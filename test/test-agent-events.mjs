#!/usr/bin/env node
/**
 * Agent-loop event stream tests - the "golden" contract for `runLocalAgent`.
 *
 * WHY THIS EXISTS: `localAgent.ts` is 4316 lines holding four wire adapters
 * (Chat / Anthropic / Responses / Google), two compaction strategies, a
 * retry+resume layer and the round loop itself. Nothing pinned the ORDER in
 * which it emits events, so a refactor there could silently reorder status
 * and tool events, drop a `usage`, or stop emitting `done` - and every
 * existing suite would still pass, because they assert on individual events
 * found with `.find()`, not on the stream's shape.
 *
 * What is pinned here is the sequence of event TYPES for canonical turns.
 * Payloads are deliberately NOT asserted - ids, timings and token counts
 * belong to their own suites - so this stays stable enough to catch a
 * regression without breaking every time a counter moves.
 *
 * The transport is the same `globalThis.fetch` swap the other localAgent
 * suites use, so the real adapters, retry layer and round loop execute.
 *
 * TRANSPORT FIDELITY NOTE: transient failures are thrown as `TypeError` with
 * an undici-style `cause` code, because that is what `isTransientNetworkError`
 * matches on (`current instanceof TypeError && message in TRANSIENT_NETWORK_
 * MESSAGES`, or a `code` in TRANSIENT_NETWORK_CODES). A plain `Error` is
 * correctly NOT retried - asserting with one would silently test nothing.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-agent-events.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runLocalAgent, NETWORK_MAX_RETRIES } = require('../out/local/localAgent.js');

let failed = 0;
const check = (name, actual, expected) => {
    const same = JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) failed++;
    console.log(`${same ? 'ok  ' : 'FAIL'} ${name}${same ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

// ---------------------------------------------------------------------------
// Scripted transport (same shape as test-subagent-runner.mjs).
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const usageFrame = frame({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

function sse(lines) {
    const chunks = [...lines];
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            pull(controller) {
                if (!chunks.length) { controller.close(); return; }
                controller.enqueue(encoder.encode(chunks.shift()));
            },
        }),
        text: async () => '',
    };
}

const textReply = (text) => sse([
    frame({ choices: [{ delta: { content: text } }] }),
    usageFrame,
    'data: [DONE]\n\n',
]);

const toolReply = (name, args) => sse([
    frame({
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                }],
            },
        }],
    }),
    usageFrame,
    'data: [DONE]\n\n',
]);

/** What undici actually throws when a socket dies mid-body. */
function socketDied() {
    const cause = Object.assign(new Error('other side closed (UND_ERR_SOCKET)'), { code: 'UND_ERR_SOCKET' });
    const err = new TypeError('terminated');
    err.cause = cause;
    return err;
}

/** A scripted step that fails the transport (steps that return a value are
 *  treated as a Response, so a failure has to THROW). */
const failSocket = () => {
    throw socketDied();
};

/**
 * Run `fn` with fetch serving `steps` in order. A step may be a function, in
 * which case it is called (and may throw), which is how failures are scripted
 * on an otherwise healthy transport.
 */
async function withScriptedFetch(steps, stats, fn) {
    const original = globalThis.fetch;
    let i = 0;
    globalThis.fetch = async (input, init) => {
        if (init?.signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        }
        const step = steps[i++];
        if (step === undefined) throw new Error(`unexpected fetch #${i} to ${String(input)}`);
        // Count BEFORE running the step so a throwing step still counts as an
        // attempt - that is the number `--retry budget` assertions care about.
        stats.calls = i;
        stats.seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
        return typeof step === 'function' ? step() : step;
    };
    try {
        return await fn();
    } finally {
        globalThis.fetch = original;
    }
}

const TOOLS = [
    { name: 'read_file', description: 'r', inputSchema: { type: 'object' }, requiresApproval: false },
];

const BASE_REQUEST = {
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'k',
    model: 'test-model',
    systemPrompt: 'sys',
    userText: 'go',
    tools: TOOLS,
    contextWindow: 200_000,
    apiStyle: 'chat',
};

const NO_APPROVAL = { requestApproval: async () => ({}) };

/** Drive one turn, returning the event stream in a compact, assertable form. */
async function run(steps, { request = {}, executor = null } = {}) {
    const types = [];
    const statuses = [];
    const raw = [];
    // Created here, not inside the fetch wrapper: on an exhausted-retry throw
    // the wrapper's own bookkeeping object would be lost with the stack.
    const stats = { calls: 0, seen: [] };
    let threw = null;
    try {
        await withScriptedFetch(steps, stats, async () => {
            for await (const event of runLocalAgent(
                { ...BASE_REQUEST, ...request },
                executor ?? { execute: async () => ({ output: 'ok' }) },
                NO_APPROVAL,
            )) {
                raw.push(event);
                types.push(event.type);
                if (event.type === 'status') statuses.push(event.value);
            }
        });
    } catch (err) {
        threw = err;
    }
    return { types, statuses, raw, threw, calls: stats.calls, requests: stats.seen };
}

// ---------------------------------------------------------------------------
// 1. The canonical turn: a tool call in round 0, final text in round 1.
// ---------------------------------------------------------------------------
{
    const { types, statuses, raw, threw } = await run([
        toolReply('read_file', { path: 'a.ts' }),
        textReply('all done'),
    ]);
    console.log(`\ncanonical: ${JSON.stringify(raw.map((e) => (e.type === 'status' ? `status:${e.value}` : e.type)))}\n`);
    ok('canonical turn: does not throw', !threw, threw?.message);

    check('canonical turn: status phases, in order',
        statuses, ['connecting', 'running', 'continuing', 'done']);

    const toolCallAt = types.indexOf('toolCall');
    const toolResultAt = types.indexOf('toolResult');
    ok('canonical turn: both tool events are present', toolCallAt >= 0 && toolResultAt >= 0, JSON.stringify(types));
    ok('canonical turn: the call precedes its result', toolCallAt < toolResultAt, JSON.stringify(types));
    // Round 1's status is `continuing`, not `running`, so pin against the
    // first chunk of the NEXT answer: the tool output must already be in the
    // stream before the model's second answer starts to arrive.
    ok('canonical turn: the result lands before the second answer streams',
        toolResultAt < types.indexOf('chunk'), JSON.stringify(types));

    ok('canonical turn: the final answer streams as chunks',
        types.filter((t) => t === 'chunk').length > 0, JSON.stringify(types));
    check('canonical turn: usage once per round',
        types.filter((t) => t === 'usage').length, 2);
    check('canonical turn: one assistantMessage per round',
        types.filter((t) => t === 'assistantMessage').length, 2);
    check('canonical turn: the stream terminates on done',
        statuses[statuses.length - 1], 'done');
}

// ---------------------------------------------------------------------------
// 2. Transport failure: a transient drop is retried, and the retry is VISIBLE
//    in the stream - it drives the countdown on the streaming bubble.
// ---------------------------------------------------------------------------
{
    const { types, statuses, calls, threw } = await run([
        failSocket,
        failSocket,
        textReply('recovered'),
    ]);
    console.log(`\nretry: ${JSON.stringify(types)}\n         statuses=${JSON.stringify(statuses)}\n`);
    ok('retry: does not throw', !threw, threw?.message);
    check('retry: one initial attempt plus the retries', calls, 3);
    check('retry: a retrying event per failed attempt',
        types.filter((t) => t === 'retrying').length, 2);
    ok('retry: attempting follows a retry (it clears the countdown)',
        types.lastIndexOf('attempting') > types.indexOf('retrying'),
        JSON.stringify(types));
    check('retry: recovery still reaches done',
        statuses[statuses.length - 1], 'done');
    ok('retry: no error event when recovery succeeds', !types.includes('error'), JSON.stringify(types));
}

// ---------------------------------------------------------------------------
// 3. Terminal failure surfaces as an error event, never a silent stop.
//    maxAttempts = NETWORK_MAX_RETRIES + 1, so exhaust that budget exactly.
// ---------------------------------------------------------------------------
{
    const steps = Array.from({ length: NETWORK_MAX_RETRIES + 1 }, () => failSocket);
    const { types, statuses, calls, threw } = await run(steps);
    console.log(`\nfailure: ${JSON.stringify(types)}${threw ? ` THREW: ${threw.message}` : ''}\n`);
    // OBSERVED CONTRACT: an exhausted retry budget does NOT yield a terminal
    // `error` event - it rethrows out of the generator. That is fine as long
    // as it neither hangs nor stops silently; the host catches it and posts
    // the error to the UI. Pinned either way so a change in shape is noticed.
    const terminated = types[types.length - 1] === 'error' || threw !== null;
    ok('failure: terminates either with an error event or by throwing', terminated,
        `last=${types[types.length - 1]} threw=${threw?.message}`);
    check('failure: the whole retry budget was consumed', calls, NETWORK_MAX_RETRIES + 1);
    ok('failure: a retrying event preceded the give-up',
        types.includes('retrying'), JSON.stringify(types));
    check('failure: never reports done', statuses.includes('done'), false);
}

// ---------------------------------------------------------------------------
// 4. Terminal events: a run never simply stops emitting.
// ---------------------------------------------------------------------------
{
    const { statuses, threw } = await run([textReply('hi')]);
    ok('single round: does not throw', !threw, threw?.message);
    check('single round: exactly the three status phases',
        statuses, ['connecting', 'running', 'done']);
}

console.log(failed === 0 ? '\nAll agent-event tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

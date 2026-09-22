#!/usr/bin/env node
/**
 * Prompt-cache rate (prefix reuse) suite.
 *
 * Providers cache the longest byte-identical PREFIX of the serialized request
 * (tools + system + messages, in the provider's own order). This suite drives
 * the REAL agent loop through a multi-turn, multi-round tool conversation on a
 * mocked transport, captures every outbound request body, rebuilds the next
 * turn's history EXACTLY the way the extension host persists it, and measures
 * the prefix reused from the previous request.
 *
 * Regression this exists for (measured live, worse the larger the window):
 * the host rebuilt history from persisted rows that DROPPED the provider-native
 * replay carriers (`isError`, `providerBlocks`, `reasoningContent`). The bytes
 * the next request sent therefore differed from the bytes the provider had just
 * cached - so at EVERY turn boundary the whole previous turn was re-sent as a
 * miss (12-16% prefix coverage on thinking turns), and the session cache rate
 * fell well under 50% as the window grew. In-run the loop had the exact bytes;
 * only the lossy round-trip broke them.
 *
 * The fix: persist and replay those carriers verbatim, and keep internal-only
 * fields off the Chat Completions wire (`chatWireMessages`). The suite asserts
 * >=75% per-request and >=80% aggregate; the residual gap is the volatile tail
 * note merged into a turn's first user turn, which is deliberately not cached.
 *
 * Run: node test/test-prompt-cache-rate.mjs   (after `npx tsc -p . --outDir out`)
 */
import { createRequire } from 'module';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { runLocalAgent, chatWireMessages } = require('../out/local/localAgent.js');
const { LocalSessionStore } = require('../out/local/localSessionStore.js');
// The REAL host mapping - not a reimplementation. A test that rebuilds rows its
// own way cannot catch a regression in the mapping that actually ships.
const { persistedEventFromAgentEvent, historyRowFromEvent, buildReplayHistory } = require('../out/local/historyRows.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

// ---------------------------------------------------------------------------
// Mock transport: one SSE shape per API style.
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
function sse(lines) {
    let index = 0;
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            pull(controller) {
                if (index >= lines.length) { controller.close(); return; }
                controller.enqueue(encoder.encode(lines[index++]));
            },
        }),
        text: async () => '',
    };
}

const REASONING = (n) => `reasoning for round ${n}: call the tool`;

function chatTool(name, args, id, _callId, n, reasoning) {
    const pieces = args.match(/.{1,8}/g) ?? ['{}'];
    const out = [];
    if (reasoning) out.push(frame({ choices: [{ delta: { reasoning_content: REASONING(n) } }] }));
    out.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: pieces[0] } }] } }] }));
    for (const piece of pieces.slice(1)) {
        out.push(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] }));
    }
    out.push('data: [DONE]\n\n');
    return out;
}
function chatText(text, n, reasoning) {
    const out = [];
    if (reasoning) out.push(frame({ choices: [{ delta: { reasoning_content: REASONING(n) } }] }));
    out.push(frame({ choices: [{ delta: { content: text } }] }));
    out.push('data: [DONE]\n\n');
    return out;
}

function messagesTool(name, args, id, _callId, n, reasoning) {
    const out = [frame({ type: 'message_start', message: { usage: { input_tokens: 100 } } })];
    if (reasoning) {
        out.push(
            frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
            frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: REASONING(n) } }),
            frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${n}` } }),
            frame({ type: 'content_block_stop', index: 0 }),
        );
    }
    const toolIndex = reasoning ? 1 : 0;
    out.push(
        frame({ type: 'content_block_start', index: toolIndex, content_block: { type: 'tool_use', id, name, input: {} } }),
        frame({ type: 'content_block_delta', index: toolIndex, delta: { type: 'input_json_delta', partial_json: args } }),
        frame({ type: 'content_block_stop', index: toolIndex }),
        frame({ type: 'message_delta', usage: { output_tokens: 5 } }),
    );
    return out;
}
function messagesText(text, n, reasoning) {
    const out = [frame({ type: 'message_start', message: { usage: { input_tokens: 100 } } })];
    if (reasoning) {
        out.push(
            frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
            frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: REASONING(n) } }),
            frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${n}` } }),
            frame({ type: 'content_block_stop', index: 0 }),
        );
    }
    const textIndex = reasoning ? 1 : 0;
    out.push(
        frame({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } }),
        frame({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } }),
        frame({ type: 'content_block_stop', index: textIndex }),
        frame({ type: 'message_delta', usage: { output_tokens: 5 } }),
    );
    return out;
}

function responsesTool(name, args, id, callId, n, reasoning) {
    const items = [];
    const out = [];
    if (reasoning) {
        const reasoningItem = { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: REASONING(n) }] };
        items.push(reasoningItem);
        out.push(
            frame({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${n}`, delta: REASONING(n) }),
            frame({ type: 'response.output_item.added', output_index: 0, item: reasoningItem }),
            frame({ type: 'response.output_item.done', output_index: 0, item: reasoningItem }),
        );
    }
    const index = items.length;
    const call = { type: 'function_call', id, call_id: callId, name, arguments: args };
    items.push(call);
    out.push(
        frame({ type: 'response.output_item.added', output_index: index, item: { ...call, arguments: '' } }),
        frame({ type: 'response.function_call_arguments.delta', item_id: id, delta: args }),
        frame({ type: 'response.output_item.done', output_index: index, item: call }),
        frame({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5 }, output: items } }),
    );
    return out;
}
function responsesText(text, n, reasoning) {
    const items = [];
    const out = [];
    if (reasoning) {
        const reasoningItem = { type: 'reasoning', id: `rs_${n}`, summary: [{ type: 'summary_text', text: REASONING(n) }] };
        items.push(reasoningItem);
        out.push(
            frame({ type: 'response.reasoning_summary_text.delta', item_id: `rs_${n}`, delta: REASONING(n) }),
            frame({ type: 'response.output_item.added', output_index: 0, item: reasoningItem }),
            frame({ type: 'response.output_item.done', output_index: 0, item: reasoningItem }),
        );
    }
    const message = { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text }] };
    items.push(message);
    out.push(
        frame({ type: 'response.output_text.delta', delta: text }),
        frame({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5 }, output: items } }),
    );
    return out;
}

function googleTool(name, args, _id, _callId, n, reasoning) {
    const parts = [];
    if (reasoning) parts.push({ text: REASONING(n), thought: true, thoughtSignature: `sig-${n}` });
    parts.push({ functionCall: { name, args: JSON.parse(args) } });
    return [frame({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })];
}
function googleText(text, n, reasoning) {
    const parts = [];
    if (reasoning) parts.push({ text: REASONING(n), thought: true, thoughtSignature: `sig-${n}` });
    parts.push({ text });
    return [frame({ candidates: [{ content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } })];
}

const RESPONDERS = {
    chat: { tool: chatTool, text: chatText },
    messages: { tool: messagesTool, text: messagesText },
    responses: { tool: responsesTool, text: responsesText },
    google: { tool: googleTool, text: googleText },
};

const TOOLS = [
    { name: 'read_file', description: 'Read a file from the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, requiresApproval: false },
    { name: 'grep_search', description: 'Search the workspace.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }, requiresApproval: false },
];

const RESULT_CHARS = 2000;
const TURNS = 4;
/** Rounds per turn in the script: tool, tool, final text. */
const ROUNDS_PER_TURN = 3;

const json = (value) => JSON.stringify(value ?? null);
/** Serialized request in the provider's cache-matching order. */
function serializedSegments(body, style) {
    if (style === 'chat') return [json(body.tools), ...(body.messages ?? []).map(json)];
    if (style === 'messages') return [json(body.tools), json(body.system), ...(body.messages ?? []).map(json)];
    if (style === 'responses') return [json(body.tools), json(body.instructions), ...(body.input ?? []).map(json)];
    if (style === 'google') return [json(body.systemInstruction), json(body.tools), ...(body.contents ?? []).map(json)];
    return [json(body)];
}
function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
}

/**
 * The pre-fix host mapping: every provider-native carrier stripped. Rows still
 * flow through the real `buildReplayHistory`, so this control reproduces the
 * CARRIER loss; a key-order regression is caught by the live path itself
 * (`buildReplayHistory` is what emits the order, and reverting it fails chat).
 */
function legacyRow(row) {
    return {
        role: row.role,
        content: row.content,
        ...(row.tool_calls ? { tool_calls: row.tool_calls } : {}),
        ...(row.tool_call_id != null ? { tool_call_id: row.tool_call_id } : {}),
    };
}

/**
 * Drive one full session and measure prefix reuse.
 *
 * `legacyReplay` reproduces the fixed bug: rebuild history WITHOUT the
 * provider-native carriers, exactly as the host did before the fix. The suite
 * asserts the live path is stable AND that the legacy path measurably is not,
 * so the test cannot silently stop testing.
 */
async function runScenario(style, { reasoning = false, legacyReplay = false } = {}) {
    const requests = [];
    const originalFetch = globalThis.fetch;
    let turn = 0;
    let round = 0;
    let callSeq = 0;

    globalThis.fetch = (async (input, init) => {
        const body = JSON.parse(String(init.body));
        requests.push(body);
        const responder = RESPONDERS[style];
        const step = round++;
        if (step % ROUNDS_PER_TURN === ROUNDS_PER_TURN - 1) {
            return sse(responder.text(`done turn ${turn}`, step, reasoning));
        }
        const name = step % ROUNDS_PER_TURN === 0 ? 'read_file' : 'grep_search';
        const args = JSON.stringify({ path: `src/file${turn}.ts` });
        return sse(responder.tool(name, args, `call-${callSeq}`, `call_${++callSeq}`, step, reasoning));
    });

    // Model-ledger rows, accumulated exactly like the host's `_localHistory`
    // and converted with the host's own `buildReplayHistory`.
    const ledger = [];
    try {
        for (turn = 0; turn < TURNS; turn++) {
            round = 0;
            const request = {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'You are Xratu, a coding agent. '.repeat(20),
                userText: `turn ${turn}: please do the thing`,
                history: buildReplayHistory(ledger),
                tools: TOOLS,
                maxRounds: 12,
                contextWindow: 200000,
                apiStyle: style,
                cacheKey: 'session-fixed',
                ...(reasoning ? { reasoningEffort: 'medium' } : {}),
            };
            const events = [];
            for await (const event of runLocalAgent(
                request,
                { execute: async () => ({ output: 'RESULT ' + 'y'.repeat(RESULT_CHARS) }) },
                { requestApproval: async () => ({}) },
            )) events.push(event);

            ledger.push({ role: 'user', content: request.userText });
            for (const event of events) {
                // The host's exact pipeline: agent event -> persisted event ->
                // history row.
                const persisted = persistedEventFromAgentEvent(event);
                if (!persisted) continue;
                const row = historyRowFromEvent(persisted);
                if (!row) continue;
                ledger.push(legacyReplay ? legacyRow(row) : row);
            }
        }
    } finally {
        globalThis.fetch = originalFetch;
    }

    let total = 0;
    let cached = 0;
    let previous = null;
    const rows = [];
    for (const body of requests) {
        const flat = serializedSegments(body, style).join('\u0000');
        const cachedChars = previous ? commonPrefixLength(previous, flat) : 0;
        total += flat.length;
        cached += cachedChars;
        rows.push({
            length: flat.length,
            cached: cachedChars,
            hit: flat.length ? cachedChars / flat.length : 0,
            cover: previous ? cachedChars / previous.length : 0,
        });
        previous = flat;
    }
    const minCover = Math.min(...rows.slice(1).map((row) => row.cover));
    // Internal-only carriers must never reach ANY provider wire.
    const leaked = requests.some((body) => JSON.stringify(body).includes('"isError"') || JSON.stringify(body).includes('"providerBlocks"'));
    return { requests: requests.length, rate: total ? cached / total : 0, minCover, rows, leaked };
}

// ---------------------------------------------------------------------------
// Live path: prefix reuse is stable on every transport, plain and thinking.
// ---------------------------------------------------------------------------
for (const style of ['chat', 'messages', 'responses', 'google']) {
    for (const reasoning of [false, true]) {
        const mode = reasoning ? 'thinking' : 'plain';
        const result = await runScenario(style, { reasoning });
        const label = `${style}/${mode}`;
        ok(`${label}: every request after the first reuses >=75% of the previous prefix`,
            result.minCover >= 0.75,
            `minCover=${(result.minCover * 100).toFixed(1)}%`);
        ok(`${label}: aggregate cache-hit rate >= 80%`,
            result.rate >= 0.80,
            `rate=${(result.rate * 100).toFixed(1)}%`);
        ok(`${label}: internal carriers never reach the wire`,
            !result.leaked);
    }
}

// ---------------------------------------------------------------------------
// PROOF: the lossy replay this suite guards against measurably fails.
// ---------------------------------------------------------------------------
for (const style of ['chat', 'messages', 'responses', 'google']) {
    for (const reasoning of [false, true]) {
        const mode = reasoning ? 'thinking' : 'plain';
        const legacy = await runScenario(style, { reasoning, legacyReplay: true });
        const fixed = await runScenario(style, { reasoning });
        const label = `${style}/${mode}`;
        // On plain non-chat transports the lossy carriers happened to be a
        // no-op (successful tool rows carry no `is_error`), so only assert the
        // strict improvement where the legacy path actually regresses.
        if (legacy.minCover < 0.75) {
            ok(`${label}: legacy lossy replay is caught (covers the bug)`,
                legacy.minCover < fixed.minCover,
                `legacy=${(legacy.minCover * 100).toFixed(1)}% fixed=${(fixed.minCover * 100).toFixed(1)}%`);
        } else {
            ok(`${label}: no carrier-specific regression on this shape (legacy == fixed)`,
                Math.abs(legacy.minCover - fixed.minCover) < 0.02,
                `legacy=${(legacy.minCover * 100).toFixed(1)}% fixed=${(fixed.minCover * 100).toFixed(1)}%`);
        }
    }
}

// ---------------------------------------------------------------------------
// The wire projection itself: internal carriers must be dropped, the reasoning
// replay carrier must be kept (`withReasoningContent` converts it).
// ---------------------------------------------------------------------------
{
    const tool = { role: 'tool', tool_call_id: 'c1', content: 'out', isError: true };
    const assistant = {
        role: 'assistant',
        content: 'text',
        tool_calls: [],
        providerBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
        reasoningContent: 'reasoned',
    };
    const [wireTool, wireAssistant] = chatWireMessages([tool, assistant]);
    ok('chatWireMessages drops internal `isError` from tool rows', !('isError' in wireTool));
    ok('chatWireMessages drops `providerBlocks` from assistant rows', !('providerBlocks' in wireAssistant));
    ok('chatWireMessages keeps `reasoningContent` for the reasoning replay',
        wireAssistant.reasoningContent === 'reasoned');
}

// ---------------------------------------------------------------------------
// Detail: the first request of the SECOND turn (the turn boundary the bug hit
// hardest) reuses the previous turn's final request.
// ---------------------------------------------------------------------------
{
    const plain = await runScenario('chat');
    const boundary = plain.rows[ROUNDS_PER_TURN];
    ok('chat: the turn boundary reuses the previous turn instead of re-sending it',
        boundary != null && boundary.cover >= 0.95,
        `cover=${boundary ? (boundary.cover * 100).toFixed(1) : 'n/a'}%`);
}

// ---------------------------------------------------------------------------
// The carriers must SURVIVE a snapshot round-trip (or the replay is lossy
// again after a reload), while a pathologically large one is dropped so the
// snapshot stays bounded. Both directions are regressions this suite guards.
// ---------------------------------------------------------------------------
{
    const root = mkdtempSync(join(tmpdir(), 'xratu-cache-'));
    const store = new LocalSessionStore(root);
    const small = await store.create('/ws-small');
    await store.save(small.id, {
        workspace: '/ws-small', model: 'm', summary: null,
        localHistory: [
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: 'a',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
                providerBlocks: [{ type: 'thinking', thinking: 't', signature: 'sig-1' }],
                reasoningContent: 'reasoned',
            },
            { role: 'tool', tool_call_id: 'c1', content: 'out', isError: false },
        ],
        uiHistory: [{ role: 'user', content: 'hi' }],
    });
    const reloaded = await store.load(small.id);
    const assistant = reloaded.localHistory.find((m) => m.role === 'assistant');
    const tool = reloaded.localHistory.find((m) => m.role === 'tool');
    ok('snapshot reload keeps providerBlocks verbatim',
        Array.isArray(assistant.providerBlocks) && assistant.providerBlocks[0].signature === 'sig-1');
    ok('snapshot reload keeps reasoningContent', assistant.reasoningContent === 'reasoned');
    ok('snapshot reload keeps the tool isError flag', tool.isError === false);

    const oversized = await store.create('/ws-large');
    await store.save(oversized.id, {
        workspace: '/ws-large', model: 'm', summary: null,
        localHistory: [
            { role: 'assistant', content: 'a', tool_calls: [], providerBlocks: [{ type: 'thinking', thinking: 'x'.repeat(300_000) }], reasoningContent: 'r'.repeat(3_000_000) },
        ],
        uiHistory: [],
    });
    const loadedLarge = await store.load(oversized.id);
    const largeAssistant = loadedLarge.localHistory[0];
    const snapshotBytes = readFileSync(join(root, 'sessions', oversized.id, 'snapshot.json')).length;
    ok('an oversized providerBlocks payload is dropped, not written',
        largeAssistant.providerBlocks === undefined);
    ok('an oversized reasoningContent payload is dropped, not written',
        largeAssistant.reasoningContent === undefined);
    ok('the snapshot stays near the aggregate budget with oversized carriers',
        snapshotBytes < 2_000_000, `bytes=${snapshotBytes}`);
}

// ---------------------------------------------------------------------------
// Aggregate carrier budget: a per-message cap cannot bound carriers (one turn
// can run unbounded rounds), so `boundCarriers` drops carriers from the OLDEST
// rows, keeping the newest reasoning whole. A carrier that sanitization will
// drop must not be counted (it would needlessly shrink unrelated content).
// ---------------------------------------------------------------------------
{
    const { boundCarriers, carrierSize, CARRIER_BUDGET } = require('../out/local/historyBounds.js');
    const big = { type: 'thinking', thinking: 'x'.repeat(400_000) };     // > MAX_CONTENT_CAP

    ok('carrierSize ignores a carrier that will be dropped (accepted-only sizing)',
        carrierSize({ providerBlocks: big }) === 0);
    ok('carrierSize counts an accepted string carrier',
        carrierSize({ reasoningContent: 'ok' }) === 2);

    // 30 rows x ~100k chars => ~3M, over the 2M budget; each payload is under
    // the per-message cap, so this exercises the AGGREGATE path.
    const rows = [];
    for (let i = 0; i < 30; i++) {
        rows.push({ role: 'assistant', content: `a${i}`, providerBlocks: [{ type: 'thinking', thinking: 'z'.repeat(100_000) }] });
    }
    const bounded = boundCarriers(rows);
    const kept = bounded.filter((row) => row.providerBlocks).length;
    ok('aggregate carrier budget drops the excess (oldest first)',
        kept > 0 && kept < rows.length, `kept=${kept} of ${rows.length}`);
    ok('the NEWEST carrier is kept whole', bounded[bounded.length - 1].providerBlocks !== undefined);
    ok('the OLDEST carrier is dropped', bounded[0].providerBlocks === undefined);
    ok('rows themselves survive - only carriers go',
        bounded.length === rows.length && bounded[0].content === 'a0');
    const under = rows.slice(0, 5);
    ok('under budget, the same array is returned (no hot-path churn)',
        boundCarriers(under) === under && under.every((row) => row.providerBlocks));
    ok('the budget is the shared CARRIER_BUDGET', CARRIER_BUDGET === 2_000_000);
}

console.log(failed === 0 ? '\nall prompt-cache-rate checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

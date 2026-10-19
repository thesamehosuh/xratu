#!/usr/bin/env node
/**
 * Subagent runner tests - drive REAL nested `runLocalAgent` loops on a mocked
 * transport and assert the delegation contract:
 *  - a `task` call returns ONLY the child's final report;
 *  - the child runs in a fresh context (no parent history) with a
 *    subagent-mode system prompt and its per-agent tool allow-list;
 *  - the `task` tool never reaches a child toolset or executor (structural
 *    recursion deny - not a prompt hint);
 *  - the child round budget (`max_rounds` / DEFAULT_SUBAGENT_ROUNDS) bounds
 *    the loop and the wrap-up still yields a report;
 *  - child usage is forwarded for cost accounting;
 *  - unknown `subagent_type` fails with the available list;
 *  - a cancelled parent (aborted signal) settles the tool call.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-subagent-runner.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runLocalAgent } = require('../out/local/localAgent.js');
const {
    runSubagentTask,
    createSubagentRunner,
    wrapRestrictedExecutor,
} = require('../out/local/subagentRunner.js');
const {
    builtinSubagents,
    discoverSubagents,
    filterToolsForSubagent,
    SUBAGENT_TOOL_NAME,
} = require('../out/subagents.js');
const { buildSubagentSystemPrompt } = require('../out/systemPrompt.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};
const check = (name, actual, expected) => {
    const okv = actual === expected;
    if (!okv) failed++;
    console.log(`${okv ? 'ok  ' : 'FAIL'} ${name}${okv ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const until = async (predicate) => {
    const end = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('Timed out waiting for the runner');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
};

// ---------------------------------------------------------------------------
// Mock transport: scripted chat-completions SSE, one handler per fetch call.
// ---------------------------------------------------------------------------
const encoder = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sse = (lines) => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
        pull(controller) {
            if (!lines.length) { controller.close(); return; }
            controller.enqueue(encoder.encode(lines.shift()));
        },
    }),
    text: async () => '',
});
const usageFrame = frame({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

function textReply(text, withUsage = true) {
    const lines = [frame({ choices: [{ delta: { content: text } }] })];
    if (withUsage) lines.push(usageFrame);
    lines.push('data: [DONE]\n\n');
    return sse(lines);
}

function toolReply(name, args, id = 'call_child_1') {
    return sse([
        frame({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id,
                        type: 'function',
                        function: { name, arguments: JSON.stringify(args) },
                    }],
                },
            }],
        }),
        usageFrame,
        'data: [DONE]\n\n',
    ]);
}

function queueFetch(handlers, seen) {
    let i = 0;
    return async (input, init) => {
        // Real fetch rejects a pre-aborted signal without dialing.
        if (init?.signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        }
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? '{}'));
        seen.push({ url, body });
        const handler = handlers[i++];
        if (!handler) throw new Error(`unexpected fetch #${i} to ${url}`);
        return handler(body, url);
    };
}

async function withMockFetch(handlers, fn) {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = queueFetch(handlers, seen);
    try {
        return { result: await fn(), seen };
    } finally {
        globalThis.fetch = original;
    }
}

const CHAT_URL = 'https://example.invalid/v1/chat/completions';

const ALL_TOOLS = [
    { name: 'read_file', description: 'r', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: 'edit_file', description: 'e', inputSchema: { type: 'object' }, requiresApproval: true },
    { name: 'grep_search', description: 'g', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: SUBAGENT_TOOL_NAME, description: 't', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: 'update_task_list', description: 'l', inputSchema: { type: 'object' }, requiresApproval: false },
    { name: 'exit_plan_mode', description: 'p', inputSchema: { type: 'object' }, requiresApproval: false },
];

const DEFS = builtinSubagents();
const EXPLORE = DEFS.find((d) => d.name === 'explore');
const GENERAL = DEFS.find((d) => d.name === 'general');

function childContext(extra = {}) {
    const usageEvents = [];
    let requestCount = 0;
    let lastDef = null;
    return {
        usageEvents,
        requestCount: () => requestCount,
        /** The profile handed to the base-request factory on the last call. */
        lastDef: () => lastDef,
        ctx: {
            // Factory: one invocation per task (fresh conversation identity).
            baseRequest: (def) => {
                requestCount++;
                lastDef = def;
                return {
                    baseUrl: 'https://example.invalid/v1',
                    apiKey: 'k',
                    model: 'test-model',
                    apiStyle: 'chat',
                    contextWindow: 100000,
                    ...(extra.baseRequest ?? {}),
                };
            },
            tools: (def) => filterToolsForSubagent(ALL_TOOLS, def),
            systemPrompt: (def) => buildSubagentSystemPrompt({
                agentPrompt: def.prompt,
                rulesContext: '',
                planMode: false,
            }),
            executor: () => ({
                execute: async (call, onOutput) => {
                    if (call.name === 'read_file') {
                        onOutput?.('partial file line\n');
                        return { output: 'contents of ' + String(call.arguments.path ?? '?') };
                    }
                    return { output: 'ok' };
                },
            }),
            approvalGate: { requestApproval: async () => ({}) },
            onUsage: (usage) => usageEvents.push(usage),
        },
    };
}

// ---------------------------------------------------------------------------
// 1. wrapRestrictedExecutor - execution-time capability surface.
// ---------------------------------------------------------------------------
{
    const executed = [];
    const base = {
        execute: async (call) => {
            executed.push(call.name);
            return { output: 'ok' };
        },
    };
    const guarded = wrapRestrictedExecutor(base, new Set(['read_file', SUBAGENT_TOOL_NAME]));
    const taskResult = await guarded.execute({ id: '1', name: SUBAGENT_TOOL_NAME, arguments: {}, argumentsJson: '{}' });
    ok('executor hard-denies task even when allow-listed', taskResult.isError === true
        && taskResult.output.includes('not available'), taskResult.output);
    const editResult = await guarded.execute({ id: '2', name: 'edit_file', arguments: {}, argumentsJson: '{}' });
    ok('executor denies tools outside the allow-list', editResult.isError === true);
    const readResult = await guarded.execute({ id: '3', name: 'read_file', arguments: {}, argumentsJson: '{}' });
    check('allowed tool passes through', readResult.output, 'ok');
    check('only the allowed tool reached the base executor', JSON.stringify(executed), JSON.stringify(['read_file']));
}

// ---------------------------------------------------------------------------
// 2. Unknown subagent_type fails with the available list.
// ---------------------------------------------------------------------------
{
    const { ctx } = childContext();
    const result = await runSubagentTask(ctx, DEFS, {
        subagentType: 'nope',
        description: 'x',
        prompt: 'do it',
    }, new Map());
    ok('unknown type is an error', result.isError === true);
    ok('error lists available types', result.output.includes('explore') && result.output.includes('general'), result.output);
}

// ---------------------------------------------------------------------------
// 3. Happy path: nested loop returns only the final report.
// ---------------------------------------------------------------------------
{
    const { ctx, usageEvents } = childContext();
    const trace = [];
    const observations = [];
    ctx.onObservation = (id, trace) => observations.push({id,trace});
    const handlers = [
        () => toolReply('read_file', { path: 'src/x.ts' }),
        () => textReply('ANSWER: found foo at src/x.ts:10'),
    ];
    const { result, seen } = await withMockFetch(handlers, () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        parentCallId: 'parent-task-call',
        description: 'find foo',
        prompt: 'Find where foo is defined. Self-contained task.',
        onOutput: (chunk) => trace.push(chunk),
    }, new Map()));
    ok('tool result is the final report', result.output.startsWith('ANSWER: found foo at src/x.ts:10'), result.output);
    ok('result carries the task_id note with the tool-call count',
        /\[task_id: [0-9a-f]{10} · 1 tool calls · resumable while this chat stays open\]/.test(result.output), result.output);
    check('result is not an error', result.isError, undefined);
    check('child made exactly two rounds', seen.length, 2);
    ok('observations preserve parent call identity', observations.length > 2 && observations.every(item => item.id === 'parent-task-call'));
    check('child trace ends done', observations.at(-1)?.trace.status, 'done');
    check('child trace names its actual model', observations.at(-1)?.trace.model, 'test-model');
    ok('child trace retains real tool output', observations.at(-1)?.trace.entries.some(entry => entry.output === 'contents of src/x.ts'));
    ok('child trace retains final narration', observations.at(-1)?.trace.entries.some(entry => entry.text.includes('ANSWER: found foo')));
    ok('initial observation is immutable', observations[0]?.trace.entries.length === 0);
    ok('child trace is absent from model payload', !seen.some(request => JSON.stringify(request.body).includes('onObservation')));
    ok('trace announces the subagent', trace.join('').includes('▶ explore'));
    ok('trace shows the child tool call as a readable line (tool + subject, no args JSON)',
        trace.join('').includes('↳ read_file src/x.ts'), trace.join(''));
    ok('trace shows the tool result line', trace.join('').includes('✓ contents of src/x.ts'));
    check('child usage forwarded once per round', usageEvents.length, 2);
    const firstTools = seen[0].body.tools.map((t) => t.function?.name ?? t.name);
    ok('child toolset excludes task', !firstTools.includes(SUBAGENT_TOOL_NAME), JSON.stringify(firstTools));
    ok('child toolset excludes parent session-control tools',
        !firstTools.includes('update_task_list') && !firstTools.includes('exit_plan_mode'),
        JSON.stringify(firstTools));
    ok('child toolset respects the explore allow-list',
        firstTools.includes('read_file') && !firstTools.includes('edit_file'), JSON.stringify(firstTools));
    const messages = seen[0].body.messages;
    check('child starts with system + user only (fresh context)', messages.length, 2);
    ok('child system prompt carries the agent body', String(messages[0].content).includes(EXPLORE.prompt.slice(0, 40)));
    ok('child system prompt carries the delegation contract',
        String(messages[0].content).includes('delegated subagent'));
    ok('child user message is the task prompt (plus the volatile tail note)',
        String(messages[1].content).startsWith('Find where foo is defined. Self-contained task.'),
        JSON.stringify(messages[1].content));
}

// The shared gate keeps child approvals real and attributes them to the parent task.
{
    const {ctx} = childContext();
    const observations = [];
    const approvals = [];
    let executed = false;
    ctx.onObservation = (id,trace) => observations.push({id,trace});
    ctx.approvalGate = {requestApproval:async (id,calls,source,signal) => { approvals.push({id,calls,source,signal}); return Object.fromEntries(calls.map(call => [call.id,false])); }};
    ctx.executor = () => ({execute:async()=>{executed=true;return {output:'should not execute'};}});
    const {result} = await withMockFetch([()=>toolReply('edit_file',{path:'a.ts',patch:'old to new'}),()=>textReply('Edit was denied; reporting findings instead.')],()=>runSubagentTask(ctx,DEFS,{subagentType:'general',description:'Fix auth',prompt:'Fix expiry',parentCallId:'parent-approval'},new Map()));
    ok('child approval identifies its parent/profile/task', approvals.length === 1 && approvals[0].source.parentCallId === 'parent-approval' && approvals[0].source.profile === 'general' && approvals[0].source.description === 'Fix auth');
    ok('child approval carries the run signal so a stop retracts its card', approvals[0].signal instanceof AbortSignal);
    ok('child never bypasses a denied tool', !executed);
    ok('trace exposes approval wait', observations.some(item=>item.trace.status==='waiting'));
    ok('trace retains denied tool error', observations.at(-1).trace.entries.some(entry=>entry.kind==='tool' && entry.isError));
    ok('parent receives only final child report', result.output.startsWith('Edit was denied; reporting findings instead.'));
}

// ---------------------------------------------------------------------------
// 4. Round budget: maxRounds=1 forces the wrap-up round as the report.
// ---------------------------------------------------------------------------
{
    const { ctx } = childContext();
    const limited = { ...GENERAL, name: 'limited', maxRounds: 1, tools: ['read_file'] };
    const handlers = [
        () => toolReply('read_file', { path: 'a.ts' }, 'c1'),
        (body) => {
            ok('wrap-up round forbids tool calls', body.tool_choice === 'none', JSON.stringify(body.tool_choice));
            return textReply('WRAPUP: partial findings', false);
        },
    ];
    const { result, seen } = await withMockFetch(handlers, () => runSubagentTask(ctx, [limited], {
        subagentType: 'limited',
        description: 'endless tools',
        prompt: 'Always call a tool.',
        onOutput: () => {},
    }, new Map()));
    check('maxRounds caps the loop at budget + wrap-up', seen.length, 2);
    ok('wrap-up text becomes the report', result.output.startsWith('WRAPUP: partial findings'), result.output);
}

// ---------------------------------------------------------------------------
// 5. Cancel settles the tool call; per-task baseRequest identity.
// ---------------------------------------------------------------------------
{
    const controller = new AbortController();
    controller.abort();
    const { ctx } = childContext({ baseRequest: { signal: controller.signal } });
    const observations = []; ctx.onObservation = (id,trace) => observations.push(trace);
    const { result, seen } = await withMockFetch([], () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        parentCallId: 'cancelled-parent',
        description: 'cancelled',
        prompt: 'Find foo.',
    }, new Map()));
    ok('cancelled run reports cancellation', result.isError === true
        && result.output.includes('cancelled'), result.output);
    check('cancelled run never dials out', seen.length, 0);
    check('cancelled observation ends without a live spinner',observations.at(-1)?.status,'cancelled');
}
{
    const { ctx, requestCount } = childContext();
    const registry = new Map();
    const handlers = [
        () => textReply('ONE'),
        () => textReply('TWO'),
    ];
    await withMockFetch(handlers, async () => {
        await runSubagentTask(ctx, DEFS, { subagentType: 'explore', description: 'a', prompt: 'task one' }, registry);
        await runSubagentTask(ctx, DEFS, { subagentType: 'explore', description: 'b', prompt: 'task two' }, registry);
    });
    check('baseRequest is built once per task', requestCount(), 2);
}

// ---------------------------------------------------------------------------
// 5b. Stopping ONE agent settles only that task call; its sibling completes.
// ---------------------------------------------------------------------------
{
    const { ctx } = childContext();
    const stops = new Map();
    const observations = [];
    ctx.onControl = (callId, stop) => {
        if (!callId) return;
        if (stop) stops.set(callId, stop);
        else stops.delete(callId);
    };
    ctx.onObservation = (id, trace) => observations.push({ id, trace });
    let aDialed = false;
    let releaseA;
    const handlers = [
        // The first child hangs at its first request until the test settles it.
        () => { aDialed = true; return new Promise((resolve) => { releaseA = resolve; }); },
        () => textReply('B finished'),
    ];
    const results = await withMockFetch(handlers, async () => {
        const a = runSubagentTask(ctx, DEFS, {
            subagentType: 'explore', parentCallId: 'agent-a', description: 'slow', prompt: 'Do A.',
        }, new Map());
        await until(() => aDialed);
        const b = runSubagentTask(ctx, DEFS, {
            subagentType: 'explore', parentCallId: 'agent-b', description: 'fast', prompt: 'Do B.',
        }, new Map());
        await until(() => stops.has('agent-a') && stops.has('agent-b'));
        stops.get('agent-a')();
        const aborted = new Error('The operation was aborted');
        aborted.name = 'AbortError';
        releaseA(Promise.reject(aborted));
        return [await a, await b];
    });
    const [a, b] = results.result;
    ok('stopped agent reports cancellation', a.isError === true && a.output.includes('cancelled'), a.output);
    ok('stopped agent keeps its resumable task id', /\[task_id: \w+/.test(a.output), a.output);
    ok('sibling agent still delivers its report', b.output.startsWith('B finished'), b.output);
    ok('sibling agent is not an error', !b.isError);
    check('stopped observation ends cancelled',
        observations.filter((item) => item.id === 'agent-a').at(-1)?.trace.status, 'cancelled');
    check('sibling observation ends done',
        observations.filter((item) => item.id === 'agent-b').at(-1)?.trace.status, 'done');
    ok('stop control is released after the run', !stops.has('agent-a'));
}

// ---------------------------------------------------------------------------
// 5c. Per-agent model/effort: the factory receives the PROFILE, so the child
// can run on its own model (and that model's caps/window), not the parent's.
// ---------------------------------------------------------------------------
{
    const defs = [{
        name: 'cheap',
        description: 'Runs on another model',
        prompt: 'Do the thing.',
        model: 'small-model',
        reasoningEffort: 'low',
        maxRounds: 2,
        source: 'project-xratu',
    }];
    const { ctx, lastDef } = childContext();
    await withMockFetch([() => textReply('done')], () =>
        runSubagentTask(ctx, defs, { subagentType: 'cheap', description: 'd', prompt: 'go' }, new Map()));
    check('baseRequest receives the launched profile', lastDef()?.name, 'cheap');
    check("the profile's model reaches the transport", lastDef()?.model, 'small-model');
}

// ---------------------------------------------------------------------------
// 6. Resume/heal: task_id continues the same subagent with its context.
// ---------------------------------------------------------------------------
{
    const { ctx } = childContext();
    const registry = new Map();
    const first = await withMockFetch([
        () => toolReply('read_file', { path: 'src/x.ts' }, 'c1'),
        () => textReply('PARTIAL: found foo, still checking y'),
    ], () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        description: 'find foo and y',
        prompt: 'Find where foo and y are defined.',
    }, registry));
    const taskId = /\[task_id: ([0-9a-f]{10}) /.exec(first.result.output)?.[1];
    ok('first run reports a task_id', !!taskId, first.result.output);
    ok('interrupted/partial work is still resumable', registry.has(taskId));
    check('registry holds the committed rows (user, tool-call turn, final)',
        registry.get(taskId)?.rows.length, 4);

    const trace = [];
    const second = await withMockFetch([
        () => textReply('FULL: foo at src/x.ts:10 and y at src/y.ts:3'),
    ], () => runSubagentTask(ctx, DEFS, {
        subagentType: '',
        description: 'continue',
        prompt: 'Now finish checking y.',
        taskId,
        onOutput: (chunk) => trace.push(chunk),
    }, registry));
    ok('resume continues with the final answer', second.result.output.startsWith('FULL:'), second.result.output);
    ok('resume keeps the same task_id', second.result.output.includes(`[task_id: ${taskId} ·`), second.result.output);
    // The note is PERSISTED with the tool result, so it has to state its own
    // lifetime: runs live in an in-memory per-chat registry.
    ok('the task_id note states its lifetime',
        second.result.output.includes('resumable while this chat stays open'), second.result.output);
    const resumedMessages = second.seen[0].body.messages;
    ok('resume restores the run history (not a fresh context)',
        resumedMessages.length > 2, `messages=${resumedMessages.length}`);
    ok('history carries the earlier prompt',
        resumedMessages.some((m) => String(m.content ?? '').includes('Find where foo and y are defined.')));
    ok('history carries the earlier tool round',
        resumedMessages.some((m) => m.role === 'tool'),
        JSON.stringify(resumedMessages.map((m) => m.role)));
    ok('new prompt is the continuation',
        String(resumedMessages[resumedMessages.length - 1].content ?? '').startsWith('Now finish checking y.'),
        JSON.stringify(resumedMessages[resumedMessages.length - 1].content));
    ok('resume trace announces the continuation', trace.join('').includes('▶ explore (resume)'), trace.join(''));
}
{
    // Unknown task_id fails with the available list; type mismatch refuses.
    const { ctx } = childContext();
    const registry = new Map();
    const bad = await runSubagentTask(ctx, DEFS, {
        subagentType: '',
        description: 'x',
        prompt: 'continue',
        taskId: 'deadbeef00',
    }, registry);
    ok('unknown task_id is an error', bad.isError === true && bad.output.includes('Unknown task_id'), bad.output);

    const created = await withMockFetch([
        () => textReply('DONE'),
    ], () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        description: 'x',
        prompt: 'go',
    }, registry));
    const taskId = /\[task_id: ([0-9a-f]{10}) /.exec(created.result.output)?.[1];
    const mismatch = await runSubagentTask(ctx, DEFS, {
        subagentType: 'general',
        description: 'x',
        prompt: 'continue',
        taskId,
    }, registry);
    ok('task_id/subagent_type mismatch is refused',
        mismatch.isError === true && mismatch.output.includes('belongs to subagent_type'), mismatch.output);
}

// ---------------------------------------------------------------------------
// 7. Full parent -> child loop: the report lands as the parent tool result.
// ---------------------------------------------------------------------------
{
    const { ctx: childCtx } = childContext();
    const defs = discoverSubagents({ workspaceRoot: '/nonexistent-workspace', homedir: '/nonexistent-home' });
    const runner = createSubagentRunner(childCtx, defs, new Map());
    const parentEvents = [];
    const parentHandlers = [
        // Parent round 1: delegate.
        () => toolReply(SUBAGENT_TOOL_NAME, {
            subagent_type: 'explore',
            description: 'find foo',
            prompt: 'Find where foo is defined.',
        }, 'call_parent_1'),
        // Child round 1: one tool call.
        () => toolReply('read_file', { path: 'src/x.ts' }, 'call_child_1'),
        // Child round 2: final report.
        () => textReply('REPORT: foo lives in src/x.ts:10'),
        // Parent round 2: wrap up.
        () => textReply('Delegated research is done.'),
    ];
    const { result, seen } = await withMockFetch(parentHandlers, async () => {
        for await (const event of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'Parent prompt',
                userText: 'investigate foo',
                history: [
                    { role: 'user', content: 'earlier turn' },
                    { role: 'assistant', content: 'earlier answer' },
                ],
                tools: ALL_TOOLS,
                apiStyle: 'chat',
                contextWindow: 100000,
            },
            {
                execute: async (call, onOutput) => {
                    if (call.name === SUBAGENT_TOOL_NAME) {
                        return runner.run({
                            subagentType: String(call.arguments.subagent_type ?? ''),
                            description: String(call.arguments.description ?? ''),
                            prompt: String(call.arguments.prompt ?? ''),
                            ...(onOutput ? { onOutput } : {}),
                        });
                    }
                    return { output: 'ok' };
                },
            },
            { requestApproval: async () => ({}) },
        )) {
            parentEvents.push(event);
        }
    });
    const toolResult = parentEvents.find((e) => e.type === 'toolResult' && e.tool === SUBAGENT_TOOL_NAME);
    ok('parent saw a toolResult for the task call', !!toolResult);
    ok('parent toolResult is the child report', toolResult?.output.startsWith('REPORT: foo lives in src/x.ts:10'), toolResult?.output);
    const finalMessage = [...parentEvents].reverse().find((e) => e.type === 'assistantMessage' && !e.toolCalls.length);
    check('parent run completed with its own answer', finalMessage?.text, 'Delegated research is done.');
    // Fetch order: parent round 1, child rounds, parent round 2.
    check('four requests total (2 parent + 2 child)', seen.length, 4);
    const childSystem = String(seen[1].body.messages[0]?.content ?? '');
    ok('child did not inherit parent history', seen[1].body.messages.length === 2
        && !childSystem.includes('earlier turn'), `messages=${seen[1].body.messages.length}`);
}

// ---------------------------------------------------------------------------
// 8. Parallel delegation: several task calls in ONE round run concurrently.
// ---------------------------------------------------------------------------
{
    // Two children gated on a barrier: only CONCURRENT execution can dial
    // both, so a serial regression deadlocks into the timeout and fails.
    let dialed = 0;
    let releaseBarrier = () => {};
    let timedOut = false;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(undefined); }, 2000));
    const childHandler = (label) => () => {
        dialed++;
        if (dialed >= 2) releaseBarrier();
        return Promise.race([barrier, guard]).then(() => textReply(`CHILD ${label}`, false));
    };
    const twoToolReply = sse([
        frame({
            choices: [{
                delta: {
                    tool_calls: [
                        { index: 0, id: 'pa', type: 'function', function: { name: SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ subagent_type: 'explore', description: 'first', prompt: 'Task A.' }) } },
                        { index: 1, id: 'pb', type: 'function', function: { name: SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ subagent_type: 'explore', description: 'second', prompt: 'Task B.' }) } },
                    ],
                },
            }],
        }),
        usageFrame,
        'data: [DONE]\n\n',
    ]);
    // The scripted queue hands responses out in CALL order; the two children
    // race, so accept either label for either slot.
    const labels = ['A', 'B'];
    const parentHandlers = [
        () => twoToolReply,
        () => childHandler(labels.shift() ?? 'X')(),
        () => childHandler(labels.shift() ?? 'X')(),
        () => textReply('Both reports are in.'),
    ];
    const { ctx: childCtx } = childContext();
    const runner = createSubagentRunner(childCtx, DEFS, new Map());
    const parentEvents = [];
    await withMockFetch(parentHandlers, async () => {
        for await (const event of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'Parent prompt',
                userText: 'research two areas',
                history: [],
                tools: ALL_TOOLS,
                apiStyle: 'chat',
                contextWindow: 100000,
                parallelTools: [SUBAGENT_TOOL_NAME],
            },
            {
                execute: async (call, onOutput) => {
                    if (call.name === SUBAGENT_TOOL_NAME) {
                        return runner.run({
                            subagentType: String(call.arguments.subagent_type ?? ''),
                            description: String(call.arguments.description ?? ''),
                            prompt: String(call.arguments.prompt ?? ''),
                            ...(onOutput ? { onOutput } : {}),
                        });
                    }
                    return { output: 'ok' };
                },
            },
            { requestApproval: async () => ({}) },
        )) {
            parentEvents.push(event);
        }
    });
    ok('both subagents dialed before either finished (concurrent, not serial)',
        dialed === 2 && !timedOut, `dialed=${dialed} timedOut=${timedOut}`);
    const taskResults = parentEvents.filter((e) => e.type === 'toolResult' && e.tool === SUBAGENT_TOOL_NAME);
    check('both delegated results landed', taskResults.length, 2);
    ok('each result carries its own report',
        taskResults.some((e) => e.output.startsWith('CHILD ')), JSON.stringify(taskResults.map((e) => e.output.slice(0, 20))));
    const finalMessage = [...parentEvents].reverse().find((e) => e.type === 'assistantMessage' && !e.toolCalls.length);
    check('parent completed after both children', finalMessage?.text, 'Both reports are in.');
}

// ---------------------------------------------------------------------------
// 9. A DENIED call in a parallel round still settles the queue.
//    Regression: the denied branch used to return outside the try/finally,
//    leaking the in-flight count so eventQueue.close() never ran and the
//    round hung forever.
// ---------------------------------------------------------------------------
{
    let dialed = 0;
    let releaseBarrier = () => {};
    let timedOut = false;
    const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
    const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(undefined); }, 2000));
    const childHandler = (label) => () => {
        dialed++;
        if (dialed >= 2) releaseBarrier();
        return Promise.race([barrier, guard]).then(() => textReply(`CHILD ${label}`, false));
    };
    const mixedReply = sse([
        frame({
            choices: [{
                delta: {
                    tool_calls: [
                        { index: 0, id: 'ed', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.ts' }) } },
                        { index: 1, id: 'pa', type: 'function', function: { name: SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ subagent_type: 'explore', description: 'first', prompt: 'Task A.' }) } },
                        { index: 2, id: 'pb', type: 'function', function: { name: SUBAGENT_TOOL_NAME, arguments: JSON.stringify({ subagent_type: 'explore', description: 'second', prompt: 'Task B.' }) } },
                    ],
                },
            }],
        }),
        usageFrame,
        'data: [DONE]\n\n',
    ]);
    const labels = ['A', 'B'];
    // edit_file fetches NOTHING (it is denied before the executor runs), so
    // the scripted queue is: mixed round -> two children -> final text.
    const parentHandlers = [
        () => mixedReply,
        () => childHandler(labels.shift() ?? 'X')(),
        () => childHandler(labels.shift() ?? 'X')(),
        () => textReply('Denied one, both reports are in.'),
    ];
    const { ctx: childCtx } = childContext();
    const runner = createSubagentRunner(childCtx, DEFS, new Map());
    const parentEvents = [];
    await withMockFetch(parentHandlers, async () => {
        const consume = (async () => {
            for await (const event of runLocalAgent(
                {
                    baseUrl: 'https://example.invalid/v1',
                    apiKey: 'k',
                    model: 'test-model',
                    systemPrompt: 'Parent prompt',
                    userText: 'edit and research',
                    history: [],
                    tools: ALL_TOOLS,
                    apiStyle: 'chat',
                    contextWindow: 100000,
                    parallelTools: [SUBAGENT_TOOL_NAME],
                },
                {
                    execute: async (call, onOutput) => {
                        if (call.name === SUBAGENT_TOOL_NAME) {
                            return runner.run({
                                subagentType: String(call.arguments.subagent_type ?? ''),
                                description: String(call.arguments.description ?? ''),
                                prompt: String(call.arguments.prompt ?? ''),
                                ...(onOutput ? { onOutput } : {}),
                            });
                        }
                        return { output: 'ok' };
                    },
                },
                // No approvals granted: edit_file is denied, the tasks run.
                { requestApproval: async () => ({}) },
            )) {
                parentEvents.push(event);
            }
            return 'done';
        })();
        // A hung queue must FAIL the assertion, not stall the suite.
        const settled = await Promise.race([
            consume,
            new Promise((resolve) => setTimeout(() => resolve('hang'), 4000)),
        ]);
        check('denied call in a parallel round does not hang the queue', settled, 'done');
    });
    const denied = parentEvents.find((e) => e.type === 'toolResult' && e.id === 'ed');
    ok('denied edit_file produced its denial result', !!denied);
    check('denial result is marked as an error', denied?.isError, true);
    const taskResults = parentEvents.filter((e) => e.type === 'toolResult' && e.tool === SUBAGENT_TOOL_NAME);
    check('both delegated results landed alongside the denial', taskResults.length, 2);
    const finalMessage = [...parentEvents].reverse().find((e) => e.type === 'assistantMessage' && !e.toolCalls.length);
    check('parent completed after the denied call and both children', finalMessage?.text, 'Denied one, both reports are in.');
}

// ---------------------------------------------------------------------------
// 7. The parallel cap is a SLOT COUNT, not a batch size. The setting, the
// README and the task-tool description all promise that the remaining calls
// start "as slots free up" - a batched implementation would hold call 3 until
// calls 1 AND 2 had both settled. Both properties are pinned here.
// ---------------------------------------------------------------------------
{
    const PROBE = { name: 'probe', description: 'p', inputSchema: { type: 'object' }, requiresApproval: false };
    /** Three calls: #0 and #2 finish at once, #1 hangs, so a slot frees while
     *  another call is still running - the exact case batching gets wrong. */
    const runCapped = async (limit) => {
        const events = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const delays = [10, 400, 10];
        const toolCalls = delays.map((_, n) => ({
            index: n, id: `c${n}`, type: 'function',
            function: { name: 'probe', arguments: JSON.stringify({ n }) },
        }));
        const handlers = [
            () => sse([
                frame({ choices: [{ delta: { tool_calls: toolCalls } }] }),
                usageFrame,
                'data: [DONE]\n\n',
            ]),
            () => textReply('all done'),
        ];
        const results = [];
        await withMockFetch(handlers, async () => {
            for await (const event of runLocalAgent(
                {
                    baseUrl: 'https://example.invalid/v1',
                    apiKey: 'k',
                    model: 'test-model',
                    systemPrompt: 'Parent prompt',
                    userText: 'run three probes',
                    history: [],
                    tools: [PROBE],
                    apiStyle: 'chat',
                    contextWindow: 100000,
                    parallelTools: ['probe'],
                    parallelToolLimit: limit,
                },
                {
                    execute: async (call) => {
                        const n = Number(call.arguments.n);
                        events.push(`start:${n}`);
                        inFlight++;
                        maxInFlight = Math.max(maxInFlight, inFlight);
                        await new Promise((resolve) => setTimeout(resolve, delays[n]));
                        events.push(`end:${n}`);
                        inFlight--;
                        return { output: `probe ${n}` };
                    },
                },
                { requestApproval: async () => ({}) },
            )) {
                if (event.type === 'toolResult') results.push(event.output);
            }
        });
        return { events, maxInFlight, results };
    };

    const capped = await runCapped(2);
    check('the cap is respected (never a third concurrent call)', capped.maxInFlight, 2);
    ok('a queued call starts as soon as ONE slot frees (start:2 precedes end:1)',
        capped.events.indexOf('start:2') > -1
        && capped.events.indexOf('start:2') < capped.events.indexOf('end:1'),
        capped.events.join(' '));
    check('every call still ran', capped.results.length, 3);

    const serial = await runCapped(1);
    check('a cap of 1 never overlaps two calls', serial.maxInFlight, 1);
    check('a serial cap keeps the emitted order', serial.events.join(' '),
        'start:0 end:0 start:1 end:1 start:2 end:2');
    check('a serial cap still runs every call', serial.results.length, 3);
}


// Use the host's actual live gate for both built-in root and delegated loops.
{
    const source = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const start = source.indexOf('const localApprovalGate: LocalApprovalGate = {');
    const end = source.indexOf('\n        };', start) + '\n        };'.length;
    const code = require('esbuild').transformSync(source.slice(start, end), { loader: 'ts' }).code;
    const makeGate = new Function('runPlanMode', code + '\nreturn localApprovalGate;');
    for (const nested of [false, true]) {
        const prompted = [], executed = [];
        const host = { _yoloMode: true, _requestLocalApproval: async (_id, _calls, attribution) => { prompted.push(attribution); return {}; } };
        const gate = makeGate.call(host, false);
        const tools = [{ name: 'edit_file', description: 'edit', inputSchema: { type: 'object' }, requiresApproval: true }];
        const handlers = [
            () => toolReply('edit_file', {}, 'auto'),
            () => { host._yoloMode = false; return toolReply('edit_file', {}, 'ask'); },
            () => { host._yoloMode = true; return toolReply('edit_file', {}, 'auto-again'); },
            () => textReply('Done'),
        ];
        const executor = { execute: async call => { executed.push(call.id); return { output: 'ok' }; } };
        await withMockFetch(handlers, async () => {
            if (nested) {
                const { ctx } = childContext();
                ctx.tools = () => tools; ctx.executor = () => executor; ctx.approvalGate = gate;
                await runSubagentTask(ctx, DEFS, { subagentType: 'general', parentCallId: 'live-child', prompt: 'test', description: 'test' }, new Map());
            } else {
                for await (const _event of runLocalAgent({ baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'test-model', apiStyle: 'chat', contextWindow: 100000, tools, userText: 'test', systemPrompt: '', history: [] }, executor, gate)) { /* drain */ }
            }
        });
        check(`${nested ? 'child' : 'root'} live YOLO revocation prompts once`, prompted.length, 1);
        check(`${nested ? 'child' : 'root'} live YOLO executes only approved mutations`, executed.join(','), 'auto,auto-again');
        if (nested) check('live child gate preserves approval attribution', prompted[0]?.parentCallId, 'live-child');
    }
}

// Exercise the real executor: model-request cancellation alone cannot stop a shell.
{
    const Module = require('module');
    const originalLoad = Module._load;
    let createLocalToolExecutor;
    try {
        Module._load = function (name, ...args) {
            if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) }, Uri: { file: p => ({ fsPath: p, path: p }) } };
            return originalLoad.call(this, name, ...args);
        };
        ({ createLocalToolExecutor } = require('../out/mcp.js'));
    } finally { Module._load = originalLoad; }
    const { mkdtempSync, rmSync } = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');
    const { getJobByCallId } = require('../out/tooling/backgroundJobs.js');
    const root = mkdtempSync(join(tmpdir(), 'xratu-agent-stop-'));
    const parent = new AbortController();
    const { ctx } = childContext({ baseRequest: { signal: parent.signal } });
    const controls = new Map();
    const observations = [];
    const registry = new Map();
    ctx.tools = () => [{ name: 'run_terminal_command', description: 'shell', inputSchema: { type: 'object' }, requiresApproval: true }];
    ctx.executor = signal => createLocalToolExecutor(root, async () => {}, undefined, undefined, undefined, undefined, { nested: true, signal });
    ctx.approvalGate = { requestApproval: async (_id, calls) => Object.fromEntries(calls.map(call => [call.id, true])) };
    ctx.onControl = (id, stop) => { if (stop) controls.set(id, stop); else controls.delete(id); };
    ctx.onObservation = (id, trace) => observations.push({ id, trace });
    let aJob, bJob;
    try {
        await withMockFetch([
            () => toolReply('run_terminal_command', { command: 'node -e "console.log(123);setTimeout(() => {}, 30000)"' }, 'real-a'),
            () => toolReply('run_terminal_command', { command: 'node -e "console.log(456);setTimeout(() => {}, 600)"' }, 'real-b'),
            () => textReply('Sibling finished'),
            () => textReply('Resumed after cancellation'),
        ], async () => {
            const a = runSubagentTask(ctx, DEFS, { subagentType: 'general', parentCallId: 'real-task-a', prompt: 'A', description: 'A' }, registry);
            await until(() => (aJob = getJobByCallId('real-a'))?.stdout.includes('123'));
            const b = runSubagentTask(ctx, DEFS, { subagentType: 'general', parentCallId: 'real-task-b', prompt: 'B', description: 'B' }, registry);
            await until(() => (bJob = getJobByCallId('real-b'))?.stdout.includes('456'));
            controls.get('real-task-a')();
            const result = await a;
            await aJob.finished;
            check('individual Stop kills the real child command', aJob.status, 'killed');
            check('individual Stop leaves a sibling command running', bJob.status, 'running');
            check('individual Stop leaves the parent signal live', parent.signal.aborted, false);
            ok('child with a running tool reports cancellation', result.isError && result.output.includes('cancelled'));
            check('sibling completes after another agent is stopped', (await b).output.startsWith('Sibling finished'), true);
            const taskId = [...registry.keys()][0];
            const resumed = await runSubagentTask(ctx, DEFS, { taskId, parentCallId: 'resumed-task', prompt: 'Continue', description: 'Resume' }, registry);
            ok('a stopped built-in task resumes with a fresh executor signal', resumed.output.startsWith('Resumed after cancellation') && !resumed.isError);
            check('running-tool observation ends cancelled', observations.filter(value => value.id === 'real-task-a').at(-1).trace.status, 'cancelled');
        });
        const controller = new AbortController();
        let mcpSignal, browserSignal;
        const pending = (_name, _args, signal) => { mcpSignal = signal; return new Promise(() => {}); };
        const executor = createLocalToolExecutor(root, async () => {}, { callTool: pending }, undefined, undefined, undefined, {
            nested: true, signal: controller.signal, sessionId: 'browser-session', browser: { tool: (_session, _name, _args, signal) => { browserSignal = signal; return new Promise(() => {}); } },
        });
        const mcp = executor.execute({ id: 'mcp', name: 'mcp__test__wait', arguments: {}, argumentsJson: '{}' }).catch(error => error.name);
        const browser = executor.execute({ id: 'browser', name: 'browser_snapshot', arguments: {}, argumentsJson: '{}' }).catch(error => error.name);
        controller.abort();
        check('external MCP receives the per-agent signal', mcpSignal, controller.signal);
        check('browser receives the per-agent signal', browserSignal, controller.signal);
        check('Stop settles an uncooperative external MCP call', await mcp, 'AbortError');
        check('Stop settles an uncooperative browser call', await browser, 'AbortError');
        const mutationController = new AbortController();
        let releaseSnapshot;
        const mutationExecutor = createLocalToolExecutor(root, () => new Promise(resolve => { releaseSnapshot = resolve; }), undefined, undefined, undefined, undefined, { nested: true, signal: mutationController.signal });
        const mutation = mutationExecutor.execute({ id: 'late-write', name: 'edit_file', arguments: { path: 'late.txt', mode: 'create', content: 'must not be written' }, argumentsJson: '{}' }).catch(error => error.name);
        await until(() => !!releaseSnapshot);
        mutationController.abort(); releaseSnapshot();
        check('Stop settles a mutation waiting for its checkpoint', await mutation, 'AbortError');
        await new Promise(resolve => setImmediate(resolve));
        check('a stopped tool cannot mutate after its checkpoint finishes', require('node:fs').existsSync(join(root, 'late.txt')), false);

    } finally {
        parent.abort();
        aJob?.kill('test cleanup'); bJob?.kill('test cleanup');
        await Promise.all([aJob?.finished, bJob?.finished]);
        rmSync(root, { recursive: true, force: true });
    }
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

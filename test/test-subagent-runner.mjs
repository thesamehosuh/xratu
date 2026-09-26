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
    return {
        usageEvents,
        requestCount: () => requestCount,
        ctx: {
            // Factory: one invocation per task (fresh conversation identity).
            baseRequest: () => {
                requestCount++;
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
            executor: {
                execute: async (call, onOutput) => {
                    if (call.name === 'read_file') {
                        onOutput?.('partial file line\n');
                        return { output: 'contents of ' + String(call.arguments.path ?? '?') };
                    }
                    return { output: 'ok' };
                },
            },
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
    });
    ok('unknown type is an error', result.isError === true);
    ok('error lists available types', result.output.includes('explore') && result.output.includes('general'), result.output);
}

// ---------------------------------------------------------------------------
// 3. Happy path: nested loop returns only the final report.
// ---------------------------------------------------------------------------
{
    const { ctx, usageEvents } = childContext();
    const trace = [];
    const handlers = [
        () => toolReply('read_file', { path: 'src/x.ts' }),
        () => textReply('ANSWER: found foo at src/x.ts:10'),
    ];
    const { result, seen } = await withMockFetch(handlers, () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        description: 'find foo',
        prompt: 'Find where foo is defined. Self-contained task.',
        onOutput: (chunk) => trace.push(chunk),
    }));
    check('tool result is exactly the final report', result.output, 'ANSWER: found foo at src/x.ts:10');
    check('result is not an error', result.isError, undefined);
    check('child made exactly two rounds', seen.length, 2);
    ok('trace announces the subagent', trace.join('').includes('▶ explore'));
    ok('trace shows the child tool call', trace.join('').includes('→ read_file'));
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
    }));
    check('maxRounds caps the loop at budget + wrap-up', seen.length, 2);
    check('wrap-up text becomes the report', result.output, 'WRAPUP: partial findings');
}

// ---------------------------------------------------------------------------
// 5. Cancel settles the tool call; per-task baseRequest identity.
// ---------------------------------------------------------------------------
{
    const controller = new AbortController();
    controller.abort();
    const { ctx } = childContext({ baseRequest: { signal: controller.signal } });
    const { result, seen } = await withMockFetch([], () => runSubagentTask(ctx, DEFS, {
        subagentType: 'explore',
        description: 'cancelled',
        prompt: 'Find foo.',
    }));
    ok('cancelled run reports cancellation', result.isError === true
        && result.output.includes('cancelled'), result.output);
    check('cancelled run never dials out', seen.length, 0);
}
{
    const { ctx, requestCount } = childContext();
    const handlers = [
        () => textReply('ONE'),
        () => textReply('TWO'),
    ];
    await withMockFetch(handlers, async () => {
        await runSubagentTask(ctx, DEFS, { subagentType: 'explore', description: 'a', prompt: 'task one' });
        await runSubagentTask(ctx, DEFS, { subagentType: 'explore', description: 'b', prompt: 'task two' });
    });
    check('baseRequest is built once per task', requestCount(), 2);
}

// ---------------------------------------------------------------------------
// 6. Full parent -> child loop: the report lands as the parent tool result.
// ---------------------------------------------------------------------------
{
    const { ctx: childCtx } = childContext();
    const defs = discoverSubagents({ workspaceRoot: '/nonexistent-workspace', homedir: '/nonexistent-home' });
    const runner = createSubagentRunner(childCtx, defs);
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
    check('parent toolResult is the child report', toolResult?.output, 'REPORT: foo lives in src/x.ts:10');
    const finalMessage = [...parentEvents].reverse().find((e) => e.type === 'assistantMessage' && !e.toolCalls.length);
    check('parent run completed with its own answer', finalMessage?.text, 'Delegated research is done.');
    // Fetch order: parent round 1, child rounds, parent round 2.
    check('four requests total (2 parent + 2 child)', seen.length, 4);
    const childSystem = String(seen[1].body.messages[0]?.content ?? '');
    ok('child did not inherit parent history', seen[1].body.messages.length === 2
        && !childSystem.includes('earlier turn'), `messages=${seen[1].body.messages.length}`);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

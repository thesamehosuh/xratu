// Optional real-runtime check: XRATU_TEST_OPENCODE_BINARY=<2.x executable> npm run test:engines.
// Uses an isolated OpenCode data directory and a local simulated model; no provider keys.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkOpenCodeRuntime(OpenCodeEngine, root, binary) {
    const workspace = join(root, 'native-runtime');
    await mkdir(workspace);
    let phase = 'cancel';
    let mcpCalls = 0;
    let approvals = 0;
    const catalogs = [];
    const model = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (!body.tools?.length) {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'title', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture' }, finish_reason: 'stop' }] }));
            return;
        }
        catalogs.push(body.tools.map((tool) => tool.function.name));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (phase === 'cancel') { chunk({ role: 'assistant', content: 'Working' }); return; }
        if (phase === 'tool') {
            const name = catalogs.at(-1).find((name) => name.endsWith('_mcp__docs__lookup'));
            if (!name) { response.end('data: [DONE]\n\n'); return; }
            phase = 'done';
            chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${mcpCalls}`, type: 'function', function: { name, arguments: '{"query":"test"}' } }] });
            chunk({}, 'tool_calls');
        } else {
            chunk({ role: 'assistant', content: 'OK' });
            chunk({}, 'stop');
        }
        response.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
    const config = { providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'test-only' }, models: { stub: { name: 'Stub' } } } } };
    await writeFile(join(workspace, 'opencode.json'), JSON.stringify(config));
    const env = { ...process.env, XDG_CONFIG_HOME: join(workspace, 'config'), XDG_DATA_HOME: join(workspace, 'data'), XDG_CACHE_HOME: join(workspace, 'cache'), XDG_STATE_HOME: join(workspace, 'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: 'true' };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    const engine = new OpenCodeEngine(binary, env, undefined, {
        listTools: async () => [{ name: 'mcp__docs__lookup', serverName: 'docs', originalName: 'lookup', description: 'Lookup documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, autoApprove: false }],
        callTool: async (name, args, signal) => {
            assert.equal(name, 'mcp__docs__lookup');
            assert.deepEqual(args, { query: 'test' });
            assert.equal(signal.aborted, false);
            mcpCalls++;
            return { text: 'Found documentation', images: [] };
        },
    });
    let session;
    const host = {
        approvals: { requestApproval: async (_id, calls) => { approvals++; assert.equal(calls[0].name, 'mcp__docs__lookup'); return Object.fromEntries(calls.map((call) => [call.id, true])); } },
        questions: { ask: async () => ({ kind: 'dismissed' }) },
        onSession: async (ref) => { session = ref; },
    };
    const turn = { prompt: 'Fixture', model: 'fixture/stub', workspace, plan: false, yolo: false };
    try {
        let nativeID;
        for (let attempt = 0; attempt < 2; attempt++) {
            phase = 'cancel';
            const controller = new AbortController();
            await assert.rejects(async () => {
                for await (const event of engine.runTurn({ ...turn, session, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }, host)) {
                    if (event.type === 'chunk') controller.abort();
                }
            }, { name: 'AbortError' });
            nativeID ??= session.nativeSessionId;
            phase = 'tool';
            const events = [];
            for await (const event of engine.runTurn({ ...turn, session, signal: AbortSignal.timeout(30_000) }, host)) events.push(event);
            assert.equal(events.at(-1).value, 'done');
            assert.equal(events.find((event) => event.type === 'toolResult')?.output, 'Found documentation');
            assert.equal(session.nativeSessionId, nativeID);
        }
        phase = 'done';
        for await (const _event of engine.runTurn({ ...turn, session, plan: true, signal: AbortSignal.timeout(30_000) }, host)) { /* drain */ }
        assert.equal(catalogs.at(-1).some((name) => name.endsWith('_mcp__docs__lookup')), false, 'Plan excludes shared MCP tools from the real native catalog');
        assert.equal(mcpCalls, 2);
        assert.equal(approvals, 2);
        console.log('ok real OpenCode binary: first-turn MCP readiness, repeated cancellation, same-session resume, MCP execution, approval attribution and Plan');
    } finally {
        await engine.dispose();
        model.closeAllConnections();
        await new Promise((resolve) => model.close(resolve));
    }
}

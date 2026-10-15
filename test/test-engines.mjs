import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { OpenCode } from '@opencode/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = await mkdtemp(join(tmpdir(), 'xratu-engines-'));
const bundle = join(root, 'engine.cjs');
await build({ stdin: { contents: "export * from './src/engines/setup'; export * from './src/engines/opencode/engine'; export * from './src/engines/opencode/attachments'; export * from './src/engines/opencode/installation'; export * from './src/engines/opencode/permissions'; export * from './src/engines/opencode/shells'; export * from './src/engines/opencode/mcpBridge';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const require = createRequire(import.meta.url);
const { OpenCodeEngine, OpenCodeAttachmentStore, OpenCodeMcpBridge, OpenCodeInstallation, NativeShellMonitor, EngineError, isFreeModel, releaseTarget, openCodePermissions, setupPhase, canStartSetup } = require(bundle);

async function harness(mode = 'complete', mcpSource) {
    let stream;
    let subscribed = false;
    const requests = [];
    let prompts = 0;
    let stopping = false;
    let settlement;
    let disposed = false;
    const nativeServers = new Map();
    const emit = (type, data) => stream.write(`data: ${JSON.stringify({ type, data })}\r\n\r\n`);
    const finish = () => {
        emit('session.text.delta', { sessionID: 'native-1', delta: 'OK' });
        emit('session.step.ended', { sessionID: 'native-1', cost: 0, tokens: { input: 20, output: 5, reasoning: 2, cache: { read: 10, write: 3 } } });
        emit('session.execution.succeeded', { sessionID: 'native-1', futureField: true });
    };
    const server = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Basic test');
        let raw = '';
        for await (const data of req) raw += data;
        const body = raw ? JSON.parse(raw) : undefined;
        requests.push({ method: req.method, path: req.url, body });
        if (req.url === '/api/event') {
            subscribed = true;
            stream = res;
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(': heartbeat\r\n\r\n');
            return;
        }
        const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: value })); };
        const integration = { id: 'openrouter', name: 'OpenRouter', methods: [{ type: 'key' }, { type: 'oauth', id: 'browser', label: 'Sign in' }], connections: [{ type: 'env', name: 'OPENROUTER_API_KEY', unexpectedSecret: 'must-not-render' }, { type: 'credential', id: 'cred-1', label: 'Saved account', method: 'key', value: { key: 'must-not-render' } }] };
        if (req.method === 'GET' && req.url.startsWith('/api/integration')) { json(req.url.split('?')[0] === '/api/integration' ? [integration] : integration); return; }
        if (req.method === 'GET' && req.url.startsWith('/api/mcp')) { json([{ name: 'native-mcp', status: { status: 'connected' }, configuration: { key: 'must-not-render' } }, ...nativeServers.values()]); return; }
        if (req.url.startsWith('/api/experimental/mcp/')) {
            const name = decodeURIComponent(req.url.split('?')[0].split('/')[4]);
            if (req.method === 'PUT') nativeServers.set(name, { name, status: { status: mode === 'mcpFailed' ? 'failed' : 'connected' } });
            if (req.method === 'DELETE') nativeServers.delete(name);
            res.writeHead(204).end(); return;
        }
        if (req.method === 'GET' && req.url.startsWith('/api/skill')) { json([{ id: 'skill-1', name: 'Native skill', path: 'skill.md', content: 'must-not-render' }]); return; }
        if (req.url.startsWith('/api/model')) { json([
            { id: 'big-pickle', providerID: 'opencode', enabled: true, status: 'active', capabilities: { tools: true, output: ['text'] }, variants: [{ id: 'high' }, { id: 'adaptive' }], cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
            { id: 'paid-model', providerID: 'opencode', enabled: true, status: 'active', capabilities: { tools: true, output: ['text'] }, variants: [{ id: 'high' }, { id: 'adaptive' }], cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] },
        ]); return; }
        if (req.url === '/api/session' || (req.method === 'GET' && req.url === '/api/session/native-1')) { json({ id: 'native-1', location: { directory: root } }); return; }
        if (req.url.split('?')[0].endsWith('/interrupt')) {
            stopping = true;
            settlement = new Promise((resolve) => setTimeout(() => { stopping = false; resolve(); }, 80));
            json({ interrupted: true });
            return;
        }
        if (req.url.endsWith('/wait')) {
            if (mode === 'cancelCleanupFailure') { res.writeHead(500).end(); return; }
            await settlement;
            res.writeHead(204).end();
            return;
        }
        if (req.url.endsWith('/prompt')) {
            assert.ok(subscribed, 'subscribe before prompt');
            assert.equal(stopping, false, 'new prompts must wait for native cancellation settlement');
            json({ id: 'inbox-1' });
            if (body.delivery === 'steer') {
                assert.ok(body.id.startsWith('msg_xratu_'));
                emit('session.execution.succeeded', { sessionID: 'native-1' });
                emit(mode === 'steerCancel' ? 'session.inbox.cancelled' : 'session.inbox.delivered', { sessionID: 'native-1', inboxID: body.id });
                if (mode !== 'steerCancel') { emit('session.execution.started', { sessionID: 'native-1' }); finish(); }
                return;
            }
            const prompt = ++prompts;
            setImmediate(() => {
                emit('session.execution.succeeded', { sessionID: 'native-1' }); // stale terminal before the new execution
                emit('session.execution.started', { sessionID: 'native-1' });
                if (mode.startsWith('ping')) {
                    if (mode === 'pingLimited') emit('session.retry.scheduled', { sessionID: 'native-1', error: { message: 'Rate limit exceeded. Please try again later.' } });
                    else finish();
                    return;
                }
                emit('new.server.event', { unknown: true });
                emit('session.text.delta', { sessionID: 'another-session', delta: 'must not leak' });
                emit('session.tool.input.started', { sessionID: 'native-1', id: 'call-1', name: 'shell' });
                emit('session.tool.called', { sessionID: 'native-1', id: 'call-1', input: { command: 'echo test' } });
                if (mode === 'complete' || mode === 'plan' || (mode === 'cancelGate' && prompt === 1)) emit('permission.asked', { sessionID: 'native-1', id: 'permission-1', action: 'shell', resources: ['echo test'], source: { type: 'tool', id: 'call-1' } });
                if (mode === 'failed') emit('session.execution.failed', { sessionID: 'native-1', error: { type: 'provider', message: 'Provider failed' } });
                if (mode === 'resume' || (mode.startsWith('cancel') && prompt > 1)) finish();
            });
            return;
        }
        res.writeHead(204); res.end();
        if (req.url.includes('/permission/') && req.url.endsWith('/reply')) {
            emit('session.tool.success', { sessionID: 'native-1', id: 'call-1', content: [{ type: 'text', text: 'test' }] });
                emit('form.created', { form: { id: 'form-1', sessionID: 'native-1', title: 'Choose', fields: [{ key: 'choices', type: 'multiselect', title: 'Which?', custom: false, minItems: 2, maxItems: 2, options: [{ label: 'First', value: 'one' }, { label: 'Second', value: 'two' }] }] } });
        }
        if (req.url.includes('/form/') && req.url.endsWith('/reply')) finish();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = OpenCode.make({ baseUrl, headers: { Authorization: 'Basic test' } });
    const engine = new OpenCodeEngine('opencode', undefined, { connect: async () => ({ baseUrl, headers: { Authorization: 'Basic test' }, client }), dispose: async () => { disposed = true; stopping = false; } }, mcpSource, join(root, 'attachments # نمونه'));
    return { engine, requests, wasDisposed: () => disposed, close: async () => { await engine.dispose(); stream?.destroy(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
const baseTurn = { prompt: 'Test', model: 'opencode/big-pickle', workspace: root, plan: false, yolo: false };
const host = { approvals: { requestApproval: async (_id, calls) => { assert.equal(calls[0].id, 'call-1'); return { 'call-1': true }; } }, questions: { ask: async (question) => { assert.equal(question.multiSelect, true); assert.equal(question.minItems, 2); assert.equal(question.maxItems, 2); assert.equal(question.allowCustomAnswer, false); return { kind: 'custom', text: '["First","Second"]' }; } } };
try {
    const codeText = '// code\n'.repeat(6000) + 'const ATTACHMENT_TAIL = "complete";';
    const codeAttachment = { name: 'C:\\outside\\..\\src\\sample.ts', mimeType: 'text/plain', dataBase64: Buffer.from(codeText).toString('base64') };
    const store = new OpenCodeAttachmentStore(join(root, 'attachment-store # نمونه'));
    const prepared = await store.prepare('../native-session', 'Read this', [codeAttachment], new AbortController().signal);
    const savedPath = fileURLToPath(prepared.files[0].uri);
    assert.equal(await readFile(savedPath, 'utf8'), codeText, 'store all code bytes beyond the inline-text cap');
    assert.ok(savedPath.startsWith(join(root, 'attachment-store # نمونه') + require('node:path').sep), 'untrusted session and file names cannot escape storage');
    assert.ok(prepared.text.includes(JSON.stringify(savedPath)));
    assert.equal(prepared.files[0].name, codeAttachment.name);
    const reloaded = await new OpenCodeAttachmentStore(join(root, 'attachment-store # نمونه')).prepare('../native-session', 'Again', [codeAttachment], new AbortController().signal);
    assert.equal(reloaded.files[0].uri, prepared.files[0].uri, 'native attachment references survive store recreation');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(store.prepare('other-session', '', [codeAttachment], aborted.signal), { name: 'AbortError' });
    console.log('ok full native attachment snapshots, safe Windows names, file URL encoding, reload and cancellation');
    const attachedTurn = await harness('resume');
    try {
        for await (const _event of attachedTurn.engine.runTurn({ ...baseTurn, attachments: [codeAttachment], signal: AbortSignal.timeout(5000) }, host)) { /* drain */ }
        const prompt = attachedTurn.requests.find((request) => request.path.endsWith('/prompt')).body;
        assert.equal(await readFile(fileURLToPath(prompt.files[0].uri), 'utf8'), codeText, 'text attachments reach the native prompt as readable files');
    } finally { await attachedTurn.close(); }
    for (const mode of ['complete', 'plan', 'resume', 'failed', 'cancel', 'steer', 'steerCancel']) {
        const test = await harness(mode);
        try {
            let session;
            const rejected = [];
            const controller = new AbortController();
            if (mode === 'cancel') setTimeout(() => controller.abort(), 100);
            const turn = { ...baseTurn, signal: mode === 'cancel' ? controller.signal : AbortSignal.timeout(5000), plan: mode === 'plan', ...(mode === 'resume' ? { session: { engineId: 'opencode', nativeSessionId: 'native-1', binaryPath: 'opencode', workspace: root } } : {}) };
            const collect = async () => {
                const events = [];
                for await (const event of test.engine.runTurn(turn, { ...host, onSteerRejected: (id) => rejected.push(id), onSession: async (ref) => { session = ref; } })) {
                    events.push(event);
                    if (mode.startsWith('steer') && event.type === 'toolCall') assert.equal(await test.engine.steer({ text: 'Change direction', attachments: [codeAttachment], steerId: 'steer-ui-1' }), true);
                }
                return events;
            };
            if (mode === 'failed') await assert.rejects(collect, /Provider failed/);
            else if (mode === 'cancel') await assert.rejects(collect);
            else {
                const events = await collect();
                assert.equal(events.filter((event) => event.type === 'chunk').map((event) => event.value).join(''), mode === 'steerCancel' ? '' : 'OK');
                assert.equal(events.at(-1).value, 'done');
                assert.equal(session.nativeSessionId, 'native-1');
                if (mode !== 'steerCancel') assert.equal(events.find((event) => event.type === 'usage').usage.promptTokens, 33);
                if (mode.startsWith('steer')) {
                    assert.equal(events.filter((event) => event.type === 'assistantMessage').length, 1);
                    if (mode === 'steer') {
                        assert.deepEqual(events.find((event) => event.type === 'steer'), { type: 'steer', text: 'Change direction', attachments: [codeAttachment], steerId: 'steer-ui-1' });
                        const steer = test.requests.find((request) => request.body?.delivery === 'steer').body;
                        assert.equal(await readFile(fileURLToPath(steer.files[0].uri), 'utf8'), codeText, 'steers stage complete code files too');
                    }
                    else assert.deepEqual(rejected, ['steer-ui-1']);
                    assert.equal(await test.engine.steer({ text: 'After settlement' }), false);
                    assert.ok(!test.requests.some((request) => request.path.split('?')[0].endsWith('/interrupt')));
                } else if (mode !== 'resume') {
                    assert.equal(test.requests.find((request) => request.path.includes('/permission/') && request.path.endsWith('/reply')).body.decision, mode === 'plan' ? 'reject' : 'once');
                    assert.deepEqual(test.requests.find((request) => request.path.includes('/form/') && request.path.endsWith('/reply')).body.answer, { choices: ['one', 'two'] });
                } else {
                    assert.equal(test.requests.filter((request) => request.method === 'POST' && request.path === '/api/session').length, 0);
                    assert.ok(test.requests.some((request) => request.path.endsWith('/model')));
                }
            }
            if (mode === 'failed' || mode === 'cancel') assert.ok(test.requests.some((request) => request.path.split('?')[0].endsWith('/interrupt')), 'interrupt the native agent after cancellation or failure');
            console.log(`ok OpenCode ${mode}`);
        } finally { await test.close(); }
    }
    for (const mode of ['cancelResume', 'cancelCleanupFailure']) {
        const test = await harness(mode);
        try {
            let session;
            for (let attempt = 0; attempt < 3; attempt++) {
                const controller = new AbortController();
                await assert.rejects(async () => {
                    for await (const event of test.engine.runTurn({ ...baseTurn, session, signal: controller.signal }, { ...host, onSession: async (ref) => { session = ref; } })) {
                        if (event.type === 'toolCall') controller.abort();
                    }
                }, { name: 'AbortError' });
                const events = [];
                for await (const event of test.engine.runTurn({ ...baseTurn, session, signal: AbortSignal.timeout(5000) }, host)) events.push(event);
                assert.equal(events.at(-1).value, 'done', 'cancelled native session remains usable');
            }
            assert.equal(test.requests.filter((request) => request.method === 'POST' && request.path === '/api/session').length, 1, 'native history and session identity survive cancellation');
            assert.equal(test.wasDisposed(), mode === 'cancelCleanupFailure', 'restart only when native cleanup fails');
            assert.ok(test.requests.some((request) => request.path === '/api/session/native-1/interrupt?resume=false'));
            console.log(`ok OpenCode repeated ${mode}`);
        } finally { await test.close(); }
    }
    for (const gate of ['approval', 'question']) {
        const test = await harness('cancelGate');
        try {
            const controller = new AbortController();
            let session;
            const pending = () => { controller.abort(); return new Promise(() => {}); };
            const gatedHost = { ...host, onSession: async (ref) => { session = ref; },
                ...(gate === 'approval' ? { approvals: { requestApproval: pending } } : { questions: { ask: pending } }),
            };
            await assert.rejects(async () => {
                for await (const _event of test.engine.runTurn({ ...baseTurn, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }, gatedHost)) { /* drain */ }
            }, { name: 'AbortError' });
            const events = [];
            for await (const event of test.engine.runTurn({ ...baseTurn, session, signal: AbortSignal.timeout(5000) }, host)) events.push(event);
            assert.equal(events.at(-1).value, 'done', 'cancel releases an unanswered native decision');
            console.log(`ok OpenCode cancel during pending ${gate}`);
        } finally { await test.close(); }
    }
    const mcpTools = [{ name: 'mcp__docs__lookup', serverName: 'docs', originalName: 'lookup', description: 'Find documentation', inputSchema: { type: 'object', properties: {} }, autoApprove: true }];
    const mcpCalls = [];
    let currentTools = mcpTools;
    const mcpSource = { listTools: async () => currentTools, callTool: async (name, args, signal) => {
        mcpCalls.push({ name, args, signal });
        return { text: 'Documentation', images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }] };
    } };
    const bridge = new OpenCodeMcpBridge(mcpSource);
    const mcpClient = new Client({ name: 'native-test', version: '1.0.0' });
    try {
        bridge.setTools(mcpTools);
        const connection = await bridge.connect();
        assert.equal(new URL(connection.url).hostname, '127.0.0.1');
        assert.equal((await fetch(connection.url, { method: 'POST' })).status, 403);
        assert.equal((await fetch(connection.url, { method: 'POST', headers: { ...connection.headers, Origin: 'https://attacker.example' } })).status, 403);
        assert.equal((await fetch(connection.url, { method: 'POST', headers: connection.headers, body: 'x'.repeat(4 * 1024 * 1024 + 1) })).status, 413, 'bridge bounds incoming payloads');
        await mcpClient.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
        assert.equal((await mcpClient.listTools()).tools[0].name, mcpTools[0].name);
        const call = () => mcpClient.callTool({ name: mcpTools[0].name, arguments: { query: 'test' }, _meta: { 'ai.opencode/sessionID': 'native-1' } });
        assert.equal((await call()).isError, true, 'unbound sessions cannot invoke tools');
        const controller = new AbortController();
        bridge.activate('native-1', true, controller.signal);
        assert.equal((await call()).isError, true, 'Plan rejects MCP execution structurally');
        bridge.activate('native-1', false, controller.signal);
        const result = await call();
        assert.deepEqual(result.content, [{ type: 'text', text: 'Documentation' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
        assert.equal(mcpCalls[0].signal, controller.signal, 'native cancellation reaches the real MCP request');
        controller.abort();
        assert.equal((await call()).isError, true, 'cancelled turns cannot invoke tools');
        assert.equal(mcpCalls.length, 1);
    } finally { await mcpClient.close(); await bridge.dispose(); }
    console.log('ok real MCP handshake, discovery, images, loopback auth, Plan and session isolation');
    const namesBridge = new OpenCodeMcpBridge(mcpSource);
    namesBridge.setTools([
        { ...mcpTools[0], name: 'mcp__foo.bar__lookup', autoApprove: true },
        { ...mcpTools[0], name: 'mcp__foo_bar__lookup', autoApprove: false },
        { ...mcpTools[0], name: `mcp__${'long'.repeat(20)}__lookup` },
    ]);
    assert.equal(namesBridge.toolNames().size, 3, 'normalization cannot merge different servers');
    assert.ok([...namesBridge.toolNames().keys()].every((name) => name.length <= 64));
    assert.equal(namesBridge.trustedActions().length, 2, 'trust cannot transfer across normalized name collisions');
    console.log('ok native MCP name limits and collision-safe approval identity');
    const sharedMcp = await harness('resume', mcpSource);
    try {
        await sharedMcp.engine.configuration(root, AbortSignal.timeout(5000));
        await sharedMcp.engine.configuration(root, AbortSignal.timeout(5000));
        const registrations = () => sharedMcp.requests.filter((request) => request.method === 'PUT' && request.path.startsWith('/api/experimental/mcp/'));
        assert.equal(registrations().length, 1, 'unchanged MCP catalogs are not reconnected');
        const registration = registrations()[0];
        assert.equal(registration.body.config.codemode, false, 'native MCP permissions must not hide inside execute');
        assert.equal(registration.body.config.oauth, false);
        for await (const _event of sharedMcp.engine.runTurn({ ...baseTurn, signal: AbortSignal.timeout(5000) }, host)) { /* drain */ }
        const creation = sharedMcp.requests.find((request) => request.method === 'POST' && request.path === '/api/session');
        const action = `${decodeURIComponent(registration.path.split('?')[0].split('/').at(-1))}_${mcpTools[0].name}`;
        assert.ok(creation.body.permissions.some((rule) => rule.action === action && rule.effect === 'allow'), 'explicit Xratu autoApprove is preserved');
        currentTools = [];
        await sharedMcp.engine.configuration(root, AbortSignal.timeout(5000));
        assert.ok(sharedMcp.requests.some((request) => request.method === 'DELETE' && request.path.startsWith('/api/experimental/mcp/')), 'disabled/removed Xratu servers leave the native catalog');
    } finally { await sharedMcp.close(); }
    console.log('ok runtime MCP registration, unchanged catalogs, trusted tools and removal');
    currentTools = mcpTools;
    const failedMcp = await harness('mcpFailed', mcpSource);
    try {
        await assert.rejects(failedMcp.engine.configuration(root, AbortSignal.timeout(5000)), (error) => error instanceof EngineError && error.valueKey === 'engineMcpBridgeFailed');
        assert.ok(!failedMcp.requests.some((request) => request.path.endsWith('/prompt')), 'a failed bridge is surfaced before starting a tool-less turn');
    } finally { await failedMcp.close(); }
    for (const mode of ['ping', 'pingLimited']) {
        const test = await harness(mode);
        try {
            if (mode === 'ping') await test.engine.ping('opencode/big-pickle', root, AbortSignal.timeout(5000));
            else await assert.rejects(test.engine.ping('opencode/big-pickle', root, AbortSignal.timeout(5000)), /Rate limit exceeded/);
            assert.ok(test.requests.some((request) => request.path.endsWith('/prompt')), 'ping uses the native harness, which the free tier permits');
            assert.ok(test.requests.some((request) => request.method === 'DELETE' && request.path === '/api/session/native-1'), 'temporary ping session is removed');
            assert.deepEqual(test.requests.find((request) => request.method === 'POST' && request.path === '/api/session').body.permissions, [{ action: '*', resource: '*', effect: 'ask' }, { action: 'subagent', resource: '*', effect: 'deny' }]);
            const creates = test.requests.filter((request) => request.method === 'POST' && request.path === '/api/session').length;
            await assert.rejects(test.engine.ping('opencode/paid-model', root, AbortSignal.timeout(5000)), /enginePingFreeOnly/);
            assert.equal(test.requests.filter((request) => request.method === 'POST' && request.path === '/api/session').length, creates, 'paid model probes cannot reach a provider');
        } finally { await test.close(); }
    }
    console.log('ok free-only manual ping, immediate rate-limit result and temporary-session cleanup');
    for (const variant of ['high', 'adaptive', 'removed', undefined]) {
        const test = await harness('resume');
        try {
            for await (const _event of test.engine.runTurn({ ...baseTurn, variant, session: { engineId: 'opencode', nativeSessionId: 'native-1', workspace: root }, signal: AbortSignal.timeout(5000) }, host)) { /* Drain native execution. */ }
            const write = test.requests.find((request) => request.path.endsWith('/model'));
            assert.equal(write.body.model.variant, variant === 'high' || variant === 'adaptive' ? variant : 'default', 'SDK switching receives advertised variants and clears stale selections');
        } finally { await test.close(); }
    }
    console.log('ok native thinking variants, custom variant IDs and reset to default');
    const readiness = { engine: 'opencode', hasWorkspace: true, installed: true, offline: false, hasCredential: false, freeOnly: true };
    assert.equal(setupPhase({ ...readiness, installed: false }), 'install');
    assert.equal(setupPhase({ ...readiness, hasWorkspace: false }), 'workspace');
    assert.equal(setupPhase({ ...readiness, offline: true }), 'offline');
    assert.equal(setupPhase({ ...readiness, models: [] }), 'model');
    assert.equal(setupPhase({ ...readiness, models: [{ id: 'free', free: true, availability: 'rateLimited' }] }), 'attention');
    assert.equal(setupPhase({ ...readiness, engine: 'xratu' }), 'connect');
    const setup = { requestId: 'test', engine: 'opencode', path: 'free', phase: 'ready', models: [{ id: 'free', free: true, availability: 'available', checkedAt: 1000 }] };
    assert.equal(canStartSetup(setup, 'free', 1001), true);
    assert.equal(canStartSetup(setup, 'free', 61_000), false);
    assert.equal(canStartSetup({ ...setup, busy: true }, 'free', 1001), false);
    assert.equal(canStartSetup({ ...setup, models: [{ ...setup.models[0], free: false }] }, 'free', 1001), false);
    assert.equal(canStartSetup(setup, 'paid', 1001), false);
    console.log('ok onboarding readiness, free-only handoff, expiring evidence and busy guard');
    const nativeConfig = await harness();
    try {
        const data = await nativeConfig.engine.configuration(root, AbortSignal.timeout(5000));
        assert.equal(data.integrations[0].connections[0].source, 'env');
        assert.equal(data.integrations[0].key, true);
        assert.equal(data.servers[0].name, 'native-mcp');
        assert.equal(data.skills[0].name, 'Native skill');
        assert.equal(JSON.stringify(data).includes('must-not-render'), false, 'native secrets and skill content never enter display envelopes');
        await nativeConfig.engine.connectKey('openrouter', 'test-only-key', root, AbortSignal.timeout(5000));
        const write = nativeConfig.requests.find((request) => request.method === 'POST' && request.path.includes('/connect/key'));
        assert.deepEqual(write.body, { key: 'test-only-key' });
        assert.ok(write.path.includes('/api/integration/openrouter/connect/key'));
    } finally { await nativeConfig.close(); }
    console.log('ok native SDK settings ownership, secret redaction and explicit key connection');

    const ts = require('typescript');
    const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
    const cls = file.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
    const names = ['_runOpenCodeAgent', '_handleToolApproval', '_resolveLocalApproval', '_releaseApprovalCard', '_pingFreeModel', '_cancelModelPings', '_setupAvailability', '_engineSelect', '_openSetup', '_showStartScreen', '_nativeVariants', '_setNativeVariant', '_nativeModelVariants', '_sendEnginesState', '_checkEngine', '_engineSetPath', '_handleToolDecision', '_fetchModels', '_rememberModelForActiveCredential'];
    const members = cls.members.filter((node) => node.name && names.includes(node.name.getText(file)));
    const sandbox = { AbortController, AbortSignal, EngineError, isFreeModel, clearTimeout, buildLocalUserText: (text) => text, isImageAttachment: (mime) => mime.startsWith('image/'), path: require('node:path'), checkOpenCode: async () => '2.0.26', classifyWorkspace: () => 'code', vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } } };
    vm.runInNewContext(ts.transpileModule(`class Host { ${members.map((node) => node.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const nativeTurn = await harness('cancelResume');
    try {
        const nativeHost = new sandbox.Host();
        const messages = [];
        Object.assign(nativeHost, {
            _sessionEpoch: 1, _selectedModel: baseTurn.model, _abortControllers: new Map(), _localSteerQueue: [],
            _view: { webview: { postMessage: (message) => messages.push(message) } },
            _getOpenCodeEngine: async () => nativeTurn.engine, _nativeVariants: () => ({}),
            _postEngineState: () => {}, _persistLocalSession: async () => {}, _observeNativeShells: () => {},
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            const controller = new AbortController();
            nativeHost._handleLocalAgentEvent = (event) => { if (event.type === 'toolCall') controller.abort(); };
            const cancelled = await nativeHost._runOpenCodeAgent('Stop this', '', undefined, controller);
            assert.equal(cancelled.aborted, true);
            assert.equal(messages.filter((message) => message.type === 'error' && message.valueKey === 'requestCancelled').length, attempt + 1, 'real host cancellation must send the terminal envelope that releases webview typing and tool spinners');
            assert.equal(nativeHost._runInFlight, false);
            assert.equal(nativeHost._nativeTurnActive, false);
            assert.equal(nativeHost._abortControllers.size, 0);
            const events = [];
            nativeHost._handleLocalAgentEvent = (event) => events.push(event);
            await nativeHost._runOpenCodeAgent('Continue', '');
            assert.equal(events.at(-1).value, 'done', 'the real host can continue the same native session');
        }
        nativeHost._handleLocalAgentEvent = () => {};
        await nativeHost._runOpenCodeAgent('Read the attached code', '', [codeAttachment]);
        const nativePrompt = nativeTurn.requests.filter((request) => request.path.endsWith('/prompt')).at(-1).body;
        assert.equal(await readFile(fileURLToPath(nativePrompt.files[0].uri), 'utf8'), codeText, 'the host forwards code attachment bytes instead of dropping them with an image-only filter');
        const terminalCount = messages.length;
        const stale = new AbortController();
        nativeHost._handleLocalAgentEvent = (event) => { if (event.type === 'toolCall') { nativeHost._sessionEpoch++; stale.abort(); } };
        assert.equal((await nativeHost._runOpenCodeAgent('Old session', '', undefined, stale)).aborted, true);
        assert.equal(messages.length, terminalCount, 'an old session cancellation cannot terminate the new view');
        console.log('ok real host cancellation publishes terminal UI state and allows repeated same-session continuation');
    } finally { await nativeTurn.close(); }
    const refreshHost = new sandbox.Host();
    refreshHost._activeEngine = 'opencode';
    refreshHost._sessionEpoch = 1;
    refreshHost._selectedModel = 'opencode/removed-free';
    refreshHost._nativeVariants = () => ({});
    const modelUpdates = [];
    refreshHost._view = { webview: { postMessage: (message) => modelUpdates.push(message) } };
    const savedModels = new Map([['xratu.engineModel.opencode', 'opencode/removed-free']]);
    refreshHost._globalState = { get: (key) => savedModels.get(key), update: async (key, value) => { if (value === undefined) savedModels.delete(key); else savedModels.set(key, value); } };
    let nativeCatalog = [{ id: 'paid', providerID: 'opencode', name: 'Paid model', variants: [], limit: { context: 128000 }, capabilities: { input: ['text'], tools: true }, cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] }];
    refreshHost._getOpenCodeEngine = async () => ({ models: async () => nativeCatalog });
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, null, 'a removed free model must not silently fall back to a paid model');
    assert.equal(savedModels.has('xratu.engineModel.opencode'), false, 'clear the persisted native model so switching engines cannot restore a removed paid selection');
    assert.equal(modelUpdates.findLast((message) => message.type === 'modelInfo').selectedModel, '', 'clear the stale composer selection explicitly');
    refreshHost._selectedModel = null;
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, null, 'a first-run paid-only catalog requires explicit selection too');
    nativeCatalog.push({ ...nativeCatalog[0], id: 'replacement-free', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] });
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, 'opencode/replacement-free', 'verified free routes take precedence over paid catalog ordering');
    assert.equal(savedModels.get('xratu.engineModel.opencode'), 'opencode/replacement-free');
    refreshHost._selectedModel = 'opencode/paid';
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, 'opencode/paid', 'keep an explicitly selected paid model');
    nativeCatalog.push({ ...nativeCatalog[0], id: 'big-pickle' });
    refreshHost._selectedModel = null;
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, 'opencode/replacement-free', 'a formerly free route with paid pricing is not a fallback');
    nativeCatalog.at(-1).cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
    refreshHost._selectedModel = null;
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, 'opencode/big-pickle', 'retain the preferred default when its pricing is verified free');
    nativeCatalog = [{ ...nativeCatalog[0], id: 'unknown', cost: [] }, { ...nativeCatalog[0], id: 'subscription', providerID: 'openai', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }];
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, null, 'unknown pricing and subscription routes cannot be automatic fallbacks');
    nativeCatalog = [];
    await refreshHost._fetchModels();
    assert.equal(refreshHost._selectedModel, null);
    console.log('ok native catalog refresh requires explicit paid selection and clears stale UI selection');
    const checkHost = new sandbox.Host();
    const enginePaths = new Map();
    checkHost._globalState = { get: (key) => enginePaths.get(key), update: async (key, value) => { enginePaths.set(key, value); } };
    checkHost._engineCheckEpoch = 0;
    checkHost._postEngineState = () => {};
    checkHost._engineInstallation = () => ({ managedBinary: async () => undefined });
    const checks = [];
    let releaseCheck;
    sandbox.checkOpenCode = async (binary) => { checks.push(binary); return new Promise((resolve) => { releaseCheck = () => resolve('2.0.26'); }); };
    const firstCheck = checkHost._sendEnginesState();
    const secondCheck = checkHost._sendEnginesState();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(checks, ['opencode'], 'concurrent callers share one binary check');
    const customBinary = join(root, 'custom-opencode');
    const changedPath = checkHost._engineSetPath(customBinary);
    releaseCheck();
    await Promise.all([firstCheck, secondCheck]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(checks, ['opencode', customBinary], 'changed inputs receive a fresh check');
    releaseCheck();
    await changedPath;
    assert.equal(checkHost._engineSetup.phase, 'ready');
    assert.equal(checkHost._engineSetup.binaryPath, customBinary);
    assert.equal(checkHost._engineCheck, undefined);
    const decisionHost = new sandbox.Host();
    decisionHost._localDecisionResolvers = new Map([['limited', { question: { multiSelect: true, minItems: 2, maxItems: 2, allowCustomAnswer: false, options: [{ label: 'First' }, { label: 'Second' }, { label: 'Third' }] } }]]);
    let resolvedDecision;
    decisionHost._resolveLocalDecision = (_id, outcome) => { resolvedDecision = outcome; };
    decisionHost._handleToolDecision('limited', '["First"]', false);
    decisionHost._handleToolDecision('limited', '["First","Second","Third"]', false);
    assert.equal(resolvedDecision, undefined, 'invalid selection counts keep the decision open');
    decisionHost._handleToolDecision('limited', '["First","Second"]', false);
    assert.equal(resolvedDecision.text, '["First","Second"]');
    console.log('ok concurrent engine checks, path invalidation and form selection bounds');
    const approvalHost = new sandbox.Host();
    const switchHost = new sandbox.Host();
    const state = new Map([['xratu.setupPath', 'provider']]);
    switchHost._activeEngine = 'opencode';
    switchHost._globalState = { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); } };
    switchHost._getSavedCredentials = async () => [{ id: 'saved' }];
    switchHost._serializeSessionTransition = async (operation) => operation();
    switchHost._persistLocalSession = async () => {};
    switchHost._postEngineState = () => {};
    switchHost._cancelSetup = () => {};
    let chatStarted = false;
    switchHost._clearHistoryNow = async (replacement) => {
        chatStarted = true;
        assert.equal(state.get('xratu.setupPath'), undefined, 'unfinished setup must not hijack a configured engine switch');
        switchHost._activeEngine = replacement.engineId;
        switchHost._selectedModel = replacement.model;
        return true;
    };
    switchHost._openSetup = async () => { throw new Error('configured engine must open chat'); };
    await switchHost._engineSelect('xratu');
    assert.equal(chatStarted, true);
    switchHost._activeEngine = 'opencode';
    switchHost._getSavedCredentials = async () => [];
    let credentialsOpened = false;
    let pendingPage;
    switchHost._startupPage = { open: (operation) => { pendingPage = operation; } };
    switchHost._setLlmCredentials = async (_reason, card) => { credentialsOpened = card === 'byok'; };
    await switchHost._engineSelect('xratu');
    assert.equal(credentialsOpened, false, 'Providers waits for the reloaded webview startup');
    await pendingPage();
    assert.equal(credentialsOpened, true, 'missing credentials open Providers, not onboarding');
    assert.equal(switchHost._activeEngine, 'xratu');
    assert.equal(state.get('xratu.setupCompleted'), true);
    state.set('xratu.setupPath', 'free');
    state.set('xratu.engineModel.opencode', 'opencode/big-pickle');
    switchHost._sendEnginesState = async () => { switchHost._engineSetup = { phase: 'ready' }; };
    await switchHost._engineSelect('opencode');
    assert.equal(switchHost._activeEngine, 'opencode');
    assert.equal(switchHost._selectedModel, 'opencode/big-pickle');
    assert.equal(state.get('xratu.setupPath'), undefined);
    switchHost._clearHistoryNow = async () => false;
    await switchHost._engineSelect('xratu');
    assert.equal(switchHost._activeEngine, 'opencode', 'failed target creation leaves the prior engine selected');
    assert.equal(switchHost._selectedModel, 'opencode/big-pickle');

    const startupHost = new sandbox.Host();
    const startupState = new Map();
    const startupMessages = [];
    startupHost._globalState = { get: (key) => startupState.get(key), update: async (key, value) => { startupState.set(key, value); } };
    startupHost._view = { webview: { postMessage: (message) => startupMessages.push(message) } };
    startupHost._activeEngine = 'xratu';
    startupHost._getSavedCredentials = async () => [];
    startupHost._sendSavedCredentials = startupHost._sendOAuthState = startupHost._restoreLocalSession = async () => {};
    startupHost._restoreChatUI = startupHost._pushSessionState = () => {};
    startupHost._cancelSetup = () => {};
    startupHost._fetchModels = async () => false;
    await startupHost._showStartScreen();
    assert.equal(startupMessages.at(-1).type, 'showWelcome', 'first installation opens onboarding');
    startupState.set('xratu.setupPath', 'provider');
    await startupHost._showStartScreen();
    assert.equal(startupMessages.at(-1).path, 'provider', 'unfinished first setup resumes its path');
    startupState.set('xratu.setupCompleted', true);
    startupMessages.length = 0;
    await startupHost._showStartScreen();
    assert.equal(startupMessages.at(-1).type, 'showChat', 'completed setup stays in chat even without credentials');
    assert.equal(startupState.get('xratu.setupPath'), undefined, 'stale setup paths cannot reopen onboarding');
    await startupHost._openSetup('free');
    assert.equal(startupMessages.at(-1).type, 'openEngines', 'later setup links open engine settings instead of onboarding');
    startupState.delete('xratu.setupCompleted');
    startupHost._getSavedCredentials = async () => [{ id: 'legacy' }];
    await startupHost._showStartScreen();
    assert.equal(startupMessages.at(-1).type, 'showChat', 'existing configured installations skip onboarding');
    assert.equal(startupState.get('xratu.setupCompleted'), true);
    console.log('ok first-install onboarding and subsequent engine switches stay separate');
    switchHost._nativeModelVariants = { 'opencode/big-pickle': ['high', 'adaptive'] };
    await switchHost._setNativeVariant('opencode/big-pickle', 'adaptive');
    assert.equal(state.get('xratu.nativeVariants')['opencode/big-pickle'], 'adaptive');
    await switchHost._setNativeVariant('opencode/big-pickle', 'unknown');
    assert.equal(state.get('xratu.nativeVariants')['opencode/big-pickle'], 'adaptive');
    await switchHost._setNativeVariant('opencode/big-pickle', null);
    assert.equal(state.get('xratu.nativeVariants')['opencode/big-pickle'], undefined);
    console.log('ok configured engine switches bypass onboarding and native variants persist safely');
    const approvalID = 'opencode:native-1:permission-1';
    let decision;
    let released = false;
    approvalHost._localApprovalResolvers = { [approvalID]: { resolve: (value) => { decision = value; } } };
    approvalHost._approvalCloseItems = { [approvalID]: [{ tool_call_id: 'call-1' }] };
    approvalHost._approvalCardRelease = new Map([[approvalID, () => { released = true; }]]);
    approvalHost._view = { webview: { postMessage: () => {} } };
    await approvalHost._handleToolApproval(approvalID, { 'call-1': true });
    assert.deepEqual(decision, { 'call-1': true }, 'Apply resolves OpenCode approval, regardless of id prefix');
    assert.ok(released);
    assert.equal(approvalHost._localApprovalResolvers[approvalID], undefined);
    console.log('ok real host OpenCode approval dispatch');
    const pingHost = new sandbox.Host();
    pingHost._activeEngine = 'opencode';
    pingHost._sessionEpoch = 1;
    pingHost._modelPingControllers = new Map();
    const pingUpdates = [];
    const pendingPings = new Map();
    let engineStarts = 0;
    pingHost._view = { webview: { postMessage: (message) => pingUpdates.push(message) } };
    pingHost._getOpenCodeEngine = async () => {
        engineStarts++;
        return { ping: (model, _workspace, signal) => new Promise((resolve, reject) => {
            pendingPings.set(model, { resolve, signal });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }) };
    };
    const slow = pingHost._pingFreeModel('opencode/slow');
    const fast = pingHost._pingFreeModel('opencode/fast');
    const other = pingHost._pingFreeModel('openrouter/free');
    await pingHost._pingFreeModel('opencode/slow'); // duplicate while pending
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingPings.size, 3, 'all probes start without waiting for another model to finish');
    assert.equal(engineStarts, 1, 'parallel probes share one engine initialization');
    pendingPings.get('opencode/fast').resolve();
    await fast;
    assert.equal(pingUpdates.filter((update) => update.state.status === 'available').length, 1);
    assert.equal(pingHost._modelPingControllers.size, 2, 'one result does not finish the other checks');
    pingHost._cancelModelPings();
    const updateCount = pingUpdates.length;
    assert.equal(pingUpdates.filter((update) => update.state.detail === 'requestCancelled').length, 2, 'cancel releases each checking button');
    await Promise.all([slow, other]);
    assert.ok(pendingPings.get('opencode/slow').signal.aborted);
    assert.ok(pendingPings.get('openrouter/free').signal.aborted);
    assert.equal(pingUpdates.length, updateCount, 'cancelled probes cannot overwrite a fresh picker/session');
    assert.equal(pingHost._modelPingControllers.size, 0);
    console.log('ok concurrent host model checks, shared initialization, duplicate suppression and cancellation');
    assert.equal(isFreeModel({ id: 'big-pickle', providerID: 'opencode', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }), true);
    assert.equal(isFreeModel({ id: 'big-pickle', providerID: 'opencode', cost: [] }), false, 'unknown pricing is not free');
    assert.equal(isFreeModel({ id: 'big-pickle', providerID: 'opencode', cost: [{ input: 0, output: 0, cache: { read: 0, write: 1 } }] }), false);
    const zero = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }];
    assert.equal(isFreeModel({ id: 'gpt-subscription', providerID: 'openai', cost: zero }), false, 'subscription pricing is not a public free model');
    assert.equal(isFreeModel({ id: 'unknown-model', providerID: 'opencode', cost: zero }), false, 'zero placeholder pricing alone cannot authorize a probe');
    assert.equal(isFreeModel({ id: 'vendor/model:free', providerID: 'openrouter', cost: zero }), true);
    assert.equal(isFreeModel({ id: 'vendor/model', providerID: 'openrouter', cost: zero }), false);
    assert.equal(isFreeModel({ id: 'new-model-free', providerID: 'opencode', cost: [...zero, { input: 1, output: 1, cache: { read: 0, write: 0 } }] }), false, 'every pricing tier must be free');
    let shellStatus = 'running';
    let cursor = 0;
    let removed = false;
    const updates = [];
    const info = () => ({ id: 'shell-1', command: 'echo test', cwd: root, metadata: { sessionID: 'native-1' }, status: shellStatus, exit: shellStatus === 'exited' ? 7 : undefined, time: { started: Date.now() - 1000 } });
    const monitor = new NativeShellMonitor(async () => ({ shell: {
        get: async ({ id }) => ({ data: id === 'foreign' ? { ...info(), metadata: { sessionID: 'other' } } : info() }),
        list: async () => ({ data: shellStatus === 'running' ? [info()] : [] }),
        output: async () => ({ data: { output: cursor++ === 0 ? 'start\n' : 'end\n', cursor, truncated: false } }),
        remove: async () => { removed = true; shellStatus = 'killed'; },
    } }), (update) => updates.push(update));
    try {
        monitor.watch('native-1', root);
        await monitor.track('shell-1', 'native-1', 'call-1', true);
        await monitor.refresh();
        assert.equal(monitor.views()[0].jobId, 'opencode:shell-1');
        assert.equal(monitor.views()[0].running, true);
        shellStatus = 'exited';
        await monitor.refresh();
        assert.equal(monitor.views()[0].exitCode, 7, 'real exit code is retained');
        assert.equal(monitor.views()[0].running, false);
        await monitor.track('foreign', 'native-1', 'call-foreign', true);
        assert.equal(monitor.views().length, 1, 'another native session cannot be attached or stopped');
        assert.equal(await monitor.stop('opencode:foreign'), false);
        assert.equal(await monitor.stop('opencode:shell-1'), true);
        assert.ok(removed);
        assert.equal(monitor.views()[0].status, 'killed');
    } finally { monitor.dispose(); }
    console.log('ok native background output, exit codes, ownership and stop');
    let foregroundCursor = 0;
    const foregroundUpdates = [];
    const foreground = new NativeShellMonitor(async () => ({ message: { list: async () => ({ data: [] }) }, shell: {
        get: async () => ({ data: { ...info(), status: 'running' } }), list: async () => ({ data: [] }),
        output: async () => ({ data: { output: ['first\n', 'second\n', 'third\n'][foregroundCursor++] ?? '', cursor: foregroundCursor, truncated: false } }),
    } }), (update) => { if (update.output) foregroundUpdates.push(update); });
    try {
        foreground.watch('native-1', root);
        await new Promise((resolve) => setImmediate(resolve));
        await foreground.track('shell-1', 'native-1', 'foreground-call');
        await foreground.refresh();
        await foreground.refresh();
        assert.deepEqual(foregroundUpdates.map((update) => update.output), ['first\n', 'second\n'], 'foreground reducers receive deltas without repeated output');
        await foreground.track('shell-1', 'native-1', 'foreground-call', true);
        await foreground.refresh();
        assert.equal(foregroundUpdates.at(-1).output, 'first\nsecond\nthird\n', 'background reducers receive the full accumulated buffer');
    } finally { foreground.dispose(); }
    const policy = openCodePermissions(true, true);
    assert.deepEqual(policy[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(!policy.some((rule) => ['shell', 'edit', 'subagent', 'mcp__server__write'].includes(rule.action) && rule.effect === 'allow'));
    assert.equal(openCodePermissions(false, true).at(-1).effect, 'deny');
    assert.equal(releaseTarget('win32', 'x64'), 'windows-x64-baseline');
    assert.equal(releaseTarget('linux', 'arm64', true), 'linux-arm64-musl');
    assert.throws(() => releaseTarget('linux', 'ia32'), /no supported release/);
    const originalFetch = globalThis.fetch;
    const installRoot = join(root, 'install');
    try {
        globalThis.fetch = async () => new Response('tampered release', { status: 200 });
        await assert.rejects(new OpenCodeInstallation(installRoot).install(new AbortController().signal, () => {}), /integrity check failed/);
        assert.deepEqual(await readdir(installRoot), [], 'failed installs leave no active runtime or staging');
    } finally { globalThis.fetch = originalFetch; }
    console.log('ok Plan gating, platform selection, and installer integrity');
    if (process.env.XRATU_TEST_OPENCODE_BINARY) {
        const { checkOpenCodeRuntime } = await import('./opencode-runtime-fixture.mjs');
        await checkOpenCodeRuntime(OpenCodeEngine, root, process.env.XRATU_TEST_OPENCODE_BINARY);
    }
} finally { await rm(root, { recursive: true, force: true }); }

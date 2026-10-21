import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { build } from 'esbuild';
import { OpenCode } from '@opencode/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

const root = await mkdtemp(join(tmpdir(), 'xratu-engines-'));
const bundle = join(root, 'engine.cjs');
await build({ stdin: { contents: "export { trimDisplayEvent } from './src/local/eventBounds'; export * from './src/engines/setup'; export * from './src/engines/opencode/engine'; export * from './src/engines/opencode/attachments'; export * from './src/engines/opencode/installation'; export * from './src/engines/opencode/transport'; export * from './src/engines/opencode/environment'; export * from './src/engines/opencode/events'; export * from './src/engines/opencode/releases'; export * from './src/engines/opencode/permissions'; export * from './src/engines/opencode/shells'; export * from './src/engines/opencode/mcpBridge'; export * from './src/engines/opencode/services'; export * from './src/engines/types';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const require = createRequire(import.meta.url);
const { ENGINE_CAPABILITIES, nativeServiceTools, nativeToolDisplayArgs, isNativePlanTool, isNativeServiceTool, openCodeEnvironment, openCodeFetch, subscribeEvents, openCodeUpdateAvailable, OPENCODE_VERSION, trimDisplayEvent, OpenCodeEngine, OpenCodeAttachmentStore, OpenCodeMcpBridge, OpenCodeInstallation, NativeShellMonitor, EngineError, isFreeModel, releaseTarget, openCodePermissions, setupPhase, canStartSetup } = require(bundle);

async function harness(mode = 'complete', mcpSource) {
    let stream;
    let subscribed = false;
    const requests = [];
    let prompts = 0;
    let stopping = false;
    let settlement;
    let disposed = false;
    const nativeServers = new Map();
    const instructions = new Map([['other.policy', 'Keep native integrations intact']]);
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
        if (req.method === 'GET' && req.url.startsWith('/api/agent')) { if (mode === 'agentsFailed') { res.writeHead(500).end(); return; } json([{ id: 'build', name: 'Build', mode: 'primary', hidden: false, system: 'must-not-render' }, { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false }, { id: 'compaction', name: 'Compact', mode: 'primary', hidden: true }]); return; }
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
        if (req.url === '/api/session/active') { json({}); return; }
        if (req.url.endsWith('/inbox')) { json([]); return; }
        if (req.url.startsWith('/api/shell')) { json([]); return; }
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
        if (req.url.includes('/instructions/entries')) {
            if (mode === 'instructionsFailed' || (mode === 'instructionWriteFailed' && req.method === 'PUT')) { res.writeHead(500).end(); return; }
            const key = decodeURIComponent(req.url.split('/instructions/entries/')[1] ?? '');
            if (req.method === 'GET') { json([...instructions].map(([key, value]) => ({ key, value }))); return; }
            if (req.method === 'PUT') {
                assert.match(key, /^[a-z0-9][a-z0-9._-]*$/, 'native instruction keys reject slashes despite the SDK string type');
                instructions.set(key, body.value);
            }
            if (req.method === 'DELETE') instructions.delete(key);
            res.writeHead(204).end(); return;
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
                if (mode === 'serviceEvents') {
                    emit('session.retry.scheduled', { sessionID: 'native-1', attempt: 2, at: Date.now() + 2000, error: { message: 'Temporary outage' } });
                    emit('session.step.started', { sessionID: 'native-1' });
                    for (const type of ['started', 'ended', 'failed']) emit(`session.compaction.${type}`, { sessionID: 'native-1', error: { message: 'Summary unavailable' } });
                    emit('session.tool.input.started', { sessionID: 'native-1', id: 'read-1', name: 'read' });
                    emit('session.tool.called', { sessionID: 'native-1', id: 'read-1', input: { filePath: 'C:\\project\\file.ts' } });
                    emit('session.tool.success', { sessionID: 'native-1', id: 'read-1', structuredContent: { text: 's'.repeat(100_000) }, content: [{ type: 'text', text: 'File read' }, { type: 'file', mime: 'image/png', uri: 'data:image/png;base64,aW1hZ2U=' }, { type: 'file', mime: 'image/png', uri: 'http://127.0.0.1/private' }] });
                    finish();
                    return;
                }
                if (mode.startsWith('ping')) {
                    if (mode === 'pingLimited') emit('session.retry.scheduled', { sessionID: 'native-1', error: { message: 'Rate limit exceeded. Please try again later.' } });
                    else finish();
                    return;
                }
                if (['editFailures', 'editRecovery', 'readFailures', 'externalEditFailures'].includes(mode)) {
                    if (prompt > 1) { finish(); return; }
                    const operations = mode === 'editRecovery'
                        ? ['edit', 'edit', 'read', 'edit', 'edit', 'write', 'edit', 'edit']
                        : Array(18).fill(mode === 'readFailures' ? 'read' : mode === 'externalEditFailures' ? 'external_edit' : 'edit');
                    operations.forEach((name, index) => {
                        const id = `edit-${index}`;
                        const success = mode === 'editRecovery' && ['read', 'write'].includes(name);
                        emit('session.tool.input.started', { sessionID: 'native-1', id, name });
                        emit('session.tool.called', { sessionID: 'native-1', id, input: { path: 'game/combat.py\noldString:\n...', oldString: 'unchanged', newString: 'unchanged' } });
                        emit(success ? 'session.tool.success' : 'session.tool.failed', { sessionID: 'native-1', id, error: { message: index < 4 ? 'ENAMETOOLONG: name too long' : 'No changes to apply: oldString and newString are identical.' } });
                    });
                    finish();
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
    return { engine, requests, instructions, wasDisposed: () => disposed, close: async () => { await engine.dispose(); stream?.destroy(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
const baseTurn = { prompt: 'Test', model: 'opencode/big-pickle', workspace: root, plan: false, yolo: false };
const host = { approvals: { requestApproval: async (_id, calls) => { assert.equal(calls[0].id, 'call-1'); return { 'call-1': true }; } }, questions: { ask: async (question) => { assert.equal(question.multiSelect, true); assert.equal(question.minItems, 2); assert.equal(question.maxItems, 2); assert.equal(question.allowCustomAnswer, false); return { kind: 'custom', text: '["First","Second"]' }; } } };
try {
    const nativePolicy = await harness('resume');
    try {
        let session;
        const run = async (context, prompt = 'you okay?') => {
            for await (const _event of nativePolicy.engine.runTurn({ ...baseTurn, context, prompt, session, signal: AbortSignal.timeout(5000) }, { ...host, onSession: async ref => { session = ref; } })) { /* drain */ }
        };
        await run('Build policy');
        assert.equal(nativePolicy.requests.find(request => request.path.endsWith('/prompt')).body.text, 'you okay?', 'native user text must be byte-identical to the user request');
        assert.equal(nativePolicy.instructions.get('xratu.policy'), 'Build policy');
        const puts = () => nativePolicy.requests.filter(request => request.method === 'PUT' && request.path.includes('/instructions/entries/'));
        assert.equal(puts().length, 1);
        const firstPut = nativePolicy.requests.indexOf(puts()[0]);
        assert.ok(firstPut < nativePolicy.requests.findIndex(request => request.path.endsWith('/prompt')), 'instructions must be installed before generation');
        await run('Build policy', 'Follow up');
        assert.equal(puts().length, 1, 'unchanged policy must not rewrite the native instruction prefix');
        // Simulate a restored session whose persisted policy differs from memory.
        nativePolicy.instructions.set('xratu.policy', 'Stale build policy');
        await run('Plan policy', 'Plan only');
        assert.equal(nativePolicy.instructions.get('xratu.policy'), 'Plan policy', 'resume replaces stale policy instead of retaining build-mode instructions');
        assert.equal(puts().length, 2);
        await run(undefined, 'No host policy');
        assert.equal(nativePolicy.instructions.has('xratu.policy'), false, 'absent context clears the previous host policy');
        assert.equal(nativePolicy.instructions.get('other.policy'), 'Keep native integrations intact');
        assert.deepEqual(nativePolicy.requests.filter(request => request.path.endsWith('/prompt')).map(request => request.body.text), ['you okay?', 'Follow up', 'Plan only', 'No host policy']);
    } finally { await nativePolicy.close(); }
    for (const mode of ['instructionsFailed', 'instructionWriteFailed']) {
        const policyFailure = await harness(mode);
        try {
            await assert.rejects(async () => {
                for await (const _event of policyFailure.engine.runTurn({ ...baseTurn, context: 'Required policy', signal: AbortSignal.timeout(5000) }, host)) { /* drain */ }
            });
            assert.ok(!policyFailure.requests.some(request => request.path.endsWith('/prompt')), 'instruction failures cannot silently start a turn without policy');
        } finally { await policyFailure.close(); }
    }
    console.log('ok native instructions are separate, persistent, updated on resume, and fail before generation');
    const edits = await harness('editFailures');
    try {
        const events = [];
        let ref;
        await assert.rejects(async () => {
            for await (const event of edits.engine.runTurn({ ...baseTurn, yolo: true, signal: AbortSignal.timeout(5000) }, { ...host, onSession: async session => { ref = session; } })) events.push(event);
        }, error => error instanceof EngineError && error.valueKey === 'engineRepeatedEditFailures');
        assert.equal(events.filter(event => event.type === 'toolResult' && event.isError).length, 3, 'surface three native edit failures before stopping the loop');
        assert.ok(!events.some(event => event.type === 'status' && event.value === 'done'), 'a stopped edit loop cannot report success');
        assert.ok(edits.requests.some(request => request.path.split('?')[0].endsWith('/interrupt') && new URL(request.path, 'http://localhost').searchParams.get('resume') === 'false'));
        assert.ok(edits.requests.some(request => request.path.endsWith('/wait')), 'wait for native settlement before another turn');
        assert.equal(edits.wasDisposed(), false, 'a settled native session stays available');
        const resumed = [];
        for await (const event of edits.engine.runTurn({ ...baseTurn, session: ref, signal: AbortSignal.timeout(5000) }, host)) resumed.push(event);
        assert.equal(resumed.at(-1).value, 'done', 'the same native conversation can continue after an explicit new prompt');
    } finally { await edits.close(); }
    for (const mode of ['editRecovery', 'readFailures', 'externalEditFailures']) {
        const recovery = await harness(mode);
        try {
            const events = [];
            for await (const event of recovery.engine.runTurn({ ...baseTurn, signal: AbortSignal.timeout(5000) }, host)) events.push(event);
            assert.equal(events.at(-1).value, 'done', mode);
            assert.ok(!recovery.requests.some(request => request.path.split('?')[0].endsWith('/interrupt')), 'successful recovery and unrelated tools must not trigger the native edit stop');
        } finally { await recovery.close(); }
    }
    console.log('ok native edit failures stop, settle and resume; successful recovery and unrelated tools remain usable');
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
                        assert.ok(steer.text.startsWith('Change direction\n\n[Attached file '), 'steering text contains only the user request and attachment reference');
                        assert.ok(!steer.text.includes('Final responses:'), 'steers do not duplicate host instructions');
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
        return { text: 'Documentation', images: [{ mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }], structuredContent: { title: 'Documentation' }, research: { version:1,provider:'direct',outcome:'success',freshness:'live',sources:[],warnings:[],document:{handle:'a'.repeat(24),start:0,end:100,total:500} } };
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
        assert.deepEqual(result.structuredContent, { title: 'Documentation' });
        assert.deepEqual(bridge.takeResearch('native-1','Documentation').document,{handle:'a'.repeat(24),start:0,end:100,total:500});
        assert.equal(mcpCalls[0].signal, controller.signal, 'native cancellation reaches the real MCP request');
        controller.abort();
        assert.equal((await call()).isError, true, 'cancelled turns cannot invoke tools');
        assert.equal(mcpCalls.length, 1);
    } finally { await mcpClient.close(); await bridge.dispose(); }
    console.log('ok real MCP handshake, discovery, images, loopback auth, Plan and session isolation');
    const serviceDefinitions = [
        { name: 'update_task_list', requiresApproval: false }, { name: 'exit_plan_mode', requiresApproval: false },
        { name: 'skill', requiresApproval: false }, { name: 'browser_snapshot', requiresApproval: false },
        { name: 'browser_open', requiresApproval: true }, { name: 'read_file' }, { name: 'task' }, { name: 'browser_unknown' },
    ].map(tool => ({ description: tool.name, inputSchema: { type: 'object', properties: {} }, ...tool }));
    const services = nativeServiceTools(serviceDefinitions);
    assert.deepEqual(services.map(tool => tool.name), ['update_task_list', 'exit_plan_mode', 'skill', 'browser_snapshot', 'browser_open']);
    assert.equal(services.find(tool => tool.name === 'browser_open').autoApprove, false);
    assert.equal(nativeServiceTools([{ name: 'browser_click', description: '', inputSchema: {} }])[0].autoApprove, false, 'browser mutation approval is structural even if a catalog omits its flag');
    const nativeInput = { filePath: 'C:\\src\\file.ts', oldString: 'before', newString: 'after' };
    const display = nativeToolDisplayArgs('edit_file', nativeInput);
    assert.equal(display.path, nativeInput.filePath);
    assert.equal(display.old_text, 'before');
    assert.equal(nativeInput.path, undefined, 'display normalization cannot mutate native arguments');
    assert.equal(ENGINE_CAPABILITIES.opencode.subagents, true);
    const serviceCalls = [];
    const serviceBridge = new OpenCodeMcpBridge({ listTools: async () => services, callTool: async (name, args, signal, context) => {
        serviceCalls.push({ name, context, signal });
        if (args.wait) return new Promise(() => {});
        return { text: 'Updated', images: [] };
    } });
    const serviceClient = new Client({ name: 'services-test', version: '1.0.0' });
    const serviceController = new AbortController();
    try {
        serviceBridge.setTools([...services, mcpTools[0]]);
        const connection = await serviceBridge.connect();
        await serviceClient.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }));
        serviceBridge.activate('native-plan', true, serviceController.signal);
        const call = (name, sessionID = 'native-plan') => serviceClient.callTool({ name, arguments: {}, _meta: { 'ai.opencode/sessionID': sessionID } });
        for (const name of ['update_task_list', 'exit_plan_mode', 'skill', 'browser_snapshot']) assert.notEqual((await call(name)).isError, true);
        for (const name of ['browser_open', 'mcp__docs__lookup', 'browser_unknown']) assert.equal((await call(name)).isError, true, `${name} stays denied in Plan`);
        assert.equal((await call('skill', 'wrong-session')).isError, true);
        assert.equal(serviceCalls.length, 4);
        assert.deepEqual(serviceCalls[0].context, { sessionID: 'native-plan', plan: true });
        assert.equal(serviceBridge.planActions().length, 4, 'only curated, plan-safe Xratu services get native permission rules');
        const childController = new AbortController();
        serviceBridge.activate('native-child', false, childController.signal, 'native-plan', serviceController.signal);
        for (const name of ['update_task_list', 'exit_plan_mode']) assert.equal((await call(name, 'native-child')).isError, true, 'children cannot reach parent coordination through MCP');
        assert.notEqual((await call('skill', 'native-child')).isError, true);
        assert.deepEqual(serviceCalls.at(-1).context, { sessionID: 'native-child', rootSessionID: 'native-plan', rootSignal: serviceController.signal, plan: false });
        assert.equal(serviceCalls.at(-1).signal, childController.signal);
        const pendingChild = serviceClient.callTool({ name: 'skill', arguments: { wait: true }, _meta: { 'ai.opencode/sessionID': 'native-child' } }).then(result => result.isError, () => true);
        const childDeadline = Date.now() + 3000;
        while (serviceCalls.filter(call => call.context.sessionID === 'native-child').length < 2) {
            if (Date.now() > childDeadline) throw new Error('child service never started');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        childController.abort();
        assert.equal(await pendingChild, true, 'child cancellation settles even an uncooperative bridged service');
        assert.equal((await call('skill', 'native-child')).isError, true, 'stopping one child fences its bridge');
        assert.notEqual((await call('skill')).isError, true, 'a child stop leaves root services available');
        serviceBridge.deactivate('native-child');
        assert.equal((await call('skill', 'native-child')).isError, true);
        const planEngine = await harness('plan', { listTools: async () => services, callTool: async () => ({ text: '', images: [] }) });
        try {
            for await (const _event of planEngine.engine.runTurn({ ...baseTurn, plan: true, signal: AbortSignal.timeout(5000) }, host)) { /* drain */ }
            const policy = planEngine.requests.find(request => request.method === 'POST' && request.path === '/api/session').body.permissions;
            assert.ok(policy.some(rule => rule.action.endsWith('_update_task_list') && rule.effect === 'allow'));
            assert.ok(!policy.some(rule => rule.action.endsWith('_browser_open') && rule.effect === 'allow'));
            assert.ok(policy.some(rule => rule.action === '*' && rule.effect === 'deny'));
        } finally { await planEngine.close(); }
        serviceBridge.activate('native-plan', false, serviceController.signal);
        assert.notEqual((await call('browser_open')).isError, true);
        serviceController.abort();
        assert.equal((await call('skill')).isError, true);
    } finally { await serviceClient.close(); await serviceBridge.dispose(); }
    const nativeEvents = await harness('serviceEvents');
    try {
        const events = [];
        for await (const event of nativeEvents.engine.runTurn({ ...baseTurn, signal: AbortSignal.timeout(5000) }, host)) events.push(event);
        assert.equal(events.find(event => event.type === 'toolCall').args.path, 'C:\\project\\file.ts');
        const output = events.find(event => event.type === 'toolResult');
        assert.equal(output.structuredContent.text.length,8000,'native structured content is bounded and forwarded');
        assert.equal(output.output, 'File read');
        assert.equal(output.images[0].dataBase64, 'aW1hZ2U=');
        assert.equal(output.images.length, 1, 'native file/HTTP URIs are never fetched');
        assert.equal(events.find(event => event.type === 'retrying').maxAttempts, 0, 'native retry limits remain unknown');
        assert.equal(events.filter(event => event.type === 'engineNotice').length, 3);
        assert.ok(events.some(event => event.type === 'attempting'));
    } finally { await nativeEvents.close(); }
    console.log('ok shared service catalog, Plan allowlist, native image parts, display metadata and lifecycle feedback');
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
    const missingAgentApi = await harness('agentsFailed');
    try {
        const data = await missingAgentApi.engine.configuration(root, AbortSignal.timeout(5000));
        assert.equal(data.agentsErrorKey, 'nativeAgentsLoadFailed');
        assert.equal(data.integrations[0].id, 'openrouter', 'optional agent inventory failure must not disable provider settings');
        assert.equal(data.servers[0].name, 'native-mcp');
    } finally { await missingAgentApi.close(); }
    const nativeConfig = await harness();
    try {
        const data = await nativeConfig.engine.configuration(root, AbortSignal.timeout(5000));
        assert.equal(data.integrations[0].connections[0].source, 'env');
        assert.equal(data.integrations[0].key, true);
        assert.equal(data.servers[0].name, 'native-mcp');
        assert.equal(data.skills[0].name, 'Native skill');
        assert.deepEqual(data.agents.map(agent => agent.id), ['build', 'explore']);
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
    const names = ['_requestLocalApproval', '_processNeedsApproval', '_requestLocalDecision', '_resolveLocalDecision', '_releaseDecisionCard', '_runOpenCodeAgent', '_commitUnfinishedLocalTurn', '_displayAssistantResponse', '_handleToolApproval', '_resolveLocalApproval', '_releaseApprovalCard', '_pingFreeModel', '_cancelModelPings', '_setupAvailability', '_engineSelect', '_openSetup', '_showStartScreen', '_nativeVariants', '_setNativeVariant', '_nativeModelVariants', '_sendEnginesState', '_checkEngine', '_engineSetPath', '_engineInstall', '_engineRemove', '_resetOpenCodeEngine', '_getOpenCodeEngine', '_nativeServiceExecutor', '_nativeServiceDefinitions', '_handleToolDecision', '_fetchModels', '_rememberModelForActiveCredential'];
    const members = cls.members.filter((node) => node.name && names.includes(node.name.getText(file)));
    const moduleLoad = Module._load;
    let sharedExecutorModule;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }), isTrusted: true }, env: {} };
            return moduleLoad.call(this, request, parent, isMain);
        };
        sharedExecutorModule = require('../out/mcp.js');
    } finally { Module._load = moduleLoad; }
    const skillModule = require('../out/skills.js');
    const sandbox = { OutsideWorkspacePathError: require('../out/paths.js').OutsideWorkspacePathError, isSessionApproved: require('../out/sessionApproval.js').isSessionApproved, sessionApprovalKind: require('../out/sessionApproval.js').sessionApprovalKind, sanitizePath: require('../out/paths.js').sanitizePath, resolveEditMode: require('../out/tooling/editFileArgs.js').resolveEditMode, externalMcpInstance: undefined, nativeServiceTools, createLocalToolExecutor: sharedExecutorModule.createLocalToolExecutor, getLocalToolDefinitions: sharedExecutorModule.getLocalToolDefinitions, resolveSkillForRun: skillModule.resolveSkillForRun, crypto: require('node:crypto'), isNativePlanTool, isNativeServiceTool, taskListReminderLine: require('../out/taskList.js').taskListReminderLine, providerHttpStatus: require('../out/providerErrors.js').providerHttpStatus, explainError: require('../out/local/errorExplain.js').explainError, buildNativeSystemContext: require('../out/systemPrompt.js').buildNativeSystemContext, OpenCodeEngine, openCodeEnvironment, openCodeUpdateAvailable, isOfflineMode: () => false, getProxyResolution: () => ({mode: 'off', url: null, noProxy: ''}), getProxyDispatcher: () => undefined, process, PULL_REQUEST_TOOLS: require('../out/pullRequests/tools.js').PULL_REQUEST_TOOLS, PULL_REQUEST_AGENT_INSTRUCTIONS: require('../out/pullRequests/tools.js').PULL_REQUEST_AGENT_INSTRUCTIONS, trimDisplayEvent, Error, AbortController, AbortSignal, EngineError, isFreeModel, clearTimeout, buildLocalUserText: (text) => text, isImageAttachment: (mime) => mime.startsWith('image/'), path: require('node:path'), checkOpenCode: async () => '2.0.26', classifyWorkspace: () => 'code', researchSession: () => {}, vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), workspaceFolders: [{ uri: { fsPath: root } }] } } };
    vm.runInNewContext(ts.transpileModule(`class Host { ${members.map((node) => node.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const nativeDefinitionsMethod = sandbox.Host.prototype._nativeServiceDefinitions;
    const nativeExecutorMethod = sandbox.Host.prototype._nativeServiceExecutor;
    Object.assign(sandbox.Host.prototype, { _nativeServiceDefinitions: () => [], _nativeServiceExecutor: () => ({ execute: async () => ({ output: 'ok' }) }), _currentTaskList: () => [], _globalState: { get: () => undefined } });
    function lifecycleHost() {
        const host = new sandbox.Host();
        const operations = [];
        let backgroundRefreshes = 0;
        const values = new Map();
        let managed = join(root, '2.0.26', 'opencode');
        Object.assign(host, {
            _engineCheckEpoch: 0, _activeEngine: 'opencode', _selectedModel: 'opencode/big-pickle',
            _engineSetup: { phase: 'ready', binaryPath: managed, installedByXratu: true },
            _setupAvailability: new Map([['old', {}]]),
            _cancelSetup: () => {}, _cancelNativeSetup: () => {}, _cancelModelPings: () => {},
            _postEngineState: () => {}, _serializeSessionTransition: async (operation) => operation(),
            _postBackgroundJobs: () => { backgroundRefreshes++; },
            _openCodeEngine: { dispose: async () => { operations.push('dispose'); } },
            _persistLocalSession: async () => { operations.push('persist'); },
            _clearHistoryNow: async ({ engineId }) => { operations.push(`chat:${engineId}`); host._activeEngine = engineId; return true; },
            _globalState: { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } },
            _localSessionStore: { list: async () => [], load: async () => null },
            _engineInstallation: () => ({
                managedBinary: async () => managed,
                install: async () => { operations.push('install'); managed = join(root, OPENCODE_VERSION, 'opencode'); return managed; },
                remove: async () => { operations.push('remove'); managed = undefined; },
            }),
        });
        return { host, operations, values, backgroundRefreshes: () => backgroundRefreshes };
    }
    const updating = lifecycleHost();
    await updating.host._engineInstall();
    assert.deepEqual(updating.operations, ['dispose', 'install', 'persist', 'chat:opencode']);
    assert.equal(updating.host._engineInstallController, undefined);
    assert.equal(updating.host._setupAvailability.size, 0);
    assert.equal(updating.backgroundRefreshes(), 1, 'disposed native jobs disappear from the background UI');
    assert.equal(updating.values.get('xratu.enginePath.opencode'), '');
    const removing = lifecycleHost();
    await removing.host._engineRemove();
    assert.deepEqual(removing.operations, ['persist', 'chat:xratu', 'dispose', 'remove']);
    assert.equal(removing.values.get('xratu.activeEngine'), 'xratu');
    const saved = lifecycleHost();
    const savedBinary = join(root, '2.0.26', 'opencode');
    saved.host._localSessionStore = {
        list: async (...args) => { assert.deepEqual(args, [], 'removal checks sessions in every workspace'); return [{ id: 'older-chat' }]; },
        load: async () => ({ engineSession: { engineId: 'opencode', binaryPath: savedBinary } }),
    };
    let preserved;
    saved.host._engineInstallation = () => ({ managedBinary: async () => undefined, remove: async (binaries) => { preserved = binaries; } });
    await saved.host._engineRemove();
    assert.deepEqual(Array.from(preserved), [savedBinary], 'removal preserves the exact saved runtime');
    const unreadable = lifecycleHost();
    unreadable.host._localSessionStore = { list: async () => [{ id: 'unreadable' }], load: async () => null };
    await unreadable.host._engineRemove();
    assert.deepEqual(unreadable.operations, ['persist'], 'unreadable session identity prevents destructive removal or switching chats');
    assert.equal(unreadable.host._engineSetup.errorKey, 'engineRemoveFailed');
    for (const kind of ['busy', 'external', 'installing']) {
        const guarded = lifecycleHost();
        if (kind === 'busy') guarded.host._localRunActive = true;
        if (kind === 'external') guarded.host._engineSetup.installedByXratu = false;
        if (kind === 'installing') guarded.host._engineInstallController = new AbortController();
        await guarded.host._engineRemove();
        assert.deepEqual(guarded.operations, [], `removal must reject ${kind} engines`);
    }
    for (const cancelled of [false, true]) {
        const failed = lifecycleHost();
        failed.host._engineInstallation = () => ({ managedBinary: async () => join(root, 'old'), install: async () => {
            if (cancelled) failed.host._engineInstallController.abort();
            throw new Error('download failed');
        } });
        await failed.host._engineInstall();
        assert.deepEqual(failed.operations, ['dispose'], 'failed/cancelled updates keep the existing conversation');
        assert.equal(failed.host._engineInstallController, undefined);
        assert.equal(failed.host._engineSetup.phase, cancelled ? 'ready' : 'failed');
    }
    const resumed = lifecycleHost();
    resumed.host._engineSetup = { phase: 'ready', binaryPath: join(root, 'new-opencode') };
    resumed.host._sendEnginesState = async () => {};
    resumed.host._engines = { register: () => {} };
    resumed.host._storagePath = root;
    const restoredBinary = join(root, 'old-opencode');
    assert.equal((await resumed.host._getOpenCodeEngine(restoredBinary)).binary, restoredBinary, 'saved native sessions keep their binary identity after an update');
    resumed.host._engineSession = { engineId: 'opencode', binaryPath: restoredBinary };
    assert.equal((await resumed.host._getOpenCodeEngine()).binary, restoredBinary, 'model probes and settings cannot replace the runtime of a restored conversation');
    const boundSource = resumed.host._openCodeEngine.mcpSource;
    const serviceSignal = new AbortController();
    const executions = [];
    resumed.host._nativeToolContext = { sessionID: 'bound-session', plan: true, signal: serviceSignal.signal, executor: { execute: async call => { executions.push(call); return { output: 'Executed', images: [] }; } } };
    const invoke = (name, sessionID = 'bound-session', plan = true, signal = serviceSignal.signal) => boundSource.callTool(name, { name: 'example' }, signal, { sessionID, plan });
    assert.equal((await invoke('skill')).text, 'Executed');
    assert.equal((await invoke('browser_snapshot')).text, 'Executed');
    assert.equal((await invoke('browser_open')).isError, true, 'host independently refuses Plan mutation');
    assert.equal((await invoke('skill', 'unrelated-session')).isError, true);
    assert.equal((await invoke('skill', 'bound-session', false)).isError, true);
    assert.equal((await invoke('skill', 'bound-session', true, new AbortController().signal)).isError, true);
    assert.equal(executions.length, 2, 'wrong session, policy or cancellation identity never reaches the executor');

    const originalServiceExecutor = resumed.host._nativeServiceExecutor;
    let childServiceSignal;
    resumed.host._nativeServiceExecutor = (_workspace, signal) => {
        childServiceSignal = signal;
        return { execute: async () => ({ output: 'Child executed' }) };
    };
    const childService = new AbortController();
    const childContext = { sessionID: 'bound-child', rootSessionID: 'bound-session', rootSignal: serviceSignal.signal, plan: true };
    assert.equal((await boundSource.callTool('skill', {}, childService.signal, childContext)).text, 'Child executed');
    assert.equal(childServiceSignal, childService.signal, 'native host binds service execution to the child signal');
    assert.equal((await boundSource.callTool('skill', {}, childService.signal, { ...childContext, rootSignal: new AbortController().signal })).isError, true, 'a child signal cannot replace turn ownership');
    childService.abort();
    assert.equal((await boundSource.callTool('skill', {}, childService.signal, childContext)).isError, true);
    resumed.host._nativeServiceExecutor = originalServiceExecutor;

    serviceSignal.abort();
    assert.equal((await invoke('skill')).isError, true);
    resumed.host._nativeToolContext = undefined;
    assert.equal((await invoke('skill')).isError, true, 'settled turns lose access');
    const skillDir = join(root, '.xratu', 'skills', 'service-check');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '\ufeff---\r\nname: service-check\r\ndescription: Test shared skill\r\n---\r\nFollow the service checklist.');
    await writeFile(join(skillDir, 'references', 'steps.txt'), 'Inspect the shared executor.');
    const disabledSkills = new Set();
    const browserCalls = [];
    Object.assign(resumed.host, {
        _nativeServiceDefinitions: nativeDefinitionsMethod,
        _nativeServiceExecutor: nativeExecutorMethod,
        _discoverSkillsForRun: workspace => skillModule.listableSkills(skillModule.discoverSkills({ workspaceRoot: workspace }), disabledSkills),
        _disabledSkillIds: () => [...disabledSkills],
        _browserSessionId: () => 'xratu-chat-services',
        _browser: { setSession: id => browserCalls.push({ id }), tool: async (sessionId, name, args, signal) => { browserCalls.push({ sessionId, name, signal }); return { output: 'Browser state', images: [] }; } },
        _checkpoints: { ensureTurnSnapshot: () => { throw new Error('read-only services must not create file snapshots'); } },
    });
    const catalog = await boundSource.listTools();
    assert.ok(catalog.some(tool => tool.name === 'skill' && tool.inputSchema.properties.name.enum.includes('service-check')));
    assert.ok(catalog.some(tool => tool.name === 'update_task_list'));
    assert.ok(catalog.some(tool => tool.name === 'browser_open' && !tool.autoApprove));
    assert.ok(!catalog.some(tool => tool.name === 'task' || tool.name === 'edit_file'));
    const activeSignal = new AbortController();
    const serviceExecutor = resumed.host._nativeServiceExecutor(root, activeSignal.signal, true);
    resumed.host._nativeToolContext = { sessionID: 'native-services', plan: true, signal: activeSignal.signal, executor: serviceExecutor };
    const executeService = (name, args) => boundSource.callTool(name, args, activeSignal.signal, { sessionID: 'native-services', plan: true });
    const expansion = require('../out/xratu_mcp_tools.js');
    let writtenTasks, exitedPlan = false;
    expansion.setTaskListWriteListener(tasks => { writtenTasks = tasks; });
    expansion.setPlanModeExitListener(() => { exitedPlan = true; });
    try {
        const tasks = [{ label: 'Check service integration', status: 'in_progress' }];
        assert.notEqual((await executeService('update_task_list', { tasks })).isError, true);
        assert.deepEqual(writtenTasks, tasks, 'native calls use the actual Xratu task-list writer');
        assert.match((await executeService('skill', { name: 'service-check' })).text, /Follow the service checklist/);
        assert.match((await executeService('skill', { name: 'service-check', resource: 'references/steps.txt' })).text, /Resource: service-check\/references\/steps\.txt\n\nInspect the shared executor\./);
        assert.equal((await executeService('skill', { name: 'service-check', resource: '../outside.txt' })).isError, true);
        disabledSkills.add('project-xratu:service-check');
        assert.equal((await executeService('skill', { name: 'service-check' })).isError, true, 'disabled skills are gated even with a stale native catalog');
        await executeService('browser_snapshot', {});
        assert.equal(browserCalls.at(-1).sessionId, 'xratu-chat-services', 'native metadata must not replace the shared Xratu browser identity');
        assert.equal(browserCalls.at(-1).signal, activeSignal.signal);
        assert.notEqual((await executeService('exit_plan_mode', {})).isError, true);
        assert.equal(exitedPlan, true);
        assert.equal((await serviceExecutor.execute({ id: 'blocked', name: 'browser_open', arguments: { url: 'https://example.test' }, argumentsJson: '{}' })).isError, true, 'ending Plan does not unlock the current executor');
    } finally { expansion.setTaskListWriteListener(null); expansion.setPlanModeExitListener(null); }
    console.log('ok real native host executor: task persistence, skill resources/disablement, browser identity and frozen Plan handoff');
    await resumed.host._openCodeEngine.dispose();
    console.log('ok native host service context enforces session, Plan, cancellation identity and settlement');
    console.log('ok update/removal lifecycle, runtime disposal, failure recovery, busy guards and saved-session identity');
    const nativeTurn = await harness('cancelResume');
    try {
        const nativeHost = new sandbox.Host();
        const messages = [];
        Object.assign(nativeHost, {
            _sessionEpoch: 1, _selectedModel: baseTurn.model, _abortControllers: new Map(), _localSteerQueue: [],
            _view: { webview: { postMessage: (message) => messages.push(message) } },
            _getOpenCodeEngine: async () => nativeTurn.engine, _nativeVariants: () => ({}), _resolveReplyLanguage: () => 'en',
            _postEngineState: () => {}, _persistLocalSession: async () => {}, _observeNativeShells: () => {},
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            const controller = new AbortController();
            nativeHost._handleLocalAgentEvent = (event) => { if (event.type === 'toolCall') controller.abort(); };
            const cancelled = await nativeHost._runOpenCodeAgent('Stop this', undefined, controller);
            assert.equal(cancelled.aborted, true);
            assert.equal(messages.filter((message) => message.type === 'error' && message.valueKey === 'requestCancelled').length, attempt + 1, 'real host cancellation must send the terminal envelope that releases webview typing and tool spinners');
            assert.equal(nativeHost._runInFlight, false);
            assert.equal(nativeHost._nativeTurnActive, false);
            assert.equal(nativeHost._abortControllers.size, 0);
            const events = [];
            nativeHost._handleLocalAgentEvent = (event) => events.push(event);
            await nativeHost._runOpenCodeAgent('Continue');
            assert.equal(events.at(-1).value, 'done', 'the real host can continue the same native session');
        }
        nativeHost._handleLocalAgentEvent = () => {};
        await nativeHost._runOpenCodeAgent('Read the attached code', [codeAttachment]);
        const nativePrompt = nativeTurn.requests.filter((request) => request.path.endsWith('/prompt')).at(-1).body;
        assert.ok(nativeTurn.instructions.get('xratu.policy').includes('Never ask the user to paste a PR into a form'), 'the real native host installs the agent-owned PR policy as instructions');
        assert.ok(nativeTurn.instructions.get('xratu.policy').includes('Language: reply to the user in English.'), 'native policy respects the reply-language setting');
        assert.ok(!JSON.stringify(nativePrompt).includes('Never ask the user to paste a PR into a form'), 'host policy never becomes user text');
        assert.equal(await readFile(fileURLToPath(nativePrompt.files[0].uri), 'utf8'), codeText, 'the host forwards code attachment bytes instead of dropping them with an image-only filter');
        const terminalCount = messages.length;
        const stale = new AbortController();
        nativeHost._handleLocalAgentEvent = (event) => { if (event.type === 'toolCall') { nativeHost._sessionEpoch++; stale.abort(); } };
        assert.equal((await nativeHost._runOpenCodeAgent('Old session', undefined, stale)).aborted, true);
        assert.equal(messages.length, terminalCount, 'an old session cancellation cannot terminate the new view');
        console.log('ok real host cancellation publishes terminal UI state and allows repeated same-session continuation');
    } finally { await nativeTurn.close(); }
    const failedTurn = await harness('editFailures');
    try {
        const failedHost = new sandbox.Host();
        const messages = [], events = [];
        Object.assign(failedHost, {
            _sessionEpoch: 1, _selectedModel: baseTurn.model, _abortControllers: new Map(), _localSteerQueue: [],
            _view: { webview: { postMessage: message => messages.push(message) } },
            _getOpenCodeEngine: async () => failedTurn.engine, _nativeVariants: () => ({}), _resolveReplyLanguage: () => 'auto',
            _postEngineState: () => {}, _persistLocalSession: async () => {}, _observeNativeShells: () => {},
            _handleLocalAgentEvent: event => events.push(event),
        });
        const stopped = await failedHost._runOpenCodeAgent('Fix this file');
        assert.equal(stopped.errorEvent.error_key, 'engineRepeatedEditFailures');
        assert.ok(messages.some(message => message.type === 'error' && message.valueKey === 'engineRepeatedEditFailures'), 'the real host releases the UI with a localized terminal error');
        assert.equal(events.filter(event => event.type === 'toolResult' && event.isError).length, 3);
        assert.equal(failedHost._runInFlight, false);
        assert.equal(failedHost._nativeTurnActive, false);
        assert.equal(failedHost._abortControllers.size, 0);
        failedHost._history = [];
        failedHost._localHistory = [];
        failedHost._pushLocalHistory = row => failedHost._localHistory.push(row);
        failedHost._commitUnfinishedLocalTurn('Fix this file', undefined, undefined, { ...stopped, events: [] }, false, '[interrupted]');
        const restored = failedHost._history.at(-1).events.at(-1);
        assert.equal(restored.error_key, 'engineRepeatedEditFailures', 'the recovery key survives history persistence');
        failedHost._displayAssistantResponse(restored);
        assert.equal(messages.at(-1).valueKey, 'engineRepeatedEditFailures', 'replay resolves the same localized error');
        failedHost._commitUnfinishedLocalTurn('Provider failure', undefined, undefined, { events: [], errorEvent: { error: 'Raw provider message' } }, false, '[interrupted]');
        assert.equal(failedHost._history.at(-1).events.at(-1).error, 'Raw provider message');
        const sessionID = failedHost._engineSession.nativeSessionId;
        await failedHost._runOpenCodeAgent('Continue with a corrected edit');
        assert.equal(failedHost._engineSession.nativeSessionId, sessionID);
        assert.equal(events.at(-1).value, 'done');
    } finally { await failedTurn.close(); }
    console.log('ok repeated native edit failures release the host/UI and preserve same-session continuation');
    for (const explanations of [true, false]) {
        const errorHost = new sandbox.Host();
        const messages = [];
        Object.assign(errorHost, {
            _sessionEpoch: 1, _selectedModel: baseTurn.model, _abortControllers: new Map(),
            _view: { webview: { postMessage: message => messages.push(message) } },
            _getOpenCodeEngine: async () => { throw new Error('getaddrinfo ENOTFOUND provider.example'); },
            _postEngineState: () => {}, _globalState: { get: () => explanations },
        });
        const outcome = await errorHost._runOpenCodeAgent('Check the connection');
        assert.equal(outcome.errorEvent.error, 'getaddrinfo ENOTFOUND provider.example', 'keep the original native error for history');
        assert.equal(messages.at(-1)[explanations ? 'valueKey' : 'value'], explanations ? 'errDns' : 'getaddrinfo ENOTFOUND provider.example');
        assert.equal(errorHost._nativeToolContext, undefined);
    }
    console.log('ok native error explanations respect the shared preference and preserve provider detail');
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
    startupHost._sendSavedCredentials = startupHost._sendOAuthState = startupHost._restoreLocalSessionNow = async () => {};
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
    {
        const gateHost = new sandbox.Host(); const shown = []; const cards = [];
        Object.assign(gateHost, { _sessionApprovedKinds: new Set(), _localApprovalResolvers: {}, _approvalCloseItems: {}, _approvalCardRelease: new Map(), _approvalCardChain: Promise.resolve(), _view: { webview: { postMessage: message => cards.push(message) } }, _processNeedsApproval: async value => { shown.push(value.approval_id); gateHost._approvalCloseItems[value.approval_id] = []; } });
        const first = new AbortController(); const second = new AbortController();
        const one = gateHost._requestLocalApproval('first', [{ tool_call_id: 'one', tool_name: 'run_terminal_command', args: { command: 'echo one' } }], undefined, first.signal);
        const two = gateHost._requestLocalApproval('second', [{ tool_call_id: 'two', tool_name: 'run_terminal_command', args: { command: 'echo two' } }], undefined, second.signal);
        await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(shown, ['first']);
        const rejectedOne = assert.rejects(one, { name: 'AbortError' });
        const reason = new DOMException('Native approval answered elsewhere', 'AbortError'); reason.resolution = 'approved'; first.abort(reason); await rejectedOne;
        await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(shown, ['first', 'second']);
        assert.equal(cards.find(card => card.approval_id === 'first').resolution, 'approved');
        assert.equal(gateHost._approvalCloseItems.first, undefined);
        gateHost._resolveLocalApproval('second', { two: true }); assert.equal((await two).two, true);
        Object.assign(gateHost, { _localDecisionResolvers: new Map(), _decisionCardRelease: new Map(), _decisionCardChain: Promise.resolve() });
        const questionController = new AbortController();
        const question = gateHost._requestLocalDecision({ header: 'Native child', question: 'Choose', options: [], source: { profile: 'general', parentCallId: 'parent', description: 'Review' } }, questionController.signal);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(cards.find(card => card.type === 'decisionRequest').source.parentCallId, 'parent');
        const rejectedQuestion = assert.rejects(question, { name: 'AbortError' }); questionController.abort(); await rejectedQuestion;
        assert.equal(gateHost._localDecisionResolvers.size, 0); assert.equal(gateHost._decisionCardRelease.size, 0);
        assert.ok(cards.some(card => card.type === 'decisionResolved' && card.answer === null));
    }
    console.log('ok real host per-request cancellation releases queued cards and preserves native attribution');
    {
        // AGENTS.md: approvals stay real for children. A root "allow for this
        // session" must not answer a delegated child, and a child's card must
        // not teach the session-wide trust set either.
        const trust = new sandbox.Host();
        const trustCards = [];
        Object.assign(trust, {
            _sessionApprovedKinds: new Set(['cmd:echo']),
            _localApprovalResolvers: {}, _approvalCloseItems: {},
            _approvalCardRelease: new Map(), _approvalCardChain: Promise.resolve(),
            _view: { webview: { postMessage: message => trustCards.push(message) } },
        });
        const rootDecision = await trust._requestLocalApproval('root-trust', [{ tool_call_id: 'root-call', tool_name: 'run_terminal_command', args: { command: 'echo root' } }]);
        assert.equal(rootDecision['root-call'], true, 'a root call still rides the session-approved kind');
        assert.equal(trust._localApprovalResolvers['root-trust'], undefined, 'a session-approved root call never opens a card');
        const childTrust = new AbortController();
        const childRequest = trust._requestLocalApproval('child-card', [{ tool_call_id: 'child-call', tool_name: 'run_terminal_command', args: { command: 'echo child' } }], { profile: 'general', parentCallId: 'parent-call', description: 'Inspect' }, childTrust.signal);
        await new Promise(resolve => setImmediate(resolve));
        const childCard = trustCards.find(message => message.approval_id === 'child-card');
        assert.ok(childCard && childCard.source.parentCallId === 'parent-call', 'a child call whose kind the root trusted still gets its own attributed card');
        assert.equal(trust._approvalCloseItems['child-card'].some(item => item.kind), false, 'a child card records no session-wide kind');
        await trust._handleToolApproval('child-card', { 'child-call': true }, true);
        const childDecision = await childRequest;
        assert.equal(childDecision['child-call'], true, 'the child card still resolves its own request');
        assert.deepEqual([...trust._sessionApprovedKinds], ['cmd:echo'], 'a child session-approval never widens root trust');
        console.log('ok session-approved kinds stay root-scoped and child cards cannot widen them');
    }

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
    assert.equal(openCodePermissions(false, true).at(-1).effect, 'ask');
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
    const nativeHome = join(root, 'native-home');
    const managedRoot = join(nativeHome, 'managed');
    const installation = new OpenCodeInstallation(managedRoot);
    const oldBinary = join(managedRoot, '2.0.26', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    await mkdir(join(managedRoot, '2.0.26'), { recursive: true });
    await writeFile(oldBinary, 'old binary');
    await writeFile(join(managedRoot, 'active'), '\uFEFF2.0.26\r\n');
    await writeFile(join(nativeHome, 'auth.json'), 'native credentials stay here');
    assert.equal(await installation.managedBinary(), oldBinary, 'extension updates find the persisted binary, including a BOM/CRLF pointer');
    assert.equal(openCodeUpdateAvailable('2.0.26'), true);
    assert.equal(openCodeUpdateAvailable(OPENCODE_VERSION), false);
    assert.equal(openCodeUpdateAvailable('2.0.100'), false, 'never downgrade a newer runtime');
    const unusedVersion = join(managedRoot, '2.0.25');
    await mkdir(unusedVersion);
    await writeFile(join(unusedVersion, 'unused'), 'unused runtime');
    await mkdir(join(managedRoot, '.staging-abandoned'));
    await installation.remove([oldBinary, join(root, 'external', 'opencode')]);
    assert.equal(await readFile(oldBinary, 'utf8'), 'old binary', 'saved sessions retain their exact runtime after removal');
    assert.deepEqual(await readdir(managedRoot), ['2.0.26'], 'activation, unused runtimes and abandoned staging are removed');
    assert.equal(await installation.managedBinary(), undefined);
    await installation.remove([oldBinary]);
    assert.equal(await readFile(oldBinary, 'utf8'), 'old binary', 'repeated removal preserves saved runtimes');
    await installation.remove();
    assert.equal(await installation.managedBinary(), undefined);
    assert.equal(await readFile(join(nativeHome, 'auth.json'), 'utf8'), 'native credentials stay here');
    await installation.remove(); // Idempotent removal, including after a partial failure.
    console.log('ok persisted managed runtimes, numeric updates and removal preserve native data');

    const inherited = { HTTP_PROXY: 'http://old:1', all_proxy: 'http://old:2', NO_PROXY: 'internal', no_proxy: 'other', PATH: process.env.PATH };
    for (const mode of ['off', 'custom', 'auto']) {
        const env = openCodeEnvironment(inherited, { mode, url: mode === 'auto' ? 'http://new:3' : null, noProxy: 'configured' });
        assert.equal(env.HTTP_PROXY, mode === 'auto' ? 'http://new:3' : undefined);
        assert.equal(env.all_proxy, undefined);
        assert.equal(env.NO_PROXY, env.no_proxy);
        for (const host of ['127.0.0.1', 'localhost', '::1', 'configured']) assert.ok(env.NO_PROXY.split(',').includes(host));
        assert.equal(env.PATH, inherited.PATH);
        assert.ok(!env.NO_PROXY.includes('other'), 'configured bypasses override inherited lowercase entries');
    }
    assert.ok(openCodeEnvironment(inherited).NO_PROXY.includes('internal,other'));
    assert.equal(inherited.HTTP_PROXY, 'http://old:1', 'do not mutate the extension host environment');
    const requests = [];
    const transportServer = createServer((request, response) => {
        requests.push(request.url);
        assert.equal(request.headers.authorization, 'Basic local-only');
        if (request.url === '/api/event') {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end('data: {"type":"local.ready","data":{"ok":true}}\n\n');
        } else {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"data":[]}');
        }
    });
    await new Promise((resolve) => transportServer.listen(0, '127.0.0.1', resolve));
    const originalDispatcher = getGlobalDispatcher();
    const blockedDispatcher = new MockAgent();
    blockedDispatcher.disableNetConnect();
    try {
        // Reproduce host proxy interception: global fetch denies EVERY request.
        globalThis.fetch = async () => new Response('Forbidden by host proxy', { status: 403 });
        setGlobalDispatcher(blockedDispatcher);
        const baseUrl = `http://127.0.0.1:${transportServer.address().port}`;
        const headers = { Authorization: 'Basic local-only' };
        const brokenClient = OpenCode.make({ baseUrl, headers });
        await assert.rejects(brokenClient.model.list({ location: { directory: root } }), /403/);
        const client = OpenCode.make({ baseUrl, headers, fetch: openCodeFetch });
        assert.deepEqual((await client.model.list({ location: { directory: root } })).data, []);
        const stream = await subscribeEvents(baseUrl, headers, AbortSignal.timeout(5000));
        for await (const event of stream) { assert.equal(event.type, 'local.ready'); break; }
        assert.ok(requests.some((url) => url.startsWith('/api/model')));
        assert.ok(requests.includes('/api/event'));
        const cancelled = new AbortController();
        cancelled.abort();
        await assert.rejects(openCodeFetch(baseUrl, { signal: cancelled.signal }), { name: 'AbortError' });
    } finally {
        globalThis.fetch = originalFetch;
        setGlobalDispatcher(originalDispatcher);
        await blockedDispatcher.close();
        transportServer.closeAllConnections();
        await new Promise((resolve) => transportServer.close(resolve));
    }
    console.log('ok SDK and SSE bypass host proxy 403s with authenticated direct loopback requests');
    if (process.env.XRATU_TEST_OPENCODE_BINARY) {
        const { checkOpenCodeRuntime } = await import('./opencode-runtime-fixture.mjs');
        globalThis.fetch = async () => new Response('Forbidden by host proxy', { status: 403 });
        try { await checkOpenCodeRuntime(OpenCodeEngine, root, process.env.XRATU_TEST_OPENCODE_BINARY); }
        finally { globalThis.fetch = originalFetch; }
    }
} finally { await rm(root, { recursive: true, force: true }); }

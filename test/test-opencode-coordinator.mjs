// Scenarios adapted from T3 Code's OpenCode2AdapterV2.test.ts:
// parallel requests, announced children, nested background reports and Stop.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { OpenCode } from '@opencode/client';

const root = await mkdtemp(join(tmpdir(), 'xratu-native-tree-'));
const bundle = join(root, 'coordinator.cjs');
await build({ stdin: { contents: "export * from './src/engines/opencode/engine'; export * from './src/engines/opencode/coordinator'; export * from './src/engines/opencode/decisions';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { OpenCodeEngine, NativeSessionCoordinator, NativeDecisions } = createRequire(import.meta.url)(bundle);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) {
    const end = Date.now() + 3000;
    while (!test()) { if (Date.now() > end) throw new Error('Timed out waiting for native fixture'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function harness() {
    let stream;
    let disposed = false;
    const requests = [];
    const active = new Set();
    const inboxes = new Map();
    const sessions = new Map([['root', { id: 'root', location: { directory: root } }], ['foreign', { id: 'foreign', parentID: 'another-chat', location: { directory: root } }], ['another-chat', { id: 'another-chat', location: { directory: root } }]]);
    const emit = (type, sessionID, data = {}) => {
        if (type === 'session.execution.started') active.add(sessionID);
        if (/^session.execution.(succeeded|failed|interrupted)$/.test(type)) active.delete(sessionID);
        if (type === 'session.created') sessions.set(sessionID, { id: sessionID, parentID: data.parentID, model: data.model, agent: data.agent, location: { directory: root } });
        stream.write(`data: ${JSON.stringify({ type, data: { sessionID, ...data } })}\n\n`);
    };
    const server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : undefined;
        const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
        requests.push({ route, method: req.method, body });
        const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: value })); };
        if (route === '/api/event') { stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); return; }
        if (route === '/api/session/active') { json(Object.fromEntries([...active].map(id => [id, {}]))); return; }
        if (route === '/api/session') { json(sessions.get('root')); return; }
        const sessionID = route.split('/')[3];
        if (req.method === 'GET' && route === `/api/session/${sessionID}`) { json(sessions.get(sessionID)); return; }
        if (route.endsWith('/inbox')) { json(inboxes.get(sessionID) ?? []); return; }
        if (route.includes('/inbox/') && req.method === 'DELETE') {
            const id = route.split('/').at(-1);
            inboxes.set(sessionID, (inboxes.get(sessionID) ?? []).filter(item => item.id !== id)); res.writeHead(204).end(); return;
        }
        if (route.endsWith('/instructions/entries') || route === '/api/shell') { json([]); return; }
        if (route.endsWith('/prompt')) { json({ id: body.id ?? 'inbox-root' }); return; }
        if (route.endsWith('/interrupt')) { active.delete(sessionID); json({ interrupted: true }); return; }
        if (route.includes('/form/') && route.endsWith('/cancel')) {
            emit('session.execution.interrupted', sessionID); res.writeHead(204).end(); return;
        }
        res.writeHead(204).end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = OpenCode.make({ baseUrl });
    const engine = new OpenCodeEngine('opencode', undefined, { connect: async () => ({ client, baseUrl, headers: {} }), dispose: async () => { disposed = true; active.clear(); } }, undefined, join(root, 'attachments'));
    const observations = [];
    const events = [];
    const controller = new AbortController();
    let outcome;
    const run = (host = {}, options = {}) => {
        const done = (async () => {
            try {
                for await (const event of engine.runTurn({ model: 'opencode/big-pickle', prompt: 'test', workspace: root, plan: false, yolo: false, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), ...options }, {
                    approvals: { requestApproval: async (_id, calls) => Object.fromEntries(calls.map(call => [call.id, true])) },
                    questions: { ask: async () => ({ kind: 'selected', label: 'First', description: '' }) },
                    onObservation: (callId, trace) => observations.push({ callId, trace }), ...host,
                })) events.push(event);
                outcome = 'done';
            } catch (error) { outcome = error; }
        })();
        return done;
    };
    const ready = () => until(() => requests.some(request => request.route.endsWith('/prompt')));
    const tool = (sessionID, id, name, input) => {
        emit('session.tool.input.started', sessionID, { id, name });
        emit('session.tool.called', sessionID, { id, name, input });
    };
    const child = (parent, callID, id, background = false) => {
        tool(parent, callID, 'subagent', { agent: 'general', description: `Inspect ${id}`, prompt: `Explore ${id}`, background });
        emit('session.created', id, { parentID: parent, agent: 'general', model: { providerID: 'opencode', id: 'child-model' } });
        emit('session.tool.progress', parent, { id: callID, metadata: { sessionID: id, status: 'running' } });
        emit('session.execution.started', id);
    };
    const result = (sessionID, id, childID, running = false) => emit('session.tool.success', sessionID, { id, metadata: { ...(childID ? { sessionID: childID } : {}), status: running ? 'running' : 'completed' }, content: [{ type: 'text', text: 'result' }] });
    const report = (parent, id, childID) => emit('session.inbox.enqueued', parent, { inboxID: id, item: { type: 'synthetic', payload: { text: `<subagent state="completed">\nReport ${childID}\n</subagent>`, metadata: { source: 'subagent', childID, state: 'completed' } } } });
    const close = async () => { controller.abort(); await engine.dispose(); stream?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    return { engine, run, ready, emit, tool, child, result, report, requests, observations, events, controller, sessions, active, inboxes, outcome: () => outcome, disposed: () => disposed, close, disconnect: () => stream.destroy() };
}
try {
    {
        // Replay T3's real 2.0.18 wire recording, not just invented shapes.
        const frames = (await readFile(new URL('./fixtures/opencode2-nested-background.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const rootID = frames.find(frame => frame.type === 'session.created').data.sessionID;
        const traces = [];
        const coordinator = new NativeSessionCoordinator(rootID, 'openrouter/deepseek/deepseek-v4-flash', name => name === 'subagent' ? 'task' : name, (id, trace) => traces.push({ id, trace }), () => {});
        let rootEnded = false;
        for (const frame of frames) {
            const queue = [frame];
            for (const event of queue) { coordinator.accept(event); queue.push(...coordinator.drain()); }
            if (frame.type === 'session.execution.succeeded' && frame.data.sessionID === rootID) {
                rootEnded = true; assert.ok(coordinator.pendingWork(), 'real background grandchild outlives the root execution');
            }
        }
        assert.ok(rootEnded); assert.equal(coordinator.pendingWork(), false);
        assert.equal(coordinator.sessions.size, 3);
        assert.equal(traces.at(-1).trace.status, 'done');
        assert.ok(traces.at(-1).trace.entries.some(entry => entry.text.includes('GRANDCHILD_OK')));
        console.log('ok T3 real native nested-background recording, through the final child follow-up');
    }
    {
        const controller = new AbortController(); const failures = []; let firstSignal; let release; let ownSignal;
        const decisions = new NativeDecisions(controller.signal, error => failures.push(error));
        decisions.start('root:permission:first', async signal => { firstSignal = signal; await new Promise(() => {}); });
        decisions.start('root:permission:first', async () => { throw new Error('duplicate must not run'); });
        decisions.start('root:permission:own', async (signal, answering) => { ownSignal = signal; answering(); await new Promise(resolve => { release = resolve; }); });
        await tick(); decisions.settle('root:permission:first', 'approved'); decisions.settle('root:permission:own');
        assert.ok(firstSignal.aborted); assert.equal(firstSignal.reason.resolution, 'approved'); assert.equal(ownSignal.aborted, false);
        release(); await tick(); await decisions.close(); assert.deepEqual(failures, []);
        console.log('ok duplicate requests, external settlement, own HTTP reply race and non-cooperative gates');
    }
    {
        const test = await harness(); const gates = new Map();
        try {
            const done = test.run({ approvals: { requestApproval: (id, calls, source, signal) => new Promise(resolve => gates.set(id, { calls, source, signal, resolve })) } });
            await test.ready(); test.emit('session.execution.started', 'root');
            for (const id of ['one', 'two']) {
                test.child('root', `delegate-${id}`, id);
                test.tool(id, 'same-id', 'shell', { command: `echo ${id}` });
                test.emit('permission.asked', id, { id: 'same-request', action: 'shell', resources: [`echo ${id}`], source: { type: 'tool', id: 'same-id' }, metadata: { command: 'spoofed command', action: 'read' } });
                test.emit('session.text.delta', id, { delta: `private ${id}` });
            }
            await until(() => gates.size === 2);
            assert.equal(test.events.filter(event => event.type === 'chunk').length, 0, 'child prose never enters parent transcript');
            for (const id of ['one', 'two']) {
                const gate = gates.get(`opencode:${id}:same-request`);
                assert.equal(gate.source.parentCallId, `delegate-${id}`);
                assert.equal(gate.calls[0].id, `${id}:same-id`);
                assert.equal(gate.calls[0].arguments.command, `echo ${id}`, 'approval displays actual tool input');
                assert.equal(gate.calls[0].arguments.action, 'shell');
                gate.resolve({ [`${id}:same-id`]: true });
            }
            await until(() => test.requests.filter(request => request.route.includes('/permission/')).length === 2);
            for (const id of ['one', 'two']) {
                test.result(id, 'same-id');
                test.emit('session.step.ended', id, { tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 0, write: 0 } }, cost: 0.01 });
                test.emit('session.execution.succeeded', id);
                test.result('root', `delegate-${id}`, id);
            }
            test.emit('session.text.delta', 'root', { delta: 'Parent answer' });
            test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
            assert.equal(test.events.filter(event => event.type === 'usage').length, 2);
            for (const id of ['one', 'two']) {
                const trace = test.observations.filter(value => value.callId === `delegate-${id}`).at(-1).trace;
                assert.equal(trace.status, 'done'); assert.equal(trace.model, 'opencode/child-model');
                assert.equal(trace.inputTokens, 2); assert.equal(trace.outputTokens, 4);
                assert.equal(trace.entries.find(entry => entry.kind === 'tool').id, `${id}:same-id`);
            }
            console.log('ok parallel native child approvals, identity, actual inputs, observations and spend');
        } finally { await test.close(); }
    }
    {
        const test = await harness();
        try {
            const done = test.run(); await test.ready(); test.emit('session.execution.started', 'root');
            test.child('root', 'parent-call', 'child');
            test.child('child', 'nested-call', 'grandchild', true);
            test.result('child', 'nested-call', 'grandchild', true);
            test.emit('session.execution.succeeded', 'child');
            test.result('root', 'parent-call', 'child'); test.emit('session.execution.succeeded', 'root');
            await tick(); await tick(); assert.equal(test.outcome(), undefined, 'root stays claimed while a nested background child runs');
            test.emit('session.text.delta', 'grandchild', { delta: 'Late native work' });
            test.emit('session.execution.succeeded', 'grandchild');
            test.report('child', 'nested-report', 'grandchild');
            test.emit('session.inbox.delivered', 'child', { inboxID: 'nested-report' });
            test.emit('session.execution.started', 'child'); test.emit('session.text.delta', 'child', { delta: 'Child follow-up' });
            test.tool('child', 'nested-call', 'read', { filePath: 'src/engine.ts' }); test.result('child', 'nested-call');
            test.emit('session.execution.succeeded', 'child'); await done;
            assert.equal(test.outcome(), 'done');
            const trace = test.observations.at(-1).trace;
            assert.equal(trace.status, 'done'); assert.ok(trace.entries.some(entry => entry.text.includes('Late native work')));
            assert.ok(trace.entries.some(entry => entry.id === 'child:nested-call' && entry.tool === 'task'));
            assert.ok(trace.entries.some(entry => entry.id === 'child:2:nested-call' && entry.tool === 'read_file'));
            assert.equal(test.events.filter(event => event.type === 'chunk').length, 0);
            assert.ok(!test.requests.some(request => request.route.endsWith('/interrupt')));
            console.log('ok background grandchildren, child-targeted reports, follow-ups and held parent completion');
        } finally { await test.close(); }
    }
    for (const broken of [false, true]) {
        const test = await harness();
        try {
            const done = test.run(); await test.ready(); test.emit('session.execution.started', 'root');
            test.child('root', 'parent-call', 'child'); test.child('child', 'nested-call', 'grandchild', true);
            test.emit('session.created', 'announced', { parentID: 'root' });
            await until(() => test.engine.coordinator?.owns('announced'));
            test.active.add('foreign');
            if (broken) {
                // Lost session.created/progress still cannot orphan a child.
                test.sessions.set('missed', { id: 'missed', parentID: 'grandchild', location: { directory: root } }); test.active.add('missed');
                test.disconnect();
            } else test.controller.abort();
            await done;
            const stopped = test.requests.filter(request => request.route.endsWith('/interrupt')).map(request => request.route.split('/')[3]);
            for (const id of ['root', 'child', 'grandchild', 'announced', ...(broken ? ['missed'] : [])]) assert.ok(stopped.includes(id), `Stop reaches ${id}`);
            assert.ok(!stopped.includes('foreign')); assert.ok(test.active.has('foreign'));
            assert.ok(test.observations.filter(value => value.callId === 'parent-call').at(-1).trace.endedAt);
            assert.notEqual(test.outcome(), 'done');
            console.log(`ok ${broken ? 'stream loss' : 'Stop'} settles announced, nested and missed children without touching other chats`);
        } finally { await test.close(); }
    }
    {
        const test = await harness();
        try {
            const done = test.run(); await test.ready(); test.emit('session.execution.started', 'root');
            test.child('root', 'background-call', 'child', true); test.result('root', 'background-call', 'child', true);
            test.emit('session.execution.succeeded', 'root');
            test.emit('session.execution.succeeded', 'child'); test.report('root', 'root-report', 'child');
            await tick(); await tick(); assert.equal(test.outcome(), undefined);
            test.emit('session.execution.started', 'root'); test.emit('session.inbox.delivered', 'root', { inboxID: 'root-report' });
            test.emit('session.text.delta', 'root', { delta: 'Report acknowledged' }); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done'); assert.equal(test.events.at(-2).text, 'Report acknowledged');
            console.log('ok direct background launch, held root report and native parent continuation');
        } finally { await test.close(); }
    }
    {
        const test = await harness();
        try {
            const done = test.run(); await test.ready(); test.emit('session.execution.started', 'root');
            for (let round = 1; round <= 2; round++) {
                test.child('root', 'same-native-id', `child-${round}`, true);
                test.result('root', 'same-native-id', `child-${round}`, true); test.emit('session.execution.succeeded', 'root');
                test.emit('session.execution.succeeded', `child-${round}`); test.report('root', `report-${round}`, `child-${round}`);
                test.emit('session.execution.started', 'root'); test.emit('session.inbox.delivered', 'root', { inboxID: `report-${round}` });
            }
            test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
            assert.deepEqual(test.events.filter(event => event.type === 'toolCall').map(event => event.id), ['same-native-id', 'root:2:same-native-id']);
            for (const id of ['same-native-id', 'root:2:same-native-id']) assert.equal(test.observations.filter(value => value.callId === id).at(-1).trace.status, 'done');
            console.log('ok repeated native tool IDs are scoped across parent continuations and child executions');
        } finally { await test.close(); }
    }
    {
        const test = await harness();
        try {
            test.sessions.set('orphan', { id: 'orphan', parentID: 'root', location: { directory: root } });
            test.active.add('orphan'); test.active.add('foreign');
            test.inboxes.set('root', [{ id: 'stranded-steer', type: 'user' }, { id: 'queued-report', type: 'synthetic', payload: { metadata: { source: 'subagent' } } }]);
            test.inboxes.set('orphan', [{ id: 'stranded-child-prompt', type: 'user' }]);
            test.inboxes.set('foreign', [{ id: 'keep-foreign-input', type: 'user' }]);
            const done = test.run({}, { session: { engineId: 'opencode', nativeSessionId: 'root', workspace: root } });
            await test.ready();
            const stopped = test.requests.findIndex(request => request.route === '/api/session/orphan/interrupt');
            const switched = test.requests.findIndex(request => request.route === '/api/session/root/model');
            assert.ok(stopped >= 0 && stopped < switched, 'restore fences orphan descendants before switching model/mode');
            assert.ok(test.active.has('foreign')); assert.ok(!test.active.has('orphan'));
            assert.equal(test.inboxes.get('root').length, 0); assert.equal(test.inboxes.get('orphan').length, 0); assert.equal(test.inboxes.get('foreign').length, 1);
            test.emit('session.execution.started', 'root'); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
            console.log('ok restored sessions fence previous descendants before admitting new work');
        } finally { await test.close(); }
    }
    {
        const test = await harness();
        try {
            const done = test.run({ questions: { ask: async () => { throw new Error('Unsupported fields must not be displayed'); } } });
            await test.ready(); test.emit('session.execution.started', 'root');
            test.emit('form.created', 'root', { form: { sessionID: 'root', id: 'hidden', title: 'Unsupported', fields: [{ key: 'hidden', type: 'string', hidden: true }] } });
            await done; assert.equal(test.outcome().valueKey, 'engineFormUnsupported', 'native cancel terminal must not hide the form error');
            console.log('ok unsupported form errors survive a native cancellation/HTTP response race');
        } finally { await test.close(); }
    }
    for (const yolo of [false, true]) {
        const test = await harness();
        try {
            const done = test.run({ approvals: { requestApproval: async () => { throw new Error('Foreign sessions must never reach UI approval'); } } }, { yolo });
            await test.ready(); test.emit('session.execution.started', 'root');
            test.tool('root', 'bad-resume', 'subagent', { agent: 'general', sessionID: 'foreign' });
            test.emit('permission.asked', 'root', { id: 'bad-permission', action: 'subagent', source: { type: 'tool', id: 'bad-resume' } });
            await until(() => test.requests.some(request => request.route.includes('/permission/')));
            assert.equal(test.requests.find(request => request.route.includes('/permission/')).body.decision, 'reject');
            assert.ok(!test.requests.some(request => request.route === '/api/session/foreign' && request.method !== 'GET'));
            test.emit('session.tool.failed', 'root', { id: 'bad-resume', error: { message: 'declined' } }); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
        } finally { await test.close(); }
    }
    console.log('ok reused session ownership cannot be bypassed with approvals or YOLO');
    {
        const test = await harness(); const approvals = [];
        try {
            const done = test.run({ approvals: { requestApproval: async (id, calls, source) => { approvals.push({ id, source }); return Object.fromEntries(calls.map(call => [call.id, true])); } } }, { yolo: true });
            await test.ready(); test.emit('session.execution.started', 'root');
            test.tool('root', 'root-shell', 'shell', { command: 'echo root' });
            test.emit('permission.asked', 'root', { id: 'root-permission', action: 'shell', source: { type: 'tool', id: 'root-shell' } });
            test.child('root', 'parent-call', 'child');
            test.tool('child', 'child-shell', 'shell', { command: 'echo child' });
            test.emit('permission.asked', 'child', { id: 'child-permission', action: 'shell', source: { type: 'tool', id: 'child-shell' } });
            await until(() => test.requests.filter(request => request.route.includes('/permission/')).length === 2);
            assert.equal(approvals.length, 1); assert.equal(approvals[0].id, 'opencode:child:child-permission'); assert.equal(approvals[0].source.parentCallId, 'parent-call');
            const policy = test.requests.find(request => request.route === '/api/session' && request.method === 'POST').body.permissions;
            assert.equal(policy[0].effect, 'ask', 'children cannot inherit blanket YOLO approval');
            test.result('child', 'child-shell'); test.emit('session.execution.succeeded', 'child'); test.result('root', 'parent-call', 'child'); test.result('root', 'root-shell'); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
            console.log('ok YOLO silently approves root tools while child mutation approvals remain real');
        } finally { await test.close(); }
    }
    {
        const test = await harness(); let question;
        try {
            const done = test.run({ questions: { ask: (value, signal) => { question = { value, signal }; return new Promise(() => {}); } } });
            await test.ready(); test.emit('session.execution.started', 'root'); test.child('root', 'parent-call', 'child');
            test.emit('form.created', 'child', { form: { id: 'native-form', sessionID: 'child', title: 'Native choice', fields: [{ key: 'scope', type: 'string', options: [{ label: 'First', value: 'one' }, { label: 'Second', value: 'two' }] }] } });
            await until(() => question);
            assert.equal(question.value.source.parentCallId, 'parent-call');
            assert.equal(test.observations.at(-1).trace.status, 'waiting');
            test.emit('form.cancelled', 'child', { id: 'native-form' }); await until(() => question.signal.aborted);
            test.emit('session.execution.succeeded', 'child'); test.result('root', 'parent-call', 'child'); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done');
            assert.ok(!test.requests.some(request => request.route.includes('/form/')), 'external settlement never sends a stale form reply or cancel');
            console.log('ok child question attribution, waiting state, native cancellation and non-cooperative question gate');
        } finally { await test.close(); }
    }
    for (const yolo of [false, true]) {
        const test = await harness();
        try {
            test.sessions.set('reused', { id: 'reused', parentID: 'root', location: { directory: root }, model: { providerID: 'opencode', id: 'own-model' } });
            test.inboxes.set('reused', [{ id: 'old-child-prompt', type: 'user' }]);
            const done = test.run({}, { yolo }); await test.ready(); test.emit('session.execution.started', 'root');
            test.tool('root', 'resume-call', 'subagent', { agent: 'general', description: 'Resume inspection', sessionID: 'reused' });
            test.emit('permission.asked', 'root', { id: 'resume-permission', action: 'subagent', source: { type: 'tool', id: 'resume-call' } });
            await until(() => test.requests.some(request => request.route.includes('/permission/')));
            const update = test.requests.findIndex(request => request.route === '/api/session/reused' && request.method !== 'GET');
            const permission = test.requests.findIndex(request => request.route.includes('/permission/'));
            assert.ok(update > 0 && update < permission, 'reused child receives the current permissions before native admission');
            assert.equal(test.requests[permission].body.decision, 'once');
            assert.equal(test.inboxes.get('reused').length, 0, 'a resumed child cannot redeliver an interrupted prompt');
            test.emit('session.tool.progress', 'root', { id: 'resume-call', metadata: { sessionID: 'reused' } });
            test.emit('session.execution.started', 'reused'); test.emit('session.execution.succeeded', 'reused');
            test.result('root', 'resume-call', 'reused'); test.emit('session.execution.succeeded', 'root'); await done;
            assert.equal(test.outcome(), 'done'); assert.equal(test.observations.at(-1).trace.resumed, true); assert.equal(test.observations.at(-1).trace.model, 'opencode/own-model');
        } finally { await test.close(); }
    }
    console.log('ok native resume updates stale permission modes and preserves the child model');
    {
        const test = await harness();
        try {
            const replies = []; const cancels = []; let asked = 0;
            const client = { session: { form: { reply: async value => replies.push(value), cancel: async value => cancels.push(value) } } };
            const signal = new AbortController().signal;
            const host = { questions: { ask: async () => { asked++; return { kind: 'custom', text: '9' }; } } };
            await assert.rejects(test.engine.answerForm(client, { id: 'hidden', sessionID: 'root', fields: [{ key: 'a', type: 'string' }, { key: 'b', type: 'string', hidden: true }] }, host, signal, () => {}), { valueKey: 'engineFormUnsupported' });
            assert.equal(asked, 0, 'preflight checks the whole form before displaying partial questions');
            await assert.rejects(test.engine.answerForm(client, { id: 'bounded', sessionID: 'root', fields: [{ key: 'n', type: 'integer', minimum: 1, maximum: 4 }] }, host, signal, () => {}), { valueKey: 'engineFormInvalidAnswer' });
            await assert.rejects(test.engine.answerForm(client, { id: 'choice', sessionID: 'root', fields: [{ key: 's', type: 'string', custom: false, options: [{ label: 'A', value: 'a' }] }] }, host, signal, () => {}), { valueKey: 'engineFormInvalidAnswer' });
            await assert.rejects(test.engine.answerForm(client, { id: 'duplicate', sessionID: 'root', fields: [{ key: 's', type: 'string', options: [{ label: 'A', value: 'a' }, { label: 'A', value: 'b' }] }] }, host, signal, () => {}), { valueKey: 'engineFormUnsupported' });
            assert.equal(replies.length, 0); assert.equal(cancels.length, 4);
            await test.engine.answerForm(client, { id: 'number', sessionID: 'root', fields: [{ key: 'n', type: 'number', minimum: 0, maximum: 10 }] }, host, signal, () => {});
            assert.deepEqual(replies.at(-1).answer, { n: 9 });
            console.log('ok whole-form preflight, ambiguous choices, typed bounds and rejected forged answers');
        } finally { await test.close(); }
    }
} finally { await rm(root, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { PullRequestStore } = require('../out/pullRequests/store.js');
const { PullRequestService } = require('../out/pullRequests/service.js');
const { PullRequestController } = require('../out/pullRequests/controller.js');
const { GitHubPullRequests } = require('../out/pullRequests/github.js');
const { pullRequestTarget, PullRequestError } = require('../out/pullRequests/types.js');
const { setOfflineMode } = require('../out/networkPolicy.js');
const { executionMatches } = require('../out/pullRequests/types.js');
const directory = await mkdtemp(path.join(tmpdir(), 'xratu-pr-'));
after(async () => { setOfflineMode(false); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const target = 'https://github.com/example/repo/pull/42';
const context = { sessionId: 'session-a', workspace: directory };
const execution = { workspace: directory, branch: 'feature', engine: 'xratu', model: 'model-a', credential: 'account-a', nativeSessionId: null, binaryPath: null };
const snapshot = (overrides = {}) => ({ title: 'A pull request', state: 'open', isDraft: false, headBranch: 'feature', baseBranch: 'main', headSha: 'a'.repeat(40), mergeability: 'clean', reviewDecision: null, viewer: 'me', author: { login: 'me' }, checks: [{ name: 'Tests', required: true, status: 'pending', url: null }], comments: [], syncedAt: new Date().toISOString(), ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let fixtureNumber = 0;
async function fixture() {
    const storage = path.join(directory, `fixture-${++fixtureNumber}`);
    let current = snapshot(), error, reads = 0;
    const diagnostics = [];
    const provider = { read: async () => { reads++; if (error) throw error; return structuredClone(current); } };
    const store = new PullRequestStore(storage, error => diagnostics.push(error));
    const service = new PullRequestService(store, provider, () => {}, error => diagnostics.push(error));
    return { store, service, provider, storage, diagnostics, reads: () => reads, update: value => { current = snapshot(value); }, fail: value => { error = value; }, load: () => store.load(context.sessionId, context.workspace) };
}

test('canonical PR identities reject non-GitHub URLs, credentials, traversal, and option-like targets', () => {
    assert.deepEqual(pullRequestTarget('https://github.com/Example/Repo/pull/42/?tab=checks#discussion'), { host: 'github.com', repository: 'example/repo', number: 42, url: target });
    assert.equal(pullRequestTarget(`${target}/files#diff-example`).url, target);
    for (const value of ['http://github.com/a/b/pull/1', 'https://github.com.evil/a/b/pull/1', 'https://user@github.com/a/b/pull/1', 'https://github.com:8443/a/b/pull/1', 'https://gitlab.com/a/b/pull/1', 'https://github.com/a/b/pull/0', 'https://github.com/a/../pull/1', '--help', null]) assert.throws(() => pullRequestTarget(value));
});

test('links are idempotent, canonical, multi-PR and persist outside transcripts', async () => {
    const f = await fixture();
    await f.service.link(context, target, 'user');
    await f.service.link(context, 'https://github.com/EXAMPLE/REPO/pull/42', 'agent');
    await f.service.link(context, target.replace('42', '43'), 'agent');
    const restored = await new PullRequestStore(f.storage).load(context.sessionId, context.workspace);
    assert.equal(restored.links.length, 2);
    assert.equal(restored.links[0].source, 'user');
    assert.equal(restored.links[0].snapshot, null);
    assert.equal(f.reads(), 0);
});

test('cursor and event enqueue commit atomically and identical reads never duplicate updates', async () => {
    const f = await fixture();
    await f.service.watch(context, target, execution);
    f.update({ checks: [{ name: 'Tests', required: true, status: 'failure', url: null }] });
    await f.service.sweep();
    const first = await f.load();
    assert.equal(first.events.length, 1);
    assert.deepEqual(first.links[0].watch.failedChecks, ['Tests']);
    assert.deepEqual(first.events[0].resume, execution);
    const disk = JSON.parse(await readFile(path.join(f.store.directory, 'session-a.json'), 'utf8'));
    assert.equal(disk.events[0].id, first.events[0].id);
    assert.deepEqual(disk.links[0].watch.failedChecks, ['Tests']);
    await f.service.sweep();
    assert.equal((await f.load()).events.length, 1);
    const reloaded = new PullRequestService(new PullRequestStore(f.storage), f.provider);
    await reloaded.sweep();
    assert.equal((await f.load()).events.length, 1);
});

test('watching establishes a baseline instead of replaying existing comments or failed checks', async () => {
    const f = await fixture();
    f.update({ checks: [{ name: 'Tests', status: 'failure', required: true, url: null }], comments: [{ id: 'old', createdAt: '2025-01-01T00:00:00Z', editedAt: null, author: { login: 'bot' }, body: 'old', url: null, path: null, reviewState: null }] });
    await f.service.watch(context, target);
    await f.service.sweep();
    assert.equal((await f.load()).events.length, 0);
});

test('re-watching refreshes execution identity without resetting the watch cursor or queued events', async () => {
    for (const initial of [undefined, execution]) {
        const f = await fixture();
        await f.service.watch(context, target, initial);
        f.update({ mergeability: 'conflicting' });
        await f.service.sweep();
        const before = await f.load(), reads = f.reads();
        const next = { ...execution, model: 'model-b' };
        await f.service.watch(context, target, next);
        const updated = await f.load();
        assert.deepEqual(updated.links[0].resume, next);
        assert.deepEqual(updated.links[0].watch, before.links[0].watch);
        assert.deepEqual(updated.events, before.events);
        assert.equal(f.reads(), reads);
        await f.service.watch(context, target);
        assert.deepEqual((await f.load()).links[0].resume, next);
    }
});

test('withdrawing all events releases failed/interrupted deliveries and lets another PR continue', async () => {
    for (const cancel of ['unwatch', 'unlink']) for (const status of ['failed', 'interrupted', 'running']) {
        const f = await fixture();
        await f.service.watch(context, target, execution);
        f.update({ mergeability: 'conflicting' });
        await f.service.sweep();
        const ids = (await f.load()).events.map(event => event.id);
        await f.service.beginDelivery(context, ids);
        if (status !== 'running') await f.store.update(context.sessionId, context.workspace, state => { state.delivery.status = status; });
        await f.service[cancel](context, target);
        assert.deepEqual((await f.load()).events, []);
        assert.equal((await f.load()).delivery?.status, status === 'running' ? 'running' : undefined);
        const second = target.replace('42', '43');
        await f.service.watch(context, second, execution);
        f.update({ mergeability: 'clean' });
        await f.service.sweep();
        f.update({ mergeability: 'conflicting' });
        await f.service.sweep();
        const nextIds = (await f.load()).events.map(event => event.id);
        assert.ok(nextIds.length);
        if (status === 'running') {
            assert.deepEqual(await f.service.beginDelivery(context, nextIds), []);
            await f.service.finishDelivery(context, ids, false);
        }
        assert.equal((await f.load()).delivery, undefined);
        assert.equal((await f.service.beginDelivery(context, nextIds)).length, nextIds.length);
    }
});

test('withdrawing only part of a failed delivery retains the remaining PR updates for explicit retry', async () => {
    const f = await fixture(), second = target.replace('42', '43');
    await f.service.watch(context, target, execution);
    await f.service.watch(context, second, execution);
    f.update({ mergeability: 'conflicting' });
    await f.service.sweep();
    const ids = (await f.load()).events.map(event => event.id);
    await f.service.beginDelivery(context, ids);
    await f.service.finishDelivery(context, ids, false);
    await f.service.unwatch(context, target);
    const state = await f.load();
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].url, second);
    assert.equal(state.delivery.status, 'failed');
});

test('unwatch withdraws queued continuations and a late read cannot restart it', async () => {
    const f = await fixture();
    await f.service.watch(context, target, execution);
    const read = deferred(), entered = deferred();
    f.provider.read = async () => { entered.resolve(); return read.promise; };
    const sweep = f.service.sweep();
    await entered.promise;
    await f.service.unwatch(context, target);
    read.resolve(snapshot({ mergeability: 'conflicting' }));
    await sweep;
    const state = await f.load();
    assert.equal(state.links[0].watch, undefined);
    assert.equal(state.events.length, 0);
});

test('unlink and deletion cannot be undone by an in-flight read or old tool', async () => {
    for (const remove of ['unlink', 'delete']) {
        const f = await fixture();
        await f.service.watch(context, target, execution);
        const read = deferred(), entered = deferred();
        f.provider.read = async () => { entered.resolve(); return read.promise; };
        const sweep = f.service.sweep();
        await entered.promise;
        if (remove === 'unlink') await f.service.unlink(context, target);
        else await f.store.remove(context.sessionId, context.workspace);
        read.resolve(snapshot({ mergeability: 'conflicting' }));
        await sweep;
        assert.deepEqual((await f.load()).links, []);
        assert.deepEqual((await f.load()).events, []);
        if (remove === 'delete') await assert.rejects(f.service.link(context, target, 'agent'), /prSessionRequired/);
    }
});

test('one host read serves multiple sessions watching the same PR', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    await f.service.watch({ ...context, sessionId: 'session-b' }, target);
    const before = f.reads();
    await f.service.sweep();
    assert.equal(f.reads() - before, 1);
});

test('transient failures preserve the last snapshot; eight failures stop visibly', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    f.fail(new PullRequestError('prReadFailed', 'temporary'));
    for (let count = 0; count < 8; count++) await f.service.sweep();
    const state = await f.load();
    assert.equal(state.links[0].snapshot.title, 'A pull request');
    assert.equal(state.links[0].watch, undefined);
    assert.equal(state.events.at(-1).reason, 'unreadable');
});

test('rate limiting pauses reads without spending the failure budget', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    f.fail(new PullRequestError('prRateLimited'));
    await f.service.sweep();
    const reads = f.reads();
    await f.service.sweep();
    assert.equal(f.reads(), reads);
    const state = await f.load();
    assert.equal(state.links[0].failures, 0);
    assert.ok(state.links[0].watch);
    assert.equal(state.links[0].errorKey, 'prRateLimited');
});

test('offline monitoring performs zero provider reads and resumes when online', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    try {
        setOfflineMode(true);
        const before = f.reads();
        await f.service.sweep();
        assert.equal(f.reads(), before);
        await assert.rejects(f.service.watch(context, target.replace('42', '43')), /prOffline/);
    } finally { setOfflineMode(false); }
    const before = f.reads();
    await f.service.sweep();
    assert.equal(f.reads(), before + 1);
});

test('closed/merged PRs end their watch and retain the link with a terminal update', async () => {
    for (const status of ['closed', 'merged']) {
        const f = await fixture();
        await f.service.watch(context, target);
        f.update({ state: status });
        await f.service.sweep();
        const state = await f.load();
        assert.equal(state.links.length, 1);
        assert.equal(state.links[0].watch, undefined);
        assert.equal(state.events.at(-1).reason, status);
    }
});

test('pending-queue overflow stops the watch instead of silently discarding updates', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    await f.store.update(context.sessionId, context.workspace, state => { state.events = Array.from({ length: 32 }, (_, index) => ({ id: String(index), key: 'github.com/example/repo#42', url: target, number: 42, createdAt: new Date().toISOString(), headSha: null, changes: [] })); });
    f.update({ mergeability: 'conflicting' });
    await f.service.sweep();
    const state = await f.load();
    assert.equal(state.events.length, 32);
    assert.equal(state.links[0].watch, undefined);
    assert.equal(state.links[0].errorKey, 'prQueueFull');
});

test('a failed metadata mutation never changes the previous atomic file', async () => {
    const f = await fixture();
    await f.service.link(context, target, 'user');
    const before = await readFile(path.join(f.store.directory, 'session-a.json'), 'utf8');
    await assert.rejects(f.store.update(context.sessionId, context.workspace, state => { state.links = []; throw new Error('failed transaction'); }));
    assert.equal(await readFile(path.join(f.store.directory, 'session-a.json'), 'utf8'), before);
});

test('another window cannot claim an already-running delivery', async () => {
    const f = await fixture();
    await f.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' });
    await f.service.sweep();
    const ids = (await f.load()).events.map(event => event.id);
    assert.equal((await f.service.beginDelivery(context, ids)).length, 1);
    const second = new PullRequestService(new PullRequestStore(f.storage), f.provider);
    assert.deepEqual(await second.beginDelivery(context, ids), []);
    await f.service.finishDelivery(context, ids, false);
    assert.equal((await f.load()).delivery.status, 'failed');
    assert.equal((await second.beginDelivery(context, ids, true)).length, 1);
    await second.finishDelivery(context, ids, true);
    assert.deepEqual((await f.load()).events, []);
});

test('malformed records are reported and cannot stop valid sessions from monitoring', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    await writeFile(path.join(f.store.directory, 'broken.json'), '{ invalid');
    f.update({ mergeability: 'conflicting' });
    await f.service.sweep();
    assert.equal((await f.load()).events.length, 1);
    assert.ok(f.diagnostics.length > 0);
    await assert.rejects(f.store.load('broken', context.workspace), /JSON|prStoreFailed/);
    await assert.rejects(f.store.load('../escape', context.workspace));
});

test('BOM/CRLF metadata loads and a live process lock refuses concurrent writes', async () => {
    const f = await fixture();
    await f.service.link(context, target, 'user');
    const filename = path.join(f.store.directory, 'session-a.json');
    const original = await readFile(filename, 'utf8');
    await writeFile(filename, '\uFEFF' + original.replaceAll(',', ',\r\n'));
    assert.equal((await f.load()).links.length, 1);
    await writeFile(`${filename}.lock`, String(process.pid));
    await assert.rejects(f.service.unlink(context, target), /prStoreBusy/);
    assert.equal((await f.load()).links.length, 1);
    await rm(`${filename}.lock`);
});

test('controller keeps inactive/busy sessions queued and admits one idle continuation', async () => {
    const f = await fixture(), messages = [], runs = [];
    let identity = { ...context, epoch: 1, busy: true, plan: false };
    const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => execution, run: async prompt => { runs.push(prompt); return true; }, publish: message => messages.push(message), diagnostic: error => { throw error; } }, f.storage, f.provider);
    await controller.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' });
    await controller.service.sweep();
    assert.equal(runs.length, 0);
    identity = { ...identity, sessionId: 'session-b', busy: false };
    await controller.resume(false);
    assert.equal(runs.length, 0);
    identity = { ...identity, sessionId: context.sessionId };
    await controller.resume(false);
    assert.equal(runs.length, 1);
    assert.match(runs[0], /untrusted/);
    assert.match(runs[0], /conflicting/);
    assert.equal((await f.load()).events.length, 0);
});

test('changed engine/model/branch/account and plan mode cannot trigger automatic continuation', async () => {
    for (const patch of [{ branch: 'other' }, { model: 'other' }, { credential: 'other' }, { engine: 'opencode' }, { nativeSessionId: 'other' }]) {
        const f = await fixture();
        let runs = 0;
        const identity = { ...context, epoch: 1, busy: true, plan: false };
        const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => ({ ...execution, ...patch }), run: async () => { runs++; return true; }, publish: () => {}, diagnostic: () => {} }, f.storage, f.provider);
        await controller.service.watch(context, target, execution);
        f.update({ mergeability: 'conflicting' });
        await controller.service.sweep();
        identity.busy = false;
        await controller.resume(false);
        assert.equal(runs, 0);
        assert.equal((await f.load()).events.length, 1);
        identity.plan = true;
        const result = await controller.tool('watch_pull_request', { url: target });
        assert.equal(result.isError, true);
        assert.match(result.output, /prPlanDenied/);
    }
});

test('a session switch during execution-context lookup cannot launch a continuation', async () => {
    const f = await fixture(), capture = deferred(), entered = deferred();
    let identity = { ...context, epoch: 1, busy: true, plan: false }, runs = 0;
    const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => { entered.resolve(); return capture.promise; }, run: async () => { runs++; return true; }, publish: () => {}, diagnostic: () => {} }, f.storage, f.provider);
    await controller.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' }); await controller.service.sweep();
    identity.busy = false;
    const waking = controller.resume(false); await entered.promise;
    identity = { ...identity, sessionId: 'session-b', epoch: 2 };
    capture.resolve(execution); await waking;
    assert.equal(runs, 0);
    assert.equal((await f.load()).events.length, 1);
});

test('a provider response that moves the PR head during pagination is rejected', async () => {
    let calls = 0;
    const provider = new GitHubPullRequests(async args => {
        assert.ok(args.includes('graphql'));
        calls++;
        return { data: { viewer: { login: 'me' }, repository: { pullRequest: { ...snapshot(), state: 'OPEN', headRefOid: (calls === 1 ? 'a' : 'b').repeat(40), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'page2' } } } } }] } } } } };
    });
    await assert.rejects(provider.read(pullRequestTarget(target), directory), /prChangedDuringRead/);
    assert.equal(calls, 2);
});

test('Stop wins even after an automatic continuation has claimed its durable queue entry', async () => {
    const f = await fixture(), claimed = deferred(), release = deferred();
    let runs = 0;
    const identity = { ...context, epoch: 1, busy: true, plan: false };
    const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => execution, run: async () => { runs++; return true; }, publish: () => {}, diagnostic: () => {} }, f.storage, f.provider);
    await controller.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' }); await controller.service.sweep();
    const claim = controller.service.beginDelivery.bind(controller.service);
    controller.service.beginDelivery = async (...args) => { const events = await claim(...args); claimed.resolve(); await release.promise; return events; };
    identity.busy = false;
    const resume = controller.resume(false);
    await claimed.promise;
    await controller.stop();
    release.resolve(); await resume;
    assert.equal(runs, 0);
    const state = await f.load();
    assert.equal(state.events.length, 0);
    assert.equal(state.links[0].watch, undefined);
});

test('damaged snapshot/cursor state is rejected before publication and failed validation is atomic', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    const filename = path.join(f.store.directory, 'session-a.json');
    const original = await readFile(filename, 'utf8');
    for (const corrupt of [
        state => { state.links[0].snapshot.comments = [{}]; },
        state => { state.links[0].watch.failedChecks = 'broken'; },
        state => { state.links[0].snapshot.checks[0].url = 'javascript:alert(1)'; },
        state => { state.events = [{ id: 'invalid', url: target }]; },
        state => { state.delivery = { ids: [], status: 'running', owner: -1 }; },
    ]) {
        await assert.rejects(f.store.update(context.sessionId, context.workspace, corrupt), error => error.valueKey === 'prStoreFailed');
        assert.equal(await readFile(filename, 'utf8'), original);
    }
    await assert.rejects(f.store.load(context.sessionId, 'another-workspace'), error => error.valueKey === 'prStoreFailed');
});

test('the real host run boundary rechecks branch, epoch, and Stop after asynchronous context capture', async () => {
    const ts = require('typescript');
    const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
    const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'XratuChatViewProvider');
    const method = cls.members.find(node => node.name?.getText(file) === '_runPullRequestUpdate');
    const sandbox = { ui: () => 'PR update', isOfflineMode: () => false, executionMatches };
    vm.runInNewContext(ts.transpileModule(`class Host { ${method.getText(file)} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    for (const change of ['branch', 'epoch', 'stop']) {
        const host = new sandbox.Host(), capture = deferred(), entered = deferred();
        let admitted = true, runs = 0;
        Object.assign(host, { _sessionEpoch: 1, _localRunActive: false, _sessionTransitionsPending: 0, _checkpointRestoreActive: false, _planMode: false, _view: { webview: { postMessage: () => {} } }, _history: [], _persistLocalSession: async () => {}, _handleChatRequest: async () => { runs++; }, _pullRequestExecution: async () => { entered.resolve(); return capture.promise; } });
        const pending = host._runPullRequestUpdate('update', 1, [target], execution, () => admitted);
        await entered.promise;
        if (change === 'epoch') host._sessionEpoch++;
        if (change === 'stop') admitted = false;
        capture.resolve(change === 'branch' ? { ...execution, branch: 'other' } : execution);
        assert.equal(await pending, false);
        assert.equal(runs, 0);
    }
});

test('large review updates have bounded excerpts while the durable cursor still deduplicates every comment', async () => {
    const f = await fixture();
    await f.service.watch(context, target);
    const createdAt = new Date(Date.now() + 1000).toISOString();
    f.update({ comments: Array.from({ length: 30 }, (_, index) => ({ id: `comment-${index}`, createdAt, editedAt: null, author: { login: 'reviewer' }, body: 'x'.repeat(4000), url: null, path: null, reviewState: null })) });
    await f.service.sweep();
    const state = await f.load();
    assert.equal(state.events[0].changes[0].remarks.length, 10);
    assert.equal(state.events[0].omittedItems, 20);
    assert.equal(state.events[0].changes[0].remarks[0].body.length, 1000);
    assert.equal(state.links[0].watch.remarkIds.length, 30);
    await f.service.sweep();
    assert.equal((await f.load()).events.length, 1);
});

test('crashed continuations remain interrupted across reloads until explicitly retried', async () => {
    const f = await fixture();
    await f.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' }); await f.service.sweep();
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    assert.equal(exited.status, 0);
    await f.store.update(context.sessionId, context.workspace, state => { state.delivery = { ids: state.events.map(event => event.id), status: 'running', owner: exited.pid }; });
    const restarted = new PullRequestService(new PullRequestStore(f.storage), f.provider);
    try {
        await restarted.start();
        assert.equal((await f.load()).delivery.status, 'interrupted');
        assert.equal((await f.load()).events.length, 1);
    } finally { restarted.dispose(); }
});

test('a failed continuation is not automatically retried, while explicit retry is allowed', async () => {
    const f = await fixture();
    let runs = 0, success = false;
    const identity = { ...context, epoch: 1, busy: true, plan: false };
    const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => execution, run: async () => { runs++; return success; }, publish: () => {}, diagnostic: () => {} }, f.storage, f.provider);
    await controller.service.watch(context, target, execution);
    f.update({ mergeability: 'conflicting' }); await controller.service.sweep();
    identity.busy = false;
    await controller.resume(false);
    assert.equal(runs, 1);
    assert.equal((await f.load()).delivery.status, 'failed');
    await controller.resume(false);
    assert.equal(runs, 1);
    success = true;
    await controller.resume(true);
    assert.equal(runs, 2);
    assert.equal((await f.load()).events.length, 0);
});

test('notification-only watches never launch an agent without explicit continuation', async () => {
    const f = await fixture();
    let runs = 0;
    const identity = { ...context, epoch: 1, busy: true, plan: false };
    const controller = new PullRequestController({ identity: () => identity, ensureSession: async () => {}, execution: async () => execution, run: async () => { runs++; return true; }, publish: () => {}, diagnostic: () => {} }, f.storage, f.provider);
    await controller.service.watch(context, target);
    f.update({ mergeability: 'conflicting' }); await controller.service.sweep();
    identity.busy = false;
    await controller.resume(false);
    assert.equal(runs, 0);
    assert.equal((await f.load()).events.length, 1);
    await controller.resume(true);
    assert.equal(runs, 1);
});

test('GitHub reader paginates checks and consumes all REST activity pages', async () => {
    const calls = [];
    const comment = { node_id: 'comment', body: 'Please fix', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', user: { login: 'reviewer' }, html_url: `${target}#comment` };
    const provider = new GitHubPullRequests(async args => {
        calls.push(args);
        if (!args.includes('graphql')) return args.at(-1).includes('issues/') ? [[comment], [{ ...comment, node_id: 'second' }]] : [[]];
        const second = args.includes('after=next');
        return { data: { viewer: { login: 'me' }, repository: { pullRequest: { title: 'Title', state: 'OPEN', isDraft: false, headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), mergeable: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', author: { login: 'author' }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', name: second ? 'Build' : 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true, detailsUrl: 'https://github.com/example/repo/actions/runs/1' }], pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next' } } } } }] } } } } };
    });
    const result = await provider.read(pullRequestTarget(target), directory);
    assert.equal(result.checks.length, 2);
    assert.equal(result.comments.length, 2);
    assert.equal(result.comments[0].editedAt, comment.updated_at);
    assert.equal(result.mergeability, 'unknown');
    assert.equal(calls.length, 5);
    assert.ok(calls.filter(args => !args.includes('graphql')).every(args => args.includes('--paginate') && args.includes('--slurp')));
});

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { EmptySeedError, ShadowCheckpointStore } = require('../out/shadowGit.js');
const root = mkdtempSync(path.join(tmpdir(), 'xratu-restore-actions-'));
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const names = ['_gitCheckout', '_rewindAndResend', 'restoreCheckpointFlow', '_restoreCheckpointAt', '_captureCheckpointAction', '_checkpointActionCurrent', '_applyCheckpointRestore', '_checkpointRestoreActive', '_findUserEntry', '_serializeSessionTransition', '_sessionTransitionQueue', '_handleChatRequest'];
const members = cls.members.filter(node => node.name && names.includes(node.name.getText(file)));
let jobs = [];
const sandbox = { ui: key => key, path, fs: require('node:fs'), EmptySeedError, backgroundJobViews: () => jobs,
    validateReviewCheckpoint: sha => { if (!/^[a-f0-9]{7,40}$/i.test(sha)) throw Error('Invalid checkpoint'); },
    vscode: { window: { showQuickPick: async entries => entries[0] }, workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } } };
vm.runInNewContext(ts.transpileModule(`class Host { ${members.map(node => node.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const sha = 'a'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness() {
    const host = new sandbox.Host();
    Object.assign(host, { _sessionEpoch: 10, _sessionId: 'A', _ephemeralSessionId: null, _activeEngine: 'builtin', _abortControllers: new Map(), _localRunActive: false, _history: [{ role: 'user', content: 'A', cp: sha.slice(0, 12) }], _approvalCloseItems: {} });
    const notices = [], messages = [], restores = [], truncations = [];
    host._view = { webview: { postMessage: msg => messages.push(msg) } };
    host.notifyBanner = (...args) => notices.push(args);
    host._checkpoints = { resolveCheckpoint: async () => sha, restoreCheckpoint: async (...args) => { restores.push(args); return { changed: true, sha, safety: 'safe' }; } };
    host._truncateLocalHistoryAt = index => truncations.push(index);
    host._dropOrphanedTaskListEdit = () => {};
    host._persistLocalSession = async () => {};
    const confirm = deferred(), shown = deferred();
    host.confirmBanner = () => { shown.resolve(); return confirm.promise; };
    return { host, notices, messages, restores, truncations, confirm, shown };
}
try {
    const h = harness();
    const pending = h.host._restoreCheckpointAt(0, sha.slice(0, 12));
    await h.shown.promise;
    await h.host._serializeSessionTransition(async () => { h.host._sessionEpoch++; h.host._sessionId = 'B'; h.host._history = [{ role: 'user', content: 'B', cp: sha.slice(0, 12) }]; });
    h.confirm.resolve('checkpointScopeFilesAndChat');
    await pending;
    assert.equal(h.restores.length, 0, 'late A confirmation must perform zero file restores in B');
    assert.equal(h.truncations.length, 0);
    assert.equal(h.host._history[0].content, 'B');
    console.log('ok stale confirmation cannot restore or truncate another session');

    for (const mutate of [
        h => { h.host._history = []; },
        h => { h.host._history[0] = { ...h.host._history[0] }; },
        h => { h.host._history[0].cp = 'b'.repeat(12); },
        h => { h.host._activeEngine = 'opencode'; },
        h => { h.host._localRunActive = true; },
        h => { h.host._abortControllers.set('run', {}); },
        h => { sandbox.vscode.workspace.workspaceFolders = []; },
        h => { h.host._checkpoints.resolveCheckpoint = async () => { throw Error('deleted'); }; },
        h => { jobs = [{ running: true, cwd: root }]; },
        h => { h.host._sessionEpoch++; },
    ]) {
        const t = harness();
        const request = t.host._restoreCheckpointAt(0, sha.slice(0, 12));
        await t.shown.promise;
        mutate(t);
        t.confirm.resolve('checkpointScopeFilesAndChat');
        await request;
        assert.equal(t.restores.length, 0);
        assert.equal(t.truncations.length, 0);
        assert.ok(t.notices.length > 0, 'rejection must be surfaced');
        jobs = [];
        sandbox.vscode.workspace.workspaceFolders = [{ uri: { fsPath: root } }];
    }
    console.log('ok changed turn, engine, epoch, workspace, busy run, background writer and deleted commit reject before writes');

    for (const [index, target] of [[-1, sha.slice(0, 12)], [0.5, sha.slice(0, 12)], [1, sha.slice(0, 12)], [0, 'b'.repeat(12)], [0, '--all']]) {
        const t = harness();
        let confirmations = 0;
        t.host.confirmBanner = async () => { confirmations++; return 'checkpointScopeFiles'; };
        await t.host._restoreCheckpointAt(index, target);
        assert.equal(confirmations, 0);
        assert.equal(t.restores.length, 0);
    }
    const missing = harness();
    missing.host._checkpoints.resolveCheckpoint = async () => { throw Error('not found'); };
    let missingConfirm = false;
    missing.host.confirmBanner = async () => { missingConfirm = true; };
    await missing.host._restoreCheckpointAt(0, sha.slice(0, 12));
    assert.equal(missingConfirm, false);
    console.log('ok invalid ownership and missing checkpoint reject before confirmation');

    for (const choice of ['checkpointScopeFiles', 'checkpointScopeFilesAndChat', 'notifCancel']) {
        for (const empty of [false, true]) {
            const t = harness();
            if (empty) t.host._checkpoints.restoreCheckpoint = async (...args) => { t.restores.push(args); throw new EmptySeedError(); };
            const request = t.host._restoreCheckpointAt(0, sha.slice(0, 12));
            await t.shown.promise;
            t.confirm.resolve(choice);
            await request;
            assert.equal(t.restores.length, choice === 'notifCancel' ? 0 : 1);
            assert.equal(t.truncations.length, choice === 'checkpointScopeFilesAndChat' ? 1 : 0);
            assert.equal(t.host._history.length, choice === 'checkpointScopeFilesAndChat' ? 0 : 1);
            if (!empty && choice !== 'notifCancel') {
                assert.equal(t.restores[0][1], sha, 'restore uses the resolved full SHA');
                assert.equal(t.notices.find(n => n[1] === 'notifRestored')[2].safety, 'safe');
            }
            if (empty && choice === 'checkpointScopeFiles') assert.ok(t.notices.some(n => n[1] === 'checkpointEmptySeed'));
        }
    }
    console.log('ok files-only, files-and-chat, cancellation and empty-seed policy preserve safety and ledger semantics');

    for (const choice of ['checkpointScopeFiles', 'checkpointScopeFilesAndChat']) {
        const t = harness();
        t.host._activeEngine = 'opencode';
        const request = t.host._restoreCheckpointAt(0, sha.slice(0, 12));
        await t.shown.promise;
        t.confirm.resolve(choice);
        await request;
        assert.equal(t.restores.length, choice === 'checkpointScopeFiles' ? 1 : 0);
        assert.equal(t.truncations.length, 0);
    }
    console.log('ok native files-only restore remains supported; native chat rewind cannot write');

    const serial = harness(), entered = deferred(), finish = deferred();
    serial.host._checkpoints.restoreCheckpoint = async (...args) => { serial.restores.push(args); entered.resolve(); await finish.promise; return { changed: true, sha, safety: 'safe' }; };
    const restoring = serial.host._restoreCheckpointAt(0, sha.slice(0, 12));
    await serial.shown.promise;
    serial.confirm.resolve('checkpointScopeFilesAndChat');
    await entered.promise;
    let switched = false;
    const switching = serial.host._serializeSessionTransition(async () => {
        assert.equal(serial.host._history.length, 0, 'restore ledger settles before switching');
        serial.host._sessionEpoch++;
        switched = true;
    });
    await serial.host._handleChatRequest('new draft');
    await serial.host._gitCheckout('main');
    await serial.host._rewindAndResend(0, 'edited draft');
    assert.equal(serial.restores.length, 1, 'other mutation paths cannot enter during restore');
    assert.equal(serial.truncations.length, 0);
    assert.ok(serial.messages.some(m => m.type === 'sendFailed' && m.prompt === 'new draft'));
    assert.equal(switched, false);
    finish.resolve();
    await Promise.all([restoring, switching]);
    assert.equal(switched, true);
    assert.equal(serial.host._checkpointRestoreActive, false);
    console.log('ok delayed restore serializes ledger with switch and rejects a new run with recoverable text');

    for (const stale of [false, true]) {
        const t = harness();
        t.host._view = undefined; // Palette restore also works before the webview is opened.
        t.host._checkpoints.listCheckpoints = async () => `${sha.slice(0, 12)}|today|target`;
        const request = t.host.restoreCheckpointFlow();
        await t.shown.promise;
        if (stale) await t.host._serializeSessionTransition(async () => { t.host._sessionEpoch++; });
        t.confirm.resolve('notifRestoreAction');
        await request;
        assert.equal(t.restores.length, stale ? 0 : 1);
        assert.equal(t.truncations.length, 0);
    }
    console.log('ok palette restores without a webview and stale palette confirmations perform zero writes');

    const storage = mkdtempSync(path.join(tmpdir(), 'xratu-action-storage-'));
    try {
        const fs = require('node:fs');
        fs.writeFileSync(path.join(root, 'work.txt'), 'before');
        const store = new ShadowCheckpointStore({ globalStorageUri: { fsPath: storage } });
        const checkpoint = await store.createCheckpoint(root, 'host restore target');
        fs.writeFileSync(path.join(root, 'work.txt'), 'after');
        const t = harness();
        t.host._checkpoints = store;
        t.host._history[0].cp = checkpoint;
        const request = t.host._restoreCheckpointAt(0, checkpoint);
        await t.shown.promise;
        t.confirm.resolve('checkpointScopeFiles');
        await request;
        assert.equal(fs.readFileSync(path.join(root, 'work.txt'), 'utf8'), 'before');
        const restored = t.notices.find(n => n[1] === 'notifRestored');
        assert.ok(restored?.[2].safety, 'host exposes a real safety checkpoint');
        assert.equal(await store.readCheckpointFile(root, restored[2].safety, 'work.txt'), 'after');
        assert.equal(t.host._history.length, 1);
        console.log('ok real shadow restore through host keeps chat and exposes the recoverable safety snapshot');
    } finally { rmSync(storage, { recursive: true, force: true }); }

} finally { rmSync(root, { recursive: true, force: true }); }

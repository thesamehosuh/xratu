import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { canStartSetup } = require('../out/engines/setup.js');
const { EngineError } = require('../out/engines/types.js');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'XratuChatViewProvider');
const names = ['_settleLocalRun', '_sessionWorkspaceIdentity', '_restoreLocalSession', '_restoreLocalSessionNow', '_showStartScreen', '_setupComplete', '_cancelSetup', '_deleteSession', '_deleteSessionNow', '_clearAllSessions', '_clearAllSessionsNow', 'clearHistory', '_clearHistoryNow', '_waitForSessionSettlement', '_openSession', '_openSessionNow', '_loadSessionForAdoption', '_serializeSessionTransition', '_sessionTransitionQueue', '_sessionTransitionsPending', '_gitCheckout', '_handleChatRequest'];
const members = cls.members.filter(n => n.name && names.includes(n.name.getText(file)));
const timers = new Map();
let nextTimer = 0, checkouts = [];
const diagnostics = [];
const sandbox = { EngineError, canStartSetup, diagnosticsChannel: { appendLine: message => diagnostics.push(message) }, isOfflineMode: () => false, classifyWorkspace: () => 'code', fs: { realpathSync: value => path.resolve(value) }, path, setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id),
    resolveSessionTitle: title => title, isSafeBranchName: branch => !branch.startsWith('-'),
    execFileAsync: async (...args) => { checkouts.push(args); },
    vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('workspace') } }] } } };
vm.runInNewContext(ts.transpileModule(`class Host { ${members.map(n => n.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const routerFile = ts.createSourceFile('webviewRouter.ts', readFileSync(new URL('../src/webviewRouter.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const router = routerFile.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'routeWebviewMessage');
vm.runInNewContext(ts.transpileModule(router.getText(routerFile).replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = id => ({ sessionId: id, model: 'target-model', summary: null, title: id, workspace: path.resolve('workspace'), renamed: false, localHistory: [{ role: 'user', content: id }], uiHistory: [{ role: 'user', content: id }], totalCostUsd: 3 });
function harness() {
    const host = new sandbox.Host(), notices = [], messages = [], state = new Map(), events = [];
    host._pullRequests = { resume: async () => {}, service: { store: { sessions: async () => [], remove: async () => {} } } };
    Object.assign(host, { _sessionEpoch: 10, _sessionId: 'A', _sessionTitle: 'A title', _activeEngine: 'xratu', _history: [{ role: 'user', content: 'A history' }], _localHistory: [{ role: 'user', content: 'A ledger' }], _selectedModel: 'A model', _sessionCost: { USD: 9, IRT: 0 }, _sessionSummary: 'A summary', _localRunActive: false, _abortControllers: new Map(), _gitBranches: ['main', 'next'] });
    host._view = { webview: { postMessage: msg => messages.push(msg) } };
    host.notifyBanner = (...args) => notices.push(args);
    host._cancelActiveRequests = () => { events.push('cancel'); host._abortControllers.clear(); };
    host._resetSessionLedgers = () => { events.push('reset'); host._sessionId = null; host._history = []; host._localHistory = []; host._sessionCost = { USD: 0, IRT: 0 }; };
    host._restoreEngine = async ref => { host._activeEngine = ref?.engineId ?? 'xratu'; host._engineSession = ref; };
    host._localSessionStore = { load: async id => snapshot(id) };
    host._deriveEvictedUserTurns = () => {};
    host._restoreReplayBoundary = () => {};
    host._restoreSessionUsage = () => {};
    host._rememberModelForActiveCredential = async () => {};
    host._globalState = { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } };
    host._lastSessionStateKey = () => 'last';
    host._persistLocalSession = async () => { events.push('persist'); };
    host._reloadWebviewChat = async () => { events.push('reload'); };
    host._postEngineState = () => {};
    host._localWorkspaceKey = () => sandbox.vscode.workspace.workspaceFolders[0]?.uri.fsPath ?? 'default';
    host._discardQueuedSteers = () => {};
    host._forgetSubagentRuns = () => {};
    host._taskListEdits = {};
    host._saveTaskListEdits = async () => {};
    host._listSessions = async () => {};
    host._sendGitStatus = async () => {};
    host._sendGitBranches = async () => {};
    return { host, notices, messages, state, events };
}
function intact(t) {
    assert.equal(t.host._sessionId, 'A');
    assert.equal(t.host._sessionEpoch, 10);
    assert.equal(t.host._history[0]?.content, 'A history');
    assert.equal(t.host._localHistory[0]?.content, 'A ledger');
    assert.equal(t.host._selectedModel, 'A model');
    assert.equal(t.host._sessionTitle, 'A title');
    assert.equal(t.host._sessionSummary, 'A summary');
    assert.equal(t.host._sessionCost.USD, 9);
    assert.ok(!t.events.includes('reset'));
    assert.ok(!t.events.includes('reload'));
}
const missing = harness();
missing.host._localSessionStore.load = async () => null;
await missing.host._openSession('missing');
intact(missing);
assert.ok(missing.notices.some(n => n[1] === 'sessionLoadFailed'));
console.log('ok missing target preserves current identity, histories, model and spend');

for (const broken of [
    () => { throw Error('unreadable'); },
    () => ({ ...snapshot('B'), sessionId: 'wrong' }),
    () => ({ ...snapshot('B'), uiHistory: {} }),
    () => ({ ...snapshot('B'), localHistory: [null] }),
    () => ({ ...snapshot('B'), uiHistory: [{ role: 'user', content: 7 }] }),
    () => ({ ...snapshot('B'), model: 7 }),
    () => ({ ...snapshot('B'), summary: {} }),
]) {
    const t = harness();
    t.host._localSessionStore.load = async () => broken();
    await t.host._openSession('B');
    intact(t);
    assert.equal(t.host._sessionTransitionsPending, 0);
    assert.ok(t.notices.some(n => n[1] === 'sessionLoadFailed'));
}
console.log('ok unreadable and structurally invalid targets are rejected before adoption');

const loading = harness(), loaded = deferred(), entered = deferred();
loading.host._localSessionStore.load = async () => { entered.resolve(); return loaded.promise; };
const switching = loading.host._openSession('B');
await loading.host._gitCheckout('next');
assert.equal(checkouts.length, 0, 'a synchronously queued transition must exclude checkout');
await entered.promise;
intact(loading);
await loading.host._handleChatRequest('new draft');
assert.ok(loading.messages.some(m => m.type === 'sendFailed' && m.prompt === 'new draft'));
loaded.resolve(snapshot('B'));
await switching;
assert.equal(loading.host._sessionId, 'B');
assert.equal(loading.host._history[0].content, 'B');
assert.equal(loading.host._localHistory[0].content, 'B');
assert.equal(loading.host._sessionCost.USD, 3);
assert.equal(loading.host._sessionEpoch, 11);
assert.equal(loading.host._sessionTransitionsPending, 0);
assert.equal(loading.state.get('last'), 'B');
console.log('ok delayed target load leaves old state intact and blocks checkout/new sends through admission');

for (const stale of ['epoch', 'workspace', 'engine']) {
    const t = harness(), target = deferred(), reading = deferred();
    t.host._localSessionStore.load = async () => { reading.resolve(); return target.promise; };
    const request = t.host._openSession('B');
    await reading.promise;
    if (stale === 'epoch') t.host._sessionEpoch++;
    else if (stale === 'engine') t.host._activeEngine = 'opencode';
    else sandbox.vscode.workspace.workspaceFolders = [];
    target.resolve(snapshot('B'));
    await request;
    assert.equal(t.host._sessionId, 'A');
    assert.ok(!t.events.includes('reset'));
    assert.ok(t.notices.some(n => n[1] === 'sessionSwitchStale'));
    sandbox.vscode.workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('workspace') } }];
}
console.log('ok epoch, engine and workspace changes during loading cannot adopt a stale target');

const settling = harness(), settled = deferred(), cancelled = deferred();
settling.host._localRunActive = true;
settling.host._localRunSettled = settled.promise;
settling.host._cancelActiveRequests = () => cancelled.resolve();
let reads = 0;
settling.host._localSessionStore.load = async () => ++reads === 1 ? snapshot('B') : null;
const settleRequest = settling.host._openSession('B');
await cancelled.promise;
intact(settling);
settling.host._history.push({ role: 'assistant', content: 'A finished cancelling' });
settling.host._localRunActive = false;
settled.resolve();
await settleRequest;
assert.equal(reads, 2, 'revalidate the target after run settlement');
assert.equal(settling.host._sessionId, 'A');
assert.equal(settling.host._history.at(-1).content, 'A finished cancelling');
assert.equal(settling.host._sessionEpoch, 10);
assert.ok(!settling.events.includes('reset'));
assert.equal(timers.size, 0, 'settlement timeout is cleaned up');
console.log('ok deleted target after cancellation preserves the old settled conversation');

const timeout = harness(), never = deferred(), cancelling = deferred();
timeout.host._localRunSettled = never.promise;
timeout.host._cancelActiveRequests = () => cancelling.resolve();
const timed = timeout.host._openSession('B');
await cancelling.promise;
for (const fire of timers.values()) fire();
await timed;
intact(timeout);
assert.ok(timeout.notices.some(n => n[1] === 'sessionSwitchBusy'));
assert.equal(timers.size, 0);
console.log('ok unsettled cancellation rejects the switch without resetting the old session');

const engineFailure = harness();
engineFailure.host._globalState.update = async () => { throw Error('storage unavailable'); };
await engineFailure.host._openSession('B');
intact(engineFailure);
console.log('ok engine preference storage failure cannot partially replace current state');

for (const flag of ['_localRunActive', '_checkpointRestoreActive', '_abortControllers']) {
    const t = harness();
    if (flag === '_abortControllers') t.host._abortControllers.set('chat', {});
    else t.host[flag] = true;
    await t.host._gitCheckout('next');
    assert.equal(checkouts.length, 0);
    assert.ok(t.notices.some(n => n[1] === 'gitCheckoutBusy'));
}
const invalidBranch = harness();
await invalidBranch.host._gitCheckout('--bad');
await invalidBranch.host._gitCheckout('unknown');
assert.equal(checkouts.length, 0);
await invalidBranch.host._gitCheckout('next');
assert.deepEqual(Array.from(checkouts[0][1]), ['-C', path.resolve('workspace'), 'checkout', 'next']);
assert.equal(checkouts[0][2].windowsHide, true);
checkouts = [];
console.log('ok busy checkout never invokes Git; idle checkout retains allowlisting and non-force argv');

const checkoutHost = harness(), checkoutEntered = deferred(), checkoutDone = deferred();
sandbox.execFileAsync = async (...args) => { checkouts.push(args); checkoutEntered.resolve(); await checkoutDone.promise; };
const checkout = checkoutHost.host._gitCheckout('next');
await checkoutEntered.promise;
const nextSession = checkoutHost.host._openSession('B');
assert.equal(checkoutHost.host._sessionId, 'A');
await checkoutHost.host._handleChatRequest('preserved send');
assert.ok(checkoutHost.messages.some(m => m.type === 'sendFailed' && m.prompt === 'preserved send'));
checkoutDone.resolve();
await Promise.all([checkout, nextSession]);
assert.equal(checkoutHost.host._sessionId, 'B');
assert.equal(checkoutHost.host._sessionTransitionsPending, 0);
sandbox.execFileAsync = async (...args) => { checkouts.push(args); };
console.log('ok delayed checkout excludes execution and settles before the next session adopts');

const queue = harness(), firstLoad = deferred(), firstEntered = deferred();
const adopted = [];
queue.host._localSessionStore.load = async id => { if (id === 'B') { firstEntered.resolve(); await firstLoad.promise; } return snapshot(id); };
queue.host._reloadWebviewChat = async () => adopted.push(queue.host._sessionId);
const first = queue.host._openSession('B'), second = queue.host._openSession('C');
await firstEntered.promise;
assert.equal(queue.host._sessionTransitionsPending, 2);
firstLoad.resolve();
await Promise.all([first, second]);
assert.deepEqual(adopted, ['B', 'C']);
assert.equal(queue.host._history[0].content, 'C');
assert.equal(queue.host._sessionTransitionsPending, 0);
await assert.rejects(queue.host._serializeSessionTransition(async () => { throw Error('test rejection'); }));
assert.equal(queue.host._sessionTransitionsPending, 0);
await queue.host._serializeSessionTransition(async () => {});
console.log('ok queued session loads adopt in order and failed callbacks release admission');

const failedCreate = harness();
failedCreate.host._localSessionStore.create = async () => { throw Error('disk full'); };
await failedCreate.host.clearHistory();
intact(failedCreate);
assert.ok(failedCreate.notices.some(n => n[1] === 'sessionCreateFailed'));
console.log('ok failed new-session creation preserves the current conversation');

const native = harness();
const nativeRef = { engineId: 'opencode', nativeSessionId: 'native-B', workspace: path.resolve('workspace'), binaryPath: path.resolve('opencode') };
native.host._localSessionStore.load = async () => ({ ...snapshot('B'), engineSession: nativeRef });
await native.host._openSession('B');
assert.equal(native.host._activeEngine, 'opencode');
assert.deepEqual(native.host._engineSession, nativeRef);
console.log('ok adoption preserves the stored native engine, binary, workspace and native-session identity');

const savedFailure = harness();
savedFailure.host._persistLocalSession = async () => { throw Error('save failed'); };
await savedFailure.host._openSession('B');
assert.equal(savedFailure.host._sessionId, 'B');
assert.ok(savedFailure.events.includes('reload'), 'UI must show the coherent target even if its follow-up save failed');
assert.ok(savedFailure.notices.some(n => n[1] === 'sessionSaveFailed'));
console.log('ok post-adoption save failure is visible and still reloads the adopted conversation');

const newSession = harness(), created = deferred(), createEntered = deferred();
newSession.host._localSessionStore.create = async () => { createEntered.resolve(); return created.promise; };
const creating = newSession.host.clearHistory();
await createEntered.promise;
intact(newSession);
created.resolve({ id: 'new' });
await creating;
assert.equal(newSession.host._sessionId, 'new');
assert.equal(newSession.host._history.length, 0);
assert.equal(newSession.host._sessionTransitionsPending, 0);
console.log('ok new-session adoption waits for durable creation before clearing old ledgers');

for (const missing of [true, false]) {
    const restoring = harness();
    restoring.host._localSessionStore.findCurrent = async () => missing ? null : { id: 'B' };
    restoring.host._localSessionStore.load = async () => null;
    await restoring.host._restoreLocalSession();
    intact(restoring);
}
const liveRestore = harness();
liveRestore.host._localRunActive = true;
liveRestore.host._localSessionStore.findCurrent = async () => { throw Error('must not reload over a live run'); };
await liveRestore.host._restoreLocalSession();
intact(liveRestore);
console.log('ok webview startup cannot erase an existing chat on load failure or replace a live run');

async function within(promise) {
    let timeout;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(Error('webview startup deadlocked the session queue')), 1000);
        })]);
    } finally { clearTimeout(timeout); }
}
function startupHarness(credentials = []) {
    const t = harness();
    t.host._getSavedCredentials = async () => credentials;
    t.host._sendSavedCredentials = t.host._sendOAuthState = async () => {};
    t.host._localSessionStore.reconcile = async () => { t.events.push('reconcile'); };
    t.host._localSessionStore.findCurrent = async () => null;
    t.host._restoreChatUI = () => { t.events.push('restoreUI'); };
    t.host._pushSessionState = t.host._pushEditorContext = t.host._pushTaskListState = t.host._resetLiveSegments = t.host._startConnectionPolling = t.host._sendTranscriptPrefs = t.host._sendRuntimePreferences = () => {};
    t.host._sendDownloads = () => {};
    t.host._resolveReplyLanguage = () => 'en';
    t.host._fetchModels = async () => false;
    t.host._secrets = { store: async () => {} };
    t.host._sendEnginesState = async () => { t.host._engineSetup = { phase: 'ready' }; };
    t.host._localSessionStore.create = async () => ({ id: 'new-chat' });
    t.boot = () => {
        const done = deferred();
        t.host._completeWebviewStartup = () => done.resolve();
        sandbox.routeWebviewMessage(t.host, { type: 'webviewReady' }, {});
        return done.promise;
    };
    return t;
}
const boot = startupHarness([{ id: 'saved' }]), reconciling = deferred(), reconciled = deferred();
boot.host._localSessionStore.findCurrent = async () => ({ id: 'B' });
boot.host._localSessionStore.reconcile = async () => { reconciling.resolve(); await reconciled.promise; };
const booted = boot.boot();
await reconciling.promise;
assert.equal(boot.host._sessionTransitionsPending, 1);
const afterBoot = boot.host._serializeSessionTransition(async () => {
    assert.ok(boot.messages.some(m => m.type === 'showChat'), 'startup must finish before the next transition');
});
reconciled.resolve();
await within(Promise.all([booted, afterBoot]));
assert.equal(boot.host._sessionTransitionsPending, 0);
assert.equal(boot.host._sessionId, 'B');
console.log('ok real webviewReady router and session restore use one queue slot without deadlock');

const setupFolders = sandbox.vscode.workspace.workspaceFolders;
sandbox.vscode.workspace.workspaceFolders = [{ uri: { fsPath: path.resolve('Terminal Game') } }];
for (const setupPath of ['free', 'provider', 'local']) {
    const credential = { id: 'saved', baseUrl: 'http://localhost:1234/v1', apiKey: '' };
    const t = startupHarness(setupPath === 'free' ? [] : [credential]);
    t.state.set('xratu.setupPath', setupPath);
    await within(t.boot());
    assert.equal(t.messages.at(-1).type, 'showWelcome');
    const engine = setupPath === 'free' ? 'opencode' : 'xratu';
    t.host._runtimeSetup = { requestId: setupPath, engine, path: setupPath, phase: 'ready', credentialId: credential.id,
        models: [{ id: 'chosen', free: true, availability: 'available', checkedAt: Date.now() }] };
    t.host._setupWorkspace = sandbox.vscode.workspace.workspaceFolders[0].uri.fsPath;
    let restarted;
    t.host._reloadWebviewChat = async () => { restarted = t.boot(); };
    await within(t.host._setupComplete(setupPath, 'chosen'));
    assert.ok(restarted, 'successful setup reloads the webview');
    await within(restarted);
    assert.equal(t.messages.at(-1).type, 'showChat');
    assert.equal(t.host._sessionId, 'new-chat');
    assert.equal(t.host._activeEngine, engine);
    assert.equal(t.host._selectedModel, 'chosen');
    assert.equal(t.state.get('xratu.setupCompleted'), true);
    assert.equal(t.host._sessionTransitionsPending, 0);
    assert.equal(t.host._setupStarting, false);
}
sandbox.vscode.workspace.workspaceFolders = setupFolders;
console.log('ok Start chat completes free/provider/local setup through the real reload/startup queue');

const deleteFailed = harness();
let deleted = [];
deleteFailed.host._localSessionStore.create = async () => { throw Error('disk full'); };
deleteFailed.host._localSessionStore.delete = async id => { deleted.push(id); return true; };
await deleteFailed.host._deleteSession('A');
intact(deleteFailed);
assert.equal(deleted.length, 0, 'deleting the active chat must first prepare a replacement');
const deleting = harness();
deleting.host._localSessionStore.create = async () => ({ id: 'fresh' });
deleting.host._localSessionStore.delete = async id => { deleted.push(id); return true; };
await deleting.host._deleteSession('A');
assert.equal(deleting.host._sessionId, 'fresh');
assert.deepEqual(deleted, ['A']);
assert.equal(deleting.host._sessionTransitionsPending, 0);
console.log('ok deleting an active session creates its replacement first without recursive queue admission');

const clearing = harness();
clearing.host._localSessionStore.reconcile = async () => {};
clearing.host._localSessionStore.list = async () => [{ id: 'A' }, { id: 'B' }];
clearing.host._localSessionStore.delete = async id => { deleted.push(id); return true; };
clearing.host._localSessionStore.create = async () => ({ id: 'empty' });
await clearing.host._clearAllSessions();
assert.equal(clearing.host._sessionId, 'empty');
assert.equal(clearing.host._history.length, 0);
assert.equal(clearing.host._sessionTransitionsPending, 0);
console.log('ok clear-all shares the transition queue and creates a fresh session without deadlocking');

for (const failure of ['lookup', 'removal']) {
    const t = harness(), removed = [], cleaned = [];
    t.host._pullRequests.service.store.sessions = async () => {
        if (failure === 'lookup') throw Error('PR lookup failed');
        return [{ sessionId: 'A', workspace: 'workspace' }, { sessionId: 'B', workspace: 'workspace' }];
    };
    t.host._pullRequests.service.store.remove = async id => { cleaned.push(id); if (id === 'A') throw Error('PR lock busy'); };
    t.host._localSessionStore.delete = async id => { removed.push(id); return true; };
    await t.host._deleteSessionNow('A');
    assert.deepEqual(removed, ['A']);
    removed.length = 0; cleaned.length = 0;
    t.host._localSessionStore.reconcile = async () => {};
    t.host._localSessionStore.list = async () => [{ id: 'A' }, { id: 'B' }];
    t.host._localSessionStore.create = async () => ({ id: 'empty' });
    await t.host._clearAllSessions();
    assert.deepEqual(removed, ['A', 'B']);
    assert.equal(t.host._sessionId, 'empty');
    if (failure === 'removal') assert.deepEqual(cleaned, ['A', 'B']);
    assert.ok(t.messages.some(message => message.valueKey === 'clearHistoryIncomplete'));
}
assert.ok(diagnostics.some(message => message.includes('PR cleanup:')));
console.log('ok PR metadata lookup/lock failures never block deleting transcripts or later cleanup');

const admitted = harness(), attachmentCheck = deferred();
Object.assign(admitted.host, { _pendingJobNotices: [], _localSteerQueue: [], _localTurnToken: 0 });
admitted.host._sessionTransitionsPending = 1;
sandbox.resolveReferenceAttachments = async () => attachmentCheck.promise;
const resend = admitted.host._handleChatRequest('Edit', undefined, { admittedEpoch: 10 });
assert.equal(admitted.host._localRunActive, true, 'admitted resend claims its original session synchronously');
assert.ok(admitted.host._localRunSettled);
attachmentCheck.resolve({ key: 'testAttachmentRejected' });
await resend;
assert.equal(admitted.host._localRunActive, false);
await admitted.host._handleChatRequest('stale', undefined, { admittedEpoch: 9 });
assert.equal(admitted.host._localRunActive, false);
assert.ok(admitted.messages.some(m => m.type === 'sendFailed' && m.prompt === 'stale'));
console.log('ok admitted resend claims execution before releasing the queue and stale admission cannot start a turn');

const canonical = harness(), canonicalLoaded = deferred(), canonicalEntered = deferred();
let canonicalRoot = 'root-A';
sandbox.fs.realpathSync = () => canonicalRoot;
canonical.host._localSessionStore.load = async () => { canonicalEntered.resolve(); return canonicalLoaded.promise; };
const canonicalRequest = canonical.host._openSession('B');
await canonicalEntered.promise;
canonicalRoot = 'root-B';
canonicalLoaded.resolve(snapshot('B'));
await canonicalRequest;
intact(canonical);
assert.ok(canonical.notices.some(n => n[1] === 'sessionSwitchStale'));
sandbox.fs.realpathSync = value => path.resolve(value);
console.log('ok retargeting the same workspace path during loading invalidates its canonical identity');

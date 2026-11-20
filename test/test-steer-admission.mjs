import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const names = ['_handleSteer', '_updateQueuedSteer', '_degradeSteerToTurn', '_confirmSteer', '_handleSteerNow', '_preparingSteers', '_steerNowIds', '_rejectQueuedSteers', '_discardQueuedSteers', '_handleChatRequest'];
const sandbox = { Error, AbortController, vscode: { workspace: { workspaceFolders: [] } }, boundOutcomeEvents() {}, trimDisplayEvent: event => event, historyRowFromEvent: () => null, resolveReferenceAttachments: async () => null, validateHostAttachments: () => null,
    extractPdfAttachments: async attachments => ({ attachments, error: null }), isImageAttachment: () => false, buildLocalUserText: text => text };
vm.runInNewContext(ts.transpileModule(`class Host { ${cls.members.filter(node => names.includes(node.name?.getText(file))).map(node => node.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const host = new sandbox.Host(), messages = [], turns = [];
    Object.assign(host, { _sessionEpoch: 1, _localTurnToken: 1, _localRunActive: true, _activeEngine: 'xratu', _localSteerQueue: [], _view: { webview: { postMessage: message => messages.push(message) } } });
    host._handleChatRequest = async (text, attachments, options) => { turns.push({ text, attachments }); options?.onAccepted?.(); };
    return { host, messages, turns };
}
const stale = fixture(), read = deferred();
sandbox.resolveReferenceAttachments = () => read.promise;
const pending = stale.host._handleSteer('old correction', [], 'old');
stale.host._sessionEpoch++; read.resolve({ key: 'attachFileMissing' }); await pending;
assert.equal(stale.messages.length, 0, 'stale attachment errors cannot leak into the replacement chat');
assert.equal(stale.host._localSteerQueue.length, 0);
sandbox.resolveReferenceAttachments = async () => null;
const replaced = fixture(), extracted = deferred();
sandbox.extractPdfAttachments = () => extracted.promise;
const replacing = replaced.host._handleSteer('for original run', [], 'replaced');
await Promise.resolve(); replaced.host._localTurnToken++; extracted.resolve({ attachments: [], error: null }); await replacing;
assert.equal(replaced.turns.length, 0);
assert.equal(replaced.host._localSteerQueue.length, 0);
assert.equal(replaced.messages.at(-1).steerId, 'replaced');
sandbox.extractPdfAttachments = async attachments => ({ attachments, error: null });
const native = fixture();
native.host._activeEngine = 'opencode';
native.host._openCodeEngine = { steer: async () => assert.fail('OpenCode must not get queued follow-ups before the current turn finishes') };
const nativeFile = [{ id: 'file', name: 'file.txt', dataBase64: 'eA==' }];
await native.host._handleSteer('native correction', nativeFile, 'native');
await native.host._handleSteer('remove this', [], 'remove');
await native.host._handleSteer('send last', [], 'last');
native.host._updateQueuedSteer('native', 'edited native correction');
native.host._updateQueuedSteer('remove');
assert.deepEqual(Array.from(native.host._localSteerQueue, entry => entry.text), ['edited native correction', 'send last']);
assert.equal(native.host._localSteerQueue[0].carryAttachments, nativeFile);
assert.equal(native.messages.at(-1).mode, 'drop');
assert.equal(native.turns.length, 0);
const handled = native.host._localSteerQueue.shift();
await native.host._degradeSteerToTurn(handled.text, handled.carryAttachments, handled.steerId, true);
assert.equal(native.turns[0].text, 'edited native correction');
assert.equal(native.turns[0].attachments, nativeFile);
assert.equal(native.messages.at(-1).mode, 'turn');
native.host._updateQueuedSteer('native', 'too late');
assert.equal(native.messages.at(-1).accepted, false);
const now = fixture();
now.host._activeEngine = 'opencode';
now.host._nativeTurnActive = true;
const handedOff = [];
now.host._openCodeEngine = { steer: async message => { handedOff.push(message); return true; } };
await now.host._handleSteer('leave queued', [], 'wait');
await now.host._handleSteer('deliver now', [], 'now');
await now.host._handleSteerNow('now');
assert.deepEqual(handedOff.map(message => message.text), ['deliver now']);
assert.deepEqual(Array.from(now.host._localSteerQueue, entry => entry.steerId), ['wait']);
assert.equal(now.messages.at(-1).type, 'steerDispatching');

const lifecycle = fixture(), started = deferred(), settle = deferred();
delete lifecycle.host._handleChatRequest;
Object.assign(lifecycle.host, {
    _activeEngine: 'opencode',
    _localRunActive: false,
    _sessionTitle: 'Test chat',
    _history: [],
    _abortControllers: new Map(),
    _checkpoints: { beginTurn() {} },
    _resetLiveSegments() {},
    _endLiveMarkdown() {},
    _displayAssistantResponse() {},
    _pushLocalHistory() {},
    _persistLocalSession: async () => {},
    _postEngineState() {},
    _settleLocalRun() {},
    async _runLocalAgent(prompt, _rules, attachments, _controller, _plan, _hidden, accepted) {
        lifecycle.turns.push({ text: prompt, attachments });
        accepted?.();
        if (prompt === 'initial') { started.resolve(); await settle.promise; }
        return { resultEvent: { persian_explanation: 'Done' }, events: [] };
    },
});
const running = lifecycle.host._handleChatRequest('initial');
await started.promise;
await lifecycle.host._handleSteer('first follow-up', [], 'one');
await lifecycle.host._handleSteer('remove follow-up', [], 'remove');
await lifecycle.host._handleSteer('last follow-up', [], 'last');
lifecycle.host._updateQueuedSteer('one', 'edited follow-up');
lifecycle.host._updateQueuedSteer('remove');
assert.deepEqual(lifecycle.turns.map(turn => turn.text), ['initial']);
settle.resolve();
await running;
assert.deepEqual(lifecycle.turns.map(turn => turn.text), ['initial', 'edited follow-up', 'last follow-up']);
assert.deepEqual(lifecycle.host._history.filter(row => row.role === 'user').map(row => row.content),
    ['initial', 'edited follow-up', 'last follow-up']);
assert.equal(lifecycle.host._localRunActive, false);
assert.equal(lifecycle.host._localSteerQueue.length, 0);

const cancelled = fixture(), attachmentRead = deferred();
sandbox.resolveReferenceAttachments = () => attachmentRead.promise;
const aboutToQueue = cancelled.host._handleSteer('cancel during attachment prep', [], 'cancel');
cancelled.host._updateQueuedSteer('cancel');
attachmentRead.resolve(null);
await aboutToQueue;
assert.equal(cancelled.host._localSteerQueue.length, 0);
assert.equal(cancelled.messages.at(-1).mode, 'drop');
sandbox.resolveReferenceAttachments = async () => null;
for (const accepts of [false, true]) {
    const t = fixture(); t.host._localRunActive = false;
    t.host._handleChatRequest = async (_text, _attachments, options) => { if (accepts) options.onAccepted(); };
    const attachments = [{ id: 'file', name: 'file.txt', dataBase64: 'eA==' }];
    await t.host._handleSteer('late correction', attachments, 'late');
    assert.equal(t.messages[0].type, 'steerApplied');
    const rejected = t.messages.find(message => message.type === 'sendFailed');
    assert.equal(!!rejected, !accepts);
    if (rejected) { assert.equal(rejected.requestId, 'late'); assert.equal(rejected.prompt, 'late correction'); assert.equal(rejected.attachments, attachments); }
}
const immediate = fixture(), preparing = deferred();
sandbox.extractPdfAttachments = () => preparing.promise;
let interrupted = 0;
immediate.host._localSteerInterrupt = () => interrupted++;
const admitting = immediate.host._handleSteer('urgent correction', [], 'urgent');
immediate.host._handleSteerNow('unknown');
assert.equal(interrupted, 0, 'unknown controls cannot interrupt a request');
immediate.host._handleSteerNow('urgent');
assert.equal(interrupted, 0, 'attachment admission must finish before interruption');
preparing.resolve({ attachments: [], error: null }); await admitting;
assert.equal(interrupted, 1, 'an instant request during attachment preparation is not lost');
immediate.host._handleSteerNow('urgent');
assert.equal(interrupted, 2, 'an admitted queued prompt can interrupt the current reply');
immediate.host._activeEngine = 'opencode'; immediate.host._handleSteerNow('urgent');
assert.equal(interrupted, 2, 'native steering stays on the native inbox rail');
immediate.host._rejectQueuedSteers();
assert.equal(immediate.host._localSteerQueue.length, 0, 'failed/cancelled runs cannot leak corrections into the next run');
assert.equal(immediate.messages.at(-1).type, 'composerError');
assert.equal(immediate.messages.at(-1).steerId, 'urgent', 'the held draft is recoverable');
sandbox.extractPdfAttachments = async attachments => ({ attachments, error: null });
const thrown = fixture(); sandbox.resolveReferenceAttachments = async () => { throw Error('read failed'); };
await thrown.host._handleSteer('retain me', [], 'throw');
assert.equal(thrown.messages.at(-1).type, 'composerError');
assert.equal(thrown.messages.at(-1).steerId, 'throw');
console.log('steer-admission: stale sessions, replacement runs, queue edits, cancellation and rejected fallback recovery passed');

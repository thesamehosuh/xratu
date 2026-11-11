import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const names = ['_handleSteer', '_degradeSteerToTurn', '_confirmSteer'];
const sandbox = { Error, resolveReferenceAttachments: async () => null, validateHostAttachments: () => null,
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
const native = fixture(), steering = deferred(), started = deferred();
native.host._activeEngine = 'opencode';
native.host._openCodeEngine = { steer: async () => { started.resolve(); return steering.promise; } };
const nativePending = native.host._handleSteer('native correction', [], 'native');
await started.promise; native.host._sessionEpoch++; native.host._localRunActive = false; steering.resolve(false); await nativePending;
assert.equal(native.turns.length, 0, 'a settled native steer cannot become a turn in the replacement session');
assert.equal(native.messages.length, 0);
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
const thrown = fixture(); sandbox.resolveReferenceAttachments = async () => { throw Error('read failed'); };
await thrown.host._handleSteer('retain me', [], 'throw');
assert.equal(thrown.messages.at(-1).type, 'composerError');
assert.equal(thrown.messages.at(-1).steerId, 'throw');
console.log('steer-admission: stale sessions, replacement runs, native awaits and rejected fallback recovery passed');

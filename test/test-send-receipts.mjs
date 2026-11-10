import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const provider = file.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'XratuChatViewProvider');
const members = provider.members.filter(n => ['_composerReceipts', '_handleComposerSend', '_persistLocalSession', '_draftWorkspaceIdentity'].includes(n.name?.getText(file)));
const sandbox = { contentCapForWindow: () => 24000, process: { platform: process.platform } };
vm.runInNewContext(ts.transpileModule(`class Host { ${members.map(n => n.getText(file)).join('\n')} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
function fixture() {
    const host = new sandbox.Host(), messages = [];
    host._sessionEpoch = 1; host._view = { webview: { postMessage: message => messages.push(message) } };
    host._browserSessionId = () => 'A';
    return { host, messages };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const t = fixture(), held = deferred(); let calls = 0, accepted;
t.host._handleChatRequest = async (_prompt, _attachments, options) => { calls++; accepted = options.onAccepted; await held.promise; };
const running = t.host._handleComposerSend('text', [], 'one', 'A');
await t.host._handleComposerSend('duplicate', [], 'one', 'A');
assert.equal(calls, 1);
accepted(); accepted();
assert.equal(t.messages.filter(m => m.status === 'accepted').length, 1);
held.resolve(); await running;
await t.host._handleComposerSend('duplicate later', [], 'one', 'A');
assert.equal(calls, 1, 'settled duplicates replay only the receipt');
const rejected = fixture();
rejected.host._handleChatRequest = async () => {};
await rejected.host._handleComposerSend('invalid attachment', [], 'two', 'A');
assert.equal(rejected.messages[0].status, 'rejected');
const stale = fixture(); let dispatched = 0;
stale.host._handleChatRequest = async () => { dispatched++; };
await stale.host._handleComposerSend('late message', [], 'three', 'B');
assert.equal(dispatched, 0);
assert.equal(stale.messages[0].valueKey, 'sessionSwitchStale');
const switched = fixture(), waiting = deferred();
switched.host._handleChatRequest = async () => waiting.promise;
const previous = switched.host._handleComposerSend('old chat', [], 'four', 'A');
switched.host._sessionEpoch++; waiting.resolve(); await previous;
assert.equal(switched.messages.length, 0, 'an old request cannot post receipts into the replacement chat');
const persisted = fixture();
Object.assign(persisted.host, {
    _sessionId: null, _sessionTitle: 'Already seeded', _history: [], _localHistory: [],
    _sessionCost: { USD: 0, IRT: 0 }, _sessionUsage: { input: 0, output: 0, cached: 0 }, _sessionUsageByHost: {},
    _trimLocalHistory: () => {}, _contextWindowHint: () => null, _localWorkspaceKey: () => '/project',
    _downloads: { bindSession: async () => {} }, _lastSessionStateKey: () => 'last',
    _globalState: { update: async () => {} },
    _localSessionStore: { create: async () => ({ id: 'disk-id', workspace: '/project' }), save: async () => ({ meta: { title: 'Already seeded' } }) },
    _pushSessionState: () => persisted.messages.push({ id: persisted.host._sessionId }),
});
await persisted.host._persistLocalSession();
assert.equal(persisted.messages[0].id, 'disk-id', 'the first disk identity is echoed even if the title was seeded earlier');
persisted.host._sessionWorkspaceIdentity = () => '/Physical/Root';
assert.equal(persisted.host._draftWorkspaceIdentity(), '/Physical/Root');
sandbox.process.platform = 'win32';
assert.equal(persisted.host._draftWorkspaceIdentity(), '/physical/root');
console.log('send-receipts: idempotent admission, accepted/rejected and stale-session boundaries passed');

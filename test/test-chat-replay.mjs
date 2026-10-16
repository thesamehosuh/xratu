import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { displayHistoryForReplay } = require('../out/chatReplay.js');
const history = [
    { role: 'user', content: 'original', cp: 'checkpoint' },
    { role: 'user', content: 'steer one' },
    { role: 'user', content: 'steer two', attachments: [{ name: 'a.txt' }] },
    { role: 'assistant', events: [
        { type: 'assistant_message', content: 'Before steering' },
        { type: 'steer_user', text: 'steer one' },
        { type: 'assistant_message', content: 'Between steers' },
        { type: 'steer_user', text: 'steer two', attachments: [{ name: 'a.txt' }] },
        { type: 'result', persian_explanation: 'Final response' },
    ] },
];
const original = JSON.stringify(history);
const replay = displayHistoryForReplay(history);
assert.equal(replay.length, 2);
assert.equal(replay[0].content, 'original');
assert.deepEqual(replay[1].events.map(event => event.type), ['assistant_message', 'steer_user', 'assistant_message', 'steer_user', 'result']);
assert.equal(replay[1].events[3].attachments[0].name, 'a.txt');
assert.equal(JSON.stringify(history), original, 'rewind/model ledger is unchanged');
const mismatch = [{ role: 'user', content: 'unrelated', cp: 'sha' }, history[3]];
assert.deepEqual(displayHistoryForReplay(mismatch)[0], mismatch[0]);
assert.ok(displayHistoryForReplay(mismatch)[1].events.every(event => event.type !== 'steer_user'));
assert.deepEqual(displayHistoryForReplay([{ role: 'user', content: 'wake', hidden: true }]), [{ role: 'user', content: 'wake', hidden: true }]);
console.log('chat replay: steers retain event order, attachments and ledger identity');

// Exercise the real host replay method too: helper-only assertions would miss
// restoring the ordered events without forwarding the steer to the webview.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.createSourceFile('extension.ts', readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'XratuChatViewProvider');
const method = cls.members.find(node => node.name?.getText(source) === '_restoreChatUI');
const sandbox = { displayHistoryForReplay };
vm.runInNewContext(ts.transpileModule(`class Host { ${method.getText(source)} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const host = new sandbox.Host(), posted = [];
Object.assign(host, { _history: history, _liveSegments: [], _view: { webview: { postMessage: message => posted.push(message) } }, _resetLiveSegments: () => {}, _renderMarkdown: text => text, _displayAssistantResponse: value => posted.push({ ...value, type:'fullResponse' }) });
host._restoreChatUI();
assert.deepEqual(posted.filter(message => ['restoreUser','chunk','steerUser','fullResponse'].includes(message.type)).map(message => message.value ?? message.persian_explanation), ['original','Before steering','steer one','Between steers','steer two','Final response']);
assert.equal(JSON.stringify(host._history), original);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const provider = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
const method = provider.members.find(node => node.name?.getText(file) === '_handleUriAttachments');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness() {
    const messages = [], sandbox = { Buffer, path, crypto: { randomUUID: () => 'id' }, ATTACH_MAX_COUNT: 4, ATTACH_MAX_BYTES: 4, ATTACH_MAX_TOTAL_BYTES: 6,
        mimeFromFilename: () => 'text/plain', isImageAttachment: () => false, isTextAttachment: () => true, isPdfAttachment: () => false,
        vscode: { Uri: { parse: raw => ({ scheme: 'file', fsPath: raw }) }, FileType: { Directory: 2 }, workspace: { fs: { stat: async () => ({ size: 2, type: 1 }), readFile: async () => Buffer.from('ok') } } } };
    sandbox.readBoundedFile = file => sandbox.vscode.workspace.fs.readFile({ fsPath: file });
    vm.runInNewContext(ts.transpileModule(`class Host { ${method.getText(file)} }; globalThis.Host = Host;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    const host = new sandbox.Host();
    host._sessionEpoch = 1;
    host._view = { webview: { postMessage: message => messages.push(message) } };
    return { host, sandbox, messages };
}
for (const boundary of ['stat', 'readFile']) {
    const t = harness(), held = deferred();
    t.sandbox.vscode.workspace.fs[boundary] = () => held.promise;
    const run = t.host._handleUriAttachments(['note.txt']);
    await Promise.resolve();
    t.host._sessionEpoch++;
    held.resolve(boundary === 'stat' ? { size: 2, type: 1 } : Buffer.from('ok'));
    await run;
    assert.equal(t.messages.length, 0, `${boundary} must not deliver into a replaced chat`);
}
const grown = harness();
grown.sandbox.vscode.workspace.fs.readFile = async () => Buffer.from('12345');
await grown.host._handleUriAttachments(['growing.txt']);
assert.equal(grown.messages[0]?.valueKey, 'attachTooLarge');
assert.ok(!grown.messages.some(message => message.type === 'attachmentsFromHost'));
const valid = harness();
await valid.host._handleUriAttachments(['note.txt']);
assert.equal(valid.messages[0]?.attachments[0].size, 2);
assert.equal(valid.messages[0]?.attachments[0].dataBase64, Buffer.from('ok').toString('base64'));
console.log('attachment-session: stale stat/read results, changed size and normal delivery passed');

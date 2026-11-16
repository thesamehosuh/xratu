import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const original = Module._load;
let diagnostics = [];
let publications = 0;
const uriFor = value => ({ fsPath: value, toString: () => value });
const diagnostic = text => ({ message: text, severity: 0, range: { start: { line: 0, character: 0 } } });
const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined }), isTrusted: true }, env: {}, Uri: { file: uriFor },
    DocumentSymbol: class {}, SymbolInformation: class {},
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    languages: {
        getDiagnostics: () => diagnostics,
        onDidChangeDiagnostics: cb => {
            publications++;
            if (publications === 1) queueMicrotask(() => { diagnostics = []; cb({ uris: [uriFor(path.join(ws, 'sample.txt'))] }); });
            return { dispose() {} };
        },
    },
    commands: { executeCommand: async name => name === 'vscode.executeReferenceProvider'
        ? [0, 1].map(line => ({ uri: uriFor(path.join(ws, 'sample.txt')), range: { start: { line, character: 0 }, end: { line, character: 1 } } }))
        : [{ uri: uriFor(path.join(ws, 'sample.txt')), range: { contains: position => position.line === 0 } }] },
};
Module._load = function (name, ...args) {
    if (name === 'vscode') return vscode;
    return original.call(this, name, ...args);
};
const { createLocalToolExecutor } = require('../out/mcp.js');
const { routeWebviewMessage } = require('../out/webviewRouter.js');
Module._load = original;
const { filePage } = require('../out/tooling/filePage.js');
const ws = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'xratu-reliability-')));
const executor = createLocalToolExecutor(ws, async () => {});
const run = (name, args) => executor.execute({ id: name, name, arguments: args });
try {
    const storage = new Map();
    const posted = [];
    const globalState = { get: key => storage.get(key), update: async (key, value) => storage.set(key, value) };
    const host = { _globalState: globalState, _view: { webview: { postMessage: m => posted.push(m) } } };
    routeWebviewMessage(host, { type: 'appearanceSet', prefs: { accent: 'violet', interfaceSize: 18, customAccent: 'invalid', saturation: 999 } }, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(globalState.get('xratu.appearance').accent, 'violet');
    assert.equal(globalState.get('xratu.appearance').saturation, 150);
    assert.equal(globalState.get('xratu.appearance').customAccent, '#82dbc5');
    assert.equal(posted.at(-1).type, 'appearancePrefs');
    assert.equal(posted.at(-1).prefs.interfaceSize, 18);
    console.log('ok appearance writes validated user-global preferences and echoes them');
    const file = path.join(ws, 'sample.txt');
    fs.writeFileSync(file, 'FIRST\nDO NOT REMOVE\nLAST\nKEEP');
    const patch = await run('edit_file', { path: 'sample.txt', edits: [{ old_text: 'FIRST\nLAST', new_text: 'REPLACEMENT' }] });
    assert.equal(patch.isError, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'FIRST\nDO NOT REMOVE\nLAST\nKEEP');
    console.log('ok noncontiguous patch cannot delete unrelated lines');
    fs.writeFileSync(file, 'x'.repeat(90_000) + '\nTAIL\nKEEP');
    const first = await filePage(file, 'sample.txt', 1, 2000);
    assert.match(first, /start_line=1, start_column=80000/);
    const second = await filePage(file, 'sample.txt', 1, 2000, 80_000);
    assert.ok(second.includes('x'.repeat(10_000) + '\nTAIL\nKEEP'));
    const batch = await run('read_file', { files: [{ path: 'sample.txt' }] });
    assert.match(batch.output, /start_line=1, start_column=80000/);
    fs.writeFileSync(file, 'a\r\nb\r\nc');
    assert.match(await filePage(file, 'sample.txt', 1, 1), /start_line=2, start_column=0/);
    assert.ok((await filePage(file, 'sample.txt', 2, 2)).includes('b\nc'));
    assert.equal((await run('read_file', { path: '.' })).isError, true);
    console.log('ok bounded reads retain continuation across long lines and CRLF');
    const plan = createLocalToolExecutor(ws, async () => {}, undefined, undefined, undefined, undefined, { plan: true });
    for (const name of ['task', 'process']) assert.equal((await plan.execute({ id: name, name, arguments: {} })).isError, true);
    diagnostics = [diagnostic('stale error')];
    const edit = await run('write_file', { path: 'sample.txt', new_content: 'fixed' });
    assert.equal(edit.isError, undefined);
    assert.ok(publications > 0);
    assert.ok(!edit.output.includes('stale error'));
    console.log('ok edits wait for fresh diagnostics even with preexisting errors');
    const references = await run('find_references', { path: 'sample.txt', line: 1, character: 1, include_declaration: false });
    assert.equal(references.isError, undefined);
    assert.equal(JSON.parse(references.output).length, 1);
    console.log('ok reference queries can exclude declarations');
    console.log('ok plan executor denies delegation and process control');
} finally { fs.rmSync(ws, { recursive: true, force: true }); }

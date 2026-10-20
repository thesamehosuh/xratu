import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const original = Module._load;
Module._load = function (name, ...args) {
    if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }), isTrusted: true }, env: {}, Uri: { file: value => ({ fsPath: value }) } };
    return original.call(this, name, ...args);
};
const { createLocalToolExecutor } = require('../out/mcp.js');
Module._load = original;
const { sanitizePath, OutsideWorkspacePathError, withPathAlias } = require('../out/paths.js');
const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'xratu-outside-')));
const workspace = path.join(base, 'workspace');
const outside = path.join(base, 'outside');
fs.mkdirSync(workspace); fs.mkdirSync(outside);
const target = path.join(outside, 'file.txt');
const call = { id: 'edit', name: 'edit_file', arguments: { path: target, mode: 'create', new_content: 'approved' } };
let snapshots = 0;
const executor = (approveOutsideWorkspace, extra = {}) => createLocalToolExecutor(workspace, async () => { snapshots++; }, undefined, undefined, undefined, undefined, { approveOutsideWorkspace, ...extra });
try {
    // Drive the actual host preview method: an outside edit must reach an
    // actionable card, never the legacy preDenied branch or a pre-consent read.
    const hostSource = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('extension.ts', hostSource, ts.ScriptTarget.Latest, true);
    const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'XratuChatViewProvider');
    const method = cls.members.filter(node => ['_processNeedsApproval', '_approveOutsideWorkspace'].includes(node.name?.getText(file))).map(node => node.getText(file)).join('\n');
    const Subject = vm.runInNewContext(ts.transpile(`class Subject { ${method} }; Subject`, { target: ts.ScriptTarget.ES2022 }), {
        vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] } },
        sanitizePath, OutsideWorkspacePathError, withPathAlias, crypto: { randomUUID: () => 'outside-id' },
        resolveEditMode: require('../out/tooling/editFileArgs.js').resolveEditMode,
        sessionApprovalKind: require('../out/sessionApproval.js').sessionApprovalKind,
    });
    const host = new Subject(); const posted = [];
    host._view = { webview: { postMessage: message => posted.push(message) } };
    host._approvalCloseItems = {};
    host._buildDiffPreview = async () => { throw new Error('outside files must not be read for a preview'); };
    await host._processNeedsApproval({ approval_id: 'outside', approvals: [{ tool_call_id: call.id, tool_name: call.name, args: call.arguments }] });
    const card = posted.find(message => message.type === 'needsApproval');
    assert.ok(card); assert.equal(card.preDenied[call.id], undefined);
    assert.equal(card.approvals[0].kind, null);
    assert.equal(card.approvals[0].args.outside_workspace_paths[0], target);
    assert.equal(fs.existsSync(target), false);
    host._requestLocalApproval = async (_id, approvals) => {
        assert.equal(approvals[0].args.path, target, 'executor-side approval normalizes model path aliases');
        return { edit: true };
    };
    assert.equal(await host._approveOutsideWorkspace({ ...call, arguments: { file_path: target, new_content: 'alias' } }, [target]), true);
    let requested;
    const denied = await executor(async (_call, paths) => { requested = paths; return false; }).execute(call);
    assert.equal(denied.isError, true);
    assert.deepEqual(requested, [target]);
    assert.equal(fs.existsSync(target), false);
    assert.equal(snapshots, 0, 'denial must precede snapshots and writes');
    const approved = await executor(async () => true).execute(call);
    assert.equal(approved.isError, undefined, approved.output);
    assert.equal(fs.readFileSync(target, 'utf8'), 'approved');
    assert.throws(() => sanitizePath(target, workspace), /outside/, 'grants must not leak to future calls');
    const next = { ...call, arguments: { ...call.arguments, path: path.join(outside, 'next.txt') } };
    assert.equal((await executor(undefined).execute(next)).isError, true);
    assert.equal(fs.existsSync(next.arguments.path), false);
    let prompted = false;
    const plan = await executor(async () => { prompted = true; return true; }, { plan: true }).execute(next);
    assert.equal(plan.isError, true); assert.equal(prompted, false);
    const controller = new AbortController();
    await assert.rejects(executor(async () => { controller.abort(); return true; }, { signal: controller.signal }).execute(next), /abort/i);
    assert.equal(fs.existsSync(next.arguments.path), false);
    const source = path.join(workspace, 'source.txt'); fs.writeFileSync(source, 'keep');
    const move = { id: 'move', name: 'move_file', arguments: { source, destination: path.join(outside, 'moved.txt') } };
    assert.equal((await executor(async () => false).execute(move)).isError, true);
    assert.equal(fs.readFileSync(source, 'utf8'), 'keep');
    assert.equal((await executor(async () => true).execute(move)).isError, undefined);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(move.arguments.destination, 'utf8'), 'keep');
    // A symlink changed while the approval card is open must not inherit the grant.
    const link = path.join(workspace, 'link');
    try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code !== 'EPERM') throw error; }
    if (fs.existsSync(link)) {
        const other = path.join(base, 'other'); fs.mkdirSync(other);
        const linked = { ...call, arguments: { ...call.arguments, path: path.join(link, 'new.txt') } };
        const switched = await executor(async () => {
            fs.unlinkSync(link); fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir'); return true;
        }).execute(linked);
        assert.equal(switched.isError, true); assert.equal(fs.existsSync(path.join(other, 'new.txt')), false);
    }
    console.log('outside-workspace approval checks passed');
} finally { fs.rmSync(base, { recursive: true, force: true }); }

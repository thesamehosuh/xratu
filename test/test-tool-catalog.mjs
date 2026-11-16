import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const original = Module._load;
Module._load = function (name, ...args) {
    if (name === 'vscode') return {
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        Uri: { file: file => ({ fsPath: file, toString: () => file }) },
        languages: { getDiagnostics: () => [], onDidChangeDiagnostics: () => ({ dispose() {} }) },
        DiagnosticSeverity: { Error: 0, Warning: 1 },
    };
    return original.call(this, name, ...args);
};
const { getLocalToolDefinitions, createLocalToolExecutor } = require('../out/mcp.js');
const { isAvailableTool } = require('../out/tooling/toolPolicy.js');
const { parseUserQuestionArgs } = require('../out/tooling/userQuestion.js');
Module._load = original;
const names = options => new Set(getLocalToolDefinitions(options).map(tool => tool.name));
const removed = ['apply_patch', 'read_files', 'directory_tree', 'workspace_symbols', 'list_code_definition_names', 'file_info', 'copy_file', 'move_file', 'delete_file', 'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'git_branch', 'git_commit', 'git_checkout', 'git_pull', 'git_push', 'git_merge', 'git_show_stash', 'run_tests', 'check_dependencies', 'install_dependency', 'browser_navigate', 'browser_type', 'unlink_pull_request', 'unwatch_pull_request'];
const root = mkdtempSync(path.join(tmpdir(), 'xratu-catalog-'));
try {
    const executor = createLocalToolExecutor(root, async () => {});
    for (const name of removed) {
        assert.equal(names({}).has(name), false, name);
        assert.equal((await executor.execute({ name, id: name, arguments: {} })).isError, true, name);
    }
    for (const name of ['browser_open', 'browser_fill', 'browser_wait_for', 'start_download', 'control_download', 'list_downloads', 'verify_file', 'inspect_archive', 'extract_archive', 'link_pull_request', 'watch_pull_request', 'get_pull_request', 'process', 'skill']) {
        if (name !== 'skill') assert.ok(names({}).has(name), name);
    }
    for (const name of ['write_file', 'edit_file', 'process_input', 'run_terminal_command']) {
        assert.equal(names({ plan: true }).has(name), false);
        assert.equal(getLocalToolDefinitions().find(tool => tool.name === name).requiresApproval, true);
    }
    assert.equal(names({}).has('exit_plan_mode'), false);
    assert.equal(names({ plan: true }).has('exit_plan_mode'), true);
    assert.equal(isAvailableTool('constructor', false), false);
    assert.equal(parseUserQuestionArgs({ question: 'What is the target URL?' }).ok, true);
    writeFileSync(path.join(root, 'sample.txt'), 'one\r\ntwo\r\nthree');
    const failed = await executor.execute({ id: 'atomic', name: 'edit_file', arguments: { path: 'sample.txt', edits: [{ old_text: 'one', new_text: 'ONE' }, { old_text: 'missing', new_text: 'bad' }] } });
    assert.equal(failed.isError, true);
    assert.equal(readFileSync(path.join(root, 'sample.txt'), 'utf8'), 'one\r\ntwo\r\nthree');
    const succeeded = await executor.execute({ id: 'edit', name: 'edit_file', arguments: { path: 'sample.txt', edits: [{ old_text: 'one', new_text: '$&' }] } });
    assert.notEqual(succeeded.isError, true);
    assert.equal(readFileSync(path.join(root, 'sample.txt'), 'utf8'), '$&\r\ntwo\r\nthree');
    writeFileSync(path.join(root, '.hidden'), 'visible');
    const listing = await executor.execute({ id: 'list', name: 'list_files', arguments: {} });
    assert.ok(JSON.parse(listing.output).entries.includes('.hidden'));
    const batch = await executor.execute({ id: 'read', name: 'read_file', arguments: { files: [{ path: 'sample.txt', start_line: 2, max_lines: 1 }] } });
    assert.match(batch.output, /two/);
    assert.doesNotMatch(batch.output, /three/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('ok catalog removals, preserved host tools, gates, atomic edits, CRLF and bounded reads');

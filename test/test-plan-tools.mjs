#!/usr/bin/env node
/**
 * Plan-mode tool surface (a security boundary, not a prompt hint):
 *  - the plan toolset must contain NO mutating tools and NO `task` delegation
 *    (a planning run finishes the plan and exits - it must not farm the work
 *    out to a subagent);
 *  - the normal toolset still offers `task` when profiles exist.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-plan-tools.mjs
 */
import { createRequire } from 'module';
import Module from 'module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// out/mcp.js imports `vscode` at the top; stub it so the pure tool-shape
// logic is testable in plain node.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
            },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            window: { withProgress: async (_o, t) => t() },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { getLocalToolDefinitions } = require('../out/mcp.js');
const { builtinSubagents } = require('../out/subagents.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const subagents = builtinSubagents().filter((d) => !d.error);
const planNames = new Set(getLocalToolDefinitions({ plan: true, subagents }).map((t) => t.name));
const runNames = new Set(getLocalToolDefinitions({ plan: false, subagents }).map((t) => t.name));

// The delegation/planning boundary.
check('plan: no task delegation', planNames.has('task'), false);
check('run: task available', runNames.has('task'), true);

// Mutating tools must be gone in plan mode.
// `run_tests` was read-only-classified, so it stayed available while planning
// even though it executes the project's build/test code and writes artifacts.
for (const name of ['edit_file', 'replace_in_file', 'apply_patch', 'run_terminal_command', 'delete_file', 'move_file', 'copy_file', 'git_commit', 'git_push', 'run_tests']) {
    check(`plan: no ${name}`, planNames.has(name), false);
}

// The approval gate itself: a mutating tool that survives into a normal run
// must actually require approval. `run_tests` was classified read-only, so it
// took no approval while still executing project build/test code.
const runTools = getLocalToolDefinitions({ plan: false, subagents });
for (const name of ['run_tests', 'install_dependency', 'run_terminal_command', 'git_push']) {
    const tool = runTools.find((t) => t.name === name);
    check(`run: ${name} requires approval`, tool ? tool.requiresApproval : false, true);
}
for (const name of ['browser_open', 'browser_navigate', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_resize', 'browser_evaluate', 'browser_close']) {
    check(`plan: no ${name}`, planNames.has(name), false);
    check(`run: ${name} requires approval`, runTools.find(tool => tool.name === name)?.requiresApproval, true);
    check(`YOLO snapshot: ${name} still reaches the live approval gate`, getLocalToolDefinitions({ yolo: true }).find(tool => tool.name === name)?.requiresApproval, true);
}
for (const name of ['browser_status', 'browser_snapshot', 'browser_screenshot', 'list_downloads', 'verify_file', 'inspect_archive']) check(`plan: keeps ${name}`, planNames.has(name), true);
for (const name of ['start_download', 'control_download', 'extract_archive']) {
    check(`plan: no ${name}`, planNames.has(name), false);
    check(`run: ${name} requires approval`, runTools.find(tool => tool.name === name)?.requiresApproval, true);
    check(`YOLO snapshot: ${name} reaches live gate`, getLocalToolDefinitions({ yolo: true }).find(tool => tool.name === name)?.requiresApproval, true);
}

// Read tools stay (planning needs them).
for (const name of ['read_file', 'grep_search', 'list_files', 'update_task_list', 'exit_plan_mode', 'ask_user_question']) {
    check(`plan: keeps ${name}`, planNames.has(name), true);
}

// Web tools stay: they are read-only research (SSRF-guarded fetch).
check('plan: keeps fetch_url (read-only)', planNames.has('fetch_url'), true);

// Exercise the host's real live gate against a tool snapshot created in YOLO.
{
    const ts = require('typescript');
    const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
    let initializer;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'localApprovalGate') initializer = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (!initializer) throw new Error('Host approval gate not found');
    const js = ts.transpileModule(`globalThis.makeGate = function(runPlanMode) { return ${initializer.getText(file)}; };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const sandbox = {}; vm.runInNewContext(js, sandbox);
    let approvals = 0;
    const host = { _yoloMode: true, _requestLocalApproval: async () => { approvals++; return { browser: false }; } };
    const gate = sandbox.makeGate.call(host, false);
    const calls = [{ id: 'browser', name: 'browser_evaluate', arguments: { expression: 'document.title' } }];
    check('live YOLO: gate approves without prompting', (await gate.requestApproval('one', calls)).browser, true);
    host._yoloMode = false;
    check('YOLO disabled after snapshot: gate waits for real approval', (await gate.requestApproval('two', calls)).browser, false);
    check('YOLO disabled after snapshot: approval was requested', approvals, 1);
    host._yoloMode = true;
    const planGate = sandbox.makeGate.call(host, true);
    check('plan gate never bypasses approval through YOLO', (await planGate.requestApproval('three', calls)).browser, false);
    check('plan gate reaches real approval', approvals, 2);
}

console.log(failed === 0 ? '\nplan-tools: all tests passed' : `\nplan-tools: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

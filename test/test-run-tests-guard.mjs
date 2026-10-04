#!/usr/bin/env node
/**
 * `run_tests` containment tests.
 *
 * Regression: `run_tests` took `target` and `extra_args` straight from the
 * model into a runner that LOADS AND EXECUTES code, with no path
 * confinement and no `sanitizePath`. Proven end to end - the tool built
 * `cargo test --manifest-path /outside/Cargo.toml` and that crate's build.rs
 * executed, outside the workspace. Worse, the tool was classified read-only,
 * so it took NO approval (no entry in EXPANSION_MUTATING_TOOL_NAMES) and was
 * still advertised in PLAN MODE, the mode documented as read-only.
 *
 * These assert the three gates: `extra_args` cannot load out-of-tree code,
 * `target` cannot escape the workspace, and legitimate calls still work
 * (including pytest node-id selectors, which must keep their selectors).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-run-tests-guard.mjs
 */
import Module from 'module';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// out/xratu_mcp_tools.js imports `vscode` at the top; stub it so the pure
// guard logic is testable in plain node.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => undefined }) },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            window: { withProgress: async (_o, t) => t() },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const { handleExpansionTool, XRATU_EXPANSION_TOOLS, EXPANSION_MUTATING_TOOL_NAMES } = require('../out/xratu_mcp_tools.js');
const { sanitizePath } = require('../out/paths.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` (${detail})`}`);
};

const ws = mkdtempSync(join(tmpdir(), 'xratu-rt-'));
mkdirSync(join(ws, 'tests'), { recursive: true });
writeFileSync(join(ws, 'tests', 'test_x.py'), 'def test_ok():\n    assert True\n');

let snapshots = 0;
const runtime = {
    workspaceRoot: ws,
    sanitizePath,
    ensureTurnSnapshot: async () => { snapshots++; },
};

const text = (r) => String(r?.content?.[0]?.text ?? '');

/** A refusal must be an ERROR result the model cannot mistake for output. */
const refused = async (args) => {
    const r = await handleExpansionTool('run_tests', args, runtime);
    return { blocked: r.isError === true && /Refusing|outside the workspace/.test(text(r)), msg: text(r) };
};

try {
    // --- extra_args must not be able to load code from outside -------------
    for (const [label, args] of [
        ['cargo --manifest-path', { framework: 'cargo', extra_args: ['--manifest-path', '/tmp/outside/Cargo.toml'] }],
        ['jest --config (separate)', { framework: 'jest', extra_args: ['--config', '/tmp/outside/jest.config.js'] }],
        ['vitest --config= inline', { framework: 'vitest', extra_args: ['--config=/tmp/outside/vitest.config.ts'] }],
        ['pytest -p plugin', { framework: 'pytest', extra_args: ['-p', 'evilplugin'] }],
        ['gradle --init-script', { framework: 'gradle', extra_args: ['--init-script', '/tmp/evil.gradle'] }],
        ['mocha --require', { framework: 'jest', extra_args: ['--require', '/tmp/evil.js'] }],
        ['cargo --target-dir', { framework: 'cargo', extra_args: ['--target-dir', '/tmp/escape'] }],
    ]) {
        const { blocked, msg } = await refused(args);
        ok(`extra_args refuses ${label}`, blocked, msg.slice(0, 80));
    }

    // --- target must stay inside the workspace -----------------------------
    for (const [label, args] of [
        ['absolute outside path', { framework: 'pytest', target: '/etc' }],
        ['parent traversal', { framework: 'jest', target: '../../../etc' }],
        ['absolute outside path (cargo)', { framework: 'cargo', target: '/tmp/outside' }],
    ]) {
        const { blocked, msg } = await refused(args);
        ok(`target refuses ${label}`, blocked, msg.slice(0, 80));
    }

    // --- legitimate calls must still work ----------------------------------
    // These assert the built argv, so a guard that silently rewrote a valid
    // request (e.g. dropping the pytest node-id selector) would fail here.
    // The guard refuses by throwing, which the executor reports as
    // "Error in run_tests: ...". A runner that simply is not installed comes
    // back as a NORMAL result carrying exit_code 1 - the command line is still
    // observable there, which is what these assertions care about.
    const cmdFor = async (args) => {
        const r = await handleExpansionTool('run_tests', args, runtime);
        const body = text(r);
        if (/^Error in run_tests:/.test(body)) return `GUARD-REFUSED: ${body}`;
        try {
            return JSON.parse(body).command;
        } catch {
            return `UNPARSEABLE: ${body.slice(0, 120)}`;
        }
    };
    const before = snapshots;
    const pytestDir = await cmdFor({ framework: 'pytest', target: 'tests' });
    ok('pytest directory target is rebased to an absolute path',
        /pytest .*[/\\]tests$/.test(pytestDir) && pytestDir.includes(ws), pytestDir);
    const nodeId = await cmdFor({ framework: 'pytest', target: 'tests/test_x.py::test_ok' });
    ok('pytest node-id selector keeps its ::selectors',
        nodeId.endsWith(`::test_ok`) && nodeId.includes(join(ws, 'tests', 'test_x.py')), nodeId);
    const withPattern = await cmdFor({ framework: 'pytest', target: 'tests', pattern: 'ok' });
    ok('pytest -k pattern still passed through', withPattern.endsWith('-k ok'), withPattern);
    const benign = await cmdFor({ framework: 'jest', target: 'tests', extra_args: ['--verbose', '--maxWorkers=2'] });
    ok('benign extra_args still pass through', benign.includes('--verbose --maxWorkers=2'), benign);
    ok('run_tests takes a turn snapshot (it writes build artifacts)',
        snapshots > before, `snapshots=${snapshots}`);

    // --- the classification itself ----------------------------------------
    // The gate that made this exploitable: read-only classification meant no
    // approval and availability in plan mode.
    ok('run_tests is classified as mutating', EXPANSION_MUTATING_TOOL_NAMES.has('run_tests'));
    const def = XRATU_EXPANSION_TOOLS.find((t) => t.name === 'run_tests');
    ok('run_tests advertises that it requires approval',
        /Requires approval\.$/.test(def.description), def.description.slice(-40));
} finally {
    rmSync(ws, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll run_tests guard tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
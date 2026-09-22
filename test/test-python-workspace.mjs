#!/usr/bin/env node
/**
 * Python interpreter + working-directory resolution tests.
 *
 * `src/tooling/pythonWorkspace.ts` decides WHICH interpreter runs
 * (run_tests / check_dependencies / install_dependency) and WHICH cwd those
 * tools use. Both were wrong for monorepos before `findManifestDir` existed,
 * so the precedence rules are pinned here:
 *
 *   - manifest lookup is ROOT-THEN-ONE-LEVEL-DOWN, sorted, and skips
 *     dot-dirs plus build/vendor output dirs
 *   - venv lookup is BASE-MAJOR: every venv name inside the manifest
 *     directory beats any venv at the workspace root
 *   - venv name order is .venv > venv > env
 *   - the interpreter binary is platform-gated (Scripts/python.exe on
 *     Windows, bin/python{,3} elsewhere) - the other layout must NOT be
 *     picked up, which is what the CI windows/ubuntu matrix checks
 *   - $VIRTUAL_ENV is a last resort
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-python-workspace.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep, isAbsolute } from 'path';

const require = createRequire(import.meta.url);
const { findManifestDir, pythonWorkspace, PYTHON_MANIFESTS } = require('../out/tooling/pythonWorkspace.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

// --- platform fixture layout -------------------------------------------------
// The module gates on the RUNNING platform, so fixtures must match it. The
// opposite layout is built on purpose to assert it is ignored - that is the
// Linux-vs-Windows half of this suite.
const isWin = process.platform === 'win32';
const VENV_BIN = isWin ? ['Scripts', 'python.exe'] : ['bin', 'python'];
const FOREIGN_BIN = isWin ? ['bin', 'python'] : ['Scripts', 'python.exe'];

const roots = [];
/** Fresh throwaway workspace root. */
const newRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'xratu-pyws-'));
    roots.push(dir);
    return dir;
};
/** Fill a file with empty-ish content at joined path segments. */
const touch = (base, ...segments) => {
    const full = join(base, ...segments);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
    return full;
};
/**
 * Make `dir` ITSELF a venv (interpreter directly inside) and return the
 * interpreter path. This is the shape `$VIRTUAL_ENV` points at - the module
 * appends the platform binary to the directory as given.
 */
const makeVenvDir = (dir, rel = VENV_BIN) => touch(dir, ...rel);

/**
 * Create a venv directory NAMED `venvName` under `base` and return the
 * interpreter path. `rel` defaults to this platform's real layout.
 */
const makeVenv = (base, venvName, rel = VENV_BIN) => makeVenvDir(join(base, venvName), rel);

const savedVenv = process.env.VIRTUAL_ENV;
const setVirtualEnv = (value) => {
    if (value === undefined) delete process.env.VIRTUAL_ENV;
    else process.env.VIRTUAL_ENV = value;
};

try {
    // ---------------------------------------------------------------- manifests
    check('one-level depth constant: 4 manifest types', PYTHON_MANIFESTS.length, 4);
    for (const manifest of ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg']) {
        ok(`PYTHON_MANIFESTS includes ${manifest}`, PYTHON_MANIFESTS.includes(manifest));
    }

    for (const manifest of PYTHON_MANIFESTS) {
        const root = newRoot();
        touch(root, manifest);
        check(`manifest at root: ${manifest}`, findManifestDir(root, PYTHON_MANIFESTS), root);
    }

    {
        const root = newRoot();
        touch(root, 'src', 'main.py');
        check('no manifest anywhere -> empty', findManifestDir(root, PYTHON_MANIFESTS), '');
    }

    {
        // The original bug: per-package manifests live one level down.
        const root = newRoot();
        touch(root, 'backend', 'pyproject.toml');
        check('manifest one level down (monorepo)', findManifestDir(root, PYTHON_MANIFESTS), join(root, 'backend'));
    }

    {
        const root = newRoot();
        touch(root, 'pyproject.toml');
        touch(root, 'backend', 'pyproject.toml');
        check('root manifest wins over subdir', findManifestDir(root, PYTHON_MANIFESTS), root);
    }

    {
        const root = newRoot();
        touch(root, '.hidden', 'pyproject.toml');
        check('dot-dir is not scanned', findManifestDir(root, PYTHON_MANIFESTS), '');
    }

    for (const ignored of ['node_modules', 'dist', 'out', 'build', 'target', 'vendor', 'coverage']) {
        const root = newRoot();
        touch(root, ignored, 'pyproject.toml');
        check(`ignored dir skipped: ${ignored}`, findManifestDir(root, PYTHON_MANIFESTS), '');
    }

    {
        // Two candidate subdirs: sorted order makes the pick deterministic.
        const root = newRoot();
        touch(root, 'zeta', 'pyproject.toml');
        touch(root, 'alpha', 'pyproject.toml');
        check('two candidates: alphabetically first wins', findManifestDir(root, PYTHON_MANIFESTS), join(root, 'alpha'));
    }

    {
        // Scan is one level deep only - nesting must not be reached.
        const root = newRoot();
        touch(root, 'a', 'b', 'pyproject.toml');
        check('nested deeper than one level is not found', findManifestDir(root, PYTHON_MANIFESTS), '');
    }

    // ------------------------------------------------------------- pythonWorkspace
    {
        const root = newRoot();
        setVirtualEnv(undefined);
        const ws = pythonWorkspace(root);
        check('no venv -> PATH interpreter', ws.python, 'python');
        check('no venv -> source PATH', ws.source, 'PATH');
        check('no manifest -> cwd is root', ws.cwd, root);
    }

    {
        // cwd follows the manifest even when the interpreter comes from PATH.
        const root = newRoot();
        setVirtualEnv(undefined);
        touch(root, 'backend', 'pyproject.toml');
        const ws = pythonWorkspace(root);
        check('manifest decides cwd', ws.cwd, join(root, 'backend'));
        check('manifest without venv -> PATH', ws.source, 'PATH');
    }

    {
        const root = newRoot();
        setVirtualEnv(undefined);
        const expected = makeVenv(root, '.venv');
        const ws = pythonWorkspace(root);
        check('.venv detected', ws.python, expected);
        check('.venv source', ws.source, 'venv');
        check('.venv cwd is root', ws.cwd, root);
    }

    {
        // .venv > venv > env
        const root = newRoot();
        setVirtualEnv(undefined);
        makeVenv(root, 'venv');
        makeVenv(root, 'env');
        const best = makeVenv(root, '.venv');
        check('prefers .venv over venv/env', pythonWorkspace(root).python, best);
    }

    {
        const root = newRoot();
        setVirtualEnv(undefined);
        makeVenv(root, 'env');
        const better = makeVenv(root, 'venv');
        check('prefers venv over env', pythonWorkspace(root).python, better);
    }

    {
        // BASE-MAJOR: any venv in the manifest dir beats .venv at the root.
        const root = newRoot();
        setVirtualEnv(undefined);
        makeVenv(root, '.venv');
        touch(root, 'backend', 'pyproject.toml');
        const nested = makeVenv(join(root, 'backend'), 'env');
        const ws = pythonWorkspace(root);
        check('manifest-dir venv beats root .venv', ws.python, nested);
        check('cwd stays the manifest dir', ws.cwd, join(root, 'backend'));
    }

    {
        // Root venv is still used when the manifest dir has none.
        const root = newRoot();
        setVirtualEnv(undefined);
        const rootVenv = makeVenv(root, '.venv');
        touch(root, 'backend', 'pyproject.toml');
        const ws = pythonWorkspace(root);
        check('root venv used when manifest dir has none', ws.python, rootVenv);
        check('cwd still the manifest dir', ws.cwd, join(root, 'backend'));
    }

    {
        // Platform gating: the OTHER platform's layout must not be detected.
        const root = newRoot();
        setVirtualEnv(undefined);
        makeVenv(root, '.venv', FOREIGN_BIN);
        const ws = pythonWorkspace(root);
        check('foreign-platform venv layout ignored', ws.source, 'PATH');
        check('foreign-platform venv -> bare python', ws.python, 'python');
    }

    {
        // Secondary binary name on this platform (bin/python3 / Scripts/python).
        const root = newRoot();
        setVirtualEnv(undefined);
        const alt = isWin ? ['Scripts', 'python'] : ['bin', 'python3'];
        const expected = makeVenv(root, '.venv', alt);
        const ws = pythonWorkspace(root);
        check(`secondary interpreter name accepted (${alt.join('/')})`, ws.python, expected);
        check('secondary interpreter -> venv source', ws.source, 'venv');
    }

    {
        // The real layout wins when both names exist.
        const root = newRoot();
        setVirtualEnv(undefined);
        const primary = makeVenv(root, '.venv', VENV_BIN);
        const alt = isWin ? ['Scripts', 'python'] : ['bin', 'python3'];
        makeVenv(root, '.venv', alt);
        check('primary interpreter name preferred', pythonWorkspace(root).python, primary);
    }

    {
        const root = newRoot();
        const vdir = newRoot();
        // $VIRTUAL_ENV names the venv DIRECTORY; the binary is appended.
        const expected = makeVenvDir(vdir);
        setVirtualEnv(vdir);
        const ws = pythonWorkspace(root);
        check('$VIRTUAL_ENV honored', ws.python, expected);
        check('$VIRTUAL_ENV source tag', ws.source, 'VIRTUAL_ENV');
        check('$VIRTUAL_ENV cwd is root', ws.cwd, root);
    }

    {
        // A project venv always outranks the ambient environment.
        const root = newRoot();
        const vdir = newRoot();
        makeVenvDir(vdir);
        setVirtualEnv(vdir);
        const local = makeVenv(root, '.venv');
        const ws = pythonWorkspace(root);
        check('project venv beats $VIRTUAL_ENV', ws.python, local);
        check('project venv source tag', ws.source, 'venv');
    }

    {
        // $VIRTUAL_ENV pointing somewhere without an interpreter must fall through.
        const root = newRoot();
        const vdir = newRoot();
        // Directory exists but carries no interpreter -> must not be trusted.
        setVirtualEnv(vdir);
        check('$VIRTUAL_ENV without interpreter falls back', pythonWorkspace(root).source, 'PATH');
    }

    {
        // No venv and no $VIRTUAL_ENV -> the bare PATH name, not a stray path.
        setVirtualEnv(undefined);
        const root = newRoot();
        const ws = pythonWorkspace(root);
        check('no venv -> bare PATH name, not a stray interpreter', ws.python, 'python');
        check('returned cwd exists on disk', existsSync(ws.cwd), true);
    }

    {
        // A detected interpreter must live INSIDE the fixture root: an
        // unrelated existing path on disk must not satisfy this.
        setVirtualEnv(undefined);
        const root = newRoot();
        const expected = makeVenv(root, '.venv');
        const ws = pythonWorkspace(root);
        check('detected interpreter is under the workspace root', ws.python, expected);
        ok('detected interpreter path is beneath root', isAbsolute(ws.python) && ws.python.startsWith(root + sep));
    }
} finally {
    setVirtualEnv(savedVenv);
    for (const dir of roots) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

console.log(failed === 0 ? '\npython-workspace tests: all passed' : `\npython-workspace tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

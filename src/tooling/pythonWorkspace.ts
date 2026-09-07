/**
 * Python interpreter + working-directory resolution for Python-ecosystem
 * expansion tools (run_tests / check_dependencies / install_dependency).
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see out/tooling/pythonWorkspace.js after `npm run compile-tests`).
 */
import * as fs from 'fs';
import * as path from 'path';

export const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'];
const DIR_SCAN_IGNORE = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor', 'coverage']);

/** Immediate non-ignored subdirectories of root, sorted for determinism. */
function immediateDirs(root: string): string[] {
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.') && !DIR_SCAN_IGNORE.has(d.name))
            .map(d => d.name).sort();
    } catch { return []; }
}

/**
 * First directory (root, then one level down) containing any of `manifests`.
 * Monorepo layouts commonly keep per-package manifests in subdirectories
 * (src/pyproject.toml, extension/package.json); root-only checks made the
 * dependency/test tools report the wrong ecosystem and run in the wrong cwd.
 */
export function findManifestDir(root: string, manifests: string[]): string {
    const has = (dir: string) => manifests.some(m => fs.existsSync(path.join(dir, m)));
    if (has(root)) return root;
    for (const name of immediateDirs(root)) {
        const dir = path.join(root, name);
        if (has(dir)) return dir;
    }
    return '';
}

/**
 * Python interpreter + working directory for Python-ecosystem tools.
 * Prefers the project virtualenv (manifest dir, then workspace root, then
 * $VIRTUAL_ENV) over bare `python` on PATH, so tests and pip operate on the
 * project's interpreter, not the system one. cwd is the directory holding
 * the Python manifest - imports like `from deps import ...` resolve
 * relative to it, which is why running from the workspace root fails.
 */
export function pythonWorkspace(root: string): { python: string; cwd: string; source: string } {
    const manifestDir = findManifestDir(root, PYTHON_MANIFESTS) || root;
    const bases = [...(manifestDir !== root ? [manifestDir] : []), root];
    const rels = process.platform === 'win32'
        ? [path.join('Scripts', 'python.exe'), path.join('Scripts', 'python')]
        : [path.join('bin', 'python'), path.join('bin', 'python3')];
    for (const base of bases) {
        for (const venv of ['.venv', 'venv', 'env']) {
            for (const rel of rels) {
                const candidate = path.join(base, venv, rel);
                if (fs.existsSync(candidate)) return { python: candidate, cwd: manifestDir, source: 'venv' };
            }
        }
    }
    const virtualEnv = process.env.VIRTUAL_ENV;
    if (virtualEnv) {
        for (const rel of rels) {
            const candidate = path.join(virtualEnv, rel);
            if (fs.existsSync(candidate)) return { python: candidate, cwd: manifestDir, source: 'VIRTUAL_ENV' };
        }
    }
    return { python: 'python', cwd: manifestDir, source: 'PATH' };
}

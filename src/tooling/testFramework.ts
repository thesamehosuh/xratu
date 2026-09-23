/**
 * Test-framework auto-detection for the `run_tests` expansion tool.
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-test-framework.mjs) - the same precedent as
 * `pythonWorkspace.ts` / `shellPlatform.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { findManifestDir, PYTHON_MANIFESTS } from './pythonWorkspace';

/**
 * Pick a test framework from the workspace's on-disk signals.
 *
 * ORDER MATTERS. A `tests/` directory is NOT a Python signal - Node/TS
 * projects use it just as often. It used to be checked FIRST, so a Node repo
 * with `tests/` and vitest/jest in package.json was detected as `pytest` and
 * `run_tests` ran `python -m pytest` (live: "No module named pytest"). Strong
 * Python signals (manifest/config files) still win outright; the bare
 * `tests/` heuristic only applies when there is no package.json to speak for
 * the project, or no JS runner was declared in it.
 */
export async function detectFramework(root: string): Promise<string> {
    const exists = (p: string) => fs.existsSync(path.join(root, p));
    // Strong Python signals first: an explicit config or a Python manifest
    // (possibly one level down in a monorepo) is unambiguous.
    if (exists('pytest.ini') || exists('pyproject.toml') || exists('tox.ini')
        || findManifestDir(root, PYTHON_MANIFESTS)) return 'pytest';
    if (exists('package.json')) {
        try {
            const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
            if (deps.vitest) return 'vitest';
            if (deps.jest) return 'jest';
        } catch { /* fall through */ }
    }
    // Weak signal: a tests/ directory with nothing above to identify the
    // project - historically Python (pytest) more often than not.
    if (exists('tests')) return 'pytest';
    if (exists('Cargo.toml')) return 'cargo';
    if (exists('go.mod')) return 'go';
    if (exists('pom.xml')) return 'maven';
    if (exists('build.gradle') || exists('build.gradle.kts')) return 'gradle';
    if (exists('*.sln') || fs.readdirSync(root).some(x => x.endsWith('.sln') || x.endsWith('.csproj'))) return 'dotnet';
    if (exists('Gemfile') && exists('spec')) return 'rspec';
    if (exists('composer.json')) return 'phpunit';
    if (exists('Package.swift')) return 'swift';
    return 'unittest';
}

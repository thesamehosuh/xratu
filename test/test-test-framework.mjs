#!/usr/bin/env node
/**
 * Test-framework auto-detection tests for `src/tooling/testFramework.ts`.
 *
 * Regression: `detectFramework` checked `exists('tests')` as a PYTHON signal
 * BEFORE looking at package.json, so any Node/TS repo with a `tests/`
 * directory was detected as `pytest` and `run_tests` ran `python -m pytest`
 * (live: "No module named pytest") even with vitest/jest declared.
 *
 * The precedence rules pinned here:
 *   - strong Python signals (pytest.ini / pyproject.toml / tox.ini / a Python
 *     manifest, root or one level down) win outright;
 *   - a declared JS runner in package.json beats the weak `tests/` heuristic;
 *   - the bare `tests/` directory only means pytest when nothing else
 *     identifies the project;
 *   - the remaining ecosystems fall through in order.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-test-framework.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { detectFramework } = require('../out/tooling/testFramework.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const roots = [];
/** Fresh throwaway workspace root containing the given files. */
const newRoot = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'xratu-fw-'));
    roots.push(dir);
    for (const [rel, content] of Object.entries(files ?? {})) {
        const full = join(dir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
    }
    return dir;
};
const pkg = (deps) => JSON.stringify({ devDependencies: deps });

try {
    // --- THE regression: a `tests/` dir must not shadow a JS runner ----------
    check('node + tests/ + vitest -> vitest',
        await detectFramework(newRoot({ 'package.json': pkg({ vitest: '1' }), 'tests/a.test.js': '' })), 'vitest');
    check('node + tests/ + jest -> jest',
        await detectFramework(newRoot({ 'package.json': pkg({ jest: '1' }), 'tests/a.test.js': '' })), 'jest');
    check('node + tests/ + vitest and jest -> vitest wins',
        await detectFramework(newRoot({ 'package.json': pkg({ jest: '1', vitest: '1' }), 'tests/a.test.js': '' })), 'vitest');

    // Sanity: the same repos WITHOUT the tests/ dir already behaved.
    check('node + vitest (no tests/) -> vitest',
        await detectFramework(newRoot({ 'package.json': pkg({ vitest: '1' }), 'src/a.js': '' })), 'vitest');

    // --- strong Python signals still win ------------------------------------
    check('pyproject.toml -> pytest',
        await detectFramework(newRoot({ 'pyproject.toml': '' })), 'pytest');
    check('pytest.ini -> pytest',
        await detectFramework(newRoot({ 'pytest.ini': '' })), 'pytest');
    check('tox.ini -> pytest',
        await detectFramework(newRoot({ 'tox.ini': '' })), 'pytest');
    check('requirements.txt at root -> pytest',
        await detectFramework(newRoot({ 'requirements.txt': '' })), 'pytest');
    check('python manifest one level down -> pytest',
        await detectFramework(newRoot({ 'backend/pyproject.toml': '' })), 'pytest');
    // A strong Python signal outranks a JS runner (polyglot repo): unchanged.
    check('pyproject.toml + package.json/jest -> pytest',
        await detectFramework(newRoot({ 'pyproject.toml': '', 'package.json': pkg({ jest: '1' }) })), 'pytest');

    // --- the weak `tests/` heuristic still covers plain Python --------------
    check('tests/ with no other signal -> pytest',
        await detectFramework(newRoot({ 'tests/test_a.py': '' })), 'pytest');
    // package.json without a known runner falls through to the weak signal.
    check('node + tests/ + no known runner -> pytest',
        await detectFramework(newRoot({ 'package.json': pkg({ mocha: '1' }), 'tests/a.test.js': '' })), 'pytest');

    // --- other ecosystems ----------------------------------------------------
    check('Cargo.toml -> cargo', await detectFramework(newRoot({ 'Cargo.toml': '' })), 'cargo');
    check('go.mod -> go', await detectFramework(newRoot({ 'go.mod': '' })), 'go');
    check('pom.xml -> maven', await detectFramework(newRoot({ 'pom.xml': '' })), 'maven');
    check('build.gradle -> gradle', await detectFramework(newRoot({ 'build.gradle': '' })), 'gradle');
    check('Gemfile + spec/ -> rspec',
        await detectFramework(newRoot({ Gemfile: '', 'spec/a_spec.rb': '' })), 'rspec');
    check('composer.json -> phpunit', await detectFramework(newRoot({ 'composer.json': '' })), 'phpunit');
    check('Package.swift -> swift', await detectFramework(newRoot({ 'Package.swift': '' })), 'swift');
    check('nothing -> unittest', await detectFramework(newRoot({ 'src/main.py': '' })), 'unittest');
} finally {
    for (const dir of roots) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

console.log(failed === 0 ? '\ntest-framework tests: all passed' : `\ntest-framework tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

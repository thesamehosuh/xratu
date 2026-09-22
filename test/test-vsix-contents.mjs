#!/usr/bin/env node
/**
 * VSIX packaging guard: only the intended files may ship.
 *
 * Regression: the published artifact was 143 files, of which 131 were junk -
 * `.playwright-mcp/` (54), `out/` (68), `.kilo/` (5), `.github/` (2),
 * `test-results/` (1) and `kilo.json` (1). `out/` alone is 1.24 MB, and the
 * machine-local dirs are explicitly marked "never commit" in .gitignore.
 *
 * Root cause: vsce reads ONLY `.vscodeignore`. It does not consult
 * `.gitignore`, so every gitignored path silently shipped anyway.
 *
 * This test runs vsce's own file listing and enforces a DENY-BY-DEFAULT
 * allowlist, so a new stray directory cannot reach users unnoticed. It is the
 * enforcement half of the .vscodeignore fix.
 *
 * Run:  node test/test-vsix-contents.mjs   (needs `npx tsc -p . --outDir out`
 * only insofar as it is part of the host suite; it needs no compiled output)
 */
import { createRequire } from 'module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// The intended package contents. Keep this list tight: anything not matched
// here fails the test on purpose, so adding a file to the VSIX is a conscious
// decision (either allow it here, or ignore it in .vscodeignore).
// ---------------------------------------------------------------------------
const ALLOWED_FILES = new Set([
    'package.json',
    'package.nls.json',
    'package.nls.fa.json',
    'README.md',
    'LICENSE',
]);
const ALLOWED_PREFIXES = [
    'dist/',            // esbuild host bundle + built webview + pdf worker
    'assets/skills/',   // bundled default skills
    'assets/fonts/',    // font licence text
];
const ALLOWED_EXACT_ASSETS = new Set([
    'assets/icon.png',
    'assets/activitybar.svg',
]);

/**
 * Paths that must NEVER be packaged, whatever the allowlist says. Checked
 * separately so the failure names the leak even if someone widens the
 * allowlist carelessly.
 */
const FORBIDDEN = [
    '.kilo/',
    '.playwright-mcp/',
    '.github/',
    'out/',
    'test-results/',
    'playwright-report/',
    'src/',
    'test/',
    'webview-ui/',
    'node_modules/',
    'kilo.json',
    '.env',
];

/** Minimum plausible package size; below this vsce probably did not run. */
const MIN_EXPECTED_FILES = 5;

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

// --- run vsce's own listing ------------------------------------------------
// Invoke the JS entry with node directly rather than the `.bin` shim: the shim
// is a shell script on POSIX and a .cmd on Windows, and this avoids both.
const vsceDir = dirname(require.resolve('@vscode/vsce/package.json'));
const vsceBin = join(vsceDir, require('@vscode/vsce/package.json').bin.vsce);
// vsceDir is <root>/node_modules/@vscode/vsce, so the package root is THREE
// levels up; two would land in node_modules and list the wrong tree.
const projectRoot = join(vsceDir, '..', '..', '..');
const run = spawnSync(process.execPath, [vsceBin, 'ls', '--no-dependencies'], {
    cwd: projectRoot,
    encoding: 'utf8',
    // vsce ls is fast; a long stall means something is wrong, not slow.
    timeout: 120_000,
});

if (run.error) {
    ok('vsce ls ran', false, String(run.error.message ?? run.error));
} else if (run.status !== 0) {
    const stderr = (run.stderr ?? '').trim().split('\n').slice(-4).join(' | ');
    ok('vsce ls exited cleanly', false, `status ${run.status}: ${stderr}`);
}

const files = (run.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

ok('vsce ls produced a file list', files.length >= MIN_EXPECTED_FILES, `got ${files.length} files`);

if (files.length >= MIN_EXPECTED_FILES) {
    // --- no forbidden path may appear -------------------------------------
    for (const bad of FORBIDDEN) {
        const hits = files.filter((f) => f === bad || f.startsWith(bad));
        ok(`not packaged: ${bad}`, hits.length === 0, `${hits.length} file(s), e.g. ${hits[0] ?? ''}`);
    }

    // --- deny by default: everything must be explicitly intended ----------
    const unexpected = files.filter((f) => {
        if (ALLOWED_FILES.has(f)) return false;
        if (ALLOWED_EXACT_ASSETS.has(f)) return false;
        return !ALLOWED_PREFIXES.some((p) => f.startsWith(p));
    });
    ok(
        'no files outside the intended package set',
        unexpected.length === 0,
        `${unexpected.length} unexpected: ${unexpected.slice(0, 6).join(', ')}`
            + (unexpected.length > 6 ? ' ...' : '')
            + ' (allow it in test-vsix-contents.mjs, or ignore it in .vscodeignore)',
    );

    // --- the things that MUST ship must actually ship ---------------------
    for (const needed of ['package.json', 'dist/extension.js', 'LICENSE', 'README.md', 'assets/icon.png']) {
        ok(`still packaged: ${needed}`, files.includes(needed), 'excluded by an over-broad ignore rule');
    }

    console.log(`\nvsix contents: ${files.length} files packaged`);
}

console.log(failed === 0 ? 'vsix-contents: all checks passed' : `vsix-contents: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

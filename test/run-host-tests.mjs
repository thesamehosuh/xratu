#!/usr/bin/env node
/**
 * Aggregate host-side suite runner - `npm run test:host`.
 *
 * The suite list is DERIVED from the `test:*` scripts in package.json, never
 * hand-maintained. A new suite is picked up automatically, so it can no longer
 * be forgotten in CI.
 *
 * That is a real regression, not a hypothetical one: `test:model-metadata`
 * (90 assertions) shipped as an npm script but was never added to the CI step
 * list, so it only ever ran on a machine where someone typed it by hand.
 * Deriving the list makes "forgot to wire the suite into CI" structurally
 * impossible for host suites.
 *
 * NOT_HOST_SUITES are the `test:*` scripts this runner must not own:
 *   webview / e2e  - need the webview build + a browser (separate CI steps)
 *   host           - this runner
 *
 * Requires the compiled host output (`out/`) because the suites under test
 * resolve `../out/*.js`. CI compiles before calling this; locally run
 * `npx tsc -p . --outDir out` first.
 *
 * Run:  npm run test:host
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// cross-spawn exposes the sync API as `.sync` (there is no `.spawnSync`).
// It resolves `npm` to npm.cmd on Windows, which a bare spawn would not.
const { sync: crossSpawnSync } = require('cross-spawn');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

const NOT_HOST_SUITES = new Set(['webview', 'e2e', 'host']);
const PREFIX = 'test:';

const suites = Object.keys(pkg.scripts ?? {})
    .filter((name) => name.startsWith(PREFIX))
    .map((name) => name.slice(PREFIX.length))
    .filter((name) => !NOT_HOST_SUITES.has(name))
    .sort();

if (suites.length === 0) {
    console.error('host-tests: no suites discovered - is package.json intact?');
    process.exit(1);
}

if (!existsSync(join(repoRoot, 'out'))) {
    console.error(
        'host-tests: compiled host output is missing (out/).\n' +
        '  The suites require it - run:  npx tsc -p . --outDir out',
    );
    process.exit(1);
}

console.log(`host-tests: ${suites.length} suites discovered from package.json`);

const results = [];
for (const suite of suites) {
    const script = `${PREFIX}${suite}`;
    process.stdout.write(`\n=== ${script} ===\n`);
    const started = Date.now();
    const res = crossSpawnSync('npm', ['run', '--silent', script], {
        cwd: repoRoot,
        stdio: 'inherit',
    });
    // status is null when the child died on a signal - that is a failure too.
    const passed = res.status === 0;
    results.push({ script, passed, ms: Date.now() - started });
}

const failed = results.filter((r) => !r.passed);
console.log('\n=== host suite summary ===');
for (const r of results) {
    console.log(`${r.passed ? 'ok  ' : 'FAIL'} ${r.script} (${(r.ms / 1000).toFixed(1)}s)`);
}

if (failed.length) {
    console.log(`\nhost-tests: ${failed.length}/${results.length} suites FAILED: ${failed.map((f) => f.script).join(', ')}`);
    process.exit(1);
}
console.log(`\nhost-tests: all ${results.length} suites passed`);

/**
 * Cross-platform webview test runner.
 *
 * Replaces the former `&&`-chained npm script: on Windows, npm script chains
 * run through cmd.exe and the esbuild .cmd shim can exit 0 even when the
 * bundle fails - the chained `node` then ran against a missing outfile
 * (CI: "Cannot find module dist-tests/webview-test.cjs"). Using esbuild's JS
 * API makes every failure throw loudly, and spawning each bundle directly
 * avoids shell-chain semantics entirely.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const OUT_DIR = 'dist-tests';
const suites = [
    { entry: 'webview-ui/test/state.test.ts', outfile: 'dist-tests/webview-test.cjs' },
    { entry: 'webview-ui/test/tasklist-render.test.tsx', outfile: 'dist-tests/tasklist-render-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/local-agent.test.ts', outfile: 'dist-tests/local-agent-test.cjs' },
    { entry: 'webview-ui/test/mention.test.ts', outfile: 'dist-tests/mention-test.cjs' },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const suite of suites) {
    process.stdout.write(`[webview-tests] bundling ${suite.entry}\n`);
    try {
        await build({
            entryPoints: [suite.entry],
            bundle: true,
            format: 'cjs',
            platform: 'node',
            outfile: suite.outfile,
            ...(suite.jsx ? { jsx: suite.jsx } : {}),
        });
    } catch (e) {
        console.error(`[webview-tests] esbuild failed for ${suite.entry}`);
        throw e;
    }
    const run = spawnSync(process.execPath, [suite.outfile], { stdio: 'inherit' });
    if (run.error) throw run.error;
    if (run.status !== 0) {
        console.error(`[webview-tests] FAILED: ${suite.entry} (exit ${run.status})`);
        process.exit(run.status ?? 1);
    }
}

console.log('[webview-tests] all webview test suites passed');

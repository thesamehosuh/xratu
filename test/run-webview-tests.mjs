/**
 * Cross-platform webview test runner.
 *
 * Bundles every webview test suite in parallel via esbuild's JS API (avoiding
 * Windows cmd.exe `&&`-chain exit-code quirks) and runs the compiled bundles
 * concurrently in bounded worker slots.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';

const OUT_DIR = 'dist-tests';
const suites = [
    { entry: 'webview-ui/test/composer-drafts.test.ts', outfile: 'dist-tests/composer-drafts-test.cjs' },
    { entry: 'webview-ui/test/conversation-activity.test.tsx', outfile: 'dist-tests/conversation-activity-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/agent-observation.test.tsx', outfile: 'dist-tests/agent-observation-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/work-surface-render.test.tsx', outfile: 'dist-tests/work-surface-render-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/state.test.ts', outfile: 'dist-tests/webview-test.cjs' },
    { entry: 'webview-ui/test/tasklist-render.test.tsx', outfile: 'dist-tests/tasklist-render-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/decision-card-render.test.tsx', outfile: 'dist-tests/decision-card-render-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/message-list-paging.test.tsx', outfile: 'dist-tests/message-list-paging-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/tool-pill-grouping.test.tsx', outfile: 'dist-tests/tool-pill-grouping-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/tool-images.test.tsx', outfile: 'dist-tests/tool-images-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/background-tools.test.tsx', outfile: 'dist-tests/background-tools-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/local-agent.test.ts', outfile: 'dist-tests/local-agent-test.cjs' },
    { entry: 'webview-ui/test/mention.test.ts', outfile: 'dist-tests/mention-test.cjs' },
    { entry: 'webview-ui/test/datetime.test.ts', outfile: 'dist-tests/datetime-test.cjs' },
    { entry: 'webview-ui/test/usage-tokens.test.ts', outfile: 'dist-tests/usage-tokens-test.cjs' },
    // Imports MessageItem (TSX), so it needs the automatic JSX runtime.
    { entry: 'webview-ui/test/patch-blocks.test.ts', outfile: 'dist-tests/patch-blocks-test.cjs', jsx: 'automatic' },
    { entry: 'webview-ui/test/transcript-prefs.test.tsx', outfile: 'dist-tests/transcript-prefs-test.cjs', jsx: 'automatic' },
];

mkdirSync(OUT_DIR, { recursive: true });

const startedAt = Date.now();
await Promise.all(suites.map(async (suite) => {
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
}));

function runBundle(suite) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [suite.outfile], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const capture = (chunk) => { output += chunk.toString(); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        child.on('error', (err) => {
            resolve({ suite, passed: false, status: null, ms: Date.now() - t0, output: `${output}\nspawn error: ${err.message}` });
        });
        child.on('close', (status, signal) => {
            if (signal) output += `\nkilled by signal ${signal}`;
            resolve({ suite, passed: status === 0, status, ms: Date.now() - t0, output });
        });
    });
}

const concurrency = Math.max(1, Math.min(suites.length, availableParallelism()));
const results = new Array(suites.length);
let cursor = 0;

await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
        const index = cursor++;
        if (index >= suites.length) return;
        results[index] = await runBundle(suites[index]);
    }
}));

const failed = results.filter((r) => !r.passed);
for (const r of results) {
    process.stdout.write(`${r.passed ? 'ok  ' : 'FAIL'} ${r.suite.entry} (${(r.ms / 1000).toFixed(2)}s)\n`);
}
if (failed.length > 0) {
    for (const r of failed) {
        console.error(`\n[webview-tests] FAILED: ${r.suite.entry} (exit ${r.status})`);
        if (r.output.trim()) console.error(r.output.trimEnd());
    }
    process.exit(1);
}

console.log(`[webview-tests] all ${suites.length} webview test suites passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

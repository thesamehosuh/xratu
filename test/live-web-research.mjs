/** Opt-in public-query compatibility/retrieval evaluation. No model calls,
 * credentials, source code, workspace paths or paid routes are transmitted.
 * Run after compile-tests: node test/live-web-research.mjs --live --output /tmp/results.json
 * This measures retrieval, not answer correctness or regional availability. */
import { readFile, writeFile } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--live')) throw new Error('Pass --live to send the public query fixtures to hosted providers.');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
    if (name === 'vscode') return { workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
    return originalLoad.call(this, name, ...args);
};
const require = createRequire(import.meta.url);
const { executeWebTool } = require('../out/webTools.js');
const { researchSession } = require('../out/web/service.js');
const { matchesDomains } = require('../out/web/providers.js');
const queries = JSON.parse(await readFile(fileURLToPath(new URL('./web-research-queries.json', import.meta.url)), 'utf8'));
researchSession('public-evaluation');
const results = [];
for (const task of queries) {
    const start = performance.now();
    try {
        const result = await executeWebTool('web_search', { query: task.query, max_results: 5, ...(task.domains ? { domains: task.domains } : {}) });
        if (!result.research) throw new Error(result.output || 'Missing research outcome.');
        results.push({ ...task, elapsedMs: Math.round(performance.now() - start), outcome: result.research.outcome, provider: result.research.provider, warnings: result.research.warnings,
            sources: result.research.sources, officialInFirstFive: task.official ? result.research.sources.some(source => matchesDomains(source.url, task.official)) : undefined });
    } catch (error) {
        results.push({ ...task, elapsedMs: Math.round(performance.now() - start), outcome: 'error', error: error instanceof Error ? error.message : String(error), sources: [] });
    }
    const result = results.at(-1);
    console.log(`${results.length}/${queries.length}: ${result.outcome} ${result.provider ?? 'none'} ${result.elapsedMs} ms`);
}
const times = results.filter(result => result.outcome === 'success').map(result => result.elapsedMs).sort((a, b) => a - b);
const official = results.filter(result => result.official);
const report = { observedAt: new Date().toISOString(), networkScope: 'This machine only; not a regional or model-answer benchmark.', count: results.length,
    successfulRetrievals: results.filter(result => result.outcome === 'success').length,
    officialInFirstFive: official.filter(result => result.officialInFirstFive).length, officialQueries: official.length,
    successfulRetrievalP50Ms: times[Math.ceil(times.length * 0.5) - 1], successfulRetrievalP95Ms: times[Math.ceil(times.length * 0.95) - 1], results };
const output = process.argv[process.argv.indexOf('--output') + 1];
if (process.argv.includes('--output') && output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));

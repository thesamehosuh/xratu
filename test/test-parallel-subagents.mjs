#!/usr/bin/env node
/**
 * Concurrent-subagent resolution tests (`xratu.maxParallelSubagents`).
 *
 * Each `task` call is a full nested agent loop with its own context window,
 * round budget and token spend, so "the model asked for six delegations in
 * one message" used to mean six loops at once with no bound. The cap is a
 * wave size, never a rejection: extra calls start in order as slots free up.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-parallel-subagents.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    resolveParallelSubagents,
    PARALLEL_SUBAGENTS_DEFAULT,
    PARALLEL_SUBAGENTS_MIN,
    PARALLEL_SUBAGENTS_MAX,
} = require('../out/tooling/parallelSubagents.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- defaults ---
check('default is 4 concurrent delegations', PARALLEL_SUBAGENTS_DEFAULT, 4);
check('min is 1', PARALLEL_SUBAGENTS_MIN, 1);
check('max is 8', PARALLEL_SUBAGENTS_MAX, 8);
check('absent setting uses the default', resolveParallelSubagents(undefined), PARALLEL_SUBAGENTS_DEFAULT);
check('null uses the default', resolveParallelSubagents(null), PARALLEL_SUBAGENTS_DEFAULT);
check('empty string uses the default', resolveParallelSubagents('   '), PARALLEL_SUBAGENTS_DEFAULT);
check('zero uses the default (never deadlock a round)', resolveParallelSubagents(0), PARALLEL_SUBAGENTS_DEFAULT);
check('negative uses the default', resolveParallelSubagents(-3), PARALLEL_SUBAGENTS_DEFAULT);
check('garbage uses the default', resolveParallelSubagents({ nope: 1 }), PARALLEL_SUBAGENTS_DEFAULT);
check('NaN uses the default', resolveParallelSubagents(Number.NaN), PARALLEL_SUBAGENTS_DEFAULT);
check('Infinity uses the default', resolveParallelSubagents(Number.POSITIVE_INFINITY), PARALLEL_SUBAGENTS_DEFAULT);

// --- explicit values ---
check('a positive number is honored', resolveParallelSubagents(2), 2);
check('a numeric string is honored (settings.json)', resolveParallelSubagents('6'), 6);
check('a fraction floors', resolveParallelSubagents(3.9), 3);
check('below the floor clamps up', resolveParallelSubagents(0.5), 1);
check('above the ceiling clamps down', resolveParallelSubagents(50), PARALLEL_SUBAGENTS_MAX);
check('the ceiling itself passes through', resolveParallelSubagents(8), 8);

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
#!/usr/bin/env node
/**
 * Consolidated runtime policy resolver tests:
 *  - `src/tooling/agentRounds.ts` (`xratu.maxAgentRounds`)
 *  - `src/tooling/compactionPolicy.ts` (`xratu.autoCompactThreshold`)
 *  - `src/tooling/parallelSubagents.ts` (`xratu.maxParallelSubagents`)
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-tooling-policies.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    resolveAgentRounds,
    AGENT_ROUNDS_UNLIMITED,
    AGENT_ROUNDS_DEFAULT,
    AGENT_ROUNDS_MIN,
} = require('../out/tooling/agentRounds.js');
const {
    resolveCompactRatio,
    COMPACT_RATIO_DEFAULT,
    COMPACT_RATIO_MIN,
    COMPACT_RATIO_MAX,
} = require('../out/tooling/compactionPolicy.js');
const {
    resolveParallelSubagents,
    PARALLEL_SUBAGENTS_DEFAULT,
    PARALLEL_SUBAGENTS_MIN,
    PARALLEL_SUBAGENTS_MAX,
} = require('../out/tooling/parallelSubagents.js');

// --- Agent round budget ----------------------------------------------------
assert.equal(AGENT_ROUNDS_UNLIMITED, Infinity);
assert.equal(AGENT_ROUNDS_DEFAULT, Infinity);
assert.equal(AGENT_ROUNDS_MIN, 1);

for (const bad of [undefined, null, '', '   ', 'abc', NaN, {}, [], true, false, () => {}, 0, -1, -1000, '0', Infinity, -Infinity]) {
    assert.equal(resolveAgentRounds(bad), AGENT_ROUNDS_UNLIMITED);
}
for (const n of [1, 2, 25, 32, 40, 100, 1000, 1e9]) {
    assert.equal(resolveAgentRounds(n), n);
}
assert.equal(resolveAgentRounds('40'), 40);
assert.equal(resolveAgentRounds(' 40 '), 40);
assert.equal(resolveAgentRounds(2.9), 2);
assert.equal(resolveAgentRounds(0.4), AGENT_ROUNDS_MIN);
for (const hostile of [Symbol('s'), 10n]) {
    const out = resolveAgentRounds(hostile);
    assert.equal(out, AGENT_ROUNDS_UNLIMITED);
}

// --- Auto-compaction ratio -------------------------------------------------
assert.equal(COMPACT_RATIO_DEFAULT, 0.9);
assert.ok(COMPACT_RATIO_MIN >= 0.5 && COMPACT_RATIO_MIN < COMPACT_RATIO_DEFAULT && COMPACT_RATIO_DEFAULT < COMPACT_RATIO_MAX && COMPACT_RATIO_MAX < 1);

for (const bad of [undefined, null, '', '   ', 'abc', NaN, {}, [], true, false, () => {}, 0, -5, Infinity, -Infinity, Symbol('s'), 10n]) {
    assert.equal(resolveCompactRatio(bad), COMPACT_RATIO_DEFAULT);
}
assert.equal(resolveCompactRatio(90), 0.9);
assert.equal(resolveCompactRatio(0.9), 0.9);
assert.equal(resolveCompactRatio('90'), 0.9);
assert.equal(resolveCompactRatio('0.9'), 0.9);
assert.equal(resolveCompactRatio(80), 0.8);
assert.equal(resolveCompactRatio(75), 0.75);
assert.equal(resolveCompactRatio(100), COMPACT_RATIO_MAX);
assert.equal(resolveCompactRatio(99), COMPACT_RATIO_MAX);
assert.equal(resolveCompactRatio(10), COMPACT_RATIO_MIN);
assert.equal(resolveCompactRatio(1), COMPACT_RATIO_MIN);
assert.equal(resolveCompactRatio(0.01), COMPACT_RATIO_MIN);
assert.ok(resolveCompactRatio(95) > resolveCompactRatio(80));

// --- Parallel subagent wave size ------------------------------------------
assert.equal(PARALLEL_SUBAGENTS_DEFAULT, 4);
assert.equal(PARALLEL_SUBAGENTS_MIN, 1);
assert.equal(PARALLEL_SUBAGENTS_MAX, 8);
for (const bad of [undefined, null, '   ', 0, -3, { nope: 1 }, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveParallelSubagents(bad), PARALLEL_SUBAGENTS_DEFAULT);
}
assert.equal(resolveParallelSubagents(2), 2);
assert.equal(resolveParallelSubagents('6'), 6);
assert.equal(resolveParallelSubagents(3.9), 3);
assert.equal(resolveParallelSubagents(0.5), 1);
assert.equal(resolveParallelSubagents(50), PARALLEL_SUBAGENTS_MAX);
assert.equal(resolveParallelSubagents(8), 8);

console.log('tooling-policies: all assertions passed');

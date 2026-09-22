#!/usr/bin/env node
/**
 * Agent round-budget resolution tests.
 *
 * Regression: the budget was unconfigurable in a way that made long workflows
 * impossible. extension.ts passed a hardcoded `maxRounds: 25` and the runtime
 * clamped it with `Math.min(..., 32)` - so there was no setting to raise, and
 * the clamp would have silently discarded one. Long tasks were cut off
 * mid-work by the wrap-up nudge.
 *
 * The budget now defaults to UNLIMITED (the loop's real stop is the model
 * returning no tool calls; the post-loop wrap-up is only reachable when a
 * COUNT ran out, so it never fires uncapped). A finite cap is opt-in.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-agent-rounds.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    resolveAgentRounds,
    AGENT_ROUNDS_UNLIMITED,
    AGENT_ROUNDS_DEFAULT,
    AGENT_ROUNDS_MIN,
} = require('../out/tooling/agentRounds.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

/** A usable result: a positive whole number of rounds, or the unlimited sentinel. */
const isUsable = (v) => typeof v === 'number' && v > 0 && (Number.isInteger(v) || v === AGENT_ROUNDS_UNLIMITED);
const UNLIMITED = AGENT_ROUNDS_UNLIMITED;

// --- the default must be no cap at all -------------------------------------
check('unlimited sentinel is Infinity', UNLIMITED, Infinity);
check('THE change: default is unlimited', AGENT_ROUNDS_DEFAULT, Infinity);
check('default is not a finite count', Number.isFinite(AGENT_ROUNDS_DEFAULT), false);
check('smallest finite cap is 1', AGENT_ROUNDS_MIN, 1);

// --- no usable value anywhere -> unlimited ---------------------------------
for (const bad of [undefined, null, '', '   ', 'abc', 'twelve', NaN, {}, [], true, false, () => {}]) {
    const shown = typeof bad === 'function' ? 'a function' : JSON.stringify(bad) ?? String(bad);
    check(`unlimited for ${shown}`, resolveAgentRounds(bad), UNLIMITED);
}

// --- 0 / negative are the documented "no limit" spellings ------------------
check('0 means no limit', resolveAgentRounds(0), UNLIMITED);
check('-1 means no limit', resolveAgentRounds(-1), UNLIMITED);
check('-1000 means no limit', resolveAgentRounds(-1000), UNLIMITED);
check("string '0' means no limit", resolveAgentRounds('0'), UNLIMITED);
check('Infinity -> unlimited', resolveAgentRounds(Infinity), UNLIMITED);
check('-Infinity -> unlimited', resolveAgentRounds(-Infinity), UNLIMITED);

// --- an explicit finite cap is honored EXACTLY (no hidden clamp) -----------
for (const n of [1, 2, 12, 25, 26, 32, 33, 40, 100, 250, 1000, 5000]) {
    check(`honors a cap of ${n}`, resolveAgentRounds(n), n);
}
check('a huge cap is honored, not clamped', resolveAgentRounds(1e9), 1e9);
check("numeric string cap '40'", resolveAgentRounds('40'), 40);
check('padded numeric string cap', resolveAgentRounds(' 40 '), 40);

// --- fractions floor to a whole round count --------------------------------
check('2.9 floors to 2', resolveAgentRounds(2.9), 2);
check('25.99 floors to 25', resolveAgentRounds(25.99), 25);
check('0.4 floors up to the minimum', resolveAgentRounds(0.4), AGENT_ROUNDS_MIN);

// --- result is always usable, and it never throws -------------------------
const inputs = [undefined, null, NaN, Infinity, -Infinity, 'x', '', {}, [], 0, -1, 1e9, 2.7, true, Symbol('s'), 10n];
for (const raw of inputs) {
    let threw = false;
    let result = null;
    try {
        result = resolveAgentRounds(raw);
    } catch {
        threw = true;
    }
    ok(`never throws on ${String(raw)}`, !threw);
    ok(`usable result for ${String(raw)}`, isUsable(result), String(result));
}

// --- the loop's termination contract ---------------------------------------
{
    // `for (round = 0; round < rounds; round++)` must not terminate on its own
    // when uncapped - the model's final answer is what ends the turn.
    const rounds = resolveAgentRounds(undefined);
    let iterations = 0;
    for (let round = 0; round < rounds && iterations < 10000; round++) iterations++;
    check('uncapped loop does not self-terminate', iterations, 10000);
}
{
    // ...and a finite cap still stops exactly on time (wrap-up path reachable).
    const rounds = resolveAgentRounds(3);
    let iterations = 0;
    for (let round = 0; round < rounds; round++) iterations++;
    check('finite cap stops at the cap', iterations, 3);
}

console.log(failed === 0 ? '\nagent-rounds tests: all passed' : `\nagent-rounds tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Compaction-policy tests for src/tooling/compactionPolicy.ts.
 *
 * The compaction threshold used to be a hardcoded constant (0.9). Every
 * comparable harness treats it as policy instead - Cline's spec says the
 * auto-compact threshold "MUST be user-configurable" - and the tradeoff runs
 * both ways: compacting early costs cache hits and a summarizer call,
 * compacting late risks the provider rejecting a request mid-turn.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-compaction-policy.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    resolveCompactRatio,
    COMPACT_RATIO_DEFAULT,
    COMPACT_RATIO_MIN,
    COMPACT_RATIO_MAX,
} = require('../out/tooling/compactionPolicy.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

// --- the default must not change existing behaviour ------------------------
check('default matches the previous constant', COMPACT_RATIO_DEFAULT, 0.9);
ok('bounds are sane', COMPACT_RATIO_MIN < COMPACT_RATIO_DEFAULT && COMPACT_RATIO_DEFAULT < COMPACT_RATIO_MAX);
ok('min never compacts before half-full', COMPACT_RATIO_MIN >= 0.5);
ok('max always leaves headroom', COMPACT_RATIO_MAX < 1);

// --- unusable input falls back rather than throwing ------------------------
for (const bad of [undefined, null, '', '   ', 'abc', NaN, {}, [], true, false, () => {}]) {
    const shown = typeof bad === 'function' ? 'a function' : JSON.stringify(bad) ?? String(bad);
    check(`default for ${shown}`, resolveCompactRatio(bad), COMPACT_RATIO_DEFAULT);
}
check('0 falls back to the default', resolveCompactRatio(0), COMPACT_RATIO_DEFAULT);
check('negative falls back to the default', resolveCompactRatio(-5), COMPACT_RATIO_DEFAULT);
check('Infinity falls back to the default', resolveCompactRatio(Infinity), COMPACT_RATIO_DEFAULT);

// --- percentages and fractions mean the same thing -------------------------
// The setting is presented as a percent (readable), the runtime wants a ratio.
check('90 (percent) -> 0.9', resolveCompactRatio(90), 0.9);
check('0.9 (fraction) -> 0.9', resolveCompactRatio(0.9), 0.9);
check("'90' (string percent) -> 0.9", resolveCompactRatio('90'), 0.9);
check("'0.9' (string fraction) -> 0.9", resolveCompactRatio('0.9'), 0.9);
check('80 (percent) -> 0.8 (Cline default)', resolveCompactRatio(80), 0.8);
check('75 (percent) -> 0.75', resolveCompactRatio(75), 0.75);

// --- clamping, not rejection ----------------------------------------------
// A user who types 100 should get the safest legal value, not silence.
check('100 clamps to the max, not 1.0', resolveCompactRatio(100), COMPACT_RATIO_MAX);
check('99 clamps to the max', resolveCompactRatio(99), COMPACT_RATIO_MAX);
check('10 clamps up to the min', resolveCompactRatio(10), COMPACT_RATIO_MIN);
check('1 (percent) clamps up to the min', resolveCompactRatio(1), COMPACT_RATIO_MIN);
check('0.01 clamps up to the min', resolveCompactRatio(0.01), COMPACT_RATIO_MIN);

// --- the result is always usable and never throws -------------------------
const inputs = [undefined, null, NaN, Infinity, -Infinity, 'x', '', {}, [], 0, -1, 1e9, 90, 0.9, true, Symbol('s'), 10n];
let bad = 0;
for (const raw of inputs) {
    let threw = false;
    let ratio = null;
    try {
        ratio = resolveCompactRatio(raw);
    } catch {
        threw = true;
    }
    if (threw || typeof ratio !== 'number' || !Number.isFinite(ratio)
        || ratio < COMPACT_RATIO_MIN || ratio > COMPACT_RATIO_MAX) bad++;
}
check('never throws and always lands in range', bad, 0);

// --- a fixed value round-trips through the compact gate -------------------
// The ratio drives `total < windowTokens * ratio`, so a bigger ratio must
// mean LATER compaction. Pins the direction of the setting.
{
    const window = 100_000;
    const used = 85_000;
    ok('at 85% fill a 0.8 threshold fires', used >= window * resolveCompactRatio(80));
    ok('at 85% fill a 0.9 threshold does not fire', !(used >= window * resolveCompactRatio(90)));
    ok('a higher threshold compacts later', resolveCompactRatio(95) > resolveCompactRatio(80));
}

console.log(failed === 0 ? '\nall compaction-policy checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

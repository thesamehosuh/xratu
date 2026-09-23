#!/usr/bin/env node
/**
 * In-memory history bound tests for src/local/historyBounds.ts.
 *
 * Covers the caps that keep the MODEL ledger (`_localHistory`) from growing for
 * the life of a session:
 *  - clipHistoryContent keeps both ends, never exceeds the cap, and is
 *    idempotent.
 *  - countUserRows counts turn boundaries (steers included).
 *  - keepLastUserTurns lands exactly on a user-row boundary, never mid-turn.
 *  - evictOldestTurns reports how many turns it dropped.
 *  - Leading non-user rows (a summary marker) are never split off on their own.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-history-bounds.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    IN_MEMORY_CONTENT_CAP,
    MAX_CONTENT_CAP,
    contentCapForWindow,
    MAX_IN_MEMORY_TURNS,
    MAX_STORED_TURNS,
    clipHistoryContent,
    clipJsonValue,
    clipToolCallArguments,
    countUserRows,
    keepLastUserTurns,
    evictOldestTurns,
    skipLeadingUserTurns,
} = require('../out/local/historyBounds.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);
const checkFalse = (name, actual) => check(name, !!actual, false);

// --- caps are sane constants ---
checkTrue('content cap is positive', IN_MEMORY_CONTENT_CAP > 0);
checkTrue('in-memory turn cap exceeds persisted turn cap', MAX_IN_MEMORY_TURNS > MAX_STORED_TURNS);

// --- clipHistoryContent ---
check('under cap is unchanged', clipHistoryContent('hello', 10), 'hello');
check('exactly at cap is unchanged', clipHistoryContent('x'.repeat(10), 10), 'x'.repeat(10));
const clipped = clipHistoryContent('A'.repeat(500) + 'Z'.repeat(500), 400);
checkTrue('over cap carries the marker', clipped.includes('[...clipped 640 chars...]'));
checkTrue('over cap keeps the head', clipped.startsWith('A'));
checkTrue('over cap keeps the tail', clipped.endsWith('Z'));
check('result never exceeds the cap', clipped.length <= 400, true);
check('clip is idempotent', clipHistoryContent(clipped, 400), clipped);
check('tiny cap falls back to a plain prefix', clipHistoryContent('abcdef', 3), 'abc');
check('default cap applies', clipHistoryContent('y'.repeat(IN_MEMORY_CONTENT_CAP + 5)) !== 'y'.repeat(IN_MEMORY_CONTENT_CAP + 5), true);

// --- fixtures: [u, a+tools, u, a, u, a] = 3 turns ---
const turn = (label) => ([
    { role: 'user', content: label },
    { role: 'assistant', content: `${label}-a` },
    { role: 'tool', content: `${label}-t` },
]);
const rows = [...turn('t1'), ...turn('t2'), ...turn('t3')];

check('countUserRows counts turns', countUserRows(rows), 3);
check('countUserRows ignores non-user rows', countUserRows([{ role: 'assistant' }, { role: 'tool' }]), 0);

// --- keepLastUserTurns ---
const last2 = keepLastUserTurns(rows, 2);
check('keep 2 turns keeps 2 user rows', countUserRows(last2), 2);
check('keep 2 turns starts at the boundary user row', last2[0].content, 't2');
check('keep 2 turns drops the oldest turn entirely', last2.some((r) => r.content === 't1'), false);
check('keep 2 turns keeps the tail intact', last2[last2.length - 1].content, 't3-t');
check('keep more than present is a no-op copy', keepLastUserTurns(rows, 99).length, rows.length);
check('keep zero is empty', keepLastUserTurns(rows, 0).length, 0);
check('keep negative is empty', keepLastUserTurns(rows, -1).length, 0);

// A leading non-user row must not be carried in on its own.
const withLeadingNonUser = [{ role: 'assistant', content: 'stale' }, ...turn('t1'), ...turn('t2')];
const markerKept = keepLastUserTurns(withLeadingNonUser, 1);
check('keep 1 starts at the last user row', markerKept[0].content, 't2');
check('keep 1 does not orphan the leading non-user row', markerKept.some((r) => r.content === 'stale'), false);

// --- evictOldestTurns ---
const under = evictOldestTurns(rows, 5);
check('under cap evicts nothing', under.evicted, 0);
check('under cap keeps every row', under.rows.length, rows.length);

const over = evictOldestTurns(rows, 2);
check('over cap evicts the difference', over.evicted, 1);
check('over cap keeps the requested turns', countUserRows(over.rows), 2);
check('over cap starts at the kept boundary', over.rows[0].content, 't2');

const zero = evictOldestTurns(rows, 0);
check('zero cap evicts nothing (guarded)', zero.evicted, 0);

check('eviction does not mutate the source array', rows.length, 9);

// --- clipToolCallArguments: bounded, and always valid JSON (the model ledger
// is replayed to a provider that rejects malformed `function.arguments`) ---
const parseOk = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

check('small args untouched', clipToolCallArguments('{"path":"a.ts"}', 100), '{"path":"a.ts"}');
const bigArgs = JSON.stringify({ path: 'a.ts', new_content: 'X'.repeat(2000) });
const clippedArgs = clipToolCallArguments(bigArgs, 400);
checkTrue('big args stay valid JSON', parseOk(clippedArgs));
checkTrue('big args are bounded', clippedArgs.length <= 400);
checkTrue('big args keep the shape', typeof JSON.parse(clippedArgs).path === 'string');
checkTrue('big args clip the large leaf', JSON.parse(clippedArgs).new_content.length < 2000);
checkTrue('big args keep a marker', clippedArgs.includes('clipped'));

const nestedArgs = JSON.stringify({ outer: { inner: 'Y'.repeat(1000) }, list: ['Z'.repeat(1000)] });
const clippedNested = clipToolCallArguments(nestedArgs, 400);
checkTrue('nested args stay valid JSON', parseOk(clippedNested));
checkTrue('nested args are bounded', clippedNested.length <= 400);
checkTrue('nested object shape preserved', typeof JSON.parse(clippedNested).outer === 'object');
checkTrue('nested array shape preserved', Array.isArray(JSON.parse(clippedNested).list));

check('malformed oversized args -> placeholder', clipToolCallArguments('{not json', 5), '{"_truncated":"arguments omitted to bound memory"}');
checkTrue('placeholder is valid JSON', parseOk(clipToolCallArguments('{not json', 5)));

// --- clipJsonValue: recursive, shape-preserving ---
const shape = clipJsonValue({ a: 'x'.repeat(1000), b: [1, 2, { c: 'y'.repeat(1000) }] }, 300);
checkTrue('clipJsonValue keeps the object shape', typeof shape.a === 'string' && Array.isArray(shape.b));
checkTrue('clipJsonValue clips nested leaves', shape.b[2].c.length < 1000);
check('clipJsonValue leaves non-strings alone', clipJsonValue({ n: 5, t: true, z: null }, 300).n, 5);

// --- contentCapForWindow: the cap must SCALE with the window ----------------
// Regression: the fixed 40k-char cap (~13k tokens) was applied to every window.
// On a 1M-token window at 11% fill it discarded ~80% of a legitimate 200k-char
// tool result (head+tail clipped, middle gone) while ~935k tokens sat free.
// The user experiences that as unexplained context loss.
checkTrue('ceiling is at least the old floor', MAX_CONTENT_CAP >= IN_MEMORY_CONTENT_CAP);

check('unknown window falls back to the old floor', contentCapForWindow(undefined), IN_MEMORY_CONTENT_CAP);
check('null window falls back to the old floor', contentCapForWindow(null), IN_MEMORY_CONTENT_CAP);
check('NaN window falls back to the old floor', contentCapForWindow(NaN), IN_MEMORY_CONTENT_CAP);
check('tiny window keeps the old floor', contentCapForWindow(4095), IN_MEMORY_CONTENT_CAP);
check('8k window keeps the old floor', contentCapForWindow(8192), IN_MEMORY_CONTENT_CAP);
check('zero window keeps the old floor', contentCapForWindow(0), IN_MEMORY_CONTENT_CAP);

// The property that matters most: never TIGHTER than before, on any window.
let tighter = 0;
for (const w of [undefined, null, NaN, 0, 1, 4096, 8192, 16_384, 32_768, 128_000, 200_000, 1_048_576, 1e9]) {
    if (contentCapForWindow(w) < IN_MEMORY_CONTENT_CAP) tighter++;
}
check('never tighter than the old cap on any window', tighter, 0);

// The regression itself: a 200k-char tool result must survive on a 1M window.
const bigWindowCap = contentCapForWindow(1_048_576);
checkTrue('1M window can hold a 200k-char message', bigWindowCap >= 200_000, `cap=${bigWindowCap}`);
check('1M window cap is bounded by the ceiling', bigWindowCap, MAX_CONTENT_CAP);
checkTrue(
    '200k-char content is NOT clipped at a 1M window',
    clipHistoryContent('x'.repeat(200_000), bigWindowCap).length === 200_000,
);
checkTrue(
    'the same content IS clipped at the old fixed cap (the bug)',
    clipHistoryContent('x'.repeat(200_000), IN_MEMORY_CONTENT_CAP).length <= IN_MEMORY_CONTENT_CAP,
);

// Mid-size windows scale between floor and ceiling.
checkTrue('128k window cap is above the floor', contentCapForWindow(128_000) > IN_MEMORY_CONTENT_CAP);
checkTrue('128k window cap is below the ceiling', contentCapForWindow(128_000) < MAX_CONTENT_CAP);

// Monotonic non-decreasing in the window, and always within bounds.
let last = 0;
let monotonic = true;
let outOfBounds = 0;
for (const w of [4096, 8192, 16_384, 32_768, 65_536, 128_000, 262_144, 524_288, 1_048_576, 2_000_000]) {
    const cap = contentCapForWindow(w);
    if (cap < last) monotonic = false;
    if (cap < IN_MEMORY_CONTENT_CAP || cap > MAX_CONTENT_CAP) outOfBounds++;
    last = cap;
}
checkTrue('cap is monotonic in the window', monotonic);
check('cap always stays within bounds', outOfBounds, 0);

// Never throws, always a usable integer.
let badCap = 0;
for (const w of [undefined, null, NaN, Infinity, -Infinity, -1, 'x', {}, [], 0, 1e9, 2.5, true, 10n]) {
    try {
        const cap = contentCapForWindow(w);
        if (!Number.isInteger(cap) || cap < IN_MEMORY_CONTENT_CAP || cap > MAX_CONTENT_CAP) badCap++;
    } catch {
        badCap++;
    }
}
check('cap resolution never throws or leaves bounds', badCap, 0);

// --- skipLeadingUserTurns: compaction replay boundary ----------------------
// The rows stay in the ledger (rewind/eviction stay aligned); only REPLAY
// starts after the skipped turns, so the model is not re-sent turns the
// rolling summary already covers.
const turnWithId = (id) => ([
    { role: 'user', content: `u${id}` },
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: `t${id}` },
]);
const ledger = [...turnWithId('a'), ...turnWithId('b'), ...turnWithId('c')];

check('skip 0 returns the same rows', skipLeadingUserTurns(ledger, 0), ledger);
check('skip 0 is the identity (same reference)', skipLeadingUserTurns(ledger, 0) === ledger, true);

{
    const out = skipLeadingUserTurns(ledger, 1);
    check('skip 1 starts at the second user turn', out[0].content, 'ub');
    check('skip 1 keeps the remaining rows', out.length, 6);
    checkFalse('skipped turn is gone', out.some((m) => m.content === 'ua'));
    checkTrue('tool row of the kept turn is present', out.some((m) => m.tool_call_id === 'b'));
}
{
    const out = skipLeadingUserTurns(ledger, 2);
    check('skip 2 starts at the third user turn', out[0].content, 'uc');
    check('skip 2 leaves exactly the last turn', out.length, 3);
}
check('skip all returns empty', skipLeadingUserTurns(ledger, 3).length, 0);
check('skip beyond the end returns empty', skipLeadingUserTurns(ledger, 99).length, 0);
check('negative skip replays everything', skipLeadingUserTurns(ledger, -1).length, ledger.length);

// The suffix count (what the snapshot stores) round-trips: replay = total - skip.
{
    const total = countUserRows(ledger);
    for (const skip of [0, 1, 2, 3]) {
        const replayed = skipLeadingUserTurns(ledger, skip);
        check(`replay count matches total-skip (skip=${skip})`, countUserRows(replayed), total - skip);
    }
}

if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall history-bounds checks passed');

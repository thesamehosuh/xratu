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
    MAX_IN_MEMORY_TURNS,
    MAX_STORED_TURNS,
    clipHistoryContent,
    countUserRows,
    keepLastUserTurns,
    evictOldestTurns,
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

if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall history-bounds checks passed');

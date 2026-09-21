#!/usr/bin/env node
/**
 * Usage-ledger tests: parsing, day bucketing, pruning, retroactive repricing,
 * and the append-only store round-trip.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-usage-ledger.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const {
    UsageLedgerStore,
    aggregateByDay,
    dayKey,
    entriesForSession,
    normalizeEntry,
    parseLedger,
    pruneEntries,
    recomputeCosts,
    serializeLedger,
    sumUsage,
    USAGE_MAX_ENTRIES,
} = require('../out/local/usageLedger.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const entry = (over = {}) => ({
    ts: Date.now(),
    sessionId: 's1',
    host: 'api.avalai.ir',
    model: 'gpt-4o',
    input: 100,
    output: 20,
    cached: 0,
    amount: 1,
    currency: 'USD',
    ...over,
});

// --- dayKey / aggregateByDay -------------------------------------------------
const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime(); // 2026-09-21 local noon
check('dayKey is the LOCAL calendar day', dayKey(new Date(2026, 8, 21, 0, 30).getTime()), '2026-09-21');

{
    const today = new Date(2026, 8, 21, 9, 0).getTime();
    const yesterday = new Date(2026, 8, 20, 9, 0).getTime();
    const longAgo = new Date(2026, 5, 1, 9, 0).getTime();
    const days = aggregateByDay([
        entry({ ts: today, input: 10, output: 1, USD: 0, amount: 2, currency: 'USD' }),
        entry({ ts: today, input: 5, output: 1, amount: 3, currency: 'IRT' }),
        entry({ ts: yesterday, input: 7, output: 0, amount: null, currency: null }),
        entry({ ts: longAgo, input: 9999 }),
    ], 3, NOW);

    check('aggregate returns exactly N buckets', days.length, 3);
    check('buckets are oldest -> newest', days.map((d) => d.day), ['2026-09-19', '2026-09-20', '2026-09-21']);
    check('today sums input across entries', days[2].input, 15);
    check('today sums output', days[2].output, 2);
    check('USD and IRT stay in their own buckets', [days[2].USD, days[2].IRT], [2, 3]);
    check('yesterday keeps its own bucket', days[1].input, 7);
    check('empty day stays at zero', [days[0].input, days[0].output], [0, 0]);
    check('entry outside the window is ignored', days.some((d) => d.input === 9999), false);
}

// --- pruneEntries ------------------------------------------------------------
{
    const old = entry({ ts: NOW - 200 * 86_400_000 });
    const fresh = entry({ ts: NOW - 86_400_000 });
    check('drops entries past retention', pruneEntries([old, fresh], NOW).length, 1);
    check('keeps entries inside retention', pruneEntries([fresh], NOW).length, 1);

    const many = Array.from({ length: 12 }, (_, i) => entry({ ts: NOW - i * 1000, input: i }));
    const capped = pruneEntries(many, NOW, 3650, 5);
    check('caps to maxEntries', capped.length, 5);
    check('cap keeps the NEWEST entries', capped[0].input, 7);
}

// --- parse / serialize -------------------------------------------------------
{
    const good = entry();
    const text = `\uFEFF${JSON.stringify(good)}\r\n\r\nnot json\n{"noTs":1}\n${JSON.stringify(entry({ input: 3 }))}\n`;
    const parsed = parseLedger(text);
    check('parse skips BOM, blanks, malformed and ts-less lines', parsed.length, 2);
    check('parse keeps the first good entry', parsed[0].input, 100);
    check('parse keeps later entries', parsed[1].input, 3);

    const roundTrip = parseLedger(serializeLedger([good, entry({ input: 8 })]));
    check('serialize -> parse round-trips', roundTrip.map((e) => e.input), [100, 8]);
    check('serialize of empty ledger is empty', serializeLedger([]), '');
}

// --- normalizeEntry ---------------------------------------------------------
check('normalize drops negative counts', normalizeEntry({ ts: 1, input: -5 }).input, 0);
check('normalize drops NaN counts', normalizeEntry({ ts: 1, output: NaN }).output, 0);
check('normalize drops amount without currency', normalizeEntry({ ts: 1, amount: 5 }).amount, null);
check('normalize drops amount with a bad currency', normalizeEntry({ ts: 1, amount: 5, currency: 'EUR' }).currency, null);
check('normalize keeps a zero amount with a currency', normalizeEntry({ ts: 1, amount: 0, currency: 'USD' }).amount, 0);
check('normalize drops a ts-less row', normalizeEntry({ input: 1 }), null);

// --- sumUsage / entriesForSession -------------------------------------------
{
    const totals = sumUsage([
        entry({ input: 10, output: 2, cached: 1, amount: 1, currency: 'USD' }),
        entry({ input: 5, output: 1, cached: 0, amount: 2, currency: 'IRT' }),
        entry({ amount: null, currency: null }),
    ]);
    check('sumUsage tokens', [totals.input, totals.output, totals.cached], [115, 23, 1]);
    check('sumUsage keeps currencies apart', [totals.USD, totals.IRT], [1, 2]);
    check('entriesForSession filters by session', entriesForSession([entry({ sessionId: 'a' }), entry({ sessionId: 'b' })], 'a').length, 1);
    check('entriesForSession with no id -> []', entriesForSession([entry()], null).length, 0);
}

// --- recomputeCosts (retroactive repricing) ---------------------------------
{
    const entries = [
        entry({ model: 'gpt-4o', amount: 1, currency: 'USD' }),
        entry({ model: 'claude-sonnet-5', amount: 1, currency: 'USD' }),
    ];
    const { entries: next, changed } = recomputeCosts(entries, (e) => ({ amount: 9, currency: 'IRT' }), 'gpt-4o');
    check('recompute reports a change', changed, true);
    check('recompute only touches the named model', [next[0].amount, next[0].currency], [9, 'IRT']);
    check('recompute leaves other models alone', [next[1].amount, next[1].currency], [1, 'USD']);

    const same = recomputeCosts(entries, (e) => ({ amount: e.amount, currency: e.currency }));
    check('recompute with an unchanged price reports no change', same.changed, false);

    const cleared = recomputeCosts(entries, () => null);
    check('recompute can clear an unknown price', cleared.entries[0].amount, null);
    check('clearing counts as a change', cleared.changed, true);
}

// --- store round-trip -------------------------------------------------------
{
    const root = mkdtempSync(join(tmpdir(), 'xratu-usage-'));
    try {
        const store = new UsageLedgerStore(root);
        check('missing ledger reads as []', (await store.read()).length, 0);

        await store.append(entry({ input: 11 }));
        await store.append(entry({ input: 22 }));
        const read = await store.read();
        check('append persists both entries', read.map((e) => e.input), [11, 22]);

        await store.replace([entry({ input: 33 })]);
        check('replace swaps the ledger', (await store.read()).map((e) => e.input), [33]);

        await store.append(entry({ ts: NOW - 400 * 86_400_000, input: 44 }));
        await store.compact();
        check('compact prunes old entries', (await store.read()).map((e) => e.input), [33]);

        await store.append(entry({ input: 55 }));
        check('append after compact still works', (await store.read()).length, 2);

        // update() is a read-modify-write INSIDE the write queue: a plain
        // read()+replace() would drop a round appended in between.
        const updated = await store.update((list) => ({
            entries: list.map((e) => ({ ...e, amount: 7, currency: 'USD' })),
            changed: true,
        }));
        check('update reports a change', updated.changed, true);
        check('update persists the transform', (await store.read()).every((e) => e.amount === 7), true);

        const noop = await store.update((list) => ({ entries: list, changed: false }));
        check('update reports no change', noop.changed, false);
        check('no-change update keeps the ledger', (await store.read()).length, 2);

        await store.update((list) => ({ entries: [...list, entry({ input: 77 })], changed: true }));
        check('update can append atomically', (await store.read()).some((e) => e.input === 77), true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

check('USAGE_MAX_ENTRIES is a sane cap', USAGE_MAX_ENTRIES >= 1000, true);

console.log(failed === 0 ? '\nusage-ledger tests: all passed' : `\nusage-ledger tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

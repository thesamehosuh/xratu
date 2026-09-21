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
    aggregateByDayAndModel,
    dayKey,
    entriesForSession,
    modelHosts,
    normalizeEntry,
    parseLedger,
    pruneEntries,
    recomputeCosts,
    serializeLedger,
    sumUsage,
    totalsByHost,
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

// --- dayKey / aggregateByDayAndModel ----------------------------------------
const NOW = new Date(2026, 8, 21, 12, 0, 0).getTime(); // 2026-09-21 local noon
check('dayKey is the LOCAL calendar day', dayKey(new Date(2026, 8, 21, 0, 30).getTime()), '2026-09-21');

{
    const today = new Date(2026, 8, 21, 9, 0).getTime();
    const yesterday = new Date(2026, 8, 20, 9, 0).getTime();
    const longAgo = new Date(2026, 5, 1, 9, 0).getTime();
    const days = aggregateByDayAndModel([
        entry({ ts: today, model: 'gpt-4o', host: 'a.ir', input: 10, output: 1, amount: 2, currency: 'USD' }),
        entry({ ts: today, model: 'gpt-4o', host: 'a.ir', input: 5, output: 1, amount: 3, currency: 'USD' }),
        entry({ ts: today, model: 'glm-5.3', host: 'a.ir', input: 7, output: 0, amount: null, currency: null }),
        entry({ ts: yesterday, model: 'gpt-4o', host: 'b.ir', input: 9, output: 0, amount: 1, currency: 'IRT' }),
        entry({ ts: longAgo, input: 9999 }),
    ], 3, NOW);

    check('only days with usage are returned', days.map((d) => d.day), ['2026-09-20', '2026-09-21']);
    check('cells are grouped by model+host', days[1].cells.length, 2);
    const gpt = days[1].cells.find((c) => c.model === 'gpt-4o');
    check('same model+host cells merge', [gpt.input, gpt.output], [15, 2]);
    check('merged cell sums its cost', gpt.USD, 5);
    const glm = days[1].cells.find((c) => c.model === 'glm-5.3');
    check('a different model is its own cell', glm.input, 7);
    check('unknown price keeps zero cost', [glm.USD, glm.IRT], [0, 0]);
    check('currencies stay per cell', days[0].cells[0].IRT, 1);
    check('an entry outside the window is dropped', days.some((d) => d.cells.some((c) => c.input === 9999)), false);
    check('days are chronological', days[0].day < days[1].day, true);
}

// --- totalsByHost -----------------------------------------------------------
{
    const hosts = totalsByHost([
        entry({ host: 'a.ir', input: 10, output: 1, cached: 2, amount: 1, currency: 'USD' }),
        entry({ host: 'a.ir', input: 5, output: 1, cached: 0, amount: 2, currency: 'USD' }),
        entry({ host: 'b.ir', input: 40, output: 0, cached: 0, amount: 3, currency: 'IRT' }),
    ]);
    check('busiest host first', hosts.map((h) => h.host), ['b.ir', 'a.ir']);
    const a = hosts.find((h) => h.host === 'a.ir');
    check('host totals sum tokens', [a.input, a.output, a.cached], [15, 2, 2]);
    check('host totals sum its currency', a.USD, 3);
    check('host totals keep currencies apart', [a.IRT, hosts.find((h) => h.host === 'b.ir').USD], [0, 0]);
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

// --- model → hosts (the Usage page's rate sheet lists these pairs) ---
{
    const pairs = modelHosts([
        entry({ model: 'gpt-4o', host: 'a.ir', input: 10, output: 0, amount: 1, currency: 'USD' }),
        entry({ model: 'gpt-4o', host: 'a.ir', input: 5, output: 5, amount: 5000, currency: 'IRT' }),
        entry({ model: 'gpt-4o', host: 'b.ir', input: 1, output: 0 }),
        entry({ model: 'glm-5.3', host: 'b.ir', input: 200, output: 0 }),
        // Entries without a model id carry no rate, so they are dropped.
        entry({ model: '', host: 'b.ir', input: 999, output: 0 }),
    ]);
    check('one row per model+host pair', pairs.length, 3);
    check('busiest pair first', pairs.map((p) => `${p.model}@${p.host}`), [
        'glm-5.3@b.ir',
        'gpt-4o@a.ir',
        'gpt-4o@b.ir',
    ]);
    check('pair tokens are summed across rounds', pairs[1].tokens, 20);
    // Cost is summed per currency and never converted between the two.
    check('pair cost keeps its currency', [pairs[1].USD, pairs[1].IRT], [1, 5000]);
    check('same model on another host is its own pair', modelHosts([entry({ model: 'x', host: '' })]), [
        { model: 'x', host: '', tokens: 120, USD: 1, IRT: 0 },
    ]);
}

console.log(failed === 0 ? '\nusage-ledger tests: all passed' : `\nusage-ledger tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

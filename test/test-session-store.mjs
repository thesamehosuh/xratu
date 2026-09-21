#!/usr/bin/env node
/**
 * LocalSessionStore tests - session title rules.
 *
 * Regression: sessions were never named after their first user message.
 * `_create` seeds the title with the workspace label and `_save` kept
 * `existing?.title`, so the derived name never landed in the index and
 * every session stayed named after the workspace folder. Covers the
 * derivation, the explicit-rename lock (renamed flag), and index
 * reconciliation.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-session-store.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { LocalSessionStore, resolveSessionTitle, renameWithRetry } = require('../out/local/localSessionStore.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const root = mkdtempSync(join(tmpdir(), 'xratu-session-store-'));
const ws = '/tmp/fake-workspace';

try {
    const store = new LocalSessionStore(root);

    // 1. Fresh session: workspace label placeholder.
    const meta = await store.create(ws);
    check('create seeds workspace label', meta.title, 'fake-workspace');
    check('create leaves renamed unset', meta.renamed, undefined);

    // 2. First save with a user turn: title derives from the first user message.
    await store.save(meta.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'hi' }],
        uiHistory: [{ role: 'user', text: 'fix the login bug please' }],
    });
    let listed = await store.list(ws);
    check('title derives from first user message', listed[0].title, 'fix the login bug please');

    // 3. Later saves without a rename keep tracking the FIRST user message.
    await store.save(meta.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'second' }],
        uiHistory: [{ role: 'user', text: 'fix the login bug please' }, { role: 'user', text: 'second turn text' }],
    });
    listed = await store.list(ws);
    check('title stays pinned to first user message', listed[0].title, 'fix the login bug please');

    // 4. Explicit rename locks the title (renamed flag) across later saves.
    await store.rename(meta.id, 'my custom name');
    await store.save(meta.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'third' }],
        uiHistory: [{ role: 'user', text: 'third turn text' }],
    });
    listed = await store.list(ws);
    check('rename wins over derivation', listed[0].title, 'my custom name');

    // 5. reconcile() rebuilds the index from snapshots without losing title/renamed.
    rmSync(join(root, 'sessions', '_index.json'));
    await store.reconcile(ws);
    listed = await store.list(ws);
    check('reconcile keeps renamed title', listed[0].title, 'my custom name');
    check('reconcile restores renamed flag', listed[0].renamed, true);

    const meta2 = await store.create(ws);
    await store.save(meta2.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'hi' }],
        uiHistory: [{ role: 'user', text: 'another conversation' }],
    });
    rmSync(join(root, 'sessions', '_index.json'));
    await store.reconcile(ws);
    listed = await store.list(ws);
    const again = listed.find((m) => m.id === meta2.id);
    check('reconcile keeps derived title', again.title, 'another conversation');
    check('reconcile leaves renamed unset for derived', again.renamed, undefined);

    // 6. Long first message truncates at 48 chars + ellipsis.
    const meta3 = await store.create(ws);
    await store.save(meta3.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'hi' }],
        uiHistory: [{ role: 'user', text: 'x'.repeat(60) }],
    });
    listed = await store.list(ws);
    check('long title truncates to 48+…', listed.find((m) => m.id === meta3.id).title, 'x'.repeat(48) + '…');

    // 7. Emoji at the truncation boundary never splits surrogate pairs.
    const meta4 = await store.create(ws);
    await store.save(meta4.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'hi' }],
        uiHistory: [{ role: 'user', text: '😀'.repeat(50) }],
    });
    listed = await store.list(ws);
    check('truncation respects surrogate pairs', listed.find((m) => m.id === meta4.id).title, '😀'.repeat(48) + '…');

    // 8. load() exposes the renamed flag (host needs it to honor renames
    //    while healing placeholder titles).
    check('load returns renamed flag', (await store.load(meta.id)).renamed, true);
    check('load returns renamed=false for derived', (await store.load(meta2.id)).renamed, false);

    // 9. resolveSessionTitle - the host restore rule. A stored title that is
    //    still the workspace placeholder reads as UNTITLED so the first user
    //    message can name the session; without this the placeholder rode
    //    back into the host on every restore and was locked in as
    //    renamedTitle on the next save (every session stuck on the
    //    workspace name).
    check('placeholder title resolves to null', resolveSessionTitle('fake-workspace', false, ws), null);
    check('placeholder resolves untitled when renamed unset', resolveSessionTitle('fake-workspace', undefined, ws), null);
    check('derived title passes through', resolveSessionTitle('fix the login bug', false, ws), 'fix the login bug');
    check('explicit rename always wins', resolveSessionTitle('fake-workspace', true, ws), 'fake-workspace');
    check('null title stays null', resolveSessionTitle(null, false, ws), null);
    check('missing workspace falls back to default label', resolveSessionTitle('default', false, undefined), null);

    // 10. A first user message that literally reads like the workspace label
    //     is a LEGITIMATE session name: the stored title matches what the
    //     current first message derives to, so it must survive restore
    //     (both reviewers flagged the string-comparison-only rule).
    const meta5 = await store.create(ws);
    await store.save(meta5.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'fake-workspace' }],
        uiHistory: [{ role: 'user', text: 'fake-workspace' }],
    });
    let loaded5 = await store.load(meta5.id);
    check('workspace-like prompt round-trips as a real title',
        resolveSessionTitle(loaded5.title, loaded5.renamed, loaded5.workspace, loaded5.uiHistory), 'fake-workspace');
    // …and a long prompt keeps its truncated derived title across restores.
    const meta6 = await store.create(ws);
    await store.save(meta6.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'y'.repeat(60) }],
        uiHistory: [{ role: 'user', text: 'y'.repeat(60) }],
    });
    let loaded6 = await store.load(meta6.id);
    check('truncated derived title survives restore',
        resolveSessionTitle(loaded6.title, loaded6.renamed, loaded6.workspace, loaded6.uiHistory), 'y'.repeat(48) + '…');
    // A true placeholder (no user turn yet) still resolves to untitled even
    // when history rows exist but carry no user text.
    check('placeholder with non-user history stays untitled',
        resolveSessionTitle('fake-workspace', false, ws, [{ role: 'assistant', text: 'hi' }]), null);

    // 11. The HOST persists uiHistory user rows with `content` (not `text`)
    //     - derivation must read that shape too, or the store-side title
    //     falls back to the workspace label on every real save (round-2
    //     review finding).
    const meta7 = await store.create(ws);
    await store.save(meta7.id, {
        workspace: ws,
        model: null,
        summary: null,
        localHistory: [{ role: 'user', content: 'fix the login bug' }],
        uiHistory: [{ role: 'user', content: 'fix the login bug' }],
    });
    listed = await store.list(ws);
    check('content-shaped user row derives title', listed.find((m) => m.id === meta7.id).title, 'fix the login bug');
    let loaded7 = await store.load(meta7.id);
    check('content-shaped first message survives restore',
        resolveSessionTitle(loaded7.title, loaded7.renamed, loaded7.workspace, loaded7.uiHistory), 'fix the login bug');

    // 12. renameWithRetry: transient Windows locks are retried, non-transient
    //     errors fail fast, and a persistent lock falls back to copy+unlink.
    {
        let calls = 0;
        const flaky = async () => {
            calls++;
            if (calls < 3) { const e = new Error('locked'); e.code = 'EPERM'; throw e; }
        };
        await renameWithRetry('a', 'b', flaky);
        check('renameWithRetry retries transient EPERM', calls, 3);
    }
    {
        let calls = 0;
        const fatal = async () => { calls++; const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
        let threw = false;
        try { await renameWithRetry('a', 'b', fatal); } catch { threw = true; }
        check('renameWithRetry rethrows non-transient immediately', threw && calls === 1, true);
    }
    {
        const dir = mkdtempSync(join(tmpdir(), 'xratu-rename-'));
        const from = join(dir, 'snapshot.json.tmp');
        const to = join(dir, 'snapshot.json');
        writeFileSync(from, 'new data');
        writeFileSync(to, 'old data');
        let attempts = 0;
        const alwaysLocked = async () => { attempts++; const e = new Error('locked'); e.code = 'EBUSY'; throw e; };
        let threw = false;
        try { await renameWithRetry(from, to, alwaysLocked); } catch { threw = true; }
        // No in-place copy fallback: atomicity must survive a persistent lock.
        check('persistent lock throws instead of overwriting', threw, true);
        check('destination untouched on failure', readFileSync(to, 'utf8'), 'old data');
        check('retries every attempt before throwing', attempts, 6);
        rmSync(dir, { recursive: true, force: true });
    }

    // 13. Full-text search across titles and transcripts. `meta7` matches by
    //     title; `meta` (renamed to "my custom name") only via its transcript.
    check('search empty query -> []', (await store.search('')).length, 0);
    const loginHits = (await store.search('login bug')).map((m) => m.id);
    check('search matches title', loginHits.includes(meta7.id), true);
    check('search matches transcript, not just title',
        (await store.search('third turn text')).map((m) => m.id).includes(meta.id), true);
    check('search is case-insensitive', (await store.search('LOGIN BUG')).length, loginHits.length);
    check('search no match -> []', (await store.search('no-such-token-xyz')).length, 0);
    check('search scoped to another workspace -> []', (await store.search('login bug', '/somewhere-else')).length, 0);
    check('search within workspace', (await store.search('login bug', ws)).length, loginHits.length);
    // Metadata fields (role/type/id) must NOT be searchable, or a query like
    // "assistant" would match every session that has an assistant turn.
    const meta8 = await store.create(ws);
    await store.save(meta8.id, {
        workspace: ws, model: null, summary: null, localHistory: [],
        uiHistory: [{ role: 'assistant', type: 'chunk', id: 'evt-1', text: 'hello world' }],
    });
    check('search ignores metadata fields',
        (await store.search('assistant')).some((m) => m.id === meta8.id), false);
    check('search still finds visible text',
        (await store.search('hello world')).some((m) => m.id === meta8.id), true);

    // 14. Cumulative session cost round-trips; a missing value reads as 0.
    {
        const withCost = await store.create(ws);
        await store.save(withCost.id, {
            workspace: ws, model: null, summary: null, localHistory: [], uiHistory: [], totalCostUsd: 1.2345,
        });
        check('totalCostUsd round-trips', (await store.load(withCost.id)).totalCostUsd, 1.2345);
        const withoutCost = await store.create(ws);
        await store.save(withoutCost.id, {
            workspace: ws, model: null, summary: null, localHistory: [], uiHistory: [],
        });
        check('missing totalCostUsd defaults to 0', (await store.load(withoutCost.id)).totalCostUsd, 0);
    }

    // 15. Session token ledger + per-host usage round-trip.
    {
        const withUsage = await store.create(ws);
        await store.save(withUsage.id, {
            workspace: ws, model: null, summary: null, localHistory: [], uiHistory: [],
            totalInputTokens: 12000, totalOutputTokens: 3400, totalCachedTokens: 800,
            usageByHost: { 'api.avalai.ir': { input: 12000, output: 3400, cached: 800 } },
        });
        const loaded = await store.load(withUsage.id);
        check('totalInputTokens round-trips', loaded.totalInputTokens, 12000);
        check('totalOutputTokens round-trips', loaded.totalOutputTokens, 3400);
        check('totalCachedTokens round-trips', loaded.totalCachedTokens, 800);
        check('usageByHost round-trips', loaded.usageByHost['api.avalai.ir'].output, 3400);

        const withoutUsage = await store.create(ws);
        await store.save(withoutUsage.id, {
            workspace: ws, model: null, summary: null, localHistory: [], uiHistory: [],
        });
        const empty = await store.load(withoutUsage.id);
        check('missing token totals default to 0', empty.totalInputTokens, 0);
        check('missing usageByHost defaults to {}', Object.keys(empty.usageByHost).length, 0);
    }

    // 16. Model-ledger eviction: the display ledger keeps turns the model
    // ledger dropped, and the offset (display turns - model turns) is derivable
    // after a reload so rewind stays aligned.
    {
        const evicted = await store.create(ws);
        const localHistory = [
            { role: 'user', content: 'l3' },
            { role: 'assistant', content: 'a3' },
            { role: 'user', content: 'l4' },
            { role: 'assistant', content: 'a4' },
        ];
        const uiHistory = [
            { role: 'user', content: 'u1' },
            { role: 'assistant', content: 'x1' },
            { role: 'user', content: 'u2' },
            { role: 'assistant', content: 'x2' },
            { role: 'user', content: 'u3' },
            { role: 'assistant', content: 'x3' },
            { role: 'user', content: 'u4' },
            { role: 'assistant', content: 'x4' },
        ];
        await store.save(evicted.id, {
            workspace: ws, model: null, summary: null, localHistory, uiHistory,
        });
        const loaded = await store.load(evicted.id);
        const uiTurns = loaded.uiHistory.filter((m) => m.role === 'user').length;
        const localTurns = loaded.localHistory.filter((m) => m.role === 'user').length;
        check('display ledger keeps every turn', uiTurns, 4);
        check('model ledger keeps its own turns', localTurns, 2);
        check('derived offset = display turns - model turns', uiTurns - localTurns, 2);
        check('display tail is the newest turn', loaded.uiHistory[loaded.uiHistory.length - 2].content, 'u4');
        check('model tail is the newest turn', loaded.localHistory[loaded.localHistory.length - 2].content, 'l4');
    }

    // 17. Turn-aligned trim: both ledgers are cut at the SAME user turn, not
    // independently by row count (they have different rows-per-turn).
    {
        const many = await store.create(ws);
        const { MAX_STORED_TURNS } = require('../out/local/historyBounds.js');
        const total = MAX_STORED_TURNS + 10;
        const localHistory = [];
        const uiHistory = [];
        for (let i = 0; i < total; i++) {
            // The model ledger carries an extra tool row per turn.
            localHistory.push({ role: 'user', content: `l${i}` }, { role: 'assistant', content: `a${i}` }, { role: 'tool', content: `t${i}` });
            uiHistory.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: `x${i}` });
        }
        await store.save(many.id, { workspace: ws, model: null, summary: null, localHistory, uiHistory });
        const loaded = await store.load(many.id);
        const uiTurns = loaded.uiHistory.filter((m) => m.role === 'user').length;
        const localTurns = loaded.localHistory.filter((m) => m.role === 'user').length;
        check('display trim caps at MAX_STORED_TURNS', uiTurns, MAX_STORED_TURNS);
        check('model trim lands on the same boundary', localTurns, MAX_STORED_TURNS);
        check('both ledgers start at the same turn', loaded.uiHistory[0].content, `u${total - MAX_STORED_TURNS}`);
        check('both ledgers start at the same turn (model)', loaded.localHistory[0].content, `l${total - MAX_STORED_TURNS}`);
    }

    // 18. A malformed snapshot whose model ledger has MORE turns than the
    // display ledger is repaired to a consistent boundary on save.
    {
        const bad = await store.create(ws);
        await store.save(bad.id, {
            workspace: ws, model: null, summary: null,
            localHistory: [{ role: 'user', content: 'l1' }, { role: 'user', content: 'l2' }, { role: 'user', content: 'l3' }],
            uiHistory: [{ role: 'user', content: 'only' }],
        });
        const loaded = await store.load(bad.id);
        const uiTurns = loaded.uiHistory.filter((m) => m.role === 'user').length;
        const localTurns = loaded.localHistory.filter((m) => m.role === 'user').length;
        check('model ledger repaired to the display boundary', localTurns, uiTurns);
        check('derived offset is zero when aligned', uiTurns - localTurns, 0);
    }
    // 19. pendingTurn nested tool-call args are bounded and stay valid JSON
    // (a top-level-only clip let nested strings bypass the persisted limit).
    {
        const pt = await store.create(ws);
        await store.save(pt.id, {
            workspace: ws, model: null, summary: null, localHistory: [], uiHistory: [],
            pendingTurn: {
                prompt: 'p', text: '', thinking: '',
                events: [{
                    type: 'tool_call', id: 'c1', tool: 'edit_file',
                    args: { patch: 'P'.repeat(30_000), nested: { deep: 'D'.repeat(30_000) } },
                }],
            },
        });
        const loaded = await store.load(pt.id);
        const serialized = JSON.stringify(loaded.pendingTurn.events[0].args);
        check('pendingTurn args bounded', serialized.length <= 20_000, true);
        check('pendingTurn args valid JSON', (() => { try { JSON.parse(serialized); return true; } catch { return false; } })(), true);
    }
} finally {
    rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
}
console.log('\nsession-store tests: all passed');

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
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
const { LocalSessionStore, resolveSessionTitle } = require('../out/local/localSessionStore.js');

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
} finally {
    rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
}
console.log('\nsession-store tests: all passed');

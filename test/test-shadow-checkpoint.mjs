#!/usr/bin/env node
/**
 * Shadow-checkpoint restore tests.
 *
 * Regression: `restoreCheckpoint` treated "no tracked diff" as "workspace
 * already matches" - but files CREATED after the last snapshot are
 * untracked and invisible to `git diff --quiet`, so a restore silently
 * did nothing and the agent's new files survived. The no-op path must
 * also count untracked (non-ignored) files.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-shadow-checkpoint.mjs
 */
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { ShadowCheckpointStore, EmptySeedError } = require('../out/shadowGit.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

// Fake the vscode.ExtensionContext surface the store touches.
const storageRoot = mkdtempSync(join(tmpdir(), 'xratu-cp-store-'));
const store = new ShadowCheckpointStore({ globalStorageUri: { fsPath: storageRoot } });

const work = mkdtempSync(join(tmpdir(), 'xratu-cp-work-'));

try {
    // --- baseline checkpoint: one tracked file ---
    writeFileSync(join(work, 'a.txt'), 'one\n');
    const sha1 = await store.createCheckpoint(work, 'baseline');
    ok('baseline checkpoint returned a sha', /^[0-9a-f]{6,}$/.test(sha1), sha1);

    // --- restore no-op: nothing changed ---
    const noop = await store.restoreCheckpoint(work, sha1);
    ok('clean restore is a no-op', noop.changed === false, JSON.stringify(noop));

    // --- THE regression: agent only CREATED files (untracked) ---
    writeFileSync(join(work, 'created.txt'), 'new\n');
    mkdirSync(join(work, 'sub'));
    writeFileSync(join(work, 'sub', 'nested.txt'), 'nested\n');
    const r1 = await store.restoreCheckpoint(work, sha1);
    ok('untracked-only restore reports changed', r1.changed === true, JSON.stringify(r1));
    ok('untracked file removed', !existsSync(join(work, 'created.txt')));
    ok('untracked nested file removed', !existsSync(join(work, 'sub', 'nested.txt')));
    ok('tracked file intact', readFileSync(join(work, 'a.txt'), 'utf-8') === 'one\n');

    // --- modified tracked file reverts ---
    writeFileSync(join(work, 'a.txt'), 'two\n');
    const r2 = await store.restoreCheckpoint(work, sha1);
    ok('tracked edit restore reports changed', r2.changed === true, JSON.stringify(r2));
    ok('tracked file reverted', readFileSync(join(work, 'a.txt'), 'utf-8') === 'one\n');

    // --- mixed: created + modified both handled ---
    writeFileSync(join(work, 'a.txt'), 'three\n');
    writeFileSync(join(work, 'b.txt'), 'b\n');
    const r3 = await store.restoreCheckpoint(work, sha1);
    ok('mixed restore reports changed', r3.changed === true, JSON.stringify(r3));
    ok('created file removed (mixed)', !existsSync(join(work, 'b.txt')));
    ok('modified file reverted (mixed)', readFileSync(join(work, 'a.txt'), 'utf-8') === 'one\n');

    // --- ignored files survive a restore (files-only restore contract) ---
    writeFileSync(join(work, '.gitignore'), 'junk/\n');
    const shaG = await store.createCheckpoint(work, 'with ignore');
    mkdirSync(join(work, 'junk'));
    writeFileSync(join(work, 'junk', 'cache.bin'), 'x');
    await store.restoreCheckpoint(work, shaG);
    ok('ignored file survives restore', existsSync(join(work, 'junk', 'cache.bin')));

    // --- safety snapshot is itself restorable ---
    writeFileSync(join(work, 'a.txt'), 'four\n');
    const r4 = await store.restoreCheckpoint(work, shaG);
    ok('post-ignore restore changed', r4.changed === true, JSON.stringify(r4));
    ok('safety shas differ per restore', r4.safety && r4.safety !== r4.sha);
    const safetyRestore = await store.restoreCheckpoint(work, r4.safety);
    ok('safety snapshot restores', safetyRestore.changed === true, JSON.stringify(safetyRestore));
    ok('safety snapshot recovers pre-restore content',
        readFileSync(join(work, 'a.txt'), 'utf-8') === 'four\n');

    // --- unknown sha rejected ---
    let threw = false;
    try {
        await store.restoreCheckpoint(work, 'deadbeefdeadbeef');
    } catch {
        threw = true;
    }
    ok('unknown sha throws', threw);

    // --- empty seed refused ---
    const seedWork = mkdtempSync(join(tmpdir(), 'xratu-cp-seed-'));
    try {
        // Initializing the store against an empty workspace seeds the empty
        // root commit; restoring to it must throw EmptySeedError.
        await store.createCheckpoint(seedWork, 'seed');
        await store.restoreCheckpoint(seedWork, 'HEAD');
        ok('empty seed restore refuses', false, 'no throw');
    } catch (e) {
        ok('empty seed restore refuses', e instanceof EmptySeedError, String(e));
    } finally {
        rmSync(seedWork, { recursive: true, force: true });
    }
} finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll checkpoint restore tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

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
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync,
    renameSync, utimesSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

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

    // --- a RENAME is undone, not left duplicated ---
    // Regression: the delete tail filtered with `--diff-filter=A`, but
    // `diff.renames` defaults to true, so a rename between the two trees was
    // reported as a single `R` entry whose destination is not `A`. The filter
    // dropped it, the tail deleted nothing, and the file survived at BOTH the
    // old and the new path while the restore reported success.
    writeFileSync(join(work, 'keep.txt'), 'keep\n');
    const shaRename = await store.createCheckpoint(work, 'before rename');
    renameSync(join(work, 'a.txt'), join(work, 'renamed.txt'));
    ok('rename applied', existsSync(join(work, 'renamed.txt')) && !existsSync(join(work, 'a.txt')));
    const rr = await store.restoreCheckpoint(work, shaRename);
    ok('rename restore reports changed', rr.changed === true, JSON.stringify(rr));
    ok('rename: original path restored', existsSync(join(work, 'a.txt')));
    ok('rename: duplicate at the new path removed', !existsSync(join(work, 'renamed.txt')),
        'file survived at BOTH paths');

    // --- stale ref locks do not brick the store ---
    // Regression: only `index.lock` was ever cleared. A `git commit` killed by
    // the 20s timeout (on Windows TerminateProcess gives git no cleanup chance)
    // leaves `refs/heads/<branch>.lock`, and NOTHING removed it - so every
    // later checkpoint and every restore failed forever, silently, because
    // ensureTurnSnapshot only console.errored.
    const shadowDir = join(storageRoot, 'checkpoints',
        createHash('sha1').update(work).digest('hex').slice(0, 16));
    for (const lockRel of [
        join('refs', 'heads', 'master.lock'),
        join('refs', 'heads', 'main.lock'),
        join('HEAD.lock'),
        'index.lock',
    ]) {
        const lockPath = join(shadowDir, lockRel);
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, '');
        // Backdate past the 60s staleness heuristic.
        const old = new Date(Date.now() - 600_000);
        utimesSync(lockPath, old, old);
    }
    writeFileSync(join(work, 'after-lock.txt'), 'changed\n');
    let lockRecovered = false;
    let lockErr = '';
    try {
        const after = await store.restoreCheckpoint(work, shaRename);
        lockRecovered = after.changed === true;
    } catch (e) {
        lockErr = e instanceof Error ? e.message : String(e);
    }
    ok('stale ref locks do not brick the store', lockRecovered, lockErr);
    for (const lockRel of [join('refs', 'heads', 'master.lock'), 'HEAD.lock', 'index.lock']) {
        ok(`stale lock cleared: ${lockRel}`, !existsSync(join(shadowDir, lockRel)));
    }

    // --- a FRESH lock (another git running) is NOT deleted ---
    // The staleness heuristic must not stomp a lock a live process holds. Such
    // a lock must fail the commit loudly - that is correct, it means another
    // git really is running - but the file itself must survive.
    mkdirSync(join(shadowDir, 'refs', 'heads'), { recursive: true });
    // The branch the shadow repo actually uses, not a hardcoded `master`:
    // init.defaultBranch may be `main` (or anything else), and a lock on a
    // branch HEAD does not point at blocks nothing - the probe would then fail
    // for the wrong reason and the assertion would be a coin flip per machine.
    const activeBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        env: { ...process.env, GIT_DIR: shadowDir },
        encoding: 'utf-8',
    }).trim();
    const freshLock = join(shadowDir, 'refs', 'heads', `${activeBranch}.lock`);
    writeFileSync(freshLock, '');
    let freshThrew = false;
    try {
        await store.createCheckpoint(work, 'fresh lock probe');
    } catch {
        freshThrew = true;
    }
    ok('fresh ref lock blocks the commit (loudly)', freshThrew);
    ok('fresh (non-stale) ref lock is left alone', existsSync(freshLock));
    rmSync(freshLock, { force: true });

    // --- the shadow repo ignores the user's GLOBAL git config ---
    // Regression: env() passed process.env through with no
    // GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM, so `commit.gpgsign = true` in
    // ~/.gitconfig killed EVERY commit ("gpg failed to sign the data" - no
    // pinentry in a hidden console) and `core.hooksPath` ran a post-commit
    // hook on every checkpoint. Both failed silently.
    const gpgWork = mkdtempSync(join(tmpdir(), 'xratu-cp-gpg-'));
    const gpgHome = mkdtempSync(join(tmpdir(), 'xratu-cp-home-'));
    const hookFired = join(gpgHome, 'hook-fired');
    try {
        mkdirSync(join(gpgHome, 'hooks'), { recursive: true });
        const hook = join(gpgHome, 'hooks', 'post-commit');
        writeFileSync(hook, `#!/bin/sh\necho ran > "${hookFired}"\n`);
        chmodSync(hook, 0o755);
        writeFileSync(join(gpgHome, '.gitconfig'),
            `[user]\n\tname = T\n\temail = t@example.invalid\n`
            + `[commit]\n\tgpgsign = true\n`
            + `[core]\n\thooksPath = ${join(gpgHome, 'hooks').replace(/\\/g, '/')}\n`);
        writeFileSync(join(gpgWork, 'f.txt'), 'f\n');

        const prevHome = process.env.HOME;
        const prevUserProfile = process.env.USERPROFILE;
        let gpgSha = '';
        let gpgErr = '';
        try {
            process.env.HOME = gpgHome;
            process.env.USERPROFILE = gpgHome;
            gpgSha = await store.createCheckpoint(gpgWork, 'under hostile global config');
        } catch (e) {
            gpgErr = e instanceof Error ? e.message : String(e);
        } finally {
            if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
            if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
        }
        ok('checkpoint survives commit.gpgsign=true in global config', !!gpgSha, gpgErr);
        ok('global core.hooksPath post-commit hook does NOT run', !existsSync(hookFired));
    } finally {
        rmSync(gpgWork, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        rmSync(gpgHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }

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
        rmSync(seedWork, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
} finally {
    // Retries on every teardown below, because this suite shells out to git
    // and gpg: on Windows a just-exited child can still hold the directory,
    // and `force` does not cover EBUSY.
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(storageRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failed === 0 ? '\nAll checkpoint restore tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

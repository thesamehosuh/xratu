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
const { readReviewFile } = require('../out/workSurface.js');

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
    const createCheckpoint = store.createCheckpoint;
    let releaseCapture, captureCount = 0, secondCaptured = false;
    const captureGate = new Promise(resolve => { releaseCapture = resolve; });
    store.createCheckpoint = async () => { captureCount++; await captureGate; return 'captured'; };
    store.beginTurn();
    const firstCapture = store.ensureTurnSnapshot(work, 'first mutation');
    const secondCapture = store.ensureTurnSnapshot(work, 'parallel mutation').then(() => { secondCaptured = true; });
    await new Promise(resolve => setImmediate(resolve));
    ok('parallel mutations wait for the same in-flight checkpoint', secondCaptured === false);
    releaseCapture(); await Promise.all([firstCapture, secondCapture]);
    ok('parallel mutations capture their baseline exactly once', captureCount === 1);
    store.createCheckpoint = createCheckpoint;
    store.beginTurn();
    const otherStore = new ShadowCheckpointStore({ globalStorageUri: { fsPath: storageRoot } });
    const firstInner = store._createCheckpointInner, otherInner = otherStore._createCheckpointInner;
    let enterFirst, releaseFirst, otherEntered = false;
    const firstEntered = new Promise(resolve => { enterFirst = resolve; });
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    store._createCheckpointInner = async () => { enterFirst(); await firstGate; return 'first'; };
    otherStore._createCheckpointInner = async () => { otherEntered = true; return 'other'; };
    const firstWindow = store.createCheckpoint(work, 'first window');
    await firstEntered;
    const otherWindow = otherStore.createCheckpoint(work, 'other window');
    await new Promise(resolve => setTimeout(resolve, 100));
    ok('separate windows serialize checkpoint writes to the same shadow repository', otherEntered === false);
    releaseFirst(); await Promise.all([firstWindow, otherWindow]);
    store._createCheckpointInner = firstInner; otherStore._createCheckpointInner = otherInner;
    const attributed = mkdtempSync(join(tmpdir(), 'xratu-cp-attributes-'));
    try {
        const attributes = '* text eol=lf ident\nlegacy.txt working-tree-encoding=UTF-16\n';
        const textBytes = Buffer.from('$Id$\r\nWindows line endings\r\n');
        const legacyBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('$Id$\r\nLegacy encoding\r\n', 'utf16le')]);
        writeFileSync(join(attributed, '.gitattributes'), attributes);
        writeFileSync(join(attributed, 'text.txt'), textBytes);
        writeFileSync(join(attributed, 'legacy.txt'), legacyBytes);
        const raw = await store.createCheckpoint(attributed, 'literal bytes despite attributes');
        writeFileSync(join(attributed, 'text.txt'), 'changed\r\n');
        writeFileSync(join(attributed, 'legacy.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('changed\r\n', 'utf16le')]));
        await store.restoreCheckpoint(attributed, raw);
        ok('checkpoint restore preserves CRLF and literal ident keywords byte for byte', readFileSync(join(attributed, 'text.txt')).equals(textBytes));
        ok('checkpoint restore preserves original working-tree encoding byte for byte', readFileSync(join(attributed, 'legacy.txt')).equals(legacyBytes));
        ok('shadow overrides never edit workspace attributes', readFileSync(join(attributed, '.gitattributes'), 'utf8') === attributes);
    } finally { rmSync(attributed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    const transactional = mkdtempSync(join(tmpdir(), 'xratu-cp-transaction-'));
    try {
        writeFileSync(join(transactional, 'same.txt'), 'checkpoint content\n');
        const baseline = await store.createCheckpoint(transactional, 'transaction baseline');
        writeFileSync(join(transactional, 'same.txt'), 'current content\n');
        writeFileSync(join(transactional, ' same.txt'), 'new spaced file\n');
        await store.restoreCheckpoint(transactional, baseline);
        ok('restore deletes the literal leading-space filename', !existsSync(join(transactional, ' same.txt')));
        ok('restore never deletes its trimmed-name checkpoint sibling', existsSync(join(transactional, 'same.txt')) && readFileSync(join(transactional, 'same.txt'), 'utf8') === 'checkpoint content\n');
        const literalNames = process.platform === 'win32' ? [' leading again.txt'] : [' leading again.txt', 'trailing .txt ', 'line\nname.txt', 'quote"name.txt'];
        for (const name of literalNames) writeFileSync(join(transactional, name), 'literal new file\n');
        await store.restoreCheckpoint(transactional, baseline);
        ok('restore removes literal quoted, spaced and control-character paths', literalNames.every(name => !existsSync(join(transactional, name))));
        rmSync(join(transactional, ' same.txt'), { force: true });
        writeFileSync(join(transactional, 'same.txt'), 'current content\n');
        writeFileSync(join(transactional, 'new.txt'), 'current new file\n');
        const gitAsync = store.gitAsync;
        let injected = false;
        store.gitAsync = async function (args, ...rest) {
            const result = await gitAsync.call(this, args, ...rest);
            if (!injected && args.includes('checkout-index')) {
                injected = true;
                return { ...result, code: 1, stderr: 'injected failure after workspace writes' };
            }
            return result;
        };
        let restoreError;
        try { await store.restoreCheckpoint(transactional, baseline); }
        catch (error) { restoreError = error; }
        finally { store.gitAsync = gitAsync; }
        ok('restore reports a materialization failure', !!restoreError);
        ok('failed restore rolls modified files back automatically', readFileSync(join(transactional, 'same.txt'), 'utf8') === 'current content\n');
        ok('failed restore preserves current created files', readFileSync(join(transactional, 'new.txt'), 'utf8') === 'current new file\n');
        writeFileSync(join(transactional, 'gone-first.txt'), 'must recover after a later cleanup error\n');
        const removals = require('fs'), remove = removals.rmSync;
        removals.rmSync = (file, ...args) => { if (file === join(transactional, 'new.txt')) throw Object.assign(Error('injected removal denied'), { code: 'EACCES' }); return remove(file, ...args); };
        let removalError;
        try { await store.restoreCheckpoint(transactional, baseline); }
        catch (error) { removalError = error; }
        finally { removals.rmSync = remove; }
        ok('failed cleanup never announces a successful restore', !!removalError);
        ok('failed cleanup rolls overwritten files back', readFileSync(join(transactional, 'same.txt'), 'utf8') === 'current content\n');
        ok('failed cleanup restores files it already deleted', existsSync(join(transactional, 'gone-first.txt')) && readFileSync(join(transactional, 'gone-first.txt'), 'utf8') === 'must recover after a later cleanup error\n');
        const headTarget = await store.createCheckpoint(transactional, 'symbolic restore target');
        writeFileSync(join(transactional, 'same.txt'), 'later content\n');
        const symbolic = await store.restoreCheckpoint(transactional, 'HEAD');
        ok('symbolic restore targets are pinned before the safety commit advances HEAD', symbolic.sha === headTarget && readFileSync(join(transactional, 'same.txt'), 'utf8') === 'current content\n');
        writeFileSync(join(transactional, '.gitignore'), 'same.txt\n');
        rmSync(join(transactional, 'same.txt'));
        await store.createCheckpoint(transactional, 'remove tracked path before ignored replacement');
        writeFileSync(join(transactional, 'same.txt'), 'ignored content absent from safety backup\n');
        let excludedError;
        try { await store.restoreCheckpoint(transactional, baseline); } catch (error) { excludedError = error; }
        ok('restore refuses to overwrite an excluded file absent from its safety checkpoint', !!excludedError && readFileSync(join(transactional, 'same.txt'), 'utf8') === 'ignored content absent from safety backup\n');
    } finally { rmSync(transactional, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

    // --- baseline checkpoint: one tracked file ---
    writeFileSync(join(work, 'a.txt'), 'one\n');
    const sha1 = await store.createCheckpoint(work, 'baseline');
    ok('baseline checkpoint returned a sha', /^[0-9a-f]{6,}$/.test(sha1), sha1);
    // Existing stores receive the partial-file exclusion on upgrade. Large
    // destinations get an exact literal pattern; glob metacharacters do not
    // accidentally hide neighboring workspace files.
    const partial = join(work, '.xratu-download-test.part');
    const artifact = join(work, 'model [q4].bin');
    writeFileSync(partial, 'partial bytes');
    await store.excludeDownload(work, 'model [q4].bin');
    writeFileSync(artifact, 'downloaded bytes');
    writeFileSync(join(work, 'model q.bin'), 'ordinary file');
    const downloadDiff = await store.diffCheckpoint(work, sha1);
    ok('partials and exact download destination stay out of shadow changes', !downloadDiff.some(file => file.path === '.xratu-download-test.part' || file.path === 'model [q4].bin'));
    ok('download exclusion does not hide neighboring files', downloadDiff.some(file => file.path === 'model q.bin'));
    await store.restoreCheckpoint(work, sha1);
    ok('checkpoint restore preserves partials and excluded artifacts', existsSync(partial) && existsSync(artifact));
    rmSync(partial); rmSync(artifact);
    const fullSha = await store.resolveCheckpoint(work, sha1);
    ok('resolve returns an existing full commit', /^[a-f0-9]{40}$/.test(fullSha) && fullSha.startsWith(sha1));
    for (const invalid of ['--all', 'HEAD', 'a'.repeat(41), '0000000']) {
        let rejected = false;
        try { await store.resolveCheckpoint(work, invalid); } catch { rejected = true; }
        ok(`resolve rejects invalid or missing target ${invalid}`, rejected);
    }
    ok('resolve never edits the workspace', readFileSync(join(work, 'a.txt'), 'utf-8') === 'one\n');


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
        mkdirSync(join(gpgHome, 'template', 'hooks'), { recursive: true });
        const templateHook = join(gpgHome, 'template', 'hooks', 'post-commit');
        writeFileSync(templateHook, readFileSync(hook)); chmodSync(templateHook, 0o755);
        writeFileSync(join(gpgHome, '.gitconfig'),
            `[user]\n\tname = T\n\temail = t@example.invalid\n`
            + `[commit]\n\tgpgsign = true\n`
            + `[init]\n\ttemplateDir = ${join(gpgHome, 'template').replace(/\\/g, '/')}\n`
            + `[core]\n\thooksPath = ${join(gpgHome, 'hooks').replace(/\\/g, '/')}\n`);
        writeFileSync(join(gpgWork, 'f.txt'), 'f\n');

        const prevHome = process.env.HOME;
        const prevUserProfile = process.env.USERPROFILE;
        const injected = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DEFAULT_HASH'];
        const inherited = injected.map(key => process.env[key]);
        let gpgSha = '';
        let gpgErr = '';
        let pinnedTarget = '';
        try {
            process.env.HOME = gpgHome;
            process.env.USERPROFILE = gpgHome;
            process.env.GIT_CONFIG_COUNT = '1';
            process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
            process.env.GIT_CONFIG_VALUE_0 = join(gpgHome, 'hooks');
            process.env.GIT_DEFAULT_HASH = 'sha256';
            gpgSha = await store.createCheckpoint(gpgWork, 'under hostile global config');
            pinnedTarget = await store.resolveCheckpoint(gpgWork, gpgSha);
        } catch (e) {
            gpgErr = e instanceof Error ? e.message : String(e);
        } finally {
            if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
            if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
            injected.forEach((key, index) => { if (inherited[index] === undefined) delete process.env[key]; else process.env[key] = inherited[index]; });
        }
        ok('checkpoint survives commit.gpgsign=true in global config', !!gpgSha, gpgErr);
        ok('shadow storage pins its supported hash format despite inherited defaults', /^[a-f0-9]{40}$/.test(pinnedTarget), gpgErr);
        ok('global core.hooksPath post-commit hook does NOT run', !existsSync(hookFired));
        ok('global init templates cannot install shadow hooks', !existsSync(hookFired));
    } finally {
        rmSync(gpgWork, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        rmSync(gpgHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }

    // --- hunk-review surface: diffCheckpoint + readCheckpointFile ---
    writeFileSync(join(work, 'review-base.txt'), 'alpha\nbeta\n');
    const reviewBase = await store.createCheckpoint(work, 'review base');
    writeFileSync(join(work, 'review-base.txt'), 'alpha\nCHANGED\n');
    writeFileSync(join(work, 'review-new.txt'), 'gamma\n');
    const changed = await store.diffCheckpoint(work, reviewBase);
    const byPath = new Map(changed.map((c) => [c.path, c]));
    const modified = byPath.get('review-base.txt');
    ok('diffCheckpoint lists a tracked modification with counts',
        !!modified && !modified.untracked && modified.added === 1 && modified.removed === 1,
        JSON.stringify(changed));
    ok('diffCheckpoint lists files created after the checkpoint as untracked',
        byPath.get('review-new.txt')?.untracked === true, JSON.stringify(changed));
    ok('readCheckpointFile returns the checkpoint content',
        (await store.readCheckpointFile(work, reviewBase, 'review-base.txt')) === 'alpha\nbeta\n');
    ok('readCheckpointFile returns null for a file that did not exist yet',
        (await store.readCheckpointFile(work, reviewBase, 'review-new.txt')) === null);
    const cleanBase = await store.createCheckpoint(work, 'review clean');
    ok('diffCheckpoint finds nothing right after a snapshot',
        (await store.diffCheckpoint(work, cleanBase)).length === 0,
        JSON.stringify(await store.diffCheckpoint(work, cleanBase)));


    writeFileSync(join(work, 'review-base.txt'), 'later edit\n');
    writeFileSync(join(work, 'review-later.txt'), 'outside the previous turn\n');
    const historical = await store.diffCheckpoint(work, reviewBase, cleanBase);
    ok('historical diff retains saved modifications and additions, excludes later edits',
        historical.find(file => file.path === 'review-base.txt')?.added === 1
        && historical.find(file => file.path === 'review-new.txt')?.added === 1
        && !historical.some(file => file.path === 'review-later.txt'), JSON.stringify(historical));
    ok('historical content is the saved result',
        (await store.readCheckpointFile(work, cleanBase, 'review-base.txt')) === 'alpha\nCHANGED\n');
    // Git quotes tabs/newlines/quotes even with core.quotePath=false.
    const reviewNames = process.platform === 'win32'
        ? ['جلسه spaced.txt']
        : ['جلسه spaced.txt', 'quoted "draft".txt', 'tab\tname.txt', 'line\nname.txt'];
    for (const name of reviewNames) writeFileSync(join(work, name), 'before\n');
    const pathBase = await store.createCheckpoint(work, 'review literal paths');
    for (const name of reviewNames) {
        writeFileSync(join(work, name), 'after\n');
        writeFileSync(join(work, `new ${name}`), 'new\n');
    }
    const literalChanges = await store.diffCheckpoint(work, pathBase);
    for (const name of reviewNames) {
        ok(`tracked review path stays literal: ${JSON.stringify(name)}`,
            literalChanges.some((file) => file.path === name && file.added === 1 && file.removed === 1));
        ok(`untracked review path stays literal: ${JSON.stringify(name)}`,
            literalChanges.some((file) => file.path === `new ${name}` && file.untracked));
        try {
            const file = await readReviewFile(store, work, pathBase, name);
            ok(`review reads literal path: ${JSON.stringify(name)}`, file.before === 'before\n' && file.after === 'after\n');
        } catch (error) { ok(`review reads literal path: ${JSON.stringify(name)}`, false, String(error)); }
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

import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { readReviewFile, validateReviewCheckpoint, REVIEW_FILE_LIMIT, StartupPageIntent } = require('../out/workSurface.js');
const SHA = 'a'.repeat(40);
const parent = await mkdtemp(path.join(os.tmpdir(), 'xratu-review-'));
const root = path.join(parent, 'workspace');
await mkdir(root);
const changes = [{ path: 'changed.txt', added: 1, removed: 1, binary: false, untracked: false }];
const store = { diffCheckpoint: async () => changes, readCheckpointFile: async () => 'before\n' };
try {
    await test('native page intent waits for startup, follows the latest command, and survives a reload', () => {
        const startup = new StartupPageIntent();
        const opened = [];
        startup.open(() => opened.push('settings'));
        startup.open(() => opened.push('providers'));
        assert.deepEqual(opened, []);
        startup.complete(); startup.complete();
        assert.deepEqual(opened, ['providers']);
        startup.open(() => opened.push('settings'));
        assert.deepEqual(opened, ['providers', 'settings']);
        startup.reset();
        startup.open(() => opened.push('providers'));
        startup.reset();
        assert.deepEqual(opened, ['providers', 'settings']);
        startup.complete();
        assert.deepEqual(opened, ['providers', 'settings', 'providers']);
    });
    await test('review reads a changed file and computes a real diff', async () => {
        await writeFile(path.join(root, 'changed.txt'), 'after\n');
        const file = await readReviewFile(store, root, SHA, 'changed.txt');
        assert.equal(file.kind, 'text');
        assert.equal(file.before, 'before\n');
        assert.equal(file.after, 'after\n');
        assert.deepEqual(file.hunks[0].removedLines, ['before']);
        assert.deepEqual(file.hunks[0].addedLines, ['after']);
    });
    await test('untracked files have an empty checkpoint side', async () => {
        const file = await readReviewFile({ ...store, diffCheckpoint: async () => [{ ...changes[0], untracked: true }], readCheckpointFile: async () => { throw new Error('must not read checkpoint'); } }, root, SHA, 'changed.txt');
        assert.equal(file.before, '');
        assert.equal(file.after, 'after\n');
    });
    await test('a deletion retains the checkpoint side', async () => {
        await rm(path.join(root, 'changed.txt'));
        const file = await readReviewFile(store, root, SHA, 'changed.txt');
        assert.equal(file.after, '');
        assert.equal(file.before, 'before\n');
    });
    await test('rejects path traversal, a nonmember, malformed SHA, and drive-relative paths', async () => {
        for (const file of ['../outside.txt', 'C:outside.txt', 'other.txt', '', null]) {
            await assert.rejects(readReviewFile(store, root, SHA, file));
        }
        for (const sha of ['--help', 'HEAD', 'aaa', 'a'.repeat(41), SHA + ':secret', null]) {
            assert.throws(() => validateReviewCheckpoint(sha));
        }
        assert.doesNotThrow(() => validateReviewCheckpoint('abcdef0'));
    });
    await test('binary and oversized files never send full contents to the webview', async () => {
        const binary = await readReviewFile({ ...store, diffCheckpoint: async () => [{ ...changes[0], binary: true }] }, root, SHA, 'changed.txt');
        assert.equal(binary.kind, 'binary');
        await writeFile(path.join(root, 'changed.txt'), Buffer.from([65, 0, 66]));
        assert.equal((await readReviewFile(store, root, SHA, 'changed.txt')).kind, 'binary');
        await writeFile(path.join(root, 'changed.txt'), 'x'.repeat(REVIEW_FILE_LIMIT + 1));
        const large = await readReviewFile(store, root, SHA, 'changed.txt');
        assert.equal(large.kind, 'tooLarge');
        assert.equal(large.after, '');
        assert.equal((await readReviewFile({ ...store, readCheckpointFile: async () => 'x'.repeat(REVIEW_FILE_LIMIT + 1) }, root, SHA, 'changed.txt')).kind, 'tooLarge');
    });
    await test('rejects directories and symlinks outside the workspace, including a switch during the diff await', async (t) => {
        await rm(path.join(root, 'changed.txt'));
        await mkdir(path.join(root, 'changed.txt'));
        await assert.rejects(readReviewFile(store, root, SHA, 'changed.txt'));
        await rm(path.join(root, 'changed.txt'), { recursive: true });
        const outside = path.join(parent, 'outside.txt');
        await writeFile(outside, 'outside content');
        try { await symlink(outside, path.join(root, 'changed.txt'), 'file'); }
        catch (error) { if (error.code === 'EPERM') { t.skip('Windows runner cannot create file symlinks'); return; } throw error; }
        await assert.rejects(readReviewFile(store, root, SHA, 'changed.txt'));
        await rm(path.join(root, 'changed.txt'));
        await writeFile(path.join(root, 'changed.txt'), 'inside');
        const switched = { ...store, diffCheckpoint: async () => { await rm(path.join(root, 'changed.txt')); await symlink(outside, path.join(root, 'changed.txt'), 'file'); return changes; } };
        await assert.rejects(readReviewFile(switched, root, SHA, 'changed.txt'));
    });
} finally { await rm(parent, { recursive: true, force: true }); }

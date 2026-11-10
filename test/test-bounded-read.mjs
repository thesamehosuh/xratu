import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readBoundedFile } = require('../out/tooling/boundedRead.js');
const root = await mkdtemp(path.join(tmpdir(), 'xratu-bounded-read-'));
try {
    const file = path.join(root, 'growing.txt');
    await writeFile(file, 'x'.repeat(100_000));
    assert.equal((await readBoundedFile(file, 8)).length, 9, 'oversize reads retain only the overflow sentinel');
    await writeFile(file, 'small');
    assert.equal((await readBoundedFile(file, 8)).toString(), 'small');
    await writeFile(file, '');
    assert.equal((await readBoundedFile(file, 8)).length, 0);
    await mkdir(path.join(root, 'dir'));
    await assert.rejects(readBoundedFile(path.join(root, 'dir'), 8));
    await assert.rejects(readBoundedFile(file, -1));
} finally { await rm(root, { recursive: true, force: true }); }
console.log('bounded-read: fixed memory ceiling, short/empty files and non-file rejection passed');

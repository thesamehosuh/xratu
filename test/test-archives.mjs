import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { Header, Pax } = require('tar');
const { buf: crc32 } = require('crc-32');
const { executeArchiveTool } = require('../out/archives/archive.js');
const { ARCHIVE_TOOLS } = require('../out/archives/tools.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xratu-archives-'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let serial = 0;
async function fixture(bytes, suffix = '.data') {
    const workspace = path.join(root, `case-${++serial}`);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, `source${suffix}`), bytes);
    return { workspace, source: `source${suffix}`, bytes };
}
async function tool(f, name, args = {}, signal) {
    return executeArchiveTool(f.workspace, name, { path: f.source, ...args }, signal);
}
function ok(result) { assert.equal(result.isError, undefined, result.output); return JSON.parse(result.output); }
async function absent(file) { await assert.rejects(fs.lstat(file), { code: 'ENOENT' }); }
async function refused(f, args = {}, signal) {
    const result = await tool(f, 'extract_archive', { destination: 'output', ...args }, signal);
    assert.equal(result.isError, true, result.output);
    if (args.destination === undefined) await absent(path.join(f.workspace, 'output'));
    return result;
}

// Small byte fixtures deliberately encode malformed archives without asking a
// CLI to sanitize the very names/types the reader must reject. No OS utilities.
function zip(entries) {
    const local = [], central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? 'hello');
        const compressed = entry.stored ? data : deflateRawSync(data);
        const method = entry.method ?? (entry.stored ? 0 : 8), flags = 0x800 | (entry.encrypted ? 1 : 0);
        const crc = entry.crc ?? (crc32(data) >>> 0), size = entry.size ?? data.length;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6);
        header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
        local.push(header, name, compressed);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16);
        directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
        directory.writeUInt32LE((((entry.mode ?? 0o100644) << 16) | (entry.dos ?? 0)) >>> 0, 38);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, name); offset += header.length + name.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}
function tar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.data ?? (entry.type === 'Directory' ? '' : 'hello'));
        const header = new Header({ path: entry.name, type: entry.type ?? 'File', size: entry.size ?? data.length,
            mode: entry.mode ?? 0o644, uid: 1234, gid: 1234, linkpath: entry.linkpath, mtime: new Date(0) });
        const buffer = Buffer.alloc(512); header.encode(buffer);
        chunks.push(buffer, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

try {
    await test('SHA-256 streams binary/empty files; compares uppercase digests and enforces budgets', async () => {
        for (const bytes of [Buffer.alloc(0), Buffer.alloc(800000, 0x91)]) {
            const f = await fixture(bytes);
            const computed = ok(await tool(f, 'verify_file'));
            assert.equal(computed.sha256, sha256(bytes)); assert.equal(computed.bytes, bytes.length);
            assert.equal(computed.verified, undefined);
            assert.equal(ok(await tool(f, 'verify_file', { sha256: sha256(bytes).toUpperCase() })).verified, true);
            assert.equal((await tool(f, 'verify_file', { sha256: '0'.repeat(64) })).isError, true);
            for (const max_bytes of [0, -1, '1', 1.5, 1024 ** 4 + 1]) assert.equal((await tool(f, 'verify_file', { max_bytes })).isError, true);
        }
        const f = await fixture(Buffer.alloc(10));
        assert.equal((await tool(f, 'verify_file', { max_bytes: 9 })).isError, true);
        assert.equal((await tool(f, 'verify_file', { sha256: 'bad' })).isError, true);
        assert.equal((await tool(f, 'verify_file', { path: '.' })).isError, true);
    });

    for (const [format, encode] of [['zip', zip], ['tar', tar], ['tar.gz', entries => gzipSync(tar(entries))]]) {
        await test(`${format}: binary/Unicode/spaces, nested directories, executable bits, and no shell`, { timeout: 10000 }, async () => {
            const bytes = Buffer.from([0, 255, 1, 2, 3]);
            const f = await fixture(encode([
                { name: './', type: 'Directory', mode: 0o040755, data: '' },
                { name: 'sdk/', type: 'Directory', mode: 0o040755, data: '' },
                { name: 'sdk/hello world.txt', data: 'hello' },
                { name: 'sdk/آرشیو.bin', data: bytes },
                { name: 'café/e\u0301.txt', data: '' },
                { name: 'sdk/bin/tool.exe', data: 'executable data', mode: 0o107755 },
            ]));
            const inspection = ok(await tool(f, 'inspect_archive'));
            assert.equal(inspection.format, format); assert.equal(inspection.entries, 6);
            assert.equal(inspection.expandedBytes, 25);
            assert.deepEqual(await fs.readdir(f.workspace), [f.source]);
            const extracted = ok(await tool(f, 'extract_archive', { destination: 'output', sha256: sha256(f.bytes) }));
            assert.equal(extracted.verified, true);
            assert.deepEqual(await fs.readFile(path.join(f.workspace, 'output', 'sdk', 'آرشیو.bin')), bytes);
            assert.equal(await fs.readFile(path.join(f.workspace, 'output', 'sdk', 'hello world.txt'), 'utf8'), 'hello');
            const mode = (await fs.stat(path.join(f.workspace, 'output', 'sdk', 'bin', 'tool.exe'))).mode;
            if (process.platform !== 'win32') { assert.equal(mode & 0o7000, 0); assert.ok(mode & 0o100); }
            assert.equal((await tool(f, 'extract_archive', { destination: 'output' })).isError, true);
            assert.equal(await fs.readFile(path.join(f.workspace, 'output', 'sdk', 'hello world.txt'), 'utf8'), 'hello');
            await refused(f, { destination: 'bad-checksum', sha256: '0'.repeat(64) });
            await absent(path.join(f.workspace, 'bad-checksum'));
        });
        await test(`${format}: Windows and POSIX escaping/unsafe filenames are refused on every host`, { timeout: 10000 }, async () => {
            for (const name of ['../escape', 'a/../../escape', 'a\\..\\escape', '/absolute', 'C:/absolute', 'C:relative',
                '\\\\server\\share\\file', '//server/share/file', 'a:stream', 'a./file', 'a /file', 'NUL.txt', 'CON', 'AUX.ext',
                'COM1.txt', 'LPT9', 'COM¹', 'conin$', 'NUL .txt', 'bad\x01name', 'a/.git/config', '.GIT/config', '.xratu-download-owned.part', 'a?b', 'a|b']) {
                const f = await fixture(encode([{ name }]));
                assert.equal((await tool(f, 'inspect_archive')).isError, true, name);
                await refused(f);
            }
        });
        await test(`${format}: duplicate files, case/Unicode aliases and file/directory conflicts are refused`, async () => {
            for (const names of [['a', 'a'], ['A', 'a'], ['Foo/a', 'foo/b'], ['é/a', 'e\u0301/b'], ['a', 'a/b'], ['a/b', 'a']]) {
                const f = await fixture(encode(names.map(name => ({ name }))));
                await refused(f);
            }
        });
        await test(`${format}: entry/byte/depth limits and checksum failure remove partial output`, async () => {
            const f = await fixture(encode([{ name: 'first', data: 'hello' }, { name: 'nested/second', data: 'world' }]));
            await refused(f, { max_bytes: 9 });
            await refused(f, { max_entries: 1 });
            await refused(f, { max_entries: 2 }); // implicit parent counts too
            for (const max_entries of [0, '10', 10001]) await refused(f, { max_entries });
            for (const max_bytes of [0, '10', 21474836481]) await refused(f, { max_bytes });
            const deep = await fixture(encode([{ name: Array(34).fill('a').join('/') }]));
            await refused(deep);
            assert.equal(ok(await tool(f, 'extract_archive', { destination: 'valid', max_entries: 3, max_bytes: 10 })).expandedBytes, 10);
        });
        await test(`${format}: cancellation during a write closes handles and removes the owned directory`, { timeout: 10000 }, async () => {
            const f = await fixture(encode([{ name: 'large', data: Buffer.alloc(1024 * 1024, 7) }, { name: 'later' }]));
            const controller = new AbortController(), promises = require('node:fs/promises'), originalOpen = promises.open;
            promises.open = async (...args) => {
                const handle = await originalOpen(...args);
                if (args[1] === 'wx') {
                    const write = handle.writeFile.bind(handle);
                    handle.writeFile = async (...data) => { await write(...data); controller.abort(); };
                }
                return handle;
            };
            try { await refused(f, {}, controller.signal); } finally { promises.open = originalOpen; }
            ok(await tool(f, 'extract_archive', { destination: 'retry' }));
        });
        await test(`${format}: disk failures and concurrent source changes remove partial output`, { timeout: 10000 }, async () => {
            for (const changeSource of [false, true]) {
                const f = await fixture(encode([{ name: 'first' }, { name: 'second' }]));
                const promises = require('node:fs/promises'), originalOpen = promises.open;
                let injected = false;
                promises.open = async (...args) => {
                    const handle = await originalOpen(...args);
                    if (args[1] === 'wx' && !injected) {
                        injected = true;
                        const write = handle.writeFile.bind(handle);
                        handle.writeFile = async (...data) => {
                            await write(...data);
                            if (changeSource) await fs.writeFile(path.join(f.workspace, f.source), 'changed');
                            else throw Object.assign(new Error('Simulated full disk'), { code: 'ENOSPC' });
                        };
                    }
                    return handle;
                };
                try { await refused(f, { sha256: sha256(f.bytes) }); }
                finally { promises.open = originalOpen; }
                assert.equal(injected, true);
            }
        });
        await test(`${format}: a swapped parent is refused whether it stays swapped or is restored`, { timeout: 10000 }, async () => {
            for (const restore of [false, true]) {
                const f = await fixture(encode([{ name: 'nested/first' }, { name: 'nested/second' }]));
                const escaped = path.join(root, `escaped-${++serial}`);
                await fs.mkdir(escaped);
                const promises = require('node:fs/promises'), originalOpen = promises.open;
                promises.open = async (...args) => {
                    // outputPath has already validated `nested`; the swap lands
                    // between that check and the create itself. With `restore`
                    // the parent is put back immediately after the create, which
                    // is exactly what beats two SEQUENCED path checks (identity,
                    // then containment) - only asking the descriptor where it
                    // lives still reports the truth.
                    if (args[1] === 'wx' && typeof args[0] === 'string' && args[0].includes(`${path.sep}nested${path.sep}`)) {
                        const parent = path.dirname(args[0]);
                        await fs.rm(parent, { recursive: true, force: true });
                        await fs.symlink(escaped, parent, 'junction');
                        const handle = await originalOpen(...args);
                        if (restore) { await fs.rm(parent, { force: true }); await fs.mkdir(parent); }
                        return handle;
                    }
                    return originalOpen(...args);
                };
                try { await refused(f); } finally { promises.open = originalOpen; }
                // No content may escape on any platform. Where the kernel can
                // answer where the descriptor points (Linux), the refused create
                // is cleaned up too; elsewhere a restored parent can strand the
                // zero-byte file, which is the documented residual.
                const leaked = await fs.readdir(escaped);
                for (const name of leaked) assert.equal((await fs.stat(path.join(escaped, name))).size, 0);
                if (process.platform === 'linux' || !restore) assert.deepEqual(leaked, []);
                await absent(path.join(f.workspace, 'output'));
            }
        });
    }
    await test('ZIP handles Windows separators without changing file bytes', async () => {
        const f = await fixture(zip([{ name: 'sdk\\bin\\tool.exe', data: 'binary' }]));
        ok(await tool(f, 'extract_archive', { destination: 'output' }));
        assert.equal(await fs.readFile(path.join(f.workspace, 'output', 'sdk', 'bin', 'tool.exe'), 'utf8'), 'binary');
    });
    await test('ZIP rejects symlinks/devices, encrypted/unsupported data, CRC corruption and size lies', async () => {
        for (const entry of [{ mode: 0o120777 }, { mode: 0o020600 }, { encrypted: true }, { method: 99 }, { crc: 0 }, { size: 1 }, { size: 100 }, { mode: 0o040755 }]) {
            const f = await fixture(zip([{ name: 'first' }, { name: 'bad', ...entry }]));
            await refused(f);
        }
        for (const bytes of [zip([{ name: 'a' }]).subarray(0, 35), Buffer.from('PK\x03\x04junk')]) await refused(await fixture(bytes));
    });
    await test('TAR rejects symlinks/hardlinks/devices/FIFOs/unknown types without following them', async () => {
        for (const type of ['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO', 'GNUDumpDir']) {
            const f = await fixture(tar([{ name: 'first' }, { name: 'link', type, linkpath: ['SymbolicLink', 'Link'].includes(type) ? '../outside' : undefined }]));
            await refused(f);
        }
    });
    await test('TAR/PAX long and overridden paths get the same checks; oversized metadata is refused', async () => {
        for (const name of ['../escape', 'C:/escape', 'NUL.txt']) {
            const bytes = Buffer.concat([new Pax({ path: name }).encode(), tar([{ name: 'safe' }])]);
            await refused(await fixture(bytes));
        }
        await refused(await fixture(tar([{ name: 'metadata', type: 'ExtendedHeader', data: Buffer.alloc(65537, 32) }, { name: 'safe' }])));
    });
    await test('truncated TAR and gzip, corrupt TAR checksums, nested compression, and non-archives fail', { timeout: 10000 }, async () => {
        const valid = tar([{ name: 'a', data: Buffer.alloc(1024) }]);
        const corrupt = Buffer.from(valid); corrupt[0] ^= 1;
        const gz = gzipSync(valid);
        for (const bytes of [valid.subarray(0, 600), gz.subarray(0, gz.length - 8), corrupt, gzipSync(gz), Buffer.from('not an archive')]) await refused(await fixture(bytes));
    });
    await test('fragmented TAR input preserves headers and cannot bypass the nested-compression guard', { timeout: 10000 }, async () => {
        const valid = tar([{ name: 'file', data: 'data' }]);
        const gz = gzipSync(valid);
        const promises = require('node:fs/promises'), originalOpen = promises.open;
        promises.open = async (...args) => {
            const handle = await originalOpen(...args);
            if (typeof args[1] === 'number') {
                const create = handle.createReadStream.bind(handle);
                handle.createReadStream = options => Readable.from((async function* () {
                    for await (const chunk of create(options)) {
                        for (let i = 0; i < chunk.length; i++) yield chunk.subarray(i, i + 1);
                    }
                })());
            }
            return handle;
        };
        try {
            for (const bytes of [valid, gz]) {
                const f = await fixture(bytes);
                ok(await tool(f, 'extract_archive', { destination: 'output' }));
                assert.equal(await fs.readFile(path.join(f.workspace, 'output', 'file'), 'utf8'), 'data');
            }
            // Separate gzip members split the inner magic as well as input.
            await refused(await fixture(Buffer.concat([gzipSync(gz.subarray(0, 1)), gzipSync(gz.subarray(1))])));
        } finally { promises.open = originalOpen; }
    });
    await test('empty archives succeed; large listings are bounded while all paths are validated', async () => {
        for (const bytes of [zip([]), tar([]), gzipSync(tar([]))]) {
            const f = await fixture(bytes);
            assert.equal(ok(await tool(f, 'extract_archive', { destination: 'output' })).entries, 0);
            assert.deepEqual(await fs.readdir(path.join(f.workspace, 'output')), []);
        }
        const entries = Array.from({ length: 210 }, (_, i) => ({ name: `file-${i}`, data: '' }));
        for (const encode of [zip, tar]) {
            const f = await fixture(encode(entries));
            const listing = ok(await tool(f, 'inspect_archive'));
            assert.equal(listing.entries, 210); assert.equal(listing.listing.length, 200); assert.equal(listing.listingTruncated, true);
            assert.equal((await tool(await fixture(encode([...entries, { name: '../escape' }])), 'inspect_archive')).isError, true);
        }
    });
    await test('existing/missing destinations and symlinks never overwrite or escape the workspace', async () => {
        const f = await fixture(zip([{ name: 'file', data: 'new' }]));
        await fs.mkdir(path.join(f.workspace, 'existing'));
        await fs.writeFile(path.join(f.workspace, 'existing', 'keep'), 'original');
        assert.equal((await tool(f, 'extract_archive', { destination: 'existing' })).isError, true);
        assert.equal(await fs.readFile(path.join(f.workspace, 'existing', 'keep'), 'utf8'), 'original');
        assert.equal((await tool(f, 'extract_archive', { destination: 'missing/new' })).isError, true);
        await absent(path.join(f.workspace, 'missing'));
        for (const destination of ['../escape', '/absolute', 'C:\\escape', 'C:relative', 'a:stream', '.git/output', 'NUL']) await refused(f, { destination });
        const outside = path.join(root, 'outside'); await fs.mkdir(outside);
        await fs.symlink(outside, path.join(f.workspace, 'link'), 'junction');
        await refused(f, { destination: 'link/new' });
        assert.equal((await tool(f, 'verify_file', { path: 'link/file' })).isError, true);
        assert.deepEqual(await fs.readdir(outside), []);
        await fs.symlink(path.join(root, 'dangling'), path.join(f.workspace, 'dangling'), 'junction');
        await refused(f, { destination: 'dangling/new' });
    });
    await test('pre-cancelled operations create no output', async () => {
        const f = await fixture(zip([{ name: 'a' }])), signal = AbortSignal.abort();
        for (const name of ['verify_file', 'inspect_archive', 'extract_archive']) assert.equal((await tool(f, name, { destination: 'output' }, signal)).isError, true);
        await absent(path.join(f.workspace, 'output'));
    });
    await test('real executor and native bridge keep reads in plan, gate extraction, and checkpoint writes', async () => {
        const originalLoad = Module._load;
        Module._load = function(request, parent, isMain) {
            if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
            return originalLoad.call(this, request, parent, isMain);
        };
        let mcp;
        try { mcp = require('../out/mcp.js'); } finally { Module._load = originalLoad; }
        const { nativeServiceTools, isNativePlanTool } = require('../out/engines/opencode/services.js');
        const f = await fixture(zip([{ name: 'a' }])); let snapshots = 0;
        const plan = mcp.createLocalToolExecutor(f.workspace, async () => { snapshots++; }, undefined, undefined, undefined, undefined, { plan: true });
        const call = (name, args = {}) => ({ id: name, name, arguments: { path: f.source, destination: 'output', ...args } });
        assert.equal((await plan.execute(call('extract_archive'))).isError, true);
        ok(await plan.execute(call('verify_file'))); ok(await plan.execute(call('inspect_archive')));
        assert.equal(snapshots, 0);
        for (const tool of ARCHIVE_TOOLS) {
            assert.equal(isNativePlanTool(tool.name), tool.name !== 'extract_archive');
            const native = nativeServiceTools([{ ...tool, requiresApproval: false }]);
            assert.equal(native.length, 1); assert.equal(native[0].autoApprove, tool.name !== 'extract_archive');
            assert.equal(mcp.getLocalToolDefinitions({ yolo: true }).find(t => t.name === tool.name).requiresApproval, tool.requiresApproval);
        }
        const run = mcp.createLocalToolExecutor(f.workspace, async () => { snapshots++; });
        ok(await run.execute(call('extract_archive'))); assert.equal(snapshots, 1);
        const { setOfflineMode } = require('../out/networkPolicy.js');
        setOfflineMode(true);
        try {
            for (const tool of ARCHIVE_TOOLS) assert.ok(mcp.getLocalToolDefinitions().some(t => t.name === tool.name));
            ok(await run.execute(call('extract_archive', { destination: 'offline' })));
        } finally { setOfflineMode(false); }
    });
} finally { await fs.rm(root, { recursive: true, force: true }); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { DownloadManager } = require('../out/downloads/manager.js');
const payload = Buffer.alloc(64 * 1024, 'xratu');
const digest = createHash('sha256').update(payload).digest('hex');
const requests = [];
const counts = new Map();
const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const count = (counts.get(pathname) ?? 0) + 1;
    counts.set(pathname, count);
    requests.push({ pathname, range: req.headers.range, ifRange: req.headers['if-range'] });
    if (pathname === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/private' }).end(); return; }
    if (pathname === '/move') { res.writeHead(302, { location: '/file' }).end(); return; }
    if (pathname === '/downgrade') { res.writeHead(302, { location: 'http://downloads.example/file' }).end(); return; }
    if (pathname === '/unavailable' || (pathname === '/retry' && count === 1)) { res.writeHead(503, { 'retry-after': '0' }).end(); return; }
    if (pathname === '/expired') { res.writeHead(403).end(); return; }
    const offset = req.headers.range && pathname !== '/ignores' ? Number(/bytes=(\d+)-/.exec(req.headers.range)?.[1] ?? 0) : 0;
    const headers = { 'content-length': payload.length - offset, etag: pathname === '/changed' && offset > 0 ? '"new"' : '"v1"' };
    if (offset > 0) headers['content-range'] = `bytes ${offset}-${payload.length - 1}/${payload.length}`;
    if (pathname === '/bad-range' && offset > 0) headers['content-range'] = `bytes 0-${payload.length - 1}/${payload.length}`;
    if (pathname === '/no-validator') delete headers.etag;
    if (pathname === '/encoded') headers['content-encoding'] = 'gzip';
    res.writeHead(offset ? 206 : 200, headers);
    let position = offset;
    if (pathname === '/stall') { res.write(payload.subarray(0, 4096)); return; }
    if (['/slow', '/changed', '/ignores', '/bad-range', '/no-validator'].includes(pathname) || (pathname === '/drop' && count === 1)) {
        res.write(payload.subarray(position, position + 4096)); position += 4096;
        if (pathname === '/drop') { setTimeout(() => res.destroy(), 40); return; }
        const timer = setInterval(() => {
            res.write(payload.subarray(position, position + 4096)); position += 4096;
            if (position >= payload.length) { clearInterval(timer); res.end(); }
        }, 12);
        res.once('close', () => clearInterval(timer));
    } else res.end(payload.subarray(offset));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;
const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'xratu-downloads-'));
const managers = [];

async function until(predicate, message = 'condition', timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timed out: ${message}`);
}
async function fixture(overrides = {}) {
    const base = await fs.mkdtemp(path.join(parent, 'case-'));
    const root = path.join(base, 'workspace'), storage = path.join(base, 'storage');
    await fs.mkdir(root);
    const secretMap = new Map(), routed = [], validated = [], diagnostics = [];
    const secrets = { get: async k => secretMap.get(k), store: async (k, v) => { secretMap.set(k, v); }, delete: async k => { secretMap.delete(k); } };
    const deps = {
        secrets, dispatcher: (_url, route) => route === 'direct' ? undefined : { route },
        validateUrl: async (url, proxied) => {
            validated.push({ url, proxied });
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'downloads.example' || parsed.username || parsed.password) throw new Error('Refused');
            return url;
        },
        fetch: (url, init) => {
            routed.push({ url, proxied: !!init.dispatcher });
            const parsed = new URL(url);
            return fetch(`${local}${parsed.pathname}${parsed.search}`, { ...init, dispatcher: undefined });
        },
        offline: () => false, changed: () => {}, diagnostic: error => diagnostics.push(error), retryMs: 5, idleMs: 1000,
        ...overrides,
    };
    const manager = new DownloadManager(root, storage, deps); managers.push(manager); await manager.ready;
    const start = async (pathname = '/file', args = {}) => {
        const result = await manager.tool(root, 'start_download', { url: `https://downloads.example${pathname}`, path: `file-${Math.random()}.bin`, ...args });
        assert.equal(result.isError, undefined, result.output);
        return JSON.parse(result.output);
    };
    const control = (id, action, args = {}) => manager.tool(root, 'control_download', { id, action, ...args });
    const state = id => manager.views().find(r => r.id === id);
    const finished = id => until(() => ['completed', 'failed', 'paused'].includes(state(id)?.status) && state(id), 'transfer settles');
    return { manager, root, storage, deps, start, control, state, finished, secretMap, routed, validated, diagnostics };
}

try {
    await test('streams and verifies a file; safe views/manifest omit signed URLs; final file is exclusive', async () => {
        const f = await fixture();
        const r = await f.start('/file?token=private', { path: 'models/model.bin', sha256: digest });
        assert.equal((await f.finished(r.id)).status, 'completed');
        assert.deepEqual(await fs.readFile(path.join(f.root, r.path)), payload);
        assert.equal(f.secretMap.size, 0);
        const manifest = await fs.readFile(path.join(f.storage, 'downloads', (await fs.readdir(path.join(f.storage, 'downloads')))[0], 'manifest.json'), 'utf8');
        assert.doesNotMatch(manifest, /private|token=/);
        assert.doesNotMatch(JSON.stringify(f.manager.views()), /private|token=/);
        const collision = await f.manager.tool(f.root, 'start_download', { url: 'https://downloads.example/file', path: r.path });
        assert.equal(collision.isError, true);
        assert.deepEqual(await fs.readFile(path.join(f.root, r.path)), payload);
    });
    await test('dropped connection retries with Range and If-Range and preserves every byte', async () => {
        const f = await fixture();
        const r = await f.start('/drop', { sha256: digest });
        assert.equal((await f.finished(r.id)).status, 'completed');
        const resumed = requests.find(req => req.pathname === '/drop' && req.range);
        assert.equal(resumed?.range, 'bytes=4096-'); assert.equal(resumed?.ifRange, '"v1"');
        assert.deepEqual(await fs.readFile(path.join(f.root, r.path)), payload);
    });
    await test('pause/resume changes route on the same ID and keeps partial bytes', async () => {
        const f = await fixture(); const r = await f.start('/slow', { route: 'direct', sha256: digest });
        await until(() => f.state(r.id).received >= 4096);
        assert.equal((await f.control(r.id, 'pause')).isError, undefined);
        const bytes = f.state(r.id).received; assert.ok(bytes > 0 && bytes < payload.length);
        assert.equal((await f.control(r.id, 'resume', { route: 'proxy' })).isError, undefined);
        assert.equal((await f.finished(r.id)).status, 'completed');
        assert.equal(f.state(r.id).effectiveRoute, 'proxy');
        assert.ok(f.routed.some(r => r.proxied) && f.routed.some(r => !r.proxied));
        assert.ok(f.validated.some(r => r.proxied) && f.validated.some(r => !r.proxied));
        assert.deepEqual(await fs.readFile(path.join(f.root, r.path)), payload);
    });
    await test('a reload leaves an interrupted record; the agent recovers it without re-downloading the prefix', async () => {
        const f = await fixture(); const r = await f.start('/slow', { sha256: digest });
        await until(() => f.state(r.id).received >= 4096); await f.manager.dispose();
        const recovered = new DownloadManager(f.root, f.storage, f.deps); managers.push(recovered); await recovered.ready;
        assert.equal(recovered.views()[0].status, 'interrupted');
        assert.equal((await recovered.tool(f.root, 'control_download', { id: r.id, action: 'resume' })).isError, undefined);
        await until(() => recovered.views()[0].status === 'completed');
        assert.deepEqual(await fs.readFile(path.join(f.root, r.path)), payload);
    });
    for (const pathname of ['/changed', '/ignores', '/bad-range', '/no-validator']) {
        await test(`unsafe resume ${pathname} fails without corrupting or publishing a file`, async () => {
            const f = await fixture(); const r = await f.start(pathname);
            await until(() => f.state(r.id).received >= 4096); await f.control(r.id, 'pause');
            const bytes = f.state(r.id).received; await f.control(r.id, 'resume');
            assert.equal((await f.finished(r.id)).error, 'downloadChanged');
            assert.equal(f.state(r.id).received, bytes);
            await assert.rejects(fs.stat(path.join(f.root, r.path)), { code: 'ENOENT' });
            if (pathname === '/changed') {
                await f.control(r.id, 'restart', { url: 'https://downloads.example/file' });
                assert.equal((await f.finished(r.id)).status, 'completed');
            }
        });
    }
    await test('checksum mismatch, byte budget and encoded bodies never publish a destination', async () => {
        for (const args of [{ sha256: '0'.repeat(64) }, { max_bytes: 100 }, { url: 'https://downloads.example/encoded' }]) {
            const f = await fixture(); const r = await f.start('/file', args);
            assert.equal((await f.finished(r.id)).status, 'failed');
            await assert.rejects(fs.stat(path.join(f.root, r.path)), { code: 'ENOENT' });
        }
    });
    await test('stall timeout and HTTP backoff settle with bounded retries; 403 does not retry', async () => {
        for (const pathname of ['/stall', '/unavailable', '/expired']) {
            const f = await fixture({ idleMs: 60, maxRetries: 1 }); const before = counts.get(pathname) ?? 0;
            const r = await f.start(pathname); const state = await f.finished(r.id);
            assert.equal(state.status, 'failed');
            assert.equal(state.attempts, pathname === '/expired' ? 1 : 2);
            assert.equal((counts.get(pathname) ?? 0) - before, state.attempts);
        }
        const f = await fixture(); const r = await f.start('/retry'); assert.equal((await f.finished(r.id)).status, 'completed');
    });
    await test('redirects revalidate routing and refuse private targets and HTTPS downgrade', async () => {
        const f = await fixture(); const r = await f.start('/redirect');
        assert.equal((await f.finished(r.id)).error, 'downloadUnsafeUrl');
        assert.equal(f.routed.filter(r => new URL(r.url).hostname === '127.0.0.1').length, 0);
        const downgrade = await f.start('/downgrade'); assert.equal((await f.finished(downgrade.id)).error, 'downloadUnsafeUrl');
        const moved = await f.start('/move', { route: 'direct' }); assert.equal((await f.finished(moved.id)).status, 'completed');
        assert.ok(f.validated.some(r => r.url.endsWith('/file') && !r.proxied));
    });
    await test('offline mode and missing explicit proxy cannot send requests', async () => {
        for (const overrides of [{ offline: () => true }, { dispatcher: () => undefined }]) {
            const f = await fixture(overrides);
            const result = await f.manager.tool(f.root, 'start_download', { url: 'https://downloads.example/file', path: 'new.bin', route: 'proxy' });
            assert.equal(result.isError, true); assert.equal(f.routed.length, 0);
        }
        let offline = false;
        const f = await fixture({ offline: () => offline }); const r = await f.start('/slow');
        await until(() => f.state(r.id).received >= 4096); await f.control(r.id, 'pause'); offline = true;
        assert.equal((await f.control(r.id, 'resume')).isError, true);
        assert.equal(f.state(r.id).status, 'paused');
    });
    await test('path traversal, symlink escapes, duplicate destinations and cross-workspace IDs are refused', async () => {
        const f = await fixture();
        for (const destination of ['../escape.bin', '.git/config', '.xratu-download-reserved', 'C:escape']) {
            const result = await f.manager.tool(f.root, 'start_download', { url: 'https://downloads.example/file', path: destination });
            assert.equal(result.isError, true, destination);
        }
        const outside = path.join(parent, 'outside'); await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal((await f.manager.tool(f.root, 'start_download', { url: 'https://downloads.example/file', path: 'link/escape.bin' })).isError, true);
        const r = await f.start('/slow', { path: 'owned.bin' });
        assert.equal((await f.manager.tool(f.root, 'start_download', { url: 'https://downloads.example/file', path: r.path })).isError, true);
        assert.equal((await f.manager.tool(outside, 'list_downloads', {})).isError, true);
        await f.control(r.id, 'cancel');
        assert.equal(f.state(r.id).status, 'cancelled'); assert.equal(f.secretMap.size, 0);
        assert.deepEqual(await fs.readdir(f.root), ['link']);
    });
    await test('destination races never overwrite a file and another window cannot acquire ownership', async () => {
        const f = await fixture(); const r = await f.start('/slow', { path: 'race.bin' });
        await until(() => f.state(r.id).received >= 4096); await fs.writeFile(path.join(f.root, r.path), 'user data');
        assert.equal((await f.finished(r.id)).error, 'downloadFileError');
        assert.equal(await fs.readFile(path.join(f.root, r.path), 'utf8'), 'user data');
        const second = new DownloadManager(f.root, f.storage, f.deps); managers.push(second);
        await assert.rejects(second.ready, /another Xratu window/);
    });
    await test('queue concurrency is bounded and cancelling an active job admits the next', async () => {
        const f = await fixture({ concurrency: 1 }); const a = await f.start('/slow'), b = await f.start('/slow');
        await until(() => f.state(a.id).received >= 4096); assert.equal(f.state(b.id).status, 'queued');
        await f.control(a.id, 'cancel'); assert.equal((await f.finished(b.id)).status, 'completed');
    });
    await test('DNS outages retry before any socket is opened and cancelled admission creates no download', async () => {
        let attempts = 0;
        const f = await fixture({ validateUrl: async url => {
            if (++attempts <= 2) throw new Error('Host could not be resolved: downloads.example');
            return url;
        } });
        const r = await f.start(); assert.equal((await f.finished(r.id)).status, 'completed');
        assert.equal(f.routed.length, 1); assert.equal(f.state(r.id).attempts, 2);
        const controller = new AbortController();
        const g = await fixture({ validateUrl: async url => { controller.abort(); return url; } });
        const denied = await g.manager.tool(g.root, 'start_download', { url: 'https://downloads.example/file', path: 'cancelled.bin' }, controller.signal);
        assert.equal(denied.isError, true); assert.equal(g.manager.views().length, 0); assert.equal(g.routed.length, 0);
        const stalled = await fixture({ idleMs: 15, maxRetries: 0, validateUrl: () => new Promise(() => {}) });
        const queued = await stalled.start();
        assert.equal((await stalled.finished(queued.id)).error, 'downloadNetworkError');
        assert.equal(stalled.routed.length, 0, 'an unresolved URL cannot open a socket');
        const cancelled = new AbortController();
        const pending = stalled.manager.tool(stalled.root, 'start_download', { url: 'https://downloads.example/file', path: 'not-started.bin' }, cancelled.signal);
        setTimeout(() => cancelled.abort(), 5);
        assert.equal((await pending).isError, true);
        assert.equal(stalled.manager.views().length, 1, 'cancelling DNS admission cannot add a job');
    });
    await test('an expired signed URL can be refreshed without losing download identity', async () => {
        const f = await fixture(); const r = await f.start('/expired?token=old');
        assert.equal((await f.finished(r.id)).httpStatus, 403);
        assert.equal((await f.control(r.id, 'resume', { url: 'https://downloads.example/file?token=new' })).isError, undefined);
        assert.equal((await f.finished(r.id)).status, 'completed');
        assert.equal(f.manager.views().length, 1);
    });
    await test('offline transition pauses active and queued transfers; returning online does not restart them', async () => {
        let offline = false;
        const f = await fixture({ concurrency: 1, offline: () => offline });
        const a = await f.start('/slow'), b = await f.start('/slow');
        await until(() => f.state(a.id).received >= 4096); offline = true;
        await f.manager.pauseForOffline();
        assert.equal(f.state(a.id).status, 'paused'); assert.equal(f.state(b.id).status, 'paused');
        assert.equal(f.state(b.id).error, 'downloadOffline');
        offline = false; await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(f.state(a.id).status, 'paused'); assert.equal(f.state(b.id).status, 'paused');
        await f.control(a.id, 'resume'); assert.equal((await f.finished(a.id)).status, 'completed');
    });
    await test('a replaced partial symlink is refused, and cancelling it does not touch the target', async () => {
        const f = await fixture(); const r = await f.start('/slow');
        await until(() => f.state(r.id).received >= 4096); await f.control(r.id, 'pause');
        const partial = path.join(f.root, `.xratu-download-${r.id}.part`);
        const other = path.join(f.root, 'other.bin'); await fs.writeFile(other, 'keep');
        await fs.unlink(partial);
        // File symlinks require Windows Developer Mode; directory junction
        // escapes are covered on every platform above.
        if (process.platform === 'win32') return;
        await fs.symlink(other, partial); await f.control(r.id, 'resume');
        assert.equal((await f.finished(r.id)).error, 'downloadFileError');
        await f.control(r.id, 'cancel'); assert.equal(await fs.readFile(other, 'utf8'), 'keep');
    });
    await test('plan execution rejects hidden mutations; native bridging keeps mutations behind approvals', async () => {
        const original = Module._load;
        Module._load = function(request, parent, isMain) {
            if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
            return original.call(this, request, parent, isMain);
        };
        let mcp;
        try { mcp = require('../out/mcp.js'); } finally { Module._load = original; }
        const { nativeServiceTools, isNativePlanTool } = require('../out/engines/opencode/services.js');
        const { DOWNLOAD_TOOLS } = require('../out/downloads/tools.js');
        let dispatched = 0;
        const executor = mcp.createLocalToolExecutor('/workspace', async () => {}, undefined, undefined, undefined, undefined, { plan: true, downloads: { tool: async () => { dispatched++; return { output: 'status' }; } } });
        for (const name of ['start_download', 'control_download']) {
            assert.equal((await executor.execute({ id: name, name, arguments: {} })).isError, true);
            assert.equal(isNativePlanTool(name), false);
            const native = nativeServiceTools([{ ...DOWNLOAD_TOOLS.find(t => t.name === name), requiresApproval: false }]);
            assert.equal(native.length, 1); assert.equal(native[0].autoApprove, false);
        }
        assert.equal(dispatched, 0);
        assert.equal((await executor.execute({ id: 'status', name: 'list_downloads', arguments: {} })).output, 'status');
        assert.equal(isNativePlanTool('list_downloads'), true);
    });
} finally {
    await Promise.allSettled(managers.map(m => m.dispose()));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(parent, { recursive: true, force: true });
}

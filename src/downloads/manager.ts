import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { constants, lstatSync } from 'fs';
import * as path from 'path';
import { sanitizePath } from '../paths';
import { abortable } from '../oauth/refreshLock';
import type { ProxyRouteMode } from '../proxy';
import { downloadActions } from './types';
import type { DownloadAction, DownloadError, DownloadRecord, DownloadSecrets, DownloadView } from './types';
import { acquireDownloadOwner } from './ownerLock';

const MAX_RECORDS = 100;
const MAX_PENDING = 20;
const DEFAULT_MAX_BYTES = 20 * 1024 ** 3;
const MAX_BYTES = 1024 ** 4;
const settled = new Set(['completed', 'cancelled']);
const busy = new Set(['queued', 'downloading', 'retrying', 'verifying']);
const statuses = new Set(['queued', 'downloading', 'retrying', 'verifying', 'paused', 'interrupted', 'completed', 'failed', 'cancelled']);

export interface DownloadDependencies {
    secrets: DownloadSecrets;
    validateUrl(url: string, proxied: boolean): Promise<string>;
    dispatcher(url: string, route: ProxyRouteMode): unknown;
    fetch(url: string, init: RequestInit & { dispatcher?: unknown }): Promise<Response>;
    offline(): boolean;
    changed(downloads: DownloadView[], error?: DownloadError): void;
    diagnostic(error: unknown): void;
    prepareDestination?(relativePath: string, bytes: number): Promise<void>;
    /** Test seams; production uses two transfers, 30s idle, 20 retries. */
    concurrency?: number;
    idleMs?: number;
    retryMs?: number;
    maxRetries?: number;
}

class DownloadFailure extends Error {
    constructor(readonly key: DownloadError, readonly retryable = false, readonly httpStatus?: number, readonly retryAfterMs?: number) { super(key); }
}
function routeArg(value: unknown): ProxyRouteMode {
    if (value === undefined) return 'auto';
    if (value === 'auto' || value === 'proxy' || value === 'direct') return value;
    throw new Error('route must be auto, proxy, or direct.');
}
function textArg(value: unknown, name: string, max = 8192): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
    return value.trim();
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function contentLength(value: string | null): number | null {
    if (value === null) return null;
    if (!/^\d+$/.test(value) || !integer(Number(value))) throw new DownloadFailure('downloadChanged');
    return Number(value);
}
function validator(record: DownloadRecord): string | undefined { return record.etag ?? record.lastModified; }
function validateRecordPath(value: string): void {
    const parts = value.split(/[\\/]/);
    if (!value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value) || /[\r\n\0]/.test(value)
        || parts.every(part => !part || part === '.') || parts.some(part => part === '..' || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.xratu-download-'))) throw new DownloadFailure('downloadFileError');
}

/** Workspace-owned transfers. Model turns own commands, never transfer lifetimes. */
export class DownloadManager {
    readonly ready: Promise<void>;
    private readonly records = new Map<string, DownloadRecord>();
    private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
    private readonly directory: string;
    private readonly scope: string;
    private readonly owner = randomUUID();
    private commands: Promise<unknown> = Promise.resolve();
    private writes: Promise<void> = Promise.resolve();
    private closed = false;
    private locked = false;
    private lastEmit = 0;
    private startupError?: DownloadError;
    private closing?: Promise<void>;
    private releaseOwner?: () => Promise<void>;
    private sessionId?: string;
    private readonly sessionAliases = new Map<string, string>();

    constructor(readonly workspace: string, storage: string, private readonly deps: DownloadDependencies) {
        this.scope = createHash('sha256').update(path.resolve(workspace)).digest('hex');
        this.directory = path.join(storage, 'downloads', this.scope);
        this.ready = this.load();
        void this.ready.catch(error => { this.startupError = 'downloadFileError'; this.deps.diagnostic(error); this.emit(); });
    }

    views(sessionId?: string): DownloadView[] {
        return [...this.records.values()].filter(r => sessionId === undefined || r.sessionId === this.resolveSession(sessionId)).reverse().map(({ id, path: target, source, route, effectiveRoute, status, received, total, bytesPerSecond, attempts, retryAt, error, httpStatus, createdAt, updatedAt }) =>
            ({ id, path: target, source, route, effectiveRoute, status, received, total, bytesPerSecond, attempts, retryAt, error, httpStatus, createdAt, updatedAt }));
    }
    publish(): void { this.emit(); }
    setSession(sessionId: string): void { this.sessionId = sessionId; this.emit(); }
    private resolveSession(sessionId: string): string { return this.sessionAliases.get(sessionId) ?? sessionId; }
    /** Saving a new chat assigns its durable id while in-flight tools retain the live id. */
    bindSession(liveId: string, savedId: string): Promise<void> {
        this.sessionAliases.set(liveId, savedId);
        const work = this.commands.then(async () => {
            await this.ready;
            let changed = false;
            for (const r of this.records.values()) if (r.sessionId === liveId) { r.sessionId = savedId; changed = true; }
            if (changed) await this.save();
            this.emit();
        });
        this.commands = work.catch(() => undefined);
        return work;
    }
    private emit(): void { this.lastEmit = Date.now(); this.deps.changed(this.views(this.sessionId), this.startupError); }
    private key(id: string): string { return `xratu.download.${this.scope}.${id}`; }
    private target(record: DownloadRecord): string {
        validateRecordPath(record.path);
        try { return sanitizePath(record.path, this.workspace); }
        catch { throw new DownloadFailure('downloadFileError'); }
    }
    private partial(record: DownloadRecord): string {
        const target = this.target(record);
        // Resolve the parent, never the generated leaf: resolving a replaced
        // partial symlink would turn its target into our write/unlink operand.
        const parent = sanitizePath(path.dirname(target), this.workspace);
        return path.join(parent, `.xratu-download-${record.id}.part`);
    }

    private async load(): Promise<void> {
        if (!this.workspace) return;
        await fs.mkdir(this.directory, { recursive: true });
        this.releaseOwner = await acquireDownloadOwner(this.directory, this.owner);
        this.locked = true;
        let manifest: unknown;
        try {
            const file = path.join(this.directory, 'manifest.json');
            if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Download manifest is too large.');
            manifest = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
        if (!Array.isArray(manifest) || manifest.length > MAX_RECORDS) throw new Error('Invalid download manifest.');
        for (const value of manifest) {
            const r = value as DownloadRecord;
            if (!r || !/^[0-9a-f-]{36}$/.test(r.id) || this.records.has(r.id) || typeof r.path !== 'string' || r.path.length > 4096
                || typeof r.source !== 'string' || r.source.length > 512 || !statuses.has(r.status)
                || !['auto', 'proxy', 'direct'].includes(r.route) || !integer(r.received) || !(r.total === null || integer(r.total))
                || !integer(r.maxBytes) || r.maxBytes < 1 || r.maxBytes > MAX_BYTES || r.received > r.maxBytes
                || !integer(r.attempts) || !integer(r.createdAt) || !integer(r.updatedAt)
                || (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !r.sessionId || r.sessionId.length > 256))
                || (r.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(r.sha256))
                || [r.etag, r.lastModified].some(v => v !== undefined && (typeof v !== 'string' || v.length > 1024 || /[\r\n]/.test(v)))) throw new Error('Invalid download record.');
            validateRecordPath(r.path);
            const source = new URL(r.source);
            if (!['http:', 'https:'].includes(source.protocol) || source.origin !== r.source) throw new Error('Invalid download source.');
            // Never silently restart network/disk work after a host restart.
            if (busy.has(r.status)) r.status = 'interrupted';
            r.bytesPerSecond = 0;
            delete r.retryAt;
            delete r.error;
            delete r.httpStatus;
            if (!settled.has(r.status)) {
                try { this.target(r); }
                catch { r.status = 'failed'; r.error = 'downloadFileError'; }
            }
            this.records.set(r.id, r);
        }
        this.emit();
    }

    private save(): Promise<void> {
        const json = JSON.stringify([...this.records.values()]);
        const write = this.writes.then(async () => {
            const temp = path.join(this.directory, `manifest-${this.owner}.tmp`);
            await fs.writeFile(temp, json, { mode: 0o600 });
            await fs.rename(temp, path.join(this.directory, 'manifest.json'));
        });
        this.writes = write.catch(() => undefined);
        return write;
    }

    async tool(workspace: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, sessionId?: string): Promise<{ output: string; isError?: boolean }> {
        const work = this.commands.then(async () => {
            await this.ready;
            signal?.throwIfAborted();
            if (this.closed) throw new Error('Download service is closed.');
            if (!this.workspace || path.resolve(workspace) !== path.resolve(this.workspace)) throw new Error('Downloads require the current workspace.');
            if (name === 'list_downloads') {
                const downloads = this.views(sessionId);
                if (args.id !== undefined && !downloads.some(r => r.id === args.id)) throw new Error('Unknown download ID.');
                return { output: JSON.stringify({ proxyAvailable: !!this.deps.dispatcher('https://example.com', 'proxy'), downloads: args.id ? downloads.filter(r => r.id === args.id) : downloads }) };
            }
            let record: DownloadRecord;
            if (name === 'start_download') record = await this.start(args, signal, sessionId);
            else if (name === 'control_download') {
                if (sessionId !== undefined && !this.views(sessionId).some(r => r.id === args.id)) throw new Error('Unknown download ID.');
                record = await this.control(args, signal);
            }
            else throw new Error('Unknown download tool.');
            return { output: JSON.stringify(this.views().find(r => r.id === record.id)) };
        });
        this.commands = work.catch(() => undefined);
        return work.catch(error => ({ output: `Error: ${error instanceof Error ? error.message : 'Download command failed.'}`, isError: true }));
    }

    /** Explicit user controls reuse the transfer's path, URL and offline guards. */
    userAction(sessionId: string, id: string, action: DownloadAction): Promise<void> {
        const work = this.commands.then(async () => {
            await this.ready;
            if (this.closed || sessionId !== this.sessionId) throw new Error('Stale download session.');
            const r = this.records.get(id);
            if (!r || r.sessionId !== this.resolveSession(sessionId) || !downloadActions(r.status).includes(action)) throw new Error('Unavailable download action.');
            await this.control({ id, action });
        });
        this.commands = work.catch(() => undefined);
        return work;
    }

    private async checkUrl(value: unknown, route: ProxyRouteMode, signal?: AbortSignal): Promise<string> {
        if (this.deps.offline()) throw new DownloadFailure('downloadOffline');
        const url = textArg(value, 'url');
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new DownloadFailure('downloadUnsafeUrl'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new DownloadFailure('downloadUnsafeUrl');
        const dispatcher = this.deps.dispatcher(url, route);
        if (route === 'proxy' && !dispatcher) throw new DownloadFailure('downloadProxyMissing');
        const deadline = AbortSignal.timeout(this.deps.idleMs ?? 30_000);
        try { return await abortable(this.deps.validateUrl(url, !!dispatcher), signal ? AbortSignal.any([signal, deadline]) : deadline); }
        catch (error) {
            signal?.throwIfAborted();
            // DNS outages may queue safely: the worker still validates before
            // every request. No socket opens on the strength of this fallback.
            if (deadline.aborted || (error instanceof Error && error.message.startsWith('Host could not be resolved:'))) return parsed.toString();
            throw new DownloadFailure('downloadUnsafeUrl');
        }
    }
    private async start(args: Record<string, unknown>, signal?: AbortSignal, sessionId?: string): Promise<DownloadRecord> {
        if ([...this.records.values()].filter(r => !settled.has(r.status)).length >= MAX_PENDING) throw new Error('At most 20 unfinished downloads are allowed. Cancel an old download first.');
        const route = routeArg(args.route);
        const url = await this.checkUrl(args.url, route, signal);
        signal?.throwIfAborted();
        const target = sanitizePath(textArg(args.path, 'path', 4096), this.workspace);
        if (/[\r\n\0]/.test(target)) throw new Error('Download path contains unsupported control characters.');
        // Use the sanitizer's spelling for both operands: native realpath can
        // expand Windows short names that realpathSync preserves.
        const relative = path.relative(sanitizePath('.', this.workspace), target);
        validateRecordPath(relative);
        const comparable = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
        if ([...this.records.values()].some(r => {
            if (settled.has(r.status)) return false;
            let destination: string;
            try { destination = this.target(r); }
            catch { r.status = 'failed'; r.error = 'downloadFileError'; r.bytesPerSecond = 0; return false; }
            return comparable(destination) === comparable(target);
        })) throw new Error('Another download owns this destination.');
        const maxBytes = args.max_bytes === undefined ? DEFAULT_MAX_BYTES : args.max_bytes;
        if (!integer(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('max_bytes must be between 1 and 1099511627776.');
        const sha256 = args.sha256 === undefined ? undefined : textArg(args.sha256, 'sha256', 64).toLowerCase();
        if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must contain 64 hexadecimal characters.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        this.assertAbsent(target);
        const now = Date.now();
        const record: DownloadRecord = { id: randomUUID(), sessionId: sessionId === undefined ? undefined : this.resolveSession(sessionId), path: relative, source: new URL(url).origin, route, status: 'queued', received: 0, total: null, bytesPerSecond: 0, attempts: 0, maxBytes, sha256, createdAt: now, updatedAt: now };
        const partial = this.partial(record);
        const file = await fs.open(partial, 'wx', 0o600);
        await file.close();
        try {
            await this.deps.secrets.store(this.key(record.id), url);
            signal?.throwIfAborted();
            this.records.set(record.id, record);
            await this.prune();
            await this.save();
        } catch (error) { this.records.delete(record.id); await fs.unlink(partial).catch(() => undefined); await Promise.resolve(this.deps.secrets.delete(this.key(record.id))).catch(() => undefined); throw error; }
        if (signal?.aborted) { record.status = 'paused'; await this.save(); }
        this.emit(); this.pump();
        return record;
    }
    private assertAbsent(target: string): void {
        // Synchronous preflight avoids a scheduling gap; link() is the final
        // exclusive publication gate, including dangling symlinks and races.
        try { lstatSync(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        throw new Error('Download destination already exists; choose a new path.');
    }
    private async prune(): Promise<void> {
        for (const r of this.records.values()) {
            if (this.records.size <= MAX_RECORDS) break;
            if (!settled.has(r.status)) continue;
            await this.deps.secrets.delete(this.key(r.id));
            this.records.delete(r.id);
        }
    }

    private async control(args: Record<string, unknown>, signal?: AbortSignal): Promise<DownloadRecord> {
        const id = textArg(args.id, 'id', 36), action = args.action;
        const r = this.records.get(id);
        if (!r) throw new Error('Unknown download ID.');
        if (!['pause', 'resume', 'restart', 'cancel'].includes(String(action))) throw new Error('Invalid download action.');
        if (settled.has(r.status)) throw new Error('Download has already completed or been cancelled.');
        if ((args.route !== undefined || args.url !== undefined) && action !== 'resume' && action !== 'restart') throw new Error('URL and route changes require resume or restart.');
        const route = args.route === undefined ? r.route : routeArg(args.route);
        const url = action === 'resume' || action === 'restart' ? await this.checkUrl(args.url ?? await this.deps.secrets.get(this.key(id)), route, signal) : undefined;
        signal?.throwIfAborted();
        if (settled.has(r.status)) return r;
        // Mark BEFORE aborting so the worker cannot publish or schedule retries.
        r.status = action === 'cancel' ? 'cancelled' : 'paused';
        const active = this.active.get(id);
        active?.controller.abort();
        await active?.done;
        if (this.records.get(id)?.status === 'completed') return r;
        if (action === 'cancel') {
            let partial: string | undefined;
            try { partial = this.partial(r); } catch (error) { this.deps.diagnostic(error); }
            if (partial) await fs.unlink(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
            await this.deps.secrets.delete(this.key(id));
        } else if (url) {
            this.assertAbsent(this.target(r));
            await this.deps.secrets.store(this.key(id), url);
            if (action === 'restart') {
                const file = await this.openPartial(r);
                try { await file.truncate(0); await file.sync(); } finally { await file.close(); }
                r.received = 0; r.total = null; delete r.etag; delete r.lastModified;
            }
            r.route = route; r.source = new URL(url).origin; r.status = 'queued'; r.attempts = 0;
            delete r.effectiveRoute;
            if (signal?.aborted) r.status = 'paused';
        }
        r.bytesPerSecond = 0; r.updatedAt = Date.now(); delete r.retryAt; delete r.error; delete r.httpStatus;
        await this.save(); this.emit(); this.pump();
        return r;
    }

    private pump(): void {
        if (this.closed || this.startupError) return;
        for (const r of this.records.values()) {
            if (this.active.size >= (this.deps.concurrency ?? 2)) break;
            if (r.status !== 'queued' || this.active.has(r.id)) continue;
            const controller = new AbortController();
            const done = Promise.resolve().then(() => this.run(r, controller.signal)).catch(error => {
                r.status = 'failed'; r.error = 'downloadFileError'; this.deps.diagnostic(error);
                this.emit();
            }).finally(() => { this.active.delete(r.id); this.pump(); });
            this.active.set(r.id, { controller, done });
        }
    }
    private async run(r: DownloadRecord, signal: AbortSignal): Promise<void> {
        while (!signal.aborted && !this.closed) {
            try {
                if (this.deps.offline()) throw new DownloadFailure('downloadOffline');
                r.status = 'downloading'; r.attempts++; delete r.error; delete r.retryAt;
                await this.save(); this.emit();
                await this.transfer(r, signal);
                r.status = 'completed'; r.bytesPerSecond = 0; r.updatedAt = Date.now();
                await this.save();
                // Publication is complete; credential cleanup must not retry
                // the transfer after its partial has already been removed.
                try { await this.deps.secrets.delete(this.key(r.id)); }
                catch (error) { this.deps.diagnostic(error); }
                this.emit(); return;
            } catch (error) {
                if (signal.aborted) break;
                const failure = error instanceof DownloadFailure ? error : new DownloadFailure(this.deps.offline() ? 'downloadOffline' : 'downloadNetworkError', !this.deps.offline());
                r.error = failure.key; r.httpStatus = failure.httpStatus; r.bytesPerSecond = 0; r.updatedAt = Date.now();
                if (!failure.retryable || r.attempts > (this.deps.maxRetries ?? 20)) {
                    r.status = failure.key === 'downloadOffline' ? 'paused' : 'failed';
                    await this.save(); this.emit(); return;
                }
                const delay = failure.retryAfterMs ?? Math.min(60_000, (this.deps.retryMs ?? 2000) * 2 ** Math.min(5, r.attempts - 1)) * (0.85 + Math.random() * 0.3);
                r.status = 'retrying'; r.retryAt = Date.now() + delay;
                await this.save(); this.emit();
                await this.wait(delay, signal);
            }
        }
        r.bytesPerSecond = 0; delete r.retryAt; r.updatedAt = Date.now();
        await this.save(); this.emit();
    }
    private wait(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, ms);
            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted) finish();
        });
    }
    private async openPartial(r: DownloadRecord): Promise<fs.FileHandle> {
        const partial = this.partial(r);
        try {
            const before = await fs.lstat(partial);
            if (!before.isFile() || before.nlink !== 1) throw new Error('Unsafe partial file.');
            const file = await fs.open(partial, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
            const after = await file.stat();
            if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1 || after.size > r.maxBytes) { await file.close(); throw new Error('Partial file changed.'); }
            return file;
        } catch { throw new DownloadFailure('downloadFileError'); }
    }

    private async transfer(r: DownloadRecord, signal: AbortSignal): Promise<void> {
        const file = await this.openPartial(r);
        const controller = new AbortController();
        const combined = AbortSignal.any([signal, controller.signal]);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let idle: ReturnType<typeof setTimeout> | undefined;
        const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), this.deps.idleMs ?? 30_000); };
        try {
            r.received = (await file.stat()).size;
            if (r.total !== null && r.received === r.total) { await this.finalize(r, file, combined); return; }
            if (r.received > 0 && !validator(r)) throw new DownloadFailure('downloadChanged');
            this.assertAbsent(this.target(r));
            const storedUrl = await this.deps.secrets.get(this.key(r.id));
            if (!storedUrl) throw new DownloadFailure('downloadFileError');
            let url: string = storedUrl;
            const offset = r.received;
            const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
            if (offset > 0) { headers.Range = `bytes=${offset}-`; headers['If-Range'] = validator(r)!; }
            let response: Response | undefined;
            for (let hop = 0; hop <= 5; hop++) {
                arm(); combined.throwIfAborted();
                if (this.deps.offline()) throw new DownloadFailure('downloadOffline');
                const dispatcher = this.deps.dispatcher(url, r.route);
                r.effectiveRoute = dispatcher ? 'proxy' : 'direct';
                if (r.route === 'proxy' && !dispatcher) throw new DownloadFailure('downloadProxyMissing');
                try { url = await abortable(this.deps.validateUrl(url, !!dispatcher), combined); }
                catch (error) {
                    combined.throwIfAborted();
                    if (error instanceof Error && error.message.startsWith('Host could not be resolved:')) throw new DownloadFailure('downloadNetworkError', true);
                    throw new DownloadFailure('downloadUnsafeUrl');
                }
                response = await this.deps.fetch(url, { method: 'GET', headers, redirect: 'manual', signal: combined, dispatcher });
                if (![301, 302, 303, 307, 308].includes(response.status)) break;
                await response.body?.cancel();
                const location = response.headers.get('location');
                if (!location || hop === 5) throw new DownloadFailure('downloadHttpError');
                const next: URL = new URL(location, url);
                if (new URL(url).protocol === 'https:' && next.protocol !== 'https:') throw new DownloadFailure('downloadUnsafeUrl');
                url = next.toString();
            }
            if (!response) throw new DownloadFailure('downloadNetworkError', true);
            reader = response.body?.getReader();
            if (response.status !== 200 && response.status !== 206) {
                if (response.status === 416) throw new DownloadFailure('downloadChanged', false, response.status);
                const retry = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
                const after = response.headers.get('retry-after');
                const wait = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : NaN;
                throw new DownloadFailure('downloadHttpError', retry, response.status, Number.isFinite(wait) ? Math.max(1000, Math.min(300_000, wait)) : undefined);
            }
            if (offset > 0 && response.status !== 206) throw new DownloadFailure('downloadChanged', false, response.status);
            const encoding = response.headers.get('content-encoding');
            if (encoding && encoding !== 'identity') throw new DownloadFailure('downloadChanged');
            const length = contentLength(response.headers.get('content-length'));
            if (response.status === 206) {
                const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
                if (!match) throw new DownloadFailure('downloadChanged');
                const [start, end, total] = match.slice(1).map(Number);
                if (![start, end, total].every(integer) || start !== offset || end < start || end >= total || (length !== null && length !== end - start + 1)
                    || (r.total !== null && r.total !== total)) throw new DownloadFailure('downloadChanged');
                r.total = total;
            } else r.total = length;
            if (r.total !== null && r.total > r.maxBytes) throw new DownloadFailure('downloadTooLarge');
            const etag = response.headers.get('etag');
            const modified = response.headers.get('last-modified');
            if (offset > 0 && ((r.etag && etag && r.etag !== etag) || (!r.etag && r.lastModified && modified && r.lastModified !== modified))) throw new DownloadFailure('downloadChanged');
            if (offset === 0) {
                r.etag = etag && !etag.startsWith('W/') && etag.length <= 1024 ? etag : undefined;
                r.lastModified = modified && modified.length <= 1024 && Number.isFinite(Date.parse(modified)) ? modified : undefined;
            }
            // Persist validators BEFORE the first byte so a crash can resume.
            await this.save();
            if (!reader) throw new DownloadFailure('downloadNetworkError', true);
            let sampleBytes = r.received, sampleAt = Date.now(), checkpointAt = sampleAt;
            while (true) {
                arm();
                const { value, done } = await reader.read();
                if (done) break;
                combined.throwIfAborted();
                if (r.received + value.byteLength > r.maxBytes) throw new DownloadFailure('downloadTooLarge');
                if (r.total !== null && r.received + value.byteLength > r.total) throw new DownloadFailure('downloadChanged');
                let written = 0;
                while (written < value.byteLength) {
                    const result = await file.write(value, written, value.byteLength - written, r.received + written);
                    if (!result.bytesWritten) throw new DownloadFailure('downloadFileError');
                    written += result.bytesWritten;
                }
                r.received += value.byteLength; r.updatedAt = Date.now();
                const elapsed = r.updatedAt - sampleAt;
                if (elapsed >= 1000) { r.bytesPerSecond = Math.round((r.received - sampleBytes) * 1000 / elapsed); sampleBytes = r.received; sampleAt = r.updatedAt; }
                if (r.updatedAt - this.lastEmit >= 1000) this.emit();
                if (r.updatedAt - checkpointAt >= 5000) { await file.sync(); await this.save(); checkpointAt = r.updatedAt; }
            }
            clearTimeout(idle);
            if (r.total !== null && r.received !== r.total) throw new DownloadFailure('downloadNetworkError', true);
            if (r.total === null) r.total = r.received;
            await this.finalize(r, file, combined);
        } catch (error) {
            if (error instanceof DownloadFailure || signal.aborted) throw error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code && /^(EACCES|EPERM|ENOSPC|EDQUOT|EIO|EEXIST|ENOENT|EXDEV|ENOTSUP|ENOSYS|EINVAL|EMLINK|EROFS|ENOTDIR|EISDIR|EBADF|ENAMETOOLONG|EFBIG|EMFILE|ENFILE)$/.test(code)) throw new DownloadFailure('downloadFileError');
            throw error;
        } finally {
            clearTimeout(idle); controller.abort();
            await reader?.cancel().catch(() => undefined);
            await file.close().catch(() => undefined);
        }
    }

    private async finalize(r: DownloadRecord, file: fs.FileHandle, signal: AbortSignal): Promise<void> {
        r.status = 'verifying'; r.bytesPerSecond = 0; this.emit();
        await file.sync();
        if (r.sha256) {
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(256 * 1024);
            for (let position = 0; position < r.received;) {
                signal.throwIfAborted();
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, r.received - position), position);
                if (!bytesRead) throw new DownloadFailure('downloadFileError');
                hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
            }
            if (hash.digest('hex') !== r.sha256) throw new DownloadFailure('downloadChecksumError');
        }
        signal.throwIfAborted();
        const expected = await file.stat();
        try { await this.deps.prepareDestination?.(r.path, r.received); }
        catch (error) { this.deps.diagnostic(error); }
        await this.save();
        await file.close();
        // Same-directory hard link atomically publishes without overwriting.
        const partial = this.partial(r), stat = await fs.lstat(partial);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== r.received || stat.ino !== expected.ino || stat.dev !== expected.dev) throw new DownloadFailure('downloadFileError');
        signal.throwIfAborted();
        await fs.link(partial, this.target(r));
        await fs.unlink(partial).catch(error => this.deps.diagnostic(error));
    }

    dispose(): Promise<void> { return this.closing ??= this.shutdown(); }
    async pauseForOffline(): Promise<void> {
        const work = this.commands.then(async () => {
            await this.ready;
            if (this.closed || !this.locked || this.startupError) return;
            for (const r of this.records.values()) if (busy.has(r.status)) { r.status = 'paused'; r.error = 'downloadOffline'; r.bytesPerSecond = 0; delete r.retryAt; }
            for (const active of this.active.values()) active.controller.abort();
            await Promise.allSettled([...this.active.values()].map(a => a.done));
            await this.save(); this.emit();
        });
        this.commands = work.catch(() => undefined);
        await work;
    }
    private async shutdown(): Promise<void> {
        this.closed = true;
        await this.commands;
        await this.ready.catch(() => undefined);
        for (const r of this.records.values()) if (busy.has(r.status)) r.status = 'interrupted';
        for (const active of this.active.values()) active.controller.abort();
        await Promise.allSettled([...this.active.values()].map(a => a.done));
        if (!this.locked) return;
        try {
            if (!this.startupError) await this.save();
            await this.writes;
        } finally {
            await this.releaseOwner?.();
            this.locked = false;
        }
    }
}

/**
 * Cross-process directory mutex for rotating OAuth tokens and persisted state.
 * Every version acquires the same path with an atomic mkdir. Each new
 * holder writes a unique owner file before entering its critical section.
 *
 * Recovery unlinks only the observed owner's filename. Only the contender
 * that removed this marker may remove the resulting empty directory. A
 * directory with no owner record is recoverable after its grace period.
 * The lock directory contains no credentials.
 */
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Lock path for a credential storage key: sha256 so the key (which names a
 *  provider, never a secret) and its length cannot leak into a filename, and
 *  so the name is filesystem-safe on Windows. */
export function oauthLockPath(lockRoot: string, storageKey: string): string {
    const digest = createHash('sha256').update(storageKey).digest('hex').slice(0, 16);
    return path.join(lockRoot, `oauth-${digest}.lock.d`);
}

export interface LockOptions {
    /** Give up acquiring after this long. Default 60s (Cline's deadline). */
    timeoutMs?: number;
    /** A lock older than this is presumed abandoned. Default 2 minutes. */
    staleMs?: number;
    /** Reap recorded owners only after the OS confirms their PID is gone. */
    recoverDeadOwner?: boolean;
    /** Async sleep between acquire attempts. Default 25ms - short enough to
     *  be responsive, long enough that the event loop is never blocked. */
    sleepMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
    signal?: AbortSignal;
}

export class LockTimeoutError extends Error {
    constructor(lockPath: string) {
        super(`Timed out acquiring OAuth refresh lock at ${lockPath}`);
        this.name = 'LockTimeoutError';
    }
}

interface OwnerRecord {
    pid: number;
    token: string;
    acquiredAt: number;
}

const LEGACY_OWNER_FILE = 'owner.json';
const OWNER_FILE_PATTERN = /^owner-[a-f0-9-]{36}\.json$/;

function readOwner(lockPath: string): { name: string; record: OwnerRecord | null } | undefined {
    try {
        const name = fs.readdirSync(lockPath).find(entry => entry === LEGACY_OWNER_FILE || OWNER_FILE_PATTERN.test(entry));
        if (!name) return undefined;
        const raw = fs.readFileSync(path.join(lockPath, name), 'utf8');
        try {
            const parsed = JSON.parse(raw) as OwnerRecord;
            if (typeof parsed?.token === 'string' && Number.isFinite(parsed.acquiredAt)) return { name, record: parsed };
        } catch { /* An interrupted owner write can leave malformed JSON. */ }
        return { name, record: null };
    } catch {
        return undefined;
    }
}

function ownerIsGone(owner: OwnerRecord): boolean {
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function sameDirectory(lockPath: string, original: fs.Stats): boolean {
    const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    return Boolean(current?.isDirectory() && current.dev === original.dev && current.ino === original.ino
        && current.birthtimeMs === original.birthtimeMs);
}

function removeEmptyLock(lockPath: string, directory: fs.Stats): boolean {
    if (!sameDirectory(lockPath, directory)) return false;
    fs.rmdirSync(lockPath);
    return true;
}

function isRemovalBusy(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

function claimStaleLock(lockPath: string, opts: LockOptions, now: number, staleMs: number): fs.Stats | undefined {
    try {
        const directory = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (!directory?.isDirectory()) return undefined;
        const seen = readOwner(lockPath);
        if (seen?.record) {
            const stale = opts.recoverDeadOwner ? ownerIsGone(seen.record) : now - seen.record.acquiredAt > staleMs;
            if (!stale) return undefined;
        } else if (now - directory.mtimeMs <= staleMs) return undefined;
        // Previous versions used a fixed file name. Recheck that legacy
        // record before unlinking it. New holders publish a unique filename.
        if (seen?.name === LEGACY_OWNER_FILE) {
            const current = readOwner(lockPath);
            if (current?.name !== seen.name || current.record?.token !== seen.record?.token) return undefined;
        }
        if (seen) {
            if (!sameDirectory(lockPath, directory)) return undefined;
            // ENOENT means a different contender already removed this
            // marker. Leave directory removal to that contender.
            fs.unlinkSync(path.join(lockPath, seen.name));
        } else if (readOwner(lockPath)) {
            // A holder may have published its owner since the first read.
            return undefined;
        }
        return directory;
    } catch {
        // The acquisition loop rechecks the owner after transient errors.
        return undefined;
    }
}

/**
 * Run `fn` after acquiring the directory and writing our owner file. The
 * release path retries transient filesystem errors using the unique name.
 */
export async function withDirectoryLock<T>(lockPath: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const staleMs = opts.staleMs ?? 120_000;
    const sleepMs = opts.sleepMs ?? 25;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.nowMs ?? (() => Date.now());
    opts.signal?.throwIfAborted();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const token = randomUUID();
    const ownerFile = path.join(lockPath, `owner-${token}.json`);
    const deadline = now() + timeoutMs;
    let recovering: fs.Stats | undefined;
    for (;;) {
        opts.signal?.throwIfAborted();
        try {
            fs.mkdirSync(lockPath);
            break;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST'
                && !(process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'))) throw error;
        }
        recovering ??= claimStaleLock(lockPath, opts, now(), staleMs);
        let recovered = false;
        if (recovering) {
            try {
                recovered = removeEmptyLock(lockPath, recovering);
                recovering = undefined;
            } catch (error) {
                // Keep the claimed identity across a busy rmdir. The marker
                // is already gone and should not have to age out again.
                if (!isRemovalBusy(error)) recovering = undefined;
            }
        }
        if (now() >= deadline) throw new LockTimeoutError(lockPath);
        if (!recovered) await abortable(sleep(sleepMs), opts.signal);
    }

    const directory = fs.lstatSync(lockPath);
    let ownerWritten = false;
    let ownerRemoved = false;
    try {
        fs.writeFileSync(ownerFile, JSON.stringify({
            pid: process.pid, token, acquiredAt: now(),
        } satisfies OwnerRecord), { flag: 'wx' });
        ownerWritten = true;

        opts.signal?.throwIfAborted();
        return await fn();
    } finally {
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                if (!sameDirectory(lockPath, directory)) break;
                if (!ownerRemoved) {
                    try { fs.unlinkSync(ownerFile); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ownerWritten) throw error;
                    }
                    ownerRemoved = true;
                }
                removeEmptyLock(lockPath, directory);
                break;
            } catch (error) {
                if (attempt === 5 || !isRemovalBusy(error)) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }
}

/** Cancel a caller's wait without leaving an abort listener behind. */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) {
        void work.catch(() => undefined);
        signal.throwIfAborted();
    }
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([work, cancelled]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

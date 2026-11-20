/**
 * Cross-process directory mutex for rotating OAuth tokens and persisted state.
 * A contender writes its unique owner file in a private directory, then
 * publishes the populated directory with a same-filesystem rename. A published
 * lock is nonempty, so another contender cannot replace it.
 *
 * To release or recover a lock, unlink only the observed owner's filename,
 * then remove the directory if it is empty. A delayed contender may reach a
 * replacement directory, but its different owner filename keeps it nonempty.
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
        } catch { /* An interrupted legacy write can leave malformed JSON. */ }
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

function removeLock(lockPath: string, ownerFile?: string): void {
    if (!fs.lstatSync(lockPath, { throwIfNoEntry: false })?.isDirectory()) return;
    if (ownerFile) {
        try { fs.unlinkSync(path.join(lockPath, ownerFile)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { fs.rmdirSync(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function tryRecoverLock(lockPath: string, opts: LockOptions, now: number, staleMs: number): boolean {
    try {
        const directory = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (!directory?.isDirectory()) return false;
        const seen = readOwner(lockPath);
        if (seen?.record) {
            const stale = opts.recoverDeadOwner ? ownerIsGone(seen.record) : now - seen.record.acquiredAt > staleMs;
            if (!stale) return false;
        } else if (now - directory.mtimeMs <= staleMs) return false;
        // Previous versions used a fixed file name. Recheck that legacy
        // record before unlinking it. New holders publish a unique filename.
        if (seen?.name === LEGACY_OWNER_FILE) {
            const current = readOwner(lockPath);
            if (current?.name !== seen.name || current.record?.token !== seen.record?.token) return false;
        }
        removeLock(lockPath, seen?.name);
        return true;
    } catch {
        // A replacement is nonempty, and transient filesystem failures can
        // be retried by the same bounded acquisition loop.
        return false;
    }
}

/**
 * Run `fn` while the populated directory at `lockPath` holds our owner file.
 * The release path retries transient filesystem errors using the unique name.
 */
export async function withDirectoryLock<T>(lockPath: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const staleMs = opts.staleMs ?? 120_000;
    const sleepMs = opts.sleepMs ?? 25;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.nowMs ?? (() => Date.now());
    opts.signal?.throwIfAborted();
    const parent = path.dirname(lockPath);
    fs.mkdirSync(parent, { recursive: true });

    const token = randomUUID();
    const ownerFile = `owner-${token}.json`;
    const deadline = now() + timeoutMs;
    let prepared: string | undefined;
    let acquired = false;
    try {
        for (;;) {
            opts.signal?.throwIfAborted();
            try {
                // Respect the grace period for legacy empty directories.
                // If another contender publishes after this lookup, rename
                // cannot replace its nonempty directory.
                if (!fs.lstatSync(lockPath, { throwIfNoEntry: false })) {
                    prepared ??= fs.mkdtempSync(path.join(parent, '.lock-'));
                    fs.writeFileSync(path.join(prepared, ownerFile), JSON.stringify({
                        pid: process.pid, token, acquiredAt: now(),
                    } satisfies OwnerRecord));
                    fs.renameSync(prepared, lockPath);
                    acquired = true;
                    break;
                }
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'EEXIST' && code !== 'ENOTEMPTY'
                    && !(process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'))) throw error;
            }
            const recovered = tryRecoverLock(lockPath, opts, now(), staleMs);
            if (now() >= deadline) throw new LockTimeoutError(lockPath);
            if (!recovered) await abortable(sleep(sleepMs), opts.signal);
        }

        opts.signal?.throwIfAborted();
        return await fn();
    } finally {
        const directory = acquired ? lockPath : prepared;
        for (let attempt = 0; directory && attempt < 6; attempt++) {
            try {
                removeLock(directory, ownerFile);
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (attempt === 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) break;
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

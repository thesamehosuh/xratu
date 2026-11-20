/**
 * Cross-process directory mutex for rotating OAuth tokens and persisted state.
 * Every version acquires the same path with an atomic mkdir. Each new
 * holder writes a unique owner file before entering its critical section.
 *
 * Cleanup claims serialize removal of a directory generation, including a
 * directory which has no owner file. The live lock path always uses mkdir
 * because older hosts can reserve it before writing an owner file.
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

function processIsGone(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function sameDirectory(lockPath: string, original: fs.BigIntStats): boolean {
    const current = fs.lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
    return Boolean(current?.isDirectory() && current.dev === original.dev && current.ino === original.ino
        && current.birthtimeNs === original.birthtimeNs);
}

function removeEmptyLock(lockPath: string, directory: fs.BigIntStats): boolean {
    if (!sameDirectory(lockPath, directory)) return false;
    fs.rmdirSync(lockPath);
    return true;
}

function isRemovalBusy(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY';
}

interface RemovalClaim {
    path: string;
    abandoned: string[];
}

/** Each claim is published populated. A subsequent claim uses the next slot
 * only when the recorded process has died or explicitly released its slot. */
function claimRemoval(lockPath: string, directory: fs.BigIntStats): RemovalClaim | undefined {
    if (!sameDirectory(lockPath, directory)) return undefined;
    const parent = path.dirname(lockPath);
    const generation = createHash('sha256').update(`${directory.dev}:${directory.ino}:${directory.birthtimeNs}`)
        .digest('hex').slice(0, 24);
    const abandoned: string[] = [];
    for (let slot = 0; ; slot++) {
        const claim = path.join(parent, `.xratu-lock-removal-${generation}-${slot}`);
        let entries: string[];
        try { entries = fs.readdirSync(claim); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            entries = [];
        }
        if (entries.length) {
            const pid = Number(entries.find(entry => /^\d+$/.test(entry)));
            if (!entries.includes('released') && !processIsGone(pid)) return undefined;
            abandoned.push(claim);
            continue;
        }

        // Only our protocol creates claim paths, and always makes them
        // nonempty before publishing them. Rename cannot replace a live claim.
        const prepared = fs.mkdtempSync(path.join(parent, '.xratu-lock-claim-'));
        let published = false;
        try {
            fs.writeFileSync(path.join(prepared, String(process.pid)), '');
            fs.renameSync(prepared, claim);
            published = true;
            return { path: claim, abandoned };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST' || isRemovalBusy(error)) return undefined;
            throw error;
        } finally {
            if (!published) fs.rmSync(prepared, { recursive: true, force: true });
        }
    }
}

function finishRemoval(claim: RemovalClaim, removed: boolean): void {
    // Earlier slots must remain visible while this generation can still be
    // touched. Removing one early could admit a second live remover there.
    for (const entry of removed ? [claim.path, ...claim.abandoned] : [claim.path]) {
        const retired = path.join(path.dirname(entry), `.xratu-lock-retired-${randomUUID()}`);
        try {
            fs.renameSync(entry, retired);
        } catch {
            // If a rename is temporarily blocked, let the next remover skip
            // this slot. This holder has finished all work on the lock path.
            try { fs.mkdirSync(path.join(entry, 'released')); } catch { /* Best effort. */ }
            continue;
        }
        try { fs.rmSync(retired, { recursive: true, force: true }); } catch { /* The claim is already retired. */ }
    }
}

interface StaleRemoval {
    directory: fs.BigIntStats;
    claim: RemovalClaim;
}

function claimStaleLock(lockPath: string, opts: LockOptions, now: number, staleMs: number): StaleRemoval | undefined {
    let claim: RemovalClaim | undefined;
    let prepared = false;
    try {
        const directory = fs.lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
        if (!directory?.isDirectory()) return undefined;
        const seen = readOwner(lockPath);
        if (seen?.record) {
            const stale = opts.recoverDeadOwner ? processIsGone(seen.record.pid) : now - seen.record.acquiredAt > staleMs;
            if (!stale) return undefined;
        } else if (now - Number(directory.mtimeMs) <= staleMs) return undefined;

        claim = claimRemoval(lockPath, directory);
        if (!claim || !sameDirectory(lockPath, directory)) return undefined;
        const current = readOwner(lockPath);
        if (current?.name !== seen?.name || current?.record?.token !== seen?.record?.token) return undefined;
        if (seen) fs.unlinkSync(path.join(lockPath, seen.name));
        prepared = true;
        return { directory, claim };
    } catch {
        // The acquisition loop rechecks the owner after transient errors.
        return undefined;
    } finally {
        if (claim && !prepared) finishRemoval(claim, false);
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
    let recovering: StaleRemoval | undefined;
    try {
        for (;;) {
            opts.signal?.throwIfAborted();
            try {
                fs.mkdirSync(lockPath);
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'EEXIST' && !(process.platform === 'win32' && isRemovalBusy(error))) throw error;
            }
            recovering ??= claimStaleLock(lockPath, opts, now(), staleMs);
            let recovered = false;
            const removal = recovering;
            if (removal) {
                try {
                    recovered = removeEmptyLock(lockPath, removal.directory);
                    finishRemoval(removal.claim, true);
                    recovering = undefined;
                } catch (error) {
                    // Hold the claim while retrying a busy empty directory.
                    if (!isRemovalBusy(error)) {
                        finishRemoval(removal.claim, false);
                        recovering = undefined;
                    }
                }
            }
            if (now() >= deadline) throw new LockTimeoutError(lockPath);
            if (!recovered) await abortable(sleep(sleepMs), opts.signal);
        }
    } finally {
        if (recovering) finishRemoval(recovering.claim, false);
    }

    const directory = fs.lstatSync(lockPath, { bigint: true });
    let ownerWritten = false;
    let ownerRemoved = false;
    let removed = false;
    let claim: RemovalClaim | undefined;
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
                if (!sameDirectory(lockPath, directory)) { removed = true; break; }
                claim ??= claimRemoval(lockPath, directory);
                if (claim) {
                    if (!ownerRemoved) {
                        try { fs.unlinkSync(ownerFile); }
                        catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ownerWritten) throw error;
                        }
                        ownerRemoved = true;
                    }
                    removeEmptyLock(lockPath, directory);
                    removed = true;
                    break;
                }
            } catch (error) {
                if (!isRemovalBusy(error)) break;
            }
            if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (claim) finishRemoval(claim, removed);
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

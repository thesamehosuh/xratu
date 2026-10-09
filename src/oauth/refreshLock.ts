/**
 * Cross-process refresh lock - a directory mutex (mkdir is atomic on both
 * POSIX and Windows, which O_EXCL file-create is not quite).
 *
 * Why this exists: refresh tokens ROTATE. Two VS Code windows sharing one
 * credential store will burn each other's tokens when both refresh at once -
 * one window's stored refresh token dies the moment the other's succeeds
 * (Roo's cross-window brick; opencode documents it as a "known cross-process
 * limitation"). The lock serializes refreshes so the second caller re-reads
 * the rotated token instead of replaying the old one.
 *
 * Why mkdir + owner-token compare instead of alternatives:
 *  - Cline uses SQLite BEGIN EXCLUSIVE - strongest option, but requires a
 *    native dependency this extension does not otherwise need.
 *  - Codex's flock is not portable to Windows from pure Node.
 *  - mkdir gives an atomic acquire on every supported platform.
 *
 * Stale takeover: a holder that crashes leaves the directory behind, so an
 * owner.json {pid, token, acquiredAt} is written inside; a waiter whose
 * deadline passes the staleness threshold removes the directory ONLY IF the
 * owner token it re-read still matches what it first saw (a changed token
 * means a live holder rewrote it - do not touch). The residual TOCTOU window
 * is milliseconds wide and the cost of a lost race is one extra refresh,
 * which the re-read-compare in the token manager then absorbs. Documented
 * honestly rather than pretending to be a perfect mutex.
 *
 * The lock directory contains NO credentials - only the hashed storage key
 * in its name.
 */
import { createHash } from 'crypto';
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

const OWNER_FILE = 'owner.json';

function readOwner(lockPath: string): OwnerRecord | null {
    try {
        const raw = fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf8');
        const parsed = JSON.parse(raw) as OwnerRecord;
        if (typeof parsed?.token !== 'string' || typeof parsed?.acquiredAt !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

/** Age of the lock directory itself, used when its owner record is missing or
 *  unreadable. 0 when it cannot be stat'ed (never treated as stale). */
function dirAgeMs(lockPath: string, nowMs: number): number {
    try {
        return nowMs - fs.statSync(lockPath).mtimeMs;
    } catch {
        return 0;
    }
}

/** Remove the lock directory ONLY if the owner record still matches what we
 *  saw. A live holder that rewrote its record between our read and our rm is
 *  not stale - this compare is what keeps takeover from becoming theft. */
function rmIfOwnerUnchanged(lockPath: string, seen: OwnerRecord): void {
    const current = readOwner(lockPath);
    if (!current || current.token !== seen.token) return;
    try {
        fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
        // Best effort: if the rm fails the next acquire loop re-evaluates.
    }
}

/** Reap an ownerless lock directory. There is no token to compare, so the
 *  guard is the directory's mtime: if it changed since we measured its age,
 *  something recreated or touched it and this is not the abandoned directory
 *  we measured. mkdir arbitration then settles any residual race - the loser
 *  gets EEXIST and retries. */
function removeIfUnchanged(lockPath: string, measuredAgeMs: number, nowMs: number): void {
    if (readOwner(lockPath)) return;
    const age = dirAgeMs(lockPath, nowMs);
    if (age === 0 || Math.abs(age - measuredAgeMs) > 1) return;
    try {
        fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
        // Best effort: the acquire loop re-evaluates.
    }
}

/**
 * Run `fn` while holding the directory lock at `lockPath`. The lock is
 * released in a finally, so a throw inside `fn` cannot leak it (the stale
 * path exists for process death, not for ordinary errors).
 */
export async function withDirectoryLock<T>(lockPath: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const staleMs = opts.staleMs ?? 120_000;
    const sleepMs = opts.sleepMs ?? 25;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = opts.nowMs ?? (() => Date.now());
    opts.signal?.throwIfAborted();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const token = `${process.pid}:${now()}:${Math.random().toString(36).slice(2)}`;
    const deadline = now() + timeoutMs;
    let firstSeenOwner: OwnerRecord | null = null;

    for (;;) {
        opts.signal?.throwIfAborted();
        try {
            fs.mkdirSync(lockPath);
            break; // acquired
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        }

        const owner = readOwner(lockPath);
        if (!firstSeenOwner && owner) firstSeenOwner = owner;
        const seen = owner ?? firstSeenOwner;
        // A holder that died between mkdir and the owner write leaves a
        // directory with NO record - keying staleness off the record alone
        // would wedge the lock forever (every waiter just times out). Age such
        // a directory by its mtime instead, and only reap it once it is well
        // past the grace period, so a live holder that has not written its
        // record yet is never taken from.
        const measuredAt = now();
        const acquiredAge = dirAgeMs(lockPath, measuredAt);
        const isStale = seen ? measuredAt - seen.acquiredAt > staleMs : acquiredAge > staleMs;
        if (isStale) {
            if (seen) rmIfOwnerUnchanged(lockPath, seen);
            else removeIfUnchanged(lockPath, acquiredAge, measuredAt);
            firstSeenOwner = null;
            continue;
        }

        if (now() >= deadline) throw new LockTimeoutError(lockPath);
        await abortable(sleep(sleepMs), opts.signal);
    }

    const acquiredStat = fs.statSync(lockPath);
    let ownerWritten = false;
    try {
        fs.writeFileSync(path.join(lockPath, OWNER_FILE), JSON.stringify({
            pid: process.pid,
            token,
            acquiredAt: now(),
        } satisfies OwnerRecord));
        ownerWritten = true;
    } catch {
        // A missing owner record makes us look stale to others. Acceptable:
        // the record exists to detect DEAD holders, and a live holder without
        // one is still protected by the directory's mere existence until
        // staleMs passes. Writing must never fail the lock itself.
    }

    try {
        opts.signal?.throwIfAborted();
        return await fn();
    } finally {
        try {
            const owner = readOwner(lockPath);
            const currentStat = fs.statSync(lockPath);
            if (owner?.token === token || (!ownerWritten && !owner
                && currentStat.ino === acquiredStat.ino && currentStat.birthtimeMs === acquiredStat.birthtimeMs)) {
                fs.rmSync(lockPath, { recursive: true, force: true });
            }
        } catch {
            // Process is exiting or the FS is misbehaving; the stale path
            // recovers this for the next caller.
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

/**
 * Persistence for background jobs, so a window reload does not orphan them.
 *
 * A background job is a process the user deliberately asked to keep running.
 * Without a checkpoint, reloading the window (or a crash) loses every handle:
 * the processes go on holding their ports, and there is no longer ANY way to
 * stop them from the extension - `killTree` needs a pid, and the pid was only
 * ever in memory. That is the failure this file exists to prevent.
 *
 * Two rules make the checkpoint safe to act on:
 *
 *  - a job is stored with its PROCESS IDENTITY (pid + kernel start token), not
 *    a bare pid, because pid numbers are recycled - see processIdentity.ts;
 *  - writing is atomic (tmp + rename), so a crash mid-write leaves the previous
 *    good file rather than a truncated one that parses into half a job list.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { renameWithRetry } from '../local/localSessionStore';
import { isOurProcess } from './processIdentity';
import type { BackgroundJobRecord } from './backgroundJobs';

/** Jobs whose recorded process is gone, or whose record is malformed. */
export interface ReconcileResult {
    /** Still the same incarnation we spawned - adoptable, and killable. */
    alive: BackgroundJobRecord[];
    /** Finished, vanished, or unparseable: dropped. */
    dropped: string[];
}

const FILE_NAME = 'background-jobs.json';
/** Records older than this are not worth adopting - a week-old dev server is
 *  not something to offer the user as "still running". */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function isBackgroundJobRecord(value: unknown): value is BackgroundJobRecord {
    if (!value || typeof value !== 'object') return false;
    const j = value as Record<string, unknown>;
    const identity = j.identity as { pid?: unknown; token?: unknown } | undefined;
    return typeof j.id === 'string'
        && typeof j.command === 'string'
        && typeof j.startedAt === 'number'
        && typeof identity?.pid === 'number'
        && typeof identity?.token === 'string';
}

export class BackgroundJobStore {
    private readonly file: string;
    /** Serializes writes so two concurrent saves cannot interleave a tmp file. */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(storageDir: string) {
        this.file = path.join(storageDir, FILE_NAME);
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        // Keep the chain alive after a rejection: one failed save must not
        // wedge every later one.
        this.queue = next.catch(() => undefined);
        return next;
    }

    /** Best-effort save. A checkpoint that cannot be written must never fail
     *  the tool call that triggered it - the process is already running. */
    /**
     * Write the checkpoint.
     *
     * MERGED, not replaced. Every VS Code window has its own extension host but
     * they share one globalStorage dir, so writing only this window's jobs let
     * the next window to save delete another window's records - and the
     * processes behind them became orphans no window could stop, which is the
     * failure this file exists to prevent. Records we did not write are carried
     * over untouched; ours win on an id collision, since our view is the live
     * one.
     */
    async save(jobs: readonly BackgroundJobRecord[]): Promise<void> {
        return this.enqueue(async () => {
            const dir = path.dirname(this.file);
            await fs.mkdir(dir, { recursive: true });
            const mine = new Map(jobs.map((j) => [j.id, j]));
            const merged: BackgroundJobRecord[] = [...mine.values()];
            for (const entry of await this._readRecords()) {
                // Carry over only well-formed records; a malformed one is
                // already unusable and merging it back would keep it forever.
                if (!isBackgroundJobRecord(entry) || mine.has(entry.id)) continue;
                merged.push(entry);
            }
            // Scoped to THIS process: two VS Code windows share one
            // globalStorage dir, and a fixed tmp name let them interleave a
            // half-written file that `load` would then discard wholesale.
            const temp = `${this.file}.${process.pid}.tmp`;
            await fs.writeFile(temp, JSON.stringify({ version: 1, jobs: merged }), 'utf8');
            await renameWithRetry(temp, this.file);
        }).catch(() => undefined);
    }

    /**
     * Parse the checkpoint, tolerating absence, corruption and a BOM.
     *
     * A read helper rather than inline JSON.parse so `save` can merge with what
     * is already on disk, and so one place owns the BOM strip.
     */
    private async _readRecords(): Promise<unknown[]> {
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            // Strip a BOM first. This file lives in globalStorage on a
            // Windows-first product, and one Notepad round-trip would
            // otherwise make JSON.parse throw and silently drop EVERY
            // recovery record - the same class of bug mcpConfig.ts guards.
            const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
            const list = (parsed as { jobs?: unknown })?.jobs;
            return Array.isArray(list) ? list : [];
        } catch {
            // No file, or an unreadable one. Either way there is nothing to
            // carry over, and a corrupt checkpoint must not block activation
            // or a save.
            return [];
        }
    }

    /**
     * Read the checkpoint and decide what is still real.
     *
     * Identity is re-verified here rather than trusted: a pid that is merely
     * ALIVE is not proof (see processIdentity.ts), and a record whose token no
     * longer matches is a recycled number that must never be adopted or killed.
     *
     * Synchronous verification, at activation only: we cannot adopt a job
     * without knowing it is ours, and there are at most a handful of records.
     */
    async load(now = Date.now()): Promise<ReconcileResult> {
        const alive: BackgroundJobRecord[] = [];
        const dropped: string[] = [];
        for (const entry of await this._readRecords()) {
            if (!isBackgroundJobRecord(entry)) {
                // Counted rather than silently skipped, so a checkpoint that
                // has gone bad is visible instead of looking merely empty.
                dropped.push('malformed');
                continue;
            }
            // A record of a process that already exited carries no handle worth
            // keeping: there is nothing left to stop.
            if (entry.status !== 'running') {
                dropped.push(entry.id);
                continue;
            }
            // Identity is the ONLY gate. An age limit used to drop a running
            // record older than a week even when the identity verified, which is
            // backwards: a long-lived database is exactly the case where the
            // user still needs the stop handle, and dropping it left a live
            // process that no window could signal. Age only prunes records we
            // could never have adopted anyway.
            if (!isOurProcess(entry.identity)) {
                dropped.push(entry.id);
                continue;
            }
            if (now - entry.startedAt > MAX_AGE_MS) {
                dropped.push(entry.id);
                continue;
            }
            alive.push(entry);
        }
        return { alive, dropped };
    }

    async clear(): Promise<void> {
        return this.enqueue(async () => {
            await fs.rm(this.file, { force: true });
        }).catch(() => undefined);
    }
}
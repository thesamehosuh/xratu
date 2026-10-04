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
    async save(jobs: readonly BackgroundJobRecord[]): Promise<void> {
        return this.enqueue(async () => {
            const dir = path.dirname(this.file);
            await fs.mkdir(dir, { recursive: true });
            // Scoped to THIS process: two VS Code windows share one
            // globalStorage dir, and a fixed tmp name let them interleave a
            // half-written file that `load` would then discard wholesale.
            const temp = `${this.file}.${process.pid}.tmp`;
            await fs.writeFile(temp, JSON.stringify({ version: 1, jobs }), 'utf8');
            await renameWithRetry(temp, this.file);
        }).catch(() => undefined);
    }

    /**
     * Read the checkpoint and decide what is still real.
     *
     * Identity is re-verified here rather than trusted: a pid that is merely
     * ALIVE is not proof (see processIdentity.ts), and a record whose token no
     * longer matches is a recycled number that must never be adopted or killed.
     */
    async load(now = Date.now()): Promise<ReconcileResult> {
        const alive: BackgroundJobRecord[] = [];
        const dropped: string[] = [];
        let parsed: unknown;
        try {
            const raw = await fs.readFile(this.file, 'utf8');
            // Strip a BOM first. This file lives in globalStorage on a
            // Windows-first product, and one Notepad round-trip would
            // otherwise make JSON.parse throw and silently drop EVERY
            // recovery record - the same class of bug mcpConfig.ts guards.
            parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch {
            // No file, or an unreadable one. Either way there is nothing to
            // adopt and nothing to report - a corrupt checkpoint must not block
            // activation.
            return { alive, dropped };
        }
        const list = (parsed as { jobs?: unknown })?.jobs;
        if (!Array.isArray(list)) return { alive, dropped };
        for (const entry of list) {
            if (!isBackgroundJobRecord(entry)) {
                dropped.push('malformed');
                continue;
            }
            if (now - entry.startedAt > MAX_AGE_MS) {
                dropped.push(entry.id);
                continue;
            }
            // A record of a process that already exited carries no handle worth
            // keeping: there is nothing left to stop.
            if (entry.status !== 'running') {
                dropped.push(entry.id);
                continue;
            }
            if (!isOurProcess(entry.identity)) {
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
import * as fs from 'fs/promises';
import * as path from 'path';
import { renameWithRetry } from './localSessionStore';

/**
 * Global, timestamped usage ledger.
 *
 * One entry per non-estimated model round: when it happened, which provider
 * host and model served it, the tokens it cost, and the cost as resolved at
 * that moment. It is deliberately APPEND-ONLY and machine-global (not
 * per-session) because:
 *  - the Pricing page's daily chart needs a time series, and a session's
 *    totals span many days, so per-session snapshots cannot be bucketed;
 *  - a price edit can only be applied retroactively if each round's tokens
 *    were recorded separately.
 *
 * The storage file is JSONL: a crash mid-append loses at most the last line,
 * and readers skip malformed lines instead of failing the whole ledger.
 *
 * Pure helpers (parsing, bucketing, pruning, recompute) live here with the
 * store so both are unit-testable.
 */

export interface UsageEntry {
    /** Epoch ms of the round. */
    ts: number;
    /** Session the round belonged to (null when unknown). */
    sessionId: string | null;
    /** Provider base-URL host ('' when unknown). */
    host: string;
    /** Model id as requested. */
    model: string;
    input: number;
    output: number;
    cached: number;
    /** Cost amount in `currency`, or null when no price was known. */
    amount: number | null;
    currency: 'USD' | 'IRT' | null;
}

/** Token + per-currency cost totals for a set of entries. */
export interface UsageTotals {
    input: number;
    output: number;
    cached: number;
    USD: number;
    IRT: number;
}

/** Ledger retention: older entries are pruned, and the file is capped. */
export const USAGE_RETENTION_DAYS = 120;
export const USAGE_MAX_ENTRIES = 5000;
/** Days returned to the chart (the UI filters down from here). */
export const USAGE_CHART_DAYS = 90;
/** Appends between automatic compactions (bounds the file without rewriting
 *  it every round). */
const COMPACT_EVERY = 200;

const MS_PER_DAY = 86_400_000;

/** LOCAL calendar day key (never UTC: buckets must match the user's clock). */
export function dayKey(ts: number): string {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

function finiteCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Tolerantly coerce one parsed JSON line into an entry (null = drop it). */
export function normalizeEntry(raw: unknown): UsageEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const ts = typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : null;
    if (ts == null) return null;
    const model = typeof e.model === 'string' ? e.model : '';
    const host = typeof e.host === 'string' ? e.host : '';
    const currency = e.currency === 'USD' || e.currency === 'IRT' ? e.currency : null;
    const amount = currency && typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount >= 0
        ? e.amount
        : null;
    return {
        ts,
        sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
        host,
        model,
        input: finiteCount(e.input),
        output: finiteCount(e.output),
        cached: finiteCount(e.cached),
        amount,
        currency: amount != null ? currency : null,
    };
}

/** Parse a JSONL ledger, skipping a BOM, blank lines and malformed lines. */
export function parseLedger(text: string): UsageEntry[] {
    const out: UsageEntry[] = [];
    for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        try {
            const entry = normalizeEntry(JSON.parse(line));
            if (entry) out.push(entry);
        } catch {
            // A torn write or hand-edit: drop the line, keep the ledger.
        }
    }
    return out;
}

export function serializeLedger(entries: readonly UsageEntry[]): string {
    return entries.length ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
}

/** Drop entries past the retention window, then cap to the newest N. */
export function pruneEntries(
    entries: readonly UsageEntry[],
    now: number = Date.now(),
    maxAgeDays: number = USAGE_RETENTION_DAYS,
    maxEntries: number = USAGE_MAX_ENTRIES,
): UsageEntry[] {
    const cutoff = now - maxAgeDays * MS_PER_DAY;
    const fresh = entries.filter((e) => e.ts >= cutoff);
    return fresh.length > maxEntries ? fresh.slice(fresh.length - maxEntries) : fresh;
}

/** Tokens + per-currency cost for a set of entries. */
export function sumUsage(entries: readonly UsageEntry[]): UsageTotals {
    const totals: UsageTotals = { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
    for (const e of entries) {
        totals.input += e.input;
        totals.output += e.output;
        totals.cached += e.cached;
        if (e.amount != null && e.currency) totals[e.currency] += e.amount;
    }
    return totals;
}

export function entriesForSession(entries: readonly UsageEntry[], sessionId: string | null): UsageEntry[] {
    if (!sessionId) return [];
    return entries.filter((e) => e.sessionId === sessionId);
}

/**
 * Re-resolve the cost of ledger entries (all, or just one model) after a price
 * change. Tokens are untouched - only `amount`/`currency` follow the new price.
 */
export function recomputeCosts(
    entries: readonly UsageEntry[],
    resolve: (entry: UsageEntry) => { amount: number; currency: 'USD' | 'IRT' } | null,
    onlyModel?: string,
): { entries: UsageEntry[]; changed: boolean } {
    const key = onlyModel?.trim().toLowerCase();
    let changed = false;
    const next = entries.map((entry) => {
        if (key && entry.model.trim().toLowerCase() !== key) return entry;
        const resolved = resolve(entry);
        const amount = resolved ? resolved.amount : null;
        const currency = resolved ? resolved.currency : null;
        if (amount !== entry.amount || currency !== entry.currency) changed = true;
        return { ...entry, amount, currency };
    });
    return { entries: next, changed };
}

/** One (day, model, host) aggregation cell for the cost chart. */
export interface LedgerCell {
    model: string;
    host: string;
    input: number;
    output: number;
    cached: number;
    USD: number;
    IRT: number;
}

/** A day with usage, sparse: only cells that actually saw traffic. */
export interface LedgerDay {
    /** Local day, YYYY-MM-DD. */
    day: string;
    cells: LedgerCell[];
}

/** All-time totals for one provider host (the provider usage list). */
export interface HostTotals {
    host: string;
    input: number;
    output: number;
    cached: number;
    USD: number;
    IRT: number;
}

/**
 * Sparse per-day / per-model / per-host aggregation for the trailing `days`.
 * Sparse because the chart is filtered CLIENT-side (month, model, provider),
 * so shipping only non-empty cells keeps the message small.
 */
export function aggregateByDayAndModel(
    entries: readonly UsageEntry[],
    days: number = USAGE_CHART_DAYS,
    now: number = Date.now(),
): LedgerDay[] {
    // YYYY-MM-DD keys compare correctly as strings, so this is a plain cutoff.
    const cutoff = dayKey(now - (Math.max(1, Math.floor(days)) - 1) * MS_PER_DAY);
    const byDay = new Map<string, Map<string, LedgerCell>>();
    for (const entry of entries) {
        const day = dayKey(entry.ts);
        if (day < cutoff) continue;
        let cells = byDay.get(day);
        if (!cells) {
            cells = new Map();
            byDay.set(day, cells);
        }
        // NUL cannot appear in a model id or host, so this key is collision-free.
        const key = `${entry.model}\u0000${entry.host}`;
        let cell = cells.get(key);
        if (!cell) {
            cell = { model: entry.model, host: entry.host, input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
            cells.set(key, cell);
        }
        cell.input += entry.input;
        cell.output += entry.output;
        cell.cached += entry.cached;
        if (entry.amount != null && entry.currency) cell[entry.currency] += entry.amount;
    }
    return [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([day, cells]) => ({ day, cells: [...cells.values()] }));
}

/** All-time totals per provider host, busiest first. */
export function totalsByHost(entries: readonly UsageEntry[]): HostTotals[] {
    const byHost = new Map<string, HostTotals>();
    for (const entry of entries) {
        const host = entry.host || '';
        let totals = byHost.get(host);
        if (!totals) {
            totals = { host, input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
            byHost.set(host, totals);
        }
        totals.input += entry.input;
        totals.output += entry.output;
        totals.cached += entry.cached;
        if (entry.amount != null && entry.currency) totals[entry.currency] += entry.amount;
    }
    return [...byHost.values()].sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

/**
 * Append-only ledger on disk. Writes are serialized (one writer at a time) and
 * rewrites are atomic (temp + rename), so a crash never leaves a half file.
 */
export class UsageLedgerStore {
    private readonly file: string;
    private _writeQueue: Promise<unknown> = Promise.resolve();
    private _appendsSinceCompaction = 0;

    constructor(storageRoot: string) {
        this.file = path.join(storageRoot, 'usage-ledger.jsonl');
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._writeQueue.then(fn, fn);
        this._writeQueue = run.catch(() => undefined);
        return run;
    }

    async read(): Promise<UsageEntry[]> {
        try {
            return parseLedger(await fs.readFile(this.file, 'utf8'));
        } catch {
            // Missing ledger is the normal first-run state.
            return [];
        }
    }

    /** Append one round; auto-compacts so the file stays bounded. */
    async append(entry: UsageEntry): Promise<void> {
        await this.enqueue(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
            this._appendsSinceCompaction += 1;
            if (this._appendsSinceCompaction >= COMPACT_EVERY) {
                this._appendsSinceCompaction = 0;
                await this.compactLocked();
            }
        });
    }

    /** Replace the whole ledger (pruned) - used by cost recomputation. */
    async replace(entries: readonly UsageEntry[]): Promise<void> {
        await this.enqueue(async () => {
            await this.writeLocked(pruneEntries(entries));
        });
    }

    /**
     * Atomic read-modify-write inside the write queue. A plain `read()` then
     * `replace()` is racy: a round appended between the two would be written
     * away, losing real usage. Also compacts in the same critical section.
     */
    async update(
        transform: (entries: UsageEntry[]) => { entries: UsageEntry[]; changed: boolean },
    ): Promise<{ entries: UsageEntry[]; changed: boolean }> {
        return this.enqueue(async () => {
            const result = transform(await this.read());
            const pruned = pruneEntries(result.entries);
            if (result.changed) await this.writeLocked(pruned);
            return { entries: pruned, changed: result.changed };
        });
    }

    /** Rewrite the ledger with old/overflowing entries dropped. */
    async compact(): Promise<void> {
        await this.enqueue(() => this.compactLocked());
    }

    private async compactLocked(): Promise<void> {
        const pruned = pruneEntries(await this.read());
        await this.writeLocked(pruned);
    }

    private async writeLocked(entries: readonly UsageEntry[]): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.tmp`;
        await fs.writeFile(temp, serializeLedger(entries), 'utf8');
        await renameWithRetry(temp, this.file);
    }
}

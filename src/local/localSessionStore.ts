import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { MAX_STORED_TURNS, boundCarriers, carrierSize, clipHistoryContent, clipJsonValue, clipToolCallArguments, countUserRows, keepLastUserTurns } from './historyBounds';

export interface LocalSessionHistoryMessage {
    role: string;
    content?: string;
    tool_calls?: any[];
    tool_call_id?: string;
    /** Provider-native assistant payload replayed verbatim on the next request
     *  (Anthropic thinking blocks with signatures, Responses reasoning items,
     *  Google model parts). Persisted so a replayed turn is byte-identical to
     *  what the provider cached - reconstruction is lossy and breaks prefix
     *  prompt caching from that message onward. Never clipped: an Anthropic
     *  thinking signature that is truncated is rejected outright. */
    providerBlocks?: unknown;
    /** Chat Completions `reasoning_content` replay carrier (same rationale). */
    reasoningContent?: string;
    /** Tool-row failure flag. The Messages transport maps it to `is_error`;
     *  persisting it keeps the replayed tool row byte-stable. */
    isError?: boolean;
}

/** An interrupted in-flight turn, persisted mid-run so a host crash can
 *  restore it instead of dropping the whole response. */
export interface LocalPendingTurn {
    prompt: string;
    events: any[];
    text: string;
    thinking: string;
    attachments?: Array<{ name: string; mime_type: string; size: number }>;
}

export interface LocalSessionSnapshot {
    /** Workspace folder path the session belongs to (list filtering). */
    workspace?: string;
    model: string | null;
    summary: string | null;
    localHistory: LocalSessionHistoryMessage[];
    uiHistory: any[];
    pendingTurn?: LocalPendingTurn | null;
    /** Cumulative spend for this session in USD. Monotonic: rewinding the
     *  conversation or restoring a checkpoint does NOT refund spent tokens. */
    totalCostUsd?: number;
    /** Cumulative Toman spend (Iranian/gateway providers), tracked separately
     *  from USD - currencies are never converted into one another. */
    totalCostIrt?: number;
    /** Cumulative session TOKEN totals (input/output/cached), monotonic like
     *  the cost ledger - drives the Usage page's usage readout. */
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCachedTokens?: number;
    /** Token totals per provider host, so usage can be attributed per
     *  provider without re-reading the transcript. */
    usageByHost?: Record<string, { input?: number; output?: number; cached?: number }>;
}

/** Slim list entry for the session picker: metadata only, never transcripts. */
export interface LocalSessionMeta {
    id: string;
    title: string;
    workspace: string;
    createdAt: number;
    updatedAt: number;
    /** True once the user renamed the session - auto-derivation stops. */
    renamed?: boolean;
}

/** Cap on the transcript text scanned per session during a search. */
const SEARCH_SCAN_CHARS = 200_000;

/** Event fields that carry visible transcript text. Deliberately EXCLUDES
 *  metadata (`role`, `type`, `id`, `tool`, …) - otherwise searching for
 *  "assistant" would match every session that has an assistant turn. */
const SEARCH_TEXT_FIELDS = ['text', 'output', 'content', 'value'];

/**
 * True when the session's visible transcript contains `needle` (lowercased).
 * Only the known text fields are examined, and each string is sliced to the
 * remaining scan budget BEFORE lowercasing, so a single huge field cannot
 * blow past the per-session cap.
 */
function transcriptMatches(uiHistory: unknown, needle: string): boolean {
    if (!Array.isArray(uiHistory) || !uiHistory.length) return false;
    let scanned = 0;
    for (const event of uiHistory) {
        if (!event || typeof event !== 'object') continue;
        const record = event as Record<string, unknown>;
        for (const field of SEARCH_TEXT_FIELDS) {
            const value = record[field];
            if (typeof value !== 'string' || !value) continue;
            const remaining = SEARCH_SCAN_CHARS - scanned;
            if (remaining <= 0) return false;
            const chunk = value.length > remaining ? value.slice(0, remaining) : value;
            scanned += chunk.length;
            if (chunk.toLowerCase().includes(needle)) return true;
        }
    }
    return false;
}

/**
 * Per-message content FLOOR in the PERSISTED snapshot (chars).
 *
 * Regression (verified from a real snapshot on disk, which contained
 * `[...clipped 41230 chars...]`): this sat at HALF the in-memory floor
 * (`IN_MEMORY_CONTENT_CAP` = 40_000), so a message of 61k chars was stored as
 * 20k. Reloading the window - which happens on every extension reinstall -
 * restored that shortened history, so the context meter dropped by tens of
 * thousands of tokens and then slowly climbed back: exactly the sawtooth
 * reported from dogfooding.
 *
 * `sanitizeSnapshot` now persists at the run's WINDOW-relative cap (the same
 * `contentCapForWindow` memory uses), so a reload restores what memory held.
 * This constant remains the floor for the aggregate-budget scaling and the
 * default when no cap is threaded (see `boundedContentCap`).
 */
const MAX_STORED_CONTENT = 40_000;
const TITLE_MAX_LEN = 48;

/** Windows transient rename failures: an AV scanner or the search indexer can
 *  briefly hold the destination. Retry with backoff before giving up. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
const RENAME_RETRY_DELAYS_MS = [0, 20, 50, 120, 250, 500];

/**
 * `fs.rename` with a short backoff for transient Windows failures. Without
 * this a momentary lock could reject the write and silently drop a turn (the
 * caller only console.errors the save failure).
 *
 * If the destination stays locked through every retry, the error is rethrown.
 * There is deliberately NO in-place copy fallback: overwriting the live file
 * would break the temp+rename atomicity and let a concurrent reader parse a
 * half-written snapshot - worse than a clean, visible save failure.
 *
 * `renameFn` is injectable for tests.
 */
export async function renameWithRetry(
    from: string,
    to: string,
    renameFn: (from: string, to: string) => Promise<void> = fs.rename,
): Promise<void> {
    let lastError: unknown;
    for (const delay of RENAME_RETRY_DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
            await renameFn(from, to);
            return;
        } catch (e) {
            lastError = e;
            const code = (e as NodeJS.ErrnoException)?.code;
            if (!code || !TRANSIENT_RENAME_CODES.has(code)) throw e;
        }
    }
    throw lastError;
}

/** Fallback title: just the folder name - never the full path. */
function workspaceLabel(workspace: string): string {
    const base = path.basename(workspace.trim());
    return base || workspace || 'default';
}

function deriveTitle(firstUserMessage: string | null | undefined, workspace: string): string {
    if (firstUserMessage) {
        const text = firstUserMessage.replace(/\s+/g, ' ').trim();
        if (text) {
            // Truncate by CODE POINTS - UTF-16 slicing splits surrogate
            // pairs (emoji at the boundary renders as a replacement char).
            const chars = Array.from(text);
            return chars.length > TITLE_MAX_LEN ? chars.slice(0, TITLE_MAX_LEN).join('') + '…' : text;
        }
    }
    return workspaceLabel(workspace);
}

/** Host-side title resolution for a loaded snapshot: a stored title that is
 *  still the auto workspace placeholder reads as UNTITLED (null) so the
 *  first user message can name the session. Without this the placeholder
 *  rode back into the host on every restore and was then passed to save()
 *  as renamedTitle - permanently locking every session to its workspace
 *  name. An explicit rename (even TO the workspace name) always wins, and
 *  so does a title that matches what the CURRENT first user message derives
 *  to - a prompt that literally reads like the workspace folder name names
 *  the session legitimately. */
export function resolveSessionTitle(
    title: string | null | undefined,
    renamed: boolean | undefined,
    workspace: string | undefined,
    uiHistory?: any[],
): string | null {
    if (!title) return null;
    if (renamed) return title;
    const ws = workspace ?? 'default';
    // Guard on a NON-null first message: with no user turn, deriveTitle
    // itself falls back to the workspace label and the derived-match below
    // would degenerate into passing the placeholder through.
    const firstMessage = uiHistory?.length ? firstUserText(uiHistory) : null;
    if (firstMessage && title === deriveTitle(firstMessage, ws)) return title;
    return title === workspaceLabel(ws) ? null : title;
}

/** Clamp a persisted per-host usage map: finite, non-negative token counts
 *  only, dropping empty entries so a corrupt snapshot cannot inflate totals. */
function normalizeUsageByHost(raw: unknown): Record<string, { input: number; output: number; cached: number }> {
    if (!raw || typeof raw !== 'object') return {};
    const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
    const out: Record<string, { input: number; output: number; cached: number }> = {};
    for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as { input?: unknown; output?: unknown; cached?: unknown };
        const entry = { input: n(v.input), output: n(v.output), cached: n(v.cached) };
        if (entry.input || entry.output || entry.cached) out[host] = entry;
    }
    return out;
}

/**
 * `contentCap` is the per-message ceiling to PERSIST. Callers pass the same
 * window-relative cap the run keeps in memory (`contentCapForWindow`), so a
 * reload restores exactly what memory held. It used to be a fixed
 * half-of-memory value, which is what silently shortened sessions on every
 * reinstall - verified from a real snapshot containing
 * `[...clipped 41230 chars...]`.
 */
function sanitizeSnapshot(snapshot: LocalSessionSnapshot, contentCap: number = MAX_STORED_CONTENT): LocalSessionSnapshot {
    // Trim BOTH ledgers to the SAME turn boundary. They have different
    // rows-per-turn (localHistory carries tool rows), so slicing each by a row
    // count independently could cut them at different turns - and rewind maps a
    // displayed userIndex to a row in both by counting user rows from the
    // front. The model ledger is normally a SUFFIX of the display turns
    // (in-memory eviction only drops its oldest turns), so the trim keeps the
    // last N turns of each and the offset is derivable from the counts. A
    // malformed ledger with MORE model turns than display turns (unreachable
    // through the normal paths) is repaired to the display boundary here.
    const localTurns = countUserRows(snapshot.localHistory);
    const uiTurns = countUserRows(snapshot.uiHistory);
    // Keep the last MAX_STORED_TURNS display turns, and the model turns that
    // fall inside that same window.
    const keepUi = Math.min(uiTurns, MAX_STORED_TURNS);
    const keepLocal = Math.min(localTurns, keepUi);
    // A ledger with no user turns is left untouched: `keepLastUserTurns(rows, 0)`
    // would wipe assistant-only display rows (legacy/crash snapshots).
    const trimRows = <T extends { role?: string }>(rows: readonly T[], turns: number): T[] =>
        turns === 0 ? rows.slice() : keepLastUserTurns(rows, turns);
    const localRows = trimRows(snapshot.localHistory, keepLocal);
    const uiRows = trimRows(snapshot.uiHistory, keepUi);
    // Provider-native replay carriers feed the NEXT request, so their bytes must
    // not be altered (an Anthropic thinking signature that is truncated is
    // rejected outright). A pathologically large payload is DROPPED, and the
    // aggregate carrier budget is enforced by dropping from the OLDEST rows -
    // `boundCarriers` does both, so unbounded rounds/turns cannot grow the
    // carriers without limit. This is the SAME policy the in-memory ledger
    // applies (`_trimLocalHistory`), so the two never disagree.
    const carriersBounded = boundCarriers(localRows);
    // The window-scaled cap is per MESSAGE; a 1M-window session could still
    // hold dozens of messages at the 200k ceiling, and the snapshot is
    // re-serialized on every turn (and every few seconds mid-run) on the main
    // thread. Scale the cap down when the kept rows blow the aggregate budget,
    // never below the floor, so small sessions are untouched and a reload can
    // only shrink below memory for pathologically large ones. Sizing runs on
    // the CARRIER-BOUNDED rows so a dropped carrier cannot clip unrelated
    // content.
    const cap = boundedContentCap(contentCap, carriersBounded, uiRows, snapshot.pendingTurn);
    const localHistory = carriersBounded.map((message) => ({
        ...message,
        content: typeof message.content === 'string'
            ? clipHistoryContent(message.content, cap)
            : message.content,
    }));
    const uiHistory = uiRows.map((message: any) => ({
        ...message,
        // Display rows carry their text on `content` (host push shape) or
        // `text` (legacy) - clip whichever is present so the on-disk policy
        // matches the in-memory one.
        ...(typeof message?.content === 'string'
            ? { content: clipHistoryContent(message.content, cap) }
            : {}),
        ...(typeof message?.text === 'string'
            ? { text: clipHistoryContent(message.text, cap) }
            : {}),
    }));
    const pendingTurn = snapshot.pendingTurn ? sanitizePendingTurn(snapshot.pendingTurn, cap) : null;
    return { ...snapshot, localHistory, uiHistory, pendingTurn };
}

/**
 * Aggregate CONTENT ceiling for one persisted snapshot (chars); provider-native
 * replay carriers have their own aggregate ceiling (`CARRIER_BUDGET`) and are
 * counted here only so the per-message content cap scales down on a long
 * thinking session. The 40k floor still applies, so the hard ceiling is
 * MAX_STORED_TURNS rows x the floor (~12 MB) - this budget's job is to stop the
 * WINDOW-scaled cap (up to 200k) from multiplying that by up to 5x.
 */
const SNAPSHOT_CONTENT_BUDGET = 2_000_000;

/** Per-message cap adjusted so the snapshot's total content stays near budget. */
function boundedContentCap(
    contentCap: number,
    localRows: readonly any[],
    uiRows: readonly any[],
    pendingTurn: LocalPendingTurn | null | undefined,
): number {
    // A bad caller (0/NaN/negative) must never persist empty content.
    if (!Number.isFinite(contentCap) || contentCap <= 0) return MAX_STORED_CONTENT;
    let total = 0;
    const add = (s: unknown) => { if (typeof s === 'string') total += s.length; };
    for (const rows of [localRows, uiRows]) {
        for (const m of rows) { add(m?.content); add(m?.text); }
    }
    // ACCEPTED carrier bytes count toward the total so the per-message content
    // cap scales down on a long thinking session. `carrierSize` ignores a
    // carrier that will be dropped, so a discarded payload cannot shrink
    // unrelated content. The rows here are already carrier-bounded, so this can
    // never exceed CARRIER_BUDGET.
    for (const m of localRows) total += carrierSize(m);
    if (pendingTurn) {
        add(pendingTurn.prompt); add(pendingTurn.text); add(pendingTurn.thinking);
        const events = Array.isArray(pendingTurn.events) ? pendingTurn.events.slice(-40) : [];
        for (const e of events as any[]) { add(e?.output); add(e?.content); }
    }
    if (total <= SNAPSHOT_CONTENT_BUDGET || total === 0) return contentCap;
    const scaled = Math.floor(contentCap * (SNAPSHOT_CONTENT_BUDGET / total));
    return Math.max(MAX_STORED_CONTENT, Math.min(contentCap, scaled));
}

function sanitizePendingTurn(pt: LocalPendingTurn, contentCap: number = MAX_STORED_CONTENT): LocalPendingTurn {
    const events = Array.isArray(pt.events) ? pt.events.slice(-40).map((event: any) => {
        if (event?.type === 'tool_result' && typeof event.output === 'string') {
            return { ...event, output: clipHistoryContent(event.output, contentCap) };
        }
        if (event?.type === 'assistant_message' && Array.isArray(event.tool_calls)) {
            // Provider-native carriers are model-ledger data and can be large;
            // the mid-run crash snapshot keeps only the display-relevant fields
            // (matching `trimDisplayEvent`).
            const { providerBlocks: _providerBlocks, reasoningContent: _reasoningContent, ...rest } = event;
            return {
                ...rest,
                content: typeof event.content === 'string'
                    ? clipHistoryContent(event.content, contentCap)
                    : event.content,
                tool_calls: event.tool_calls.map((tc: any) => {
                    const args = tc?.function?.arguments;
                    return typeof args === 'string' && args.length > contentCap
                        ? { ...tc, function: { ...tc.function, arguments: clipToolCallArguments(args, contentCap) } }
                        : tc;
                }),
            };
        }
        if (event?.type === 'tool_call' && event.args && typeof event.args === 'object') {
            // Clip NESTED string leaves (a top-level-only pass let nested
            // arguments bypass the persisted limit), then enforce a total-size
            // ceiling on the re-serialized payload. The ceiling is `contentCap`,
            // NOT the fixed floor: with a large window the per-message cap is
            // larger, and comparing the re-serialized size against the smaller
            // floor collapsed an already-clipped payload to `{_truncated:true}`.
            const clipped = clipJsonValue(event.args, contentCap);
            let serialized = '';
            try { serialized = JSON.stringify(clipped); } catch { serialized = ''; }
            return {
                ...event,
                args: serialized.length <= contentCap ? clipped : { _truncated: true },
            };
        }
        return event;
    }) : [];
    return {
        prompt: clipHistoryContent(pt.prompt, contentCap),
        events,
        text: clipHistoryContent(pt.text, contentCap),
        thinking: clipHistoryContent(pt.thinking, contentCap),
        attachments: Array.isArray(pt.attachments) ? pt.attachments : undefined,
    };
}

function firstUserText(uiHistory: any[]): string | null {
    for (const m of uiHistory) {
        if (m?.role !== 'user') continue;
        // The host persists uiHistory user rows with `content` (the webview
        // HistoryMessage shape); older paths and tests use `text`. Read both.
        if (typeof m.text === 'string' && m.text.trim()) return m.text;
        if (typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return null;
}

/**
 * Multi-session persistence for the local runtime (Roo-style): one directory
 * per session under `<globalStorage>/sessions/<id>/` holding the full
 * transcript snapshot, plus a slim `_index.json` for instant list rendering.
 * The index is reconciled against the directories on every startup, and the
 * legacy single-snapshot-per-workspace `local-sessions.json` is imported on
 * first run.
 */
export class LocalSessionStore {
    private readonly rootDir: string;
    private readonly legacyPath: string;
    /** Promise-chain mutex: every mutating operation runs serialized.
     *  Two concurrent saves share ONE snapshot.json.tmp path, so an
     *  interleaved writeFile/rename can rename a partially-written temp
     *  file (corrupt snapshot → load() returns null → reconcile() drops
     *  the session) or land a stale write last (resurrected pendingTurn). */
    private _writeQueue: Promise<unknown> = Promise.resolve();

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._writeQueue.then(fn, fn);
        this._writeQueue = run.catch(() => undefined);
        return run;
    }

    constructor(storageRoot: string) {
        this.rootDir = path.join(storageRoot, 'sessions');
        this.legacyPath = path.join(storageRoot, 'local-sessions.json');
    }

    private sessionDir(id: string): string {
        // Defensive: ids are store-generated UUIDs; this keeps any hostile
        // path fragments from escaping the sessions root.
        if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('invalid session id');
        return path.join(this.rootDir, id);
    }

    private async readIndex(): Promise<Record<string, LocalSessionMeta>> {
        try {
            const raw = await fs.readFile(path.join(this.rootDir, '_index.json'), 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    private async writeIndex(index: Record<string, LocalSessionMeta>): Promise<void> {
        await fs.mkdir(this.rootDir, { recursive: true });
        const temp = path.join(this.rootDir, '_index.json.tmp');
        await fs.writeFile(temp, JSON.stringify(index), 'utf8');
        await renameWithRetry(temp, path.join(this.rootDir, '_index.json'));
    }

    /** Rebuild the index from the per-session directories (source of truth),
     *  importing the legacy single-snapshot file when present. */
    async reconcile(currentWorkspacePath?: string): Promise<void> {
        return this.enqueue(() => this._reconcile(currentWorkspacePath));
    }

    private async _reconcile(currentWorkspacePath?: string): Promise<void> {
        await this.migrateLegacy(currentWorkspacePath);
        await fs.mkdir(this.rootDir, { recursive: true });
        const index = await this.readIndex();
        const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/i.test(entry.name)) continue;
            if (index[entry.name]) continue;
            try {
                const raw = await fs.readFile(path.join(this.rootDir, entry.name, 'snapshot.json'), 'utf8');
                const parsed = JSON.parse(raw);
                index[entry.name] = {
                    id: entry.name,
                    title: parsed?.title || deriveTitle(firstUserText(parsed?.uiHistory ?? []), parsed?.workspace || 'default'),
                    workspace: parsed?.workspace || 'default',
                    createdAt: parsed?.createdAt ?? Date.now(),
                    updatedAt: parsed?.updatedAt ?? Date.now(),
                    ...(parsed?.renamed ? { renamed: true } : {}),
                };
            } catch {
                /* unreadable directory - leave it out of the list */
            }
        }
        for (const id of Object.keys(index)) {
            try {
                await fs.access(this.sessionDir(id));
            } catch {
                delete index[id];
            }
        }
        await this.writeIndex(index);
    }

    /** Legacy keys were sha256(resolved workspace path) - only the CURRENT
     *  workspace's path can be recovered, everything else migrates under a
     *  generic label (titles still come from the first user message). */
    private legacyKey(workspacePath: string): string {
        return createHash('sha256').update(path.resolve(workspacePath)).digest('hex');
    }

    /** Import legacy `local-sessions.json` (one snapshot per workspace) as
     *  individual sessions, then rename the file out of the way. */
    private async migrateLegacy(currentWorkspacePath?: string): Promise<void> {
        let legacy: Record<string, any>;
        try {
            legacy = JSON.parse(await fs.readFile(this.legacyPath, 'utf8'));
        } catch {
            return;
        }
        const currentKey = currentWorkspacePath ? this.legacyKey(currentWorkspacePath) : null;
        try {
            await fs.mkdir(this.rootDir, { recursive: true });
            for (const [key, snapshot] of Object.entries(legacy)) {
                if (!snapshot || !Array.isArray(snapshot.uiHistory) || snapshot.uiHistory.length === 0) continue;
                const id = randomUUID();
                const workspace = key === currentKey ? currentWorkspacePath! : 'workspace';
                const meta = {
                    id,
                    title: deriveTitle(firstUserText(snapshot.uiHistory), workspace),
                    workspace,
                    createdAt: snapshot.updatedAt ?? Date.now(),
                    updatedAt: snapshot.updatedAt ?? Date.now(),
                };
                const payload = { ...meta, model: snapshot.model ?? null, summary: snapshot.summary ?? null, localHistory: snapshot.localHistory ?? [], uiHistory: snapshot.uiHistory };
                const dir = this.sessionDir(id);
                await fs.mkdir(dir, { recursive: true });
                const temp = path.join(dir, 'snapshot.json.tmp');
                await fs.writeFile(temp, JSON.stringify(sanitizeSnapshot(payload)), 'utf8');
                await renameWithRetry(temp, path.join(dir, 'snapshot.json'));
            }
            await renameWithRetry(this.legacyPath, `${this.legacyPath}.migrated`);
        } catch {
            /* migration is best-effort; the legacy file stays for next run */
        }
    }

    async list(workspaceRoot?: string): Promise<LocalSessionMeta[]> {
        const index = Object.values(await this.readIndex());
        index.sort((a, b) => b.updatedAt - a.updatedAt);
        if (workspaceRoot == null) return index;
        return index.filter((m) => m.workspace === workspaceRoot);
    }

    /**
     * Full-text search across stored sessions: title, workspace, and the
     * visible transcript. Scans at most `limit` most-recent sessions and caps
     * the text examined per session so a large history stays responsive.
     */
    async search(query: string, workspaceRoot?: string, limit = 200): Promise<LocalSessionMeta[]> {
        const needle = query.trim().toLowerCase();
        if (!needle) return [];
        const candidates = (await this.list(workspaceRoot)).slice(0, limit);
        const hits: LocalSessionMeta[] = [];
        for (const meta of candidates) {
            if (meta.title.toLowerCase().includes(needle)
                || meta.workspace.toLowerCase().includes(needle)) {
                hits.push(meta);
                continue;
            }
            const snapshot = await this.load(meta.id);
            if (snapshot && transcriptMatches(snapshot.uiHistory, needle)) hits.push(meta);
        }
        return hits;
    }

    /** Session to reopen for a workspace: the preferred id when it still
     *  exists, else the most recent, else null. */
    async findCurrent(workspaceRoot: string, preferredId?: string | null): Promise<LocalSessionMeta | null> {
        const all = await this.list(workspaceRoot);
        if (preferredId && all.some((m) => m.id === preferredId)) {
            return all.find((m) => m.id === preferredId) ?? null;
        }
        return all[0] ?? null;
    }

    async create(workspaceRoot: string): Promise<LocalSessionMeta> {
        return this.enqueue(() => this._create(workspaceRoot));
    }

    private async _create(workspaceRoot: string): Promise<LocalSessionMeta> {
        const id = randomUUID();
        const now = Date.now();
        const meta: LocalSessionMeta = { id, title: workspaceLabel(workspaceRoot), workspace: workspaceRoot, createdAt: now, updatedAt: now };
        await this.writeMeta(meta, { model: null, summary: null, localHistory: [], uiHistory: [] });
        return meta;
    }

    async load(id: string): Promise<(LocalSessionSnapshot & { sessionId: string; title: string | null; workspace: string; renamed: boolean }) | null> {
        try {
            const raw = await fs.readFile(path.join(this.sessionDir(id), 'snapshot.json'), 'utf8');
            const parsed = JSON.parse(raw);
            return {
                sessionId: id,
                title: parsed?.title ?? null,
                workspace: parsed?.workspace ?? 'default',
                renamed: !!parsed?.renamed,
                model: parsed?.model ?? null,
                summary: parsed?.summary ?? null,
                localHistory: parsed?.localHistory ?? [],
                uiHistory: parsed?.uiHistory ?? [],
                pendingTurn: parsed?.pendingTurn ?? null,
                // Clamp: a malformed/negative/overflowing value must not
                // violate the ledger invariant (spend is finite and >= 0).
                totalCostUsd: Number.isFinite(parsed?.totalCostUsd) && parsed.totalCostUsd > 0
                    ? parsed.totalCostUsd
                    : 0,
                totalCostIrt: Number.isFinite(parsed?.totalCostIrt) && parsed.totalCostIrt > 0
                    ? parsed.totalCostIrt
                    : 0,
                totalInputTokens: Number.isFinite(parsed?.totalInputTokens) && parsed.totalInputTokens > 0
                    ? parsed.totalInputTokens
                    : 0,
                totalOutputTokens: Number.isFinite(parsed?.totalOutputTokens) && parsed.totalOutputTokens > 0
                    ? parsed.totalOutputTokens
                    : 0,
                totalCachedTokens: Number.isFinite(parsed?.totalCachedTokens) && parsed.totalCachedTokens > 0
                    ? parsed.totalCachedTokens
                    : 0,
                usageByHost: normalizeUsageByHost(parsed?.usageByHost),
            };
        } catch {
            return null;
        }
    }

    private async writeMeta(meta: LocalSessionMeta, snapshot: LocalSessionSnapshot, contentCap: number = MAX_STORED_CONTENT): Promise<void> {
        const dir = this.sessionDir(meta.id);
        await fs.mkdir(dir, { recursive: true });
        const payload = { ...meta, ...sanitizeSnapshot(snapshot, contentCap) };
        const temp = path.join(dir, 'snapshot.json.tmp');
        await fs.writeFile(temp, JSON.stringify(payload), 'utf8');
        await renameWithRetry(temp, path.join(dir, 'snapshot.json'));
        const index = await this.readIndex();
        index[meta.id] = meta;
        await this.writeIndex(index);
    }

    /** Persist the transcript snapshot. The title tracks the first user
     *  message (server-matching rule) until the user explicitly renames the
     *  session - `_create` only seeds the workspace label, so without the
     *  re-derivation every session would keep that placeholder forever. */
    async save(id: string, snapshot: LocalSessionSnapshot, renamedTitle?: string, contentCap?: number): Promise<{ meta: LocalSessionMeta } | null> {
        return this.enqueue(() => this._save(id, snapshot, renamedTitle, contentCap));
    }

    private async _save(id: string, snapshot: LocalSessionSnapshot, renamedTitle?: string, contentCap?: number): Promise<{ meta: LocalSessionMeta } | null> {
        const index = await this.readIndex();
        const existing = index[id];
        const title = renamedTitle ?? (existing?.renamed
            ? existing.title
            : deriveTitle(firstUserText(snapshot.uiHistory), snapshot.workspace ?? existing?.workspace ?? 'default'));
        const meta: LocalSessionMeta = {
            id,
            title,
            workspace: snapshot.workspace ?? existing?.workspace ?? 'default',
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            ...(existing?.renamed ? { renamed: true } : {}),
        };
        await this.writeMeta(meta, snapshot, contentCap);
        return { meta };
    }

    async rename(id: string, title: string): Promise<boolean> {
        return this.enqueue(() => this._rename(id, title));
    }

    private async _rename(id: string, title: string): Promise<boolean> {
        const index = await this.readIndex();
        const existing = index[id];
        if (!existing) return false;
        const meta = { ...existing, title: title.trim() || existing.title, updatedAt: Date.now(), renamed: true };
        index[id] = meta;
        await this.writeIndex(index);
        // Keep the directory copy consistent for reconcile().
        try {
            const dir = this.sessionDir(id);
            const raw = await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8');
            const parsed = JSON.parse(raw);
            parsed.title = meta.title;
            parsed.renamed = true;
            const temp = path.join(dir, 'snapshot.json.tmp');
            await fs.writeFile(temp, JSON.stringify(parsed), 'utf8');
            await renameWithRetry(temp, path.join(dir, 'snapshot.json'));
        } catch {
            /* index is the list source of truth; directory drift heals on reconcile */
        }
        return true;
    }

    async delete(id: string): Promise<boolean> {
        return this.enqueue(() => this._delete(id));
    }

    private async _delete(id: string): Promise<boolean> {
        try {
            await fs.rm(this.sessionDir(id), { recursive: true, force: true });
        } catch {
            // A real removal failure (e.g. EBUSY on Windows with an open
            // handle) - keep the index entry so the session stays visible
            // and a later attempt can retry it.
            return false;
        }
        const index = await this.readIndex();
        if (index[id]) {
            delete index[id];
            try {
                await this.writeIndex(index);
            } catch {
                /* reconcile heals the stale entry on next startup */
            }
        }
        return true;
    }
}

/**
 * Bounds for the per-session MODEL ledger (`_localHistory` in extension.ts).
 * Kept dependency-free so it is unit-testable without VS Code.
 *
 * The persisted snapshot is capped by `sanitizeSnapshot`, but the LIVE array is
 * not: a long session accumulates one row per user/assistant/tool message for
 * its whole life, and a single tool result can be hundreds of thousands of
 * characters. These helpers bound that growth.
 *
 * The DISPLAY ledger (`_history`) is intentionally NOT evicted here - the user
 * keeps their full transcript, and the webview bounds the DOM by mounting only
 * a trailing window.
 *
 * A "turn" is a `role: 'user'` row plus every following row up to (but not
 * including) the next user row. Slicing only at turn boundaries is what keeps
 * the display ledger and the model ledger aligned: rewind maps a displayed
 * `userIndex` to a row in both by counting user rows from index 0.
 */

/**
 * Per-message content FLOOR kept in memory (chars).
 *
 * This is the old fixed cap and is retained as the floor so a small or unknown
 * window behaves exactly as before. It is NOT the ceiling any more - see
 * `contentCapForWindow`.
 */
export const IN_MEMORY_CONTENT_CAP = 40_000;

/**
 * Absolute per-message ceiling (chars), whatever the window.
 *
 * Matches the terminal-output cap upstream tools already apply (200k chars for
 * terminal output, 120k for expansion), so the ledger never clips tighter than
 * the tool that produced the content. ~13k tokens at 4 chars/token.
 */
export const MAX_CONTENT_CAP = 200_000;

/** Rough chars-per-token used to translate a window into a char budget. */
const CHARS_PER_TOKEN = 4;
/** A single message may occupy at most this share of the context window. */
const PER_MESSAGE_WINDOW_SHARE = 0.08;

/**
 * Content cap for ONE message, scaled to the context window.
 *
 * Regression: this was the fixed `IN_MEMORY_CONTENT_CAP` (40_000 chars, ~13k
 * tokens) for every window. A fixed absolute cannot serve both ends of a 100x
 * range - it is far too small for a 1M-token window (it silently discarded
 * ~80% of a legitimate 200k-char tool result at 11% window fill, head+tail
 * clipping away the middle) and far too large for an 8k window.
 *
 * The cap is a MEMORY bound, so it must scale with what the run can actually
 * afford. Properties, in order of importance:
 *   - never TIGHTER than the old fixed cap (no regression on any window)
 *   - grows with the window (a 1M window keeps ~200k-char messages intact)
 *   - hard-bounded by MAX_CONTENT_CAP so memory stays finite
 *   - unknown/absurd windows fall back to the old fixed cap
 */
export function contentCapForWindow(windowTokens?: number | null): number {
    if (typeof windowTokens !== 'number' || !Number.isFinite(windowTokens) || windowTokens < 4096) {
        return IN_MEMORY_CONTENT_CAP;
    }
    const byWindow = Math.floor(windowTokens * PER_MESSAGE_WINDOW_SHARE * CHARS_PER_TOKEN);
    return Math.max(IN_MEMORY_CONTENT_CAP, Math.min(byWindow, MAX_CONTENT_CAP));
}

/**
 * Oldest complete turns dropped from the model ledger past this many.
 *
 * This is a MEMORY bound, not a context bound - the context window is policed
 * separately by compaction (90% of the window) and `boundHistory` (72%), both
 * of which scale with the window. Dropping turns here is irreversible (unlike
 * compaction, which summarizes first), so it is set well above any realistic
 * single session.
 */
export const MAX_IN_MEMORY_TURNS = 200;
/**
 * User turns retained in the persisted snapshot (turn-aligned).
 *
 * DELIBERATELY tighter than `MAX_IN_MEMORY_TURNS` (asserted by
 * test-history-bounds.mjs) so the snapshot written on every turn stays small.
 * The consequence is worth stating: reloading the window or restarting the
 * extension host rebuilds the model ledger from this snapshot, so turns past
 * the 60th are gone and the context meter drops. That is a reload-time loss by
 * design, NOT the cause of drops mid-conversation - those can only come from
 * compaction (90% of the window) or `boundHistory` (72%), neither of which can
 * fire below that fill.
 */
export const MAX_STORED_TURNS = 60;

/**
 * Room reserved for the clip marker. Subtracting it from `cap` guarantees the
 * RETURNED string is never longer than `cap`, which makes the helper
 * idempotent - a second pass over already-clipped text is a no-op, so a
 * write-through-clip wrapper never degrades the marker's count.
 */
const CLIP_MARKER_RESERVE = 40;

interface HistoryRow {
    role?: string;
    content?: unknown;
}

/**
 * Clip a stored message's content, keeping both ends (tool output is usually
 * actionable at the head and the tail - a stack trace, a summary line). The
 * marker is counted against `cap`, so the result length is always <= `cap`.
 */
export function clipHistoryContent(text: string, cap: number = IN_MEMORY_CONTENT_CAP): string {
    if (text.length <= cap) return text;
    // Too small to carry a marker without eating the content.
    if (cap <= CLIP_MARKER_RESERVE) return text.slice(0, cap);
    const contentBudget = cap - CLIP_MARKER_RESERVE;
    const head = Math.floor(contentBudget * 0.6);
    const tail = contentBudget - head;
    const removed = text.length - contentBudget;
    return `${text.slice(0, head)}\n[...clipped ${removed} chars...]\n${text.slice(-tail)}`;
}

/** Number of user rows in a ledger (one per turn, steers included). */
export function countUserRows(rows: ReadonlyArray<HistoryRow>): number {
    let n = 0;
    for (const row of rows) if (row?.role === 'user') n++;
    return n;
}

/** Depth ceiling for the recursive JSON clip - beyond it a subtree is replaced
 *  outright rather than walked (pathological nesting must not blow the stack). */
const JSON_CLIP_MAX_DEPTH = 8;

/**
 * Recursively clip the STRING LEAVES of a parsed JSON value, preserving the
 * object/array shape. Used for tool-call arguments: the model ledger is
 * replayed to the provider, which rejects malformed `function.arguments`, so
 * the value must stay valid JSON.
 */
export function clipJsonValue(value: unknown, cap: number, depth = 0): unknown {
    if (typeof value === 'string') return clipHistoryContent(value, cap);
    if (Array.isArray(value)) {
        if (depth >= JSON_CLIP_MAX_DEPTH) return '[truncated]';
        return value.map((item) => clipJsonValue(item, cap, depth + 1));
    }
    if (value && typeof value === 'object') {
        if (depth >= JSON_CLIP_MAX_DEPTH) return '[truncated]';
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) out[key] = clipJsonValue(item, cap, depth + 1);
        return out;
    }
    return value;
}

/** Valid-JSON placeholder used when a payload cannot be bounded by clipping. */
const TRUNCATED_ARGS_JSON = '{"_truncated":"arguments omitted to bound memory"}';
/** Room for JSON punctuation/key overhead when sizing the per-leaf budget. */
const ARGS_JSON_OVERHEAD = 64;

/** Count string leaves so the budget can be divided between them. */
function countStringLeaves(value: unknown, depth = 0): number {
    if (typeof value === 'string') return 1;
    if (depth >= JSON_CLIP_MAX_DEPTH) return 0;
    if (Array.isArray(value)) return value.reduce((n, item) => n + countStringLeaves(item, depth + 1), 0);
    if (value && typeof value === 'object') {
        return Object.values(value).reduce((n: number, item) => n + countStringLeaves(item, depth + 1), 0);
    }
    return 0;
}

/**
 * Bound a tool-call `function.arguments` JSON string. Oversized string leaves
 * are clipped (head+tail) with the budget divided between them so the shape
 * survives; if the re-serialized payload is STILL over `cap` (many leaves), it
 * degrades to a small valid placeholder. Malformed input also degrades to the
 * placeholder - a provider would reject it anyway, and the alternative is an
 * unbounded string in memory.
 */
export function clipToolCallArguments(argsJson: string, cap: number = IN_MEMORY_CONTENT_CAP): string {
    if (argsJson.length <= cap) return argsJson;
    try {
        const parsed = JSON.parse(argsJson);
        const leaves = Math.max(1, countStringLeaves(parsed));
        // Split the budget between leaves; the floor keeps a clipped leaf
        // useful even when the total budget is small.
        const perLeaf = Math.max(64, Math.floor((cap - ARGS_JSON_OVERHEAD) / leaves));
        const clipped = JSON.stringify(clipJsonValue(parsed, perLeaf));
        return clipped.length <= cap ? clipped : TRUNCATED_ARGS_JSON;
    } catch {
        return TRUNCATED_ARGS_JSON;
    }
}

/**
 * Keep only the last `k` complete turns. Returns the tail starting at the
 * k-th-from-last user row (so the ledger never begins mid-turn). `k <= 0`
 * keeps nothing; a ledger with fewer than `k` turns is returned unchanged.
 */
export function keepLastUserTurns<T extends HistoryRow>(rows: readonly T[], k: number): T[] {
    if (k <= 0) return [];
    let seen = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.role !== 'user') continue;
        seen++;
        if (seen === k) return rows.slice(i);
    }
    return rows.slice();
}

/**
 * Drop the oldest complete turns past `maxUserTurns`. Returns the retained
 * rows plus how many user turns were evicted (the caller tracks that offset so
 * displayed user indices still map to the right model-ledger row).
 */
export function evictOldestTurns<T extends HistoryRow>(
    rows: readonly T[],
    maxUserTurns: number,
): { rows: T[]; evicted: number } {
    const total = countUserRows(rows);
    if (maxUserTurns <= 0) return { rows: rows.slice(), evicted: 0 };
    if (total <= maxUserTurns) return { rows: rows.slice(), evicted: 0 };
    return { rows: keepLastUserTurns(rows, maxUserTurns), evicted: total - maxUserTurns };
}

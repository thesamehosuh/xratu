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

/** Per-message content ceiling kept in memory (chars). */
export const IN_MEMORY_CONTENT_CAP = 40_000;
/** Oldest complete turns dropped from the model ledger past this many. */
export const MAX_IN_MEMORY_TURNS = 200;
/** User turns retained in the persisted snapshot (turn-aligned). */
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

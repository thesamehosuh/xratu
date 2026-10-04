/**
 * Transcript display preferences - the persisted blob behind the Settings
 * page's "which pills open themselves" switches (auto-expanded diffs,
 * commands, reasoning).
 *
 * The host stores the blob OPAQUELY (one JSON string in globalState): the row
 * ids are the WEBVIEW's schema (webview-ui/src/transcriptPrefs.ts), so adding
 * a row there must never require a change here.
 *
 * What the host DOES own is the trust boundary. `transcriptSet` carries
 * webview-supplied ids, so they are pattern-checked, only booleans survive,
 * and the map is capped - a malformed or hostile payload can never grow the
 * persisted blob without bound.
 */

export interface TranscriptPrefs {
    /** Row ids whose pill starts expanded. An absent id means collapsed. */
    expand: Record<string, boolean>;
}

/** Ids are short slugs (tool families, 'thinking', …) - never paths or prose. */
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Object keys that would poison a plain-object lookup chain. */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** Far above the row count the UI can produce; a hard stop for junk input. */
const MAX_IDS = 32;

export function emptyTranscriptPrefs(): TranscriptPrefs {
    return { expand: {} };
}

export function isTranscriptId(value: unknown): value is string {
    return typeof value === 'string' && ID_RE.test(value) && !RESERVED_IDS.has(value);
}

function sanitizeMap(raw: unknown): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'boolean' || !isTranscriptId(id)) continue;
        if (Object.keys(out).length >= MAX_IDS) break;
        out[id] = value;
    }
    return out;
}

/**
 * Parse the persisted blob. Anything unreadable degrades to "no overrides",
 * which the webview resolves to its own defaults - a corrupt store must never
 * leave the transcript in a state the UI cannot explain.
 */
export function parseTranscriptPrefs(raw: string | undefined): TranscriptPrefs {
    if (!raw) return emptyTranscriptPrefs();
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyTranscriptPrefs();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyTranscriptPrefs();
    return { expand: sanitizeMap((parsed as Record<string, unknown>).expand) };
}

/** Fold one toggle into the blob. An out-of-shape id is a no-op. */
export function withTranscriptPref(
    prefs: TranscriptPrefs,
    id: string,
    enabled: boolean,
): TranscriptPrefs {
    if (!isTranscriptId(id)) return prefs;
    const map = prefs.expand;
    if (Object.prototype.hasOwnProperty.call(map, id) && map[id] === enabled) return prefs;
    if (!Object.prototype.hasOwnProperty.call(map, id) && Object.keys(map).length >= MAX_IDS) {
        return prefs;
    }
    return { expand: { ...map, [id]: enabled } };
}
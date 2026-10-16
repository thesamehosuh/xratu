/**
 * Host-persisted transcript display preferences. Legacy expansion ids remain
 * bounded boolean flags; presentation options use a closed, shared schema.
 * Both stored JSON and incoming webview patches cross the same validation.
 */

export interface TranscriptOptions {
    detail: 'minimal' | 'balanced' | 'detailed';
    reasoning: 'activity' | 'collapsed' | 'expanded';
    commands: 'collapsed' | 'errors' | 'expanded';
    progress: 'latest' | 'all';
    compactCompleted: boolean;
    followActivity: boolean;
    timestamps: boolean;
}

export interface TranscriptPrefs {
    /** Row ids whose pill starts expanded. An absent id means collapsed. */
    expand: Record<string, boolean>;
    options?: Partial<TranscriptOptions>;
}

/** Closed, bounded presentation schema for both stored JSON and webview input. */
export function sanitizeTranscriptOptions(raw: unknown): Partial<TranscriptOptions> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const input = raw as Record<string, unknown>;
    const options: Partial<TranscriptOptions> = {};
    if (typeof input.detail === 'string' && ['minimal', 'balanced', 'detailed'].includes(input.detail)) options.detail = input.detail as TranscriptOptions['detail'];
    if (typeof input.reasoning === 'string' && ['activity', 'collapsed', 'expanded'].includes(input.reasoning)) options.reasoning = input.reasoning as TranscriptOptions['reasoning'];
    if (typeof input.commands === 'string' && ['collapsed', 'errors', 'expanded'].includes(input.commands)) options.commands = input.commands as TranscriptOptions['commands'];
    if (input.progress === 'latest' || input.progress === 'all') options.progress = input.progress;
    for (const key of ['compactCompleted', 'followActivity', 'timestamps'] as const) {
        if (typeof input[key] === 'boolean') options[key] = input[key];
    }
    return options;
}

export function withTranscriptOptions(prefs: TranscriptPrefs, raw: unknown): TranscriptPrefs {
    return { ...prefs, options: { ...prefs.options, ...sanitizeTranscriptOptions(raw) } };
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
    const input = parsed as Record<string, unknown>;
    const options = sanitizeTranscriptOptions(input.options);
    return { expand: sanitizeMap(input.expand), ...(Object.keys(options).length ? { options } : {}) };
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
    return { ...prefs, expand: { ...map, [id]: enabled } };
}

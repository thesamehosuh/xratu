/**
 * Display defaults and legacy expansion preferences. Defaults resolve at
 * render time; explicit stored choices survive changes to the default mode.
 * The host shares the closed presentation schema and persists the overrides.
 */
import type { StringKey } from './i18n';
import { sanitizeTranscriptOptions } from '../../src/transcriptPrefs';
import type { TranscriptOptions } from '../../src/transcriptPrefs';
export type { TranscriptOptions } from '../../src/transcriptPrefs';

export type ToolFamily = 'edit' | 'terminal' | 'read' | 'search' | 'git' | 'web' | 'ops' | 'mcp' | 'subagent' | 'generic';

export interface TranscriptPrefs {
    /** Row ids whose pill starts expanded. An absent id means collapsed. */
    expand: Record<string, boolean>;
    options?: Partial<TranscriptOptions>;
}

export function transcriptOptions(prefs?: TranscriptPrefs): TranscriptOptions {
    const detail = prefs?.options?.detail ?? 'balanced';
    return {
        detail,
        reasoning: prefs?.expand.thinking ? 'expanded' : prefs?.expand.thinking === false || detail === 'detailed' ? 'collapsed' : 'activity',
        commands: prefs?.expand.terminal ? 'expanded' : prefs?.expand.terminal === false ? 'collapsed' : 'errors',
        progress: detail === 'minimal' ? 'latest' : 'all',
        compactCompleted: true,
        followActivity: true,
        timestamps: true,
        showContextMeter: false,
        ...prefs?.options,
    };
}

/** Existing explicit expansion choices survive the new compact defaults. */
export function conversationPrefs(prefs?: TranscriptPrefs): TranscriptPrefs {
    const options = transcriptOptions(prefs);
    return { ...prefs, options, expand: {
        edit: options.detail === 'detailed',
        ...prefs?.expand,
        thinking: options.reasoning === 'expanded',
        terminal: options.commands === 'expanded',
    } };
}

/** Regex-ordered, first match wins - mirrors TOOL_ICONS/TOOL_LABELS style. */
export function toolFamily(tool?: string): ToolFamily {
    if (!tool) return 'generic';
    if (tool.startsWith('mcp__')) return 'mcp';
    if (/^(apply_patch|replace_in_file|edit_file|write_file|create_file)$/.test(tool)) return 'edit';
    if (/terminal|command/.test(tool)) return 'terminal';
    if (/^read_files?$|^file_info$/.test(tool)) return 'read';
    if (/^skill$/.test(tool)) return 'read';
    if (/grep|glob|find_|workspace_symbols|list_files|directory_tree/.test(tool)) return 'search';
    if (/^git_/.test(tool)) return 'git';
    if (/fetch_url|web_search|opencode_websearch|opencode_webfetch/.test(tool)) return 'web';
    if (/^run_tests$|^get_diagnostics$|^check_dependencies$|^install_dependency$|^copy_file$|^move_file$|^delete_file$/.test(tool)) return 'ops';
    if (/^task$/.test(tool)) return 'subagent';
    return 'generic';
}

export interface TranscriptRow {
    /** Prefs key: a tool family for pills, 'thinking' for the reasoning pill. */
    id: string;
    labelKey: StringKey;
    descKey: StringKey;
    /** Switch position before the user ever touched this row. */
    defaultOn: boolean;
}

/**
 * Pills stay collapsed until the reader opens them: mounting every diff,
 * output and reasoning stream up front froze long transcripts, so even
 * edits (whose diff used to be the payload) start closed. The switches
 * below opt back into auto-expand per family.
 */
export const TRANSCRIPT_ROWS: readonly TranscriptRow[] = [
    { id: 'edit', labelKey: 'txExpandEdits', descKey: 'txExpandEditsDesc', defaultOn: false },
    { id: 'terminal', labelKey: 'txExpandCommands', descKey: 'txExpandCommandsDesc', defaultOn: false },
    { id: 'thinking', labelKey: 'txExpandThinking', descKey: 'txExpandThinkingDesc', defaultOn: false },
];

/** The state a fresh install (or a corrupt store) resolves to. */
export const EMPTY_TRANSCRIPT_PREFS: TranscriptPrefs = { expand: {} };

function coerceMap(raw: unknown): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'boolean') out[id] = value;
    }
    return out;
}

/** Tolerate anything on the wire (the blob is host-persisted JSON). */
export function coerceTranscriptPrefs(raw: unknown): TranscriptPrefs {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_TRANSCRIPT_PREFS;
    const input = raw as Record<string, unknown>;
    const options = sanitizeTranscriptOptions(input.options);
    return { expand: coerceMap(input.expand), ...(Object.keys(options).length ? { options } : {}) };
}

/** Resolve one switch/pill: stored override first, then the row's default,
 *  then collapsed - an id with no row never opens itself. */
export function prefOn(prefs: TranscriptPrefs | undefined, id: string): boolean {
    const stored = prefs?.expand?.[id];
    if (typeof stored === 'boolean') return stored;
    return TRANSCRIPT_ROWS.find((r) => r.id === id)?.defaultOn ?? false;
}

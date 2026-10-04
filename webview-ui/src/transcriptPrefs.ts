/**
 * Transcript display preferences - the webview half of the Settings page's
 * "which pills open themselves" switches.
 *
 * This module owns the ROW SCHEMA. The host persists the blob opaquely
 * (src/transcriptPrefs.ts), so adding a switch below needs no host change:
 * one entry in TRANSCRIPT_ROWS plus the i18n strings it names. The consumers
 * already ask `prefOn` per tool family and for 'thinking', so a new row needs
 * no rendering change unless its id is neither.
 *
 * Defaults live HERE, never in the persisted blob: an untouched id has no
 * entry, so changing a default moves everyone who never expressed an opinion
 * and leaves everyone who did alone.
 */
import type { StringKey } from './i18n';

export type ToolFamily = 'edit' | 'terminal' | 'read' | 'search' | 'git' | 'web' | 'ops' | 'mcp' | 'subagent' | 'generic';

export interface TranscriptPrefs {
    /** Row ids whose pill starts expanded. An absent id means collapsed. */
    expand: Record<string, boolean>;
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
    if (/fetch_url|web_search/.test(tool)) return 'web';
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
 * Diffs expand because the diff IS the payload the user came for. Commands
 * stay collapsed: a command line is long and scroll-heavy, and the summary
 * already carries the command plus its exit code. Reasoning stays collapsed
 * too - a thinking stream is the longest content in the transcript, so
 * expanding it on sight would bury the answer it is reasoning towards.
 */
export const TRANSCRIPT_ROWS: readonly TranscriptRow[] = [
    { id: 'edit', labelKey: 'txExpandEdits', descKey: 'txExpandEditsDesc', defaultOn: true },
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
    return { expand: coerceMap((raw as Record<string, unknown>).expand) };
}

/** Resolve one switch/pill: stored override first, then the row's default,
 *  then collapsed - an id with no row never opens itself. */
export function prefOn(prefs: TranscriptPrefs | undefined, id: string): boolean {
    const stored = prefs?.expand?.[id];
    if (typeof stored === 'boolean') return stored;
    return TRANSCRIPT_ROWS.find((r) => r.id === id)?.defaultOn ?? false;
}
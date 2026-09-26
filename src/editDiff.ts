/**
 * Pure before/after reconstruction for the edit-step "open diff in editor"
 * button. The webview only ships the tool name + JSON args (and the result
 * text) of a completed edit call; from those this module derives the two
 * document sides the host feeds to `vscode.diff`.
 *
 * The host prefers the exact before/after snapshot it captured when the edit
 * ran (see extension.ts `_editSnapshots`); this module is the FALLBACK for
 * restored sessions where no snapshot exists. Kept free of the `vscode`
 * import so plain node can unit-test it (test/test-edit-diff.mjs) - the
 * view half lives in editDiffView.ts.
 */

import { parsePatchBlocks, repairPatchMarkers } from './paths';

export interface EditDiffPayload {
    /** Path as the model wrote it (label for the diff title). */
    path: string;
    /** Content BEFORE the edit - '' when the call created the file. */
    before: string;
    /** Content AFTER the edit. */
    after: string;
}

/** Concatenation separator for multi-block patches: present on BOTH sides at
 *  the same ordinal so the diff aligns block pairs instead of drifting. */
const BLOCK_SEP = '\n\n';

/** Inline clip markers the host appends when it persists args
 *  (`_clipDisplay`) or trims replayed history. They are display artifacts,
 *  never file content - strip them before diffing. */
const CLIP_MARKERS = /… \[\+(?:\d+ chars truncated|[^\]]*trimmed in history replay[^\]]*)\]/g;

/**
 * Rebuild the before/after documents of a completed edit tool call.
 * Returns null when the args cannot produce an honest diff (unparsable JSON,
 * a patch that refuses to parse, an overwrite whose old side is unknowable).
 */
export function editDiffFromArgs(
    tool: string | undefined,
    argsText: string,
    resultText?: string
): EditDiffPayload | null {
    let args: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = JSON.parse(argsText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
        }
    } catch {
        // The webview also renders raw marker text when JSON parsing fails
        // (see EditFileSection's rawPatch fallback) - try that below.
    }
    if (!args) {
        // Raw patch text (not JSON): diff the fragment blocks directly.
        return argsText.includes('<<<<<<<') ? patchDiff('', argsText) : null;
    }
    const path = typeof args.path === 'string' ? args.path : '';
    const toolName = tool ?? '';

    if (typeof args.patch === 'string') return patchDiff(path, args.patch);
    if (typeof args.old_str === 'string') {
        // replace_in_file (legacy name, still in history): exact fragment pair.
        return {
            path,
            before: stripClips(args.old_str),
            after: stripClips(typeof args.new_str === 'string' ? args.new_str : ''),
        };
    }
    const content =
        typeof args.new_content === 'string' ? args.new_content :
            typeof args.content === 'string' ? args.content : null;
    if (content !== null && (toolName === '' || /^(edit|write|create)_file$/.test(toolName))) {
        const mode = typeof args.mode === 'string' ? args.mode : '';
        const created = mode === 'create' || /Successfully created/.test(resultText ?? '');
        if (created) return { path, before: '', after: stripClips(content) };
        // Overwrite/append on an existing file: the old side is unknowable
        // from args alone. Guessing '' would render the whole file as ADDED -
        // refuse and let the caller show its "no diff" banner instead.
        return null;
    }
    return null;
}

/** Build a fragment diff from a marker patch (or raw marker text). */
function patchDiff(path: string, patchText: string): EditDiffPayload | null {
    try {
        const repaired = repairPatchMarkers(patchText);
        const blocks = parsePatchBlocks(repaired.patch);
        if (blocks.length === 0) return null;
        const allEmpty = blocks.every((b) => !b.search);
        return {
            path,
            // New-file idiom (every SEARCH empty): before is the empty file.
            before: allEmpty ? '' : blocks.map((b) => stripClips(b.search)).join(BLOCK_SEP),
            after: blocks.map((b) => stripClips(b.replace)).join(BLOCK_SEP),
        };
    } catch {
        // Marker-like content refuses to parse - the pill renders the error
        // state instead; there is no diff to show.
        return null;
    }
}

function stripClips(text: string): string {
    return text.replace(CLIP_MARKERS, '');
}

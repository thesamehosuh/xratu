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

// Cap for the approval diff's O(m·n) LCS table. 2000×2000 ≈ 4M cells; beyond
// that the synchronous DP allocation (several GB at 20k×20k lines) would
// freeze the extension host. Over-budget previews degrade to diff: null.
export const MAX_DIFF_LCS_CELLS = 4_000_000;

/** Apply <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks in-memory so
 *  approval cards show a real diff for apply_patch payloads. Returns
 *  null when no block matches (the preview degrades gracefully). */
export function applyMarkerPatch(content: string, patch: string): string | null {
    // Shared parser, not a private copy of the regex: the approval card
    // must preview exactly what apply_patch will do - including the
    // dropped-final-closer repair - or the diff shown and the edit
    // applied can disagree. A refusal (marker-like content inside a body)
    // degrades to null; the preview is advisory, the tool reports.
    let blocks: Array<{ search: string; replace: string }>;
    try {
        blocks = parsePatchBlocks(repairPatchMarkers(patch).patch);
    } catch {
        return null;
    }
    if (blocks.length === 0) return null;
    let out = content;
    for (const { search, replace } of blocks) {
        if (out.split(search).length - 1 === 1) {
            out = out.replace(search, () => replace);
            continue;
        }
        const sLines = search.split('\n');
        const cLines = out.split('\n');
        let at = -1;
        for (let i = 0; i <= cLines.length - sLines.length; i++) {
            let match = true;
            for (let j = 0; j < sLines.length; j++) {
                if (cLines[i + j].trimEnd() !== sLines[j].trimEnd()) { match = false; break; }
            }
            if (match) { at = i; break; }
        }
        if (at < 0) return null;
        cLines.splice(at, sLines.length, ...replace.split('\n'));
        out = cLines.join('\n');
    }
    return out;
}

export function computeDiffHunks(oldContent: string, newContent: string): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; removedLines: string[]; addedLines: string[] }> | null {
    // Trim the shared prefix/suffix first: a small edit inside a huge
    // file collapses to the changed region, keeping the LCS table tiny.
    let oldLines = oldContent.split('\n');
    let newLines = newContent.split('\n');
    let trimmed = 0;
    {
        let prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
        let suffix = 0;
        while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
            oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
        if (prefix > 0 || suffix > 0) {
            trimmed = prefix;
            oldLines = oldLines.slice(prefix, oldLines.length - suffix);
            newLines = newLines.slice(prefix, newLines.length - suffix);
        }
    }
    const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; removedLines: string[]; addedLines: string[] }> = [];

    // Simple LCS-based diff
    const m = oldLines.length;
    const n = newLines.length;
    if (m * n > MAX_DIFF_LCS_CELLS) {
        return null;
    }
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find diff regions
    const changes: Array<{ type: 'keep' | 'remove' | 'add'; oldIdx: number; newIdx: number }> = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            changes.unshift({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            changes.unshift({ type: 'add', oldIdx: i, newIdx: j - 1 });
            j--;
        } else {
            changes.unshift({ type: 'remove', oldIdx: i - 1, newIdx: j });
            i--;
        }
    }

    // Group consecutive changes into hunks (with 2 lines of context)
    const contextLines = 2;
    let hunkStart = 0;
    while (hunkStart < changes.length) {
        // Skip keep lines at the start
        while (hunkStart < changes.length && changes[hunkStart].type === 'keep') {
            hunkStart++;
        }
        if (hunkStart >= changes.length) break;

        // Find the end of this change group (with context)
        let hunkEnd = hunkStart;
        let lastChangeIdx = hunkStart;
        while (hunkEnd < changes.length) {
            if (changes[hunkEnd].type !== 'keep') {
                lastChangeIdx = hunkEnd;
            }
            // Stop if we've gone past the last change by contextLines
            if (hunkEnd > lastChangeIdx + contextLines && hunkEnd < changes.length) {
                // Check if there are more changes ahead
                let hasMoreChanges = false;
                for (let k = hunkEnd; k < changes.length; k++) {
                    if (changes[k].type !== 'keep') { hasMoreChanges = true; break; }
                }
                if (!hasMoreChanges) break;
                // Include context and start a new hunk
                hunkEnd = Math.min(hunkEnd + contextLines, changes.length);
                break;
            }
            hunkEnd++;
        }

        // Extract the hunk
        const hunkChanges = changes.slice(hunkStart, hunkEnd);
        const removedLines: string[] = [];
        const addedLines: string[] = [];
        let oldStart = -1;
        let oldCount = 0;
        let newStart = -1;
        let newCount = 0;

        for (const c of hunkChanges) {
            if (c.type === 'remove') {
                if (oldStart === -1) oldStart = c.oldIdx;
                removedLines.push(oldLines[c.oldIdx]);
                oldCount++;
            } else if (c.type === 'add') {
                if (newStart === -1) newStart = c.newIdx;
                addedLines.push(newLines[c.newIdx]);
                newCount++;
            }
        }

        if (removedLines.length > 0 || addedLines.length > 0) {
            hunks.push({
                oldStart: oldStart + 1 + trimmed,
                oldCount,
                newStart: (newStart >= 0 ? newStart : oldStart) + 1 + trimmed,
                newCount,
                removedLines,
                addedLines,
            });
        }

        hunkStart = hunkEnd;
    }

    return hunks;
}

/** One hunk of a before/after pair, flattened for the review surface's
 *  picker: git-style 1-based starts, per-side counts, and a one-line sample
 *  of the change (first added line, else first removed). */
export interface HunkSummary {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    added: number;
    removed: number;
    sample: string;
}

/** Flatten computeDiffHunks for display. Returns null when the LCS table
 *  would blow the cell budget - the caller then falls back to the whole-file
 *  diff instead of pretending there are no changes. */
export function hunkSummaries(before: string, after: string): HunkSummary[] | null {
    const hunks = computeDiffHunks(before, after);
    if (!hunks) return null;
    return hunks.map((h) => ({
        oldStart: h.oldStart,
        oldCount: h.oldCount,
        newStart: h.newStart,
        newCount: h.newCount,
        added: h.addedLines.length,
        removed: h.removedLines.length,
        sample: (h.addedLines[0] ?? h.removedLines[0] ?? '').trim().slice(0, 120),
    }));
}

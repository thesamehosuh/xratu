// Pure helpers for the composer's @-mention workspace-file picker (pure =
// unit-testable without a DOM - see test/mention.test.ts).  UX follows the
// Cursor/Claude Code/Cline pattern: typing `@` at a word boundary opens a
// file popup, the picked file becomes a workspace-REFERENCE attachment chip,
// and the host reads the file's content at send time (always fresh).

/** A live @-mention in the composer: `start` is the index of the `@`,
 *  `query` is the text typed after it up to the caret. */
export interface MentionState {
    start: number;
    caret: number;
    query: string;
}

/** Detect an open mention ending at `caret`. The `@` must start the text or
 *  follow whitespace (never mid-word like an email address), and the token
 *  between it and the caret must contain no whitespace. */
export function detectMention(text: string, caret: number): MentionState | null {
    if (caret <= 0 || caret > text.length) return null;
    // Scan back from the caret to the nearest whitespace/line break.
    let start = -1;
    for (let i = caret - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '@') {
            if (i === 0 || /\s/.test(text[i - 1])) start = i;
            break;
        }
        if (/\s/.test(ch)) break;
    }
    if (start < 0) return null;
    const query = text.slice(start + 1, caret);
    if (query.length > 512) return null;
    return { start, caret, query };
}

/** Remove the `@query` token from the text once a file is picked (the chip
 *  itself carries the reference - Cline-style replacement, not inline text).
 *  Returns the new text with the caret positioned at the removal point,
 *  separated from following text by one space when needed. */
export function applyMentionPick(
    text: string,
    start: number,
    caret: number,
): { text: string; caret: number } {
    const before = text.slice(0, start);
    const after = text.slice(caret);
    const needsSpace = after.length > 0 && !/^\s/.test(after);
    const merged = needsSpace ? `${before} ${after}` : `${before}${after}`;
    return { text: merged, caret: start + (needsSpace ? 1 : 0) };
}

/** Substring filter with a light relevance ranking: basename matches beat
 *  full-path matches, prefix matches beat infix, shorter paths win ties.
 *  Bounded so huge workspaces never flood the popup. */
export function filterFiles(files: string[], query: string, limit = 50): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, limit);
    const terms = q.split(/[\s/\\]+/).filter(Boolean);
    const scored: Array<{ path: string; score: number }> = [];
    for (const p of files) {
        const lower = p.toLowerCase();
        const base = lower.slice(lower.lastIndexOf('/') + 1);
        let ok = true;
        let score = 0;
        for (const term of terms) {
            const inBase = base.includes(term);
            const inPath = lower.includes(term);
            if (!inBase && !inPath) { ok = false; break; }
            score += inBase ? 4 : 1;
            if (base.startsWith(term)) score += 4;
            if (lower.startsWith(term)) score += 2;
        }
        if (!ok) continue;
        score += Math.max(0, 8 - Math.floor(p.length / 16));
        scored.push({ path: p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
    return scored.slice(0, limit).map((s) => s.path);
}

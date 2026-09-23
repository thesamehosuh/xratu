/**
 * `git status --porcelain=v1 --branch` → a compact summary for the status line
 * under the composer.
 *
 * Pure and dependency-free so it can be unit-tested without VS Code or git;
 * running the command lives in the extension host.
 */

export interface GitStatusSummary {
    /** False when the workspace is not a git repository (or git is missing). */
    isRepo: boolean;
    branch: string | null;
    /** True for a detached HEAD (`## HEAD (no branch)`). */
    detached: boolean;
    upstream: string | null;
    ahead: number;
    behind: number;
    /** Changes staged in the index (X column). */
    staged: number;
    /** Tracked files changed in the working tree (Y column). */
    modified: number;
    untracked: number;
    /** Unmerged paths - reported apart because "resolve this" is a different
     *  action from "commit this". */
    conflicted: number;
}

/** Not-a-repo / git-unavailable state. */
export function emptyGitStatus(): GitStatusSummary {
    return {
        isRepo: false,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicted: 0,
    };
}

/** Unmerged XY codes - every combination of added/deleted/modified on both
 *  sides. `UU` is the common one, the rest are rename/delete variants. */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse porcelain v1 output. Assumes the command SUCCEEDED (the host reports
 * `emptyGitStatus()` when it did not), so the result is always `isRepo: true`.
 */
export function parseGitStatus(stdout: string): GitStatusSummary {
    const out: GitStatusSummary = { ...emptyGitStatus(), isRepo: true };
    for (const rawLine of stdout.split(/\r?\n/)) {
        if (!rawLine) continue;
        if (rawLine.startsWith('## ')) {
            parseBranchLine(rawLine.slice(3), out);
            continue;
        }
        if (rawLine.length < 3) continue;
        const code = rawLine.slice(0, 2);
        if (code === '??') {
            out.untracked += 1;
            continue;
        }
        if (CONFLICT_CODES.has(code)) {
            out.conflicted += 1;
            continue;
        }
        // Anything else malformed is ignored rather than counted as a change -
        // a wrong number in a status line is worse than a missing one.
        if (!/^[ MADRCU?!]{2}$/.test(code)) continue;
        if (code[0] !== ' ' && code[0] !== '?') out.staged += 1;
        if (code[1] !== ' ' && code[1] !== '?') out.modified += 1;
    }
    return out;
}

/**
 * Local branch names from
 * `git for-each-ref --format=%(refname:short) refs/heads`.
 *
 * Sorted and deduped for a stable list, and anything that could be read as an
 * OPTION is dropped here rather than at the checkout call - the picker's data
 * and the checkout allowlist must be the same list.
 */
export function parseBranchList(stdout: string): string[] {
    const seen = new Set<string>();
    for (const raw of stdout.split(/\r?\n/)) {
        const name = raw.trim();
        if (!name || !isSafeBranchName(name)) continue;
        seen.add(name);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * True when a branch name is safe to hand to git as a standalone argv entry.
 *
 * The only thing that matters is that it cannot be mistaken for an OPTION
 * (`--upload-pack=…`, `-D`, …): git already forbids most of this in branch
 * names, so this is the belt to that suspenders - and it is shared by the
 * listing and the checkout path so they can never disagree about what is
 * acceptable.
 */
export function isSafeBranchName(name: unknown): boolean {
    const s = String(name ?? '');
    if (!s || s.length > 255) return false;
    if (s.startsWith('-')) return false;
    if (/\s/.test(s)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(s)) return false;
    return true;
}

/** `main...origin/main [ahead 1, behind 2]` / `HEAD (no branch)` /
 *  `No commits yet on main` / `Initial commit on main`. */
function parseBranchLine(text: string, out: GitStatusSummary): void {
    const bracket = text.match(/\s\[([^\]]*)\]\s*$/);
    if (bracket) {
        const ahead = bracket[1].match(/ahead (\d+)/);
        const behind = bracket[1].match(/behind (\d+)/);
        out.ahead = ahead ? Number(ahead[1]) : 0;
        out.behind = behind ? Number(behind[1]) : 0;
    }
    const head = (bracket ? text.slice(0, text.length - bracket[0].length) : text).trim();
    if (/^HEAD \(no branch\)$/i.test(head)) {
        out.detached = true;
        return;
    }
    const unborn = head.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/i);
    if (unborn) {
        out.branch = unborn[1].trim() || null;
        return;
    }
    const [local, upstream] = head.split('...');
    out.branch = (local ?? '').trim() || null;
    if (upstream && upstream.trim()) out.upstream = upstream.trim();
    // No branch name at all: git could not name a branch, so treat it as
    // detached rather than showing an empty name.
    if (!out.branch) out.detached = true;
}

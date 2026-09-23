import { GitBranch } from 'lucide-react';
import type { GitStatusSummary } from '../types';
import { t, tf } from '../i18n';

interface GitStatusBarProps {
    status: GitStatusSummary | null;
    /** Workspace folder the status is for ($HOME-compacted by the host). */
    root: string | null;
    /** Open the branch drop-up (the line is the picker's trigger). */
    onOpenPicker: () => void;
}

/** Head-truncate a long path: the TAIL is the informative part, so an ellipsis
 *  at the front beats CSS's default (which would eat the folder name). */
function compactPath(value: string, max = 38): string {
    return value.length <= max ? value : `\u2026${value.slice(value.length - max + 1)}`;
}

/**
 * Plain monochrome status line UNDER the composer card: the branch and what is
 * uncommitted in it.
 *
 * Deliberately unframed - no border, no background - because this is ambient
 * information about the workspace, not a control; it must not compete with the
 * composer above it. Renders nothing at all outside a git repository, so a
 * non-git workspace shows no trace of it.
 */
export function GitStatusBar({ status, root, onOpenPicker }: GitStatusBarProps) {
    if (!status || !status.isRepo) return null;

    const parts: string[] = [];
    if (status.staged > 0) parts.push(tf('gitStagedCount', { n: String(status.staged) }));
    if (status.modified > 0) parts.push(tf('gitModifiedCount', { n: String(status.modified) }));
    if (status.untracked > 0) parts.push(tf('gitUntrackedCount', { n: String(status.untracked) }));
    if (status.conflicted > 0) parts.push(tf('gitConflictedCount', { n: String(status.conflicted) }));
    if (status.ahead > 0) parts.push(`\u2191${status.ahead}`);
    if (status.behind > 0) parts.push(`\u2193${status.behind}`);
    // A clean tree still reports the branch - "main" alone is the useful fact.
    if (parts.length === 0) parts.push(t('gitClean'));

    const branch = status.branch ?? t('gitDetachedHead');
    return (
        <button
            type="button"
            className="git-status"
            dir="ltr"
            onClick={onOpenPicker}
            title={t('gitStatusOpen')}
            aria-label={`${root ? `${root} ` : ''}${branch}: ${parts.join(', ')}`}
        >
            {/* Folder then branch on the left, counts on the right: which
                workspace, which branch, and what is uncommitted - in the order
                you read them. */}
            <span className="git-status-side">
                <GitBranch size={11} aria-hidden="true" />
                {root && (
                    <span className="git-status-path" title={root}>{compactPath(root)}</span>
                )}
                <span className="git-status-branch">{branch}</span>
            </span>
            <span className="git-status-side git-status-stats">{parts.join(' \u00b7 ')}</span>
        </button>
    );
}

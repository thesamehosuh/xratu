/**
 * Virtual-document side of the edit-step "open diff in editor" button: feeds
 * two `xratu-diff:` URIs into the host's native side-by-side diff editor
 * (`vscode.diff`).
 *
 * The content map is the provider's EXISTING `_virtualDocuments` (extension.ts
 * registers the `xratu-diff` scheme against it) - this module only writes
 * entries and evicts the oldest ones so a long review session cannot grow it
 * without bound. The URI path ends in the real basename so VS Code derives the
 * language mode from the file extension (virtual docs have no disk backing).
 */
import * as vscode from 'vscode';
import * as path from 'path';

const SCHEME = 'xratu-diff';
/** Two entries (before/after) per opened diff. */
const MAX_DOCS = 60;

/**
 * Open a native side-by-side diff for `filePath`. Returns false when there is
 * nothing to diff (identical sides - the caller shows a banner instead).
 */
export function openEditDiff(
    store: Map<string, string>,
    filePath: string,
    before: string,
    after: string
): boolean {
    if (before === after) return false;
    const base = path.basename(filePath) || 'file';
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const left = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/before/${base}` });
    const right = vscode.Uri.from({ scheme: SCHEME, path: `/${id}/after/${base}` });
    store.set(left.toString(), before);
    store.set(right.toString(), after);
    // Bound the map: drop the oldest pair first (insertion order).
    while (store.size > MAX_DOCS) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
    }
    void vscode.commands.executeCommand('vscode.diff', left, right, filePath || 'diff');
    return true;
}

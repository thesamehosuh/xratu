/**
 * Collect AGENTS.md project rules for the local system prompt: workspace
 * root first, then every nested directory between it and the active file
 * (closest wins - it is sent last). Split out of extension.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Collect AGENTS.md project rules: workspace root first, then every nested
 *  directory between it and the active file (closest wins - it is sent last).
 *  Everything travels inside the normal authenticated /chat request body, so
 *  no second network path exists. */
export async function collectProjectRules(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';

    let rootFsPath = folders[0].uri.fsPath;
    let activeFsPath: string | null = null;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
        const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (wf) {
            rootFsPath = wf.uri.fsPath;
            activeFsPath = editor.document.uri.fsPath;
        }
    }

    // Chain of directories from the root down to the active file's folder.
    const dirs: string[] = [];
    if (activeFsPath) {
        const stop = path.resolve(rootFsPath);
        // Windows paths are case-insensitive; a casing mismatch between the
        // workspace folder and the editor document (c:\Work vs C:\Work) would
        // otherwise make this walk climb past the workspace root.
        const sameDir = (a: string, b: string) => process.platform === 'win32'
            ? a.toLowerCase() === b.toLowerCase()
            : a === b;
        const insideRoot = (dir: string) => process.platform === 'win32'
            ? dir.toLowerCase().startsWith(stop.toLowerCase() + path.sep) || sameDir(dir, stop)
            : dir.startsWith(stop + path.sep) || sameDir(dir, stop);
        let dir = path.dirname(path.resolve(activeFsPath));
        while (true) {
            dirs.unshift(dir);
            if (sameDir(dir, stop)) break;
            const parent = path.dirname(dir);
            if (parent === dir || !insideRoot(dir)) break;
            dir = parent;
        }
    } else {
        dirs.push(path.resolve(rootFsPath));
    }

    const PER_FILE_CAP = 4000;
    const TOTAL_CAP = 8000;
    const sections: string[] = [];
    let total = 0;
    for (const dir of dirs) {
        const file = path.join(dir, 'AGENTS.md');
        try {
            let text = await fs.promises.readFile(file, 'utf-8');
            if (text.length > PER_FILE_CAP) {
                const fullLen = text.length;
                text = text.slice(0, PER_FILE_CAP)
                    + `\n… (truncated - showing first ${PER_FILE_CAP} of ${fullLen} chars; read the file directly for the rest)`;
            }
            total += text.length;
            if (total > TOTAL_CAP) break;
            const rel = path.relative(rootFsPath, dir);
            sections.push(`## ${rel && rel !== '' ? rel + '/' : ''}AGENTS.md\n${text.trim()}`);
        } catch { /* no rules at this level */ }
    }
    return sections.join('\n\n');
}

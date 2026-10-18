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

    // Built-in tools and checkpoints execute in the first workspace folder.
    // An editor in another workspace must not supply that run's instructions.
    const rootFsPath = folders[0].uri.fsPath;
    let activeFsPath: string | null = null;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
        const relative = path.relative(path.resolve(rootFsPath), path.resolve(editor.document.uri.fsPath));
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
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

    const sections: string[] = [];
    for (const dir of dirs) {
        const file = path.join(dir, 'AGENTS.md');
        try {
            const text = (await fs.promises.readFile(file, 'utf-8')).replace(/^\uFEFF/, '');
            const rel = path.relative(rootFsPath, dir);
            sections.push(`## ${rel && rel !== '' ? rel + '/' : ''}AGENTS.md\n${text.trim()}`);
        } catch (error) {
            // Missing rules are normal; unreadable rules must not disappear.
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        }
    }
    return sections.join('\n\n');
}

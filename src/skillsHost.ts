/**
 * VS Code-facing skill folder operations: path checks, opening/scaffolding
 * SKILL.md, and closing stale editor tabs after a rename. Split out of
 * extension.ts (skills.ts itself stays vscode-free and node-testable).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SKILL_FILE } from './skills';

export async function isDir(p: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

/** True only for paths at or inside a known skills location - the reveal
 *  handler must not become a generic "show any folder in explorer" tool
 *  driven by webview-supplied paths. Both sides are canonicalized with
 *  realpath so symlinks/`..` cannot smuggle a path lexically inside a
 *  skills root while resolving elsewhere on disk. */
export async function isKnownSkillsPath(p: string): Promise<boolean> {
    let real: string;
    try {
        real = await fs.promises.realpath(p);
    } catch {
        return false;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const candidates: string[] = [
        path.join(os.homedir(), '.agents', 'skills'),
    ];
    if (root) {
        candidates.push(
            path.join(root, '.xratu', 'skills'),
            path.join(root, '.agents', 'skills'),
        );
    }
    for (const base of candidates) {
        let baseReal: string;
        try {
            baseReal = await fs.promises.realpath(base);
        } catch {
            continue;
        }
        if (real === baseReal || real.startsWith(baseReal + path.sep)) return true;
    }
    return false;
}

/** Open (creating if needed) a skill's SKILL.md in an editor tab. Caller
 *  must have validated skillDir as a known skills location. */
export async function openSkillFile(skillDir: string): Promise<void> {
    const file = path.join(skillDir, SKILL_FILE);
    try {
        await fs.promises.access(file);
    } catch {
        const fallbackName = path.basename(skillDir) || 'new-skill';
        const template = [
            '---',
            `name: ${fallbackName}`,
            'description: TODO - describe what this skill does and when the agent should load it.',
            '---',
            '',
            `# ${fallbackName}`,
            '',
        ].join('\n');
        await fs.promises.writeFile(file, template, 'utf8');
    }
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
}

/** After discovery auto-renamed a skill folder, close editor tabs still
 *  open on the OLD SKILL.md path. Without this, saving such a stale tab
 *  recreates the old folder and the skill reappears as a duplicate.
 *  Unsaved edits are carried over to the renamed file first. */
export async function closeStaleSkillEditors(oldDir: string, newDir: string): Promise<void> {
    try {
        const tabGroups = (vscode.window as unknown as {
            tabGroups?: {
                // Groups live in `all`; each group carries its `tabs`.
                all?: readonly { tabs?: readonly { input?: unknown }[] }[];
                close?: (tabs: unknown[], preserveFocus?: boolean) => Thenable<boolean>;
            };
        }).tabGroups;
        const tabs = (tabGroups?.all ?? []).flatMap((g) => g.tabs ?? []);
        if (tabs.length === 0 || !tabGroups?.close) return;
        const oldFile = path.join(oldDir, SKILL_FILE);
        const newFile = path.join(newDir, SKILL_FILE);
        const samePath = (a: string, b: string) =>
            path.resolve(a) === path.resolve(b)
            || (process.platform === 'win32' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase());
        const stale = tabs.filter((t) => {
            const input = t.input as { uri?: { fsPath?: string } } | undefined;
            const fsPath = input && typeof input === 'object' ? input.uri?.fsPath : undefined;
            return !!fsPath && samePath(fsPath, oldFile);
        });
        if (stale.length === 0) return;
        const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, oldFile));
        if (doc?.isDirty) {
            await fs.promises.writeFile(newFile, Buffer.from(doc.getText(), 'utf8'));
        }
        await tabGroups.close(stale, true);
    } catch {
        /* best effort - editor bookkeeping must never surface as a chat error */
    }
}

/**
 * Path safety + patch parsing shared by the MCP bridge and the host.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PatchBlock { search: string; replace: string; }

/** Parse SEARCH/REPLACE patch blocks. Accepts the standard Cline/Claude-style
 *  markers (models emit these natively) and falls back to the legacy
 *  ===<<< … >>>=== internal variant. An EMPTY SEARCH block is the new-file
 *  creation idiom and is preserved for callers to handle. */
export function parsePatchBlocks(patch: string): PatchBlock[] {
    const out: PatchBlock[] = [];
    const stdRe = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
    let m: RegExpExecArray | null;
    while ((m = stdRe.exec(patch)) !== null) {
        out.push({ search: m[1], replace: m[2] });
    }
    if (out.length > 0) {
        // A block body that itself contains marker lines makes the non-greedy
        // split ambiguous - the regex silently re-slices the patch (seen live:
        // a markdown doc containing '=======' lines got shredded). Refuse
        // loudly so the caller restructures instead of corrupting the file.
        for (const b of out) {
            if (/^(?:<{7}|={7}|>{7})/m.test(b.search) || /^(?:<{7}|={7}|>{7})/m.test(b.replace)) {
                throw new Error(
                    "patch block content contains a line that looks like a SEARCH/REPLACE marker "
                    + "('<<<<<<<', '=======', '>>>>>>>'). Restructure the patch: edit that hunk "
                    + "with replace_in_file, or rewrite the content without marker-like lines."
                );
            }
        }
        return out;
    }
    return patch
        .split('===<<<')
        .filter((b) => b.includes('>>>==='))
        .map((b) => {
            const parts = b.split('>>>===');
            return { search: (parts[0] ?? '').trim(), replace: (parts[1] ?? '').trim() };
        })
        .filter((b) => b.search.length > 0);
}

function comparable(p: string): string {
    // Windows filesystems are case-insensitive; containment checks must be too,
    // or C:/work vs c:/work slips through the workspace boundary.
    return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function sanitizePath(userPath: string, workspaceRoot: string): string {
    if (!workspaceRoot) {
        throw new Error('No workspace open. Open a folder in VS Code before using file operations.');
    }
    // Windows drive-relative paths ("C:foo" = CWD of drive C + foo) are NOT
    // absolute, so path.join would naively nest them inside the workspace -
    // but the filesystem resolves the drive prefix and escapes. Refuse them.
    if (/^[a-zA-Z]:(?![\\/])/.test(userPath)) {
        throw new Error(`Path '${userPath}' is outside the workspace.`);
    }
    // The workspace root itself may sit behind a symlinked prefix (macOS
    // /tmp → /private/tmp); compare against its REAL path or every resolved
    // target fails containment.
    let realRoot: string;
    try {
        realRoot = fs.realpathSync(workspaceRoot);
    } catch {
        realRoot = path.resolve(workspaceRoot);
    }
    const fullPath = path.normalize(path.isAbsolute(userPath) ? userPath : path.join(realRoot, userPath));
    // Resolve symlinks to prevent traversal via symlinked directories.
    // Use realpathSync on the parent (which must exist) + basename to handle
    // the case where the target file doesn't exist yet (e.g. edit_file create).
    let resolved: string;
    try {
        resolved = fs.realpathSync(fullPath);
    } catch {
        // ENOENT has two very different causes: the final component simply
        // doesn't exist yet (safe - resolve the parent), OR the component is
        // a DANGLING SYMLINK whose target is missing (unsafe - falling back
        // to parent+basename keeps the symlink path, containment passes, and
        // a subsequent write creates the link's target ANYWHERE). Distinguish
        // with lstat: a dangling link has a directory entry.
        let linkExists = false;
        try {
            fs.lstatSync(fullPath);
            linkExists = true;
        } catch { /* genuinely absent - safe to fall back */ }
        if (linkExists) {
            throw new Error(`Path '${userPath}' is a symlink whose target does not exist (refused).`);
        }
        const parent = path.dirname(fullPath);
        const base = path.basename(fullPath);
        try {
            resolved = path.join(fs.realpathSync(parent), base);
        } catch {
            // Parent doesn't exist either - fall back to normalized path
            // (the write will fail with ENOENT, which is safe)
            resolved = fullPath;
        }
    }
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    const inside = comparable(resolved).startsWith(comparable(rootWithSep));
    if (!inside && comparable(resolved) !== comparable(realRoot)) {
        throw new Error(`Path '${userPath}' is outside the workspace.`);
    }
    return resolved;
}

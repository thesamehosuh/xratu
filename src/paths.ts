/**
 * Path safety + patch parsing shared by the MCP bridge and the host.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PatchBlock { search: string; replace: string; }

/** Count marker lines anchored at the start of a line (the parser only ever
 *  treats line-initial markers as structural). */
function countMarkerLines(patch: string, re: RegExp): number {
    return (patch.match(re) ?? []).length;
}

/** Canonical block shape, shown in diagnostics so the model can copy it. */
const PATCH_TEMPLATE = '<<<<<<< SEARCH\n<current file lines>\n=======\n<replacement lines>\n>>>>>>> REPLACE';

/**
 * Explain why a marker-based patch produced no blocks, or null when the text
 * holds no marker-like content at all (the caller's generic message is then
 * the honest answer).
 *
 * Regression: a patch sent without its final `>>>>>>> REPLACE` line parsed to
 * zero blocks and the caller reported only "no valid SEARCH/REPLACE blocks
 * found" - which names neither the fault nor the fix, so a recoverable
 * syntax slip (an omitted closing marker) became a dead end. Diagnosing here
 * keeps the explanation next to the parser that knows the exact grammar.
 */
export function diagnosePatchBlocks(patch: string): string | null {
    // Markers crammed onto ONE line. This is exactly what a model produces when
    // it imitates a tool description whose multi-line example was flattened onto
    // a single line - which the apply_patch description literally did. The
    // parser needs a newline after each marker, so such a patch can never parse;
    // naming this beats reporting a "missing separator" the model cannot see.
    // The opener must START the line: an inline `... <<<<<<< ...` inside a block
    // body is legitimate content (a well-formed patch parses it), so it must not
    // be mistaken for a flattened patch when the patch is malformed for some
    // other reason.
    const oneLine = patch
        .split(/\r?\n/)
        .find((line) => /^\s*<<<<<<</.test(line) && (line.includes('=======') || line.includes('>>>>>>>')));
    if (oneLine) {
        return `the SEARCH/REPLACE markers are on ONE line: "${oneLine.trim().slice(0, 100)}". `
            + `Each marker must be ALONE on its own line. Write it as:\n${PATCH_TEMPLATE}`;
    }
    const opens = countMarkerLines(patch, /^<<<<<<<.*$/gm);
    const seps = countMarkerLines(patch, /^=======\r?$/gm);
    const closes = countMarkerLines(patch, /^>>>>>>>.*$/gm);
    // Only an OPEN or CLOSE marker makes this text look like an attempted
    // patch. A lone `=======` is ordinary prose (a markdown rule, an RST
    // underline, diff-ish tool output), so it must still return [] and let the
    // caller keep its generic message.
    if (opens === 0 && closes === 0) return null;

    if (opens > 0 && closes === 0) {
        return `patch has ${opens} opening '<<<<<<< SEARCH' marker line(s) but NO closing `
            + `'>>>>>>> REPLACE' marker. The closing marker is the one most often dropped - `
            + `add it directly after the replacement text and re-send the SAME block unchanged. `
            + `The exact shape:\n${PATCH_TEMPLATE}`;
    }
    if (opens > 0 && seps === 0) {
        return `patch has ${opens} '<<<<<<< SEARCH' marker line(s) but no '=======' separator `
            + `marker line. '=======' goes ALONE on its own line, between the search text and the `
            + `replacement text. The exact shape:\n${PATCH_TEMPLATE}`;
    }
    if (opens === 0 && closes > 0) {
        return `patch has ${closes} '>>>>>>> REPLACE' marker line(s) but no '<<<<<<< SEARCH' `
            + `opening marker - every block starts with '<<<<<<< SEARCH'. `
            + `The exact shape:\n${PATCH_TEMPLATE}`;
    }
    if (opens !== closes) {
        return `patch has ${opens} opening '<<<<<<< SEARCH' marker line(s) and ${closes} closing `
            + `'>>>>>>> REPLACE' marker line(s) - the counts must match, one closing marker per `
            + `opened block. The exact shape:\n${PATCH_TEMPLATE}`;
    }
    if (seps < opens) {
        return `patch opens ${opens} block(s) but has only ${seps} '=======' separator marker `
            + `line(s) - each block needs its own '=======' between search and replacement. `
            + `The exact shape:\n${PATCH_TEMPLATE}`;
    }
    // Markers are present in plausible numbers yet no block parsed, so the
    // FORM is off (stray text on a marker line, wrong case, trailing spaces).
    return `patch contains SEARCH/REPLACE marker lines but no block parsed. Each marker must be `
        + `exactly '<<<<<<< SEARCH', '=======' and '>>>>>>> REPLACE', alone on its own line `
        + `(no trailing text, no leading whitespace). The exact shape:\n${PATCH_TEMPLATE}`;
}

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
        // An opener with no closing marker is silently SKIPPED by the
        // non-greedy scan: the earlier blocks parse, the unterminated one
        // vanishes, and the caller believes the whole patch landed. Refuse
        // rather than partially apply a patch the model thinks is complete.
        const opened = countMarkerLines(patch, /^<<<<<<<.*$/gm);
        if (opened > out.length) {
            throw new Error(
                `patch opens ${opened} block(s) but only ${out.length} close with '>>>>>>> REPLACE' - `
                + `the counts must match. The unterminated block(s) would be silently dropped: add the `
                + `missing closing marker and re-send the SAME patch.`
            );
        }
        return out;
    }
    const legacy = patch
        .split('===<<<')
        .filter((b) => b.includes('>>>==='))
        .map((b) => {
            const parts = b.split('>>>===');
            return { search: (parts[0] ?? '').trim(), replace: (parts[1] ?? '').trim() };
        })
        .filter((b) => b.search.length > 0);
    if (legacy.length > 0) return legacy;

    // Nothing parsed. If the text looks like an attempted patch, say exactly
    // what is wrong instead of handing back [] for the caller to describe
    // generically; genuinely marker-less text still returns [].
    const diagnosis = diagnosePatchBlocks(patch);
    if (diagnosis) throw new Error(diagnosis);
    return [];
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

/**
 * Host-side attachment layer: validation (the layer that actually guards
 * the send - the webview's checks are UX only), mime/size helpers, prompt
 * fencing, and reading @-mention reference files at send time. Split out
 * of extension.ts.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { sanitizePath } from './paths';
import type { ComposerAttachment } from './chatViewTypes';

// ---------------------------------------------------------------------------
// Attachment validation (host-side check - the webview's checks are a UX
// convenience; this is the layer that actually guards the send).
// ---------------------------------------------------------------------------

const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ATTACH_TEXT_EXTRA_TYPES = new Set([
    'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/toml', 'application/javascript', 'application/x-sh',
]);
export const ATTACH_MAX_COUNT = 20;
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Cap on attachment text (the webview mirrors this value). */
const ATTACH_TEXT_MAX_CHARS = 24_000;

export function isImageAttachment(mime: string): boolean {
    return ATTACH_IMAGE_TYPES.has(mime);
}

export function isTextAttachment(mime: string): boolean {
    return mime.startsWith('text/') || ATTACH_TEXT_EXTRA_TYPES.has(mime);
}

/** PDFs are allowed IN and are text-extracted host-side (pdfExtract.ts); raw
 *  application/pdf is never sent to a model. */
export function isPdfAttachment(mime: string): boolean {
    return mime === 'application/pdf';
}

const HOST_IMAGE_EXT_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};

/** Text/source extensions accepted as inline text attachments (subset of the
 *  webview's ATTACH_TEXT_EXTENSIONS - same list, kept in sync). */
const TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'jsonc', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env', 'log',
    'properties', 'py', 'pyw', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less',
    'html', 'htm', 'vue', 'svelte', 'astro', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
    'swift', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'php', 'zsh', 'fish', 'ps1',
    'psm1', 'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'dockerfile', 'makefile',
    'mk', 'cmake', 'gradle', 'lock', 'gitignore', 'gitattributes', 'editorconfig',
    'npmrc', 'diff', 'patch', 'lua', 'pl', 'pm', 'r', 'dart', 'elm', 'ex', 'exs',
    'erl', 'hrl', 'clj', 'cljs', 'scala', 'groovy', 'tf', 'tfvars', 'hcl', 'sol',
    'zig', 'nim', 'v', 'asm', 's', 'm', 'mm',
]);

/** Extension → MIME for explorer-dragged files (mirrors the webview's
 *  mimeForFile; browsers aren't involved here so there is no File.type).
 *  Returns '' for UNKNOWN extensions - binaries (mp3/mp4/zip/…) must be
 *  rejected, never shipped as text/plain garbage. */
export function mimeFromFilename(name: string): string {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : name.toLowerCase();
    if (HOST_IMAGE_EXT_MIME[ext]) return HOST_IMAGE_EXT_MIME[ext];
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'json' || ext === 'jsonc') return 'application/json';
    if (ext === 'xml') return 'application/xml';
    if (ext === 'yaml' || ext === 'yml') return 'application/yaml';
    if (ext === 'toml') return 'application/toml';
    if (ext === 'sh' || ext === 'bash') return 'application/x-sh';
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'application/javascript';
    if (TEXT_FILE_EXTENSIONS.has(ext)) return 'text/plain';
    return '';
}

/** Decoded byte length of a base64 payload, without materializing it. */
function decodedBase64Len(dataBase64: string): number {
    const stripped = dataBase64.includes(',') ? dataBase64.slice(dataBase64.indexOf(',') + 1) : dataBase64;
    const trimmed = stripped.trimEnd();
    let padding = 0;
    while (padding < trimmed.length && trimmed[trimmed.length - 1 - padding] === '=') padding++;
    return Math.max(Math.floor(trimmed.length / 4) * 3 - padding, 0);
}

/** Returns a user-facing error as an i18n key (+ params), or null when the
 *  attachments pass. The webview resolves the key via tf(). */
export function validateHostAttachments(attachments: ComposerAttachment[] | undefined): { key: string; params?: Record<string, string> } | null {
    if (!attachments || attachments.length === 0) return null;
    if (attachments.length > ATTACH_MAX_COUNT) {
        return { key: 'attachTooMany' };
    }
    let total = 0;
    for (const a of attachments) {
        const decoded = decodedBase64Len(a.dataBase64);
        if (decoded === 0) return { key: 'attachEmpty', params: { name: a.name } };
        total += decoded;
        if (total > ATTACH_MAX_TOTAL_BYTES) return { key: 'attachTotalTooLarge' };
        if (decoded > ATTACH_MAX_BYTES) return { key: 'attachTooLarge', params: { name: a.name } };
        if (!isImageAttachment(a.mimeType) && !isTextAttachment(a.mimeType) && !isPdfAttachment(a.mimeType)) {
            return { key: 'attachUnsupported', params: { name: a.name } };
        }
    }
    return null;
}

/** Prompt text for the local loop: text attachments ride as fenced blocks
 *  (no vision needed); caps match ATTACH_TEXT_MAX_CHARS. Shared by the
 *  opening prompt AND steered messages. */
export function buildLocalUserText(prompt: string, attachments?: ComposerAttachment[]): string {
    const textBlocks: string[] = [];
    for (const a of attachments ?? []) {
        if (!isTextAttachment(a.mimeType)) continue;
        let content = Buffer.from(a.dataBase64, 'base64').toString('utf8');
        if (content.length > ATTACH_TEXT_MAX_CHARS) {
            const remaining = content.length - ATTACH_TEXT_MAX_CHARS;
            content = content.slice(0, ATTACH_TEXT_MAX_CHARS)
                + `\n… [file truncated, ${remaining} more characters - read the file with your tools if needed]`;
        }
        textBlocks.push(`[Attached file: ${a.name}]\n\`\`\`\n${content}\n\`\`\``);
    }
    return [prompt, ...textBlocks].filter((p) => p.length > 0).join('\n\n')
        || 'Describe the attached file(s).';
}

/** Resolve @-mention REFERENCE attachments (path-only chips) by reading
 *  the workspace files NOW - content is always current at send time, and
 *  the resolved text/image bytes flow through the exact same downstream
 *  pipeline as picker attachments (host validation, PDF extraction,
 *  fenced blocks in the user prompt). Mutates entries in place.
 *  Fail-closed: any unresolvable ref aborts the send with a composer
 *  error, never a silently dropped reference. */
export async function resolveReferenceAttachments(
    attachments: ComposerAttachment[] | undefined
): Promise<{ key: string; params?: Record<string, string> } | null> {
    if (!attachments || attachments.length === 0) return null;
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    let totalBytes = attachments
        .filter((a) => !a.path)
        .reduce((sum, a) => sum + decodedBase64Len(a.dataBase64), 0);
    for (const a of attachments) {
        if (!a.path) continue;
        const rel = a.path.replace(/\\/g, '/').replace(/^\.\//, '');
        let abs: string;
        try {
            // sanitizePath enforces workspace containment + symlink safety.
            abs = sanitizePath(rel, wsFolder ? wsFolder.uri.fsPath : '');
        } catch {
            return { key: 'attachRefOutside', params: { name: rel } };
        }
        const uri = vscode.Uri.file(abs);
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch {
            return { key: 'attachRefNotFound', params: { name: rel } };
        }
        if (stat.type & vscode.FileType.Directory) {
            return { key: 'attachIsFolder', params: { name: rel } };
        }
        if (stat.size === 0) {
            return { key: 'attachEmpty', params: { name: rel } };
        }
        if (stat.size > ATTACH_MAX_BYTES) {
            return { key: 'attachTooLarge', params: { name: rel } };
        }
        if (totalBytes + stat.size > ATTACH_MAX_TOTAL_BYTES) {
            return { key: 'attachTotalTooLarge' };
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        // mimeFromFilename returns '' for unknown extensions - sniff the
        // bytes instead of guessing: decodable NUL-free UTF-8 is text,
        // everything else is refused (fail-closed binary protection).
        let mime = mimeFromFilename(path.basename(abs));
        if (!mime) {
            const isText = !bytes.includes(0) && Buffer.from(bytes).toString('utf8').length > 0;
            if (!isText) return { key: 'attachUnsupported', params: { name: rel } };
            mime = 'text/plain';
        }
        if (isTextAttachment(mime) && (bytes.includes(0) || Buffer.from(bytes).toString('utf8').includes('\uFFFD'))) {
            return { key: 'attachUnsupported', params: { name: rel } };
        }
        totalBytes += stat.size;
        a.dataBase64 = Buffer.from(bytes).toString('base64');
        a.size = stat.size;
        a.mimeType = mime;
        // The model and every chip/history view identify the file by its
        // workspace-relative path (Cline-style), not the bare basename.
        a.name = rel;
    }
    return null;
}

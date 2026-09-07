import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import { getLocalToolDefinitions, createLocalToolExecutor } from './mcp';
import { sanitizePath } from './paths';
import { insecureRemoteHttpError, isLikelyLocalUrl } from './endpointGuard';
import { sessionApprovalKind, isSessionApproved } from './sessionApproval';
import { ShadowCheckpointStore, EmptySeedError } from './shadowGit';
import { ExternalMcpManager } from './externalMcp';
import { McpConfigStore, type ExternalServerConfig, type McpSaveTarget } from './mcpConfig';
import { runLocalAgent, type LocalAgentEvent, type LocalImageAttachment, type LocalUsage } from './local/localAgent';
import type { LocalToolExecutor } from './local/localAgent';
import { extractPdfAttachments } from './pdfExtract';
import { LocalSessionStore, resolveSessionTitle } from './local/localSessionStore';
import { discoverLocalRuntimes, probeCustomEndpoint, probeLocalEndpoint, modelIsLikelyVision, modelLikelySupportsTools } from './local/localModelClient';
import type { DiscoveredLocalModel } from './local/localModelClient';
import { ui, setUiLocale } from './uiStrings';
import { BACKEND_SYSTEM_PROMPT } from './systemPrompt';
import { gitWorkspaceFiles, setPlanModeExitListener, setTaskListWriteListener } from './xratu_mcp_tools';
import { TASK_LIST_TOOL_NAME, parseTaskListArgs, type TaskListItem } from './taskList';
import { MCP_REGISTRY } from './mcpRegistry';
import { discoverSkills, ensureBundledSkill, listableSkills, resolveSkillForRun, skillId, SKILL_FILE, type DiscoveredSkill } from './skills';

/** External MCP manager + config store - module-level so deactivate() can
 *  shut the stdio children down and the provider can serve the MCP page. */
let externalMcpInstance: ExternalMcpManager | null = null;
let mcpConfigStoreInstance: McpConfigStore | null = null;

interface ApprovalDiff {
    file: string;
    added: number;
    removed: number;
    lines: string[];
}

interface ComposerAttachment {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    dataBase64: string;
    /** Workspace-relative path of a REFERENCE attachment (@-mention): the
     *  webview sends path-only, and this host reads the bytes at send time
     *  (_resolveReferenceAttachments) so content is always fresh. */
    path?: string;
}

interface AttachmentMeta {
    name: string;
    mime_type: string;
    size: number;
    path?: string;
}

/** Reasoning effort levels (backend accepts exactly these; null/absent = Default). */
 type ThinkingLevel = 'low' | 'medium' | 'high';



// ---------------------------------------------------------------------------
// Attachment validation (host-side re-check - the webview is a UX convenience
// only and the backend re-validates again; this is the middle layer of the
// Cline-style three-layer limit contract).
// ---------------------------------------------------------------------------

const ATTACH_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ATTACH_TEXT_EXTRA_TYPES = new Set([
    'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/toml', 'application/javascript', 'application/x-sh',
]);
const ATTACH_MAX_COUNT = 20;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const ATTACH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Mirrors the backend's ATTACHMENT_TEXT_MAX_CHARS. */
const ATTACH_TEXT_MAX_CHARS = 24_000;

// Cap for the approval diff's O(m·n) LCS table. 2000×2000 ≈ 4M cells; beyond
// that the synchronous DP allocation (several GB at 20k×20k lines) would
// freeze the extension host. Over-budget previews degrade to diff: null.
const MAX_DIFF_LCS_CELLS = 4_000_000;
/** Cap for the @-mention file list (same order as the project tree cap). */
const FILE_LIST_MAX_ENTRIES = 2000;

function isImageAttachment(mime: string): boolean {
    return ATTACH_IMAGE_TYPES.has(mime);
}

function isTextAttachment(mime: string): boolean {
    return mime.startsWith('text/') || ATTACH_TEXT_EXTRA_TYPES.has(mime);
}

/** PDFs are allowed IN and are text-extracted host-side (pdfExtract.ts)
 *  before anything reaches the backend - which keeps rejecting raw
 *  application/pdf as fail-closed bypass protection. */
function isPdfAttachment(mime: string): boolean {
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
function mimeFromFilename(name: string): string {
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
function validateHostAttachments(attachments: ComposerAttachment[] | undefined): { key: string; params?: Record<string, string> } | null {
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

let shikiHighlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null;

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Allowlist-based HTML sanitizer for webview content.
// Replaces the regex-based XSS filter (blocklists are inherently bypassable).
// Uses a tag/attribute allowlist - only known-safe constructs pass through.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'pre', 'code', 'blockquote',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'a', 'img', 'button', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'sup', 'sub', 'small', 'details', 'summary',
    'div', 'span', 'abbr', 'kbd', 'samp', 'var',
    'svg', 'path', 'rect', 'polyline', 'line', 'circle',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
    'a': new Set(['href', 'title', 'rel']),
    'button': new Set(['type', 'title', 'aria-label']),
    'img': new Set(['src', 'alt', 'title', 'width', 'height']),
    'td': new Set(['colspan', 'rowspan', 'align', 'valign']),
    'th': new Set(['colspan', 'rowspan', 'align', 'valign', 'scope']),
    'ol': new Set(['start', 'type', 'reversed']),
    'code': new Set(['class']),   // for shiki language classes
    'pre': new Set(['class', 'style']),   // shiki theme background
    'div': new Set(['class']),    // for shiki wrapper
    'span': new Set(['class', 'style']),  // shiki token colors
    'col': new Set(['span']),
    'abbr': new Set(['title']),
    'svg': new Set(['xmlns', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'class']),
    'path': new Set(['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    'rect': new Set(['width', 'height', 'x', 'y', 'rx', 'ry', 'fill', 'stroke']),
    'polyline': new Set(['points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']),
    'line': new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
    'circle': new Set(['cx', 'cy', 'r', 'fill', 'stroke']),
    '*': new Set(['class']),      // allow class on all tags
};

const FORBIDDEN_TAGS = new Set([
    'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
    'select', 'link', 'style', 'meta', 'base', 'math',
    'video', 'audio', 'source', 'canvas', 'template', 'head', 'body',
    'html', 'title', 'frame', 'frameset', 'applet', 'marquee',
]);

const EVENT_HANDLER_RE = /^on[a-z]/i;
const DATA_ATTR_RE = /^data-/i;
const JAVASCRIPT_URI_RE = /^\s*javascript\s*:/i;

/**
 * Inline styles are only safe for syntax highlighting: permit exactly the
 * two color properties shiki emits, with hex values, nothing else.
 */
function sanitizeStyle(value: string): string {
    const kept = value
        .split(';')
        .map((decl) => decl.trim())
        .filter((decl) => /^(color|background-color)\s*:\s*#[0-9a-fA-F]{3,8}$/.test(decl));
    return kept.join('; ');
}

function _sanitizeHtml(html: string): string {
    // Tokenize HTML into tags, text, and comments using a regex that captures
    // opening tags, closing tags, self-closing tags, and comments.
    const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>|([^<]+)/g;

    let result = '';
    let match: RegExpExecArray | null;

    while ((match = TOKEN_RE.exec(html)) !== null) {
        const [full, closeSlash, tagName, attrsRaw, selfClose, textContent] = match;

        // Text content or comment (no tag) - pass through text, strip comments
        // Check before tagName - text/comment matches have undefined tagName
        if (textContent !== undefined) {
            result += textContent;
            continue;
        }
        if (!tagName) { continue; }

        const tag = tagName.toLowerCase();

        // Strip HTML comments (potential attack vector)
        if (full.startsWith('<!--')) {
            continue;
        }

        // Check forbidden tags - strip entirely (including children in the regex)
        if (FORBIDDEN_TAGS.has(tag)) {
            continue;
        }

        // Unknown tags - strip but keep content
        if (!ALLOWED_TAGS.has(tag)) {
            continue;
        }

        // Parse attributes
        const allowedAttrs = new Set<string>([
            ...(ALLOWED_ATTRS[tag] || []),
            ...(ALLOWED_ATTRS['*'] || []),
        ]);

        let safeAttrs = '';
        const ATTR_RE = /([a-zA-Z_][\w\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
        let attrMatch: RegExpExecArray | null;

        while ((attrMatch = ATTR_RE.exec(attrsRaw)) !== null) {
            const [, attrName, dqVal, sqVal, uqVal] = attrMatch;
            const attrLower = attrName.toLowerCase();
            const attrVal = dqVal ?? sqVal ?? uqVal ?? '';

            // Block event handlers (onmouseover, onclick, etc.)
            if (EVENT_HANDLER_RE.test(attrLower)) continue;

            // Block data-* attributes
            if (DATA_ATTR_RE.test(attrLower)) continue;

            // Check allowlist
            if (!allowedAttrs.has(attrLower)) continue;

            // Validate href/src URIs - block javascript: and data: URIs
            if (attrLower === 'href' || attrLower === 'src') {
                if (JAVASCRIPT_URI_RE.test(attrVal)) continue;
                // Block data: URIs that could contain HTML/JS
                if (/^\s*data\s*:/i.test(attrVal)) continue;
                // Remote images are a tracking beacon vector in offline
                // coding chats - only relative/anchor links survive here,
                // and CSP blocks network loads at the frame level too.
                if (attrLower === 'src' && /^[a-z][a-z0-9+.-]*:\/\//i.test(attrVal)) continue;
            }

            // Style attributes get property-level filtering (shiki colors only)
            if (attrLower === 'style') {
                const cleanStyle = sanitizeStyle(attrVal);
                if (cleanStyle) {
                    safeAttrs += ` ${attrName}="${cleanStyle}"`;
                }
                continue;
            }

            // Reconstruct attribute with original quoting style
            if (dqVal !== undefined) {
                safeAttrs += ` ${attrName}="${escapeHtml(attrVal)}"`;
            } else if (sqVal !== undefined) {
                safeAttrs += ` ${attrName}='${escapeHtml(attrVal)}'`;
            } else if (uqVal !== undefined) {
                safeAttrs += ` ${attrName}="${escapeHtml(attrVal)}"`;
            } else {
                safeAttrs += ` ${attrName}`;
            }
        }

        if (closeSlash) {
            result += `</${tag}>`;
        } else if (selfClose) {
            result += `<${tag}${safeAttrs} />`;
        } else {
            result += `<${tag}${safeAttrs}>`;
        }
    }

    return result;
}

async function initShiki() {
    shikiHighlighter = await createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: ['python', 'typescript', 'javascript', 'html', 'css', 'json', 'bash', 'markdown', 'sql', 'yaml', 'xml', 'diff'],
    });
}

function looksLikeFilePath(value: string): boolean {
    const v = value.trim();
    if (!v || /\s/.test(v)) return false;
    return (
        /^(?:\.?\.?[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(v) ||
        /^(?:src|app|lib|tests?|components|extension|webview-ui)[\\/]/i.test(v) ||
        /\.(?:ts|tsx|js|jsx|py|rs|go|java|c|cc|cpp|h|hpp|json|md|css|scss|html|xml|yaml|yml|toml|sh|bash)(?::\d+(?::\d+)?)?$/i.test(v)
    );
}

function looksLikeSymbol(value: string): boolean {
    const v = value.trim();
    return /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:\(\))?$/.test(v);
}

function languageLabel(lang: string): string {
    const normalized = lang.trim().split(/\s+/)[0].toLowerCase();
    if (!normalized) return 'code';
    const aliases: Record<string, string> = {
        js: 'javascript',
        ts: 'typescript',
        py: 'python',
        sh: 'bash',
        shell: 'bash',
        yml: 'yaml',
        md: 'markdown',
        rs: 'rust',
        cs: 'c#',
    };
    return aliases[normalized] ?? normalized;
}

function highlightCode(str: string, lang: string, live: boolean): string {
    // Fallback MUST emit a <pre><code> shell like shiki does - renderFence
    // inserts the result straight into .code-surface, and bare text there
    // collapses newlines (no white-space: pre on the surface div).
    if (live || !lang || !shikiHighlighter) return `<pre><code>${escapeHtml(str)}</code></pre>`;
    try {
        const theme = vscode.window.activeColorTheme?.kind === vscode.ColorThemeKind.Light
            ? 'github-light' : 'github-dark';
        return shikiHighlighter.codeToHtml(str, { lang, theme });
    } catch {
        return `<pre><code>${escapeHtml(str)}</code></pre>`;
    }
}

function closeOpenFence(text: string): string {
    const lines = text.split('\n');
    let inFence = false;
    let fenceMarker = '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (!inFence) {
            if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
                inFence = true;
                fenceMarker = trimmed.slice(0, 3);
            }
        } else {
            if (trimmed.startsWith(fenceMarker)) {
                inFence = false;
            }
        }
    }
    if (inFence) return text + '\n' + fenceMarker;
    return text;
}

function renderFence(token: any, live: boolean): string {
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    const label = languageLabel(token.info);
    const highlighted = highlightCode(token.content, lang, live);
    return (
        `<div class="code-block">` +
            `<div class="code-header">` +
                `<span class="code-title">${escapeHtml(label)}</span>` +
                `<button type="button" class="code-copy" aria-label="${escapeHtml(ui('copyCode'))}" title="${escapeHtml(ui('copyCode'))}">${escapeHtml(ui('copyCode'))}</button>` +
            `</div>` +
            `<div class="code-surface">${highlighted}</div>` +
        `</div>`
    );
}

function configureMarkdownRenderer(renderer: MarkdownIt['renderer'], live: boolean): void {
    renderer.rules.fence = (tokens, idx) => renderFence(tokens[idx], live);

    // Indented code blocks emit a bare <pre><code> - route them through the
    // same shell so they get the padded surface instead of raw browser styles.
    renderer.rules.code_block = (tokens, idx) => renderFence(tokens[idx], live);

    renderer.rules.code_inline = (tokens, idx) => {
        const value = tokens[idx].content;
        const classes = [
            'xratu-inline-code',
            looksLikeFilePath(value) ? 'xratu-path' : '',
            !looksLikeFilePath(value) && looksLikeSymbol(value) ? 'xratu-symbol' : '',
        ].filter(Boolean).join(' ');
        return `<code class="${classes}">${escapeHtml(value)}</code>`;
    };
}

const md = new MarkdownIt({
    html: false,
    linkify: true,
    // Single newlines inside a paragraph become <br> - chat models routinely
    // break lines without blank lines, which would otherwise merge into one.
    breaks: true,
});

configureMarkdownRenderer(md.renderer, false);

// Streaming twin: identical DOM structure, but skips Shiki so the webview does
// not replace code-block structure when the final highlighted response arrives.
const mdLive = new MarkdownIt({ html: false, linkify: true, breaks: true });
configureMarkdownRenderer(mdLive.renderer, true);

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    while (text.length < 32) {
        const value = crypto.getRandomValues(new Uint32Array(1))[0];
        // Rejection sampling avoids the modulo bias of naive char picking.
        const idx = value % 64;
        if (idx < possible.length) {
            text += possible.charAt(idx);
        }
    }
    return text;
}

/** Collect AGENTS.md project rules: workspace root first, then every nested
 *  directory between it and the active file (closest wins - it is sent last).
 *  Everything travels inside the normal authenticated /chat request body, so
 *  no second network path exists. */
async function collectProjectRules(): Promise<string> {
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

interface HistoryMessage {
    role: string;
    content?: string;
    events?: any[];
    /** Shadow-checkpoint sha taken just BEFORE this prompt ran - the restore
     *  point when the user edits/resends or regenerates this turn. */
    cp?: string;
    /** Attachment metadata (no base64) for user turns - rendered in the
     *  bubble and replayed on edit/resend. */
    attachments?: AttachmentMeta[];
}

/** Prompt text for the local loop: text attachments ride as fenced blocks
 *  (no vision needed); caps mirror the backend's ATTACHMENT_TEXT_MAX_CHARS.
 *  Shared by the opening prompt AND steered messages. */
function buildLocalUserText(prompt: string, attachments?: ComposerAttachment[]): string {
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

/** Result of consuming one streamed agent run. */
interface StreamOutcome {
    /** Final 'result' event, when the run completed normally. */
    resultEvent: any | null;
    /** A pending approval was surfaced (stream ended with [DONE]). */
    needsApprovalId: string | null;
    /** Server reported an error event. */
    errorEvent: any | null;
    /** Every non-chunk event, mirroring what the server persists. */
    events: any[];
    /** The run was cancelled mid-stream - `events` holds the partial turn. */
    aborted?: boolean;
    /** A pre-run guard rejected the turn (no credential, insecure URL, no
     *  model): NOTHING ran, the guard already posted its error, and the
     *  prompt must NOT join the replayed context - no provider ever saw it. */
    noRun?: boolean;
}

/** Fallback context window for LOCAL runs when neither a probe nor a user
 *  override knows the model's real window. Conservative on purpose: local
 *  runtimes (Ollama/LM Studio) default to 4-8k, and claiming a LARGER window
 *  than reality overflows the prompt and makes small models degenerate. */
const LOCAL_DEFAULT_CONTEXT_WINDOW = 8192;

/** Display-event payload caps - mirrors the backend's `_trim_event_payloads`
 *  (chat.py) so the host carries the same bounds the server persists.
 *  Non-mutating: returns a clipped copy only when something was trimmed. */
const DISPLAY_ARG_LIMIT = 300;
/** Edit-family payloads: the patch IS the rendered diff body on reload -
 *  a 300-char clip leaves a mangled partial block in the pill. */
const DISPLAY_PATCH_KEYS = new Set(['patch', 'new_content']);
const DISPLAY_PATCH_ARG_LIMIT = 6000;
const DISPLAY_OUTPUT_LIMIT = 1500;

function _clipDisplay(value: string, limit: number): string {
    return value.length <= limit
        ? value
        : `${value.slice(0, limit)}… [+${value.length - limit} chars truncated]`;
}

/** Case-tolerant path equality for watcher-vs-store path comparisons
 *  (Windows returns watcher URIs with arbitrary drive-letter casing). */
function sameMcpPath(a: string, b: string): boolean {
    return process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
}

function trimDisplayEvent(event: any): any {    if (event?.type === 'tool_call' && event.tool !== TASK_LIST_TOOL_NAME) {
        if (event.args && typeof event.args === 'object') {
            return {
                ...event,
                args: Object.fromEntries(
                    Object.entries(event.args).map(([k, v]) =>
                        [k, typeof v === 'string'
                            ? _clipDisplay(v, DISPLAY_PATCH_KEYS.has(k) ? DISPLAY_PATCH_ARG_LIMIT : DISPLAY_ARG_LIMIT)
                            : v])
                ),
            };
        }
        if (typeof event.args === 'string') {
            return { ...event, args: _clipDisplay(event.args, DISPLAY_ARG_LIMIT) };
        }
    } else if (event?.type === 'tool_result' && typeof event.output === 'string' && event.output.length > DISPLAY_OUTPUT_LIMIT) {
        return { ...event, output: _clipDisplay(event.output, DISPLAY_OUTPUT_LIMIT) };
    }
    return event;
}

class XratuChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'xratu-chat-view';
    private _view?: vscode.WebviewView;
    private _sessionId: string | null = null;
    private _history: HistoryMessage[] = [];
    private _sessionSummary: string | null = null;
    /** Display title of the CURRENT session (toolbar button + picker).
     *  Mirrors the server rule: first user message, truncated; a rename
     *  always wins. Null = untitled/new session. */
    private _sessionTitle: string | null = null;
    private _lastFileContent: string = "";
    /** Turn-scoped checkpoint store (owned by activate, shared with the bridge). */
    private readonly _checkpoints: ShadowCheckpointStore;
    /**
     * Timeline rows that must be closed when an approval round resolves,
     * keyed by approval_id: approval-required calls, pre-denied calls, and
     * non-approval deferred calls ("auto") that execute server-side inside
     * /chat/approve and therefore never produce a streamed tool_result.
     */
    private _approvalCloseItems: Record<string, Array<{ tool_call_id: string; tool_name: string; kind?: string }>> = {};
    /** Session-scoped "allow for this session" kinds, chosen from the
     *  approval card's third action. A kind is a tool name, or for
     *  run_terminal_command the command's leading binary (`cmd:npm`) -
     *  approving one command trusts that KIND of command, not every
     *  mutating tool. Classification is deliberately narrow (pure helpers
     *  in sessionApproval.ts): shell-composed or unclassifiable commands
     *  always prompt again. Cleared with the session ledgers (new session
     *  / logout). */
    private _sessionApprovedKinds = new Set<string>();
    /** One controller per in-flight request kind: cancel can never hit the wrong stream. */
    private _abortControllers = new Map<'chat' | 'approve', AbortController>();
    /** Bumped whenever the visible session is wiped (new session, logout,
     *  account inactive). In-flight run handlers compare their captured
     *  value before writing history or posting follow-ups, so a cancelled
     *  zombie stream can never leak into a freshly cleared session. */
    private _sessionEpoch = 0;
    private _connectionStatusInterval: NodeJS.Timeout | null = null;
    private _chatRetryCount: number = 0;
    private _yoloMode: boolean = false;
    private _planMode: boolean = false;
    private _selectedModel: string | null = null;
    private _contextWindows: Record<string, number> = {};
    /** Pending local approvals - resolver keyed by approvalId. */
    private _localApprovalResolvers: Record<string, {
        resolve: (decisions: Record<string, boolean>) => void;
        reject: (err: unknown) => void;
    }> = {};
    /** Local-mode conversation history (OpenAI-format messages). */
    private _localHistory: Array<{ role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }> = [];
    /** Steered user messages waiting to join the LIVE local run. Entries
     *  carry the PROCESSED payload (refs resolved, PDFs extracted, text
     *  attachments fenced into `text`); `carryAttachments` holds image-only
     *  attachments for a potential follow-up turn. */
    private _localSteerQueue: Array<{
        text: string;
        images?: LocalImageAttachment[];
        meta?: AttachmentMeta[];
        carryAttachments?: ComposerAttachment[];
    }> = [];
    /** Identity of the current chat turn. `_handleSteer` captures it BEFORE
     *  its async attachment work and re-checks before queueing: a steer
     *  whose targeted run settled meanwhile (success, cancel or a noRun
     *  guard rejection) must not join the shared queue - the next run
     *  would drain and answer text the user aimed at a dead prompt. */
    private _localTurnToken = 0;
    /** True while a local agent loop is live - steers queue for its next
     *  round boundary instead of starting a new turn. */
    private _localRunActive = false;
    /** Settles when the owning local run fully unwinds (either cleanup
     *  finally in _handleChatRequest). _clearAllSessions awaits it so the
     *  fresh session is only exposed after the canceled run has stopped
     *  writing. Null when no run owns _localRunActive. */
    private _localRunSettled: Promise<void> | null = null;
    private _resolveRunSettled: (() => void) | null = null;

    /** Settle the owning run's deferred (idempotent; both cleanup finallys
     *  in _handleChatRequest call this). */
    private _settleLocalRun(): void {
        this._resolveRunSettled?.();
        this._resolveRunSettled = null;
        this._localRunSettled = null;
    }
    /** Accumulated local text for the current assistant turn - mirrors the cloud "result" event. */
    private _localAccumulatedText: string = '';
    private _localAccumulatedThinking: string = '';
    private _localCurrentUsage: LocalUsage | null = null;
    /** The in-flight local turn, held so a throttled snapshot can persist it
     *  BEFORE the run commits - a host crash mid-run used to lose the whole
     *  turn (local mode has no server copy). Cleared in _runLocalAgent's
     *  finally; the ledgers alone are authoritative after that. */
    private _localPendingTurn: { prompt: string; events: any[]; attachments?: AttachmentMeta[] } | null = null;
    private _localPartialTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _localSessionStore: LocalSessionStore;
    /** Seq for in-app notification banners (replaces vscode.window toasts). */
    private _notifSeq = 0;
    /** Config file the MCP page just wrote, with a hash of the exact bytes -
     *  the file watcher consumes ONE event whose current file content hashes
     *  equal (the save's own echo - the save path reloads itself); a manual
     *  edit of that same file hashes differently and reloads normally. */
    private _mcpPageWritePending: { path: string; hash: string } | null = null;
    private _mcpPageWriteTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pending confirm-banner resolvers keyed by notification id - the webview
     *  answers via notificationAction; a reload/dispose resolves with null. */
    private _pendingNotifies = new Map<string, (action: string | null) => void>();

    private _onDidChangeVirtualDoc = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChangeVirtualDoc.event;
    private _virtualDocuments = new Map<string, string>();
    private _webviewSubscriptions: vscode.Disposable[] = [];

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this._virtualDocuments.get(uri.toString()) || '';
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _secrets: vscode.SecretStorage,
        checkpoints: ShadowCheckpointStore,
        private readonly _globalState: vscode.Memento,
        localStorageUri: vscode.Uri
    ) {
        this._checkpoints = checkpoints;
        this._localSessionStore = new LocalSessionStore(localStorageUri.fsPath);
        setUiLocale(this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa');
        this._contextWindows = this._loadContextWindows();
        this._loadTaskListEdits();
        setTaskListWriteListener(() => this._noteTaskListWrite());
        // exit_plan_mode (agent-initiated): ends plan mode exactly like the
        // user's toolbar toggle - state flips so the NEXT request carries
        // plan_mode=false, and the webview echo keeps the toolbar honest.
        setPlanModeExitListener(() => {
            if (this._planMode) {
                this._planMode = false;
                this._view?.webview.postMessage({ type: 'planMode', enabled: false });
            }
        });
    }

    /** Last-served context-window table (provider metadata + backend tables),
     *  persisted so a mid-session extension reload does NOT silently drop the
     *  real window: without it _contextWindowHint() returns undefined, the
     *  request carries no llm_context_window, and the backend falls back to
     *  its 128k default - compacting a 1.3M-window conversation at ~80k. */
    private _loadContextWindows(): Record<string, number> {
        try {
            const raw = this._globalState.get<string>('xratu.contextWindows');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            return {};
        }
    }

    private async _saveContextWindows(): Promise<void> {
        await this._globalState.update('xratu.contextWindows', JSON.stringify(this._contextWindows));
    }

    // --- Session task list ("the list IS the plan") --------------------------
    // The current list derives from the newest update_task_list tool_call in
    // _history; user edits are a small per-session override that any NEW
    // model write invalidates (setTaskListWriteListener → _noteTaskListWrite).

    private _taskListEdits: Record<string, TaskListItem[]> = {};

    private _loadTaskListEdits(): void {
        try {
            const raw = this._globalState.get<string>('xratu.taskListEdits');
            const parsed = raw ? JSON.parse(raw) : {};
            this._taskListEdits = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            this._taskListEdits = {};
        }
    }

    private async _saveTaskListEdits(): Promise<void> {
        await this._globalState.update('xratu.taskListEdits', JSON.stringify(this._taskListEdits));
    }

    /** A model write invalidates the session's edit override. */
    private _noteTaskListWrite(): void {
        if (this._sessionId && this._taskListEdits[this._sessionId]) {
            delete this._taskListEdits[this._sessionId];
            void this._saveTaskListEdits().catch((e) =>
                console.error('xratu: task list edit persist failed:', e));
            this._pushTaskListState();
        }
    }

    /** Current merged list for the live session: user override wins, else the
     *  newest model write in history. Null when this session has no list. */
    private _currentTaskList(): TaskListItem[] | null {
        const override = this._sessionId ? this._taskListEdits[this._sessionId] : undefined;
        if (override && override.length) return override;
        for (let i = this._history.length - 1; i >= 0; i--) {
            const row = this._history[i];
            if (row.role !== 'assistant' || !Array.isArray(row.events)) continue;
            for (let j = row.events.length - 1; j >= 0; j--) {
                const ev = row.events[j];
                if (ev && ev.type === 'tool_call' && ev.tool === TASK_LIST_TOOL_NAME) {
                    const parsed = parseTaskListArgs(ev.args);
                    return parsed && parsed.length ? parsed : null;
                }
            }
        }
        return null;
    }

    /** Echo the session's task-list EDIT OVERRIDE (null = none). The webview
     *  shows the override over the newest update_task_list step's args and
     *  falls back to those args when there is no override - pushing the
     *  derived list here would race a mid-run write (history rows commit at
     *  end of run) and flash a stale checklist. */
    private _pushTaskListState(): void {
        const override = this._sessionId ? this._taskListEdits[this._sessionId] : undefined;
        this._view?.webview.postMessage({
            type: 'taskListState',
            tasks: override && override.length ? override : null,
        });
    }

    /** Native-toast fallback text - resolved from uiStrings (bilingual,
     *  locale follows the user's persisted choice). */
    private static _fallbackText(key: string, params?: Record<string, string>): string {
        return ui(key, params);
    }

    /** Show an in-app notification banner (info/warning/error). The message
     *  is an i18n KEY (+ optional interpolation params) resolved webview-side
     *  via tf(); falls back to a native VS Code toast when the webview can't
     *  render banners. */
    public notifyBanner(kind: 'info' | 'warning' | 'error', valueKey: string, params?: Record<string, string>): void {
        const showNative = () => {
            const text = XratuChatViewProvider._fallbackText(valueKey, params);
            const fn = kind === 'error' ? vscode.window.showErrorMessage
                : kind === 'warning' ? vscode.window.showWarningMessage
                    : vscode.window.showInformationMessage;
            void fn(text);
        };
        if (!this._view) {
            showNative();
            return;
        }
        this._view.webview.postMessage({
            type: 'notification',
            id: `n${++this._notifSeq}`,
            kind,
            valueKey,
            params
        }).then((ok) => {
            if (!ok) showNative();
        });
    }

    /** Confirm dialog rendered as an in-app banner with action buttons.
     *  `actions` are i18n keys; resolves with the picked ACTION KEY, or null
     *  on dismiss/cancel - callers compare keys, never localized labels. */
    public confirmBanner(messageKey: string, actions: string[], params?: Record<string, string>): Promise<string | null> {
        const native = () => {
            const labels = actions.map((a) => XratuChatViewProvider._fallbackText(a));
            const msg = XratuChatViewProvider._fallbackText(messageKey, params);
            return Promise.resolve(
                vscode.window.showWarningMessage(msg, ...labels).then((picked) =>
                    picked ? (actions[labels.indexOf(picked)] ?? null) : null
                )
            );
        };
        if (!this._view) return native();
        const id = `n${++this._notifSeq}`;
        return new Promise<string | null>((resolve) => {
            this._pendingNotifies.set(id, resolve);
            this._view!.webview.postMessage({ type: 'notification', id, kind: 'warning', valueKey: messageKey, params, actions })
                .then((ok) => {
                    if (!ok) {
                        this._pendingNotifies.delete(id);
                        native().then(resolve);
                    }
                });
        });
    }

    /** Webview answered (or was replaced/disposed) - settle the confirm. */
    private _resolveNotification(id: string, action: string | null): void {
        const resolve = this._pendingNotifies.get(id);
        if (resolve) {
            this._pendingNotifies.delete(id);
            resolve(action);
        }
    }

    /** Interactive rollback: pick a shadow checkpoint and restore files to it. */
    public async restoreCheckpointFlow(): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.notifyBanner('error', 'notifNoFolder');
            return;
        }
        const listing = await this._checkpoints.listCheckpoints(folder.uri.fsPath, 20);
        const entries = listing.split('\n').filter((l) => l.includes('|'));
        if (entries.length === 0 || listing === 'No checkpoints found.') {
            this.notifyBanner('info', 'notifNoCheckpoints');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            entries.map((line) => {
                const [sha, date, ...subject] = line.split('|');
                return { label: subject.join('|').trim() || 'checkpoint', description: `${date.trim()} (${sha.trim()})`, sha: sha.trim() };
            }),
            { placeHolder: ui('checkpointRestorePlaceholder') }
        );
        if (!picked) return;
        const confirm = await this.confirmBanner(
            'notifRestoreConfirm',
            ['notifRestoreAction', 'notifCancel'],
            { target: picked.description }
        );
        if (confirm !== 'notifRestoreAction') return;
        try {
            const result = await this._checkpoints.restoreCheckpoint(folder.uri.fsPath, picked.sha);
            // changed=false = workspace already matched the checkpoint -
            // nothing was restored, so stay silent.
            if (result.changed) {
                this.notifyBanner('info', 'notifRestored', { sha: result.sha, safety: result.safety });
            }
        } catch (e) {
            this.notifyBanner('error', 'notifRestoreFailed', {
                error: e instanceof Error ? e.message : String(e)
            });
        }
    }

    /** Read files via vscode.workspace.fs and hand them to the webview
     *  composer (explorer context menu + palette file dialog paths - the
     *  sidebar webview view cannot receive drag-and-drop, by VS Code design). */
    public async attachUrisPublic(uris: string[]): Promise<void> {
        await this.ensureView();
        await this._handleUriAttachments(uris);
    }

    /** Palette commands are useless before the panel exists - surface it. */
    public async ensureView(): Promise<void> {
        if (!this._view?.visible) {
            await vscode.commands.executeCommand(`${XratuChatViewProvider.viewType}.focus`);
            for (let i = 0; i < 20 && !this._view; i++) {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
    }

    /** The agent loop runs in the extension - there is nothing to poll.
     *  Post 'connected' so the webview never sits on its 'disconnected'
     *  default (cloud-era connection-loss indicators are gone). */
    private _startConnectionPolling() {
        this._view?.webview.postMessage({ type: 'connectionStatus', status: 'connected' });
    }

    private async _showStartScreen() {
        if (!this._view) return;
        // The only gate: a saved credential. Returning users (or anyone who
        // just connected from the welcome screen) go straight to chat;
        // otherwise the welcome screen offers provider setup (Phase 3:
        // BYOK/local entry with auto-discovery, no accounts).
        const credentials = await this._getSavedCredentials();
        if (credentials.length === 0) {
            this._view.webview.postMessage({ type: 'showWelcome' });
            return;
        }
        await this._restoreLocalSession();
        this._restoreChatUI();
        this._view.webview.postMessage({ type: 'showChat' });
        this._pushSessionState();
        void this._fetchModels();
    }

    /** Echo the active editor's file (workspace-relative) to the webview so
     *  suggestion-chip workflows can name the user's actual file. Null when
     *  no real file editor is active or it lives outside the workspace. */
    private _pushEditorContext(): void {
        if (!this._view) return;
        const editor = vscode.window.activeTextEditor;
        let activeFile: string | null = null;
        if (editor && editor.document.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
            activeFile = vscode.workspace.asRelativePath(editor.document.uri, false);
        }
        void this._view.webview.postMessage({ type: 'editorContext', activeFile });
    }

    /** Index of the userIndex-th user entry in _history, or -1. */
    private _findUserEntry(userIndex: number): number {
        let seen = -1;
        for (let i = 0; i < this._history.length; i++) {
            if (this._history[i].role === 'user') {
                seen++;
                if (seen === userIndex) return i;
            }
        }
        return -1;
    }

    /** Index of the userIndex-th user message in the local agent ledger, or -1. */
    private _findLocalUserEntry(userIndex: number): number {
        let seen = -1;
        for (let i = 0; i < this._localHistory.length; i++) {
            if (this._localHistory[i].role === 'user') {
                seen++;
                if (seen === userIndex) return i;
            }
        }
        return -1;
    }

    /** Shared rewind primitive behind message edit and response regenerate:
     *  restore the turn's workspace checkpoint, truncate server history at
     *  the Nth user message, mirror the truncation in the webview, then
     *  re-send (edited text, or the original for regenerate). */
    /** A rewind (edit-resend / regenerate) truncates history for the SAME
     *  session id - drop the task-list edit override unless an
     *  update_task_list write survives in the remaining ledger, or the next
     *  request would echo a phantom checklist the model never saw. */
    private _dropOrphanedTaskListEdit(): void {
        if (!this._sessionId || !this._taskListEdits[this._sessionId]) return;
        for (const row of this._history) {
            if (row.role !== 'assistant' || !Array.isArray(row.events)) continue;
            if (row.events.some((ev) => ev?.type === 'tool_call' && ev.tool === TASK_LIST_TOOL_NAME)) return;
        }
        delete this._taskListEdits[this._sessionId];
        void this._saveTaskListEdits().catch((e) =>
            console.error('xratu: task list edit persist failed:', e));
    }

    private async _rewindAndResend(userIndex: number, newText: string | null, attachments?: ComposerAttachment[]): Promise<void> {
        if (!this._view || this._abortControllers.size > 0) return;

        let targetIdx = this._findUserEntry(userIndex);
        const entry = targetIdx >= 0 ? this._history[targetIdx] : undefined;

        const text = (newText ?? entry?.content ?? '').trim();
        // Attachment-only edits are valid (the composer allows them) - the
        // warning fires only when there is nothing to resend at all.
        if (!text && !(attachments && attachments.length > 0)) {
            this.notifyBanner('warning', 'notifRewindNoText');
            return;
        }

        // 1. Workspace files back to this turn's pre-prompt state. Prefer
        // THIS turn's checkpoint; fall back to the newest one recorded before
        // it (restored-from-server sessions carry no per-turn shas). The
        // store safety-snapshots the CURRENT state either way.
        const folder = vscode.workspace.workspaceFolders?.[0];
        let baseSha = entry?.cp;
        if (folder && !baseSha && targetIdx > 0) {
            for (let i = targetIdx - 1; i >= 0; i--) {
                if (this._history[i].cp) { baseSha = this._history[i].cp; break; }
            }
        }
        if (folder && baseSha) {
            try {
                await this._checkpoints.restoreCheckpoint(folder.uri.fsPath, baseSha);
            } catch (e) {
                // Empty seed = the workspace was empty at this turn's start;
                // there is nothing meaningful to restore, so rewind the chat
                // history anyway instead of failing the edit. (Restoring TO
                // the seed would wipe files added since - skip it entirely.)
                if (e instanceof EmptySeedError) {
                    baseSha = undefined;
                } else {
                    this.notifyBanner('error', 'notifCpRestoreFailed', {
                        error: e instanceof Error ? e.message : String(e)
                    });
                    return;
                }
            }
        }
        // No checkpoint for this turn - only chat history rewinds; silent.

        // Rewind BOTH ledgers in place (no backend, no JWT).
        this._approvalCloseItems = {};
        if (targetIdx >= 0) {
            this._history = this._history.slice(0, targetIdx);
        }
        const localIdx = this._findLocalUserEntry(userIndex);
        if (localIdx >= 0) {
            this._localHistory = this._localHistory.slice(0, localIdx);
        }
        this._dropOrphanedTaskListEdit();
        this._view.webview.postMessage({ type: 'truncateFromUser', userIndex });
        this._view.webview.postMessage({ type: 'restoreUser', value: text });
        await this._persistLocalSession();

        // Re-send through the normal chat path. Skip its pre-send capture:
        // after a restore the tree matches baseSha, so a fresh commit would
        // record the SAFETY snapshot (post-edit state) as this turn's
        // baseline and corrupt future rewinds.
        await this._handleChatRequest(text, attachments?.length ? attachments : undefined, { baseSha: folder && baseSha ? baseSha : undefined });
    }

    /** Saved provider credentials live in VS Code SecretStorage. The webview only
     * receives metadata + a masked key; the real API key never leaves the extension host.
     * Runtime collapse: every credential is an OpenAI-compatible endpoint - the
     * old `runtimeMode` discriminator is accepted on read and dropped. */
    private async _getSavedCredentials(): Promise<Array<{
        id: string;
        providerId: string;
        baseUrl: string;
        apiKey: string;
        label: string;
    }>> {
        const raw = await this._secrets.get('xratu.llmCredentials');
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return parsed
                        .filter((c) =>
                            c && typeof c.id === 'string' &&
                            typeof c.baseUrl === 'string' &&
                            typeof c.apiKey === 'string'
                        )
                        .map((c) => ({
                            id: c.id,
                            providerId: typeof c.providerId === 'string' ? c.providerId : this._providerIdForUrl(c.baseUrl),
                            baseUrl: c.baseUrl.trim(),
                            apiKey: c.apiKey,
                            label: typeof c.label === 'string' ? c.label : this._providerLabelForUrl(c.baseUrl),
                        }));
                }
            } catch { /* fall through to legacy migration */ }
        }

        // Migrate the pre-multi-provider single credential into the new vault once.
        const [apiKey, baseUrl] = await Promise.all([
            this._secrets.get('xratu.llmApiKey'),
            this._secrets.get('xratu.llmBaseUrl'),
        ]);
        if (!apiKey || !baseUrl) return [];

        const migrated = [{
            id: crypto.randomUUID(),
            providerId: this._providerIdForUrl(baseUrl),
            baseUrl: baseUrl.trim(),
            apiKey,
            label: this._providerLabelForUrl(baseUrl),
        }];
        await this._secrets.store('xratu.llmCredentials', JSON.stringify(migrated));
        await this._secrets.store('xratu.activeLlmCredentialId', migrated[0].id);
        return migrated;
    }

    /** Heuristic "on-machine runtime" check - see endpointGuard.ts. */
    private _isLikelyLocalUrl(baseUrl: string): boolean {
        return isLikelyLocalUrl(baseUrl);
    }

    /** "on-machine runtime" heuristic - see _isLikelyLocalUrl. */
    private _providerIdForUrl(baseUrl: string): string {
        const v = baseUrl.toLowerCase();
        if (v.includes('openai.com')) return 'openai';
        if (v.includes('openrouter.ai')) return 'openrouter';
        if (v.includes('groq.com')) return 'groq';
        if (v.includes('deepseek.com')) return 'deepseek';
        if (v.includes('mistral.ai')) return 'mistral';
        if (v.includes('together.xyz')) return 'together';
        if (v.includes('fireworks.ai')) return 'fireworks';
        if (v.includes('cerebras.ai')) return 'cerebras';
        if (v.includes('anthropic.com')) return 'anthropic';
        if (v.includes('googleapis.com')) return 'google';
        if (v.includes('generativelanguage.googleapis.com')) return 'google';
        if (v.includes('x.ai')) return 'xai';
        if (v.includes('api.groq.com')) return 'groq';
        if (v.includes('localhost:11434')) return 'ollama';
        if (v.includes('localhost:1234')) return 'lmstudio';
        return 'custom';
    }

    private _providerLabelForUrl(baseUrl: string): string {
        const labels: Record<string, string> = {
            openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq',
            deepseek: 'DeepSeek', mistral: 'Mistral', together: 'Together',
            fireworks: 'Fireworks', cerebras: 'Cerebras', anthropic: 'Anthropic',
            google: 'Google', xai: 'xAI', ollama: 'Ollama', lmstudio: 'LM Studio',
            custom: 'Custom',
        };
        return labels[this._providerIdForUrl(baseUrl)] ?? 'Custom';
    }

    private _maskApiKey(apiKey: string): string {
        if (apiKey.length <= 8) return '••••••••';
        return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
    }

    private async _persistSavedCredentials(credentials: Array<{
        id: string;
        providerId: string;
        baseUrl: string;
        apiKey: string;
        label: string;
    }>): Promise<void> {
        await this._secrets.store('xratu.llmCredentials', JSON.stringify(credentials));
    }

    private async _getLlmCredentials(): Promise<{ llm_api_key?: string; llm_base_url?: string }> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) return {};
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        // '' is an EXPLICIT "no credential selected" (user deselected / fell
        // back to free) - only a missing id falls back to the first entry.
        if (activeId === '') return {};
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        if (active.id !== activeId) await this._globalState.update('xratu.activeLlmCredentialId', active.id);
        return { llm_api_key: active.apiKey, llm_base_url: active.baseUrl };
    }

    private async _sendSavedCredentials(): Promise<void> {
        if (!this._view) return;
        const credentials = await this._getSavedCredentials();
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId') ?? credentials[0]?.id ?? null;
        this._view.webview.postMessage({
            type: 'savedCredentials',
            credentials: credentials.map((c) => ({
                id: c.id,
                providerId: c.providerId,
                baseUrl: c.baseUrl,
                maskedKey: this._maskApiKey(c.apiKey),
                label: c.label,
                active: c.id === activeId,
            })),
        });
    }

    private async _setLlmCredentials(reason?: string, openCard?: 'byok' | 'local'): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId') ?? credentials[0]?.id ?? null;
        const active = credentials.find((c) => c.id === activeId);
        this._view?.webview.postMessage({
            type: 'openCredentials',
            reason,
            currentUrl: active?.baseUrl ?? '',
            activeCredentialId: activeId,
            openCard,
        });
        await this._sendSavedCredentials();
    }

    private async _saveLlmCredentials(base_url: string, api_key: string, returnToChat = false): Promise<void> {
        if (!base_url) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: 'credUrlRequired' });
            return;
        }
        // Local runtimes (Ollama, LM Studio, etc.) usually don't need an API key.
        const cleanUrl = base_url.trim().replace(/\/$/, '');
        const credentials = await this._getSavedCredentials();
        // A keyless connect to a URL that already has a saved credential
        // reuses the stored key: discovery probes saved custom endpoints
        // WITH their key, so the one-click connect must not fail key
        // validation or create a duplicate empty-key entry.
        if (!api_key) {
            const existingForUrl = credentials.find((c) => c.baseUrl.replace(/\/$/, '') === cleanUrl && c.apiKey);
            if (existingForUrl) api_key = existingForUrl.apiKey;
        }
        const isLocal = this._isLikelyLocalUrl(cleanUrl);
        if (!api_key && !isLocal) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: 'credUrlKeyRequired' });
            return;
        }
        const insecureError = insecureRemoteHttpError(cleanUrl, api_key);
        if (insecureError) {
            this._view?.webview.postMessage({ type: 'byokCredentialError', valueKey: insecureError });
            return;
        }
        const providerId = this._providerIdForUrl(cleanUrl);
        const label = this._providerLabelForUrl(cleanUrl);
        // Updating the same key replaces its existing entry; a different key
        // at the same provider remains a separate saved connection.
        const existing = credentials.find((c) =>
            c.baseUrl.replace(/\/$/, '') === cleanUrl && c.apiKey === api_key
        );
        const id = existing?.id ?? crypto.randomUUID();
        const next = credentials.filter((c) => c.id !== id);
        next.push({ id, providerId, baseUrl: cleanUrl, apiKey: api_key, label });

        await this._persistSavedCredentials(next);
        await this._globalState.update('xratu.activeLlmCredentialId', id);

        // Keep legacy slots synchronized for older Xratu code/data.
        await this._secrets.store('xratu.llmBaseUrl', cleanUrl);
        await this._secrets.store('xratu.llmApiKey', api_key);

        await this._fetchModels();
        await this._sendSavedCredentials();

        this._view?.webview.postMessage({
            type: 'credentialsSaved',
            returnToChat,
        });
    }

    private async _selectLlmCredential(id: string): Promise<void> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.some((c) => c.id === id)) return;
        const currentId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (currentId === id) {
            // Toggle OFF: clicking the active credential deselects it - the
            // user's explicit "no credential" gesture. Model listing drops
            // to the empty setup state until a provider is re-selected.
            await this._globalState.update('xratu.activeLlmCredentialId', '');
            this._selectedModel = null;
            await this._fetchModels();
            await this._sendSavedCredentials();
            this._view?.webview.postMessage({ type: 'credentialsSaved' });
            return;
        }
        await this._globalState.update('xratu.activeLlmCredentialId', id);
        await this._fetchModels();
        await this._sendSavedCredentials();
        this._view?.webview.postMessage({ type: 'credentialsSaved' });
    }

    /** Replace the stored API key of a saved connection. Only the webview's
     *  NEW key travels here - the old key never leaves the host. */
    private async _updateLlmCredential(id: string, api_key: string): Promise<void> {
        const key = api_key.trim();
        if (!key) return;
        const credentials = await this._getSavedCredentials();
        const target = credentials.find((c) => c.id === id);
        if (!target) return;
        target.apiKey = key;
        await this._persistSavedCredentials(credentials);
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === id) {
            // The active connection's legacy slot mirrors its key.
            await this._secrets.store('xratu.llmApiKey', key);
            await this._fetchModels();
        }
        await this._sendSavedCredentials();
        this._view?.webview.postMessage({ type: 'credentialsSaved' });
    }

    private async _deleteLlmCredential(id: string): Promise<void> {
        const credentials = await this._getSavedCredentials();
        const next = credentials.filter((c) => c.id !== id);
        if (next.length === credentials.length) return;

        // A deleted connection takes its remembered model with it - otherwise
        // a stale selection lingers in the picker (re-surfaced by the legacy
        // fallback in _fetchModels) with no provider behind it.
        await this._forgetCredentialModel(id);
        await this._persistSavedCredentials(next);
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === id) {
            const nextActive = next[0]?.id ?? null;
            if (nextActive) await this._globalState.update('xratu.activeLlmCredentialId', nextActive);
            else await this._globalState.update('xratu.activeLlmCredentialId', '');
        }
        if (!next.length) {
            await this._secrets.delete('xratu.llmApiKey');
            await this._secrets.delete('xratu.llmBaseUrl');
            // Last credential gone: clear the legacy model secret and the
            // in-memory selection too, or the picker keeps showing a model
            // that belongs to a connection that no longer exists.
            await this._secrets.delete('xratu.selectedModel');
            this._selectedModel = null;
        } else {
            const active = next.find((c) => c.id === this._globalState.get<string>('xratu.activeLlmCredentialId')) ?? next[0];
            await this._secrets.store('xratu.llmApiKey', active.apiKey);
            await this._secrets.store('xratu.llmBaseUrl', active.baseUrl);
            await this._globalState.update('xratu.activeLlmCredentialId', active.id);
        }
        await this._fetchModels();
        await this._sendSavedCredentials();
    }

    // --- Per-credential model memory -------------------------------------
    // Switching back to a saved connection restores the last model selected
    // under it. Keyed by credential id (not provider id: two saved keys at
    // the same provider are separate connections with separate model lists).

    private _credentialModelMap(): Record<string, string> {
        try {
            const raw = this._globalState.get<string>('xratu.modelsByCredential');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            return {};
        }
    }

    private async _resolveActiveCredentialId(): Promise<string | null> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) return null;
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        if (activeId === '') return null;
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        return active.id;
    }

    private async _rememberModelForActiveCredential(model: string | null): Promise<void> {
        if (!model) return;
        const credId = await this._resolveActiveCredentialId();
        if (!credId) return;
        const map = this._credentialModelMap();
        if (map[credId] === model) return;
        map[credId] = model;
        await this._globalState.update('xratu.modelsByCredential', JSON.stringify(map));
    }

    /** Drop a deleted credential's remembered model so it can't resurface. */
    private async _forgetCredentialModel(credId: string): Promise<void> {
        const map = this._credentialModelMap();
        if (!(credId in map)) return;
        delete map[credId];
        await this._globalState.update('xratu.modelsByCredential', JSON.stringify(map));
    }

    private async _modelForActiveCredential(): Promise<string | null> {
        const credId = await this._resolveActiveCredentialId();
        if (!credId) return null;
        return this._credentialModelMap()[credId] ?? null;
    }

    // --- Cloud runtime selection (free vs BYOK) ---------------------------
    // Free = the hosted runtime: the backend injects its own upstream
    // credentials and the client sends NONE. BYOK = the user's own key.
    // The choice persists in globalState, never in the secret store.

    /** Per-runtime model memory: the free runtime remembers its own selection
     *  (a single opaque id) separately from every BYOK credential's map. */
    private async _freeSelectedModel(): Promise<string | null> {
        return this._globalState.get<string>('xratu.freeSelectedModel') ?? null;
    }

    private async _rememberFreeModel(model: string): Promise<void> {
        await this._globalState.update('xratu.freeSelectedModel', model);
    }

    // --- Context-window knowledge (BYOK) --------------------------------
    // Layered like the backend's resolver: the user's explicit per-model
    // override wins, then provider-reported/snapshot entries from the served
    // table. The winning value is echoed per request so the stateless relay
    // budgets with exactly what the pill shows.

    private _contextWindowOverrides(): Record<string, number> {
        try {
            const raw = this._globalState.get<string>('xratu.contextWindowOverrides');
            const parsed = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                ? parsed : {};
        } catch {
            return {};
        }
    }

    private async _setContextWindowOverride(model: string, window: number | null): Promise<void> {
        if (!model) return;
        const map = this._contextWindowOverrides();
        if (typeof window === 'number' && window >= 1024 && Number.isFinite(window)) {
            map[model] = Math.floor(window);
        } else {
            delete map[model];
        }
        await this._globalState.update('xratu.contextWindowOverrides', JSON.stringify(map));
    }

    /** Best-known window for the selected model: explicit override, else the
     *  longest matching entry of the served table (mirrors resolveWindow in
     *  the webview). Undefined when nothing is known - the backend then uses
     *  its own chain. */
    private _contextWindowHint(): number | undefined {
        const model = this._selectedModel;
        if (!model) return undefined;
        const override = this._contextWindowOverrides()[model];
        if (typeof override === 'number' && override >= 1024) return override;
        const lowered = model.toLowerCase();
        let best: { len: number; win: number } | null = null;
        for (const [needle, win] of Object.entries(this._contextWindows)) {
            if (lowered.includes(needle.toLowerCase()) && (!best || needle.length > best.len)) {
                best = { len: needle.length, win };
            }
        }
        return best ? best.win : undefined;
    }

    // --- Thinking-level (reasoning effort) selection ----------------------
    // Per-model, client-held like the context-window overrides: the stateless
    // relay receives the level echoed per request.  Null/absent = Default -
    // the backend's Thinking() capability default applies unchanged.

    private _thinkingLevels(): Record<string, ThinkingLevel> {
        try {
            const raw = this._globalState.get<string>('xratu.thinkingLevels');
            const parsed = raw ? JSON.parse(raw) : {};
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
            const clean: Record<string, ThinkingLevel> = {};
            for (const [model, level] of Object.entries(parsed)) {
                if (level === 'low' || level === 'medium' || level === 'high') clean[model] = level;
            }
            return clean;
        } catch {
            return {};
        }
    }

    /** Level selected for the model about to run; undefined = Default. */
    private _thinkingLevelHint(model: string | null | undefined): ThinkingLevel | undefined {
        if (!model) return undefined;
        return this._thinkingLevels()[model];
    }

    private async _setThinkingLevel(model: string, level: ThinkingLevel | null): Promise<void> {
        if (!model) return;
        const map = this._thinkingLevels();
        if (level === 'low' || level === 'medium' || level === 'high') {
            map[model] = level;
        } else {
            delete map[model];
        }
        await this._globalState.update('xratu.thinkingLevels', JSON.stringify(map));
    }

    // ---------------------------------------------------------------------------
    // Local runtime detection
    // ---------------------------------------------------------------------------

    /** Whether the active credential runs through the in-extension agent
     *  loop. Phase 1 runtime collapse: there is exactly ONE runtime - the
     *  local OpenAI-compatible loop - and every credential (remote BYOK or
     *  on-machine) runs through it, so this is trivially true. Kept as a
     *  function so the deletion pass can sweep its call sites mechanically. */
    private async _isLocalRuntime(): Promise<boolean> {
        return true;
    }

    /** Build the system prompt for local mode. The persona base is the
     *  canonical prompt bundled in systemPrompt.ts - local runs never touch
     *  a backend, so the prompt travels with the extension. Only the
     *  local-operational notes and static context are appended here. */
    private _buildLocalSystemPrompt(fileContent: string, rulesContext: string, sessionSummary: string | null, planMode: boolean): string {
        const parts: string[] = [
            BACKEND_SYSTEM_PROMPT,
            "",
            "Operational notes for local mode:",
            "- Attached images are part of the current request only.",
            "- Use local tools (read_file, edit_file, grep_search, etc.) for workspace inspection and changes.",
            "- web_search and fetch_url access the web directly from this machine; if web_search reports no provider configured, rely on fetch_url or answer from your own knowledge.",
        ];
        if (planMode) {
            // Mirrors the backend's per-turn plan hint (chat.py plan_hint):
            // local plan mode has no server, so the guidance rides here.
            parts.push(
                "",
                "PLAN MODE (READ-ONLY): mutating tools are unavailable. Draft the implementation plan " +
                "as a task list with update_task_list (one item per verifiable step, every label ONE SHORT " +
                "single sentence ~10 words max, all items pending), then call exit_plan_mode ONCE to end " +
                "plan mode - execution becomes possible in the next turn.",
            );
        }
        if (rulesContext) {
            parts.push("", "Project Rules (from AGENTS.md):", rulesContext);
        }
        if (fileContent) {
            parts.push("", "Project structure:", fileContent);
        }
        if (sessionSummary) {
            parts.push("", "Conversation summary:", sessionSummary);
        }
        return parts.join('\n');
    }

    /** Convert extension history to local agent message format (no image base64).
     *  Normalizes the message shape for strict OpenAI-compatible servers (LM
     *  Studio et al.): assistant content must be a STRING (never undefined -
     *  a dropped key is rejected with "Invalid 'content': content field must
     *  be a string or an array of objects") and tool_calls must carry
     *  `function.arguments`. The normalizer also repairs turns persisted by
     *  older builds that stored the `argumentsJson` key or dropped content. */
    private _buildLocalHistory(): Array<import('./local/localAgent').LocalAgentMessage> {
        return this._localHistory.map((msg) => ({
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content: msg.content ?? '',
            tool_calls: msg.tool_calls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.function?.name,
                    arguments: typeof tc.function?.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function?.arguments ?? tc.function?.argumentsJson ?? {}),
                },
            })),
            tool_call_id: msg.tool_call_id,
        }));
    }

    // ---------------------------------------------------------------------------
    // Local approval coordinator
    // ---------------------------------------------------------------------------

    /** Request approval from the user for local tool calls. Returns decisions.
     *  The pending promise is tracked so a cancel can reject it - otherwise
     *  the suspended local agent generator would hang forever.
     *  Calls whose kind was allowed for this session resolve silently; only
     *  the remainder reach the approval card. */
    private _requestLocalApproval(approvalId: string, approvals: Array<{ tool_call_id: string; tool_name: string; args: Record<string, unknown> }>): Promise<Record<string, boolean>> {
        const preDecided: Record<string, boolean> = {};
        const pending = approvals.filter((a) => {
            if (isSessionApproved(a.tool_name, a.args, this._sessionApprovedKinds)) {
                preDecided[a.tool_call_id] = true;
                return false;
            }
            return true;
        });
        if (pending.length === 0) return Promise.resolve(preDecided);
        return new Promise((resolve, reject) => {
            this._localApprovalResolvers[approvalId] = {
                resolve: (decisions) => resolve({ ...preDecided, ...decisions }),
                reject,
            };
            void this._processNeedsApproval({
                approval_id: approvalId,
                approvals: pending.map((a) => ({
                    tool_call_id: a.tool_call_id,
                    tool_name: a.tool_name,
                    args: a.args,
                })),
                auto: [],
            });
        });
    }

    /** Resolve a local approval from the UI decision. */
    private _resolveLocalApproval(approvalId: string, decisions: Record<string, boolean>): void {
        const resolver = this._localApprovalResolvers[approvalId];
        if (resolver) {
            delete this._localApprovalResolvers[approvalId];
            resolver.resolve(decisions);
        }
    }

    /** Reject every pending local approval. Used on cancel/logout: the local
     *  agent generator is suspended awaiting the decision and must resume
     *  (with an AbortError) instead of waiting on a user who has moved on. */
    private _rejectPendingLocalApprovals(): void {
        for (const [approvalId, resolver] of Object.entries(this._localApprovalResolvers)) {
            delete this._localApprovalResolvers[approvalId];
            const err = new Error('Request cancelled while waiting for approval');
            err.name = 'AbortError';
            resolver.reject(err);
            this._view?.webview.postMessage({ type: 'approvalResolved', approval_id: approvalId, resolution: 'rejected' });
        }
    }

    /** Public: whether the active credential is a local runtime. */
    public async isLocalMode(): Promise<boolean> {
        return this._isLocalRuntime();
    }

    /** Public: discover reachable local runtimes. */
    public async discoverLocalModels(signal?: AbortSignal): Promise<DiscoveredLocalModel[]> {
        const discovered = await discoverLocalRuntimes(signal);
        // Also probe saved custom credentials - after the runtime collapse
        // every credential is an OpenAI-compatible endpoint worth probing.
        // Stored URLs are not revalidated at load, so the cleartext-key guard
        // applies here too: skip credentials that would leak their key over
        // remote HTTP (the credentials page blocks saving new ones).
        const credentials = await this._getSavedCredentials();
        for (const cred of credentials) {
            if (cred.providerId === 'custom') {
                if (insecureRemoteHttpError(cred.baseUrl, cred.apiKey)) continue;
                const probed = await probeCustomEndpoint(cred.baseUrl, signal, cred.apiKey);
                if (probed) {
                    discovered.push(probed);
                }
            }
        }
        return discovered;
    }

    /** Public: check if the selected model likely supports vision. */
    public isLocalModelVisionCapable(): boolean {
        if (!this._selectedModel) return false;
        return modelIsLikelyVision(this._selectedModel);
    }

    /** Public: check if the selected model likely supports function calling. */
    public isLocalModelToolCapable(): boolean {
        if (!this._selectedModel) return true;
        return modelLikelySupportsTools(this._selectedModel);
    }

    // ---------------------------------------------------------------------------
    // Local agent runner
    // ---------------------------------------------------------------------------

    /** Webview steered a live local run: process the payload through the
     *  SAME attachment pipeline as a normal send (ref resolution,
     *  validation, PDF extraction) and queue it for the loop's next round
     *  boundary. With no live run (race: the turn settled first) it
     *  degrades to an ordinary send. */
    private async _handleSteer(value: string, attachments?: ComposerAttachment[]): Promise<void> {
        const text = value.trim();
        if (!text && !(attachments && attachments.length > 0)) return;
        if (!this._localRunActive) {
            void this._handleChatRequest(text, attachments);
            return;
        }
        // Identity of the run this steer is AIMED at - captured before any
        // await. Attachment processing (reference resolution, PDF text
        // extraction) can take seconds; if the targeted run settles in that
        // window, queueing would land the steer in the SHARED queue where an
        // unrelated next run drains it. Re-check on append instead. A session
        // switch (epoch bump - clearHistory/openSession) invalidates the
        // steer outright: its webview bubbles no longer exist to match.
        const turnToken = this._localTurnToken;
        const sessionEpochAtEntry = this._sessionEpoch;
        const refError = await this._resolveReferenceAttachments(attachments);
        if (refError) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: refError.key, params: refError.params });
            return;
        }
        const attachValidationError = validateHostAttachments(attachments);
        if (attachValidationError) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: attachValidationError.key, params: attachValidationError.params });
            return;
        }
        const pdfExtraction = await extractPdfAttachments(attachments ?? []);
        if (pdfExtraction.error) {
            this._view?.webview.postMessage({ type: 'composerError', value: '', valueKey: pdfExtraction.error.key, params: pdfExtraction.error.params });
            return;
        }
        const sendAttachments = pdfExtraction.attachments;
        if (this._sessionEpoch !== sessionEpochAtEntry) {
            // The session this steer belonged to was cleared/switched while
            // attachments were processed - drop it silently; its bubbles are
            // gone and queueing would corrupt the fresh session.
            return;
        }
        if (!this._localRunActive || this._localTurnToken !== turnToken) {
            // The targeted run settled while attachments were processed -
            // the webview already rendered the steer bubble, so run the
            // message as an ordinary turn (its own user row keeps the
            // ledgers aligned with that bubble).
            void this._handleChatRequest(text, sendAttachments);
            return;
        }
        const images = sendAttachments
            ?.filter((a) => isImageAttachment(a.mimeType))
            .map((a) => ({ name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64 }));
        this._localSteerQueue.push({
            text: buildLocalUserText(text, sendAttachments),
            ...(images?.length ? { images } : {}),
            ...(sendAttachments?.length ? {
                meta: sendAttachments.map((a) => ({ name: a.name, mime_type: a.mimeType, size: a.size })),
                // Follow-up-turn carry: images only - text attachments are
                // already fenced into `text` and must not be duplicated.
                carryAttachments: sendAttachments
                    .filter((a) => isImageAttachment(a.mimeType))
                    .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, dataBase64: a.dataBase64 })),
            } : {}),
        });
    }

    private async _runLocalAgent(
        prompt: string,
        fileContent: string,
        rulesContext: string,
        attachments?: ComposerAttachment[],
        existingController?: AbortController,
        planMode?: boolean,
    ): Promise<StreamOutcome> {
        const credentials = await this._getSavedCredentials();
        if (!credentials.length) {
            this._view?.webview.postMessage({ type: 'error', valueKey: 'localCredMissing' });
            return { resultEvent: null, needsApprovalId: null, errorEvent: null, events: [], noRun: true };
        }
        const activeId = this._globalState.get<string>('xratu.activeLlmCredentialId');
        const active = credentials.find((c) => c.id === activeId) ?? credentials[0];
        const insecureError = insecureRemoteHttpError(active.baseUrl, active.apiKey);
        if (insecureError) {
            this._view?.webview.postMessage({ type: 'error', valueKey: insecureError });
            return { resultEvent: null, needsApprovalId: null, errorEvent: null, events: [], noRun: true };
        }
        const model = this._selectedModel;
        if (!model) {
            this._view?.webview.postMessage({ type: 'error', valueKey: 'noModelSelected' });
            return { resultEvent: null, needsApprovalId: null, errorEvent: null, events: [], noRun: true };
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';

        // Reuse the controller registered by _handleChatRequest when the
        // caller already owns one (local branch) so cancel covers the full
        // isTyping window; standalone invocations create their own.
        const controller = existingController ?? new AbortController();
        this._abortControllers.set('chat', controller);
        // Matches the caller's epoch (captured right before this call) -
        // post-cancel messages must not leak into a new session view.
        const epoch = this._sessionEpoch;

        const outcome: StreamOutcome = {
            resultEvent: null,
            needsApprovalId: null,
            errorEvent: null,
            events: [],
        };

        this._localAccumulatedText = '';
        this._localAccumulatedThinking = '';
        this._localCurrentUsage = null;
        // `events` is held by reference and grows as the run streams - the
        // throttled snapshot below always captures the current tail.
        this._localPendingTurn = {
            prompt,
            events: outcome.events,
            ...(attachments?.length ? {
                attachments: attachments.map((a) => ({
                    name: a.name,
                    mime_type: a.mimeType,
                    size: Math.ceil(a.dataBase64.length * 3 / 4),
                })),
            } : {}),
        };

        // External MCP tools ride the local loop too: aggregated before the
        // run starts (listTools is async) and routed through the same manager.
        const externalTools = externalMcpInstance
            ? await externalMcpInstance.listTools().catch(() => [])
            : [];
        const executor = createLocalToolExecutor(
            workspaceRoot,
            (wsRoot, reason) => this._checkpoints.ensureTurnSnapshot(wsRoot, reason),
            externalMcpInstance ?? undefined,
            // Dispatch-time gate + body source in ONE resolver: the skill
            // call resolves the winning copy (per-source identity, shadowed
            // copies excluded), checks the live disabled list, and reuses the
            // resolved dirPath for the load - no second discovery per call.
            (skillName) => resolveSkillForRun(
                workspaceRoot || undefined,
                skillName,
                new Set(this._disabledSkillIds()),
            ),
        );

        // Text attachments ride the prompt as fenced blocks (no vision
        // needed) - PDFs arrive here ALREADY text-extracted by the caller;
        // only images go through as image_url parts.
        const localUserText = buildLocalUserText(prompt, attachments);
        const localAttachments = attachments
            ?.filter((a) => isImageAttachment(a.mimeType))
            .map((a) => ({
                name: a.name,
                mimeType: a.mimeType,
                dataBase64: a.dataBase64,
            }));

        // The turn's plan mode was captured by the caller BEFORE any await -
        // a mid-preflight toggle must not expose mutating tools in an
        // already-started plan turn.
        const runPlanMode = planMode ?? this._planMode;
        const systemPrompt = this._buildLocalSystemPrompt(fileContent, rulesContext, this._sessionSummary, runPlanMode);

        try {
            const agent = runLocalAgent(
                {
                    baseUrl: active.baseUrl,
                    apiKey: active.apiKey || null,
                    model,
                    systemPrompt,
                    userText: localUserText,
                    attachments: localAttachments,
                    history: this._buildLocalHistory(),
                    tools: getLocalToolDefinitions({
                        yolo: this._yoloMode,
                        plan: runPlanMode,
                        external: externalTools,
                        // Agent Skills are rescanned per run (tool schemas
                        // snapshot at session start); disabled ones are
                        // filtered out host-side.
                        skills: this._discoverSkillsForRun(workspaceRoot),
                    }),
                    ...(this._currentTaskList()?.length ? { taskList: this._currentTaskList()! } : {}),
                    signal: controller.signal,
                    maxRounds: 12,
                    // Window for compaction/budget math. Prefer the probed or
                    // override value; the fallback is deliberately CONSERVATIVE
                    // (not 32k): claiming a window larger than the runtime
                    // actually has overflows it and makes small local models
                    // degenerate (repetition loops). Over-estimating small
                    // only costs extra history compaction, which is functional.
                    contextWindow: this._contextWindowHint() ?? LOCAL_DEFAULT_CONTEXT_WINDOW,
                    reasoningEffort: this._thinkingLevelHint(model),
                },
                executor,
                {
                    requestApproval: (id, calls) => {
                        // YOLO is consulted LIVE per call, so toggling it
                        // mid-response takes effect from the next tool call
                        // without restarting the run. Plan mode keeps its
                        // read-only enforcement (mutating tools were already
                        // dropped from the toolset at loop start).
                        if (this._yoloMode && !runPlanMode) {
                            return Promise.resolve(
                                Object.fromEntries(calls.map((c) => [c.id, true]))
                            );
                        }
                        return this._requestLocalApproval(
                            id,
                            calls.map((c) => ({ tool_call_id: c.id, tool_name: c.name, args: c.arguments }))
                        );
                    },
                },
                {
                    // Mid-run steering: the loop drains this at every round
                    // boundary (after tool results, before the next model
                    // request), so steered messages join the conversation
                    // without restarting the turn.
                    drain: () => this._localSteerQueue.splice(0).map((e) => ({
                        text: e.text,
                        ...(e.images?.length ? { attachments: e.images } : {}),
                    })),
                },
            );

            for await (const event of agent) {
                this._handleLocalAgentEvent(event, outcome);
            }
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                outcome.aborted = true;
                if (epoch === this._sessionEpoch) {
                    this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                }
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                this._view?.webview.postMessage({ type: 'error', value: msg });
                outcome.errorEvent = { error: msg };
            }
        } finally {
            this._abortControllers.delete('chat');
            // The run is over - committed, aborted or errored. Clear BEFORE
            // the caller's commit persist so the snapshot never carries a
            // pendingTurn for a turn that is already in the ledgers, and stop
            // the throttled flush.
            this._localPendingTurn = null;
            if (this._localPartialTimer) {
                clearTimeout(this._localPartialTimer);
                this._localPartialTimer = null;
            }
        }

        return outcome;
    }

    /** Translate a local agent event into webview messages + outcome tracking. */
    private _handleLocalAgentEvent(event: LocalAgentEvent, outcome: StreamOutcome): void {
        switch (event.type) {
            case 'chunk':
                this._localAccumulatedText += event.value;
                // Batched onto the shared live tick - see _noteStreamChunk.
                this._noteStreamChunk(event.value);
                this._scheduleLocalPartialPersist();
                break;
            case 'thinking':
                this._localAccumulatedThinking = event.value;
                this._flushLiveSegment();
                this._noteThinking(event.value);
                this._scheduleLocalPartialPersist();
                break;
            case 'toolCall':
                this._flushLiveSegment();
                outcome.events.push({ type: 'tool_call', id: event.id, tool: event.tool, args: event.args });
                this._scheduleLocalPartialPersist();
                if (event.tool === TASK_LIST_TOOL_NAME) {
                    this._noteTaskListWrite();
                }
                this._view?.webview.postMessage({
                    type: 'toolCall',
                    tool: event.tool,
                    args: JSON.stringify(event.args, null, 2),
                    callId: event.id,
                });
                break;
            case 'toolResult':
                this._flushLiveSegment();
                outcome.events.push({ type: 'tool_result', id: event.id, tool: event.tool, output: event.output });
                this._scheduleLocalPartialPersist();
                this._view?.webview.postMessage({
                    type: 'toolResult',
                    tool: event.tool,
                    output: event.output,
                    callId: event.id,
                });
                break;
            case 'steer':
                // Ledger-only: the webview rendered the steer bubble
                // optimistically when it sent the steer. Events order it
                // exactly where the model will see it.
                outcome.events.push({
                    type: 'steer_user',
                    text: event.text,
                    ...(event.attachments?.length ? {
                        attachments: event.attachments.map((a) => ({
                            name: a.name,
                            mime_type: a.mimeType,
                            size: Math.ceil(a.dataBase64.length * 3 / 4),
                        })),
                    } : {}),
                });
                break;
            case 'assistantMessage':
                outcome.events.push({
                    type: 'assistant_message',
                    content: event.text,
                    tool_calls: event.toolCalls.map((call) => ({
                        id: call.id,
                        type: 'function',
                        // OpenAI wire shape: `arguments` (string). Storing any
                        // other key here corrupts the REPLAYED history - strict
                        // local servers (LM Studio) 400 with "Invalid 'content'"
                        // / missing-arguments errors on the NEXT request.
                        function: { name: call.name, arguments: call.argumentsJson },
                    })),
                });
                this._scheduleLocalPartialPersist();
                break;
            case 'usage':
                // Mid-stream ESTIMATES only feed the webview's live context
                // meter; the turn's recorded usage stays on the real
                // round-end event (server-reported), which overwrites it.
                if (!event.estimated) this._localCurrentUsage = event.usage;
                // Mirror cloud behavior: the webview's context meter tracks
                // each round's cumulative usage while the turn streams.
                this._view?.webview.postMessage({
                    type: 'usage',
                    usage: event.usage ? {
                        input_tokens: event.usage.promptTokens,
                        output_tokens: event.usage.completionTokens,
                    } : null,
                });
                break;
            case 'compactionSummary':
                // Local compaction summarized the dropped turns with the
                // user's model - keep it rolling: the next local request's
                // system prompt and the session snapshot carry it forward.
                this._sessionSummary = event.value;
                break;
            case 'needsApproval':
                outcome.needsApprovalId = event.approvalId;
                break;
            case 'status':
                if (event.value === 'done') {
                    outcome.resultEvent = {
                        persian_explanation: this._localAccumulatedText,
                        thinking: this._localAccumulatedThinking,
                        usage: this._localCurrentUsage ? {
                            input_tokens: this._localCurrentUsage.promptTokens,
                            output_tokens: this._localCurrentUsage.completionTokens,
                        } : null,
                        context_window: this._contextWindowHint() ?? null,
                    };
                }
                break;
            case 'error':
                outcome.errorEvent = { error: event.value };
                this._view?.webview.postMessage({ type: 'error', value: event.value });
                break;
        }
    }

    private async _fetchModels(): Promise<boolean> {
        if (!this._view) return false;
        // A remembered model for THIS credential wins over the in-memory one -
        // the in-memory value may belong to the credential we just switched
        // away from. The legacy secret is the pre-multi-provider fallback.
        // With NO active credential there is nothing to restore: wipe instead,
        // or a deleted connection's model lingers in the picker forever.
        if (await this._resolveActiveCredentialId()) {
            this._selectedModel = (await this._modelForActiveCredential())
                ?? this._selectedModel
                ?? (await this._secrets.get('xratu.selectedModel') ?? null);
        } else if (this._selectedModel) {
            this._selectedModel = null;
            await this._secrets.delete('xratu.selectedModel');
        }
        // Let the picker spin its refresh button for the duration of the fetch.
        this._view.webview.postMessage({ type: 'modelsRefreshing', active: true });
        try {
            const llm = await this._getLlmCredentials();
            if (!llm.llm_base_url) {
                // Nothing configured - the picker stays empty until a
                // provider is connected.
                this._view.webview.postMessage({
                    type: 'modelInfo', defaultModel: '', models: [],
                    visionCapable: this.isLocalModelVisionCapable(),
                    contextWindows: this._contextWindows,
                    overrides: this._contextWindowOverrides(),
                    thinkingLevels: this._thinkingLevels(),
                    selectedModel: this._selectedModel ?? undefined
                });
                this._view.webview.postMessage({ type: 'byokSetupHint' });
                return false;
            }
            // Runtime collapse: every credential - remote BYOK or on-machine
            // runtime - is an OpenAI-compatible endpoint the extension probes
            // and chats with directly.
            return await this._fetchLocalModels(llm.llm_base_url, llm.llm_api_key);
        } catch (e) {
            // Probe failure - tell the user instead of failing silently.
            this._view.webview.postMessage({
                type: 'byokCredentialError',
                value: e instanceof Error ? e.message : String(e)
            });
            return false;
        } finally {
            this._view.webview.postMessage({ type: 'modelsRefreshing', active: false });
        }
    }

    private async _fetchLocalModels(baseUrl: string, apiKey?: string): Promise<boolean> {
        if (!this._view) return false;
        const insecureError = insecureRemoteHttpError(baseUrl, apiKey);
        if (insecureError) {
            this._view.webview.postMessage({ type: 'byokCredentialError', valueKey: insecureError });
            return false;
        }
        // Deselect/switch may happen while the probe below is in flight -
        // remember which credential started this fetch so a stale result
        // never resurrects a selection the user just cleared (a stale model
        // paired with the fallback credential would mislabel chat requests).
        const fetchCredId = await this._resolveActiveCredentialId();
        this._view.webview.postMessage({ type: 'modelsRefreshing', active: true });
        try {
            const probed = await probeLocalEndpoint(baseUrl, undefined, apiKey);
            if ((await this._resolveActiveCredentialId()) !== fetchCredId) {
                return false;
            }
            if (!probed) {
                this._view.webview.postMessage({
                    type: 'byokCredentialError',
                    valueKey: 'localUnreachable',
                });
                return false;
            }

            const models = probed.models.map((m) => m.id).filter(Boolean);
            const localWindows: Record<string, number> = {};
            for (const m of probed.models) {
                if (m.id && m.contextWindow) localWindows[m.id] = m.contextWindow;
            }
            // Prefer the model remembered for this credential, then the
            // in-memory selection; fall back to the provider's first model.
            const remembered = await this._modelForActiveCredential();
            const preferred = remembered && models.includes(remembered)
                ? remembered
                : this._selectedModel;
            this._selectedModel = preferred && models.includes(preferred)
                ? preferred
                : (models[0] ?? null);
            this._contextWindows = { ...this._contextWindows, ...localWindows };
            void this._saveContextWindows();
            this._view.webview.postMessage({
                type: 'modelInfo',
                defaultModel: models[0] ?? '',
                models,
                contextWindows: this._contextWindows,
                overrides: this._contextWindowOverrides(),
                thinkingLevels: this._thinkingLevels(),
                selectedModel: this._selectedModel ?? undefined,
                visionCapable: this.isLocalModelVisionCapable(),
            });
            return true;
        } catch (e) {
            this._view.webview.postMessage({
                type: 'byokCredentialError',
                valueKey: 'localUnreachableDetail',
                params: { detail: e instanceof Error ? e.message : String(e) },
            });
            return false;
        } finally {
            this._view.webview.postMessage({ type: 'modelsRefreshing', active: false });
        }
    }

    /** Command-palette entry point (keeps _setLlmCredentials private-adjacent). */
    public async setLlmCredentialsPublic(): Promise<void> {
        await this.ensureView();
        void this._setLlmCredentials();
    }

    /** Command-palette entry point: focus the webview and route to Settings. */
    public async openSettingsPublic(): Promise<void> {
        await this.ensureView();
        this._view?.webview.postMessage({ type: 'openSettings' });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // The old webview is gone (reload/re-init): any confirm banner it owed
        // an answer can never be answered - settle them as cancelled.
        for (const [id, resolve] of this._pendingNotifies) {
            this._pendingNotifies.delete(id);
            resolve(null);
        }
        // Same for local-approval promises: the approval card died with the
        // old page, so nobody can ever answer it - without this the suspended
        // runLocalAgent generator waits forever, holding its controller slot.
        this._rejectPendingLocalApprovals();

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Dispose old subscriptions before creating new ones (prevents listener leak on re-init)
        for (const sub of this._webviewSubscriptions) { sub.dispose(); }
        this._webviewSubscriptions = [];

        this._webviewSubscriptions.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this._startConnectionPolling();
                    this._pushEditorContext();
                    // Skills live on disk - rescan on every focus so the
                    // capabilities page never shows a stale list.
                    void this._sendSkillsState();
                } else {
                            }
            })
        );

        // Keep the webview's editor context fresh - suggestion workflows
        // name the open file, so every editor switch must be echoed.
        this._webviewSubscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                if (webviewView.visible) this._pushEditorContext();
            })
        );

        this._webviewSubscriptions.push(
            webviewView.webview.onDidReceiveMessage((data) => {
            (async () => {
                try {
                    switch (data.type) {
                        case 'webviewReady':
                            // Locale FIRST, before any await: the boot chain
                            // below (_showStartScreen) must never outrun this
                            // echo, or the page renders in the wrong language.
                            // (The HTML also bakes the locale in; this is the
                            // idempotent echo.)
                            this._view?.webview.postMessage({
                                type: 'locale',
                                locale: this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa'
                            });
                            this._startConnectionPolling();
                            // Re-echo the policy toggles: a webview reload
                            // (new session, logout loop, window reload)
                            // resets the UI to OFF while the host state
                            // persists - the toolbar must never lie about
                            // YOLO being armed.
                            this._view?.webview.postMessage({ type: 'yoloMode', enabled: this._yoloMode });
                            this._view?.webview.postMessage({ type: 'planMode', enabled: this._planMode });
                            this._pushTaskListState();
                            this._resetLiveSegments();
                            // Reconcile the local multi-session index with the
                            // on-disk directories (+ legacy one-shot import)
                            // and restore the CURRENT session - both inside
                            // ONE serialized transition: the restore reads
                            // the index (a fire-and-forget reconcile could
                            // race it and restore nothing, or a stale id, on
                            // the first run after the legacy migration), and
                            // the transition queue keeps a boot racing
                            // openSession/clearHistory from restoring a stale
                            // session id over the newer transition's state.
                            await this._serializeSessionTransition(async () => {
                                await this._localSessionStore.reconcile(this._localWorkspaceKey()).catch((e) =>
                                    console.error('xratu: local session reconcile failed', e));
                                await this._showStartScreen();
                            });
                            this._pushEditorContext();
                            break;
                        case 'setLocale':
                            void this._globalState.update('xratu.locale', data.locale);
                            setUiLocale(data.locale === 'en' ? 'en' : 'fa');
                            break;
                        case 'askQuestion':
                            await this._handleChatRequest(data.value, data.attachments);
                            break;
                        case 'steerRun':
                            void this._handleSteer(data.value, data.attachments);
                            break;
                        case 'requestFileList':
                            void this._pushFileList();
                            break;
                        case 'approvalDecision':
                            await this._handleToolApproval(data.approvalId, data.decisions || {}, data.sessionApprove === true);
                            break;
                        case 'notificationAction':
                            this._resolveNotification(data.id, data.action ?? null);
                            break;
                        case 'cancelRequest':
                            this._cancelActiveRequests();
                            break;
                        case 'restoreCheckpoint':
                            void this.restoreCheckpointFlow();
                            break;
                        case 'clearHistory':
                            // Legacy sender - same semantics as a new session
                            // (multi-session keeps old conversations intact).
                            await this.clearHistory();
                            break;
                        case 'newSession':
                            await this.clearHistory();
                            break;
                        case 'clearAllSessions':
                            // Settings "Clear history": wipe EVERY stored
                            // session on this machine, then start fresh.
                            await this._clearAllSessions();
                            break;
                        case 'listSessions':
                            await this._listSessions(!!data.all);
                            break;
                        case 'openSession':
                            await this._openSession(data.id);
                            break;
                        case 'renameSession':
                            await this._renameSession(data.id, String(data.title ?? ''));
                            break;
                        case 'deleteSession':
                            await this._deleteSession(data.id);
                            break;
                        case 'saveLlmCredentials':
                            void this._saveLlmCredentials(data.base_url, data.api_key, !!data.returnToChat);
                            break;
                        case 'selectLlmCredential':
                            void this._selectLlmCredential(data.id);
                            break;
                        case 'deleteLlmCredential':
                            void this._deleteLlmCredential(data.id);
                            break;
                        case 'updateLlmCredential':
                            void this._updateLlmCredential(data.id, data.api_key);
                            break;
                        case 'openCredentials':
                            void this._setLlmCredentials(undefined, data.target);
                            break;
                        case 'toggleYolo':
                            this._yoloMode = !this._yoloMode;
                            this._view?.webview.postMessage({ type: 'yoloMode', enabled: this._yoloMode });
                            break;
                        case 'togglePlanMode':
                            this._planMode = !this._planMode;
                            this._view?.webview.postMessage({ type: 'planMode', enabled: this._planMode });
                            // The in-flight run captured its toolset + mode at
                            // start (schemas snapshot per run) - a mid-run
                            // toggle must never read as retroactively active.
                            if (this._localRunActive) {
                                this.notifyBanner('info', 'planModeLiveNote');
                            }
                            break;
                        case 'listModels':
                            await this._fetchModels();
                            break;
                        case 'selectModel': {
                            this._selectedModel = data.value;
                            void this._secrets.store('xratu.selectedModel', data.value);
                            void this._rememberModelForActiveCredential(data.value);
                            break;
                        }
                        case 'setContextWindowOverride':
                            void this._setContextWindowOverride(data.model, data.window);
                            break;
                        case 'setThinkingLevel':
                            void this._setThinkingLevel(data.model, data.level);
                            break;
                        case 'copyToClipboard':
                            void vscode.env.clipboard.writeText(data.value);
                            break;
                        case 'taskListEdit': {
                            // User edit of the checklist (webview is the single
                            // editing surface). Stored as the session override;
                            // the next /chat request echoes it so the model
                            // sees the edited list in its per-turn reminder.
                            if (this._sessionId && Array.isArray(data.tasks) && data.tasks.length > 0) {
                                this._taskListEdits[this._sessionId] = data.tasks as TaskListItem[];
                                void this._saveTaskListEdits().catch((e) =>
                                    console.error('xratu: task list edit persist failed:', e));
                            }
                            this._pushTaskListState();
                            break;
                        }
                        case 'editMessage':
                            this._rewindAndResend(data.userIndex, data.value, data.attachments).catch((e) => {
                                this.notifyBanner('error', 'notifEditFailed', {
                                    error: e instanceof Error ? e.message : String(e)
                                });
                            });
                            break;
                        case 'openMcpSettings': {
                            // MCP config lives in dedicated JSON files, NOT
                            // VS Code settings - open the resolved file (the
                            // workspace file when it exists, else global) so
                            // raw edits land where the page saves.
                            const store = mcpConfigStoreInstance;
                            const wsPath = store?.workspacePath ?? null;
                            let target = wsPath && fs.existsSync(wsPath) ? wsPath : store?.globalPath ?? null;
                            if (target && !fs.existsSync(target)) {
                                await fs.promises.mkdir(path.dirname(target), { recursive: true });
                                // Exclusive create - never clobber a config
                                // created concurrently (TOCTOU on exists).
                                try {
                                    await fs.promises.writeFile(target, '{\n  "mcpServers": {}\n}\n', { encoding: 'utf-8', flag: 'wx' });
                                } catch (err: any) {
                                    if (err?.code !== 'EEXIST') throw err;
                                }
                            }
                            if (target) {
                                await vscode.window.showTextDocument(vscode.Uri.file(target));
                            }
                            break;
                        }
                        case 'mcpGetState':
                            await this._sendMcpState();
                            // Fire-and-forget live probe: statuses fill in
                            // (and re-push) as servers connect. Errors here
                            // are already recorded per-server.
                            void externalMcpInstance?.listTools()
                                .catch(() => undefined)
                                .finally(() => { void this._sendMcpState(); });
                            break;
                        case 'mcpSave':
                            await this._saveMcpConfig(data.target as McpSaveTarget, data.servers as ExternalServerConfig[]);
                            break;
                        case 'mcpRestart':
                            await externalMcpInstance?.restart(String(data.name ?? ''));
                            await this._sendMcpState();
                            break;
                        case 'skillsGetState':
                            await this._sendSkillsState();
                            break;
                        case 'skillsToggle':
                            await this._setSkillEnabled(
                                String(data.id ?? ''),
                                !!data.enabled,
                            );
                            await this._sendSkillsState();
                            break;
                        case 'skillsReveal': {
                            // Reveal a skill folder in the OS file explorer.
                            // Without a dirPath: ensure + reveal the global
                            // skills directory (empty-state CTA).
                            const requested = String(data.dirPath ?? '').trim();
                            let target = '';
                            if (requested && await this._isDir(requested)) {
                                target = requested;
                            } else {
                                const globalSkills = path.join(os.homedir(), '.agents', 'skills');
                                try { await fs.promises.mkdir(globalSkills, { recursive: true }); } catch { /* reveal best effort */ }
                                target = globalSkills;
                            }
                            // Guard against arbitrary path reveals leaking
                            // beyond skill locations - only reveal paths that
                            // are (or live under) a known skills root.
                            if (await this._isKnownSkillsPath(target)) {
                                void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
                            }
                            break;
                        }
                        case 'skillsOpen': {
                            // Open a skill's SKILL.md in an editor tab - the
                            // skills page's "edit" affordance. Missing files
                            // are scaffolded from a minimal template.
                            const requested = String(data.dirPath ?? '').trim();
                            if (requested && await this._isDir(requested) && await this._isKnownSkillsPath(requested)) {
                                await this._openSkillFile(requested);
                            }
                            break;
                        }
                        case 'skillsCreate': {
                            // Scaffold a unique new-skill folder in the
                            // global skills directory and open it.
                            const dir = await this._createSkillScaffold();
                            if (dir) {
                                await this._openSkillFile(dir);
                                await this._sendSkillsState();
                            }
                            break;
                        }
                        case 'skillsDelete': {
                            // Permanently remove a skill folder (path-guarded
                            // to known skills locations).
                            const dirPath = String(data.dirPath ?? '').trim();
                            await this._deleteSkillFolder(dirPath);
                            await this._sendSkillsState();
                            break;
                        }
                        case 'discoverLocalModels': {
                            // Probes can throw (network glitches, aborted
                            // fetches) - report the failure instead of an
                            // indistinguishable empty result.
                            try {
                                const discovered = await this.discoverLocalModels();
                                this._view?.webview.postMessage({
                                    type: 'localModelsDiscovered',
                                    runtimes: discovered.map((d) => ({
                                        id: d.connection.id,
                                        runtime: d.connection.runtime,
                                        name: d.connection.name,
                                        baseUrl: d.connection.baseUrl,
                                        modelCount: d.models.length,
                                        models: d.models.map((m) => m.id),
                                        supportsTools: d.supportsTools,
                                        supportsVision: d.supportsVision,
                                    })),
                                });
                            } catch (e) {
                                this._view?.webview.postMessage({
                                    type: 'localModelsDiscovered',
                                    runtimes: [],
                                    error: e instanceof Error ? e.message : String(e),
                                });
                            }
                            break;
                        }
                        case 'regenerate': {
                            // Re-run the LAST exchange: rewind to its own
                            // pre-prompt checkpoint and resend unchanged.
                            let lastUser = -1;
                            for (let i = 0; i < this._history.length; i++) {
                                if (this._history[i].role === 'user') lastUser = i;
                            }
                            if (lastUser >= 0) {
                                this._rewindAndResend(lastUser, null).catch((e) => {
                                    this.notifyBanner('error', 'notifRegenerateFailed', {
                                        error: e instanceof Error ? e.message : String(e)
                                    });
                                });
                            }
                            break;
                        }
                    }
                } catch (err) {
                    console.error('xratu: unhandled error', err);
                    this._view?.webview.postMessage({ type: 'error', valueKey: 'errInternal', params: { detail: err instanceof Error ? err.message : String(err) } });
                }
            })();
        })
        );
    }

    /** Push the MCP page's complete view: merged config + live statuses +
     *  the curated registry. Header values are included (the page is the
     *  single editing surface - masking them would make saves destructive). */
    private async _sendMcpState(): Promise<void> {
        if (!externalMcpInstance || !mcpConfigStoreInstance || !this._view) return;
        const config = await mcpConfigStoreInstance.load();
        const statuses = await externalMcpInstance.getServerStatuses();
        const servers = statuses.map((s) => ({
            ...config.servers[s.name],
            name: s.name,
            state: s.state,
            toolCount: s.toolCount,
            lastError: s.lastError,
            source: s.source,
        }));
        this._view.webview.postMessage({
            type: 'mcpState',
            servers,
            hasWorkspace: !!config.workspacePath,
            legacyInUse: config.legacyInUse,
            registry: MCP_REGISTRY,
        });
    }

    /** MCP page saves are dispatched concurrently by the webview message
     *  handler - serialize write → echo-marker → reload → state-push so an
     *  earlier save can never complete out of order (or have its echo
     *  consumed by a later save's watcher event). */
    private _mcpSaveQueue: Promise<unknown> = Promise.resolve();

    private _saveMcpConfig(target: McpSaveTarget, servers: ExternalServerConfig[]): Promise<void> {
        const run = this._mcpSaveQueue.then(() => this._saveMcpConfigNow(target, servers), () => this._saveMcpConfigNow(target, servers));
        this._mcpSaveQueue = run.catch(() => undefined);
        return run;
    }

    private async _saveMcpConfigNow(target: McpSaveTarget, servers: ExternalServerConfig[]): Promise<void> {
        if (!externalMcpInstance || !mcpConfigStoreInstance) return;
        const map: Record<string, ExternalServerConfig> = {};
        for (const entry of Array.isArray(servers) ? servers : []) {
            const name = String((entry as { name?: unknown }).name ?? '').trim();
            if (!name) continue;
            const { name: _n, state: _s, toolCount: _t, lastError: _l, source: _src, ...cfg } = entry as ExternalServerConfig & Record<string, unknown>;
            map[name] = cfg as ExternalServerConfig;
        }
        // The page only sees the MERGED view (workspace wins per key over
        // global), so rebuilding the global file from its rows alone would
        // silently delete a global entry shadowed by a same-name workspace
        // override. Re-attach the invisible entries - payload names win if
        // the user explicitly wrote a server with that name.
        if (target === 'global') {
            const current = await mcpConfigStoreInstance.load();
            for (const [name, cfg] of Object.entries(current.shadowedGlobalEntries)) {
                if (!(name in map)) map[name] = cfg;
            }
        }
        // The config-file watcher fires on this write too - arm the pending
        // marker (path + content hash) so the watcher consumes its echo
        // instead of double-reloading (each reload restarts the stdio
        // servers).
        const writeTarget = target === 'workspace' ? mcpConfigStoreInstance.workspacePath : mcpConfigStoreInstance.globalPath;
        if (writeTarget) {
            const written = JSON.stringify({ mcpServers: map }, null, 2) + '\n';
            this._mcpPageWritePending = {
                path: writeTarget,
                hash: crypto.createHash('sha256').update(written, 'utf-8').digest('hex'),
            };
            if (this._mcpPageWriteTimer) clearTimeout(this._mcpPageWriteTimer);
            this._mcpPageWriteTimer = setTimeout(() => {
                this._mcpPageWritePending = null;
                this._mcpPageWriteTimer = null;
            }, 10_000);
        }
        await mcpConfigStoreInstance.save(target, map);
        await externalMcpInstance.reload();
        await this._sendMcpState();
    }

    /** Raw mcp.json edits (the MCP page's "Edit raw JSON" opens the file in
     *  the editor): drop cached connections and re-push the page state.
     *  Called debounced by the file watchers with the changed path; an event
     *  whose file still hashes to the page's just-written content is the
     *  save's own echo and is consumed without a redundant reload. Omitting
     *  the path (workspace-trust transitions) always reloads. */
    public async reloadMcpFromDisk(changedPath?: string): Promise<void> {
        if (!externalMcpInstance) return;
        const pending = this._mcpPageWritePending;
        if (pending && changedPath && sameMcpPath(pending.path, changedPath)) {
            let echo = false;
            try {
                const current = fs.readFileSync(changedPath);
                echo = crypto.createHash('sha256').update(current).digest('hex') === pending.hash;
            } catch {
                echo = false;
            }
            this._mcpPageWritePending = null;
            if (this._mcpPageWriteTimer) {
                clearTimeout(this._mcpPageWriteTimer);
                this._mcpPageWriteTimer = null;
            }
            if (echo) return;
        }
        await externalMcpInstance.reload();
        await this._sendMcpState();
    }

    /** Discover Agent Skills for the upcoming run, minus user-disabled ones.
     *  Never throws - a broken skills directory must not kill a run. */
    private _discoverSkillsForRun(workspaceRoot: string): DiscoveredSkill[] {
        try {
            return listableSkills(
                discoverSkills({ workspaceRoot: workspaceRoot || undefined }),
                new Set(this._disabledSkillIds()),
            );
        } catch {
            return [];
        }
    }

    /** Raw disabled-skill store: `source:name` ids (current scheme) plus any
     *  pre-id bare names, which keep working via the name fallback. */
    private _disabledSkillIds(): string[] {
        const raw = this._globalState.get<string>('xratu.disabledSkills');
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }

    private async _setSkillEnabled(id: string, enabled: boolean): Promise<void> {
        const id0 = String(id ?? '').trim();
        if (!id0) return;
        const set = new Set(this._disabledSkillIds());
        if (enabled) {
            // Drop both the exact id and any stale bare-name entry.
            set.delete(id0);
            const name = id0.includes(':') ? id0.slice(id0.indexOf(':') + 1) : '';
            if (name) set.delete(name);
        } else {
            set.add(id0);
        }
        await this._globalState.update('xratu.disabledSkills', JSON.stringify(Array.from(set).sort()));
    }

    /** Push the Skills page view: discovered skills (valid, invalid, and
     *  shadowed) with enabled flags and folder paths for reveal actions. */
    private async _sendSkillsState(): Promise<void> {
        if (!this._view) return;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const disabled = new Set(this._disabledSkillIds());
        let skills: DiscoveredSkill[] = [];
        try {
            skills = discoverSkills({ workspaceRoot: root || undefined });
        } catch {
            skills = [];
        }
        // Auto-renamed folders leave editor tabs on the old path - close
        // them so a later save cannot resurrect the old folder.
        if (skills.some((s) => s.renamedFrom)) {
            for (const s of skills) {
                if (s.renamedFrom) {
                    await this._closeStaleSkillEditors(
                        path.join(path.dirname(s.dirPath), s.renamedFrom),
                        s.dirPath,
                    );
                }
            }
            // The carried-over editor buffer may itself contain a NEWER
            // name than disk had at scan time - rescan once so the state
            // pushed below is already final (one refresh, not two).
            try {
                skills = discoverSkills({ workspaceRoot: root || undefined });
            } catch {
                /* keep the first scan */
            }
        }
        const isEnabled = (s: DiscoveredSkill): boolean =>
            !s.error && !s.shadowed && !disabled.has(skillId(s.source, s.name)) && !disabled.has(s.name);
        this._view.webview.postMessage({
            type: 'skillsState',
            skills: skills.map((s) => ({
                id: skillId(s.source, s.name),
                name: s.name,
                description: s.description,
                dirPath: s.dirPath,
                source: s.source,
                bodyChars: s.bodyChars,
                error: s.error ?? null,
                shadowed: !!s.shadowed,
                enabled: isEnabled(s),
            })),
        });
    }

    private async _isDir(p: string): Promise<boolean> {
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
    private async _isKnownSkillsPath(p: string): Promise<boolean> {
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
    private async _openSkillFile(skillDir: string): Promise<void> {
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

    /** Scaffold a unique `new-skill` folder in the global skills directory
     *  and return its path (null when the directory cannot be created). */
    private async _createSkillScaffold(): Promise<string | null> {
        const globalSkills = path.join(os.homedir(), '.agents', 'skills');
        try {
            await fs.promises.mkdir(globalSkills, { recursive: true });
        } catch {
            return null;
        }
        let name = 'new-skill';
        for (let n = 2; await this._isDir(path.join(globalSkills, name)); n++) {
            name = `new-skill-${n}`;
        }
        const dir = path.join(globalSkills, name);
        try {
            await fs.promises.mkdir(dir, { recursive: true });
        } catch {
            return null;
        }
        return dir;
    }

    /** Settings "Clear history": wipe EVERY stored session on this machine,
     *  then land in a fresh empty one. The active session is invalidated
     *  BEFORE the deletions so an in-flight or pending persist cannot
     *  resurrect a directory mid-clear, reconciliation runs before the
     *  listing so orphaned directories and legacy snapshots are included,
     *  and deletion failures are counted, not fatal - the clear proceeds
     *  with an honest error afterward. */
    private async _clearAllSessions(): Promise<void> {
        this._cancelActiveRequests();
        this._sessionEpoch++;
        // Mirror the run-loop finally: a pending partial flush must not fire
        // against a session we are about to invalidate and delete.
        this._localPendingTurn = null;
        if (this._localPartialTimer) {
            clearTimeout(this._localPartialTimer);
            this._localPartialTimer = null;
        }
        // The abort above is asynchronous - the run loop unwinds on a later
        // event. Await its settlement so the fresh session is not exposed
        // while the dead run can still write, and a steer aimed at the old
        // run cannot fall into the epoch-drop path unanswered. If the run
        // refuses to settle, ABORT the clear: proceeding from here would
        // recreate exactly the race this flow exists to prevent.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this._view?.webview.postMessage({ type: 'error', valueKey: 'clearHistoryBusy' });
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        let failed = 0;
        try {
            // list() reads only the index - reconcile first so orphaned
            // session directories and eligible legacy snapshots are covered.
            await this._localSessionStore.reconcile(this._localWorkspaceKey());
            const all = await this._localSessionStore.list();
            for (const meta of all) {
                const ok = await this._localSessionStore.delete(meta.id);
                if (!ok) failed++;
            }
        } catch (e) {
            console.error('xratu: clear all sessions failed', e);
            failed++;
        }
        // Per-session task-list overrides live in global state - wipe them
        // with the sessions, before the fresh empty one is created.
        this._taskListEdits = {};
        await this._saveTaskListEdits();
        await this.clearHistory();
        if (failed > 0) {
            this._view?.webview.postMessage({
                type: 'error',
                valueKey: 'clearHistoryIncomplete',
                params: { count: String(failed) },
            });
        }
    }

    /** Permanently remove a skill folder. Caller supplies a webview path -
     *  guarded to known skills locations. */
    private async _deleteSkillFolder(dirPath: string): Promise<void> {
        if (!(await this._isDir(dirPath)) || !(await this._isKnownSkillsPath(dirPath))) return;
        try {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
        } catch (e) {
            console.error('xratu: skill delete failed', e);
        }
    }

    /** After discovery auto-renamed a skill folder, close editor tabs still
     *  open on the OLD SKILL.md path. Without this, saving such a stale tab
     *  recreates the old folder and the skill reappears as a duplicate.
     *  Unsaved edits are carried over to the renamed file first. */
    private async _closeStaleSkillEditors(oldDir: string, newDir: string): Promise<void> {
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

    private _restoreChatUI() {
        if (!this._view) return;
        // Replay never streams chunks - any stale segment state from an
        // errored turn must not leak into the replayed bubbles.
        this._resetLiveSegments();
        for (const msg of this._history) {
            if (msg.role === 'user') {
                this._view.webview.postMessage({ type: 'restoreUser', value: msg.content, attachments: msg.attachments });
            } else if (msg.role === 'assistant') {
                if (Array.isArray(msg.events) && msg.events.length > 0) {
                    this._view.webview.postMessage({ type: 'startResponse' });
                    for (const parsed of msg.events) {
                        if (parsed.type === 'thinking') {
                            this._view.webview.postMessage({ type: 'thinking', value: parsed.content });
                        } else if (parsed.type === 'tool_call') {
                            this._view.webview.postMessage({
                                type: 'toolCall',
                                tool: parsed.tool,
                                args: JSON.stringify(parsed.args, null, 2),
                                callId: parsed.id ?? undefined
                            });
                        } else if (parsed.type === 'tool_result') {
                            this._view.webview.postMessage({
                                type: 'toolResult',
                                tool: parsed.tool,
                                output: parsed.output,
                                callId: parsed.id ?? undefined
                            });
                        } else if (parsed.type === 'result') {
                            this._displayAssistantResponse(parsed);
                        }
                    }
                } else if (msg.content) {
                    this._displayAssistantResponse({ persian_explanation: msg.content });
                }
            }
        }
    }

    private _renderMarkdown(text: string, live = false): string {
        const source = live ? closeOpenFence(text) : text;
        const rawHtml = (live ? mdLive : md).render(source);
        // Sanitize before sending to webview - allowlist-based, not regex blocklist
        return _sanitizeHtml(rawHtml);
    }

    private _localWorkspaceKey(): string {
        const folder = vscode.workspace.workspaceFolders?.[0];
        return folder?.uri.fsPath || 'default';
    }

    // ------------------------------------------------------------------
    // Session management (multi-session: create / list / switch / rename
    // / delete) - cloud sessions live in the backend, local sessions in
    // the LocalSessionStore. The toolbar's centered title button drives
    // all of it through the webview protocol.
    // ------------------------------------------------------------------

    private static readonly TITLE_MAX_LEN = 48;

    private _workspaceName(): string {
        const activeEditor = vscode.window.activeTextEditor;
        const folder = (activeEditor && vscode.workspace.getWorkspaceFolder(activeEditor.document.uri))
            || vscode.workspace.workspaceFolders?.[0];
        return folder?.name || 'default';
    }

    private _deriveSessionTitle(text: string): string {
        const clean = text.replace(/\s+/g, ' ').trim();
        if (!clean) return this._workspaceName();
        // Code-point truncation (mirrors LocalSessionStore) - UTF-16
        // slicing would split a surrogate pair at the boundary.
        const chars = Array.from(clean);
        return chars.length > XratuChatViewProvider.TITLE_MAX_LEN
            ? chars.slice(0, XratuChatViewProvider.TITLE_MAX_LEN).join('') + '…'
            : clean;
    }

    /** Legacy key shape preserved verbatim - existing installs already
     *  persist their last-active session under it (the `xratu.lastLocalSession`
     *  branch was dead code: `_localRuntime` was never set). */
    private _lastSessionStateKey(): string {
        return `xratu.lastSession.${this._workspaceName()}`;
    }

    /** Echo current session identity to the webview (toolbar title button). */
    private _pushSessionState(): void {
        this._view?.webview.postMessage({
            type: 'sessionState',
            id: this._sessionId,
            title: this._sessionTitle,
        });
        // The checklist + progress chip are per-session: every session
        // switch re-echoes the merged task list for the NEW session.
        this._pushTaskListState();
    }

    /** Reset the per-session ledgers. Callers own cancel + epoch bump. */
    private _resetSessionLedgers(): void {
        this._sessionId = null;
        this._history = [];
        this._localHistory = [];
        this._sessionSummary = null;
        this._sessionTitle = null;
        this._approvalCloseItems = {};
        this._sessionApprovedKinds.clear();
        this._virtualDocuments.clear();
    }

    private async _reloadWebviewChat(): Promise<void> {
        if (!this._view) return;
        // webview.html reload destroys the old page; the template defaults to
        // welcome-screen shown. The fresh page sends webviewReady, whose
        // handler runs _showStartScreen() exactly once - never call it here
        // too: both calls replay the chat history and every message renders
        // TWICE on the fresh page (hello, response, hello, response).
        this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }

    /** Session picker listing for the webview. With `all` the list spans
     *  every workspace; otherwise it is scoped to the current one. */
    private async _listSessions(all: boolean): Promise<void> {
        const metas = await this._localSessionStore.list(all ? undefined : this._localWorkspaceKey());
        const items = metas.map((m) => ({ id: m.id, title: m.title, workspace: m.workspace, updatedAt: m.updatedAt }));
        this._view?.webview.postMessage({ type: 'sessionList', items, currentId: this._sessionId });
    }

    /** Session transitions (switch/create) are dispatched concurrently by
     *  the webview message handler - serialize them so a stale load/create
     *  cannot overwrite a newer transition's session state. */
    private _sessionTransitionQueue: Promise<unknown> = Promise.resolve();

    private _serializeSessionTransition<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._sessionTransitionQueue.then(fn, fn);
        this._sessionTransitionQueue = run.catch(() => undefined);
        return run;
    }

    /** Swap the visible session to `id`. Allowed while a run streams: the
     *  live run is cancelled first (the epoch bump keeps its settled state
     *  out of the new session's view), then the webview reloads so
     *  streaming state starts clean. Serialized against clearHistory. */
    private _openSession(id: string): Promise<void> {
        return this._serializeSessionTransition(() => this._openSessionNow(id));
    }

    private async _openSessionNow(id: string): Promise<void> {
        this._cancelActiveRequests();
        // The abort above is asynchronous - await the dead run's settlement
        // so buffered events and its throttled save cannot render into, or
        // persist over, the session we are about to expose. A run that
        // refuses to settle ABORTS the switch: proceeding would let its
        // events write into the new session.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this.notifyBanner('warning', 'sessionSwitchBusy');
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        const snapshot = await this._localSessionStore.load(id);
        if (!snapshot) {
            this.notifyBanner('warning', 'sessionLoadFailed');
            return;
        }
        this._sessionId = snapshot.sessionId;
        this._localHistory = snapshot.localHistory;
        this._history = snapshot.uiHistory as HistoryMessage[];
        this._sessionSummary = snapshot.summary ?? null;
        // A stored title that is still the workspace placeholder reads as
        // untitled - otherwise the placeholder blocks first-message seeding
        // and is locked in as renamedTitle on the next save.
        this._sessionTitle = resolveSessionTitle(snapshot.title, snapshot.renamed, snapshot.workspace, snapshot.uiHistory);
        if (snapshot.model) {
            this._selectedModel = snapshot.model;
            void this._rememberModelForActiveCredential(snapshot.model);
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
        await this._reloadWebviewChat();
    }

    /** Start a brand-new session (toolbar +, Settings entry). Previously
     *  "clear history" - which DESTROYED the conversation; multi-session
     *  keeps it and creates a fresh one instead. */
    public clearHistory(): Promise<void> {
        return this._serializeSessionTransition(() => this._clearHistoryNow());
    }

    private async _clearHistoryNow() {
        // A live stream must die WITH the session: without this, the zombie
        // run keeps consuming events and writes its result (or its cancel
        // bookkeeping) into the freshly created session.
        this._cancelActiveRequests();
        // Same settlement wait as _openSession - a run that refuses to
        // settle ABORTS the switch instead of racing the fresh session.
        if (this._localRunSettled) {
            const settled = await Promise.race([
                this._localRunSettled,
                new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
            ]);
            if (settled === false) {
                this._view?.webview.postMessage({ type: 'error', valueKey: 'clearHistoryBusy' });
                return;
            }
        }
        this._sessionEpoch++;
        this._resetSessionLedgers();

        try {
            const meta = await this._localSessionStore.create(this._localWorkspaceKey());
            this._sessionId = meta.id;
            this._sessionTitle = null;
        } catch (e) {
            console.error('xratu: create local session failed', e);
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
        await this._reloadWebviewChat();
    }

    /** Rename a session (picker inline edit); persists in the local store. */
    private async _renameSession(id: string, title: string): Promise<void> {
        const clean = title.replace(/\s+/g, ' ').trim();
        if (!clean) return;
        await this._localSessionStore.rename(id, clean);
        if (id === this._sessionId) {
            this._sessionTitle = clean.slice(0, 128);
            this._pushSessionState();
        }
        await this._listSessions(false);
    }

    /** Hard-delete a session (picker context action; the webview confirms).
     *  Deleting the OPEN session falls back to a fresh empty one. */
    private async _deleteSession(id: string): Promise<void> {
        await this._localSessionStore.delete(id);
        if (this._taskListEdits[id]) {
            delete this._taskListEdits[id];
            void this._saveTaskListEdits().catch((e) =>
                console.error('xratu: task list edit persist failed:', e));
        }
        if (id === this._sessionId) {
            await this.clearHistory();
            return;
        }
        await this._listSessions(false);
    }

    /** Reopen the last-active LOCAL session for this workspace (or the
     *  preferred id already held in memory). Empty result = clean slate. */
    private async _restoreLocalSession(): Promise<void> {
        const preferred = this._sessionId ?? this._globalState.get<string>(this._lastSessionStateKey());
        const meta = await this._localSessionStore.findCurrent(this._localWorkspaceKey(), preferred);
        if (!meta) {
            this._sessionId = null;
            this._history = [];
            this._localHistory = [];
            this._sessionSummary = null;
            this._sessionTitle = null;
            return;
        }
        const snapshot = await this._localSessionStore.load(meta.id);
        if (!snapshot) {
            this._sessionId = null;
            this._history = [];
            this._localHistory = [];
            this._sessionSummary = null;
            this._sessionTitle = null;
            return;
        }
        this._localHistory = snapshot.localHistory;
        this._history = snapshot.uiHistory as HistoryMessage[];
        this._sessionId = snapshot.sessionId;
        this._sessionSummary = snapshot.summary ?? null;
        // Same placeholder rule as _openSessionNow - see resolveSessionTitle.
        this._sessionTitle = resolveSessionTitle(snapshot.title, snapshot.renamed, snapshot.workspace, snapshot.uiHistory);
        this._selectedModel = snapshot.model || this._selectedModel;
        if (snapshot.model) void this._rememberModelForActiveCredential(snapshot.model);
        if (snapshot.pendingTurn?.prompt) {
            // Crash mid-run: fold the interrupted turn into the ledgers
            // exactly like the cancel path - the partial pills/text stay
            // visible and the model replays its tool context (dangling
            // tool calls get placeholder results). Persisted back WITHOUT
            // the pendingTurn below so it can never restore twice.
            const pt = snapshot.pendingTurn;
            const restoredEvents: any[] = [];
            if (pt.thinking) restoredEvents.push({ type: 'thinking', content: pt.thinking });
            restoredEvents.push(...(pt.events ?? []).map(trimDisplayEvent));
            if (pt.text) restoredEvents.push({ type: 'result', persian_explanation: pt.text });
            this._history.push({
                role: 'user',
                content: pt.prompt,
                ...(pt.attachments?.length ? { attachments: pt.attachments } : {}),
            });
            if (restoredEvents.length > 0) {
                this._history.push({ role: 'assistant', events: restoredEvents, content: '' });
            }
            this._localHistory.push({ role: 'user', content: pt.prompt });
            for (const event of pt.events ?? []) {
                if (event.type === 'assistant_message') {
                    this._localHistory.push({
                        role: 'assistant',
                        content: event.content || '',
                        ...(event.tool_calls?.length ? { tool_calls: event.tool_calls } : {}),
                    });
                } else if (event.type === 'tool_result') {
                    this._localHistory.push({ role: 'tool', tool_call_id: event.id, content: event.output });
                } else if (event.type === 'steer_user') {
                    this._localHistory.push({ role: 'user', content: event.text });
                }
            }
            const answered = new Set(
                this._localHistory.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
            );
            for (const m of this._localHistory) {
                for (const tc of m.tool_calls ?? []) {
                    if (!answered.has(tc.id)) {
                        this._localHistory.push({ role: 'tool', tool_call_id: tc.id, content: '[interrupted by a crash]' });
                        answered.add(tc.id);
                    }
                }
            }
            await this._persistLocalSession().catch((e) => {
                console.error('xratu: local session persist failed:', e);
            });
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
    }

    /** Throttled mid-run snapshot: persist the IN-FLIGHT local turn every
     *  5s so a host crash loses at most the last few seconds instead of the
     *  whole turn. Restored via `pendingTurn` in _restoreLocalSession. */
    private _scheduleLocalPartialPersist(): void {
        if (this._localPartialTimer) return;
        this._localPartialTimer = setTimeout(() => {
            this._localPartialTimer = null;
            if (!this._localPendingTurn) return;
            this._persistLocalSession().catch((e) => {
                console.error('xratu: local partial persist failed:', e);
            });
        }, 5000);
    }

    private async _persistLocalSession(): Promise<void> {
        const epochAtEntry = this._sessionEpoch;
        if (!this._sessionId) {
            // First send with no open local session (fresh install, or the
            // last snapshot was cleared) - create one on demand or history
            // would never persist.
            try {
                const meta = await this._localSessionStore.create(this._localWorkspaceKey());
                if (epochAtEntry !== this._sessionEpoch) {
                    // The session was invalidated while creating (clear
                    // history / open session) - do not adopt the stray.
                    void this._localSessionStore.delete(meta.id).catch(() => undefined);
                    return;
                }
                this._sessionId = meta.id;
            } catch (e) {
                console.error('xratu: create local session failed', e);
                return;
            }
        }
        if (epochAtEntry !== this._sessionEpoch) {
            // Invalidated mid-persist - saving would resurrect a deleted
            // session directory under an already-stale id.
            return;
        }
        const sessionIdAtEntry = this._sessionId;
        const titleWasNull = this._sessionTitle == null;
        const hasUserTurn = this._history.some((m) => m.role === 'user');
        const saved = await this._localSessionStore.save(
            this._sessionId!,
            {
                workspace: this._localWorkspaceKey(),
                model: this._selectedModel,
                summary: this._sessionSummary,
                localHistory: this._localHistory,
                uiHistory: this._history,
                pendingTurn: this._localPendingTurn ? {
                    prompt: this._localPendingTurn.prompt,
                    events: this._localPendingTurn.events,
                    text: this._localAccumulatedText,
                    thinking: this._localAccumulatedThinking,
                    ...(this._localPendingTurn.attachments?.length
                        ? { attachments: this._localPendingTurn.attachments }
                        : {}),
                } : null,
            },
            this._sessionTitle ?? undefined
        );
        // The store derives the title from the first user message when the
        // user has not renamed the session - adopt it so the toolbar shows
        // the real name without a reload. Only after a user turn is actually
        // ledgered (a mid-run partial persist has no user row yet, and
        // adopting the workspace placeholder there would lock it in), and
        // only if the session was not switched while the save was in flight
        // - a stale adoption would pin the OLD session's title onto the new
        // one.
        if (
            saved &&
            titleWasNull &&
            hasUserTurn &&
            epochAtEntry === this._sessionEpoch &&
            this._sessionId === sessionIdAtEntry
        ) {
            this._sessionTitle = saved.meta.title;
            this._pushSessionState();
        }
        await this._globalState.update(this._lastSessionStateKey(), this._sessionId);
    }

    // Live markdown during streaming: text deltas accumulate here and a
    // throttled flush keeps the webview updating WHILE the answer streams
    // instead of only after the final event. The same sanitize allowlist as
    // fullResponse applies to every intermediate render.
    //
    // EVERYTHING display-transient rides ONE 100ms tick (raw chunk text,
    // cumulative thinking, segment markdown): per-delta postMessage floods the
    // host→webview bridge and re-renders the streaming bubble dozens of times
    // per second, and 'thinking' is CUMULATIVE per delta (O(n²) traffic if
    // relayed directly). Display-only - buffers never carry state the
    // fullResponse/final segment accounting depends on.
    private _liveMdText = '';
    private _liveMdTimer: ReturnType<typeof setTimeout> | null = null;
    // Timeline segmentation (parallel to the webview's text steps): chunks
    // accumulate into the CURRENT segment; every thinking/tool event closes
    // it so fullResponse can ship per-segment rendered markdown and the
    // final answer stays interleaved between the pills. Both lists reset at
    // turn start and are consumed by _displayAssistantResponse.
    private _liveSegments: string[] = [];
    private _liveSeg = '';
    // Raw text deltas not yet posted to the webview (batched into ONE
    // 'chunk' message per tick).
    private _pendingChunk = '';
    // Latest cumulative thinking text not yet posted (latest value wins).
    private _pendingThinking: string | null = null;

    private _noteStreamChunk(delta: string): void {
        this._liveMdText += delta;
        this._liveSeg += delta;
        this._pendingChunk += delta;
        this._scheduleLiveFlush();
    }

    /** Queue a cumulative thinking update for the next live tick. */
    private _noteThinking(content: string): void {
        this._pendingThinking = content;
        this._scheduleLiveFlush();
    }

    private _scheduleLiveFlush(): void {
        if (this._liveMdTimer) return;
        this._liveMdTimer = setTimeout(() => {
            this._liveMdTimer = null;
            this._flushLiveDisplay();
        }, 100);
    }

    /** One throttled flush of every transient stream display: raw chunk
     *  text first (so the raw step is up to date), then cumulative
     *  thinking, then the CURRENT SEGMENT's rendered markdown - the webview
     *  patches its trailing text step with this html so formatted markdown
     *  appears between the pills while streaming. Rendering the whole
     *  accumulated text here would duplicate earlier segments (each already
     *  has its own step). */
    private _flushLiveDisplay(): void {
        if (this._pendingChunk) {
            this._view?.webview.postMessage({ type: 'chunk', value: this._pendingChunk });
            this._pendingChunk = '';
        }
        if (this._pendingThinking !== null) {
            this._view?.webview.postMessage({ type: 'thinking', value: this._pendingThinking });
            // Rendered markdown for the thinking pill body (same throttle +
            // sanitize pipeline as text segments) - the pill renders formatted
            // reasoning instead of a raw wall of text. Cumulative, so the
            // latest value always covers the whole block.
            this._view?.webview.postMessage({ type: 'thinkingHtml', value: this._renderMarkdown(this._pendingThinking, true) });
            this._pendingThinking = null;
        }
        // A flush racing a segment close must not render an empty segment.
        if (!this._liveSeg) return;
        this._view?.webview.postMessage({
            type: 'streamHtml',
            value: this._renderMarkdown(this._liveSeg, true),
        });
    }

    /** Close the current text segment (called before every non-chunk UI
     *  event, mirroring where the webview opens a new text step). The FINAL
     *  render must happen HERE, synchronously, before the pill event posts:
     *  the tick would otherwise fire with an empty _liveSeg and drop the
     *  tail - and since the trailing step renders only its html, that text
     *  would never appear (the visible "stream stops on tool call"). */
    private _flushLiveSegment(): void {
        if (this._liveMdTimer) {
            clearTimeout(this._liveMdTimer);
            this._liveMdTimer = null;
        }
        this._flushLiveDisplay();
        if (this._liveSeg) {
            this._view?.webview.postMessage({
                type: 'streamHtml',
                value: this._renderMarkdown(this._liveSeg, true),
            });
            this._liveSegments.push(this._liveSeg);
            this._liveSeg = '';
        }
    }

    /** Cancel pending live renders - the final fullResponse takes over. */
    private _endLiveMarkdown(): void {
        if (this._liveMdTimer) {
            clearTimeout(this._liveMdTimer);
            this._liveMdTimer = null;
        }
        this._liveMdText = '';
        this._pendingChunk = '';
        this._pendingThinking = null;
    }

    /** New turn: nothing streamed yet, so the segment timeline starts empty. */
    private _resetLiveSegments(): void {
        this._liveSegments = [];
        this._liveSeg = '';
    }

    private _cancelActiveRequests() {
        for (const controller of this._abortControllers.values()) {
            controller.abort();
        }
        this._abortControllers.clear();
        this._rejectPendingLocalApprovals();
    }

    private _displayAssistantResponse(parsed: any) {
        if (!this._view) return;
        if (parsed.error || parsed.error_key) {
            // error_key (i18n key) is the committed marker of cancelled/
            // failed turns - the replay path surfaces the localized reason.
            this._view.webview.postMessage({
                type: 'error',
                value: parsed.error,
                valueKey: parsed.error_key,
                params: parsed.error_params,
            });
            return;
        }

        const renderedHtml = parsed.persian_explanation
            ? this._renderMarkdown(parsed.persian_explanation)
            : null;

        // Per-segment timeline: the webview's text steps get their FINAL
        // formatted content between the pills instead of the whole answer
        // collapsing into one bottom block. Empty for restored sessions -
        // those keep the single rendered block.
        this._flushLiveSegment();
        const segmentsHtml = this._liveSegments.length > 0
            ? this._liveSegments.map((seg) => this._renderMarkdown(seg))
            : undefined;
        this._resetLiveSegments();

        this._view.webview.postMessage({
            type: 'fullResponse',
            persian: parsed.persian_explanation,
            renderedHtml: renderedHtml,
            segmentsHtml,
            usage: parsed.usage ?? null,
            contextWindow: parsed.context_window ?? null,
            usableContextTokens: parsed.usable_context_tokens ?? null
        });
    }


    /** Files dragged from the VS Code explorer: the webview only receives
     *  text/uri-list, so the HOST reads the bytes via vscode.workspace.fs,
     *  derives the MIME from the filename and echoes full attachments back. */
    private async _handleUriAttachments(uris: string[]): Promise<void> {
        if (!this._view || !uris.length) return;
        const attachments: ComposerAttachment[] = [];
        let totalBytes = 0;
        let error: { key: string; params?: Record<string, string> } | null = null;
        for (const raw of uris.slice(0, ATTACH_MAX_COUNT)) {
            let uri: vscode.Uri;
            try {
                uri = vscode.Uri.parse(raw);
            } catch {
                continue;
            }
            const name = path.basename(uri.fsPath);
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type & vscode.FileType.Directory) {
                    error = { key: 'attachIsFolder', params: { name } };
                    continue;
                }
                if (stat.size === 0) {
                    error = { key: 'attachEmpty', params: { name } };
                    continue;
                }
                if (stat.size > ATTACH_MAX_BYTES) {
                    error = { key: 'attachTooLarge', params: { name } };
                    continue;
                }
                if (totalBytes + stat.size > ATTACH_MAX_TOTAL_BYTES) {
                    error = { key: 'attachTotalTooLarge' };
                    break;
                }
                const mime = mimeFromFilename(name);
                if (!mime || (!isImageAttachment(mime) && !isTextAttachment(mime) && !isPdfAttachment(mime))) {
                    error = { key: 'attachUnsupported', params: { name } };
                    continue;
                }
                const bytes = await vscode.workspace.fs.readFile(uri);
                totalBytes += stat.size;
                attachments.push({
                    id: `a-${crypto.randomUUID()}`,
                    name,
                    mimeType: mime,
                    size: stat.size,
                    dataBase64: Buffer.from(bytes).toString('base64'),
                });
            } catch (e) {
                error = { key: 'attachReadError', params: { name } };
            }
        }
        if (error) {
            this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: error.key, params: error.params });
        }
        if (attachments.length > 0) {
            this._view.webview.postMessage({ type: 'attachmentsFromHost', attachments });
        }
    }

    /** Workspace file list for the composer's @-mention popup. Git keep-set
     *  (tracked + untracked, .gitignore-respected) with a findFiles fallback
     *  - the SAME source the project-tree context uses, so the popup never
     *  offers node_modules/build output, and secret files are filtered even
     *  outside git. LISTING is not attaching: a user who explicitly refs
     *  .env still can (their call, same as the picker). */
    private async _pushFileList(): Promise<void> {
        if (!this._view) return;
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        let files: string[] = [];
        if (wsFolder) {
            try {
                files = Array.from(await gitWorkspaceFiles(wsFolder.uri.fsPath));
            } catch (e) {
                console.error('xratu: git file list failed:', e);
            }
            if (files.length === 0) {
                try {
                    const uris = await vscode.workspace.findFiles(
                        '**/*',
                        '**/{node_modules,.git,.venv,venv,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,target,dist,out,build}/**',
                        FILE_LIST_MAX_ENTRIES + 1
                    );
                    files = uris
                        .map((u) => vscode.workspace.asRelativePath(u, false))
                        .filter((p) => !/(^|\/)\.env$|\.secrets?\.env$/.test(p));
                } catch (e) {
                    console.error('xratu: findFiles fallback failed:', e);
                }
            }
            files.sort();
            if (files.length > FILE_LIST_MAX_ENTRIES) files = files.slice(0, FILE_LIST_MAX_ENTRIES);
        }
        this._view.webview.postMessage({ type: 'fileList', files });
    }

    /** Resolve @-mention REFERENCE attachments (path-only chips) by reading
     *  the workspace files NOW - content is always current at send time, and
     *  the resolved text/image bytes flow through the exact same downstream
     *  pipeline as picker attachments (host validation, PDF extraction,
     *  local fenced blocks, backend fenced blocks). Mutates entries in place.
     *  Fail-closed: any unresolvable ref aborts the send with a composer
     *  error, never a silently dropped reference. */
    private async _resolveReferenceAttachments(
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

    private async _handleChatRequest(prompt: string, attachments?: ComposerAttachment[], opts?: { baseSha?: string; steerCarry?: boolean }): Promise<void> {
        if (!this._view) { return; }
        // Plan mode is captured BEFORE any await: the run later builds its
        // system prompt, toolset and approval gate from this snapshot, so a
        // toggle during pre-flight can never expose mutating tools in an
        // already-started plan turn (or vice versa).
        const planModeAtStart = this._planMode;
        // A run is already live - NEVER run a second concurrent turn (the
        // shared stream buffers would corrupt both). Route the message
        // through the steer pipeline instead: it re-checks run identity and
        // queues for the live round boundary. (Internal carry turns are
        // exempt - their parent loop owns the flag.)
        if (this._localRunActive && !opts?.steerCarry) {
            await this._handleSteer(prompt, attachments);
            return;
        }
        // Claim run ownership SYNCHRONOUSLY - before any await. Two rapid
        // askQuestion sends both passed the guard above while the first was
        // still in pre-flight (checkpoint, rules, project-tree I/O), and ran
        // CONCURRENT turns: both runs share the accumulated-text buffers, so
        // the first ends "done" with an empty transcript and dies with a
        // bogus no-response error. With the claim here, the second request
        // sees the flag set and steers instead. Every exit path - early
        // return, thrown preflight call, normal completion - runs the
        // cleanup in the outer finally below.
        this._localRunActive = true;
        this._localTurnToken += 1;
        if (!opts?.steerCarry) {
            // The run that OWNS _localRunActive publishes a settlement
            // deferred - session-wiping flows await it before exposing the
            // fresh session (steerCarry turns are owned by their parent
            // loop and must not replace it).
            this._localRunSettled = new Promise<void>((resolve) => { this._resolveRunSettled = resolve; });
        }
        // Everything this turn posts from here on belongs to THIS session
        // view - a new session (clearHistory) bumps the epoch and any
        // post-cancel bookkeeping below becomes a no-op.
        const epoch = this._sessionEpoch;
        // Ownership floor for queued steers: anything appended above this
        // length belonged to an earlier turn; this turn may only clear what
        // it accumulated (see the noRun branch). The loop cannot have
        // drained anything before the flag was set.
        const steerQueueFloor = this._localSteerQueue.length;
        try {
            // Seed the display title (server applies the same truncation rule);
            // an explicit rename always wins because this only fills a null.
            if (this._sessionTitle == null && prompt.trim()) {
                this._sessionTitle = this._deriveSessionTitle(prompt);
                this._pushSessionState();
            }

            // Context ships the PROJECT TREE only - never automatic file
            // contents.  Output panels, debug consoles and webviews are
            // irrelevant here by construction; the agent reads specific files
            // through its own tools when it needs their content.
            // @-mention refs resolve FIRST (filling path-only chips with fresh
            // bytes); everything downstream validates them like any attachment.
            const refError = await this._resolveReferenceAttachments(attachments);
            if (refError) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: refError.key, params: refError.params });
                return;
            }
            const attachValidationError = validateHostAttachments(attachments);
            if (attachValidationError) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: attachValidationError.key, params: attachValidationError.params });
                return;
            }
            // PDFs become text attachments HERE (single pipeline for cloud AND
            // local); the display metadata below keeps the original pdf identity.
            const pdfExtraction = await extractPdfAttachments(attachments ?? []);
            if (pdfExtraction.error) {
                this._view.webview.postMessage({ type: 'composerError', value: '', valueKey: pdfExtraction.error.key, params: pdfExtraction.error.params });
                return;
            }
            const sendAttachments = pdfExtraction.attachments;
            const attachmentMeta: AttachmentMeta[] | undefined = attachments && attachments.length > 0
                ? attachments.map((a) => ({ name: a.name, mime_type: a.mimeType, size: a.size, path: a.path }))
                : undefined;
            const wsFolder0 = vscode.workspace.workspaceFolders?.[0];
            let fileContent = "";
            if (wsFolder0) {
                try {
                    const MAX_TREE_ENTRIES = 600;
                    // Git is ground truth here - same keep-set the directory_tree
                    // expansion tool uses (tracked + untracked, .gitignore-respected),
                    // so caches, build output, DBs and secret files never reach the
                    // structure snapshot. findFiles stays as the non-git fallback.
                    let relPaths = Array.from(await gitWorkspaceFiles(wsFolder0.uri.fsPath));
                    if (relPaths.length === 0) {
                        const uris = await vscode.workspace.findFiles(
                            '**/*',
                            '**/{node_modules,.git,.venv,venv,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,target,dist,out,build}/**',
                            MAX_TREE_ENTRIES + 1
                        );
                        relPaths = uris
                            .map((u) => vscode.workspace.asRelativePath(u, false))
                            // Never list secret files, even outside git.
                            .filter((p) => !/(^|\/)\.env$|\.secrets?\.env$/.test(p));
                    }
                    relPaths.sort();
                    const truncated = relPaths.length > MAX_TREE_ENTRIES;
                    const shown = relPaths.slice(0, MAX_TREE_ENTRIES);
                    fileContent =
                        `// Project structure: ${wsFolder0.name}` +
                        (truncated ? ` (first ${MAX_TREE_ENTRIES} of ${relPaths.length} paths)` : '') +
                        '\n' +
                        shown.join('\n');
                } catch (e) {
                    console.error('xratu: building project tree failed:', e);
                }
            }
            this._lastFileContent = fileContent;

            this._view.webview.postMessage({ type: 'startResponse' });
            // Fresh turn: the streamed-text segment timeline starts empty.
            this._resetLiveSegments();
            // Register the cancel controller IMMEDIATELY after startResponse: the
            // pre-prompt checkpoint (shadow-git snapshot) and rules collection
            // below can take seconds, and the webview is ALREADY showing its
            // busy/stop state - cancel must work for the whole isTyping window,
            // not just once the model fetch begins. The abort checks between the
            // pre-flight steps below make the cancel take effect at the next
            // boundary.
            const controller = new AbortController();
            this._abortControllers.set('chat', controller);
            try {
                // Pre-prompt checkpoint: a no-op commit when the tree is unchanged,
                // and THE restore point when this message is later edited/resended.
                // Runs before beginTurn so the turn's lazy snapshot reuses this HEAD
                // instead of creating a second commit.  Rewind-resends skip it and
                // reuse the restored sha instead (see _rewindAndResend).
                const wsFolder = vscode.workspace.workspaceFolders?.[0];
                let prePromptSha: string | undefined = opts?.baseSha;
                if (wsFolder && !prePromptSha) {
                    try {
                        prePromptSha = await this._checkpoints.createCheckpoint(wsFolder.uri.fsPath, 'prompt');
                    } catch (e) {
                        // Non-fatal for the chat itself, but NEVER silent: a broken
                        // capture disables every future file-restore invisibly.
                        console.error('xratu: pre-prompt checkpoint failed:', e);
                    }
                }
                // New turn -> the shadow-checkpoint store may snapshot once more.
                this._checkpoints.beginTurn();

                // Cancel during the pre-flight work: settle like any other cancelled
                // turn (the webview's typing bubble flips to "Request cancelled.") -
                // nothing was streamed or ledgered yet.
                if (controller.signal.aborted) {
                    this._abortControllers.delete('chat');
                    if (epoch === this._sessionEpoch) {
                        this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                    }
                    return;
                }

                const rulesContext = await collectProjectRules();

                if (controller.signal.aborted) {
                    this._abortControllers.delete('chat');
                    if (epoch === this._sessionEpoch) {
                        this._view?.webview.postMessage({ type: 'error', valueKey: 'requestCancelled' });
                    }
                    return;
                }

                // The chat cancel controller was registered right after
                // startResponse (covering checkpoint/rules work) - the loop's
                // fetches and pre-flight checks share it.
                const outcome = await this._runLocalAgent(prompt, fileContent, rulesContext, sendAttachments, controller, planModeAtStart);
                this._endLiveMarkdown();
                // An empty completion (context overflow, degenerate round) must
                // read as an error, not finalize a silent empty bubble.
                if (outcome.resultEvent && !String(outcome.resultEvent.persian_explanation ?? '').trim() && outcome.events.length === 0) {
                    outcome.resultEvent = null;
                }
                if (outcome.resultEvent) {
                    this._displayAssistantResponse(outcome.resultEvent);
                    // A completed local run has ALWAYS resolved its approvals
                    // in-process (the generator resumes itself, unlike the cloud
                    // pause/resume protocol), so the turn is final - commit the
                    // full message sequence even when needsApprovalId was set.
                    // steerCarry turns re-enter with an ALREADY-ledgered user row
                    // (the carry loop below pushed it) - skip their own push.
                    if (!opts?.steerCarry) {
                        this._localHistory.push({ role: 'user', content: prompt });
                    }
                    for (const event of outcome.events) {
                        if (event.type === 'assistant_message') {
                            this._localHistory.push({
                                role: 'assistant',
                                content: event.content || '',
                                ...(event.tool_calls?.length ? { tool_calls: event.tool_calls } : {}),
                            });
                        } else if (event.type === 'tool_result') {
                            this._localHistory.push({ role: 'tool', tool_call_id: event.id, content: event.output });
                        } else if (event.type === 'steer_user') {
                            this._localHistory.push({ role: 'user', content: event.text });
                        }
                    }
                    outcome.events.push({ type: 'result', ...outcome.resultEvent });

                    // Commit the turn to the ledgers BEFORE persisting - a failed
                    // snapshot write (Windows AV locking local-sessions.json) must
                    // not silently drop the turn from the in-memory history too.
                    if (!opts?.steerCarry) {
                        this._history.push({ role: "user", content: prompt, cp: prePromptSha, attachments: attachmentMeta });
                    }
                    for (const event of outcome.events) {
                        if (event.type === 'steer_user') {
                            this._history.push({
                                role: 'user',
                                content: event.text,
                                ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                            });
                        }
                    }
                    this._history.push({ role: "assistant", events: outcome.events.map(trimDisplayEvent), content: JSON.stringify(outcome.resultEvent) });
                    await this._persistLocalSession().catch((e) => {
                        console.error('xratu: local session persist failed:', e);
                    });
                    // Steers typed while the model streamed its FINAL text never
                    // reached a round boundary - carry each as its own follow-up
                    // turn. The user row is ledgered HERE (steerCarry skips the
                    // nested turn's own push); the webview already rendered the
                    // bubble when it steered.
                    while (this._localSteerQueue.length > 0 && epoch === this._sessionEpoch) {
                        const carry = this._localSteerQueue.shift()!;
                        this._localHistory.push({ role: 'user', content: carry.text });
                        this._history.push({
                            role: 'user',
                            content: carry.text,
                            ...(carry.meta?.length ? { attachments: carry.meta } : {}),
                        });
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                        await this._handleChatRequest(carry.text, carry.carryAttachments, { steerCarry: true });
                    }
                } else if (outcome.aborted) {
                    // Cancelled mid-run: keep the partial turn in BOTH ledgers so
                    // the local model replays the tool/thinking context next turn,
                    // and edit/regenerate indexing stays aligned.
                    if (epoch === this._sessionEpoch) {
                        this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[cancelled by user]');
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                    }
                } else if (outcome.errorEvent) {
                    // Failed mid-run (provider 5xx, stream cut, malformed SSE, …):
                    // the turn was REAL - tool calls already ran, files may have
                    // changed, the task list may have been rewritten. Dropping it
                    // here is what caused "context lost after a red message": the
                    // next request replayed a history missing the entire turn, and
                    // the task list (derived from these history rows) vanished with
                    // it. Commit exactly like a cancel, placeholder-answer dangling
                    // tool calls, keep the pre-prompt checkpoint shas, and persist.
                    if (epoch === this._sessionEpoch) {
                        this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[interrupted by error]');
                        await this._persistLocalSession().catch((e) => {
                            console.error('xratu: local session persist failed:', e);
                        });
                    }
            } else if (outcome.noRun) {
                // Pre-run guard (no credential / insecure URL / no model): the
                // run never started, the guard already posted its own error, and
                // no provider ever saw the prompt - ledger nothing, stay quiet.
                // Steers queued while THIS turn was believed live belong to it
                // and drop; the queue is shared state, so anything below the
                // floor (a concurrent run's steers) is not ours to remove. The
                // loop never started, so no drain can have shifted the indices.
                if (this._localSteerQueue.length > steerQueueFloor) {
                    this._localSteerQueue.splice(steerQueueFloor);
                }
            } else {
                // Empty completion - no text, no events. Nothing streamed to
                // preserve, but the prompt itself must still join the ledger:
                // the webview rendered its user bubble, and a dropped row would
                // desync edit/regenerate indexing. Then surface the error.
                if (epoch === this._sessionEpoch) {
                    this._commitUnfinishedLocalTurn(prompt, attachmentMeta, prePromptSha, outcome, opts?.steerCarry, '[interrupted by error]');
                    await this._persistLocalSession().catch((e) => {
                        console.error('xratu: local session persist failed:', e);
                    });
                }
                this._localSteerQueue.length = 0;
                this._view?.webview.postMessage({ type: 'error', valueKey: 'localNoResponse' });
            }
            } finally {
                // Unconditional cleanup on EVERY exit - normal completion, the
                // pre-flight abort returns, AND a thrown preflight call (a
                // throw used to leak the flag and the 'chat' controller: every
                // later message steered into a queue nothing drained,
                // edit-resend bailed on the stale controller, session switch
                // stayed locked until reload). A session switch mid-run (epoch
                // bump) additionally drops queued steers - they belong to the
                // dead session. The run-active flag is NOT reset for steerCarry
                // turns: the carry loop that spawned them owns it, and a reset
                // here would let a steer arriving between carry turns start a
                // CONCURRENT second turn.
                if (epoch !== this._sessionEpoch) this._localSteerQueue.length = 0;
                if (!opts?.steerCarry) {
                    this._localRunActive = false;
                    this._settleLocalRun();
                }
                this._abortControllers.delete('chat');
            }
        return;
        } finally {
            // Unconditional cleanup for exits the inner finally cannot see:
            // early returns and throws in the pre-controller region (title
            // seed, attachment resolution, PDF extraction, project-tree I/O).
            // Idempotent - the inner finally performs the same bookkeeping
            // once the controller is registered.
            if (epoch !== this._sessionEpoch) this._localSteerQueue.length = 0;
            if (!opts?.steerCarry) {
                this._localRunActive = false;
                this._settleLocalRun();
            }
            this._abortControllers.delete('chat');
        }
}


    /** Ledger an UNFINISHED local turn (cancelled or errored mid-run): the
     *  user's prompt and everything the model streamed/executed stays in
     *  BOTH ledgers, so the next turn replays the full context (including
     *  any task-list writes - the checklist derives from these history
     *  rows). Dangling assistant tool_calls get placeholder results -
     *  providers reject a request whose assistant tool_calls are never
     *  answered. Steers that never reached a round boundary still render
     *  as user bubbles webview-side - ledger them here so edit/regenerate
     *  indexing stays aligned. */
    private _commitUnfinishedLocalTurn(
        prompt: string,
        attachmentMeta: AttachmentMeta[] | undefined,
        prePromptSha: string | undefined,
        outcome: StreamOutcome,
        steerCarry: boolean | undefined,
        toolPlaceholder: string,
    ): void {
        if (!steerCarry) {
            this._history.push({ role: 'user', content: prompt, cp: prePromptSha, attachments: attachmentMeta });
            this._localHistory.push({ role: 'user', content: prompt });
        }
        for (const event of outcome.events) {
            if (event.type === 'assistant_message') {
                this._localHistory.push({
                    role: 'assistant',
                    content: event.content || '',
                    ...(event.tool_calls?.length ? { tool_calls: event.tool_calls } : {}),
                });
            } else if (event.type === 'tool_result') {
                this._localHistory.push({ role: 'tool', tool_call_id: event.id, content: event.output });
            } else if (event.type === 'steer_user') {
                this._localHistory.push({ role: 'user', content: event.text });
                this._history.push({
                    role: 'user',
                    content: event.text,
                    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
                });
            }
        }
        // _history's display-ledger convention (matching the success path):
        // steer user rows BEFORE the assistant row, so a restored session
        // replays the steer bubbles above the partial answer and editing a
        // steered message truncates the partial turn with it.
        //
        // The replay ledger also needs the terminal state the live webview
        // got as transient messages: placeholder results for dangling
        // tool_calls (otherwise the restored pill spins forever) and a
        // terminal `result` marker (otherwise the cancel/error bubble
        // vanishes on reload). These are DISPLAY events only - the model
        // context is built from _localHistory.
        const displayEvents: any[] = outcome.events.map(trimDisplayEvent);
        const answered = new Set(
            outcome.events.filter((e) => e.type === 'tool_result').map((e) => e.id)
        );
        for (const event of outcome.events) {
            if (event.type === 'tool_call' && !answered.has(event.id)) {
                displayEvents.push({
                    type: 'tool_result',
                    id: event.id,
                    tool: event.tool,
                    output: toolPlaceholder,
                });
                answered.add(event.id);
            }
        }
        // Partial text streamed before the interruption lives only in
        // _localAccumulatedText (round events carry no display chunk rows) -
        // commit it as its own result so the replay keeps what the user saw.
        const partialText = this._localAccumulatedText.trim();
        if (partialText) {
            displayEvents.push({ type: 'result', persian_explanation: partialText });
        }
        displayEvents.push(outcome.errorEvent
            ? { type: 'result', error: outcome.errorEvent.error }
            : { type: 'result', error_key: outcome.aborted ? 'requestCancelled' : 'localNoResponse' });
        this._history.push({ role: 'assistant', events: displayEvents, content: '' });
        while (this._localSteerQueue.length > 0) {
            const carry = this._localSteerQueue.shift()!;
            this._localHistory.push({ role: 'user', content: carry.text });
            this._history.push({
                role: 'user',
                content: carry.text,
                ...(carry.meta?.length ? { attachments: carry.meta } : {}),
            });
        }
        const answeredLocal = new Set(
            this._localHistory.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
        );
        for (const m of this._localHistory) {
            for (const tc of m.tool_calls ?? []) {
                if (!answeredLocal.has(tc.id)) {
                    this._localHistory.push({ role: 'tool', tool_call_id: tc.id, content: toolPlaceholder });
                    answeredLocal.add(tc.id);
                }
            }
        }
    }

    private async _buildDiffPreview(toolName: string, args: any): Promise<ApprovalDiff | null> {
        const filePath: string = args.path || '';
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        let fullPath: string;
        try {
            fullPath = sanitizePath(filePath, workspaceRoot);
        } catch {
            return null;
        }
        try {
            const fileUri = vscode.Uri.file(fullPath);
            const stat = await vscode.workspace.fs.stat(fileUri).then((s) => s, () => null);
            let oldContent = '';
            let newContent: string;
            if (!stat && toolName === 'edit_file') {
                newContent = args.new_content || '';
            } else if (toolName === 'apply_patch') {
                // Simulate the SEARCH/REPLACE blocks in memory so the card
                // shows a real unified diff instead of raw markers.
                oldContent = stat ? (await vscode.workspace.openTextDocument(fileUri)).getText() : '';
                const patched = this._applyMarkerPatch(oldContent, String(args.patch ?? ''));
                if (patched === null) return null;
                newContent = patched;
            } else {
                const doc = await vscode.workspace.openTextDocument(fileUri);
                oldContent = doc.getText();
                newContent = toolName === 'edit_file'
                    ? (args.new_content || '')
                    : oldContent.replace(args.old_str ?? '', () => (args.new_str ?? ''));
            }
            const hunks = this._computeDiffHunks(oldContent, newContent);
            if (hunks === null) return null;
            const lines: string[] = [];
            let added = 0;
            let removed = 0;
            for (const h of hunks) {
                lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
                for (const l of h.removedLines) { lines.push('- ' + l); removed++; }
                for (const l of h.addedLines) { lines.push('+ ' + l); added++; }
            }
            return { file: filePath, added, removed, lines };
        } catch {
            return null;
        }
    }

    /** Apply <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks in-memory so
     *  approval cards show a real diff for apply_patch payloads. Returns
     *  null when no block matches (the preview degrades gracefully). */
    private _applyMarkerPatch(content: string, patch: string): string | null {
        const stdRe = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        const blocks: Array<{ search: string; replace: string }> = [];
        let m: RegExpExecArray | null;
        while ((m = stdRe.exec(patch)) !== null) {
            blocks.push({ search: m[1], replace: m[2] });
        }
        if (blocks.length === 0) return null;
        let out = content;
        for (const { search, replace } of blocks) {
            if (out.split(search).length - 1 === 1) {
                out = out.replace(search, () => replace);
                continue;
            }
            const sLines = search.split('\n');
            const cLines = out.split('\n');
            let at = -1;
            for (let i = 0; i <= cLines.length - sLines.length; i++) {
                let match = true;
                for (let j = 0; j < sLines.length; j++) {
                    if (cLines[i + j].trimEnd() !== sLines[j].trimEnd()) { match = false; break; }
                }
                if (match) { at = i; break; }
            }
            if (at < 0) return null;
            cLines.splice(at, sLines.length, ...replace.split('\n'));
            out = cLines.join('\n');
        }
        return out;
    }

    private async _processNeedsApproval(parsed: any) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
        const out: any[] = [];
        const closeItems: Array<{ tool_call_id: string; tool_name: string }> = [];
        const preDenied: Record<string, boolean> = {};

        for (const approval of parsed.approvals ?? []) {
            const toolName: string = approval.tool_name ?? 'unknown';
            let args = approval.args;
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { args = {}; }
            }
            approval.args = args;
            let diff: ApprovalDiff | null = null;
            // Only approvable items carry a kind - a pre-denied call must
            // never teach the session gate to auto-approve its kind later.
            // Null kind (shell-composed terminal commands) never records.
            const kind = sessionApprovalKind(toolName, args ?? {});

            if (toolName === 'edit_file' || toolName === 'replace_in_file' || toolName === 'apply_patch') {
                try {
                    sanitizePath(approval.args?.path || '', workspaceRoot);
                } catch {
                    preDenied[approval.tool_call_id] = false;
                    // Pre-denied calls still have an open timeline row from
                    // their streamed tool_call event - they need closing too.
                    closeItems.push({ tool_call_id: approval.tool_call_id, tool_name: toolName });
                    this._view?.webview.postMessage({ type: 'error', value: `Path is outside the workspace: ${approval.args?.path}` });
                    // Keep the item in the payload (flagged pre-denied) - the
                    // approval card renders it with a denied tag instead of
                    // showing an empty card.
                    out.push({ tool_call_id: approval.tool_call_id, tool_name: toolName, args: approval.args, diff: null });
                    continue;
                }
                diff = await this._buildDiffPreview(toolName, approval.args);
            }
            out.push({ tool_call_id: approval.tool_call_id, tool_name: toolName, args: approval.args, diff, kind });
        }

        closeItems.push(...out.map((a) => ({ tool_call_id: a.tool_call_id, tool_name: a.tool_name, kind: a.kind })));

        for (const auto of (parsed.auto ?? []) as any[]) {
            // Server-executed deferred calls (read_file & co.) shown as pills
            // during the run but resolved inside the resume without their own
            // streamed tool_result - mark them closable.
            closeItems.push({
                tool_call_id: String(auto.tool_call_id ?? ''),
                tool_name: auto.tool_name ?? 'tool'
            });
        }
        this._approvalCloseItems[parsed.approval_id] = closeItems;

        this._view?.webview.postMessage({
            type: 'needsApproval',
            approval_id: parsed.approval_id,
            approvals: out,
            preDenied
        });
    }

    private async _handleToolApproval(approvalId: string, toolDecisions: Record<string, boolean>, sessionApprove = false, _retryCount = 0): Promise<void> {
        if (_retryCount > 1) return;
        const epoch = this._sessionEpoch;
        const approvals = this._approvalCloseItems[approvalId] ?? [];

        const approvalsMap: Record<string, boolean> = {};
        Object.assign(approvalsMap, toolDecisions);

        // --- Local approval: resolve the pending promise, the local agent
        //     generator continues on its own (no cloud /chat/approve call).
        if (approvalId.startsWith('local-')) {
            // "Allow for this session": every approvable kind in this round
            // is trusted for the REST of the session (cleared on new session).
            if (sessionApprove) {
                for (const a of approvals) {
                    if (a.kind) this._sessionApprovedKinds.add(a.kind);
                }
            }
            this._resolveLocalApproval(approvalId, toolDecisions);
            delete this._approvalCloseItems[approvalId];
            const decisionValues = approvals.map((a) => toolDecisions[a.tool_call_id] === true);
            const acceptedCount = decisionValues.filter(Boolean).length;
            const resolution = acceptedCount === 0 ? 'rejected' : acceptedCount === decisionValues.length ? 'approved' : 'mixed';
            this._view?.webview.postMessage({ type: 'approvalResolved', approval_id: approvalId, resolution });
            return;
        }
    }

    private _computeDiffHunks(oldContent: string, newContent: string): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; removedLines: string[]; addedLines: string[] }> | null {
        // Trim the shared prefix/suffix first: a small edit inside a huge
        // file collapses to the changed region, keeping the LCS table tiny.
        let oldLines = oldContent.split('\n');
        let newLines = newContent.split('\n');
        let trimmed = 0;
        {
            let prefix = 0;
            while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
            let suffix = 0;
            while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
                oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
            if (prefix > 0 || suffix > 0) {
                trimmed = prefix;
                oldLines = oldLines.slice(prefix, oldLines.length - suffix);
                newLines = newLines.slice(prefix, newLines.length - suffix);
            }
        }
        const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; removedLines: string[]; addedLines: string[] }> = [];

        // Simple LCS-based diff
        const m = oldLines.length;
        const n = newLines.length;
        if (m * n > MAX_DIFF_LCS_CELLS) {
            return null;
        }
        const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (oldLines[i - 1] === newLines[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack to find diff regions
        const changes: Array<{ type: 'keep' | 'remove' | 'add'; oldIdx: number; newIdx: number }> = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                changes.unshift({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                changes.unshift({ type: 'add', oldIdx: i, newIdx: j - 1 });
                j--;
            } else {
                changes.unshift({ type: 'remove', oldIdx: i - 1, newIdx: j });
                i--;
            }
        }

        // Group consecutive changes into hunks (with 2 lines of context)
        const contextLines = 2;
        let hunkStart = 0;
        while (hunkStart < changes.length) {
            // Skip keep lines at the start
            while (hunkStart < changes.length && changes[hunkStart].type === 'keep') {
                hunkStart++;
            }
            if (hunkStart >= changes.length) break;

            // Find the end of this change group (with context)
            let hunkEnd = hunkStart;
            let lastChangeIdx = hunkStart;
            while (hunkEnd < changes.length) {
                if (changes[hunkEnd].type !== 'keep') {
                    lastChangeIdx = hunkEnd;
                }
                // Stop if we've gone past the last change by contextLines
                if (hunkEnd > lastChangeIdx + contextLines && hunkEnd < changes.length) {
                    // Check if there are more changes ahead
                    let hasMoreChanges = false;
                    for (let k = hunkEnd; k < changes.length; k++) {
                        if (changes[k].type !== 'keep') { hasMoreChanges = true; break; }
                    }
                    if (!hasMoreChanges) break;
                    // Include context and start a new hunk
                    hunkEnd = Math.min(hunkEnd + contextLines, changes.length);
                    break;
                }
                hunkEnd++;
            }

            // Extract the hunk
            const hunkChanges = changes.slice(hunkStart, hunkEnd);
            const removedLines: string[] = [];
            const addedLines: string[] = [];
            let oldStart = -1;
            let oldCount = 0;
            let newStart = -1;
            let newCount = 0;

            for (const c of hunkChanges) {
                if (c.type === 'remove') {
                    if (oldStart === -1) oldStart = c.oldIdx;
                    removedLines.push(oldLines[c.oldIdx]);
                    oldCount++;
                } else if (c.type === 'add') {
                    if (newStart === -1) newStart = c.newIdx;
                    addedLines.push(newLines[c.newIdx]);
                    newCount++;
                }
            }

            if (removedLines.length > 0 || addedLines.length > 0) {
                hunks.push({
                    oldStart: oldStart + 1 + trimmed,
                    oldCount,
                    newStart: (newStart >= 0 ? newStart : oldStart) + 1 + trimmed,
                    newCount,
                    removedLines,
                    addedLines,
                });
            }

            hunkStart = hunkEnd;
        }

        return hunks;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        const cspSource = webview.cspSource;

        // The React webview is built by Vite into a single self-contained
        // index.html (JS + CSS inlined).  We inject a strict CSP with a
        // per-load nonce and attach that nonce to the inlined module script.
        const csp = [
            "default-src 'none'",
            `style-src ${cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${cspSource} data:`,
            `font-src ${cspSource}`,
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ].join('; ');

        try {
            const fs = require('fs');
            const builtPath = path.join(
                this._extensionUri.fsPath,
                'dist',
                'webview-ui',
                'index.html'
            );
            let html = fs.readFileSync(builtPath, 'utf-8');

            // Inject the CSP into <head>.  If the bundle somehow already
            // ships a CSP meta, drop it in favour of ours.
            html = html.replace(
                /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i,
                ''
            );
            html = html.replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);

            // Attach the nonce to the inlined module script and strip any
            // crossorigin attribute that would break same-origin loading.
            html = html.replace(/<script([^>]*)>/i, (_m: string, attrs: string) => {
                const cleaned = attrs.replace(/\s+crossorigin/gi, '');
                return `<script${cleaned} nonce="${nonce}">`;
            });

            // Bake the persisted UI language into the page BEFORE the bundle
            // runs - the webview must never depend on a postMessage echo for
            // its first paint (the echo rides behind awaits on the
            // webviewReady path and is lost whenever that boot chain fails).
            const uiLocale = this._globalState.get<string>('xratu.locale') === 'en' ? 'en' : 'fa';
            html = html.replace(/<head>/i, `<head>\n<script nonce="${nonce}">window.XRATU_LOCALE=${JSON.stringify(uiLocale)};</script>`);

            return html;
        } catch (err) {
            console.error('Failed to load webview bundle:', err);
            return `<!DOCTYPE html><html><body><p>Webview build not found. Run: npm run compile</p></body></html>`;
        }
    }
}

/** First-run default skill: seed the bundled natural-farsi writing skill
 *  into the user's global cross-agent skills root (~/.agents/skills), the
 *  same location the Skills page already scans. The once-flag means the
 *  seed happens exactly once per install: an existing SKILL.md (user-
 *  authored or previously seeded) is never touched, and a deliberate
 *  deletion is never resurrected - disabling via the Skills page is the
 *  supported "off" switch. */
async function seedDefaultSkill(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>('xratu.skills.bundledSeeded')) return;
    if (vscode.workspace.isTrusted === false) return;
    const source = path.join(context.extensionPath, 'assets', 'skills', 'natural-farsi', SKILL_FILE);
    const skillMd = await fs.promises.readFile(source, 'utf-8');
    await ensureBundledSkill(path.join(os.homedir(), '.agents', 'skills'), 'natural-farsi', skillMd);
    await context.globalState.update('xratu.skills.bundledSeeded', true);
}

export function activate(context: vscode.ExtensionContext) {
    const checkpoints = new ShadowCheckpointStore(context);
    const mcpConfigStore = new McpConfigStore(context);
    const externalMcp = new ExternalMcpManager(() => mcpConfigStore.load());
    externalMcpInstance = externalMcp;
    mcpConfigStoreInstance = mcpConfigStore;

    // Ship with the DuckDuckGo search MCP active (first run only - the seed
    // is skipped as soon as the global config file exists). Fire-and-forget:
    // the manager reloads configs on demand, and failures must never block
    // activation.
    mcpConfigStore.seedDefaults().catch((e) =>
        console.error('xratu: MCP default-server seed failed:', e));

    // Ship with the natural-farsi writing skill (first run only). Lands in
    // the shared cross-agent skills root so it survives workspace switches.
    // A once-flag means a user who deletes it stays deleted; exclusive
    // create inside - an existing copy is never clobbered. Fire-and-forget:
    // the next skills scan picks the folder up, and failures must never
    // block activation.
    seedDefaultSkill(context).catch((e) =>
        console.error('xratu: default skill seed failed:', e));

    initShiki().catch(err => console.error('Shiki init failed:', err));

    const provider = new XratuChatViewProvider(context.extensionUri, context.secrets, checkpoints, context.globalState, context.globalStorageUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(XratuChatViewProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('xratu-diff', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('xratu.clearHistory', async () => {
            await provider.ensureView();
            await provider.clearHistory();
        }),
        vscode.commands.registerCommand('xratu.setLlmCredentials', async () => {
            await provider.setLlmCredentialsPublic();
        }),
        vscode.commands.registerCommand('xratu.openSettings', async () => {
            await provider.openSettingsPublic();
        }),
        vscode.commands.registerCommand('xratu.restoreCheckpoint', async () => {
            await provider.ensureView();
            await provider.restoreCheckpointFlow();
        }),
        vscode.commands.registerCommand('xratu.attachFile', async () => {
            // Drag-and-drop into a SIDEBAR webview view is impossible in VS
            // Code (the workbench makes webview iframes pointer-transparent
            // during drags and never re-dispatches DROP to them) - this native
            // file dialog is the reliable "attach from anywhere" path.
            const picks = await vscode.window.showOpenDialog({
                canSelectMany: true,
                canSelectFolders: false,
                openLabel: 'Attach to Xratu',
                title: 'Attach files to Xratu chat',
            });
            if (picks?.length) {
                await provider.attachUrisPublic(picks.map((u) => u.toString()));
            }
        }),
        vscode.commands.registerCommand('xratu.attachFromExplorer', async (uriOrContext: vscode.Uri | { selectedUri?: vscode.Uri } | undefined) => {
            // Explorer right-click → "Attach to Xratu". The menu passes the
            // selected resource URI.
            const uri = uriOrContext instanceof vscode.Uri
                ? uriOrContext
                : uriOrContext?.selectedUri;
            if (uri) {
                await provider.attachUrisPublic([uri.toString()]);
            }
        })
    );

    // Raw mcp.json edits (MCP page → "Edit raw JSON") apply live: reload the
    // manager and re-push page state. Editors fire several events per save -
    // debounce so one save is one reload. Only the files the config store
    // actually READS (global + first workspace folder) may trigger a reload;
    // the multi-root glob watcher alone would disconnect servers on edits to
    // folders the store ignores.
    const onMcpFileChanged = (() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let lastUri: vscode.Uri | null = null;
        const watchedPaths = (): string[] => {
            const store = mcpConfigStoreInstance;
            if (!store) return [];
            const paths = [store.globalPath];
            const ws = store.workspacePath;
            if (ws) paths.push(ws);
            return paths;
        };
        return (uri: vscode.Uri) => {
            lastUri = uri;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                const changed = lastUri?.fsPath;
                if (!changed || !watchedPaths().some((p) => sameMcpPath(p, changed))) return;
                void provider.reloadMcpFromDisk(changed).catch((e) =>
                    console.error('xratu: mcp config reload failed:', e));
            }, 500);
        };
    })();
    const mcpWatchers = [
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(mcpConfigStore.globalPath)),
            path.basename(mcpConfigStore.globalPath)
        )),
        vscode.workspace.createFileSystemWatcher('**/.xratu/mcp.json'),
    ];
    for (const w of mcpWatchers) {
        context.subscriptions.push(w);
        w.onDidChange(onMcpFileChanged);
        w.onDidCreate(onMcpFileChanged);
        w.onDidDelete(onMcpFileChanged);
    }

    // Trust transitions re-resolve the effective config. Entering restricted
    // mode forces a window reload (so the filtered load() applies fresh);
    // onDidGrantWorkspaceTrust is the one in-session transition and may
    // newly connect workspace-sourced servers.
    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            void provider.reloadMcpFromDisk().catch((e) =>
                console.error('xratu: mcp trust-transition reload failed:', e));
            // Activation skipped the default-skill seed in Restricted Mode -
            // this transition is its only second chance in this window.
            void seedDefaultSkill(context).catch((e) =>
                console.error('xratu: default skill trust-transition seed failed:', e));
        })
    );
}

export function deactivate() {
    // External stdio MCP servers are child processes - without this they
    // outlive extension-host reloads until the process dies on its own.
    void externalMcpInstance?.stopAll();
    externalMcpInstance = null;
    mcpConfigStoreInstance = null;
}

/**
 * Host-side markdown rendering: the Shiki highlighter, the language/alias
 * tables, fence rendering, and the two MarkdownIt instances (final + live
 * streaming twin). Split out of extension.ts; it reads the active VS Code
 * color theme for the highlighter and stays the source test-shiki-langs.mjs
 * greps for the bundled language list.
 */

import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import { escapeHtml } from './sanitizeHtml';
import { ui } from './uiStrings';

let shikiHighlighter: Awaited<ReturnType<typeof createHighlighter>> | null = null;

/**
 * Grammars bundled into the host highlighter.
 *
 * The list is deliberately broad, because a fence tagged with a language that
 * is NOT loaded makes `codeToHtml` THROW, and every throw fell through the
 * silent catch in `highlightCode` into the plain monochrome fallback. With the
 * original twelve names, `tsx`, `jsx`, `go`, `rust`, `c`, `cpp`, `java`,
 * `kotlin`, `swift`, `toml`, `dockerfile`, `scss` and `vue` - all everyday
 * fences - rendered as unstyled text with no error reported anywhere.
 *
 * Shiki resolves each canonical name together with its aliases, so loading
 * `typescript` also covers `ts`, `csharp` covers `c#`/`cs`, and so on.
 *
 * Every name here must be a real bundled grammar: a single unknown entry makes
 * `createHighlighter` reject, which is the very failure being fixed here. A
 * name is only added after being checked against `createHighlighter` - which
 * is why `env` and `gitignore`, despite looking plausible, are absent.
 */
const SHIKI_LANGS = [
    'javascript', 'typescript', 'tsx', 'jsx',
    'python', 'java', 'c', 'cpp', 'csharp', 'objective-c', 'vb',
    'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'scala',
    'dart', 'lua', 'r', 'perl', 'haskell', 'elixir', 'clojure', 'zig',
    'sql', 'bash', 'powershell', 'cmd', 'bat',
    'json', 'yaml', 'toml', 'ini', 'csv',
    'html', 'css', 'scss', 'markdown', 'xml', 'diff',
    'dockerfile', 'makefile', 'cmake', 'graphql', 'nginx', 'vue',
    'latex', 'plaintext',
] as const;

/** Every loaded id and alias, so `highlightCode` can check membership in O(1)
 *  instead of letting an unknown language throw. */
let shikiLoadedLangs: Set<string> | null = null;

/** A highlighting failure is reported once, not once per code block. */
let shikiWarned = false;

async function initShiki() {
    shikiHighlighter = await createHighlighter({
        themes: ['github-dark', 'github-light'],
        langs: [...SHIKI_LANGS],
    });
    shikiLoadedLangs = new Set(shikiHighlighter.getLoadedLanguages());
}

/**
 * Initialise the highlighter, retrying once.
 *
 * `shikiHighlighter` gates every fence: while it is null `highlightCode`
 * emits the plain fallback, and nothing re-renders those blocks afterwards.
 * A single failed init therefore silently discoloured every code block for the
 * rest of the session - which is the whole of the reported "shiki is not
 * working" symptom, and it cleared only because the extension was reloaded.
 * Retrying costs one extra startup pass and downgrades a permanently broken
 * session to a briefly delayed one.
 */
export async function ensureShiki(): Promise<void> {
    if (shikiHighlighter) return;
    try {
        await initShiki();
    } catch (err) {
        console.error('xratu: shiki init failed, retrying once:', err);
        try {
            await initShiki();
        } catch (retryErr) {
            console.error('xratu: shiki unavailable; code will render unhighlighted:', retryErr);
        }
    }
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
        jsx: 'jsx',
        ts: 'typescript',
        tsx: 'tsx',
        py: 'python',
        sh: 'bash',
        shell: 'bash',
        zsh: 'bash',
        yml: 'yaml',
        md: 'markdown',
        rs: 'rust',
        // 'c#' is an alias shiki resolves, but the canonical name keeps the
        // loaded-languages membership check predictable.
        cs: 'csharp',
        'c++': 'cpp',
        htm: 'html',
        dockerfile: 'dockerfile',
    };
    return aliases[normalized] ?? normalized;
}

function highlightCode(str: string, lang: string, live: boolean): string {
    // Fallback MUST emit a <pre><code> shell like shiki does - renderFence
    // inserts the result straight into .code-surface, and bare text there
    // collapses newlines (no white-space: pre on the surface div).
    if (live || !lang || !shikiHighlighter) return `<pre><code>${escapeHtml(str)}</code></pre>`;
    // Guard the language rather than letting `codeToHtml` throw on it. Shiki's
    // own `fallbackLanguage` does not cover a grammar that is not loaded at
    // all - it still throws - so membership is checked here and an unknown
    // fence falls back to the plaintext grammar, which still yields a themed
    // block instead of bare text.
    const resolved = shikiLoadedLangs?.has(lang) ? lang : 'plaintext';
    try {
        const theme = vscode.window.activeColorTheme?.kind === vscode.ColorThemeKind.Light
            ? 'github-light' : 'github-dark';
        return shikiHighlighter.codeToHtml(str, { lang: resolved, theme });
    } catch (err) {
        // This catch used to be empty, which is why an entire session could
        // render monochrome with nothing in any log to explain it.
        if (!shikiWarned) {
            shikiWarned = true;
            console.error(`xratu: shiki failed for lang "${lang}"; rendering plain text:`, err);
        }
        return `<pre><code>${escapeHtml(str)}</code></pre>`;
    }
}

export function closeOpenFence(text: string): string {
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

export const md = new MarkdownIt({
    html: false,
    linkify: true,
    // Single newlines inside a paragraph become <br> - chat models routinely
    // break lines without blank lines, which would otherwise merge into one.
    breaks: true,
});

configureMarkdownRenderer(md.renderer, false);

// Streaming twin: identical DOM structure, but skips Shiki so the webview does
// not replace code-block structure when the final highlighted response arrives.
export const mdLive = new MarkdownIt({ html: false, linkify: true, breaks: true });
configureMarkdownRenderer(mdLive.renderer, true);

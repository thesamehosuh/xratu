/**
 * Shiki highlighting for the webview's code and diff surfaces.
 *
 * Extracted from `MessageItem.tsx` so the approval card's diff view and the
 * transcript's code pills share ONE highlighter, ONE cache and ONE theme
 * observer. Uses `shiki/core` + the pure-JS regex engine with only the two
 * GitHub themes and curated coding grammars so the single-file webview bundle
 * avoids shipping 200+ unused grammars, 60 themes, and the unused WASM binary.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import githubDark from '@shikijs/themes/github-dark';
import githubLight from '@shikijs/themes/github-light';

/** Pure-JS regex engine: the webview CSP has no 'wasm-unsafe-eval', so the
 *  default oniguruma (WASM) engine silently fails and every highlighted
 *  block fell back to white text. `forgiving` skips the few grammars whose
 *  patterns the JS engine can't express - display-only highlighting. */
const SHIKI_ENGINE = createJavaScriptRegexEngine({ forgiving: true });

/** Match the host code blocks: same github pair, picked from the VS Code
 *  theme the webview is rendered under (body carries vscode-light/-dark). */
const SHIKI_DARK_THEME = 'github-dark';
const SHIKI_LIGHT_THEME = 'github-light';

type LangModule = { default: LanguageRegistration[] };

const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
    bash: () => import('@shikijs/langs/bash'),
    bat: () => import('@shikijs/langs/bat'),
    c: () => import('@shikijs/langs/c'),
    cmake: () => import('@shikijs/langs/cmake'),
    cpp: () => import('@shikijs/langs/cpp'),
    csharp: () => import('@shikijs/langs/csharp'),
    css: () => import('@shikijs/langs/css'),
    dart: () => import('@shikijs/langs/dart'),
    diff: () => import('@shikijs/langs/diff'),
    dockerfile: () => import('@shikijs/langs/dockerfile'),
    elixir: () => import('@shikijs/langs/elixir'),
    go: () => import('@shikijs/langs/go'),
    graphql: () => import('@shikijs/langs/graphql'),
    haskell: () => import('@shikijs/langs/haskell'),
    html: () => import('@shikijs/langs/html'),
    ini: () => import('@shikijs/langs/ini'),
    java: () => import('@shikijs/langs/java'),
    javascript: () => import('@shikijs/langs/javascript'),
    json: () => import('@shikijs/langs/json'),
    jsx: () => import('@shikijs/langs/jsx'),
    kotlin: () => import('@shikijs/langs/kotlin'),
    lua: () => import('@shikijs/langs/lua'),
    makefile: () => import('@shikijs/langs/makefile'),
    markdown: () => import('@shikijs/langs/markdown'),
    nginx: () => import('@shikijs/langs/nginx'),
    perl: () => import('@shikijs/langs/perl'),
    php: () => import('@shikijs/langs/php'),
    powershell: () => import('@shikijs/langs/powershell'),
    python: () => import('@shikijs/langs/python'),
    r: () => import('@shikijs/langs/r'),
    ruby: () => import('@shikijs/langs/ruby'),
    rust: () => import('@shikijs/langs/rust'),
    scala: () => import('@shikijs/langs/scala'),
    scss: () => import('@shikijs/langs/scss'),
    sql: () => import('@shikijs/langs/sql'),
    svelte: () => import('@shikijs/langs/svelte'),
    swift: () => import('@shikijs/langs/swift'),
    toml: () => import('@shikijs/langs/toml'),
    tsx: () => import('@shikijs/langs/tsx'),
    typescript: () => import('@shikijs/langs/typescript'),
    vue: () => import('@shikijs/langs/vue'),
    xml: () => import('@shikijs/langs/xml'),
    yaml: () => import('@shikijs/langs/yaml'),
    zig: () => import('@shikijs/langs/zig'),
};

const LANG_ALIASES: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    cs: 'csharp',
    'c#': 'csharp',
    'c++': 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hpp: 'cpp',
    md: 'markdown',
    ps1: 'powershell',
    pwsh: 'powershell',
    cmd: 'bat',
    batch: 'bat',
    docker: 'dockerfile',
    kt: 'kotlin',
    rb: 'ruby',
    gql: 'graphql',
    jsonc: 'json',
    hs: 'haskell',
    ex: 'elixir',
    pl: 'perl',
    make: 'makefile',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const pendingLangs = new Map<string, Promise<void>>();

function resolveLang(lang: string): string | null {
    const normalized = lang.trim().toLowerCase();
    if (!normalized || normalized === 'text' || normalized === 'plaintext' || normalized === 'plain') return null;
    const canonical = LANG_ALIASES[normalized] ?? normalized;
    return canonical in LANG_LOADERS ? canonical : null;
}

function getHighlighter(): Promise<HighlighterCore> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighterCore({
            themes: [githubDark, githubLight],
            langs: [],
            engine: SHIKI_ENGINE,
        });
    }
    return highlighterPromise;
}

async function ensureLang(highlighter: HighlighterCore, canonical: string): Promise<void> {
    if (loadedLangs.has(canonical)) return;
    let pending = pendingLangs.get(canonical);
    if (!pending) {
        pending = LANG_LOADERS[canonical]()
            .then((mod) => highlighter.loadLanguage(mod.default))
            .then(() => { loadedLangs.add(canonical); })
            .finally(() => { pendingLangs.delete(canonical); });
        pendingLangs.set(canonical, pending);
    }
    await pending;
}

function currentShikiTheme(): string {
    if (typeof document === 'undefined') return SHIKI_DARK_THEME;
    if (document.querySelector('.app')?.getAttribute('data-color-scheme') === 'dark') return SHIKI_DARK_THEME;
    return document.body?.classList.contains('vscode-light') ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

function themeSnapshot(): string {
    const forced = typeof document !== 'undefined' && document.querySelector('.app')?.getAttribute('data-color-scheme') === 'dark';
    return `${currentShikiTheme()}:${forced ? 'dark' : 'editor'}`;
}

// One shared observer watches the editor theme and app override, so switching
// either re-highlights already-rendered pills
// instead of leaving stale token colors until the webview is recreated.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
let lastTheme = themeSnapshot();

function onBodyClassMutation(): void {
    const next = themeSnapshot();
    if (next === lastTheme) return;
    lastTheme = next;
    for (const listener of themeListeners) listener();
}

function subscribeTheme(callback: () => void): () => void {
    if (typeof document !== 'undefined') {
        if (!themeObserver) {
            lastTheme = themeSnapshot();
            themeObserver = new MutationObserver(onBodyClassMutation);
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
            const app = document.querySelector('.app');
            if (app) themeObserver.observe(app, { attributes: true, attributeFilter: ['data-color-scheme'] });
        }
        themeListeners.add(callback);
    }
    return () => {
        themeListeners.delete(callback);
        if (!themeListeners.size) { themeObserver?.disconnect(); themeObserver = null; }
    };
}

/** Reactive VS Code code-block theme for the webview. */
export function useShikiTheme(): string {
    return useSyncExternalStore(subscribeTheme, themeSnapshot, themeSnapshot).split(':')[0];
}

/** Memo of Shiki output per (theme, lang, code). Highlighting is async and
 *  expensive; without a cache every diff block in a run re-highlights on
 *  mount, and again on every theme/code change - a run ending in several
 *  6KB apply_patch pills used to fire dozens of codeToHtml passes at once
 *  (freeze, then a line-by-line raw->highlighted flash as each landed). */
const HIGHLIGHT_CACHE = new Map<string, string[]>();
const HIGHLIGHT_CACHE_MAX = 150;
/** Above this, skip highlighting entirely (escaped raw lines instead): the
 *  tokenizer cost is not worth it for huge clipped blocks. */
const HIGHLIGHT_MAX_CHARS = 24_000;

function cacheKey(theme: string, lang: string, code: string): string {
    return `${theme}\u0000${lang}\u0000${code}`;
}

export async function highlightedLines(code: string, lang: string, theme: string): Promise<string[]> {
    const canonical = resolveLang(lang);
    if (!code || !canonical || code.length > HIGHLIGHT_MAX_CHARS) return [];
    const key = cacheKey(theme, canonical, code);
    const hit = HIGHLIGHT_CACHE.get(key);
    if (hit) return hit;
    try {
        const highlighter = await getHighlighter();
        await ensureLang(highlighter, canonical);
        const html = highlighter.codeToHtml(code, { lang: canonical, theme });
        const match = html.match(/<code>([\s\S]*?)<\/code>/);
        if (!match) return [];
        const lines = match[1].replace(/<span class="line">/g, '').replace(/<\/span>\s*(?=<span class="line">|$)/g, '').split('\n');
        if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_MAX) {
            const keys = Array.from(HIGHLIGHT_CACHE.keys());
            for (const old of keys.slice(0, Math.floor(keys.length / 2))) HIGHLIGHT_CACHE.delete(old);
        }
        HIGHLIGHT_CACHE.set(key, lines);
        return lines;
    } catch {
        return [];
    }
}

export function useHighlightedCode(code: string, lang: string): string[] {
    const theme = useShikiTheme();
    const canonical = resolveLang(lang) ?? '';
    const key = cacheKey(theme, canonical, code);
    const [highlighted, setHighlighted] = useState(() => ({ key, lines: HIGHLIGHT_CACHE.get(key) ?? [] }));
    useEffect(() => {
        if (!code || !canonical || code.length > HIGHLIGHT_MAX_CHARS) {
            setHighlighted({ key, lines: [] });
            return;
        }
        const hit = HIGHLIGHT_CACHE.get(key);
        if (hit) {
            setHighlighted({ key, lines: hit });
            return;
        }
        let cancelled = false;
        highlightedLines(code, canonical, theme).then((lines) => {
            if (cancelled) return;
            setHighlighted({ key, lines });
        }).catch(() => {
            if (!cancelled) setHighlighted({ key, lines: [] });
        });
        return () => { cancelled = true; };
    }, [code, canonical, theme, key]);
    return highlighted.key === key ? highlighted.lines : HIGHLIGHT_CACHE.get(key) ?? [];
}

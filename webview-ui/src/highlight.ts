/**
 * Shiki highlighting for the webview's code and diff surfaces.
 *
 * Extracted from `MessageItem.tsx` so the approval card's diff view and the
 * transcript's code pills share ONE highlighter, ONE cache and ONE theme
 * observer. Two highlighter instances meant two caches and two observer
 * lifecycles; the card's cache missed every hit the transcript had already
 * paid for, so opening an approval re-tokenized the same file.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createJavaScriptRegexEngine, getSingletonHighlighter } from 'shiki';

/** Pure-JS regex engine: the webview CSP has no 'wasm-unsafe-eval', so the
 *  default oniguruma (WASM) engine silently fails and every highlighted
 *  block fell back to white text. `forgiving` skips the few grammars whose
 *  patterns the JS engine can't express - display-only highlighting. */
const SHIKI_ENGINE = createJavaScriptRegexEngine({ forgiving: true });

/** Match the host code blocks: same github pair, picked from the VS Code
 *  theme the webview is rendered under (body carries vscode-light/-dark). */
const SHIKI_DARK_THEME = 'github-dark';
const SHIKI_LIGHT_THEME = 'github-light';

function currentShikiTheme(): string {
    if (typeof document === 'undefined') return SHIKI_DARK_THEME;
    return document.body?.classList.contains('vscode-light') ? SHIKI_LIGHT_THEME : SHIKI_DARK_THEME;
}

// One shared observer watches the body theme class and notifies every mounted
// code block, so switching VS Code themes re-highlights already-rendered pills
// instead of leaving stale token colors until the webview is recreated.
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
let lastTheme = currentShikiTheme();

function onBodyClassMutation(): void {
    const next = currentShikiTheme();
    if (next === lastTheme) return;
    lastTheme = next;
    for (const listener of themeListeners) listener();
}

function subscribeTheme(callback: () => void): () => void {
    if (typeof document !== 'undefined') {
        if (!themeObserver) {
            themeObserver = new MutationObserver(onBodyClassMutation);
            themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
        themeListeners.add(callback);
    }
    return () => {
        themeListeners.delete(callback);
    };
}

/** Reactive VS Code code-block theme for the webview. */
export function useShikiTheme(): string {
    return useSyncExternalStore(subscribeTheme, currentShikiTheme, currentShikiTheme);
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

export function useHighlightedCode(code: string, lang: string): string[] {
    const theme = useShikiTheme();
    const [highlighted, setHighlighted] = useState<string[]>(() =>
        (code && lang !== 'text' ? HIGHLIGHT_CACHE.get(cacheKey(theme, lang, code)) : undefined) ?? [],
    );
    useEffect(() => {
        if (!code || lang === 'text' || code.length > HIGHLIGHT_MAX_CHARS) {
            setHighlighted([]);
            return;
        }
        const key = cacheKey(theme, lang, code);
        const hit = HIGHLIGHT_CACHE.get(key);
        if (hit) {
            setHighlighted(hit);
            return;
        }
        let cancelled = false;
        getSingletonHighlighter({
            themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
            langs: [lang === 'text' ? 'plaintext' : lang],
            engine: SHIKI_ENGINE,
        }).then((h) => {
            if (cancelled) return;
            const html = h.codeToHtml(code, { lang, theme });
            const match = html.match(/<code>([\s\S]*?)<\/code>/);
            if (!match) {
                setHighlighted([]);
                return;
            }
            const inner = match[1]
                .replace(/<span class="line">/g, '')
                .replace(/<\/span>\s*(?=<span class="line">|$)/g, '');
            const lines = inner.split('\n');
            if (HIGHLIGHT_CACHE.size >= HIGHLIGHT_CACHE_MAX) {
                // Cheap LRU-ish trim: drop the oldest half.
                const keys = Array.from(HIGHLIGHT_CACHE.keys());
                for (const k of keys.slice(0, Math.floor(keys.length / 2))) HIGHLIGHT_CACHE.delete(k);
            }
            HIGHLIGHT_CACHE.set(key, lines);
            setHighlighted(lines);
        }).catch(() => {
            if (!cancelled) setHighlighted([]);
        });
        return () => { cancelled = true; };
    }, [code, lang, theme]);
    return highlighted;
}
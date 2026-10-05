/**
 * VS Code "Dark Modern" theme tokens for standalone webview inspection.
 *
 * The built webview paints almost every surface through `--vscode-*` custom
 * properties that VS Code injects at runtime. A plain browser has NONE of
 * them, so a hand-rolled injection is easy to get wrong: injecting before
 * `document.documentElement` exists silently drops every token and the whole
 * UI renders transparent (no bubble fill, no borders, no `color-mix`
 * surfaces) while still LOOKING plausible against a dark canvas. Any
 * screenshot-based review taken in that state is worthless.
 *
 * `installVscodeTheme(page)` applies the tokens after the document exists and
 * is the ONLY supported way to theme the standalone page. Use it in specs and
 * in manual inspection instead of hand-writing the token block.
 */
import type { Page } from '@playwright/test';

/** Dark Modern defaults for every `--vscode-*` token the webview reads. */
export const VSCODE_DARK_TOKENS: Record<string, string> = {
    '--vscode-button-secondaryBackground': '#313131',
    '--vscode-button-secondaryForeground': '#cccccc',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
    '--vscode-editor-foreground': '#cccccc',
    '--vscode-editorWarning-foreground': '#cca700',
    '--vscode-editorWidget-background': '#202020',
    '--vscode-errorForeground': '#f85149',
    '--vscode-font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
    '--vscode-foreground': '#cccccc',
    /* Diff colours resolve through the gitDecoration family in every stock
     * theme. Without them here a diff falls back to `currentColor` and add/del
     * become indistinguishable - a screenshot that looks fine and proves
     * nothing, which is the same trap as missing surfaces. */
    '--vscode-gitDecoration-addedResourceForeground': '#4bf3c8',
    '--vscode-gitDecoration-deletedResourceForeground': '#f4587e',
    '--vscode-input-background': '#313131',
    '--vscode-input-border': '#3c3c3c',
    '--vscode-input-foreground': '#cccccc',
    '--vscode-input-placeholderForeground': '#989898',
    '--vscode-inputValidation-errorBackground': '#5a1d1d',
    '--vscode-list-hoverBackground': '#2a2d2e',
    '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    '--vscode-scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    '--vscode-sideBar-background': '#181818',
    '--vscode-textBlockQuote-background': '#2b2b2b',
    '--vscode-textLink-foreground': '#4daafc',
    '--vscode-textPreformat-foreground': '#d0d0d0',
    '--vscode-widget-border': '#454545',
};

/** The token block as a `:root{}` stylesheet. */
export const VSCODE_DARK_THEME_CSS = ':root{'
    + Object.entries(VSCODE_DARK_TOKENS).map(([name, value]) => `${name}:${value};`).join('')
    + '}';

/** Light Modern defaults for every `--vscode-*` token the webview reads. */
export const VSCODE_LIGHT_TOKENS: Record<string, string> = {
    '--vscode-button-secondaryBackground': '#e5e5e5',
    '--vscode-button-secondaryForeground': '#3b3b3b',
    '--vscode-descriptionForeground': '#616161',
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-font-family': 'Consolas, "Courier New", monospace',
    '--vscode-editor-foreground': '#000000',
    '--vscode-editorWarning-foreground': '#bf8803',
    '--vscode-editorWidget-background': '#f3f3f3',
    '--vscode-errorForeground': '#e51400',
    '--vscode-font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
    '--vscode-foreground': '#3b3b3b',
    '--vscode-gitDecoration-addedResourceForeground': '#1a7f37',
    '--vscode-gitDecoration-deletedResourceForeground': '#cf222e',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-border': '#cecece',
    '--vscode-input-foreground': '#3b3b3b',
    '--vscode-input-placeholderForeground': '#767676',
    '--vscode-inputValidation-errorBackground': '#f2dede',
    '--vscode-list-hoverBackground': '#e8e8e8',
    '--vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    '--vscode-scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    '--vscode-sideBar-background': '#f8f8f8',
    '--vscode-textBlockQuote-background': '#f2f2f2',
    '--vscode-textLink-foreground': '#005fb8',
    '--vscode-textPreformat-foreground': '#000000',
    '--vscode-widget-border': '#e5e5e5',
};

/** The token block as a `:root{}` stylesheet. */
export const VSCODE_LIGHT_THEME_CSS = ':root{'
    + Object.entries(VSCODE_LIGHT_TOKENS).map(([name, value]) => `${name}:${value};`).join('')
    + '}';

/**
 * Install theme tokens into a standalone webview page and mark the body as
 * dark or light (the webview's Shiki highlighter picks its theme from the
 * `vscode-dark` / `vscode-light` body class).
 *
 * Call BEFORE `page.goto`. Safe to call once per page; the injected style is
 * idempotent. A light install MUST go through here too: the `vscode-light`
 * block in `theme.css` remaps the `--xratu-*` surfaces, and hand-rolling only
 * the `:root` tokens leaves a light body class off, which silently changes
 * which elevation mix every surface resolves to.
 */
export async function installVscodeTheme(page: Page, mode: 'dark' | 'light' = 'dark'): Promise<void> {
    const css = mode === 'light' ? VSCODE_LIGHT_THEME_CSS : VSCODE_DARK_THEME_CSS;
    await page.emulateMedia({ colorScheme: mode });
    await page.addInitScript(({ css, bodyClass }) => {
        const apply = () => {
            // `document.head` is absent while the initial document is still
            // parsing, so fall back to documentElement; a later
            // DOMContentLoaded pass adds the body class and guarantees the
            // style is present even when the first pass ran too early.
            const target = document.head || document.documentElement;
            if (target && !document.getElementById('xratu-vscode-theme')) {
                const style = document.createElement('style');
                style.id = 'xratu-vscode-theme';
                style.textContent = css;
                target.appendChild(style);
            }
            document.body?.classList.add(bodyClass);
        };
        apply();
        document.addEventListener('DOMContentLoaded', apply);
    }, { css, bodyClass: mode === 'light' ? 'vscode-light' : 'vscode-dark' });
}

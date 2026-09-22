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

/**
 * Install the Dark Modern tokens into a standalone webview page and mark the
 * body as dark (the webview's Shiki highlighter picks its theme from the
 * `vscode-dark` / `vscode-light` body class).
 *
 * Call BEFORE `page.goto`. Safe to call once per page; the injected style is
 * idempotent.
 */
export async function installVscodeTheme(page: Page): Promise<void> {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript((css) => {
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
            document.body?.classList.add('vscode-dark');
        };
        apply();
        document.addEventListener('DOMContentLoaded', apply);
    }, VSCODE_DARK_THEME_CSS);
}

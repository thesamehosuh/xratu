import { expect, test } from '@playwright/test';
import { installVscodeTheme, VSCODE_DARK_TOKENS } from './vscodeTheme';

/**
 * Regression guard for the standalone-inspection fixture. Without the tokens
 * every surface renders transparent (no bubble fill, no borders, no
 * `color-mix` surfaces) while still looking plausible on a dark canvas - the
 * exact trap that makes screenshot-based reviews meaningless.
 */
test('installVscodeTheme resolves the tokens the webview paints with', async ({ page }) => {
    await page.addInitScript(() => {
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: () => undefined,
            getState: () => undefined,
            setState: (state: unknown) => state,
        });
    });
    await installVscodeTheme(page);
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();

    const probe = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
            editorBg: root.getPropertyValue('--vscode-editor-background').trim(),
            shell: root.getPropertyValue('--xratu-shell').trim(),
            bubble: root.getPropertyValue('--xratu-bubble').trim(),
            dark: document.body.classList.contains('vscode-dark'),
            styleTag: !!document.getElementById('xratu-vscode-theme'),
        };
    });
    expect(probe.editorBg).toBe(VSCODE_DARK_TOKENS['--vscode-editor-background']);
    expect(probe.shell).toBe(VSCODE_DARK_TOKENS['--vscode-sideBar-background']);
    expect(probe.bubble).toContain('color-mix');
    expect(probe.dark).toBe(true);
    expect(probe.styleTag).toBe(true);

    // A real bubble must paint an opaque background: transparent is the
    // symptom of missing tokens.
    await page.evaluate(() => window.postMessage({ type: 'showChat' }, '*'));
    await page.evaluate(() => window.postMessage({ type: 'restoreUser', value: 'hello' }, '*'));
    const bg = await page.locator('article.msg.user').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
});

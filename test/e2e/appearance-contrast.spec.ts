import { expect, test } from '@playwright/test';
import { installVscodeTheme, VSCODE_DARK_TOKENS, VSCODE_LIGHT_TOKENS } from './vscodeTheme';
import { openPageNavigation } from './navigation';

for (const editor of ['light', 'dark'] as const) for (const scheme of ['editor', 'dark'] as const) {
    test(`contrast tracks the active theme with VS Code body tokens (${editor}, ${scheme})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(tokens => {
            document.addEventListener('DOMContentLoaded', () => {
                document.getElementById('xratu-vscode-theme')?.remove();
                for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty(name, value);
            });
        }, editor === 'light' ? VSCODE_LIGHT_TOKENS : VSCODE_DARK_TOKENS);
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => state = next, postMessage: () => {} }) });
        });
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        if (scheme === 'dark') {
            await page.locator('#appearance-scheme').click();
            await page.locator('#appearance-scheme').locator('..').getByRole('option').nth(1).click();
        }
        const active = editor === 'light' && scheme === 'editor' ? 'light' : 'dark';
        const app = page.locator('.appearance-page');
        const ink = () => app.evaluate(el => getComputedStyle(el).color);
        const baseline = await ink();
        await page.locator(`#appearance-${active === 'light' ? 'dark' : 'light'}Contrast`).press('End');
        expect(await ink()).toBe(baseline);
        const slider = page.locator(`#appearance-${active}Contrast`);
        await slider.focus();
        for (let i = 0; i < 50; i++) await slider.press('ArrowRight');
        await expect(slider).toHaveValue('50');
        // A midpoint must be interpolated from the actual editor foreground,
        // not from a hard-coded fallback or the other theme's foreground.
        const expected = active === 'light' ? 'color(srgb 0.115686 0.115686 0.115686)' : scheme === 'dark' ? 'color(srgb 0.915686 0.915686 0.915686)' : 'color(srgb 0.9 0.9 0.9)';
        await expect(app).toHaveCSS('color', expected);
        await slider.press('End');
        await expect(app).toHaveCSS('color', active === 'light' ? 'color(srgb 0 0 0)' : 'color(srgb 1 1 1)');
    });
}

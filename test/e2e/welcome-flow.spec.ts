import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
const post = (page: Page, message: Record<string, unknown>) => page.evaluate(msg => window.postMessage(msg, '*'), message);
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        Object.assign(window, { __xratuHostMessages: sent, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => sent.push(m), getState: () => undefined, setState: () => {} }) });
    });
    await page.goto('/');
});
for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`welcome scans, connects and opens provider setup (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 760 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showWelcome' });
        await expect(page.locator('.welcome')).toBeVisible();
        await expect(page.locator('.composer-input')).toHaveCount(0);
        await post(page, { type: 'localModelsDiscovered', runtimes: [{ id: 'ollama', runtime: 'ollama', name: 'Ollama', modelCount: 1, supportsTools: true, supportsVision: false, baseUrl: 'http://127.0.0.1:11434/v1', models: ['coder'] }] });
        await expect(page.locator('.welcome-runtime')).toContainText('Ollama');
        await page.locator('.welcome-runtime button').click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages)).toContainEqual({ type: 'saveLlmCredentials', base_url: 'http://127.0.0.1:11434/v1', api_key: '', returnToChat: true });
        await post(page, { type: 'credentialsSaved', returnToChat: true });
        await expect(page.locator('.composer-input')).toBeVisible();
        await post(page, { type: 'showWelcome' });
        await page.locator('.welcome-cta').click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages)).toContainEqual({ type: 'openCredentials' });
        await post(page, { type: 'openCredentials' });
        await expect(page.locator('.cred-page')).toBeVisible();
        expect(await page.locator('.app').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
}

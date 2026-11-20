import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
const post = (page: Page, message: Record<string, unknown>) => page.evaluate(msg => window.postMessage(msg, '*'), message);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string; requestId?: string }[] }).__xratuHostMessages);
const setupRequest = async (page: Page, previous?: string) => {
    await expect.poll(async () => (await sent(page)).filter(msg => msg.type === 'setupGetState').at(-1)?.requestId).toBeTruthy();
    if (previous) await expect.poll(async () => (await sent(page)).filter(msg => msg.type === 'setupGetState').at(-1)?.requestId).not.toBe(previous);
    return (await sent(page)).filter(msg => msg.type === 'setupGetState').at(-1)!;
};
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
        await expect(page.locator('.onboarding')).toBeVisible();
        await expect(page.locator('.composer-input')).toBeHidden();
        await page.locator('.setup-path').nth(2).click();
        const local = await setupRequest(page);
        await post(page, { type: 'runtimeSetupState', state: { requestId: local.requestId, engine: 'xratu', path: 'local', phase: 'connect', models: [] } });
        await post(page, { type: 'localModelsDiscovered', runtimes: [{ id: 'ollama', runtime: 'ollama', name: 'Ollama', modelCount: 1, supportsTools: true, supportsVision: false, baseUrl: 'http://127.0.0.1:11434/v1', models: ['coder'] }] });
        await expect(page.locator('.setup-runtime')).toContainText('Ollama');
        await page.locator('.setup-runtime button').click();
        await expect.poll(() => sent(page)).toContainEqual({ type: 'saveLlmCredentials', base_url: 'http://127.0.0.1:11434/v1', api_key: '', returnToChat: false });
        await post(page, { type: 'credentialsSaved', credentialId: 'local', returnToChat: false });
        const ready = await setupRequest(page, local.requestId);
        await expect(page.locator('.onboarding')).toBeVisible();
        await post(page, { type: 'runtimeSetupState', state: { requestId: ready.requestId, engine: 'xratu', path: 'local', phase: 'ready', credentialId: 'local', models: [{ id: 'coder', name: 'coder', provider: 'Ollama' }] } });
        await page.locator('.setup-start').click();
        expect(await sent(page)).toContainEqual({ type: 'setupComplete', requestId: ready.requestId, model: 'coder' });
        await post(page, { type: 'showChat' });
        await expect(page.locator('.composer-input')).toBeVisible();
        await post(page, { type: 'showWelcome' });
        await page.locator('.setup-path').nth(1).click();
        const provider = await setupRequest(page, ready.requestId);
        await post(page, { type: 'runtimeSetupState', state: { requestId: provider.requestId, engine: 'xratu', path: 'provider', phase: 'connect', models: [] } });
        await expect(page.locator('.setup-credentials')).toBeVisible();
        expect(await page.locator('.app').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
}

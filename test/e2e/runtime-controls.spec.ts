import { test, expect, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function host(page: Page, message: Record<string, unknown>) {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}
async function sent(page: Page) {
    return page.evaluate(() => (window as unknown as { sent: Record<string, unknown>[] }).sent);
}
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, { sent: messages, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => null, setState: () => {} }) });
    });
    await installVscodeTheme(page);
});
const runtime = { id: 'local-ollama', runtime: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5-coder:3b'], modelCount: 1, supportsTools: true, supportsVision: false };

for (const locale of ['fa', 'en'] as const) for (const width of [420, 900]) {
    test(`offline preferences and banner ${locale} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await host(page, { type: 'locale', locale });
        await host(page, { type: 'showChat' });
        await host(page, { type: 'openSettings' });
        const offline = page.getByRole('switch', { name: locale === 'fa' ? 'حالت آفلاین' : 'Offline mode' });
        await offline.click();
        expect((await sent(page)).some((m) => m.type === 'setOfflineMode' && m.enabled === true)).toBe(true);
        await expect(offline).toHaveAttribute('aria-checked', 'false');
        await host(page, { type: 'runtimePreferences', offline: true, errorExplanations: false });
        await expect(offline).toHaveAttribute('aria-checked', 'true');
        await expect(page.locator('.screen-overlay .offline-banner')).toBeVisible();
        await expect(page.getByRole('switch', { name: locale === 'fa' ? 'توضیح خطا ها' : 'Explain errors' })).toHaveAttribute('aria-checked', 'false');
        await page.locator('.screen-overlay .offline-banner button').click();
        expect((await sent(page)).some((m) => m.type === 'openBundledGuide' && m.guide === 'offline')).toBe(true);
        const overflow = await page.locator('.settings-page').evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await page.getByRole('button', { name: locale === 'fa' ? 'بازگشت' : 'Back', exact: true }).click();
        await expect(page.locator('.app .offline-banner')).toBeVisible();
    });
}

test('Ollama download progress, cancellation and confirmed deletion', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await host(page, { type: 'locale', locale: 'en' });
    await host(page, { type: 'showChat' });
    await host(page, { type: 'openCredentials' });
    await host(page, { type: 'localModelsDiscovered', runtimes: [runtime] });
    await page.getByText('Manage Ollama models', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Model name to download' }).fill('qwen2.5-coder:7b');
    await page.getByRole('button', { name: 'Download model', exact: true }).click();
    expect((await sent(page)).find((m) => m.type === 'manageLocalModel')).toMatchObject({ action: 'pull', baseUrl: runtime.baseUrl, model: 'qwen2.5-coder:7b' });
    await host(page, { type: 'localModelOperation', baseUrl: runtime.baseUrl, model: 'qwen2.5-coder:7b', action: 'pull', busy: true, status: 'downloading', total: 100, completed: 25 });
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '25');
    await page.getByRole('button', { name: 'Cancel download' }).click();
    expect((await sent(page)).some((m) => m.type === 'manageLocalModel' && m.action === 'cancel')).toBe(true);
    await host(page, { type: 'localModelOperation', baseUrl: runtime.baseUrl, model: 'qwen2.5-coder:7b', action: 'pull', busy: false, errorKey: 'requestCancelled' });
    await page.getByRole('button', { name: 'Delete model qwen2.5-coder:3b' }).click();
    expect((await sent(page)).some((m) => m.type === 'manageLocalModel' && m.action === 'delete')).toBe(false);
    await page.getByRole('button', { name: 'Confirm deleting this model' }).click();
    expect((await sent(page)).some((m) => m.type === 'manageLocalModel' && m.action === 'delete' && m.model === 'qwen2.5-coder:3b')).toBe(true);
    await host(page, { type: 'runtimePreferences', offline: true, errorExplanations: true });
    await expect(page.getByRole('button', { name: 'Download model', exact: true })).toBeDisabled();
});

test('provider onboarding and measured latency retain errors and unknown prices', async ({ page }) => {
    await page.goto('/');
    await host(page, { type: 'locale', locale: 'en' });
    await host(page, { type: 'showChat' });
    await host(page, { type: 'openCredentials' });
    await page.getByRole('radio', { name: 'Avalai', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Sign up and add credit · Avalai' })).toHaveAttribute('href', 'https://chat.avalai.ir/platform');
    await page.getByText('Compare connection latency', { exact: true }).click();
    await page.getByRole('button', { name: 'Test active model' }).click();
    expect((await sent(page)).some((m) => m.type === 'benchmarkProvider')).toBe(true);
    await host(page, { type: 'providerBenchmark', credentialId: 'avalai', model: 'same-model', busy: false, firstTokenMs: 150, totalMs: 300, price: { input: 1, output: 2, currency: 'USD' }, cost: { amount: 0.0001, currency: 'USD' } });
    await expect(page.locator('.provider-comparison')).toContainText('First token: 150 ms');
    await expect(page.locator('.provider-comparison')).toContainText('input 1, output 2 USD');
    await host(page, { type: 'providerBenchmark', credentialId: 'other', model: 'same-model', busy: false, error: 'Provider unavailable' });
    await expect(page.locator('.provider-comparison')).toContainText('Provider unavailable');
    await expect(page.locator('.provider-comparison .runtime-model-row')).toHaveCount(2);
});

test('offline benchmarks allow only the active loopback connection', async ({ page }) => {
    await page.goto('/');
    await host(page, { type: 'locale', locale: 'en' });
    await host(page, { type: 'showChat' });
    await host(page, { type: 'openCredentials' });
    await host(page, { type: 'runtimePreferences', offline: true, errorExplanations: true });
    await page.getByText('Compare connection latency', { exact: true }).click();
    const button = page.getByRole('button', { name: 'Test active model' });
    const connection = { id: 'test', providerId: 'custom', maskedKey: '', label: 'Test', active: true };
    for (const baseUrl of ['https://provider.example/v1', 'http://localhost.evil.test/v1', 'http://localhost:11434@provider.example/v1', 'http://192.168.1.2:11434/v1']) {
        await host(page, { type: 'savedCredentials', credentials: [{ ...connection, baseUrl }] });
        await expect(button).toBeDisabled();
    }
    for (const baseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:11434/v1']) {
        await host(page, { type: 'savedCredentials', credentials: [{ ...connection, baseUrl }] });
        await expect(button).toBeEnabled();
    }
    await button.click();
    expect((await sent(page)).some((m) => m.type === 'benchmarkProvider')).toBe(true);
    await host(page, { type: 'providerBenchmark', credentialId: 'test', model: 'test', busy: true });
    await expect(button).toBeDisabled();
    await host(page, { type: 'providerBenchmark', credentialId: 'test', model: 'test', busy: false, errorKey: 'insecureEndpointHttp' });
    await expect(page.locator('.provider-comparison')).not.toContainText('insecureEndpointHttp');
    await expect(button).toBeEnabled();
});

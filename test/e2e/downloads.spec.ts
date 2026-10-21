import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const now = 1_700_000_000_000;
const base = { id: 'download-1', path: 'models/qwen-coder-7b-q4_k_m.gguf', source: 'https://huggingface.co', route: 'auto', effectiveRoute: 'proxy', received: 1_400_000_000, total: 4_500_000_000, bytesPerSecond: 780_000, attempts: 2, createdAt: now, updatedAt: now };

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`Downloads controls are session-scoped, live and dockable: ${locale} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await installVscodeTheme(page);
        await page.addInitScript(() => {
            const sent: unknown[] = [];
            (window as Record<string, unknown>).__sent = sent;
            (window as Record<string, unknown>).acquireVsCodeApi = () => ({ postMessage: (msg: unknown) => sent.push(msg), getState: () => undefined, setState: (s: unknown) => s });
        });
        await page.goto('/');
        await page.evaluate(locale => {
            window.postMessage({ type: 'locale', locale }, '*');
            window.postMessage({ type: 'showChat' }, '*');
            window.postMessage({ type: 'sessionState', id: 'chat-a', browserSessionId: 'chat-a', title: null }, '*');
        }, locale);
        await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await page.locator('.composer-input').fill('Keep my draft');
        await page.locator('#surface-tab-downloads').click();
        const panel = page.locator('#surface-panel-downloads');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText(locale === 'en' ? 'No downloads yet' : 'هنوز دانلودی شروع نشده');
        await expect(panel.locator('p')).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`downloads-empty-${locale}-${width}.png`) });
        await page.evaluate(base => window.postMessage({ type: 'downloadsState', sessionId: 'chat-a', downloads: [
            { ...base, status: 'downloading' },
            { ...base, id: 'download-2', path: 'assets/بسته-داده.zip', source: 'https://mirror.example.ir', status: 'completed', route: 'direct', effectiveRoute: 'direct', received: 64_000_000, total: 64_000_000, bytesPerSecond: 0 },
            { ...base, id: 'download-3', path: 'archives/sdk.zip', status: 'retrying', error: 'downloadNetworkError', retryAt: Date.now() + 10000, received: 900_000_000, bytesPerSecond: 0 },
            { ...base, id: 'download-4', path: 'models/interrupted-model.gguf', status: 'interrupted', bytesPerSecond: 0 },
            { ...base, id: 'download-5', path: 'assets/failed.zip', status: 'failed', bytesPerSecond: 0 },
            { ...base, id: 'download-6', path: 'assets/cancelled.zip', status: 'cancelled', bytesPerSecond: 0 },
        ] }, '*'), base);
        await expect(panel.locator('.download-row')).toHaveCount(6);
        await expect(panel.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '31');
        const primary = panel.locator('.download-downloading button').first();
        await expect(primary).toHaveAccessibleName(locale === 'en' ? 'Cancel download' : 'لغو دانلود');
        await expect(panel.locator('.download-completed button')).toHaveCount(0);
        await expect(panel.locator('.download-cancelled button')).toHaveCount(0);
        await expect(panel.locator('.download-interrupted button')).toHaveCount(2);
        await expect(panel.locator('.download-failed button')).toHaveCount(1);
        await expect(panel.locator('.download-delete')).toHaveCount(0);
        const completed = panel.locator('.download-completed');
        expect(await completed.evaluate(el => el.querySelector('.download-metrics')!.getBoundingClientRect().width === el.querySelector('.download-footer')!.getBoundingClientRect().width)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`downloads-populated-${locale}-${width}.png`) });
        await primary.click();
        await expect(primary).toBeDisabled();
        await page.locator('#surface-tab-downloads').focus();
        await page.mouse.move(0, 0);
        const command = await page.evaluate(() => (window as unknown as { __sent: { type: string; sessionId: string; id: string; action: string; requestId: string }[] }).__sent.filter(m => m.type === 'downloadAction').at(-1));
        expect(command).toMatchObject({ type: 'downloadAction', sessionId: 'chat-a', id: base.id, action: 'cancel' });
        await page.evaluate(command => window.postMessage({ ...command, type: 'downloadActionResult', errorKey: 'downloadActionFailed' }, '*'), command);
        await expect(primary).toBeEnabled();
        await expect(panel.locator('.download-action-error')).toBeVisible();

        for (const [selector, action, id] of [
            ['.download-interrupted button', 'resume', 'download-4'],
            ['.download-retrying button:nth-child(2)', 'cancel', 'download-3'],
        ]) {
            const button = panel.locator(selector).first();
            await button.focus();
            await button.click();
            await expect(button).toBeDisabled();
            const request = await page.evaluate(() => (window as unknown as { __sent: { type: string; id: string; action: string }[] }).__sent.filter(m => m.type === 'downloadAction').at(-1));
            expect(request).toMatchObject({ id, action });
            await page.evaluate(request => window.postMessage({ ...request, type: 'downloadActionResult' }, '*'), request);
            await expect(button).toBeEnabled();
        }

        await expect(panel).not.toContainText(base.source);
        await expect(panel).not.toContainText(base.path);
        await expect(panel.locator('.download-row').first().locator('strong')).toHaveAttribute('title', new RegExp(base.path));
        await expect(panel.locator('.download-retrying .download-status')).toHaveAttribute('title', /\n/);
        expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const element = await panel.elementHandle();
        if (width > 860) {
            await page.locator('#surface-tab-downloads').focus();
            await page.keyboard.press('Shift+F10');
            await page.locator('.dock-layout-menu [role=menuitem]').first().click();
            await expect(page.locator('.dock-sidebar #surface-tab-downloads')).toBeAttached();
            expect(await panel.evaluate((el, original) => el === original, element)).toBe(true);
        }
        await page.evaluate(base => window.postMessage({ type: 'downloadsState', sessionId: 'chat-a', downloads: [{ ...base, status: 'completed', received: base.total, bytesPerSecond: 0 }] }, '*'), base);
        await expect(panel.locator('.download-completed')).toHaveCount(1);
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        const sent = await page.evaluate(() => (window as Record<string, unknown>).__sent) as { type: string }[];
        expect(sent.some(msg => msg.type === 'downloadsGetState')).toBe(true);
        expect(sent.filter(msg => msg.type === 'downloadAction')).toHaveLength(3);
        await page.evaluate(base => {
            window.postMessage({ type: 'sessionState', id: 'chat-b', browserSessionId: 'chat-b', title: null }, '*');
            window.postMessage({ type: 'downloadsState', sessionId: 'chat-a', downloads: [{ ...base, status: 'downloading' }] }, '*');
        }, base);
        await expect(panel.locator('.download-row')).toHaveCount(0);
        await page.evaluate(base => window.postMessage({ type: 'downloadsState', sessionId: 'chat-b', downloads: [{ ...base, status: 'failed' }] }, '*'), base);
        await expect(panel.locator('.download-row')).toHaveCount(1);
        await page.locator('#surface-tab-downloads').click();
        await panel.locator('.download-failed button').first().click();
        const retry = await page.evaluate(() => (window as unknown as { __sent: { type: string; sessionId: string; id: string; action: string; requestId: string }[] }).__sent.filter(m => m.type === 'downloadAction').at(-1));
        expect(retry).toMatchObject({ sessionId: 'chat-b', action: 'restart' });
        await page.evaluate(retry => window.postMessage({ ...retry, type: 'downloadActionResult', sessionId: 'chat-a' }, '*'), retry);
        await expect(panel.locator('.download-failed button').first()).toBeDisabled();
        await page.evaluate(retry => window.postMessage({ ...retry, type: 'downloadActionResult' }, '*'), retry);
        await expect(panel.locator('.download-failed button').first()).toBeEnabled();
    });
}

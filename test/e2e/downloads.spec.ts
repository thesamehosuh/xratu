import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const now = 1_700_000_000_000;
const base = { id: 'download-1', path: 'models/qwen-coder-7b-q4_k_m.gguf', source: 'https://huggingface.co', route: 'auto', effectiveRoute: 'proxy', received: 1_400_000_000, total: 4_500_000_000, bytesPerSecond: 780_000, attempts: 2, createdAt: now, updatedAt: now };

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`Downloads is read-only, live and dockable: ${locale} ${width}`, async ({ page }) => {
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
        }, locale);
        await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await page.locator('.composer-input').fill('Keep my draft');
        await page.locator('#surface-tab-downloads').click();
        const panel = page.locator('#surface-panel-downloads');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText(locale === 'en' ? 'No downloads yet' : 'هنوز دانلودی شروع نشده');
        await expect(panel.locator('p')).toHaveText(locale === 'en'
            ? 'Files the agent downloads appear here with live progress, and interrupted transfers keep their saved progress.'
            : 'فایل هایی که ایجنت دانلود میکنه اینجا با پیشرفت زنده نمایش داده میشن؛ پیشرفت دانلود نیمه کاره هم ذخیره میشه.');
        await page.screenshot({ path: test.info().outputPath(`downloads-empty-${locale}-${width}.png`) });
        await page.evaluate(base => window.postMessage({ type: 'downloadsState', downloads: [
            { ...base, status: 'downloading' },
            { ...base, id: 'download-2', path: 'assets/بسته-داده.zip', source: 'https://mirror.example.ir', status: 'completed', route: 'direct', effectiveRoute: 'direct', received: 64_000_000, total: 64_000_000, bytesPerSecond: 0 },
            { ...base, id: 'download-3', path: 'archives/sdk.zip', status: 'retrying', error: 'downloadNetworkError', retryAt: Date.now() + 10000, received: 900_000_000, bytesPerSecond: 0 },
            { ...base, id: 'download-4', path: 'models/interrupted-model.gguf', status: 'interrupted', bytesPerSecond: 0 },
        ] }, '*'), base);
        await expect(panel.locator('.download-row')).toHaveCount(4);
        await expect(panel.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '31');
        await expect(panel.locator('button, input, select, a')).toHaveCount(0);
        await expect(panel).not.toContainText(base.source);
        await expect(panel).not.toContainText(base.path);
        await expect(panel.locator('.download-row').first().locator('strong')).toHaveAttribute('title', new RegExp(base.path));
        await expect(panel.locator('.download-retrying .download-status')).toHaveAttribute('title', /\n/);
        expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`downloads-populated-${locale}-${width}.png`) });
        const element = await panel.elementHandle();
        if (width > 860) {
            await page.locator('#surface-tab-downloads').focus();
            await page.keyboard.press('Shift+F10');
            await page.locator('.dock-layout-menu [role=menuitem]').first().click();
            await expect(page.locator('.dock-sidebar #surface-tab-downloads')).toBeAttached();
            expect(await panel.evaluate((el, original) => el === original, element)).toBe(true);
        }
        await page.evaluate(base => window.postMessage({ type: 'downloadsState', downloads: [{ ...base, status: 'completed', received: base.total, bytesPerSecond: 0 }] }, '*'), base);
        await expect(panel.locator('.download-completed')).toHaveCount(1);
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        const sent = await page.evaluate(() => (window as Record<string, unknown>).__sent) as { type: string }[];
        expect(sent.some(msg => msg.type === 'downloadsGetState')).toBe(true);
        expect(sent.filter(msg => /download/i.test(msg.type))).toEqual([{ type: 'downloadsGetState' }]);
    });
}

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, msg: Record<string, unknown>) => page.evaluate(message => window.postMessage(message, '*'), msg);
const session = (page: Page, id: string | null, workspace = '/project', browserSessionId = id ?? 'fresh') =>
    post(page, { type: 'sessionState', id, title: id, workspace, browserSessionId });

for (const locale of ['en', 'fa']) for (const width of [420, 1100]) {
    test(`drafts isolate sessions and survive reload ${locale} ${width}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await installVscodeTheme(page);
        await page.addInitScript(() => {
            (window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
                postMessage: () => undefined,
                getState: () => JSON.parse(sessionStorage.getItem('webviewState') ?? '{}'),
                setState: (state: unknown) => sessionStorage.setItem('webviewState', JSON.stringify(state)),
            });
        });
        await page.goto('/');
        await expect(page.locator('.app')).toBeAttached();
        await post(page, { type: 'locale', locale });
        await session(page, 'A');
        await post(page, { type: 'showChat' });
        const input = page.locator('.composer-input');
        await input.fill('draft A');
        await session(page, 'B');
        await expect(input).toHaveValue('');
        await input.fill('draft B');
        await session(page, 'A');
        await expect(input).toHaveValue('draft A');
        await session(page, 'A', '/other-project');
        await expect(input).toHaveValue('');
        await session(page, 'B');
        await expect(input).toHaveValue('draft B');
        await page.reload();
        await expect(page.locator('.app')).toBeAttached();
        await post(page, { type: 'locale', locale });
        await session(page, 'A');
        await post(page, { type: 'showChat' });
        await expect(input).toHaveValue('draft A');
        // Assigning a durable disk ID to this same new chat must keep a
        // follow-up draft typed while the first request was being saved.
        await session(page, null);
        await input.fill('follow-up');
        await session(page, 'created', '/project', 'fresh');
        await expect(input).toHaveValue('follow-up');
        await session(page, 'A');
        await expect(input).toHaveValue('draft A');
        await page.screenshot({ path: `/tmp/xratu-drafts-${locale}-${width}.png` });
    });
}

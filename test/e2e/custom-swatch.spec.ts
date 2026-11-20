import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation } from './navigation';

for (const locale of ['en', 'fa']) for (const width of [420, 1440]) {
    test(`custom rainbow swatch covers a circular control (${locale}, ${width})`, async ({ page }, info) => {
        await installVscodeTheme(page);
        await page.setViewportSize({ width, height: 950 });
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => { state = next; }, postMessage: () => {} }) });
        });
        await page.goto('/');
        await page.evaluate(locale => { window.postMessage({ type: 'locale', locale }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); }, locale);
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        const swatch = page.locator('.appearance-custom-swatch');
        await swatch.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath('appearance.png'), animations: 'disabled' });
        const dimensions = await swatch.boundingBox();
        expect(dimensions!.width).toBeGreaterThanOrEqual(32);
        expect(dimensions!.height).toBeCloseTo(dimensions!.width, 0);
        await expect(swatch).toHaveCSS('border-radius', '50%');
        await expect(swatch).toHaveCSS('background-image', /conic-gradient/);
        await page.locator('.appearance-color-input').evaluate(el => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '#cc2255'); el.dispatchEvent(new Event('change', { bubbles: true })); });
        await expect(swatch).toHaveAttribute('aria-checked', 'true');
        await expect(swatch).not.toHaveCSS('box-shadow', 'none');
        await expect(swatch.locator('svg')).toBeVisible();
    });
}

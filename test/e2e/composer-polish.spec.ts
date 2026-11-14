import { test, expect } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa']) for (const width of [420, 1440]) {
    test(`engine drop-up and plain tool hints (${theme}, ${locale}, ${width})`, async ({ page }, info) => {
        await installVscodeTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(() => {
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => null, setState: () => {}, postMessage: () => {} }) });
        });
        await page.goto('/');
        const post = (message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
        await post({ type: 'locale', locale });
        await post({ type: 'showChat' });
        const engine = page.locator('.composer-engine-picker .dropdown-trigger');
        const list = page.locator('.composer-engine-picker .dropdown-list');
        const icon = engine.locator('svg');
        await expect(icon).toHaveCount(1);
        const iconBox = await icon.boundingBox();
        const labelBox = await engine.locator('.dropdown-value').boundingBox();
        expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(labelBox!.x);
        await engine.click();
        await page.screenshot({ animations: 'disabled', path: info.outputPath('empty-engine-menu.png') });
        const above = async () => {
            const trigger = await engine.boundingBox(), popup = await list.boundingBox();
            return popup && trigger ? popup.y + popup.height <= trigger.y : false;
        };
        await expect.poll(above).toBe(true);
        await page.keyboard.press('Escape');
        await post({ type: 'restoreUser', value: 'Fix the equipment slots' });
        await post({ type: 'startResponse' });
        await post({ type: 'toolCall', tool: 'grep_search', args: JSON.stringify({ pattern: 'game' }), callId: 'search' });
        await post({ type: 'toolResult', tool: 'grep_search', output: 'tests/test_engine.py:1: game', callId: 'search' });
        const hint = page.locator('.conversation-work-current > code').first();
        await expect(hint).toHaveText('game');
        await expect(hint).toBeVisible();
        await expect(hint).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        expect(await hint.evaluate(el => el.getBoundingClientRect().width < el.parentElement!.getBoundingClientRect().width / 2)).toBe(true);
        await page.screenshot({ animations: 'disabled', path: info.outputPath('plain-tool-hint.png') });
        await post({ type: 'fullResponse', persian: 'Fixed the equipment slots.' });
        const input = page.locator('.composer-input');
        await input.fill('Keep this draft');
        await input.evaluate(el => { Object.assign(window, { originalInput: el }); (el as HTMLTextAreaElement).setSelectionRange(2, 6); });
        await page.locator('.msg.user').click();
        await expect(page.locator('.composer-actions')).toHaveCSS('height', '0px');
        await input.focus();
        await engine.click();
        await expect(page.locator('.input-bar')).toHaveClass(/menu-open/);
        await expect(page.locator('.composer-actions')).toHaveCSS('height', '36px');
        await expect.poll(above).toBe(true);
        await expect(list.getByRole('option').first()).toBeFocused();
        await page.screenshot({ animations: 'disabled', path: info.outputPath('docked-engine-menu.png') });
        await page.keyboard.press('Escape');
        await expect(list).toHaveCount(0);
        await expect(input).toHaveValue('Keep this draft');
        expect(await input.evaluate(el => el === (window as unknown as { originalInput: Element }).originalInput)).toBe(true);
        expect(await input.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([2, 6]);
        const separator = await page.locator('.composer-engine-picker').evaluate(el => {
            const style = getComputedStyle(el, '::after');
            return { height: style.height, width: style.width };
        });
        expect(separator).toEqual({ height: '14px', width: '1px' });
    });
}

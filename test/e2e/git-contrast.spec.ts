import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation } from './navigation';

for (const locale of ['en', 'fa']) for (const width of [420, 1440]) {
    test(`git surroundings follow dark contrast (${locale}, ${width})`, async ({ page }, info) => {
        await installVscodeTheme(page, 'dark');
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => state = next, postMessage: () => {} }) });
        });
        await page.goto('/');
        const post = (message: object) => page.evaluate(m => window.postMessage(m, '*'), message);
        await post({ type: 'locale', locale });
        await post({ type: 'showChat' });
        await post({ type: 'gitStatusState', root: '~/Projects/xratu', status: { isRepo: true, branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, staged: 2, modified: 1, untracked: 0, conflicted: 0 } });
        await expect(page.locator('.git-status')).toBeVisible();
        await post({ type: 'openSettings' });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        await page.locator('#appearance-darkContrast').press('End');
        await page.locator('.toolbar-back-work').click();
        await expect(page.locator('.git-status')).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath('dark-contrast.png') });
        const colors = await page.locator('.git-status').evaluate(el => {
            const ancestors: { name: string; background: string }[] = [];
            for (let node: Element | null = el; node; node = node.parentElement) ancestors.push({ name: node.className.toString(), background: getComputedStyle(node).backgroundColor });
            return ancestors;
        });
        const painted = colors.find(entry => entry.background !== 'rgba(0, 0, 0, 0)')!;
        expect(painted.background, JSON.stringify(colors)).toMatch(/^(rgb\(0, 0, 0\)|color\(srgb 0 0 0\))$/);
    });
}

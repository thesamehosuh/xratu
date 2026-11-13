import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation } from './navigation';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
const fixture = {
    type: 'usageState', providers: [
        { host: 'api.openai.com', label: 'OpenAI', iranian: false, input: 60000, output: 10000, cached: 20000, USD: 1, IRT: 0 },
        { host: 'api.example.ir', label: 'Gateway', iranian: true, input: 30000, output: 10000, cached: 10000, USD: 0, IRT: 70000 },
    ],
    history: [
        { day: '2026-11-10', cells: [{ model: 'model-a', host: 'api.openai.com', input: 60000, output: 10000, cached: 20000, USD: 1, IRT: 0 }] },
        { day: '2026-11-12', cells: [{ model: 'model-b', host: 'api.example.ir', input: 30000, output: 10000, cached: 10000, USD: 0, IRT: 70000 }] },
    ],
    rates: [
        { id: 'model-a', host: 'api.openai.com', input: 2, output: 6, cachedInput: .5, currency: 'USD', source: 'builtin', USD: 1, IRT: 0 },
        { id: 'model-b', host: 'api.example.ir', input: 10000, output: 30000, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 70000 },
    ],
    allTime: { input: 2000000, output: 300000, cached: 1000000, USD: 50, IRT: 800000 },
    chatgpt: { totals: { input: 90000, output: 10000, cached: 50000, USD: 0, IRT: 0 }, models: [{ model: 'gpt-5.4', tokens: 75000 }, { model: 'gpt-5-mini', tokens: 25000 }], hasHistory: true },
};
for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`usage dashboard and centered session actions (${theme}, ${locale}, ${width})`, async ({ page }) => {
        await installVscodeTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            const sent: object[] = [];
            Object.assign(window, { __xratuHostMessages: sent, acquireVsCodeApi: () => ({ getState: () => undefined, setState: (s: unknown) => s, postMessage: (m: object) => sent.push(m) }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await page.locator('.toolbar > .sidebar-toggle').click();
        await post(page, { type: 'sessionList', currentId: 'current', items: [{ id: 'current', title: 'A long conversation title', workspace: '/project', updatedAt: Date.now() }] });
        const row = page.locator('.session-row');
        await row.hover();
        const centers = await row.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return [...el.querySelectorAll('.session-row-action')].map(button => {
                const rect = button.getBoundingClientRect(); const icon = button.querySelector('svg')!.getBoundingClientRect();
                return [Math.abs(rect.y + rect.height / 2 - bounds.y - bounds.height / 2), Math.abs(icon.y + icon.height / 2 - bounds.y - bounds.height / 2)];
            });
        });
        for (const pair of centers) for (const distance of pair) expect(distance).toBeLessThanOrEqual(1);
        const evidence = join(process.cwd(), 'output/playwright/usage-redesign', `${theme}-${locale}-${width}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => { await page.mouse.move(width - 1, 0); await page.screenshot({ animations: 'disabled', path: join(evidence, `${name}.png`) }); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1); };
        await shot('session-actions');
        await post(page, { type: 'openSettings' });
        await openPageNavigation(page);
        await page.locator('[data-section=usage]').click();
        await post(page, { type: 'oauthState', state: { providers: [], accounts: [{ providerId: 'chatgpt-codex', credentialId: 'oauth', accountLabel: 'user@example.test', active: true, planEnabled: true }] } });
        await post(page, fixture);
        const numbers = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US');
        const tabs = page.locator('.usage-view-tabs button');
        await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.usage-summary-main > strong')).toHaveText(numbers.format(110000));
        await expect(page.locator('.usage-input-total')).toHaveText(numbers.format(60000));
        await expect(page.locator('.usage-cached-total')).toHaveText(numbers.format(30000));
        await expect(page.locator('.usage-output-total')).toHaveText(numbers.format(20000));
        await expect(page.locator('.usage-model-row')).toHaveCount(2);
        await expect(page.locator('.cost-plot')).toBeVisible();
        await shot('tokens');
        await tabs.nth(1).click();
        await expect(page.locator('.usage-summary-cost')).toContainText(new Intl.NumberFormat('fa-IR').format(70000));
        await expect(page.locator('.usage-model-name').first()).toContainText('model-b');
        await shot('cost');
        await page.locator('.cost-currencies button').last().click();
        await expect(page.locator('.usage-model-name').first()).toContainText('model-a');
        await page.locator('.usage-breakdown-tabs button').last().click();
        await expect(page.locator('.prov-row')).toHaveCount(2);
        await shot('providers');
        await tabs.nth(2).click();
        await expect(page.locator('.cost-toolbar,.cost-filters,.usage-activity-chart')).toHaveCount(0);
        await expect(page.locator('.usage-summary-main > strong')).toHaveText(numbers.format(100000));
        await expect(page.locator('.usage-input-total')).toHaveText(numbers.format(40000));
        await expect(page.locator('.usage-cached-total')).toHaveText(numbers.format(50000));
        await expect(page.locator('.usage-model-percent').first()).toHaveText(new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(.75));
        const layout = await page.locator('.usage-plan-summary').evaluate(el => ({
            positions: [...el.querySelectorAll('.usage-token-breakdown > div')].map(item => item.getBoundingClientRect().top),
            shareHeight: el.querySelector('.usage-token-share')!.getBoundingClientRect().height,
        }));
        expect(Math.max(...layout.positions) - Math.min(...layout.positions)).toBeLessThanOrEqual(1);
        expect(layout.shareHeight).toBe(6);
        await expect(page.locator('.usage-manage')).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');
        await shot('subscription');
        await tabs.first().click();
        await page.locator('.rate-disclosure > summary').click();
        await expect(page.locator('.rate-row')).toHaveCount(2);
        await page.locator('.rate-disclosure').scrollIntoViewIfNeeded();
        await shot('pricing');
        await page.locator('.usage-header-actions button').click();
        expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<{ type: string }> }).__xratuHostMessages.filter(m => m.type === 'usageGetState').length)).toBeGreaterThan(1);
        await post(page, { ...fixture, providers: [], rates: [], history: [], allTime: { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 }, chatgpt: undefined });
        await expect(page.locator('.usage-chart-empty')).toBeVisible();
        await page.locator('.usage-chart-empty').scrollIntoViewIfNeeded();
        await shot('empty');
        expect(errors).toEqual([]);
    });
}

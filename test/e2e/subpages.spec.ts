import { openPageNavigation } from './navigation';
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: object) => page.evaluate((value) => window.postMessage(value, '*'), message);
const providers = [
    { host: 'api.example.com', label: 'Cloud API', iranian: false, input: 1000, output: 200, cached: 400, USD: 12, IRT: 0 },
    { host: 'local.example.ir', label: 'Local gateway', iranian: true, input: 2000, output: 300, cached: 600, USD: 0, IRT: 700000 },
];
const usage = {
    type: 'usageState',
    providers,
    rates: [
        { id: 'model-a', host: providers[0].host, input: 2, output: 6, cachedInput: 0.5, currency: 'USD', source: 'builtin', USD: 12, IRT: 0 },
        { id: 'model-b', host: providers[1].host, input: 10000, output: 30000, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 700000 },
    ],
    history: [
        { day: '2026-07-02', cells: [{ model: 'model-a', host: providers[0].host, input: 4, output: 1, cached: 0, USD: 1, IRT: 0 }] },
        { day: '2026-08-02', cells: [{ model: 'model-a', host: providers[0].host, input: 100, output: 20, cached: 40, USD: 2, IRT: 0 }] },
        { day: '2026-08-07', cells: [{ model: 'model-b', host: providers[1].host, input: 200, output: 30, cached: 60, USD: 0, IRT: 70000 }] },
    ],
    allTime: { input: 3000, output: 500, cached: 1000, USD: 12, IRT: 700000 },
    chatgpt: { totals: { input: 90000, output: 10000, cached: 50000, USD: 0, IRT: 0 }, models: [{ model: 'gpt-5.4', tokens: 75000 }, { model: 'gpt-5-mini', tokens: 25000 }], hasHistory: true },
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: object[] = [];
        Object.assign(window, { __xratuHostMessages: sent, acquireVsCodeApi: () => ({ postMessage: (message: object) => sent.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});

for (const [locale, width] of [['en', 1280], ['fa', 420]] as const) {
    test(`usage summary, filters, currency toggle, and ChatGPT plan tab (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'openSettings' });
        await openPageNavigation(page);
        await page.locator('.page-sidebar').getByRole('button', { name: locale === 'en' ? 'Usage' : 'مصرف', exact: true }).click();
        await expect(page.locator('.usage-loading')).toBeVisible();
        await expect(page.locator('.usage-metrics')).toHaveCount(0);
        await post(page, { type: 'oauthState', state: { providers: [], accounts: [{ providerId: 'chatgpt-codex', credentialId: 'oauth', accountLabel: 'user@example.test', active: true, planEnabled: true }] } });
        await post(page, usage);

        const numbers = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US');
        const metrics = page.locator('.usage-summary');
        const tabs = page.locator('.usage-view-tabs button');
        await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true');
        await expect(metrics.locator('.usage-input-total')).toHaveText(numbers.format(200));
        await expect(metrics.locator('.usage-output-total')).toHaveText(numbers.format(50));

        // Cost tab + currency switching + providers breakdown
        await tabs.nth(1).click();
        await expect(metrics).toContainText('$2.00');
        await page.locator('.cost-currencies button').last().click();
        await expect(page.locator('.usage-model-name').first()).toContainText('model-a');
        await page.locator('.usage-breakdown-tabs button').nth(1).click();
        await expect(page.locator('.prov-row')).toHaveCount(2);
        await expect(page.locator('.prov-row').filter({ hasText: 'Cloud API' })).toContainText('$2.00');
        await expect(page.locator('.usage-lifetime')).toContainText(numbers.format(3500));

        // Model/host dropdown filters + clear + month stepper
        const model = page.locator('.cost-filters .dropdown').first();
        await model.locator('.dropdown-trigger').click();
        await page.getByRole('option', { name: 'model-a', exact: true }).click();
        await expect(metrics.locator('.usage-input-total')).toHaveText(numbers.format(60));
        await expect(page.locator('.prov-row')).toHaveCount(1);
        await expect(page.locator('.cost-currencies')).toHaveCount(0);
        const host = page.locator('.cost-filters .dropdown').nth(1);
        await host.locator('.dropdown-trigger').click();
        await page.getByRole('option', { name: 'Local gateway', exact: true }).click();
        await expect(metrics.locator('.usage-input-total')).toHaveText(numbers.format(0));
        await expect(page.locator('.prov-row')).toHaveCount(0);
        await page.locator('.usage-clear-filters').click();
        await expect(metrics.locator('.usage-input-total')).toHaveText(numbers.format(200));
        await page.getByLabel(locale === 'en' ? 'Previous month' : 'ماه قبل', { exact: true }).click();
        await expect(metrics.locator('.usage-input-total')).toHaveText(numbers.format(4));

        // ChatGPT subscription plan tab (absorbed from usage-redesign)
        await tabs.nth(2).click();
        await expect(page.locator('.cost-toolbar,.cost-filters,.usage-activity-chart')).toHaveCount(0);
        await expect(page.locator('.usage-summary-main > strong')).toHaveText(numbers.format(100000));
        await expect(page.locator('.usage-input-total')).toHaveText(numbers.format(40000));
        await expect(page.locator('.usage-cached-total')).toHaveText(numbers.format(50000));
        await expect(page.locator('.usage-model-percent').first()).toHaveText(
            new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(0.75),
        );
        await expect(page.locator('.usage-manage')).toHaveAttribute('href', 'https://chatgpt.com/settings/usage');

        // Zero-cost token fallback + refresh action
        await tabs.nth(1).click();
        await post(page, { ...usage, history: [{ day: '2026-08-02', cells: [{ model: 'free-local', host: providers[0].host, input: 100, output: 20, cached: 0, USD: 0, IRT: 0 }] }] });
        await expect(page.locator('.usage-chart-empty')).toContainText(locale === 'en' ? 'Tokens were recorded without a cost' : 'توکن ثبت شده');
        await page.getByRole('button', { name: locale === 'en' ? 'View token usage' : 'نمایش مصرف توکن', exact: true }).click();
        await expect(page.locator('.cost-legend')).toContainText('free-local');
        await page.locator('.usage-header-actions button').click();
        expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<{ type: string }> }).__xratuHostMessages.filter((m) => m.type === 'usageGetState').length)).toBeGreaterThan(1);
        expect(await page.locator('.settings-scroll').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });

    test(`subpage keyboard navigation preserves accessible names and draft (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await page.locator('.composer-input').fill('Keep this draft');
        await post(page, { type: 'openSettings' });
        await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', version: '2.0.30', installedByXratu: true, busy: false } });
        await post(page, { type: 'agentsState', profiles: [
            { name: 'explore', description: 'Explore the project and find relevant code.', source: 'builtin', editable: false },
            { name: 'review', description: 'Review project changes before merging.', source: 'project-xratu', editable: true, tools: ['read_file', 'search_files'] },
        ] });
        await post(page, { type: 'skillsState', skills: [{ id: 'review', name: 'review', description: 'Review project changes', dirPath: 'C:\\project\\.xratu\\skills\\review', source: 'project-xratu', enabled: true, bodyChars: 400 }] });
        await post(page, { type: 'mcpMarketplaceState', query: '', entries: [{ id: 'docs', source: 'curated', serverName: 'docs', name: 'Documentation', description: 'Search project documentation.', tags: [], install: { kind: 'stdio', command: 'npx', args: ['docs-server'], runtime: 'node' }, installConfidence: 'curated' }], sources: [], status: 'live', error: null, liveSearch: false });
        const names = locale === 'en'
            ? ['Providers', 'Engines', 'Servers', 'Marketplace', 'Skills', 'Agent files', 'Usage', 'Proxy', 'Settings']
            : ['ارائه دهنده ها', 'موتورهای اجرا', 'سرور ها', 'فروشگاه', 'مهارت ها', 'فایل های ایجنت', 'مصرف', 'پروکسی', 'تنظیمات'];
        for (const name of names) {
            await openPageNavigation(page);
            const target = page.locator('.page-sidebar').getByRole('button', { name, exact: true });
            await target.focus();
            await page.keyboard.press('Enter');
            await openPageNavigation(page);
            await expect(target).toHaveAttribute('aria-current', 'page');
            if (width < 860) await page.locator('.toolbar > .sidebar-toggle').click();
            await expect(page.locator('.page-content h2')).toBeVisible();
            expect(await page.locator('.page-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        }
        await page.locator('.toolbar-back-work').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
    });
}

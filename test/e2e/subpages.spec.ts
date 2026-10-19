import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: object) => page.evaluate((value) => window.postMessage(value, '*'), message);
const providers = [
    { host: 'api.example.com', label: 'Cloud API', iranian: false, input: 1000, output: 200, cached: 400, USD: 12, IRT: 0 },
    { host: 'local.example.ir', label: 'Local gateway', iranian: true, input: 2000, output: 300, cached: 600, USD: 0, IRT: 700000 },
];
const usage = {
    type: 'usageState', providers, rates: [
        { id: 'model-a', host: providers[0].host, input: 2, output: 6, cachedInput: 0.5, currency: 'USD', source: 'builtin', USD: 12, IRT: 0 },
        { id: 'model-b', host: providers[1].host, input: 10000, output: 30000, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 700000 },
    ],
    history: [
        { day: '2026-07-02', cells: [{ model: 'model-a', host: providers[0].host, input: 4, output: 1, cached: 0, USD: 1, IRT: 0 }] },
        { day: '2026-08-02', cells: [{ model: 'model-a', host: providers[0].host, input: 100, output: 20, cached: 40, USD: 2, IRT: 0 }] },
        { day: '2026-08-07', cells: [{ model: 'model-b', host: providers[1].host, input: 200, output: 30, cached: 60, USD: 0, IRT: 70000 }] },
    ],
    allTime: { input: 3000, output: 500, cached: 1000, USD: 12, IRT: 700000 },
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: object[] = [];
        Object.assign(window, { __xratuHostMessages: sent, acquireVsCodeApi: () => ({ postMessage: (message: object) => sent.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`usage summary, chart and providers share their scope (${locale}, ${width})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'openSettings' });
        await page.locator('.page-sidebar').getByRole('button', { name: locale === 'en' ? 'Usage' : 'مصرف', exact: true }).click();
        await expect(page.locator('.usage-loading')).toBeVisible();
        await expect(page.locator('.usage-metrics')).toHaveCount(0);
        await post(page, usage);
        const numbers = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US');
        const metrics = page.locator('.usage-metrics');
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(350));
        await expect(metrics.locator('strong').nth(2)).toHaveText(numbers.format(2));
        await expect(metrics).toContainText('$2.00');
        await expect(page.locator('.prov-row')).toHaveCount(2);
        await expect(page.locator('.prov-row').filter({ hasText: 'Cloud API' })).toContainText('$2.00');
        await expect(page.locator('.prov-row').filter({ hasText: 'Cloud API' }).locator('.prov-stats')).toContainText(numbers.format(60));
        await expect(page.locator('.usage-lifetime')).toContainText(numbers.format(3500));
        await expect(page.locator('.cost-dates > span').first()).toHaveText(locale === 'en' ? '1' : '۱');
        await page.mouse.move(15, 15);
        await page.screenshot({ path: testInfo.outputPath('usage-overview.png') });
        await page.locator('.rate-disclosure > summary').click();
        await page.locator('.settings-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await page.screenshot({ path: testInfo.outputPath('usage-rates.png') });
        await page.locator('.usage-overview').scrollIntoViewIfNeeded();

        const model = page.locator('.cost-filters .dropdown').first();
        await model.locator('.dropdown-trigger').click();
        await model.getByRole('option', { name: 'model-a', exact: true }).click();
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(120));
        await expect(page.locator('.prov-row')).toHaveCount(1);
        await expect(page.locator('.cost-legend')).toContainText('model-a');
        await expect(page.locator('.cost-currencies')).toHaveCount(0);
        const host = page.locator('.cost-filters .dropdown').nth(1);
        await host.locator('.dropdown-trigger').click();
        await host.getByRole('option', { name: 'Local gateway', exact: true }).click();
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(0));
        await expect(page.locator('.prov-row')).toHaveCount(0);
        await page.locator('.usage-clear-filters').click();
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(350));
        await expect(page.locator('.prov-row')).toHaveCount(2);
        await page.getByLabel(locale === 'en' ? 'Previous month' : 'ماه قبل', { exact: true }).click();
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(5));
        await expect(page.locator('.prov-row')).toHaveCount(1);
        await expect(page.locator('.usage-lifetime')).toContainText(numbers.format(3500));

        await post(page, { ...usage, history: [{ day: '2026-08-02', cells: [{ model: 'free-local', host: providers[0].host, input: 100, output: 20, cached: 0, USD: 0, IRT: 0 }] }] });
        await expect(metrics.locator('strong').nth(1)).toHaveText(numbers.format(120));
        await expect(page.locator('.usage-chart-empty')).toContainText(locale === 'en' ? 'Tokens were recorded without a cost' : 'توکن ثبت شده');
        await expect(page.locator('.usage-period-cost')).not.toContainText('$0');
        await page.getByRole('button', { name: locale === 'en' ? 'View token usage' : 'نمایش مصرف توکن', exact: true }).click();
        await expect(page.locator('.cost-cols')).toHaveAttribute('aria-label', locale === 'en' ? 'Daily tokens by model' : 'نمودار مصرف روزانه توکن به تفکیک مدل');
        await expect(page.locator('.cost-legend')).toContainText('free-local');
        await expect(page.locator('.cost-legend')).toContainText(numbers.format(120));
        await page.mouse.move(15, 15);
        await page.screenshot({ path: testInfo.outputPath('usage-token-view.png') });
        expect(await page.locator('.settings-scroll').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    });

    test(`subpage navigation preserves accessible names and the draft (${locale}, ${width})`, async ({ page }, testInfo) => {
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
        for (const [index, name] of names.entries()) {
            const target = page.locator('.page-sidebar').getByRole('button', { name, exact: true });
            await target.focus();
            await page.keyboard.press('Enter');
            await expect(target).toHaveAttribute('aria-current', 'page');
            await expect(page.locator('.page-content h2')).toBeVisible();
            expect(await page.locator('.page-content').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await page.screenshot({ path: testInfo.outputPath(`page-${index}.png`) });
        }
        await page.locator('.sidebar-back').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
    });
}

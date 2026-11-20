import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation } from './navigation';
const post = (page: Page, value: object) => page.evaluate(message => window.postMessage(message, '*'), value);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
const openTool = async (page: Page, name: string) => {
    const group = page.locator('.transcript-pane .conversation-work-group').last();
    await group.locator(':scope > summary').click();
    const label = group.locator('.step-group-body').getByText(name, { exact: true }).first();
    await expect(label).toBeVisible();
    await label.click();
    return group;
};
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const messages: object[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (value: object) => messages.push(value), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});
for (const [locale, width] of [['en', 1280], ['fa', 420]] as const) {
    test(`native search, structured sources, and proxy routing control (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'toolCall', callId: 'native', tool: 'opencode_websearch', args: '{"query":"docs"}' });
        await post(page, { type: 'toolResult', callId: 'native', tool: 'opencode_websearch', output: '1. Official documentation\n   https://example.com/docs\n   Search result snippet.' });
        const nativeSearch = await openTool(page, locale === 'en' ? 'Web search · OpenCode' : 'جستجوی وب · OpenCode');
        await expect(nativeSearch.locator('.detail-web-results a')).toHaveAttribute('href', 'https://example.com/docs');
        await expect(page.locator('.lucide-globe').first()).toBeVisible();

        await post(page, { type: 'openCredentials' });
        await expect(page.locator('.cred-page')).toBeVisible();
        await expect(page.locator('.research-controls')).toHaveCount(0);
        await openPageNavigation(page);
        await page.locator('.page-sidebar').getByRole('button', { name: locale === 'en' ? 'Proxy' : 'پروکسی', exact: true }).click();
        const state = { type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'localhost', resolvedUrl: 'http://127.0.0.1:7890', resolvedSource: 'system', systemProxy: 'http://127.0.0.1:7890', noProxyList: 'localhost', webSearchUseProxy: true };
        await post(page, state);
        const control = page.locator('.proxy-search-routing');
        const buttons = control.getByRole('button');
        await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
        await buttons.last().click();
        await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true');
        await page.locator('.proxy-save-row .apply-btn').click();
        expect(await sent(page)).toContainEqual({ type: 'proxySave', requestId: expect.any(String), mode: 'auto', proxyUrl: state.proxyUrl, noProxy: state.noProxy, webSearchUseProxy: false });
        const requestId = (await sent(page)).filter(message => message.type === 'proxySave').at(-1)!.requestId;
        await post(page, { ...state, requestId, webSearchUseProxy: false });
        await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true');
        expect(await page.locator('.page-content').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

        await page.locator('.toolbar-back-work').click();
        await post(page, { type: 'showChat' });
        await post(page, { type: 'toolCall', callId: 'research', tool: 'web_search', args: '{"query":"official docs"}' });
        await post(page, { type: 'toolResult', callId: 'research', tool: 'web_search', output: 'A format that cannot be parsed as numbered source text.', research: { version: 1, provider: 'parallel', outcome: 'success', freshness: 'unknown', warnings: [], sources: [{ id: 'one', title: 'Official documentation', url: 'https://example.com/docs', excerpts: ['Observed evidence.'], retrievedAt: '2026-10-21T00:00:00Z', route: 'parallel' }, { id: 'unsafe', title: 'Unsafe link', url: 'javascript:alert(1)', excerpts: [] }] } });
        const structuredSearch = await openTool(page, locale === 'en' ? 'Web search' : 'جستجوی وب');
        const source = structuredSearch.locator('.detail-web-results a').filter({ hasText: 'Official documentation' });
        await expect(source).toHaveAttribute('href', 'https://example.com/docs');
        await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
    });
}

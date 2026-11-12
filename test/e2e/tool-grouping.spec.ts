import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: Record<string, unknown>) => page.evaluate(value => window.postMessage(value, '*'), message);
async function call(page: Page, id: string, tool: string, args: Record<string, unknown>, output = 'Completed', isError = false) {
    await post(page, { type: 'toolCall', callId: id, tool, args: JSON.stringify(args) });
    await post(page, { type: 'toolResult', callId: id, tool, output, isError });
}
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => undefined, setState: (state: unknown) => state }) });
    });
    await page.goto('/');
    await post(page, { type: 'showChat' });
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`one tool presentation across families and completion (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'restoreUser', value: locale === 'fa' ? 'ورود کاربر رو بررسی و اصلاح کن.' : 'Investigate and fix the login flow.' });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: locale === 'fa' ? 'مسیر ورود و مستندات رو بررسی میکنم.' : 'I’ll check the login flow and the provider docs.' });
        await call(page, 'read', 'read_file', { path: 'src/auth.ts' }, 'export const valid = true;');
        await call(page, 'search', 'grep_search', { pattern: 'expiresAt', path: 'src' }, 'src/auth.ts:8:expiresAt');
        await call(page, 'web', 'web_search', { query: 'OAuth token expiry' }, 'Provider documentation found');
        await call(page, 'mcp', 'mcp__docs__lookup', { query: 'refresh token rotation' }, 'Refresh tokens must be rotated.');
        await call(page, 'diagnostics', 'get_diagnostics', { path: 'src/auth.ts' }, 'No diagnostics');
        const liveGroups = await page.locator('.transcript-pane .conversation-work-group').count();
        await page.screenshot({ path: info.outputPath('live-tools.png') });
        await post(page, { type: 'chunk', value: locale === 'fa' ? 'شرط انقضا جا افتاده. اضافه اش میکنم.' : 'The expiry guard is missing. I’m adding it now.' });
        await call(page, 'edit', 'replace_in_file', { path: 'src/auth.ts', search: 'valid = true', replace: 'valid = expiresAt > Date.now()' }, 'Replaced 1 occurrence');
        await call(page, 'test', 'run_terminal_command', { command: 'npm test' }, 'All tests passed\nExit code: 0');
        const groups = page.locator('.transcript-pane .conversation-work-group');
        await groups.last().locator(':scope > summary').click();
        await post(page, { type: 'fullResponse', persian: locale === 'fa' ? 'شرط انقضا اصلاح شد و تست ها پاس شدن.' : 'Fixed the expiry guard. All tests pass.' });
        await page.screenshot({ path: info.outputPath('completed-tools.png') });
        expect(liveGroups, 'web, MCP and diagnostic calls belong to the same adjacent work group').toBe(1);
        await expect(groups).toHaveCount(0);
        const thin = page.locator('.transcript-pane .completed-steps');
        await expect(thin).toHaveCount(1);
        await expect(thin).not.toHaveAttribute('open');
        await thin.locator(':scope > summary').click();
        await expect(thin.locator('.compact-step')).toHaveCount(7);
        await expect(thin).not.toContainText('Refresh tokens must be rotated.');
        await expect(page.locator('.transcript-pane')).not.toContainText('The expiry guard is missing. I’m adding it now.');
        const overflow = await page.locator('.transcript-pane').evaluate(element => element.scrollWidth > element.clientWidth + 1);
        expect(overflow).toBe(false);
        await page.screenshot({ path: info.outputPath('thin-tools.png') });
        await page.locator('#surface-tab-activity').click();
        const mcp = page.locator('.activity-pane details.step').filter({ hasText: 'docs · lookup' });
        await mcp.locator(':scope > summary').click();
        await expect(mcp).toContainText('Refresh tokens must be rotated.');
    });
}

test('running commands, failures and completed output remain reachable', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'startResponse' });
    await call(page, 'read', 'read_file', { path: 'src/auth.ts' });
    await post(page, { type: 'toolCall', callId: 'command', tool: 'run_terminal_command', args: '{"command":"npm test"}' });
    await expect(page.getByRole('button', { name: 'Run in background' })).toBeVisible();
    await post(page, { type: 'toolResult', callId: 'command', tool: 'run_terminal_command', output: 'Test failed\nExit code: 1', isError: true });
    const group = page.locator('.transcript-pane .conversation-work-group').first();
    await expect(group.locator(':scope > summary')).toContainText('1 failed');
    await expect(group).toHaveAttribute('open', '');
    await expect(group).toContainText('Test failed');
    await post(page, { type: 'fullResponse', persian: 'The test needs a follow-up fix.' });
    await expect(group).toHaveCount(0);
    const thin = page.locator('.transcript-pane .completed-steps');
    await expect(thin.locator(':scope > summary')).toContainText('1 failed');
    await thin.locator(':scope > summary').click();
    await expect(thin).toContainText('Test failed');
});

test('manual expansion survives mixed tools and streamed arguments', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'startResponse' });
    await call(page, 'read', 'read_file', { path: 'src/auth.ts' });
    const group = page.locator('.transcript-pane .conversation-work-group');
    await group.locator(':scope > summary').click();
    await call(page, 'web', 'web_search', { query: 'expiry' });
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('open', '');
    await group.locator(':scope > summary').click();
    await post(page, { type: 'toolCall', callId: 'mcp', tool: 'mcp__docs__lookup', args: '{"query":"refresh"}' });
    await expect(group).not.toHaveAttribute('open');
    await expect(group.locator('.spinner')).toHaveCount(1);
    await post(page, { type: 'toolResult', callId: 'mcp', tool: 'mcp__docs__lookup', output: 'Found docs' });
    await expect(group).not.toHaveAttribute('open');
    await expect(group.locator('.spinner')).toHaveCount(0);
});

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: Record<string, unknown>) => page.evaluate(msg => window.postMessage(msg, '*'), message);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __xratuHostMessages: Record<string, unknown>[] }).__xratuHostMessages);
const pick = async (page: Page, selector: string, label: string) => {
    await page.locator(selector).click();
    await page.getByRole('option', { name: label, exact: true }).click();
};
const tool = async (page: Page, id: string, name: string, path: string, done = true) => {
    await post(page, { type: 'toolCall', tool: name, args: JSON.stringify({ path, pattern: 'expiry', command: 'npm test' }), callId: id });
    if (done) await post(page, { type: 'toolResult', tool: name, output: `Retained result for ${path}`, callId: id });
};
const seed = async (page: Page) => {
    await post(page, { type: 'restoreUser', value: 'Fix expired tokens being accepted.' });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'chunk', value: 'I will inspect token validation.' });
    await tool(page, 'a', 'read_file', 'src/auth.ts');
    await tool(page, 'b', 'read_file', 'test/auth.ts');
    await post(page, { type: 'thinking', value: 'Trace the expiry guard.' });
    await tool(page, 'search', 'grep_search', 'src');
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => undefined, setState: (s: unknown) => s }) });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
});

test('live mixed exploration stays one group and preserves manual expansion', async ({ page }) => {
    await seed(page);
    const group = page.locator('.transcript-pane .conversation-work-group');
    await expect(group).toHaveCount(1);
    await expect(group).not.toHaveAttribute('open');
    await expect(group.locator(':scope > summary')).toContainText('2 reads');
    await expect(page.locator('.transcript-pane .step-think')).toHaveCount(0);
    await group.locator(':scope > summary').click();
    await tool(page, 'c', 'read_file', 'src/session.ts', false);
    await expect(group).toHaveAttribute('open', '');
    await post(page, { type: 'toolResult', tool: 'read_file', output: 'session source', callId: 'c' });
    await expect(group).toHaveAttribute('open', '');
    await expect(group.locator(':scope > summary')).toContainText('3 reads');
    await group.locator(':scope > summary').click();
    await post(page, { type: 'thinking', value: 'More reasoning without reopening the group.' });
    await tool(page, 'd', 'grep_search', 'test');
    await expect(group).not.toHaveAttribute('open');
});

test('Conversation has no Activity shortcuts and Activity retains searchable details', async ({ page }) => {
    await seed(page);
    await expect(page.locator('.transcript-pane').getByRole('button', { name: 'View in Activity' })).toHaveCount(0);
    const group = page.locator('.transcript-pane .conversation-work-group');
    await group.locator(':scope > summary').click();
    await expect(page.locator('.transcript-pane .conversation-activity-link')).toHaveCount(0);
    await page.locator('#surface-tab-activity').click();
    await expect(page.locator('.activity-pane')).toContainText('Retained result for test/auth.ts');
    await expect(page.locator('.activity-filters select')).toHaveCount(0);
    await pick(page, '.activity-filters .dropdown-trigger', 'Thinking');
    await expect(page.locator('.activity-timeline')).toContainText('Trace the expiry guard.');
    await expect(page.locator('.activity-timeline')).not.toContainText('Retained result for');
    await pick(page, '.activity-filters .dropdown-trigger', 'All activity');
    await page.getByRole('searchbox', { name: 'Search activity' }).fill('I will inspect');
    await expect(page.locator('.activity-timeline')).toContainText('I will inspect token validation.');
    await page.getByRole('searchbox', { name: 'Search activity' }).fill('no-such-activity');
    await expect(page.locator('.activity-empty')).toHaveText('No activity matches these filters.');
});

test('balanced groups completed commands while the active command and failures stay actionable', async ({ page }) => {
    await post(page, { type: 'startResponse' });
    await tool(page, 'lint', 'run_terminal_command', 'lint');
    await tool(page, 'build', 'run_terminal_command', 'build');
    const group = page.locator('.transcript-pane .conversation-work-group');
    await expect(group).toHaveCount(1);
    await expect(group).not.toHaveAttribute('open');
    await expect(group.locator(':scope > summary')).toContainText('2 commands');
    await tool(page, 'test', 'run_terminal_command', 'test', false);
    await expect(page.locator('.transcript-pane').getByRole('button', { name: 'Run in background' })).toBeVisible();
    await group.locator(':scope > summary').click();
    await expect(group).toContainText('Retained result for lint');
    await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'test passed', callId: 'test' });
    await expect(group).toHaveAttribute('open', '');
    await expect(group.locator(':scope > summary')).toContainText('3 commands');
    await tool(page, 'failure', 'run_terminal_command', '', false);
    await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'STDOUT:\nTest failed\nExit code: 1', callId: 'failure' });
    await expect(page.locator('.transcript-pane details.step.fail')).toBeVisible();
    await expect(page.locator('.transcript-pane details.step.fail')).toHaveAttribute('open', '');
    await page.locator('#surface-tab-activity').click();
    await expect(page.locator('.activity-pane')).toContainText('Retained result for lint');
    await expect(page.locator('.activity-pane')).toContainText('Retained result for build');
    await expect(page.locator('.activity-pane .conversation-work-group')).toHaveCount(0);
});

test('settings persist through host echoes, preserve legacy choices and reset', async ({ page }) => {
    await post(page, { type: 'openSettings' });
    const detail = page.getByLabel('Conversation detail', { exact: true });
    await expect(page.locator('.preferences-page select')).toHaveCount(0);
    await expect(detail).toHaveText('Balanced');
    await detail.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Balanced', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('option', { name: 'Minimal', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(detail).toBeFocused();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect(await sent(page)).toContainEqual({ type: 'transcriptOptionsSet', options: { detail: 'minimal' } });
    await expect(detail).toHaveText('Balanced');
    await post(page, { type: 'transcriptPrefs', prefs: { expand: { edit: true }, options: { detail: 'minimal' } } });
    await expect(detail).toHaveText('Minimal');
    await page.locator('.conversation-advanced > summary').click();
    await expect(page.locator('#tx-diffs')).toHaveText('Inline');
    await expect(page.locator('#tx-progress')).toHaveText('Latest only');
    await pick(page, '#tx-commands', 'Expanded');
    expect(await sent(page)).toContainEqual({ type: 'transcriptOptionsSet', options: { commands: 'expanded' } });
    await pick(page, '#tx-diffs', 'Summary');
    expect(await sent(page)).toContainEqual({ type: 'transcriptSet', id: 'edit', enabled: false });
    await post(page, { type: 'transcriptPrefs', prefs: { expand: { edit: false }, options: { detail: 'minimal', commands: 'expanded' } } });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'openSettings' });
    await expect(detail).toHaveText('Minimal');
    await page.locator('.conversation-advanced > summary').click();
    await expect(page.locator('#tx-commands')).toHaveText('Expanded');
    await page.getByRole('button', { name: 'Reset conversation preferences' }).click();
    expect(await sent(page)).toContainEqual({ type: 'transcriptReset' });
    await post(page, { type: 'transcriptPrefs', prefs: { expand: {} } });
    await expect(detail).toHaveText('Balanced');
    await expect(page.locator('#tx-diffs')).toHaveText('Summary');
});

test('minimal keeps actionable failures, approvals and background controls visible', async ({ page }) => {
    await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { detail: 'minimal' } } });
    await seed(page);
    await tool(page, 'cmd', 'run_terminal_command', '', false);
    await post(page, { type: 'toolResult', tool: 'run_terminal_command', callId: 'cmd', output: 'STDOUT:\nTest failed\nExit code: 1' });
    const failure = page.locator('.transcript-pane details.step.fail');
    await expect(failure).toHaveAttribute('open', '');
    await expect(failure).toContainText('Test failed');
    await tool(page, 'bg', 'run_terminal_command', '', false);
    await expect(page.locator('.transcript-pane').getByRole('button', { name: 'Run in background' })).toBeVisible();
    await post(page, { type: 'needsApproval', approval_id: 'ap', approvals: [{ tool_call_id: 'bg', tool_name: 'run_terminal_command', args: { command: 'npm test' } }] });
    await expect(page.locator('.transcript-pane .approval-card')).toBeVisible();
});

test('Activity can disable following and timestamps without discarding the trace', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 500 });
    await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { followActivity: false, timestamps: false } } });
    await post(page, { type: 'startResponse' });
    for (let i = 0; i < 18; i++) await tool(page, `call-${i}`, i % 2 ? 'read_file' : 'grep_search', `file-${i}.ts`);
    await page.locator('#surface-tab-activity').click();
    const pane = page.locator('.activity-pane');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.activity-age')).toHaveCount(0);
    await expect.poll(() => pane.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBe(0);
    await tool(page, 'later', 'read_file', 'later.ts');
    await expect.poll(() => pane.evaluate(el => el.scrollTop)).toBe(0);
    await expect(pane).toContainText('later.ts');
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`conversation and settings remain usable (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await seed(page);
        await post(page, { type: 'chunk', value: 'The expiry guard is missing. I am adding a regression test.' });
        await tool(page, 'edit', 'replace_in_file', 'src/auth.ts');
        await tool(page, 'lint', 'run_terminal_command', 'lint');
        await tool(page, 'build', 'run_terminal_command', 'build');
        await tool(page, 'git', 'git_status', '');
        await tool(page, 'cmd', 'run_terminal_command', '', false);
        await expect(page.locator('.transcript-pane .conversation-work-group')).toHaveCount(2);
        await expect(page.locator('.conversation-work-summary > span').first()).toHaveCSS('direction', locale === 'fa' ? 'rtl' : 'ltr');
        for (const group of await page.locator('.conversation-work-group').all()) {
            const centers = await group.locator(':scope > summary .sum-row').evaluate(row => {
                const selectors = ['.step-icon', '.step-label', '.conversation-work-summary', '.step-chev'];
                return selectors.map(selector => {
                    const rect = row.querySelector(selector)!.getBoundingClientRect();
                    return rect.y + rect.height / 2;
                });
            });
            expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1.1);
        }
        await page.screenshot({ path: info.outputPath(`conversation-${locale}-${width}.png`), animations: 'disabled' });
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-filters input')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`activity-${locale}-${width}.png`), animations: 'disabled' });
        await post(page, { type: 'openSettings' });
        await expect(page.locator('#tx-detail')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`settings-default-${locale}-${width}.png`), animations: 'disabled' });
        await page.locator('#tx-detail').click();
        const menu = page.locator('.preferences-page .dropdown-list');
        await expect(menu).toBeVisible();
        expect(await menu.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
        const bounds = await menu.boundingBox();
        const scrollBounds = await page.locator('.settings-scroll').boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(scrollBounds!.y - 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(scrollBounds!.y + scrollBounds!.height + 1);
        await page.screenshot({ path: info.outputPath(`settings-menu-${locale}-${width}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await expect(page.locator('#tx-detail')).toBeFocused();
        await page.locator('.conversation-advanced > summary').click();
        const detail = page.locator('#tx-detail');
        await expect(detail).toBeVisible();
        expect(await page.locator('.settings-scroll').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`settings-${locale}-${width}.png`), animations: 'disabled' });
        await page.locator('.conversation-reset').scrollIntoViewIfNeeded();
        await expect(page.locator('.conversation-reset')).toBeVisible();
        await page.screenshot({ path: info.outputPath(`settings-bottom-${locale}-${width}.png`), animations: 'disabled' });
    });
}

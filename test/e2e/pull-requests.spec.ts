import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const url = 'https://github.com/example/repo/pull/42';
const link = {
    host: 'github.com', repository: 'example/repo', number: 42, url, linkedAt: '2026-01-01T00:00:00Z', generation: 'link-generation', source: 'agent', failures: 0,
    snapshot: { title: 'Make session updates reliable', state: 'open', isDraft: false, headBranch: 'fix/session-updates', baseBranch: 'main', headSha: 'a'.repeat(40), mergeability: 'clean', reviewDecision: 'REVIEW_REQUIRED', syncedAt: '2026-01-01T12:00:00Z', viewer: 'me', author: { login: 'me' }, checks: [{ name: 'Windows / Tests', status: 'failure', required: true, url: 'https://github.com/example/repo/actions/runs/123' }, { name: 'Linux / Tests', status: 'success', required: true, url: null }], comments: [{ id: 'review', body: 'Please keep the original staging state. <script>window.prInjected = true</script>', author: { login: 'reviewer' }, url: `${url}#review`, path: 'src/extension.ts', reviewState: 'CHANGES_REQUESTED', createdAt: '2026-01-01T12:00:00Z', editedAt: null }] },
};
const watching = { startedAt: '2026-01-01T12:00:00Z', headSha: 'a'.repeat(40), failedChecks: ['Windows / Tests'], passed: false, passedChecks: [], remarksThrough: '2026-01-01T12:00:00Z', remarkIds: [], conflicting: false, wakes: 0 };
const state = (links: unknown[] = []) => ({ links, events: [], offline: false });
async function host(page: Page, value: unknown) { await page.evaluate(message => window.postMessage(message, '*'), value); }
async function sent(page: Page) { return page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<{ type: string; action?: string; sessionId?: string; requestId: string; url?: string; autoResume?: boolean }> }).__xratuHostMessages); }
async function reply(page: Page, value: unknown, sessionId = 'session-a') {
    const request = (await sent(page)).filter(message => ['pullRequestsGetState', 'pullRequestAction'].includes(message.type)).at(-1)!;
    await host(page, { type: 'pullRequestsState', sessionId, requestId: request.requestId, state: value });
}
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages = sent;
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => sent.push(message), getState: () => undefined, setState: (value: unknown) => value });
    });
});

async function openSession(page: Page, locale = 'en') {
    await page.goto('/');
    await page.locator('.app').waitFor();
    await host(page, { type: 'locale', locale });
    await host(page, { type: 'showChat' });
    await host(page, { type: 'sessionState', id: 'session-a', title: 'Session A' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await page.waitForFunction(() => {
        const reads = ((window as unknown as { __xratuHostMessages: Array<{ type: string; refresh?: boolean }> }).__xratuHostMessages || []).filter(message => message.type === 'pullRequestsGetState');
        return reads.length > 0 && reads[reads.length - 1].refresh === true;
    });
    await reply(page, state());
}

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1200]) {
    test(`agent-linked PRs show compact chat status and open the panel ${locale} ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await openSession(page, locale);
        await expect(page.locator('#surface-tab-pullRequests')).toHaveCount(0);
        await expect(page.locator('.pr-indicator')).toHaveCount(0);
        await page.locator('.composer-input').fill('Keep my draft');
        // Linking belongs to the agent tool path. No form or panel visit is needed.
        await host(page, { type: 'startResponse' });
        await host(page, { type: 'toolCall', tool: 'link_pull_request', args: JSON.stringify({ url }), callId: 'link-pr' });
        await host(page, { type: 'toolResult', tool: 'link_pull_request', output: JSON.stringify({ pullRequests: [{ url }] }), callId: 'link-pr' });
        const resume = { workspace: '/project', branch: 'fix/session-updates', engine: 'xratu', model: 'provider/model', credential: 'account', nativeSessionId: null, binaryPath: null };
        await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([{ ...link, watch: watching, resume }]) });
        await host(page, { type: 'fullResponse', persian: 'PR linked and watching.' });
        await expect(page.locator('.pr-indicator')).toHaveCount(1);
        await expect(page.locator('#surface-tab-pullRequests')).toHaveCount(0);
        await expect(page.locator('.pr-panel')).toBeHidden();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`pr-chat-${locale}-${width}.png`) });
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-timeline details.step')).toBeVisible();
        await expect(page.locator('.pr-indicator')).toHaveCount(1);
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.pr-indicator-row').click();
        await expect(page.locator('.pr-indicator')).toHaveCount(0);
        await expect(page.locator('.pr-panel')).toBeVisible();
        await expect(page.locator('.pr-panel')).toHaveClass(/panel-main/);
        await expect(page.locator('.pr-row')).toContainText('Make session updates reliable');
        const details = page.locator('.pr-detail');
        await expect(details.nth(0)).not.toHaveAttribute('open');
        await expect(details.nth(1)).not.toHaveAttribute('open');
        await expect(details.nth(0).locator('summary')).toContainText(locale === 'en' ? '1 failed' : '1 ناموفق');
        await expect(details.nth(1).locator('summary')).toContainText('reviewer');
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`pr-collapsed-${locale}-${width}.png`) });
        await details.nth(0).locator('summary').click();
        await details.nth(1).locator('summary').click();
        await expect(page.locator('.pr-check-dot.failure')).toBeVisible();
        // Badges are the last `span` in `.pr-detail li`, so the generic
        // `span:last-child` rule matches them too: the badge selectors have to
        // stay more specific or every status label renders in the description
        // colour instead of its own tone.
        await expect(page.locator('.pr-check-badge.is-failure')).toHaveCSS('color', 'rgb(248, 81, 73)');
        await expect(page.locator('.pr-comments')).toContainText('<script>');
        await expect(page.locator('.pr-comments p')).toBeVisible();
        await page.locator('.pr-comments p').scrollIntoViewIfNeeded();
        await expect(page.locator('.pr-comments')).not.toHaveAttribute('data-motion-anim', '1');
        expect(await page.locator('.pr-comments').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => (window as unknown as { prInjected?: boolean }).prInjected)).toBeUndefined();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`pr-details-${locale}-${width}.png`) });
        await page.getByRole('button', { name: locale === 'en' ? 'Stop watching' : 'توقف پیگیری', exact: true }).click();
        expect((await sent(page)).at(-1)).toMatchObject({ action: 'unwatch', sessionId: 'session-a' });
        await reply(page, state([link]));
        await expect(page.locator('.pr-indicator-watch')).toHaveCount(0);
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        await host(page, { type: 'sessionState', id: 'session-b', title: 'Session B' });
        await expect(page.locator('.pr-row')).toHaveCount(0);
        await expect(page.locator('.pr-indicator')).toHaveCount(0);
        await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([link]) });
        await expect(page.locator('.pr-row')).toHaveCount(0);
        await reply(page, state(), 'session-b');
        expect(await page.locator('.app').evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    });
}

test('pending updates stay agent-facing and never add a card to the PR panel', async ({ page }) => {
    await openSession(page);
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: { ...state([link]), delivery: { ids: ['event'], status: 'interrupted', owner: 1 }, events: [{ id: 'event', key: 'github.com/example/repo#42', url, number: 42, createdAt: '2026-01-01T12:00:00Z', headSha: 'a'.repeat(40), changes: [{ kind: 'conflicting' }] }] } });
    await expect(page.locator('.pr-indicator')).toHaveCount(1);
    await host(page, { type: 'openPullRequests' });
    await expect(page.locator('.pr-panel')).toBeVisible();
    // The update notice is agent-facing: the panel shows the PR rows (which
    // carry the visible status) and never a separate queue card.
    await expect(page.locator('.pr-updates')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review with agent', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dismiss updates', exact: true })).toHaveCount(0);
    await expect(page.locator('.pr-row')).toContainText('Make session updates reliable');
});

test('unlinking the last PR leaves the explicitly opened empty panel and preserves the draft', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openSession(page);
    await page.locator('.composer-input').fill('Continue reviewing');
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([link]) });
    await host(page, { type: 'openPullRequests' });
    await page.locator('.pr-menu summary').click();
    await expect(page.getByRole('button', { name: 'Unlink', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Unlink', exact: true })).toBeHidden();
    await page.locator('.pr-menu summary').click();
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    expect((await sent(page)).at(-1)).toMatchObject({ action: 'unlink', url });
    await reply(page, state());
    await expect(page.locator('.pr-row')).toHaveCount(0);
    await page.locator('#surface-tab-conversation').click();
    await expect(page.locator('.composer-input')).toHaveValue('Continue reviewing');
});

for (const refreshFirst of [true, false]) test(`focus refresh never supersedes a pending watch action (refresh first: ${refreshFirst})`, async ({ page }) => {
    await openSession(page);
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([link]) });
    await host(page, { type: 'openPullRequests' });
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    const action = (await sent(page)).filter(message => message.type === 'pullRequestAction').at(-1)!;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const refresh = (await sent(page)).filter(message => message.type === 'pullRequestsGetState').at(-1)!;
    expect(refresh.requestId).not.toBe(action.requestId);
    if (refreshFirst) {
        await host(page, { type: 'pullRequestsState', sessionId: 'session-a', requestId: refresh.requestId, state: state([link]) });
        await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeDisabled();
    }
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', requestId: action.requestId, state: state([{ ...link, watch: watching }]) });
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeEnabled();
    if (!refreshFirst) await host(page, { type: 'pullRequestsState', sessionId: 'session-a', requestId: refresh.requestId, state: state([link]) });
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeEnabled();
    await expect(page.locator('.pr-indicator')).toHaveCount(0);
});

test('PR state refreshes remotely without disabling Watch during background reads', async ({ page }) => {
    await page.clock.install();
    await openSession(page);
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([link]) });
    await host(page, { type: 'openPullRequests' });
    const before = (await sent(page)).filter(message => message.type === 'pullRequestsGetState').length;
    await page.clock.fastForward(30_000);
    const reads = (await sent(page)).filter(message => message.type === 'pullRequestsGetState');
    expect(reads).toHaveLength(before + 1);
    expect(reads.at(-1)).toMatchObject({ refresh: true });
    await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeEnabled();
    await reply(page, state([{ ...link, snapshot: { ...link.snapshot, checks: link.snapshot.checks.map(check => ({ ...check, status: 'success' })) } }]));
    await expect(page.locator('.pr-detail').first().locator('summary')).toContainText('2 passed');
});


test('a timed-out watch action releases the controls and allows background refresh to recover', async ({ page }) => {
    await page.clock.install();
    await openSession(page);
    await host(page, { type: 'pullRequestsState', sessionId: 'session-a', state: state([link]) });
    await host(page, { type: 'openPullRequests' });
    await page.getByRole('button', { name: 'Watch', exact: true }).click();
    const reads = (await sent(page)).filter(message => message.type === 'pullRequestsGetState').length;
    await page.clock.fastForward(50_000);
    await expect(page.getByRole('button', { name: 'Watch', exact: true })).toBeEnabled();
    await page.clock.fastForward(30_000);
    expect((await sent(page)).filter(message => message.type === 'pullRequestsGetState')).toHaveLength(reads + 1);
    await reply(page, state([{ ...link, watch: watching }]));
    await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeEnabled();
});

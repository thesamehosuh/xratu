/**
 * Browser smoke tests for the built webview bundle (dist/webview-ui).
 *
 * Drives the app with a mocked `acquireVsCodeApi` and real `FromExtensionMessage`
 * envelopes posted via `window.postMessage` — no VS Code host required.
 */
import { installVscodeTheme } from './vscodeTheme';
import { postHostMessageAndWait } from './hostMessages';
import { openPageNavigation, openSettingsFromWork } from './navigation';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as Record<string, unknown>).__xratuHostMessages = sent;
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (message: unknown) => { sent.push(message); },
            getState: () => undefined,
            setState: (state: unknown) => state,
        });
    });
});

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

test('app shell boots in RTL fa, posts webviewReady, mounts welcome/chat, and flips locale preserving content dir', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();
    await expect(page.locator('.app')).toHaveAttribute('dir', 'rtl');
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sent).toContainEqual({ type: 'webviewReady' });

    await hostMessage(page, { type: 'showWelcome' });
    await expect(page.locator('.onboarding')).toBeVisible();

    await hostMessage(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', customPath: '', installedByXratu: false, busy: false } });
    await hostMessage(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await hostMessage(page, { type: 'restoreUser', value: 'سلام' });
    const bubble = page.locator('article.msg.user').first();
    await expect(bubble).toHaveAttribute('dir', 'auto');
    await expect(bubble).toHaveCSS('direction', 'rtl');

    await hostMessage(page, { type: 'locale', locale: 'en' });
    await expect(page.locator('.app')).toHaveAttribute('dir', 'ltr');
    await expect(bubble).toHaveAttribute('dir', 'auto');
    await expect(bubble).toHaveCSS('direction', 'rtl');
    await expect(bubble.getByRole('button', { name: 'Edit message', exact: true })).toBeVisible();
});

test('chat costs stay hidden, Usage opens via Settings, and composer draft survives navigation until accepted', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await expect(page.locator('.session-cost')).toHaveCount(0);
    await hostMessage(page, { type: 'sessionCost', cost: { amount: 0.0046, currency: 'USD' } });
    await expect(page.locator('.session-cost')).toHaveCount(0);

    const input = page.locator('.composer-input');
    await input.fill('half-written message');
    await hostMessage(page, { type: 'openSettings' });
    await expect(input).toHaveCount(1);
    await expect(input).toBeHidden();

    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: 'مصرف', exact: true }).click();
    await expect(page.locator('.settings-nav-row')).toHaveCount(0);
    const asked = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(asked).toContainEqual({ type: 'usageGetState' });
    await hostMessage(page, {
        type: 'usageState',
        providers: [{ host: 'openode.ai', label: 'OpenCode Go', iranian: false, input: 300, output: 30, cached: 0, USD: 0.0068, IRT: 0 }],
        rates: [],
        history: [],
        allTime: { input: 300, output: 30, cached: 0, USD: 0.0068, IRT: 0 },
    });
    await expect(page.locator('.usage-activity-chart h3', { hasText: 'روند مصرف توکن' })).toBeVisible();

    // Back returns to the chat composer with the draft intact.
    await page.locator('.toolbar-back-work').click();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('half-written message');

    // Accepted send clears the draft cleanly across subsequent navigation.
    await input.press('Enter');
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'askQuestion', value: 'half-written message' }));
    const request = (sent as Array<{ type: string; requestId?: string }>).findLast(message => message.type === 'askQuestion')!;
    await hostMessage(page, { type: 'sendReceipt', requestId: request.requestId, sessionKey: '', status: 'accepted' });
    await hostMessage(page, { type: 'openSettings' });
    await page.locator('.toolbar-back-work').click();
    await expect(input).toHaveValue('');
});

test('git status bar sits under the composer and opens a filterable branch drop-up', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'gitStatusState', root: null, status: { isRepo: false, branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
    await expect(page.locator('.git-status')).toHaveCount(0);

    await hostMessage(page, { type: 'gitStatusState', root: '~/Projects/xratu', status: { isRepo: true, branch: 'main', detached: false, upstream: 'origin/main', ahead: 1, behind: 0, staged: 2, modified: 1, untracked: 3, conflicted: 0 } });
    const bar = page.locator('.git-status');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.git-status-branch')).toHaveText('main');
    await expect(bar.locator('.git-status-stats')).toContainText('2');
    await expect(bar.locator('.git-status-path')).toHaveText('~/Projects/xratu');

    const pathBox = await bar.locator('.git-status-path').boundingBox();
    const branchBox = await bar.locator('.git-status-branch').boundingBox();
    const statsBox = await bar.locator('.git-status-stats').boundingBox();
    expect(pathBox!.x).toBeLessThan(branchBox!.x);
    expect(branchBox!.x).toBeLessThan(statsBox!.x);
    expect(pathBox!.x).toBeGreaterThanOrEqual(11);

    const inputBox = await page.locator('.composer-input').boundingBox();
    const barBox = await bar.boundingBox();
    expect(barBox!.y).toBeGreaterThan(inputBox!.y);
    const nested = await page.evaluate(() => {
        const barEl = document.querySelector('.git-status');
        const card = document.querySelector('.composer-input')?.closest('[class*="composer"]');
        return !!(card && barEl && card.contains(barEl));
    });
    expect(nested).toBe(false);

    const sent = () => page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<Record<string, unknown>>);
    await bar.click();
    await expect.poll(async () => (await sent()).some((m) => m.type === 'gitBranchesGetState')).toBe(true);
    await hostMessage(page, { type: 'gitBranchesState', branches: ['chore/a', 'feat/x', 'main'], current: 'main' });

    const pop = page.locator('.branch-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.mention-item')).toHaveCount(3);
    const popBox = await pop.boundingBox();
    const cardBox = await page.locator('.composer').boundingBox();
    expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(cardBox!.y + 1);
    await expect(pop.locator('.branch-current')).toHaveCount(1);

    await pop.locator('.mention-input').fill('feat');
    await expect(pop.locator('.mention-item')).toHaveCount(1);
    await pop.locator('.mention-item').click();
    expect(await sent()).toContainEqual({ type: 'gitCheckout', branch: 'feat/x' });
    await expect(page.locator('.branch-pop')).toHaveCount(0);

    await bar.click();
    await expect(page.locator('.branch-pop')).toBeVisible();
    await page.locator('article.msg, .composer-input').first().click({ force: true });
    await expect(page.locator('.branch-pop')).toHaveCount(0);

    await bar.click();
    await expect(page.locator('.branch-pop')).toBeVisible();
    await bar.click();
    await expect(page.locator('.branch-pop')).toHaveCount(0);
});

test('long history pages, reveals earlier messages, and collapses back on returning to tail', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'sessionState', id: 's1', title: null });
    for (let i = 0; i < 50; i++) {
        await hostMessage(page, { type: 'restoreUser', value: `msg ${i}` });
    }
    const bubbles = page.locator('article.msg.user');
    await expect(bubbles).toHaveCount(40);
    await expect(page.locator('.show-earlier')).toBeVisible();
    await expect(page.getByText('msg 0', { exact: true })).toHaveCount(0);

    await page.locator('.show-earlier').click();
    await expect(bubbles).toHaveCount(50);
    await expect(page.getByText('msg 0', { exact: true })).toBeVisible();

    // Leave the tail and return: mounted window collapses back to one page.
    await page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.jump-btn')).toBeVisible();
    await page.locator('.messages').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(bubbles).toHaveCount(40);
    await expect(page.locator('.show-earlier')).toBeVisible();
    await expect(page.getByText('msg 49', { exact: true })).toBeVisible();
});

test('a tall mixed restore replay stays paged without expanding the whole transcript', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'sessionState', id: 's3', title: null });
    const tall = 'lorem ipsum dolor sit amet '.repeat(40);
    for (let i = 0; i < 25; i++) {
        await hostMessage(page, { type: 'restoreUser', value: `turn ${i} ${tall}` });
        await hostMessage(page, { type: 'startResponse' });
        await hostMessage(page, { type: 'thinking', value: `reasoning ${i} ${tall}` });
        await hostMessage(page, { type: 'thinkingHtml', value: `<p>reasoning ${i}</p>` });
        await hostMessage(page, { type: 'toolCall', tool: 'read_file', args: '{}', callId: `c${i}` });
        await hostMessage(page, { type: 'toolResult', tool: 'read_file', output: tall, callId: `c${i}` });
        await hostMessage(page, { type: 'fullResponse', persian: `answer ${i}` });
    }
    await expect(page.locator('article.msg')).toHaveCount(40);
    await expect(page.locator('.show-earlier')).toBeVisible();
    await expect(page.getByText(/turn 0 /)).toHaveCount(0);
});

test('appending while scrolled up keeps the reader anchor', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'sessionState', id: 's2', title: null });
    for (let i = 0; i < 40; i++) {
        await hostMessage(page, { type: 'restoreUser', value: `msg ${i}` });
    }
    const bubbles = page.locator('article.msg.user');
    await expect(bubbles).toHaveCount(40);
    const transcript = page.locator('.messages');
    await transcript.evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.jump-btn')).toBeVisible();
    await page.evaluate(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreUser', value: 'msg x' } }));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'restoreUser', value: 'msg y' } }));
    });
    await expect(bubbles).toHaveCount(42);
    await expect(page.getByText('msg 0', { exact: true })).toBeInViewport();
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(0);
    await expect(page.locator('.show-earlier')).toHaveCount(0);
});

test('edit pill open-diff, turn outcome review vs no-diff turn, and checkpoint restore', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });

    // Edit pill open-diff button posts full call payload.
    await hostMessage(page, { type: 'restoreUser', value: 'Review these changes', cp: 'abc1234' });
    await hostMessage(page, { type: 'startResponse' });
    const args = JSON.stringify({ path: 'src/a.ts', patch: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' });
    await hostMessage(page, { type: 'toolCall', tool: 'apply_patch', args, callId: 'c-open' });
    await hostMessage(page, { type: 'toolResult', tool: 'apply_patch', output: 'done', callId: 'c-open' });
    const openBtn = page.locator('button[title="Open diff in editor"]').first();
    await expect(openBtn).toBeVisible();
    await openBtn.click();
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages)).toContainEqual({
        type: 'openDiff',
        edits: [{ tool: 'apply_patch', args, callId: 'c-open', result: 'done' }],
    });

    await hostMessage(page, { type: 'fullResponse', persian: 'Changes complete.', renderedHtml: '<p>Changes complete.</p>' });
    await expect.poll(async () => {
        const box = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages) as Array<Record<string, unknown>>;
        const request = box.filter((message) => message.type === 'changesGetState').at(-1);
        if (!request) return false;
        await hostMessage(page, { ...request, type: 'changesState', files: [{ path: 'src/changed.ts', added: 3, removed: 1, binary: false, untracked: false }] });
        return (await page.locator('.outcome-review').count()) > 0;
    }).toBe(true);
    const review = page.locator('.outcome-review');
    await expect(review).toBeVisible();
    await expect(page.locator('.msg-footer button[aria-label="Review changes"]')).toHaveCount(0);
    await page.locator('button[aria-label="Restore files"]').click();
    await expect.poll(async () => (await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages) as Array<Record<string, unknown>>).filter(message => message.type === 'restoreCheckpoint').at(-1)).toMatchObject({ userIndex: 0, sha: 'abc1234' });
    await expect(page.locator('button[aria-label="Regenerate response"]')).toHaveCount(0);
    await review.click();
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages) as Array<Record<string, unknown>>;
    expect(sent.some((message) => message.type === 'changesGetState' && message.sha === 'abc1234')).toBe(true);
    await expect(page.locator('.changes-pane')).toBeVisible();
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(review).toBeHidden();
    await expect(page.locator('.changes-pane')).toBeVisible();

    // A turn with no diff renders no outcome buttons.
    await page.setViewportSize({ width: 420, height: 900 });
    await hostMessage(page, { type: 'sessionState', id: 'empty-diff-session', title: null });
    await hostMessage(page, { type: 'restoreUser', value: 'Nothing to change', cp: 'def5678' });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, { type: 'fullResponse', persian: 'Nothing changed.', renderedHtml: '<p>Nothing changed.</p>' });
    await expect.poll(async () => {
        const box = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages) as Array<Record<string, unknown>>;
        return box.some((message) => message.type === 'changesGetState' && message.sha === 'def5678');
    }).toBe(true);
    const req = ((await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages)) as Array<Record<string, unknown>>)
        .filter((message) => message.type === 'changesGetState' && message.sha === 'def5678').at(-1)!;
    await postHostMessageAndWait(page, { ...req, type: 'changesState', files: [] });
    await expect(page.locator('.review-current .surface-empty-state')).toContainText('No changes since this checkpoint.');
    await expect(page.locator('.turn-outcome')).toHaveCount(0);
});

test('capabilities refresh spinner keeps spinning until EVERY echo arrives', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await openSettingsFromWork(page);
    await openPageNavigation(page);
    await page.locator('.sidebar-item[data-section="mcp"]').click();
    await hostMessage(page, { type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false });
    await hostMessage(page, { type: 'skillsState', skills: [] });
    const spinner = page.locator('.settings-head .spinning');
    await expect(spinner).toHaveCount(0);
    await page.getByTitle('بروزرسانی').click();
    await hostMessage(page, { type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false });
    await page.clock.fastForward(1000);
    await expect(spinner).toBeVisible();
    await hostMessage(page, { type: 'skillsState', skills: [] });
    await expect(spinner).toHaveCount(0);
});

test('stream follow survives shrink-clamps and a large edit pill', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'transcriptPrefs', prefs: { expand: { edit: true } } });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'restoreUser', value: 'Refactor the handlers module' });
    await hostMessage(page, { type: 'startResponse' });
    for (let i = 0; i < 10; i++) {
        await hostMessage(page, { type: 'chunk', value: `Paragraph ${i}. Analyzing the module structure and exports.\n\n` });
    }
    await hostMessage(page, { type: 'thinking', value: 'Short replacement plan.' });
    const bigPatch = Array.from({ length: 12 }, (_, i) =>
        `<<<<<<< SEARCH\nfunction handler${i}(event) {\n    return format(compute(event.data, ${i}));\n}\n=======\nfunction handler${i}(event) {\n    const value = computeV2(event.data, ${i});\n    if (!value) return fallback(${i});\n    return format(value, { dense: true });\n}\n>>>>>>> REPLACE`,
    ).join('\n');
    await hostMessage(page, { type: 'toolCall', tool: 'apply_patch', args: JSON.stringify({ path: 'src/handlers.ts', patch: bigPatch }), callId: 'c2' });
    await hostMessage(page, { type: 'toolResult', tool: 'apply_patch', callId: 'c2', output: 'Patch applied cleanly.' });
    const distFromBottom = () => page.evaluate(() => {
        const el = document.querySelector('.messages')!;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    await expect.poll(distFromBottom).toBeLessThan(80);
    for (let i = 0; i < 4; i++) {
        await hostMessage(page, { type: 'chunk', value: `Post-edit note ${i}. All twelve handlers now route through v2.\n\n` });
    }
    await hostMessage(page, { type: 'fullResponse', renderedHtml: '<p>Refactor complete.</p>' });
    await expect.poll(distFromBottom).toBeLessThan(80);
});

test('cost page: stacked model chart, month stepper, filters, provider list (fa/RTL)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await openSettingsFromWork(page);
    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: 'مصرف', exact: true }).click();

    const asked = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(asked).toContainEqual({ type: 'usageGetState' });

    const history = [
        { day: '2026-07-10', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 100, output: 10, cached: 0, USD: 1, IRT: 5000 }] },
        { day: '2026-07-11', cells: [
            { model: 'gpt-4o', host: 'a.ir', input: 200, output: 20, cached: 0, USD: 2, IRT: 0 },
            { model: 'glm-5.3', host: 'a.ir', input: 50, output: 5, cached: 0, USD: 0.5, IRT: 700 },
        ] },
        { day: '2026-08-05', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 300, output: 30, cached: 0, USD: 0, IRT: 9000 }] },
    ];
    await hostMessage(page, {
        type: 'usageState',
        providers: [
            { host: 'a.ir', label: 'Avalai', iranian: true, input: 650, output: 65, cached: 0, USD: 6.5, IRT: 14000 },
            { host: 'b.ir', label: 'Metis', iranian: true, input: 400, output: 40, cached: 12, USD: 0, IRT: 95000 },
        ],
        rates: [
            { id: 'gpt-4o', host: '', input: 1, output: 2, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 14000 },
            { id: 'glm-5.3', host: 'a.ir', input: 0.15, output: 0.5, cachedInput: 0.03, currency: 'USD', source: 'builtin', USD: 0.5, IRT: 0 },
            { id: 'glm-5.3', host: 'b.ir', input: 0.3, output: 1, cachedInput: 0.03, currency: 'USD', source: 'gateway', USD: 1.2, IRT: 0 },
            { id: 'mystery-local', host: 'a.ir', input: 0, output: 0, cachedInput: null, currency: 'USD', source: 'unknown', USD: 0, IRT: 0 },
        ],
        history,
        allTime: { input: 1050, output: 105, cached: 12, USD: 6.5, IRT: 109000 },
    });
    await page.locator('.usage-view-tabs button').nth(1).click();
    await expect(page.locator('.cost-col')).toHaveCount(31);
    await expect(page.locator('.cost-legend-item')).toHaveCount(1);
    await expect(page.locator('.cost-legend-item')).toContainText('gpt-4o');
    await expect(page.locator('.cost-currencies')).toHaveCount(0);
    await expect(page.locator('.cost-col:not([aria-label$="-"])')).toHaveCount(1);

    await page.getByLabel('ماه قبل').click();
    await expect(page.locator('.cost-legend-item')).toHaveCount(2);
    await expect(page.locator('.cost-legend')).toContainText('glm-5.3');
    await expect(page.getByLabel('ماه قبل')).toBeDisabled();
    await expect(page.locator('.cost-currencies')).toBeVisible();

    await page.locator('.cost-col:not([aria-label$="-"])').first().hover();
    await expect(page.locator('.cost-detail')).toContainText('تیر');
    const chartHeightHovered = (await page.locator('.usage-activity-chart').boundingBox())!.height;
    const providersTopHovered = (await page.locator('.usage-breakdown').boundingBox())!.y;
    await page.mouse.move(5, 5);
    await expect(page.locator('.cost-detail')).toContainText('مصرف بازه انتخاب شده');
    const chartHeightIdle = (await page.locator('.usage-activity-chart').boundingBox())!.height;
    const providersTopIdle = (await page.locator('.usage-breakdown').boundingBox())!.y;
    expect(Math.round(chartHeightHovered)).toBe(Math.round(chartHeightIdle));
    expect(Math.round(providersTopHovered)).toBe(Math.round(providersTopIdle));

    await page.locator('.cost-currencies .usage-range', { hasText: 'دلار' }).click();
    await expect(page.locator('.cost-axis')).toContainText('$');
    await page.getByLabel('ماه بعد').click();
    await expect(page.locator('.cost-currencies')).toHaveCount(0);
    await expect(page.locator('.cost-col:not([aria-label$="-"])')).toHaveCount(1);
    await expect(page.locator('.cost-axis')).toContainText('هزار');

    const modelFilter = page.locator('.cost-filters .dropdown').first();
    await page.getByLabel('ماه قبل').click();
    await modelFilter.locator('.dropdown-trigger').click();
    await page.getByRole('option', { name: 'glm-5.3', exact: true }).click();
    await expect(page.locator('.cost-legend-item')).toHaveCount(1);
    await expect(page.locator('.cost-legend-item')).toContainText('glm-5.3');

    await modelFilter.locator('.dropdown-trigger').click();
    await page.getByRole('option', { name: 'همه مدل ها', exact: true }).click();
    await page.locator('.cost-granularity .usage-range', { hasText: 'هفته' }).click();
    await expect(page.locator('.cost-col')).toHaveCount(7);
    await expect(page.locator('.cost-granularity .usage-range.active')).toContainText('هفته');
    await expect(page.locator('.cost-period-label')).toContainText('–');
    await page.getByLabel('هفته قبل').click();
    await expect(page.locator('.usage-activity-chart .usage-empty')).toBeVisible();
    await page.getByLabel('هفته قبل').click();
    await page.getByLabel('هفته قبل').click();
    await expect(page.locator('.cost-col')).toHaveCount(7);
    await page.locator('.cost-granularity .usage-range', { hasText: 'ماه' }).click();
    await expect(page.locator('.cost-col')).toHaveCount(31);

    await page.locator('.usage-breakdown-tabs button').nth(1).click();
    const providerRows = page.locator('.prov-row');
    await expect(providerRows).toHaveCount(1);
    await expect(providerRows.first()).toContainText('Avalai');
    await expect(providerRows.locator('.pricing-badge')).toHaveCount(1);
    await expect(providerRows.first().locator('.usage-model-tokens')).toHaveText('۳۳۰');
    await expect(page.locator('.usage-input-total')).toHaveText('۳۰۰');
    await expect(page.locator('.usage-output-total')).toHaveText('۳۰');
    await expect(page.locator('.usage-lifetime')).toContainText('۱٬۱۵۵');
    await expect(page.locator('.cost-dates')).toBeVisible();
    await page.locator('.rate-disclosure > summary').click();

    const rateRows = page.locator('.rate-row');
    await expect(rateRows).toHaveCount(4);
    const overrideRow = rateRows.filter({ hasText: 'gpt-4o' });
    await expect(overrideRow).toContainText('نرخ شما');
    await expect(overrideRow.locator('.rate-values')).toContainText('1');
    await expect(overrideRow.locator('.usage-cost')).toContainText('تومان');
    const unknownRow = rateRows.filter({ hasText: 'mystery-local' });
    await expect(unknownRow).toContainText('نامعلوم');
    await expect(unknownRow.locator('.rate-unknown')).toBeVisible();
    const glmRows = rateRows.filter({ hasText: 'glm-5.3' });
    await expect(glmRows).toHaveCount(2);
    await expect(glmRows.nth(0)).toContainText('a.ir');
    await expect(glmRows.nth(1)).toContainText('b.ir');
    await expect(glmRows.nth(1)).toContainText('نرخ گیت وی');

    const builtinRow = glmRows.nth(0);
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    await builtinRow.locator('.icon-btn').click();
    await expect(builtinRow.locator('.rate-pop')).toBeVisible();
    await expect(builtinRow.locator('.rate-edit-grid')).toBeVisible();
    await expect(builtinRow.locator('.settings-ghost-action', { hasText: 'بازگشت' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    await builtinRow.locator('.icon-btn').click();
    await builtinRow.locator('.num-field input').first().fill('0.2');
    await builtinRow.locator('.settings-primary-action').click();
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages)).toContainEqual({
        type: 'usageSaveModel', id: 'glm-5.3', input: 0.2, output: 0.5, cachedInput: 0.03, currency: 'USD',
    });
    await overrideRow.locator('.icon-btn').click();
    await expect(overrideRow.locator('.settings-ghost-action', { hasText: 'بازگشت' })).toBeVisible();
    await page.keyboard.press('Escape');

    await unknownRow.locator('.icon-btn').click();
    await expect(unknownRow.locator('.num-field input').first()).toHaveValue('');
    await expect(unknownRow.locator('.settings-primary-action')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.locator('.rate-disclosure[open]')).toBeVisible();

    await expect(page.locator('.pricing-add')).toHaveCount(0);
    await page.locator('.rates-add-toggle').click();
    const add = page.locator('.pricing-add .settings-primary-action');
    const rateInput = page.locator('.pricing-add .num-field input');
    await expect(add).toBeDisabled();
    await page.locator('.pricing-add .pricing-add-id input').fill('my-model');
    await rateInput.first().fill('1');
    await page.locator('.pricing-add .num-step').first().click();
    await expect(rateInput.first()).toHaveValue('2');
    await page.locator('.pricing-add .num-step').nth(1).click();
    await expect(rateInput.first()).toHaveValue('1');
    await expect(add).toBeDisabled();
    await rateInput.nth(1).fill('2');
    await add.click();
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages)).toContainEqual({
        type: 'usageSaveModel', id: 'my-model', input: 1, output: 2, cachedInput: null, currency: 'USD',
    });

    await page.setViewportSize({ width: 420, height: 320 });
    await page.locator('.cost-filters .dropdown').first().locator('.dropdown-trigger').click();
    const listBox = await page.locator('.dropdown-list').boundingBox();
    expect(listBox!.y).toBeGreaterThanOrEqual(0);
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(320);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 420, height: 900 });
    expect(await page.evaluate(() => {
        const el = document.querySelector('.settings-scroll')!;
        return el.scrollWidth - el.clientWidth;
    })).toBeLessThanOrEqual(1);
});

test('steering queues during tools and delegated work without cancelling and renders bubble on steerApplied', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'restoreUser', value: 'do a then b' });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, { type: 'chunk', value: 'first part ' });
    await hostMessage(page, { type: 'toolCall', tool: 'read_file', args: '{}', callId: 'c1' });

    const userBefore = await page.locator('.msg.user').count();
    const assistantBefore = await page.locator('.msg.assistant').count();
    await page.locator('.composer-input').fill('also check b.txt');
    await page.locator('.composer-input').press('Enter');
    await expect(page.locator('.queued-message')).toHaveCount(1);
    await expect(page.locator('.queued-message')).toContainText('also check b.txt');
    const chipsBox = await page.locator('.queued-steers').boundingBox();
    const composerBox = await page.locator('.composer').boundingBox();
    expect(Math.abs(chipsBox!.x - composerBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(chipsBox!.width - composerBox!.width)).toBeLessThanOrEqual(1);
    expect(await page.locator('.msg.user').count()).toBe(userBefore);
    expect(await page.locator('.msg.assistant').count()).toBe(assistantBefore);
    expect(await page.locator('.msg.user.steered').count()).toBe(0);

    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<{ type: string; steerId?: string }>);
    const steerId = sent.find((m) => m.type === 'steerRun')?.steerId;
    expect(steerId).toBeTruthy();
    await page.getByRole('button', { name: 'Steer now', exact: true }).click();
    const controls = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<{ type: string; steerId?: string }>);
    expect(controls.filter(message => message.type === 'steerNow')).toEqual([{ type: 'steerNow', steerId }]);
    expect(controls.some(message => message.type === 'cancelRequest')).toBe(false);
    await expect(page.locator('.queued-message')).toHaveCount(1);

    await hostMessage(page, { type: 'toolResult', tool: 'read_file', output: 'r', callId: 'c1' });
    await hostMessage(page, { type: 'steerApplied', steerId });
    await expect(page.locator('.msg.user.steered')).toHaveCount(1);
    await expect(page.locator('.msg.user.steered')).toContainText('also check b.txt');
    await expect(page.locator('.queued-message')).toHaveCount(0);

    // Delegated task steering in narrow RTL keeps Steer now inside bounds and stacks multiple steers.
    await hostMessage(page, { type: 'locale', locale: 'fa' });
    await hostMessage(page, { type: 'toolCall', tool: 'task', args: '{"prompt":"Inspect files"}', callId: 'child-running' });
    const input = page.locator('.composer-input');
    await input.fill('اول تست ها رو بررسی کن');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await expect(page.locator('.queued-message')).toHaveCount(1);
    const now = page.locator('.queued-steer-now');
    await expect(now).toBeVisible();
    const box = await now.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(420);
    await now.click();
    await input.fill('A second correction');
    await input.press('Enter');
    await expect(page.locator('.queued-message')).toHaveCount(2);
    await hostMessage(page, { type: 'locale', locale: 'en' });
    const lastQueued = page.locator('.queued-message').last();
    await input.fill('Keep this ordinary draft');
    await lastQueued.getByRole('button', { name: 'Edit queued message' }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('A second correction');
    await input.fill('An edited correction');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const mutation = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<{ type: string; steerId: string; value?: string }>);
    const edit = mutation.find(m => m.type === 'updateQueuedSteer')!;
    expect(edit.value).toBe('An edited correction');
    await hostMessage(page, { type: 'steerEditResult', accepted: true, steerId: edit.steerId, value: edit.value });
    await expect(lastQueued).toContainText('An edited correction');
    await expect(input).toHaveValue('Keep this ordinary draft');
    await lastQueued.getByRole('button', { name: 'Edit queued message' }).click();
    await input.fill('Unsaved correction');
    await hostMessage(page, { type: 'steerApplied', mode: 'steer', steerId: edit.steerId });
    await expect(input).toHaveValue('Keep this ordinary draft');
    await expect(page.getByText('Unsaved correction', { exact: true })).toBeVisible();
    await expect(page.locator('.queued-message')).toHaveCount(1);
    const afterDelegated = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<{ type: string }>);
    expect(afterDelegated.filter(message => message.type === 'steerRun')).toHaveLength(3);
    expect(afterDelegated.filter(message => message.type === 'steerNow')).toHaveLength(2);
    expect(afterDelegated.some(message => message.type === 'cancelRequest' || message.type === 'subagentStop')).toBe(false);
});

test('context meter switch flips optimistically and follows host echo', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await expect(page.locator('.tok-pct')).toHaveCount(0);
    await expect(page.locator('.ctx-wrap')).toHaveCount(0);
    await expect(page.locator('.ctx-trigger')).toHaveCount(0);

    await hostMessage(page, { type: 'openSettings' });
    const contextMeter = page.getByRole('switch', { name: 'Show context window meter', exact: true });
    await expect(contextMeter).toHaveAttribute('aria-checked', 'false');
    await contextMeter.click();
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages))
        .toContainEqual({ type: 'transcriptOptionsSet', options: { showContextMeter: true } });
    await expect(contextMeter).toHaveAttribute('aria-checked', 'true');
    await contextMeter.click();
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages))
        .toContainEqual({ type: 'transcriptOptionsSet', options: { showContextMeter: false } });
    await hostMessage(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: false } } });
    await expect(contextMeter).toHaveAttribute('aria-checked', 'false');
    await contextMeter.click();
    await hostMessage(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
    await expect(contextMeter).toHaveAttribute('aria-checked', 'true');
    await hostMessage(page, { type: 'showChat' });
    await page.locator('.composer-input').focus();
    await expect(page.locator('.tok-pct')).toBeVisible();
    await hostMessage(page, { type: 'transcriptPrefs', prefs: { expand: {} } });
    await expect(page.locator('.tok-pct')).toHaveCount(0);
});

test('reasoning body stays LTR in fa while pill label stays RTL, and hidden monitor wakes stay silent', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'fa' });
    await hostMessage(page, { type: 'restoreUser', value: 'سلام' });
    await hostMessage(page, { type: 'restoreUser', value: 'PR monitor notification', hidden: true });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { reasoning: 'collapsed' } } });
    await hostMessage(page, { type: 'thinking', value: 'seed' });
    await hostMessage(page, { type: 'thinkingHtml', value: '<p>English reasoning that must not be reordered by the UI locale.</p>' });
    await page.locator('.step-think > summary').click();
    const body = page.locator('.step-think-body');
    await expect(body).toHaveAttribute('dir', 'ltr');
    expect(await body.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
    await expect(page.locator('.step-think .step-label').first()).toHaveCSS('direction', 'rtl');

    await hostMessage(page, { type: 'fullResponse', persian: 'I checked the new review.', renderedHtml: '<p>I checked the new review.</p>' });

    await expect(page.locator('article.msg.user')).toHaveCount(1);
    await expect(page.locator('.transcript-pane')).not.toContainText('PR monitor notification');
    await expect(page.locator('.transcript-pane')).toContainText('I checked the new review.');
    await expect(page.locator('.queued-message,.pr-indicator')).toHaveCount(0);
});

test('calm entry hides chips, workspaceKind switches chip sets, and fresh workspace accepts prompts', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });
    // Default workspaceKind (omitted) keeps established-project chips hidden behind calm entry.
    await expect(page.locator('.composer-welcome')).toBeVisible();
    await expect(page.locator('.chip-suggest').first()).toBeHidden();
    await expect(page.locator('.chip-suggest'))
        .toHaveText(['Tour this codebase', 'Hunt for bugs', 'Write tests', 'Optimize it']);

    await hostMessage(page, { type: 'locale', locale: 'fa' });
    await expect(page.locator('.composer-welcome')).toBeVisible();
    await expect(page.locator('.chip-suggest').first()).toBeHidden();

    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat', workspaceKind: 'empty' });
    await expect(page.locator('.chip-suggest'))
        .toHaveText(['Build something new', 'Set up this folder', 'Plan it with me first', 'Bring my code in']);
    await hostMessage(page, { type: 'showChat', workspaceKind: 'bare' });
    await expect(page.locator('.chip-suggest').first()).toHaveText('Build something new');
    await hostMessage(page, { type: 'showChat', workspaceKind: 'project' });
    await expect(page.locator('.chip-suggest'))
        .toHaveText(['Tour this codebase', 'Hunt for bugs', 'Write tests', 'Optimize it']);

    await hostMessage(page, { type: 'showChat', workspaceKind: 'empty' });
    await page.locator('.composer-input').fill('Build a new application');
    await page.locator('.composer-input').press('Enter');
    expect(await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages))
        .toContainEqual(expect.objectContaining({ type: 'askQuestion', value: 'Build a new application' }));
});

test('message copy shows success only after the host confirms the write', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'restoreUser', value: 'Copy this message' });
    const copy = page.locator('article.msg.user').getByRole('button', { name: 'Copy answer' });
    const latestRequest = () => page.evaluate(() => ((window as Record<string, unknown>).__xratuHostMessages as Array<Record<string, unknown>>)
        .filter(message => message.type === 'copyToClipboard').at(-1));
    await copy.click();
    const failed = await latestRequest();
    expect(failed).toMatchObject({ requestId: expect.any(String), value: 'Copy this message' });
    await expect(copy.locator('.lucide-copy')).toBeVisible();
    await hostMessage(page, { type: 'clipboardResult', requestId: failed?.requestId, ok: false });
    await expect(copy.locator('.lucide-copy')).toBeVisible();
    await copy.click();
    const successful = await latestRequest();
    expect(successful?.requestId).not.toBe(failed?.requestId);
    await hostMessage(page, { type: 'clipboardResult', requestId: successful?.requestId, ok: true });
    await expect(copy.locator('.lucide-check')).toBeVisible();
});

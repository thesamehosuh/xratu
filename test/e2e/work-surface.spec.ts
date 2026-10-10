import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme, VSCODE_LIGHT_THEME_CSS } from './vscodeTheme';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const post = (page: Page, message: Record<string, unknown>) => page.evaluate((msg) => window.postMessage(msg, '*'), message);
const sent = (page: Page): Promise<Array<Record<string, unknown>>> => page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
const latest = async (page: Page, type: string, afterRequestId?: unknown) => {
    await expect.poll(async () => {
        const message = (await sent(page)).filter((m) => m.type === type).at(-1);
        return !!message && (afterRequestId === undefined || message.requestId !== afterRequestId);
    }).toBe(true);
    return (await sent(page)).filter((m) => m.type === type).at(-1)!;
};
const changes = [
    { path: 'src/first.ts', added: 1, removed: 1, binary: false },
    { path: 'src/second.ts', added: 1, removed: 0, binary: false, untracked: true },
];
const replyFile = async (page: Page, after = 'new', afterRequestId?: unknown) => {
    const request = await latest(page, 'changeFileGet', afterRequestId);
    await post(page, { ...request, file: { path: request.path, kind: 'text', before: 'old', after,
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: after.split('\n').length, removedLines: ['old'], addedLines: after.split('\n') }] }, type: 'changeFileState' });
};
const openReview = async (page: Page) => {
    await post(page, { type: 'restoreUser', value: 'Fix this', cp: sha });
    const request = await latest(page, 'changesGetState');
    await post(page, { ...request, type: 'changesState', files: changes });
    if (await page.locator('#surface-tab-changes').isVisible()) await page.locator('#surface-tab-changes').click();
    await replyFile(page);
    await expect(page.locator('.review-diff')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        const state = window as unknown as { __xratuUiState?: unknown };
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => state.__xratuUiState, setState: (s: unknown) => { state.__xratuUiState = s; return s; } }) });
    });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
});

for (const locale of ['en', 'fa']) {
    test(`review sidebar resizes by pointer and keyboard, preserves other state and survives reload (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 900 });
        await post(page, { type: 'locale', locale });
        await page.locator('.composer-input').fill('Keep my draft');
        await page.evaluate(() => Object.assign(window, { __xratuUiState: { anotherPreference: 'preserved' } }));
        const handle = page.locator('.review-resize');
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();
        const x = box!.x + box!.width / 2;
        await page.mouse.move(x, box!.y + 80);
        await page.mouse.down();
        await page.mouse.move(x + (locale === 'fa' ? 120 : -120), box!.y + 80, { steps: 8 });
        await page.mouse.up();
        await expect(handle).toHaveAttribute('aria-valuenow', '470');
        const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: Record<string, unknown> }).__xratuUiState);
        expect(saved).toEqual({ anotherPreference: 'preserved', reviewSidebarWidth: 470 });
        await handle.focus();
        await page.keyboard.press('Home');
        await expect(handle).toHaveAttribute('aria-valuenow', '260');
        await page.keyboard.press('End');
        await expect(handle).toHaveAttribute('aria-valuenow', '540');
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(handle).toBeHidden();
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        await page.setViewportSize({ width: 1080, height: 900 });
        await expect(handle).toHaveAttribute('aria-valuenow', '540');
        await page.addInitScript((state) => Object.assign(window, { __xratuUiState: state }), saved);
        await page.reload();
        await post(page, { type: 'showChat' });
        await expect(handle).toHaveAttribute('aria-valuenow', '470');
    });
}

for (const locale of ['en', 'fa']) for (const width of [420, 900]) {
    test(`user bubbles remain on the right with independent text direction (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        for (const value of ['An English request', 'یه درخواست فارسی']) await post(page, { type: 'restoreUser', value });
        const bubbles = page.locator('article.msg.user');
        await expect(bubbles).toHaveCount(2);
        const boxes = await bubbles.evaluateAll((nodes) => nodes.map((node) => ({ right: node.getBoundingClientRect().right, dir: node.querySelector('[dir="auto"]')?.getAttribute('dir'), direction: getComputedStyle(node.querySelector('.msg-content')!).direction })));
        expect(boxes[0].right).toBeCloseTo(boxes[1].right, 0);
        expect(boxes[0].direction).toBe('ltr');
        expect(boxes[1].direction).toBe('rtl');
        await expect(page.locator('.toolbar-brand')).toHaveCount(1);
        expect(await page.locator('.app').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
}

test('sidebar pages preserve drafts and Escape returns from a setup panel before leaving the page', async ({ page }) => {
    await page.locator('.composer-input').fill('Unfinished draft');
    await post(page, { type: 'openSettings' });
    await post(page, { type: 'savedCredentials', credentials: [{ id: 'one', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', active: true }] });
    for (const index of [1, 2, 3, 4, 5, 6, 7, 0]) {
        await page.locator('.sidebar-item').nth(index).click();
        await expect(page.locator('.sidebar-item').nth(index)).toHaveAttribute('aria-current', 'page');
    }
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Avalai', exact: true })).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.sidebar-item').first()).toHaveAttribute('aria-current', 'page');
    await page.locator('.sidebar-back').click();
    await expect(page.locator('.composer-input')).toHaveValue('Unfinished draft');
});

test('a saved account response does not flash open an empty setup drawer', async ({ page }) => {
    await post(page, { type: 'openCredentials' });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await post(page, { type: 'savedCredentials', credentials: [{ id: 'one', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', active: true }] });
    await expect(page.locator('.saved-credential')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('preference help and usage details remain reachable without API history', async ({ page }) => {
    await post(page, { type: 'openSettings' });
    const help = page.locator('.preference-help').first();
    await help.focus();
    await expect(help).toBeFocused();
    await expect(help).toHaveAccessibleName(/.+/);
    await page.locator('.sidebar-item').nth(5).click();
    const totals = { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
    await post(page, { type: 'usageState', providers: [], rates: [], history: [], allTime: totals, chatgpt: { totals, models: [], hasHistory: true } });
    await expect(page.locator('.usage-plan')).toBeVisible();
    await expect(page.locator('.usage-api')).not.toHaveAttribute('open');
    const details = page.locator('.usage-page .page-help > summary');
    await expect(details).toBeVisible();
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.usage-page .page-help-body')).toBeVisible();
});

test('mode controls wait for the host echo and closing their menu does not cancel a run', async ({ page }) => {
    await post(page, { type: 'startResponse' });
    await page.locator('[data-policy="mode"]').click();
    await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
    expect(await sent(page)).toContainEqual({ type: 'togglePlanMode' });
    await expect(page.locator('[data-policy="mode"]')).toContainText('Build');
    await post(page, { type: 'planMode', enabled: true });
    await expect(page.locator('[data-policy="mode"]')).toContainText('Plan');
    await page.locator('[data-policy="approval"]').click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect((await sent(page)).some((m) => m.type === 'cancelRequest')).toBe(false);
});

test('review responses reject old checkpoints and settled requests do not time out later', async ({ page }) => {
    await page.clock.install();
    await post(page, { type: 'restoreUser', value: 'First', cp: sha });
    const previous = await latest(page, 'changesGetState');
    await post(page, { type: 'restoreUser', value: 'Second', cp: otherSha });
    await expect.poll(async () => (await latest(page, 'changesGetState')).sha).toBe(otherSha);
    const current = await latest(page, 'changesGetState');
    await post(page, { ...previous, type: 'changesState', files: [{ ...changes[0], path: 'stale.ts' }] });
    await post(page, { ...current, type: 'changesState', files: changes });
    await page.locator('#surface-tab-changes').click();
    await replyFile(page);
    await page.clock.fastForward(46_000);
    await expect(page.locator('.review-files')).not.toContainText('stale.ts');
    await expect(page.locator('.changes-review [role="alert"]')).toHaveCount(0);
    await expect(page.locator('.review-diff')).toBeVisible();
});

test('review comments belong to their file and feedback preserves unsent text without submitting', async ({ page }) => {
    await page.locator('.composer-input').fill('My existing draft');
    await openReview(page);
    await page.locator('.review-input').fill('First file feedback');
    await page.locator('.review-file').nth(1).click();
    await expect(page.locator('.review-input')).toHaveValue('');
    await page.locator('.review-input').fill('Second file feedback');
    await page.locator('.review-file').first().click();
    await expect(page.locator('.review-input')).toHaveValue('First file feedback');
    await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
    await expect(page.locator('.composer-input')).toHaveValue('My existing draft\n\nsrc/first.ts\nFirst file feedback');
    expect((await sent(page)).some((m) => m.type === 'askQuestion')).toBe(false);
});

test('reviewed status expires when file content changes; the native diff gets the guarded checkpoint and path', async ({ page }) => {
    await openReview(page);
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reviewed', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
    expect(await sent(page)).toContainEqual({ type: 'changeFileOpen', sha, path: changes[0].path });
    const previousList = await latest(page, 'changesGetState');
    const previousFile = await latest(page, 'changeFileGet');
    await page.locator('.review-head').getByRole('button', { name: 'Refresh' }).click();
    const request = await latest(page, 'changesGetState', previousList.requestId);
    await post(page, { ...request, type: 'changesState', files: changes });
    await latest(page, 'changeFileGet', previousFile.requestId);
    await expect(page.locator('.review-diff')).toBeVisible();
    await expect(page.locator('.review-diff')).toContainText('new');
    await replyFile(page, 'changed again', previousFile.requestId);
    await expect(page.locator('.review-diff')).toContainText('changed again');
    await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeVisible();
});

for (const locale of ['en', 'fa']) for (const width of [420, 900]) {
    test(`review code wraps long tokens without horizontal scrolling (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        const previousList = await latest(page, 'changesGetState');
        const previousFile = await latest(page, 'changeFileGet');
        await page.locator('.review-head button').click();
        const request = await latest(page, 'changesGetState', previousList.requestId);
        await post(page, { ...request, type: 'changesState', files: changes });
        const longCode = `const url = "https://example.com/${'segment'.repeat(150)}";`;
        await replyFile(page, longCode, previousFile.requestId);
        const added = page.locator('.review-diff .pill-diff-line.add');
        await expect(added).toContainText(longCode);
        await expect.poll(() => added.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(40);
        const overflow = await page.locator('.review-diff').evaluate((el) => ({ extra: el.scrollWidth - el.clientWidth, x: getComputedStyle(el).overflowX }));
        expect(overflow.extra).toBeLessThanOrEqual(1);
        expect(overflow.x).toBe('hidden');
    });
}

test('Activity keeps tool output, omits answer prose and updates persisted event ages', async ({ page }) => {
    const now = new Date('2026-10-10T12:00:00Z');
    await page.clock.install({ time: now });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'chunk', value: 'Answer introduction' });
    await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/a.ts"}', callId: 'age', timestamp: now.getTime() - 120_000 });
    await post(page, { type: 'toolResult', tool: 'read_file', output: 'Retained tool output', callId: 'age', timestamp: now.getTime() - 119_000 });
    await post(page, { type: 'chunk', value: 'Answer conclusion' });
    await post(page, { type: 'fullResponse', persian: 'Answer conclusion' });
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await expect(page.locator('.activity-timeline')).toContainText('Answer introduction');
    await expect(page.locator('.activity-timeline')).not.toContainText('Answer conclusion');
    await expect(page.locator('.activity-timeline details.step')).toHaveAttribute('title', /2 minutes ago/);
    const detail = page.locator('.activity-timeline details.step');
    if (!await detail.evaluate((el) => (el as HTMLDetailsElement).open)) await detail.locator(':scope > summary').click();
    await expect(detail.locator('.activity-age')).toBeVisible();
    await expect(detail.locator('summary .activity-age')).toHaveCount(0);
    await expect(page.locator('.activity-timeline')).toContainText('Retained tool output');
    await page.clock.fastForward(60_000);
    await expect(page.locator('.activity-age')).toContainText('3 minutes ago');
});

test('agent loading stays compact while profile discovery is pending', async ({ page }) => {
    await post(page, { type: 'openSettings' });
    await page.locator('.sidebar-item').nth(4).click();
    const loading = page.locator('.agent-loading');
    await expect(loading).toBeVisible();
    const dimensions = await loading.locator('svg').boundingBox();
    expect(dimensions?.width).toBe(14);
    expect(dimensions?.height).toBe(14);
    await post(page, { type: 'agentsState', profiles: [] });
    await expect(loading).toHaveCount(0);
});

for (const locale of ['en', 'fa']) for (const width of [420, 900]) {
    test(`composer menus stay inside the viewport and Escape preserves a running turn (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'modelInfo', defaultModel: 'coder', selectedModel: 'coder', models: ['coder', 'another-coder'], contextWindows: { coder: 32768 } });
        await post(page, { type: 'gitStatusState', root: 'project', status: { isRepo: true, branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 1, untracked: 0, conflicted: 0 } });
        await post(page, { type: 'gitBranchesState', branches: ['main', `feat/${'long-branch-name'.repeat(20)}`] });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'update_task_list', args: '{"tasks":[{"id":"one","label":"Current task","status":"in_progress"}]}', callId: 'tasks' });
        await post(page, { type: 'toolResult', tool: 'update_task_list', output: 'Task list updated', callId: 'tasks' });
        await post(page, { type: 'taskListState', tasks: [{ id: 'one', label: 'Current task', status: 'in_progress' }] });
        for (const [trigger, selector] of [
            ['.picker-chip', '.model-pop'], ['.tok-meter', '.ctx-menu'], ['[data-policy=mode]', '.composer-policy-menu'],
            ['[data-policy=approval]', '.composer-policy-menu'], ['.attach-btn', '.attach-menu'], ['.task-list-chip', '.task-list-chip-menu'], ['.git-status', '.branch-pop'],
        ]) {
            await page.locator(trigger).click();
            const menu = page.locator(selector);
            await expect(menu).toBeVisible();
            const box = await menu.boundingBox();
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
            expect(box!.y).toBeGreaterThanOrEqual(0);
            expect(box!.y + box!.height).toBeLessThanOrEqual(641);
            expect(await menu.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
            await page.locator('.composer-input').focus();
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            expect((await sent(page)).some((m) => m.type === 'cancelRequest'), `Escape from ${selector} must only close the menu`).toBe(false);
        }
        expect((await sent(page)).some((m) => m.type === 'cancelRequest')).toBe(false);
        await expect(page.locator('.send-btn.is-stop')).toBeVisible();
    });
}

test('background jobs remain available when switching work surfaces', async ({ page }) => {
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }] });
    for (const name of ['Changes', 'Activity', 'Conversation']) {
        await page.getByRole('tab', { name, exact: true }).click();
        await expect(page.locator('#surface-tab-background')).toBeVisible();
    }
    await page.locator('#surface-tab-background').click();
    await page.locator('.bg-job-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
});

test('agent details surface both load problems and open only the discovered profile', async ({ page }) => {
    await post(page, { type: 'openSettings' });
    await page.locator('.sidebar-item').nth(4).click();
    await post(page, { type: 'agentsState', profiles: [{ name: 'reviewer', description: 'Review code', source: 'project-xratu', editable: true, error: 'No valid tools remain', warning: 'Dropped unknown tool Read' }] });
    await page.locator('.agent-profile').click();
    await expect(page.locator('.agent-profile-details')).toContainText('No valid tools remain');
    await expect(page.locator('.agent-profile-details')).toContainText('Dropped unknown tool Read');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    expect(await sent(page)).toContainEqual({ type: 'agentFileOpen', name: 'reviewer', source: 'project-xratu' });
});

test('a session switch clears review notes and rejects the previous file response', async ({ page }) => {
    await openReview(page);
    await page.locator('.review-input').fill('Only belongs to this session');
    const previousFile = await latest(page, 'changeFileGet');
    const previousList = await latest(page, 'changesGetState');
    await post(page, { type: 'sessionState', id: 'another-session', title: 'Another session' });
    await expect.poll(async () => (await latest(page, 'changesGetState')).requestId).not.toBe(previousList.requestId);
    const currentList = await latest(page, 'changesGetState');
    await post(page, { ...currentList, type: 'changesState', files: changes });
    await page.locator('#surface-tab-changes').click();
    await replyFile(page, 'new', previousFile.requestId);
    await post(page, { ...previousFile, type: 'changeFileState', errorKey: 'surfaceChangesFailed' });
    await expect(page.locator('.review-input')).toHaveValue('');
    await expect(page.locator('.review-diff')).toBeVisible();
    await expect(page.locator('.changes-review [role="alert"]')).toHaveCount(0);
});

test('large change lists reveal more files and binary files keep native editor access', async ({ page }) => {
    await post(page, { type: 'restoreUser', value: 'Many files', cp: sha });
    const request = await latest(page, 'changesGetState');
    await post(page, { ...request, type: 'changesState', files: Array.from({ length: 100 }, (_, i) => ({ path: `assets/image-${i}.png`, added: 0, removed: 0, binary: true })) });
    await page.locator('#surface-tab-changes').click();
    await expect(page.locator('.review-file')).toHaveCount(80);
    await page.locator('.review-more').click();
    await expect(page.locator('.review-file')).toHaveCount(100);
    const file = await latest(page, 'changeFileGet');
    await post(page, { ...file, type: 'changeFileState', file: { path: file.path, kind: 'binary', before: '', after: '' } });
    await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open in editor', exact: true })).toBeEnabled();
    await expect(page.locator('.review-diff')).toHaveCount(0);
});

test('light themes retain readable teal labels', async ({ page }) => {
    await page.evaluate((css) => {
        document.getElementById('xratu-vscode-theme')!.textContent = css;
        document.body.classList.replace('vscode-dark', 'vscode-light');
    }, VSCODE_LIGHT_THEME_CSS);
    await post(page, { type: 'restoreUser', value: 'Review this', cp: sha });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'fullResponse', persian: 'Finished' });
    const colors = await page.locator('.outcome-review').evaluate((el) => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(document.querySelector('.toolbar')!).backgroundColor }));
    const luminance = (color: string) => {
        const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map((n) => Number(n) / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    expect((luminance(colors.background) + 0.05) / (luminance(colors.foreground) + 0.05)).toBeGreaterThan(4.5);
});

for (const locale of ['en', 'fa']) {
    test(`sidebar pages fit a very narrow and short panel (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 420 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'openSettings' });
        await post(page, { type: 'savedCredentials', credentials: [{ id: 'one', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', active: true }] });
        for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
            await page.locator('.sidebar-item').nth(index).click();
            const overflow = await page.locator('.page-content').evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(overflow).toBeLessThanOrEqual(1);
        }
        await page.locator('.sidebar-back').click();
        await expect(page.locator('.send-btn')).toBeVisible();
        await expect(page.locator('.composer-input')).toBeVisible();
    });
}

for (const locale of ['en', 'fa']) {
    test(`panels dock by drag, retain review state and drafts, and restore their placement (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        await page.locator('.composer-input').fill('A draft that survives docking');
        await page.locator('.review-input').fill('Keep this review note');
        await page.locator('.review-footer button').last().click();
        await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.side'));
        await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.dock-tabs.main #surface-tab-activity')).toHaveCount(0);
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
        await page.locator('.dock-tabs.side #surface-tab-changes').click();
        await expect(page.locator('.review-input')).toHaveValue('Keep this review note');
        await expect(page.locator('.review-footer button').last()).toHaveClass(/reviewed/);
        await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
        await expect(page.locator('.changes-pane.panel-main')).toBeVisible();
        await expect(page.locator('.review-input')).toHaveValue('Keep this review note');
        await expect(page.locator('.review-footer button').last()).toHaveClass(/reviewed/);
        await expect(page.locator('.composer-input')).toHaveValue('A draft that survives docking');
        // Moving the last sidebar panel removes its column.
        await page.locator('.dock-tabs.side #surface-tab-activity').dragTo(page.locator('.dock-tabs.main'));
        await expect(page.locator('.work-surface')).not.toHaveClass(/has-sidebar/);
        await page.locator('#surface-tab-conversation').click();
        const stage = await page.locator('.chat-stage').boundingBox();
        expect(stage!.width).toBeGreaterThan(1000);
        // An empty sidebar is still a drop destination during the next drag.
        const source = await page.locator('#surface-tab-activity').boundingBox();
        await page.mouse.move(source!.x + source!.width / 2, source!.y + 20);
        await page.mouse.down();
        await page.mouse.move(source!.x + source!.width / 2 + 15, source!.y + 20, { steps: 3 });
        await expect(page.locator('.dock-sidebar.drag-target')).toBeVisible();
        const destination = await page.locator('.dock-sidebar.drag-target').boundingBox();
        await page.mouse.move(destination!.x + 80, destination!.y + 120, { steps: 8 });
        await page.mouse.up();
        await expect(page.locator('.work-surface')).toHaveClass(/has-sidebar/);
        const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: unknown }).__xratuUiState);
        await page.addInitScript((value) => Object.assign(window, { __xratuUiState: value }), saved);
        await page.reload();
        await post(page, { type: 'showChat' });
        await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toBeVisible();
        await expect(page.locator('.dock-tabs.main #surface-tab-changes')).toBeVisible();
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(page.locator('.dock-sidebar')).toBeHidden();
        await expect(page.locator('.dock-tabs.main [role="tab"]')).toHaveCount(3);
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-pane.panel-main')).toBeVisible();
        await page.setViewportSize({ width: 1080, height: 900 });
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
    });

    test(`panel placement is keyboard accessible, resettable and keeps hidden controls unfocusable (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        await expect(page.locator('.dock-tabs.main .dock-layout-button')).toBeVisible();
        await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await page.locator('#surface-tab-activity').focus();
        await expect(page.locator('#surface-tab-activity')).toBeFocused();
        await page.locator('#surface-tab-activity').press('Shift+F10');
        await expect(page.locator('.dock-layout-menu')).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toBeFocused();
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
        await page.locator('.dock-tabs.side .dock-layout-button').click();
        await page.keyboard.press('Escape');
        await expect(page.locator('.dock-layout-menu')).toHaveCount(0);
        await expect(page.locator('.dock-tabs.side .dock-layout-button')).toBeFocused();
        await page.locator('.dock-tabs.side .dock-layout-button').click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await expect(page.locator('.dock-tabs.main #surface-tab-activity')).toBeVisible();
        await expect(page.locator('.dock-tabs.side #surface-tab-changes')).toBeVisible();
        await expect(page.locator('#surface-tab-conversation')).toBeFocused();
        await expect(page.locator('.activity-pane')).toBeHidden();
        await expect(page.locator('.work-surface')).toHaveClass(/review-visible/);
    });
}

test('side-by-side Activity keeps live task controls unique and review opens the current dock', async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 900 });
    await post(page, { type: 'restoreUser', value: 'Implement this', cp: sha });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'toolCall', tool: 'update_task_list', args: '{"tasks":[{"id":"one","label":"Current task","status":"in_progress"}]}', callId: 'tasks' });
    await post(page, { type: 'toolResult', tool: 'update_task_list', output: 'Task list updated', callId: 'tasks' });
    await post(page, { type: 'taskListState', tasks: [{ id: 'one', label: 'Current task', status: 'in_progress' }] });
    await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.side'));
    await expect(page.locator('.task-list-inline')).toHaveCount(2);
    expect(await page.locator('[id]').evaluateAll((nodes) => {
        const ids = nodes.map((node) => node.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
    })).toEqual([]);
    await post(page, { type: 'fullResponse', persian: 'Done', renderedHtml: '<p>Done</p>' });
    await expect(page.locator('.outcome-review')).toBeVisible();
    await page.locator('.outcome-review').click();
    await expect(page.locator('.dock-tabs.side #surface-tab-changes')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.outcome-review')).toBeHidden();
    await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
    await page.locator('#surface-tab-conversation').click();
    await page.locator('.outcome-review').click();
    await expect(page.locator('.changes-pane.panel-main')).toBeVisible();
    await expect(page.locator('#surface-tab-changes')).toHaveAttribute('aria-selected', 'true');
});

for (const locale of ['en', 'fa']) {
    test(`Activity observes live tools without approval, question or execution controls (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: '{"command":"npm test"}', callId: 'cmd' });
        await post(page, { type: 'needsApproval', approval_id: 'approval', approvals: [{ tool_call_id: 'cmd', tool_name: 'run_terminal_command', args: { command: 'npm test' } }] });
        await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.side'));
        await expect(page.locator('.activity-pane details.step')).toBeVisible();
        await expect(page.locator('.activity-pane .approval-card')).toHaveCount(0);
        await expect(page.locator('.transcript-pane .approval-card')).toBeVisible();
        await expect(page.locator('.activity-pane .icon-btn-mini')).toHaveCount(0);
        await post(page, { type: 'approvalResolved', approval_id: 'approval' });
        await post(page, { type: 'terminalBackgrounded', callId: 'cmd', jobId: 'job', byUser: true });
        await expect(page.locator('.activity-pane .icon-btn-mini')).toHaveCount(0);
    });

    test(`Activity follows new rows, preserves manual scroll and resumes at the bottom (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 640 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'startResponse' });
        const add = async (i: number) => {
            const tool = i % 2 ? 'read_file' : 'grep_search';
            await post(page, { type: 'toolCall', tool, args: JSON.stringify({path: `file-${i}.ts`, pattern: 'test'}), callId: `call-${i}`, timestamp: Date.now() - 120_000 });
            await post(page, { type: 'toolResult', tool, output: `Result ${i}`, callId: `call-${i}` });
        };
        for (let i = 0; i < 24; i++) await add(i);
        await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.side'));
        const pane = page.locator('.activity-pane');
        const bottom = () => pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        await expect.poll(bottom).toBeLessThan(2);
        await add(24);
        await expect.poll(bottom).toBeLessThan(2);
        await pane.hover();
        await page.mouse.wheel(0, -300);
        await expect.poll(bottom).toBeGreaterThan(100);
        const top = await pane.evaluate((el) => el.scrollTop);
        await add(25);
        await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
        await page.mouse.wheel(0, 10_000);
        await expect.poll(bottom).toBeLessThan(2);
        await add(26);
        await expect.poll(bottom).toBeLessThan(2);
        // Moving the same mounted view keeps its follow behavior.
        await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.main'));
        await expect.poll(bottom).toBeLessThan(2);
        await add(27);
        await expect.poll(bottom).toBeLessThan(2);
    });
}

test('review diffs omit patch metadata, grow taller and stay bounded in the main tab', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReview(page);
    const list = await latest(page, 'changesGetState');
    const file = await latest(page, 'changeFileGet');
    await page.locator('.review-head button').click();
    const request = await latest(page, 'changesGetState', list.requestId);
    await post(page, { ...request, type: 'changesState', files: changes });
    await replyFile(page, 'Long source line\n'.repeat(100), file.requestId);
    await expect.poll(() => page.locator('.review-diff').evaluate((el) => el.clientHeight)).toBeGreaterThan(500);
    await expect(page.locator('.review-diff')).not.toContainText('@@');
    await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
    const review = await page.locator('.changes-review').boundingBox();
    expect(review!.width).toBeLessThanOrEqual(980);
});

for (const locale of ['en', 'fa']) for (const segments of [true, false]) {
    test(`progress prose stays in Activity and the answer stays in chat (${locale}, segments=${segments})`, async ({ page }) => {
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'restoreUser', value: 'Check authentication' });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: 'I will inspect the validation path.' });
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/auth.ts"}', callId: 'read' });
        await post(page, { type: 'toolResult', tool: 'read_file', output: 'source', callId: 'read' });
        await post(page, { type: 'chunk', value: 'The expiry guard needs a regression test.' });
        await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: '{"command":"npm test"}', callId: 'test' });
        await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'Exit code: 0\nSTDOUT:\npassed\nSTDERR:\n(empty)', callId: 'test' });
        await post(page, { type: 'chunk', value: 'Expired tokens are now rejected.' });
        if (segments) await post(page, { type: 'thinking', value: 'Final reasoning bookkeeping' });
        await post(page, { type: 'fullResponse', persian: 'I will inspect the validation path.The expiry guard needs a regression test.Expired tokens are now rejected.', renderedHtml: '<p>I will inspect the validation path.</p><p>The expiry guard needs a regression test.</p><p>Expired tokens are now rejected.</p>', ...(segments ? { segmentsHtml: ['<p>I will inspect the validation path.</p>', '<p>The expiry guard needs a regression test.</p>', '<p>Expired tokens are now rejected.</p>'] } : {}) });
        const chat = page.locator('.transcript-pane');
        await expect(chat).toContainText('Expired tokens are now rejected.');
        await expect(chat).not.toContainText('I will inspect the validation path.');
        await expect(chat).not.toContainText('The expiry guard needs a regression test.');
        await page.locator('.completed-steps summary').click();
        await expect(page.locator('.compact-step > code').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.composer-input')).toBeHidden();
        const activity = page.locator('.activity-pane');
        await expect(activity).toContainText('I will inspect the validation path.');
        await expect(activity).toContainText('The expiry guard needs a regression test.');
        await expect(activity).not.toContainText('Expired tokens are now rejected.');
        await page.locator('#surface-tab-changes').click();
        await expect(page.locator('.composer-input')).toBeHidden();
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toBeVisible();
    });
}

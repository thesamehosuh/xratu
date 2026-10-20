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
/** Resolved computed color for a CSS value - custom properties keep their raw
 *  source string, so assertions compare resolved colors only. */
const computedColor = (page: Page, cssValue: string) =>
    page.evaluate((value) => {
        const probe = document.createElement('span');
        probe.style.color = value;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, cssValue);
const varColor = (page: Page, name: string) => computedColor(page, `var(${name})`);
const dragToSidebar = async (page: Page, selector: string) => {
    const tab = page.locator(selector);
    // Wait for layout and locale changes to settle before starting the gesture.
    await tab.hover();
    const source = (await tab.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, { steps: 3 });
    await expect(page.locator('.dock-sidebar.drag-target')).toBeVisible();
    const destination = (await page.locator('.dock-tabs.side').boundingBox())!;
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 5 });
    await page.mouse.up();
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
/** Answer the review pane's latest changes request until the turn's diff
 *  (and its review button) lands. The pane re-requests on busy/revision
 *  flips, so a one-shot reply can go stale. */
const answerChangesUntilReview = async (page: Page) => {
    await expect.poll(async () => {
        const current = (await sent(page)).filter((m) => m.type === 'changesGetState').at(-1);
        if (!current) return false;
        await post(page, { ...current, type: 'changesState', files: changes });
        return (await page.locator('.outcome-review').count()) > 0;
    }).toBe(true);
};
const openReview = async (page: Page, prompt = 'Fix this') => {
    await post(page, { type: 'restoreUser', value: prompt, cp: sha });
    const request = await latest(page, 'changesGetState');
    await post(page, { ...request, type: 'changesState', files: changes });
    await expect(page.locator('#surface-tab-changes')).toBeVisible();
    await page.locator('#surface-tab-changes').click();
    await replyFile(page);
    await expect(page.locator('.review-diff')).toBeVisible();
};

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`restore controls and stable, shared empty states (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        // A user row without a checkpoint must not shift the restore target.
        await post(page, { type: 'restoreUser', value: 'Earlier context' });
        await openReview(page);
        await expect(page.locator('.review-current .review-restore')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.screenshot({ path: info.outputPath('restore-files.png') });
        await page.locator('.review-current .review-restore').click();
        await expect.poll(async () => (await sent(page)).filter(message => message.type === 'restoreCheckpoint').at(-1)).toMatchObject({ sha, userIndex: 1 });
        const beforeRestore = await latest(page, 'changesGetState');
        await post(page, { type: 'checkpointRestored', sessionId: null });
        const request = await latest(page, 'changesGetState', beforeRestore.requestId);
        await post(page, { ...request, type: 'changesState', files: [] });
        const empty = page.locator('.changes-pane .surface-empty-state');
        await expect(empty).toBeVisible();
        await page.locator('.review-current .review-head .icon-btn').click();
        const refresh = await latest(page, 'changesGetState', request.requestId);
        // Keep a refresh pending: the settled empty state must stay visible.
        await expect(empty).toBeVisible();
        await expect(page.locator('.review-current .review-empty')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath('changes-empty-refresh.png') });
        await post(page, { ...refresh, type: 'changesState', files: [] });
        for (const panel of ['activity', 'agents', 'background', 'pullRequests']) {
            if (!await page.locator(`#surface-tab-${panel}`).count()) {
                await page.locator('.dock-tabs.main .dock-add-button').click();
                await page.locator(`.new-tab-pane:not(.panel-hidden) [data-open-panel="${panel}"]`).click();
            } else await page.locator(`#surface-tab-${panel}`).click();
            const state = page.locator(`#surface-panel-${panel} .surface-empty-state`);
            await expect(state).toBeVisible();
            await expect(state).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            for (const side of ['top', 'right', 'bottom', 'left']) await expect(state).toHaveCSS(`border-${side}-width`, '0px');
            await page.screenshot({ path: info.outputPath(`${panel}-empty.png`) });
        }
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.msg.user .icon-btn').filter({ has: page.locator('.lucide-rotate-ccw') })).toHaveCount(1);
        await post(page, { type: 'startResponse' });
        await expect(page.locator('.msg.user .lucide-rotate-ccw')).toHaveCount(0);
        await page.locator('#surface-tab-changes').click();
        await expect(empty).toBeVisible();
    });

    test(`summary icons and cancel hover feedback (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'restoreUser', value: 'Inspect the code' });
        await post(page, { type: 'startResponse' });
        const stop = page.locator('.send-btn.is-stop');
        await expect(stop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await stop.hover();
        // Approved stop style: error-foreground icon on a SOFT red tint. An
        // opaque fill - the solid red or the send action's teal - must fail,
        // not just a transparent one.
        await expect(stop).toHaveCSS('color', await varColor(page, '--vscode-errorForeground'));
        const hoverBackground = await stop.evaluate((element) => getComputedStyle(element).backgroundColor);
        const alpha = (() => {
            const slash = hoverBackground.match(/\/\s*([\d.]+)\s*\)/); // color(srgb r g b / a)
            if (slash) return Number(slash[1]);
            const channels = hoverBackground.match(/rgba?\(([^)]*)\)/)?.[1].split(',').map(part => part.trim());
            return channels?.length === 4 ? Number(channels[3]) : 1; // opaque rgb()
        })();
        expect(alpha, `stop hover keeps a soft tint, got ${hoverBackground}`).toBeGreaterThan(0);
        expect(alpha, `stop hover must stay translucent, got ${hoverBackground}`).toBeLessThan(1);
        await page.screenshot({ path: info.outputPath('cancel-hover.png') });
        await page.mouse.move(0, 0);
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'read' });
        await post(page, { type: 'toolResult', tool: 'read_file', output: 'export const value = 1;', callId: 'read' });
        // The work group's own summary icons carry the same dim-at-rest /
        // accent-on-hover contract on a different selector - and they exist
        // only while the turn is live, since the finished turn folds its tool
        // rows into the compact list asserted below.
        const workGroup = page.locator('.transcript-pane .conversation-work-group');
        await expect(workGroup).toBeVisible();
        if (!await workGroup.evaluate((element) => (element as HTMLDetailsElement).open)) {
            await workGroup.locator(':scope > summary').click();
        }
        const nestedSummary = workGroup.locator('.step-group-body .step > summary').first();
        const nestedIcon = nestedSummary.locator('.step-icon').first();
        await expect(nestedIcon).toHaveCSS('color', await varColor(page, '--vscode-descriptionForeground'));
        await nestedSummary.hover();
        await expect(nestedIcon).toHaveCSS('color', await varColor(page, '--surface-accent'));
        await page.screenshot({ path: info.outputPath('work-group-hover.png') });
        await page.mouse.move(0, 0);
        await post(page, { type: 'fullResponse', persian: 'Inspected the file.' });
        const summary = page.locator('.completed-steps > summary');
        await summary.click();
        await page.mouse.move(0, 0);
        const accent = await summary.locator('svg').first().evaluate(element => getComputedStyle(element).color);
        const icon = page.locator('.compact-step > svg').first();
        await expect(icon).not.toHaveCSS('color', accent);
        await page.screenshot({ path: info.outputPath('summary-expanded.png') });
        await page.locator('.compact-step').first().hover();
        await expect(icon).toHaveCSS('color', accent);
        await expect(summary.locator('svg').first()).toHaveCSS('color', accent);
    });
}

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
    for (const panel of ['Activity', 'Browser']) {
        await page.locator('.dock-tabs.main .dock-add-button').click();
        await page.locator(`.new-tab-pane:not(.panel-hidden) [data-open-panel="${panel.toLowerCase()}"]`).click();
    }
    await page.locator('#surface-tab-conversation').click();
});

for (const locale of ['en', 'fa']) {
    test(`review sidebar resizes by pointer and keyboard, preserves other state and survives reload (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 900 });
        await post(page, { type: 'locale', locale });
        await page.locator('.composer-input').fill('Keep my draft');
        await page.evaluate(() => Object.assign(window, { __xratuUiState: { anotherPreference: 'preserved' } }));
        await openReview(page);
        const handle = page.locator('.review-resize');
        const initialWidth = Number(await handle.getAttribute('aria-valuenow'));
        const box = await handle.boundingBox();
        expect(box).not.toBeNull();
        const x = box!.x + box!.width / 2;
        await page.mouse.move(x, box!.y + 80);
        await page.mouse.down();
        await page.mouse.move(x + (locale === 'fa' ? 120 : -120), box!.y + 80, { steps: 8 });
        await page.mouse.up();
        await expect(handle).toHaveAttribute('aria-valuenow', String(initialWidth + 120));
        const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: Record<string, unknown> }).__xratuUiState);
        expect(saved).toMatchObject({ anotherPreference: 'preserved', reviewSidebarWidth: initialWidth + 120 });
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
        await openReview(page);
        await expect(handle).toHaveAttribute('aria-valuenow', String(initialWidth + 120));
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
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 0]) {
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
    await page.locator('.sidebar-item').nth(6).click();
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
    await expect.poll(async () => (await sent(page)).some(m => m.type === 'changesGetState' && m.sha === otherSha)).toBe(true);
    const requests = (await sent(page)).filter(m => m.type === 'changesGetState');
    const current = requests.find(m => m.sha === otherSha)!;
    const historical = requests.find(m => m.sha === sha && m.toSha === otherSha)!;
    await post(page, { ...historical, type: 'changesState', files: [] });
    await post(page, { ...previous, type: 'changesState', files: [{ ...changes[0], path: 'stale.ts' }] });
    await post(page, { ...current, type: 'changesState', files: changes });
    await page.locator('#surface-tab-changes').click();
    await replyFile(page);
    await expect(page.locator('.review-current .review-diff')).toBeVisible();
    await page.clock.fastForward(46_000);
    await expect(page.locator('.review-files')).not.toContainText('stale.ts');
    await expect(page.locator('.changes-review [role="alert"]')).toHaveCount(0);
    await expect(page.locator('.review-diff')).toBeVisible();
});

test('ask for review names the selected file and preserves the composer draft', async ({ page }) => {
    await page.locator('.composer-input').fill('My existing draft');
    await openReview(page);
    await expect(page.locator('.review-input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
    await page.locator('.review-ask').click();
    await expect(page.locator('.composer-input')).toHaveValue(/My existing draft[\s\S]*src\/first.ts/);
    expect((await sent(page)).some((m) => m.type === 'askQuestion')).toBe(false);
});

test('refresh keeps the diff visible and native editor access uses the guarded checkpoint and path', async ({ page }) => {
    await openReview(page);
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
    await expect(page.locator('.review-ask')).toBeVisible();
});

for (const locale of ['en', 'fa']) for (const width of [420, 900]) {
    test(`review code wraps long tokens without horizontal scrolling (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        const previousList = await latest(page, 'changesGetState');
        const previousFile = await latest(page, 'changeFileGet');
        await page.locator('.review-head .icon-btn').click();
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
    await page.locator('.sidebar-item').nth(5).click();
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
        await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
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
            ['[data-policy=approval]', '.composer-policy-menu'], ['.attach-btn', '.attach-menu'], ['.task-list-chip', '.task-list-chip-menu'],
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
        await expect(page.locator('.git-status')).toBeDisabled();
        await post(page, { type: 'fullResponse', persian: 'Done', renderedHtml: '<p>Done</p>' });
        await page.locator('.git-status').click();
        const branches = page.locator('.branch-pop');
        await expect(branches).toBeVisible();
        const branchBox = await branches.boundingBox();
        expect(branchBox!.x).toBeGreaterThanOrEqual(0);
        expect(branchBox!.x + branchBox!.width).toBeLessThanOrEqual(width + 1);
        expect(branchBox!.y).toBeGreaterThanOrEqual(0);
        expect(branchBox!.y + branchBox!.height).toBeLessThanOrEqual(641);
        await page.keyboard.press('Escape');
        await expect(branches).toHaveCount(0);
        expect((await sent(page)).some(m => m.type === 'cancelRequest')).toBe(false);
    });
}

test('background jobs remain available when switching work surfaces', async ({ page }) => {
    await openReview(page);
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }] });
    for (const name of ['Changes', 'Activity', 'Conversation']) {
        await page.locator(`#surface-tab-${name.toLowerCase()}`).click();
        await expect(page.locator('#surface-tab-background')).toBeVisible();
    }
    await page.locator('#surface-tab-background').click();
    await page.locator('.bg-job-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
});

test('agent details surface both load problems and open only the discovered profile', async ({ page }) => {
    await post(page, { type: 'openSettings' });
    await page.locator('.sidebar-item').nth(5).click();
    await post(page, { type: 'agentsState', profiles: [{ name: 'reviewer', description: 'Review code', source: 'project-xratu', editable: true, error: 'No valid tools remain', warning: 'Dropped unknown tool Read' }] });
    await page.locator('.agent-profile').click();
    await expect(page.locator('.agent-profile-details')).toContainText('No valid tools remain');
    await expect(page.locator('.agent-profile-details')).toContainText('Dropped unknown tool Read');
    await page.getByRole('button', { name: 'Open file', exact: true }).click();
    expect(await sent(page)).toContainEqual({ type: 'agentFileOpen', name: 'reviewer', source: 'project-xratu' });
});

test('a session switch clears review notes and rejects the previous file response', async ({ page }) => {
    await openReview(page);
    const previousFile = await latest(page, 'changeFileGet');
    const previousList = await latest(page, 'changesGetState');
    await post(page, { type: 'sessionState', id: 'another-session', title: 'Another session' });
    await expect.poll(async () => (await latest(page, 'changesGetState')).requestId).not.toBe(previousList.requestId);
    const currentList = await latest(page, 'changesGetState');
    await post(page, { ...currentList, type: 'changesState', files: changes });
    await page.locator('#surface-tab-changes').click();
    await replyFile(page, 'new', previousFile.requestId);
    await post(page, { ...previousFile, type: 'changeFileState', errorKey: 'surfaceChangesFailed' });
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
    await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
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
    await answerChangesUntilReview(page);
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
        for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
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
    test(`Conversation stays anchored while panels move without losing drafts or scroll (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page, 'Keep this conversation');
        await page.locator('.composer-input').fill('Keep this draft');
        await page.locator('.composer-input').evaluate(el => { (el as HTMLElement).dataset.retained = 'yes'; });
        await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('draggable', 'false');
        await page.locator('#surface-tab-conversation').click({ button: 'right' });
        await expect(page.locator('.dock-layout-menu [role=menuitem]')).toHaveCount(3);
        await page.keyboard.press('Escape');
        await dragToSidebar(page, '#surface-tab-browser');
        await expect(page.locator('.conversation-panel.panel-main')).toBeVisible();
        await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
        await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
        await expect(page.locator('.composer-input')).toHaveAttribute('data-retained', 'yes');
        for (let i = 0; i < 16; i++) await post(page, { type: 'restoreUser', value: `Saved message ${i} with enough text to wrap` });
        const transcript = page.locator('.messages');
        await transcript.hover();
        await page.mouse.wheel(0, -300);
        await expect.poll(() => transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
        const scroll = await transcript.evaluate(el => el.scrollTop);
        await page.locator('#surface-tab-activity').click();
        await page.locator('#surface-tab-conversation').click();
        await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBe(scroll);
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
        const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: unknown }).__xratuUiState);
        await page.addInitScript(value => Object.assign(window, { __xratuUiState: value }), saved);
        await page.reload();
        await post(page, { type: 'showChat' });
        await expect(page.locator('.conversation-panel.panel-main')).toBeVisible();
        await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
    });
}

for (const locale of ['en', 'fa']) {
    test(`panels dock by drag, retain review state and drafts, and restore their placement (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        await page.locator('.composer-input').fill('A draft that survives docking');
        await dragToSidebar(page, '#surface-tab-activity');
        await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.dock-tabs.main #surface-tab-activity')).toHaveCount(0);
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
        await page.locator('.dock-tabs.side #surface-tab-changes').click();
        await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
        await expect(page.locator('.changes-pane.panel-main')).toBeVisible();
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
        await openReview(page);
        await expect(page.locator('.dock-tabs.main #surface-tab-changes')).toBeVisible();
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(page.locator('.dock-sidebar')).toBeHidden();
        await expect(page.locator('.dock-tabs.main [role="tab"]')).toHaveCount(5);
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-pane.panel-main')).toBeVisible();
        await page.setViewportSize({ width: 1080, height: 900 });
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
    });

    test(`panel placement is keyboard accessible, resettable and keeps hidden controls unfocusable (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
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
        await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
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
    await dragToSidebar(page, '#surface-tab-activity');
    await expect(page.locator('.task-list-inline')).toHaveCount(2);
    expect(await page.locator('[id]').evaluateAll((nodes) => {
        const ids = nodes.map((node) => node.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
    })).toEqual([]);
    await post(page, { type: 'fullResponse', persian: 'Done', renderedHtml: '<p>Done</p>' });
    await answerChangesUntilReview(page);
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
        await dragToSidebar(page, '#surface-tab-activity');
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
        await dragToSidebar(page, '#surface-tab-activity');
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
    await page.locator('.review-head .icon-btn').click();
    const request = await latest(page, 'changesGetState', list.requestId);
    await post(page, { ...request, type: 'changesState', files: changes });
    await replyFile(page, 'Long source line\n'.repeat(100), file.requestId);
    await expect.poll(() => page.locator('.review-diff').evaluate((el) => el.clientHeight)).toBeGreaterThan(500);
    await expect(page.locator('.review-diff')).not.toContainText('@@');
    await expect(page.locator('.review-diff')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.review-diff')).toHaveCSS('border-top-width', '0px');
    await expect(page.locator('.review-diff')).toHaveCSS('border-radius', '0px');
    await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
    const review = await page.locator('.changes-review').boundingBox();
    expect(review!.width).toBeLessThanOrEqual(980);
});

for (const locale of ['en', 'fa']) for (const segments of [true, false]) {
    test(`progress stays in chat until completion, then folds into Activity (${locale}, segments=${segments})`, async ({ page }) => {
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await openReview(page, 'Check authentication');
        await page.locator('#surface-tab-conversation').click();
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: 'I will inspect the validation path.' });
        const chat = page.locator('.transcript-pane');
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/auth.ts"}', callId: 'read' });
        await expect(chat).toContainText('I will inspect the validation path.');
        await post(page, { type: 'toolResult', tool: 'read_file', output: 'source', callId: 'read' });
        await post(page, { type: 'chunk', value: 'The expiry guard needs a regression test.' });
        await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: '{"command":"npm test"}', callId: 'test' });
        await expect(chat).toContainText('I will inspect the validation path.');
        await expect(chat).toContainText('The expiry guard needs a regression test.');
        await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'Exit code: 0\nSTDOUT:\npassed\nSTDERR:\n(empty)', callId: 'test' });
        await post(page, { type: 'chunk', value: 'Expired tokens are now rejected.' });
        await expect(chat).toContainText('I will inspect the validation path.');
        await expect(chat).toContainText('The expiry guard needs a regression test.');
        if (segments) await post(page, { type: 'thinking', value: 'Final reasoning bookkeeping' });
        await post(page, { type: 'fullResponse', persian: 'I will inspect the validation path.The expiry guard needs a regression test.Expired tokens are now rejected.', renderedHtml: '<p>I will inspect the validation path.</p><p>The expiry guard needs a regression test.</p><p>Expired tokens are now rejected.</p>', ...(segments ? { segmentsHtml: ['<p>I will inspect the validation path.</p>', '<p>The expiry guard needs a regression test.</p>', '<p>Expired tokens are now rejected.</p>'] } : {}) });
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

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`Changes opens for a diff and retains its view when the content becomes empty (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await expect(page.locator('#surface-tab-changes')).toHaveCount(0);
        await expect(page.locator('.dock-sidebar')).toBeHidden();
        await post(page, { type: 'restoreUser', value: 'First edit', cp: sha });
        const first = await latest(page, 'changesGetState');
        await post(page, { ...first, type: 'changesState', files: [] });
        await expect(page.locator('#surface-tab-changes')).toHaveCount(0);
        await page.evaluate(() => window.postMessage({ type: 'toolResult', tool: 'write_file', output: 'Written', callId: 'write' }, '*'));
        const changed = await latest(page, 'changesGetState', first.requestId);
        await post(page, { ...changed, type: 'changesState', files: changes });
        await expect(page.locator('#surface-tab-changes')).toBeVisible();
        await replyFile(page, 'first result');
        await page.locator('#surface-tab-changes').click();
        await expect(page.locator('.review-current .review-diff')).toBeVisible();
        await expect(page.locator('.review-head h2')).toHaveCount(0);
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`changes-${locale}-${width}.png`) });
        await post(page, { type: 'restoreUser', value: 'Second edit', cp: otherSha });
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'changesGetState' && m.sha === sha && m.toSha === otherSha).length).toBe(1);
        const requests = (await sent(page)).filter(m => m.type === 'changesGetState');
        const historical = requests.find(m => m.sha === sha && m.toSha === otherSha)!;
        const current = requests.filter(m => m.sha === otherSha).at(-1)!;
        await post(page, { ...current, type: 'changesState', files: [] });
        await expect(page.locator('.review-current .review-diff')).toContainText('first result');
        await post(page, { ...current, type: 'changesState', files: changes });
        await post(page, { ...historical, type: 'changesState', files: [changes[0]] });
        await page.locator('#surface-tab-changes').click();
        const turn = page.locator('.review-turn');
        await expect(turn).toHaveCount(1);
        await expect(turn).not.toHaveAttribute('open');
        await expect(turn).toContainText(locale === 'en' ? 'Show changes' : 'نمایش تغییرات');
        await expect(turn).not.toContainText('First edit');
        const lastFile = await latest(page, 'changeFileGet');
        await turn.locator('summary').click();
        const file = await latest(page, 'changeFileGet', lastFile.requestId);
        expect(file.toSha).toBe(otherSha);
        await replyFile(page, 'first result');
        await expect(turn.locator('.review-diff')).toContainText('first result');
        await turn.locator('summary').click();
        await turn.locator('summary').click();
        await post(page, { type: 'truncateFromUser', userIndex: 0 });
        await expect(page.locator('.review-turn')).toHaveCount(0);
        await expect(page.locator('#surface-tab-changes')).toBeVisible();
        await expect(page.locator('.changes-pane .surface-empty-state')).toBeVisible();
    });
}

for (const locale of ['en', 'fa']) {
    test(`tabs reorder and drop on panel bodies with pointer dragging (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 800 });
        await post(page, { type: 'locale', locale });
        await page.locator('#surface-tab-browser').dragTo(page.locator('#surface-tab-conversation'));
        await expect(page.locator('.dock-tabs.main [role=tab]').first()).toHaveAttribute('data-panel', 'browser');
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.composer-input').fill('Keep draft');
        const source = (await page.locator('#surface-tab-activity').boundingBox())!;
        await page.mouse.move(source.x + 10, source.y + 10);
        await page.mouse.down();
        await page.mouse.move(source.x + 25, source.y + 10, { steps: 3 });
        const target = (await page.locator('.dock-sidebar.drag-target').boundingBox())!;
        await page.mouse.move(target.x + 80, target.y + 200, { steps: 5 });
        await page.mouse.up();
        await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
        await page.locator('#surface-tab-activity').dragTo(page.locator('.chat-stage'));
        await expect(page.locator('.activity-pane.panel-main')).toBeVisible();
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep draft');
        await expect(page.locator('.work-surface')).not.toHaveClass(/docking/);
    });
}

test('reused checkpoints keep the latest diff live without an empty previous-turn entry', async ({ page }) => {
    await openReview(page);
    await post(page, { type: 'restoreUser', value: 'Another turn with the same checkpoint', cp: sha });
    await post(page, { type: 'toolResult', tool: 'write_file', output: 'Written', callId: 'next-write' });
    const previous = (await sent(page)).filter(m => m.type === 'changesGetState').at(-1)!;
    const request = await latest(page, 'changesGetState', previous.requestId);
    expect(request.toSha).toBeUndefined();
    await post(page, { ...request, type: 'changesState', files: changes });
    await expect(page.locator('#surface-tab-changes')).toBeVisible();
    await expect(page.locator('.review-turn')).toHaveCount(0);
});

for (const locale of ['en', 'fa']) {
    test(`the active diff stays open until the next turn produces changes (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 800 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        await post(page, { type: 'restoreUser', value: 'Second turn', cp: otherSha });
        await expect(page.locator('.review-current .review-diff')).toContainText('new');
        await expect.poll(async () => (await sent(page)).some(m => m.type === 'changesGetState' && m.sha === otherSha)).toBe(true);
        const requests = (await sent(page)).filter(m => m.type === 'changesGetState');
        const current = requests.find(m => m.sha === otherSha)!;
        const frozen = requests.find(m => m.sha === sha && m.toSha === otherSha)!;
        await post(page, { ...frozen, type: 'changesState', files: changes });
        await post(page, { ...current, type: 'changesState', files: [] });
        await expect(page.locator('.review-current .review-diff')).toContainText('new');
        await expect(page.locator('.review-turn[open]')).toHaveCount(0);
        await post(page, { type: 'toolResult', tool: 'write_file', output: 'Written', callId: 'new-write' });
        const updated = await latest(page, 'changesGetState', current.requestId);
        expect(updated.sha).toBe(otherSha);
        await post(page, { ...updated, type: 'changesState', files: changes });
        await expect(page.locator('.review-turn')).toBeVisible();
        await expect(page.locator('.review-turn')).not.toHaveAttribute('open');
        const file = await latest(page, 'changeFileGet');
        expect(file.sha).toBe(otherSha);
        await replyFile(page, 'second result');
        await expect(page.locator('.review-current .review-diff')).toContainText('second result');
        await page.locator('.review-turn > summary').click();
    });
}

for (const locale of ['en', 'fa']) {
    test(`repeated checkpoint endpoints retain distinct review turns (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
        await post(page, { type: 'locale', locale });
        const thirdSha = 'c'.repeat(40);
        for (const [index, cp] of [sha, otherSha, sha, thirdSha].entries()) {
            await post(page, { type: 'restoreUser', value: `Turn ${index + 1}`, cp });
            await post(page, { type: 'startResponse' });
            await post(page, { type: 'fullResponse', persian: `Result ${index + 1}` });
        }
        for (const [from, to] of [[sha, otherSha], [otherSha, sha], [sha, thirdSha], [thirdSha, undefined]]) {
            await expect.poll(async () => (await sent(page)).some(message => message.type === 'changesGetState' && message.sha === from && message.toSha === to)).toBe(true);
            const requests = (await sent(page)).filter(message => message.type === 'changesGetState');
            const request = requests.filter(message => message.sha === from && message.toSha === to).at(-1)!;
            await post(page, { ...request, type: 'changesState', files: changes });
        }
        await page.locator('#surface-tab-changes').click();
        await expect(page.locator('.review-turn')).toHaveCount(3);
        const earlierA = page.locator('.review-turn').last();
        const laterA = page.locator('.review-turn').first();
        const initialFileRequest = (await sent(page)).filter(message => message.type === 'changeFileGet').at(-1);
        await earlierA.locator('summary').click();
        const first = await latest(page, 'changeFileGet', initialFileRequest?.requestId);
        expect(first.toSha).toBe(otherSha);
        await replyFile(page, 'first A result');
        await expect(earlierA).toContainText('first A result');
        await laterA.locator('summary').click();
        const second = await latest(page, 'changeFileGet', first.requestId);
        expect(second.toSha).toBe(thirdSha);
        await replyFile(page, 'second A result');
        await expect(laterA).toContainText('second A result');
        await expect(earlierA).toContainText('first A result');
        await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.outcome-review').nth(2).click();
        await expect(page.locator('.review-current')).toContainText('second A result');
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.outcome-review').first().click();
        await expect(page.locator('.review-current')).toContainText('first A result');
    });
}

for (const locale of ['en', 'fa']) {
    for (const width of [420, 1080]) {
        test(`checkpoint restore scope and recoverable rejection (${locale}, ${width}px)`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'restoreUser', value: 'Update the workspace', cp: sha });
            await page.locator('.composer-input').fill('Keep this draft');
            await post(page, { type: 'notification', id: 'restore-confirm', kind: 'warning', valueKey: 'checkpointScopeConfirm',
                actions: ['checkpointScopeFiles', 'checkpointScopeFilesAndChat', 'notifCancel'] });
            await expect(page.locator('.notif-copy')).toContainText(locale === 'en' ? 'whole workspace' : 'کل پوشه کاری');
            await expect(page.locator('.notif-action')).toHaveCount(3);
            await page.screenshot({ path: testInfo.outputPath('restore-confirm.png') });
            await page.locator('.notif-action').first().click();
            await expect.poll(async () => (await sent(page)).find(m => m.type === 'notificationAction' && m.id === 'restore-confirm')?.action).toBe('checkpointScopeFiles');
            for (const [key, text] of [
                ['checkpointActionStale', locale === 'en' ? 'request restore again' : 'دوباره از گفتگوی فعلی'],
                ['checkpointBackgroundBusy', locale === 'en' ? 'Stop it from Background' : 'از بخش پس زمینه'],
            ]) {
                await post(page, { type: 'notification', id: key, kind: 'warning', valueKey: key });
                await expect(page.locator('.notif-copy')).toContainText(text);
                await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
                await page.screenshot({ path: testInfo.outputPath(`${key}.png`) });
                await page.locator('.notif-close').click();
            }
        });
    }
}

for (const locale of ['en', 'fa']) {
    for (const width of [420, 1080]) {
        test(`branch checkout is unavailable during a run (${locale}, ${width}px)`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'gitStatusState', root: 'workspace', status: { isRepo: true, branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
            await page.locator('.composer-input').fill('Keep this draft');
            await page.locator('.git-status').click();
            await post(page, { type: 'gitBranchesState', branches: ['main', 'next'], current: 'main' });
            await expect(page.locator('.branch-pop')).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath('branch-before.png') });
            await post(page, { type: 'startResponse' });
            await expect(page.locator('.git-status')).toBeDisabled();
            await expect(page.locator('.branch-pop')).toHaveCount(0);
            await post(page, { type: 'notification', id: 'branch-busy', kind: 'warning', valueKey: 'gitCheckoutBusy' });
            await expect(page.locator('.notif-copy')).toContainText(locale === 'en' ? 'session action' : 'کار گفتگو');
            await page.screenshot({ path: testInfo.outputPath('branch-busy.png') });
            await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
            expect((await sent(page)).filter(message => message.type === 'gitCheckout')).toHaveLength(0);
            await post(page, { type: 'fullResponse', persian: 'Done', renderedHtml: '<p>Done</p>' });
            await expect(page.locator('.git-status')).toBeEnabled();
            await expect(page.locator('.branch-pop')).toHaveCount(0);
            await page.locator('.notif-close').click();
            await post(page, { type: 'sessionState', id: 'A', title: 'Current conversation' });
            await post(page, { type: 'restoreUser', value: 'Previous task', cp: sha });
            for (const key of ['sessionLoadFailed', 'sessionCreateFailed', 'sessionSwitchStale']) {
                await post(page, { type: 'notification', id: key, kind: 'warning', valueKey: key });
                await expect(page.locator('.notif-copy')).not.toHaveText(key);
                await expect(page.getByText('Previous task', { exact: true })).toBeVisible();
                await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
                await page.screenshot({ path: testInfo.outputPath(`${key}.png`) });
                await page.locator('.notif-close').click();
            }

        });
    }
}


test('live changes follow the latest edited file and preserve a manual selection until another edit', async ({ page }) => {
    await openReview(page);
    const refresh = async (files: Array<Record<string, unknown>>) => {
        const old = await latest(page, 'changesGetState');
        await page.locator('.review-head').getByRole('button', { name: 'Refresh' }).click();
        const request = await latest(page, 'changesGetState', old.requestId);
        await post(page, { ...request, type: 'changesState', files });
    };
    await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 2 }]);
    await expect(page.locator('.review-file.selected')).toContainText('src/second.ts');
    await replyFile(page, 'second changed');
    await page.locator('.review-file').filter({ hasText: 'src/first.ts' }).click();
    await replyFile(page, 'first manually selected');
    await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 2 }]);
    await expect(page.locator('.review-file.selected')).toContainText('src/first.ts');
    await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 3 }]);
    await expect(page.locator('.review-file.selected')).toContainText('src/second.ts');
    const secondRequest = (await sent(page)).filter(message => message.type === 'changeFileGet' && message.path === 'src/second.ts').at(-1)!;
    await post(page, { ...secondRequest, type: 'changeFileState', file: { path: 'src/second.ts', kind: 'text', before: 'old', after: 'second changed again', hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removedLines: ['old'], addedLines: ['second changed again'] }] } });
    await expect(page.locator('.review-open-file').filter({ has: page.locator('.review-diff-head', { hasText: 'src/second.ts' }) })).toContainText('second changed again');
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`new tabs choose panels and empty views explain what to do (${locale}, ${width})`, async ({ page }) => {
        await page.locator('.dock-tabs.main .dock-layout-button').click();
        await page.getByRole('menuitem', { name: 'Reset layout', exact: true }).click();
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await expect(page.locator('[role="tab"]')).toHaveCount(2);
        for (const panel of ['agents', 'background', 'downloads', 'changes', 'activity', 'pullRequests', 'browser']) {
            await page.locator('.dock-tabs.main .dock-add-button').click();
            const blank = page.locator('.new-tab-pane:not(.panel-hidden)');
            await expect(blank.locator('h2')).not.toBeEmpty();
            await expect(blank.locator('.new-tab-choice')).toHaveCount(8);
            await blank.locator(`[data-open-panel="${panel}"]`).click();
            await expect(page.locator(`#surface-tab-${panel}`)).toHaveAttribute('aria-selected', 'true');
            await expect(page.locator(`#surface-panel-${panel}`)).toBeVisible();
            await expect(page.locator(`#surface-panel-${panel} ${panel === 'downloads' ? 'strong' : 'p'}`).first()).not.toBeEmpty();
            await expect(page.locator('[role="tab"][data-panel^="new-"]')).toHaveCount(0);
        }
        expect(await page.locator('.app').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
}

for (const locale of ['en', 'fa']) test(`assistant ask-review hides while the diff panel is visible (${locale})`, async ({ page }) => {
    await post(page, { type: 'restoreUser', value: 'Edit the file', cp: sha });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'fullResponse', persian: 'Updated.', renderedHtml: '<p>Updated.</p>' });
    await answerChangesUntilReview(page);
    await post(page, { type: 'locale', locale });
    await expect(page.locator('.outcome-actions button')).toHaveCount(2);
    await page.setViewportSize({ width: 1080, height: 900 });
    await expect(page.locator('.changes-pane')).toBeVisible();
    await expect(page.locator('.outcome-actions button')).toHaveCount(1);
    await expect(page.locator('.outcome-review')).toBeHidden();
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(page.locator('.changes-pane')).toBeHidden();
    await expect(page.locator('.outcome-actions button')).toHaveCount(2);
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`tabs add, reuse, close, reopen and restore without losing content (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await page.locator('.composer-input').fill('Keep my draft');
        const add = page.locator('.dock-tabs.main .dock-add-button');
        await add.click();
        await add.click();
        await expect(page.locator('[role=tab][data-panel^="new-"]')).toHaveCount(2);
        await page.locator('.new-tab-pane:not(.panel-hidden) [data-open-panel=activity]').click();
        await expect(page.locator('#surface-tab-activity')).toHaveCount(1);
        await expect(page.locator('[role=tab][data-panel^="new-"]')).toHaveCount(1);
        await page.locator('.activity-search-box input').fill('Retained filter');
        const activityTab = page.locator('.dock-tab[data-panel=activity]');
        await activityTab.hover();
        await expect(activityTab.locator('.dock-tab-close')).toHaveCSS('opacity', '1');
        await activityTab.locator('.dock-tab-close').click();
        await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
        await expect(page.locator('.activity-pane')).toBeHidden();
        await page.locator('.dock-tabs.main .dock-layout-button').click();
        await page.getByRole('menuitem', { name: locale === 'en' ? 'Reopen closed tab' : 'باز کردن دوباره تب بسته شده', exact: true }).click();
        await expect(page.locator('#surface-tab-activity')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.activity-search-box input')).toHaveValue('Retained filter');
        await page.evaluate(() => window.addEventListener('mousedown', event => {
            if (event.button === 1) document.documentElement.dataset.middleClickPrevented = String(event.defaultPrevented);
        }, { once: true }));
        await page.locator('#surface-tab-browser').click({ button: 'middle' });
        await expect(page.locator('html')).toHaveAttribute('data-middle-click-prevented', 'true');
        await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
        await page.locator('[role=tab][data-panel^="new-"]').click();
        await page.locator('.new-tab-pane:not(.panel-hidden) [data-open-panel=browser]').click();
        await expect(page.locator('#surface-tab-browser')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[role=tab][data-panel^="new-"]')).toHaveCount(0);
        await page.locator('.dock-tabs.main .dock-layout-button').click();
        const menu = page.locator('.dock-layout-menu');
        await expect(menu.getByRole('menuitem')).toHaveCount(width >= 860 ? 5 : 4);
        await page.keyboard.press('Escape');
        await expect(page.locator('.dock-tabs.main .dock-layout-button')).toBeFocused();
        await page.locator('#surface-tab-browser').press('Delete');
        await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        await add.click();
        const blankId = await page.locator('[role=tab][data-panel^="new-"]').getAttribute('id');
        const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: unknown }).__xratuUiState);
        await page.addInitScript(value => Object.assign(window, { __xratuUiState: value }), saved);
        await page.reload();
        await post(page, { type: 'showChat' });
        await expect(page.locator(`#${blankId}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.new-tab-pane:not(.panel-hidden)')).toBeVisible();
        await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
        await post(page, { type: 'locale', locale: 'en' });
        await page.getByRole('button', { name: 'New chat', exact: true }).click();
        await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected', 'true');
        expect(await sent(page)).toContainEqual({ type: 'newSession' });
    });

    test(`tab actions target the selected tab and close other tabs (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await page.locator('#surface-tab-activity').click({ button: 'right' });
        await page.getByRole('menuitem', { name: locale === 'en' ? 'Close other tabs' : 'بستن تب های دیگه', exact: true }).click();
        await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
        await expect(page.locator('#surface-tab-conversation')).toBeVisible();
        await expect(page.locator('#surface-tab-activity')).toHaveAttribute('aria-selected', 'true');
        await page.locator('.dock-tabs.main .dock-layout-button').click();
        await page.getByRole('menuitem', { name: locale === 'en' ? 'Close tab' : 'بستن تب', exact: true }).click();
        await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
        await expect(page.locator('#surface-tab-conversation')).toBeFocused();
        await expect(page.locator('.conversation-panel')).toBeVisible();
    });
}

for (const locale of ['en', 'fa']) test(`overflowing tabs scroll by arrows, wheel and keyboard (${locale})`, async ({ page }) => {
    await post(page, { type: 'locale', locale });
    const nav = page.locator('.dock-tabs.main');
    const list = nav.locator('.dock-tab-list');
    for (let i = 0; i < 8; i++) await nav.locator('.dock-add-button').click();
    const previous = nav.getByRole('button', { name: locale === 'en' ? 'Scroll to previous tabs' : 'نمایش تب های قبلی', exact: true });
    const next = nav.getByRole('button', { name: locale === 'en' ? 'Scroll to next tabs' : 'نمایش تب های بعدی', exact: true });
    await expect(previous).toBeVisible();
    await expect(next).toBeVisible();
    const selectedFits = () => list.evaluate(el => {
        const selected = el.querySelector('[role=tab][aria-selected=true]')!.closest('.dock-tab')!.getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        return {
            fits: selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1,
            selectedLeft: selected.left,
            selectedRight: selected.right,
            listLeft: bounds.left,
            listRight: bounds.right,
            scrollLeft: el.scrollLeft,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
        };
    });
    await expect.poll(selectedFits).toMatchObject({ fits: true });
    await expect(nav.locator('.dock-tab-close[tabindex="-1"]')).toHaveCount(11);
    await nav.locator('[role=tab][aria-selected=true]').press('Tab');
    if (process.platform === 'darwin') {
        // macOS Chromium follows the system Full Keyboard Access setting, which
        // can omit buttons from Tab navigation. Focus the action explicitly so
        // this test still exercises its scrolling controls on every runner.
        await nav.locator('.dock-add-button').focus();
    } else {
        await expect(nav.locator('.dock-add-button')).toBeFocused();
    }
    // Arrow clicks DO scroll the strip, but a click can also lose a race with
    // the strip re-revealing the selected tab (that reveal is layout work the
    // macOS runners schedule far less predictably than the Linux lane do), and
    // an undone click leaves the scroll position exactly where it was. The
    // contract this test owns is "clicking previous walks the strip to its
    // logical start and then the arrow disables", not "each individual click
    // moves the strip by more than one pixel".
    const fromStart = () => list.evaluate(el => Math.abs(el.scrollLeft));
    const remainingToEnd = () => list.evaluate(el => el.scrollWidth - el.clientWidth - Math.abs(el.scrollLeft));
    for (let i = 0; i < 25 && (await fromStart()) > 1; i++) {
        await expect(previous).toBeEnabled();
        await previous.click();
    }
    await expect(previous).toBeDisabled();
    await expect.poll(fromStart).toBeLessThanOrEqual(1);
    await list.hover();
    await page.mouse.wheel(0, 180);
    await expect.poll(fromStart).toBeGreaterThan(100);
    await previous.click();
    for (let i = 0; i < 25 && (await remainingToEnd()) > 1; i++) {
        await expect(next).toBeEnabled();
        await next.click();
    }
    await expect(next).toBeDisabled();
    await expect(previous).toBeEnabled();
    await nav.locator('[role=tab][aria-selected=true]').press('Home');
    await expect(page.locator('#surface-tab-conversation')).toBeFocused();
    await expect.poll(selectedFits).toMatchObject({ fits: true });
    await page.locator('#surface-tab-conversation').press('End');
    await expect.poll(selectedFits).toMatchObject({ fits: true });
    await page.setViewportSize({ width: 1080, height: 900 });
    await expect.poll(selectedFits).toMatchObject({ fits: true });
    await page.setViewportSize({ width: 420, height: 900 });
    await expect.poll(selectedFits).toMatchObject({ fits: true });
    expect(await page.locator('.app').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) test(`closing Background keeps its process and retained view alive (${locale}, ${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3, output: 'Ready' }] });
    await page.locator('#surface-tab-background').click();
    await expect(page.locator('.background-output')).toContainText('Ready');
    await page.locator('.background-output').evaluate(el => { (el as HTMLElement).dataset.retained = 'yes'; });
    await page.locator('#surface-tab-background').press('Delete');
    await expect(page.locator('#surface-tab-background')).toHaveCount(0);
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 4, output: 'Ready\nStill running' }] });
    await expect(page.locator('#surface-tab-background')).toHaveCount(0);
    expect((await sent(page)).some(message => message.type === 'killBackgroundJob')).toBe(false);
    await page.locator('.dock-tabs.main .dock-add-button').click();
    await page.locator('.new-tab-pane:not(.panel-hidden) [data-open-panel=background]').click();
    await expect(page.locator('.background-output')).toContainText('Still running');
    await expect(page.locator('.background-output')).toHaveAttribute('data-retained', 'yes');
    await page.locator('.bg-job-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`multiple diffs retain independent replies (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await openReview(page);
        await page.locator('.review-file').filter({ hasText: 'src/second.ts' }).click();
        await expect.poll(async () => (await sent(page)).filter(message => message.type === 'changeFileGet' && message.path === 'src/second.ts').length).toBeGreaterThan(0);
        for (const path of ['src/second.ts', 'src/first.ts']) {
            const request = (await sent(page)).filter(message => message.type === 'changeFileGet' && message.path === path).at(-1)!;
            await post(page, { ...request, type: 'changeFileState', file: { path, kind: 'text', before: 'old', after: path, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removedLines: ['old'], addedLines: [path] }] } });
        }
        await expect(page.locator('.review-diff')).toHaveCount(2);
        await page.screenshot({ path: info.outputPath('multiple-diffs.png') });
        await page.locator('.review-file').filter({ hasText: 'src/first.ts' }).click();
        await expect(page.locator('.review-diff')).toHaveCount(1);
        await expect(page.locator('.review-diff')).toContainText('src/second.ts');
        const beforeRefresh = await latest(page, 'changesGetState');
        await page.locator('.review-head .icon-btn').click();
        const refreshed = await latest(page, 'changesGetState', beforeRefresh.requestId);
        await post(page, { ...refreshed, type: 'changesState', files: changes });
        await expect(page.locator('.review-file').filter({ hasText: 'src/first.ts' })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.review-open-file')).toHaveCount(1);
    });
    test(`CTX caps, compaction lifecycle, and refresh icon (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
        await post(page, { type: 'modelInfo', defaultModel: 'coder', selectedModel: 'coder', models: ['coder'], contextWindows: { coder: 32768 }, overrides: { coder: 1048576 } });
        await page.locator('.tok-meter').click();
        await expect(page.locator('.ctx-opt', { hasText: '64k' })).toHaveCount(0);
        await expect(page.locator('.ctx-opt', { hasText: '32k' })).toHaveCount(1);
        await page.keyboard.press('Escape');
        await page.locator('.picker-chip').click();
        await post(page, { type: 'modelsRefreshing', active: true });
        await expect(page.locator('.model-pop-head .ghost-btn')).not.toHaveClass(/spinning/);
        await expect(page.locator('.model-pop-head .ghost-btn > svg')).toHaveClass(/spinning/);
        await page.keyboard.press('Escape');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'compactionState', active: true });
        await expect(page.locator('.compaction-status')).toBeVisible();
        await page.screenshot({ path: info.outputPath('compaction.png') });
        await post(page, { type: 'byokReset' });
        await expect(page.locator('.compaction-status')).toHaveCount(0);
    });
}

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) test(`Activity jump resumes following the bottom (${locale}, ${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'startResponse' });
    for (let index = 0; index < 40; index++) {
        await post(page, { type: 'toolCall', tool: index % 2 ? 'grep_search' : 'read_file', args: JSON.stringify({ path: `src/file${index}.ts` }), callId: `read-${index}` });
        await post(page, { type: 'toolResult', tool: index % 2 ? 'grep_search' : 'read_file', output: 'content', callId: `read-${index}` });
    }
    await page.locator('#surface-tab-activity').click();
    const pane = page.locator('#surface-panel-activity');
    await pane.evaluate(element => { element.scrollTop = 0; });
    const jump = pane.locator('.jump-btn');
    await expect(jump).toBeVisible();
    await page.screenshot({ path: info.outputPath('activity-jump.png') });
    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48);
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) test(`outside-workspace approval remains actionable (${locale}, ${width})`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'needsApproval', approval_id: 'outside', approvals: [{ tool_call_id: 'outside-edit', tool_name: 'edit_file', args: { path: '../shared/settings.json', new_content: '{}', outside_workspace_paths: ['../shared/settings.json'] } }] });
    await expect(page.locator('.approval-boundary-note')).toBeVisible();
    await expect(page.locator('.approval-session')).toHaveCount(0);
    const approve = page.locator('.approval-apply');
    await expect(approve).toBeEnabled();
    await page.screenshot({ path: info.outputPath('outside-approval.png') });
    await approve.click();
    const decision = await latest(page, 'approvalDecision');
    expect(decision.approvalId).toBe('outside');
    expect(decision.decisions).toEqual({ 'outside-edit': true });
});

test('context overrides do not leak to similarly named models', async ({ page }) => {
    await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
    await post(page, { type: 'modelInfo', defaultModel: 'gpt-4o-mini', selectedModel: 'gpt-4o-mini', models: ['gpt-4o', 'gpt-4o-mini'], contextWindows: { 'gpt-4o': 128000 }, overrides: { 'gpt-4o': 8192 } });
    await post(page, { type: 'usage', usage: { input_tokens: 64000, output_tokens: 0 } });
    await expect(page.locator('.tok-meter .tok-pct')).toHaveText('(50%)');
});

test('automatic change refreshes only reload open files that changed', async ({ page }) => {
    await openReview(page);
    await page.locator('.review-file').filter({ hasText: 'src/second.ts' }).click();
    await replyFile(page, 'second');
    const fileRequests = async (path: string) => (await sent(page)).filter(message => message.type === 'changeFileGet' && message.path === path);
    const firstBefore = (await fileRequests('src/first.ts')).length;
    const secondBefore = (await fileRequests('src/second.ts')).length;
    const listBefore = await latest(page, 'changesGetState');
    await post(page, { type: 'toolResult', tool: 'edit_file', output: 'Updated', callId: 'update-second' });
    const list = await latest(page, 'changesGetState', listBefore.requestId);
    await post(page, { ...list, type: 'changesState', files: [changes[0], { ...changes[1], added: 2 }] });
    await expect.poll(async () => (await fileRequests('src/second.ts')).length).toBe(secondBefore + 1);
    expect((await fileRequests('src/first.ts')).length).toBe(firstBefore);
    await page.locator('.review-head .icon-btn').click();
    await expect.poll(async () => (await fileRequests('src/first.ts')).length).toBe(firstBefore + 1);
});

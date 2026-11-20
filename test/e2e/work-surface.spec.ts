import { openPageNavigation } from './navigation';
import { postHostMessageAndWait } from './hostMessages';
import { setLocale as setTestLocale, t } from '../../webview-ui/src/i18n';
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

const computedColor = (page: Page, cssValue: string) =>
    page.evaluate((value) => {
        const probe = document.createElement('span');
        probe.style.color = value;
        document.querySelector('.app')!.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, cssValue);
const varColor = (page: Page, name: string) => computedColor(page, `var(${name})`);

const dragToSidebar = async (page: Page, selector: string) => {
    const tab = page.locator(selector);
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
    await post(page, {
        ...request,
        file: {
            path: request.path, kind: 'text', before: 'old', after,
            hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: after.split('\n').length, removedLines: ['old'], addedLines: after.split('\n') }],
        },
        type: 'changeFileState',
    });
};

const answerChangesUntilReview = async (page: Page) => {
    await expect.poll(async () => {
        const current = (await sent(page)).filter((m) => m.type === 'changesGetState').at(-1);
        if (!current) return false;
        await post(page, { ...current, type: 'changesState', files: changes });
        return (await page.locator('.outcome-review').count()) > 0;
    }).toBe(true);
};

const openWorkPanel = async (page: Page, panel: string) => {
    const tab = page.locator(`#surface-tab-${panel}`);
    if (await tab.count()) {
        await tab.click();
        return;
    }
    const tabsBar = page.locator('.dock-tabs.main');
    if (!await tabsBar.isVisible()) await page.locator('.toolbar-tools button[aria-pressed]').first().click();
    await page.locator('.dock-tabs.main .dock-add-button').click();
    await page.locator(`.new-tab-pane:not(.panel-hidden) [data-open-panel="${panel}"]`).click();
};

const openReview = async (page: Page, prompt = 'Fix this') => {
    await post(page, { type: 'restoreUser', value: prompt, cp: sha });
    const request = await latest(page, 'changesGetState');
    await post(page, { ...request, type: 'changesState', files: changes });
    const wide = page.viewportSize()!.width >= 860;
    const tab = page.locator('#surface-tab-changes');
    await expect(tab).toHaveAttribute('draggable', String(wide));
    if (wide && !await tab.isVisible()) await page.locator('.toolbar-tools button[aria-pressed]').nth(1).click();
    await expect(tab).toBeVisible();
    await tab.click();
    await replyFile(page);
    await expect(page.locator('.review-diff')).toBeVisible();
};

async function bootMinimal(page: Page, width = 420, height = 900) {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        const state = window as unknown as { __xratuUiState?: unknown };
        Object.assign(window, {
            __xratuHostMessages: messages,
            acquireVsCodeApi: () => ({
                postMessage: (m: unknown) => messages.push(m),
                getState: () => state.__xratuUiState,
                setState: (s: unknown) => { state.__xratuUiState = s; return s; },
            }),
        });
    });
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
}

/* ---- notifications (no dock setup needed) ---------------------------- */

test.describe('notifications', () => {
    test.beforeEach(async ({ page }) => {
        await bootMinimal(page, 420, 900);
    });

    test('action notifications bypass persistent banners in FIFO order and restore focus safely', async ({ page }) => {
        await post(page, { type: 'notification', id: 'warning', kind: 'warning', valueKey: 'warning before confirms' });
        await post(page, { type: 'notification', id: 'error', kind: 'error', valueKey: 'error before confirms' });
        await expect(page.locator('.notif-copy')).toHaveText('warning before confirms');
        await post(page, { type: 'notification', id: 'first', kind: 'warning', valueKey: 'first confirm', actions: ['accept first'] });
        await post(page, { type: 'notification', id: 'second', kind: 'error', valueKey: 'second confirm', actions: ['accept second'] });
        await expect(page.locator('.notif-copy')).toHaveText('first confirm');
        await expect(page.locator('.notif-action')).not.toBeFocused();
        await page.locator('.notif-action').focus();
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'notificationAction')).toEqual([
            { type: 'notificationAction', id: 'first', action: 'accept first' },
        ]);
        await expect(page.locator('.notif-copy')).toHaveText('second confirm');
        await expect(page.getByRole('button', { name: 'accept second', exact: true })).toBeVisible();
        await expect(page.locator('.notif-action')).not.toBeFocused();
        await page.locator('.notif-close').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.notif-copy')).toHaveText('warning before confirms');
        await page.locator('.notif-close').click();
        await expect(page.locator('.notif-copy')).toHaveText('error before confirms');
        await page.locator('.notif-close').click();
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'notificationAction')).toEqual([
            { type: 'notificationAction', id: 'first', action: 'accept first' },
            { type: 'notificationAction', id: 'second', action: null },
            { type: 'notificationAction', id: 'warning', action: null },
            { type: 'notificationAction', id: 'error', action: null },
        ]);
        await expect(page.locator('.notif')).toHaveCount(0);

        // Preemption keeps focus on close without activating next action, and recovers to .app if target disables.
        const background = page.locator('button:visible').first();
        await background.focus();
        await post(page, { type: 'notification', id: 'focus-warning', kind: 'warning', valueKey: 'focus warning' });
        await expect(background).toBeFocused();
        await page.locator('.notif-close').focus();
        await post(page, { type: 'notification', id: 'focus-first', kind: 'warning', valueKey: 'focus first', actions: ['delete first'] });
        await expect(page.locator('.notif-close')).toBeFocused();
        await expect(page.locator('.notif-action')).not.toBeFocused();
        await post(page, { type: 'notification', id: 'focus-second', kind: 'error', valueKey: 'focus second', actions: ['delete second'] });
        await page.locator('.notif-action').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.notif-copy')).toHaveText('focus second');
        await expect(page.locator('.notif-close')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.notif-copy')).toHaveText('focus warning');
        await page.keyboard.press('Enter');
        await expect(page.locator('.notif')).toHaveCount(0);
        await expect(background).toBeFocused();

        await post(page, { type: 'notification', id: 'missing-focus', kind: 'warning', valueKey: 'missing focus' });
        await page.locator('.notif-close').focus();
        await background.evaluate((element: HTMLButtonElement) => { element.disabled = true; });
        await page.keyboard.press('Enter');
        await expect(page.locator('.notif')).toHaveCount(0);
        await expect(page.locator('.app')).toBeFocused();
    });

    test('background focus is never stolen and preempted info timers restart cleanly', async ({ page }) => {
        await page.clock.install();
        const background = page.locator('button:visible').first();
        await background.focus();
        await post(page, { type: 'notification', id: 'background-warning', kind: 'warning', valueKey: 'background warning' });
        await expect(background).toBeFocused();
        await page.locator('.notif-close').focus();
        await background.focus();
        await post(page, { type: 'notification', id: 'background-confirm', kind: 'warning', valueKey: 'background confirm', actions: ['delete'] });
        await expect(background).toBeFocused();
        await page.locator('.notif-close').dispatchEvent('click');
        await expect(background).toBeFocused();
        await page.locator('.notif-close').dispatchEvent('click');
        await expect(page.locator('.notif')).toHaveCount(0);
        await expect(background).toBeFocused();

        await post(page, { type: 'notification', id: 'info', kind: 'info', valueKey: 'temporary information' });
        await expect(page.locator('.notif-copy')).toHaveText('temporary information');
        await page.clock.fastForward(3000);
        await post(page, { type: 'notification', id: 'confirm', kind: 'info', valueKey: 'pending confirm', actions: ['proceed'] });
        await expect(page.locator('.notif-copy')).toHaveText('pending confirm');
        await page.clock.fastForward(10000);
        await expect(page.locator('.notif-copy')).toHaveText('pending confirm');
        await page.locator('.notif-action').click();
        await expect(page.locator('.notif-copy')).toHaveText('temporary information');
        await page.clock.fastForward(5000);
        await expect(page.locator('.notif-copy')).toHaveText('temporary information');
        await page.clock.fastForward(1000);
        await expect(page.locator('.notif')).toHaveCount(0);
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'notificationAction').slice(-2)).toEqual([
            { type: 'notificationAction', id: 'confirm', action: 'proceed' },
            { type: 'notificationAction', id: 'info', action: null },
        ]);
    });
});

/* ---- work-surface panels, docking, review, settings ------------------ */

test.describe('work surface', () => {
    test.beforeEach(async ({ page }) => {
        await bootMinimal(page, 420, 900);
        await page.locator('.toolbar-tools button[aria-pressed]').first().click();
        for (const panel of ['activity', 'browser']) {
            await page.locator('.dock-tabs.main .dock-add-button').click();
            await page.locator(`.new-tab-pane:not(.panel-hidden) [data-open-panel="${panel}"]`).click();
        }
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.composer-input').focus();
    });

    for (const [locale, width] of [['en', 1080], ['fa', 420]] as const) {
        test(`restore controls and stable, shared empty states (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'restoreUser', value: 'Earlier context' });
            await openReview(page);
            await expect(page.locator('.review-current .review-restore')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
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
            await expect(empty).toBeVisible();
            await expect(page.locator('.review-current .review-empty')).toHaveCount(0);
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
            }
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.msg.user .icon-btn').filter({ has: page.locator('.lucide-rotate-ccw') })).toHaveCount(1);
            await post(page, { type: 'startResponse' });
            await expect(page.locator('.msg.user .lucide-rotate-ccw')).toHaveCount(0);
            if (page.viewportSize()!.width >= 860 && !await page.locator('#surface-tab-changes').isVisible()) await page.locator('.toolbar-tools button[aria-pressed]').nth(1).click();
            await page.locator('#surface-tab-changes').click();
            await expect(empty).toBeVisible();
        });

        test(`summary icons and cancel hover feedback (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'restoreUser', value: 'Inspect the code' });
            await post(page, { type: 'startResponse' });
            const stop = page.locator('.send-btn.is-stop');
            await expect(stop).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await stop.hover();
            await expect(stop).toHaveCSS('color', await varColor(page, '--vscode-errorForeground'));
            const hoverBackground = await stop.evaluate((element) => getComputedStyle(element).backgroundColor);
            const alpha = (() => {
                const slash = hoverBackground.match(/\/\s*([\d.]+)\s*\)/);
                if (slash) return Number(slash[1]);
                const channels = hoverBackground.match(/rgba?\(([^)]*)\)/)?.[1].split(',').map(part => part.trim());
                return channels?.length === 4 ? Number(channels[3]) : 1;
            })();
            expect(alpha, `stop hover keeps a soft tint, got ${hoverBackground}`).toBeGreaterThan(0);
            expect(alpha, `stop hover must stay translucent, got ${hoverBackground}`).toBeLessThan(1);
            await page.mouse.move(0, 0);
            await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'read' });
            await post(page, { type: 'toolResult', tool: 'read_file', output: 'export const value = 1;', callId: 'read' });
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
            await page.mouse.move(0, 0);
            await post(page, { type: 'fullResponse', persian: 'Inspected the file.' });
            const summary = page.locator('.completed-steps > summary');
            await summary.click();
            await page.mouse.move(0, 0);
            const accent = await summary.locator('svg').first().evaluate(element => getComputedStyle(element).color);
            const icon = page.locator('.compact-step > svg').first();
            await expect(icon).not.toHaveCSS('color', accent);
            await page.locator('.compact-step').first().hover();
            await expect(icon).toHaveCSS('color', accent);
            await expect(summary.locator('svg').first()).toHaveCSS('color', accent);
        });

        test(`user bubbles remain on the right with independent text direction (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            for (const value of ['An English request', 'یه درخواست فارسی']) await post(page, { type: 'restoreUser', value });
            const bubbles = page.locator('article.msg.user');
            await expect(bubbles).toHaveCount(2);
            const boxes = await bubbles.evaluateAll((nodes) => nodes.map((node) => ({ right: node.getBoundingClientRect().right, direction: getComputedStyle(node.querySelector('.msg-content')!).direction })));
            expect(boxes[0].right).toBeCloseTo(boxes[1].right, 0);
            expect(boxes[0].direction).toBe('ltr');
            expect(boxes[1].direction).toBe('rtl');
            await expect(page.locator('.toolbar > .sidebar-toggle')).toHaveCount(1);
            expect(await page.locator('.app').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        });

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

        test(`composer menus stay inside the viewport and Escape preserves a running turn (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 640 });
            await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'yoloMode', enabled: false });
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
            await page.locator('.composer-input').focus();
            await page.locator('.git-status').press('Enter');
            await expect(branches).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(branches).toHaveCount(0);
            expect((await sent(page)).some(m => m.type === 'cancelRequest')).toBe(false);
        });

        test(`Changes opens for a diff, tracks historical turns, and retains empty view (${locale}, ${width})`, async ({ page }) => {
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
            if (page.viewportSize()!.width >= 860 && !await page.locator('#surface-tab-changes').isVisible()) await page.locator('.toolbar-tools button[aria-pressed]').nth(1).click();
            await expect(page.locator('#surface-tab-changes')).toBeVisible();
            await replyFile(page, 'first result');
            await page.locator('#surface-tab-changes').click();
            await expect(page.locator('.review-current .review-diff')).toBeVisible();
            await expect(page.locator('.review-head h2')).toHaveCount(0);
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
            await post(page, { type: 'truncateFromUser', userIndex: 0 });
            await expect(page.locator('.review-turn')).toHaveCount(0);
            await expect(page.locator('#surface-tab-changes')).toBeVisible();
            await expect(page.locator('.changes-pane .surface-empty-state')).toBeVisible();
        });

        test(`checkpoint restore scope, branch-busy guard, and session error notices (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'gitStatusState', root: 'workspace', status: { isRepo: true, branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
            await post(page, { type: 'sessionState', id: 'A', title: 'Current conversation' });
            await expect(page.locator('.session-btn-title')).toHaveText('Current conversation');
            await post(page, { type: 'restoreUser', value: 'Update the workspace', cp: sha });
            await page.locator('.composer-input').fill('Keep this draft');

            // Checkpoint restore scope banner and bounds.
            await post(page, { type: 'notification', id: 'restore-confirm', kind: 'warning', valueKey: 'checkpointScopeConfirm',
                actions: ['checkpointScopeFiles', 'checkpointScopeFilesAndChat', 'notifCancel'] });
            await expect(page.locator('.notif-copy')).toContainText(locale === 'en' ? 'whole workspace' : 'کل پوشه کاری');
            await expect(page.locator('.notif-action')).toHaveCount(3);
            const copyWidth = await page.locator('.notif-copy').evaluate(el => el.getBoundingClientRect().width);
            const bannerWidth = await page.locator('.notif').evaluate(el => el.getBoundingClientRect().width);
            expect(copyWidth).toBeGreaterThan(bannerWidth * 0.6);
            expect(await page.locator('.notif').evaluate(el => {
                const box = el.getBoundingClientRect();
                return Array.from(el.querySelectorAll('button')).every(button => {
                    const rect = button.getBoundingClientRect();
                    return rect.left >= box.left && rect.right <= box.right && rect.bottom <= box.bottom;
                });
            })).toBe(true);
            await page.locator('.notif-action').first().click();
            await expect.poll(async () => (await sent(page)).find(m => m.type === 'notificationAction' && m.id === 'restore-confirm')?.action).toBe('checkpointScopeFiles');

            for (const [key, text] of [
                ['checkpointActionStale', locale === 'en' ? 'request restore again' : 'دوباره از گفتگوی فعلی'],
                ['checkpointBackgroundBusy', locale === 'en' ? 'Stop it from Background' : 'از بخش پس زمینه'],
            ]) {
                await post(page, { type: 'notification', id: key, kind: 'warning', valueKey: key });
                await expect(page.locator('.notif-copy')).toContainText(text);
                await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
                await page.locator('.notif-close').click();
            }
            await post(page, { type: 'notification', id: 'restore-error', kind: 'error', valueKey: 'checkpointActionStale' });
            await expect(page.locator('.notif-error[role="alert"] .notif-copy')).toBeVisible();
            setTestLocale(locale);
            await expect(page.locator('.notif-error .notif-copy')).toHaveText(t('checkpointActionStale'));
            await page.locator('.notif-close').click();
            await expect.poll(async () => (await sent(page)).find(m => m.type === 'notificationAction' && m.id === 'restore-error')?.action).toBe(null);

            // Branch checkout closes & disables during a run; session failure notices stay localized.
            await page.locator('.git-status').click();
            await post(page, { type: 'gitBranchesState', branches: ['main', 'next'], current: 'main' });
            await expect(page.locator('.branch-pop')).toBeVisible();
            await post(page, { type: 'startResponse' });
            await expect(page.locator('.git-status')).toBeDisabled();
            await expect(page.locator('.branch-pop')).toHaveCount(0);
            await post(page, { type: 'notification', id: 'branch-busy', kind: 'warning', valueKey: 'gitCheckoutBusy' });
            await expect(page.locator('.notif-copy')).toContainText(locale === 'en' ? 'session action' : 'کار گفتگو');
            await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
            expect((await sent(page)).filter(message => message.type === 'gitCheckout')).toHaveLength(0);
            await post(page, { type: 'fullResponse', persian: 'Done', renderedHtml: '<p>Done</p>' });
            await expect(page.locator('.git-status')).toBeEnabled();
            await page.locator('.notif-close').click();
            for (const key of ['sessionLoadFailed', 'sessionCreateFailed', 'sessionSwitchStale']) {
                await post(page, { type: 'notification', id: key, kind: 'warning', valueKey: key });
                await expect(page.locator('.notif-copy')).not.toHaveText(key);
                await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
                await page.locator('.notif-close').click();
            }
        });

        test(`tabs add, reuse, close, reopen, context-menu close-others and restore (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await page.locator('.composer-input').fill('Keep my draft');
            const add = page.locator('.dock-tabs.main .dock-add-button');
            await add.click();
            await expect(page.getByRole('dialog')).toBeVisible();
            await expect(page.locator('[role=tab][data-panel^="new-"]')).toHaveCount(0);
            await page.locator('.new-tab-pane:not(.panel-hidden) [data-open-panel=activity]').click();
            await expect(page.locator('#surface-tab-activity')).toHaveCount(1);
            await page.locator('.activity-search-box input').fill('Retained filter');
            const activityTab = page.locator('.dock-tab[data-panel=activity]');
            await activityTab.hover();
            await expect(activityTab.locator('.dock-tab-close')).toHaveCSS('opacity', '1');
            await activityTab.locator('.dock-tab-close').click();
            await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
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
            await add.click();
            await page.locator('.new-tab-pane:not(.panel-hidden) [data-open-panel=browser]').click();
            await expect(page.locator('#surface-tab-browser')).toHaveAttribute('aria-selected', 'true');
            await page.locator('.dock-tabs.main .dock-layout-button').click();
            await expect(page.locator('.dock-layout-menu').getByRole('menuitem')).toHaveCount(width >= 860 ? 5 : 4);
            await page.keyboard.press('Escape');
            await expect(page.locator('.dock-tabs.main .dock-layout-button')).toBeFocused();
            // Right-click Close other tabs & Close tab.
            await page.locator('#surface-tab-activity').click({ button: 'right' });
            await page.getByRole('menuitem', { name: locale === 'en' ? 'Close other tabs' : 'بستن تب های دیگه', exact: true }).click();
            await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
            await expect(page.locator('#surface-tab-conversation')).toBeVisible();
            await page.locator('.dock-tabs.main .dock-layout-button').click();
            await page.getByRole('menuitem', { name: locale === 'en' ? 'Close tab' : 'بستن تب', exact: true }).click();
            await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
            await expect(page.locator('#surface-tab-conversation')).toBeFocused();
            await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
            const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: unknown }).__xratuUiState);
            await page.addInitScript(value => Object.assign(window, { __xratuUiState: value }), saved);
            await page.reload();
            await post(page, { type: 'showChat' });
            await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected', 'true');
            await expect(page.locator('#surface-tab-browser')).toHaveCount(0);
            await post(page, { type: 'locale', locale: 'en' });
            await page.locator('.toolbar > .sidebar-toggle').click();
            await page.getByRole('button', { name: 'New chat', exact: true }).click();
            await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected', 'true');
            expect(await sent(page)).toContainEqual({ type: 'newSession' });
        });

        test(`resting composer replaces git with runtime summary (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
            await post(page, { type: 'gitStatusState', root: 'project', status: { isRepo: true, branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 1, untracked: 0, conflicted: 0 } });
            setTestLocale(locale);
            const modelInfo = { type: 'modelInfo', defaultModel: 'reasoner', selectedModel: 'reasoner', models: ['reasoner'], displayNames: { reasoner: 'A very long reasoning model display name for narrow sidebar coverage' }, thinkingLevels: { reasoner: 'high' }, capabilities: { reasoner: { reasoningLevels: ['low', 'high'] } } };
            await post(page, modelInfo);
            await post(page, { type: 'yoloMode', enabled: false });
            await expect(page.locator('.composer-summary')).toBeHidden();
            await expect(page.locator('.git-status')).toBeVisible();
            await post(page, { type: 'restoreUser', value: 'Keep the context visible' });
            await post(page, { type: 'startResponse' });
            await post(page, { type: 'fullResponse', persian: 'Done' });
            await page.locator('.msg.user').click();
            await expect(page.locator('.tok-meter')).toBeVisible();
            await expect(page.locator('.tok-pct')).toBeHidden();
            await expect(page.locator('.tok-text')).toBeHidden();
            const summary = page.locator('.composer-summary');
            await expect(summary).toBeVisible();
            await expect(page.locator('.git-status')).toBeHidden();
            await expect(summary.locator('dd')).toHaveText([modelInfo.displayNames.reasoner, t('thinkingHigh'), t('surfaceBuild'), t('surfaceAskFirst')]);
            await expect(summary.locator('dd[dir=ltr]')).toHaveCount(1);
            const bounds = (await summary.boundingBox())!;
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
            const rows = await summary.locator('.composer-summary-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().y));
            expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(1);
            await post(page, { type: 'planMode', enabled: true });
            await post(page, { type: 'yoloMode', enabled: true });
            await expect(summary.locator('dd').nth(2)).toHaveText(t('surfacePlan'));
            await expect(summary.locator('dd').nth(3)).toHaveText(t('surfaceAutoApprove'));
            await post(page, { ...modelInfo, capabilities: { reasoner: { reasoningLevels: ['low'] } } });
            await expect(summary.locator('dd').nth(1)).toHaveText(t('thinkingDefault'));
            await post(page, { ...modelInfo, capabilities: { reasoner: { noReasoning: true } } });
            await expect(summary.locator('dd').nth(1)).toHaveText(t('thinkingNone'));
            await post(page, { type: 'gitStatusState', root: null, status: { isRepo: false, branch: null, detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
            await expect(summary).toBeVisible();
            const ring = (await page.locator('.tok-meter').boundingBox())!;
            const composer = (await page.locator('.composer').boundingBox())!;
            expect(ring.y).toBeGreaterThanOrEqual(composer.y);
            expect(ring.y + ring.height).toBeLessThanOrEqual(composer.y + composer.height);
            await page.locator('.composer-input').focus();
            await expect(summary).toBeHidden();
            await post(page, { type: 'gitStatusState', root: 'project', status: { isRepo: true, branch: 'main', detached: false, ahead: 0, behind: 0, staged: 0, modified: 1, untracked: 0, conflicted: 0 } });
            await expect(page.locator('.git-status')).toBeVisible();
            await page.locator('.picker-chip').click();
            await expect(page.locator('.model-pop')).toBeVisible();
            await expect(summary).toBeHidden();
            await expect(page.locator('.git-status')).toBeVisible();
        });

        test(`multiple diffs, newest-file ordering, and outside-workspace approval (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await openReview(page);
            const previous = await latest(page, 'changesGetState');
            await page.locator('.review-head .icon-btn').click();
            const request = await latest(page, 'changesGetState', previous.requestId);
            await post(page, { ...request, type: 'changesState', files: changes.map((file, i) => ({ ...file, modifiedAt: i + 1 })) });
            const replyPath = async (path: string, content: string, previousId?: unknown) => {
                await expect.poll(async () => (await sent(page)).filter(m => m.type === 'changeFileGet' && m.path === path && m.requestId !== previousId).length).toBeGreaterThan(0);
                const fileRequest = (await sent(page)).filter(m => m.type === 'changeFileGet' && m.path === path && m.requestId !== previousId).at(-1)!;
                await post(page, { ...fileRequest, type: 'changeFileState', file: { path, kind: 'text', before: 'old', after: content, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removedLines: ['old'], addedLines: [content] }] } });
            };
            await replyPath('src/second.ts', 'newest content');
            const groups = page.locator('.review-current .review-file-group');
            await expect(groups.first().locator('.review-file code')).toHaveText('src/second.ts');
            await expect(groups.first().locator('.review-diff')).toContainText('newest content');
            await expect(groups.nth(1).locator('.review-file code')).toHaveText('src/first.ts');
            const firstFile = groups.nth(1).locator('.review-file');
            if (await firstFile.getAttribute('aria-expanded') === 'true') await firstFile.click();
            const previousFile = (await sent(page)).filter(m => m.type === 'changeFileGet' && m.path === 'src/first.ts').at(-1);
            await firstFile.click();
            await replyPath('src/first.ts', 'older content', previousFile?.requestId);
            await expect(groups.nth(1).locator('.review-diff')).toContainText('older content');
            await expect(groups.first().locator('.review-diff')).toContainText('newest content');
            await firstFile.click();
            await expect(page.locator('.review-diff')).toHaveCount(1);
            await expect(page.locator('.review-diff')).toContainText('newest content');

            // Outside-workspace approval disables session-approve and posts decision.
            await page.locator('#surface-tab-conversation').click();
            await post(page, { type: 'startResponse' });
            await post(page, { type: 'needsApproval', approval_id: 'outside', approvals: [{ tool_call_id: 'outside-edit', tool_name: 'edit_file', args: { path: '../shared/settings.json', new_content: '{}', outside_workspace_paths: ['../shared/settings.json'] } }] });
            await expect(page.locator('.approval-boundary-note')).toBeVisible();
            await expect(page.locator('.approval-session')).toHaveCount(0);
            const approve = page.locator('.approval-apply');
            await expect(approve).toBeEnabled();
            await approve.click();
            const decision = await latest(page, 'approvalDecision');
            expect(decision.approvalId).toBe('outside');
            expect(decision.decisions).toEqual({ 'outside-edit': true });
        });

        test(`new tabs choose all panels, closing Background retains DOM, and Activity jump resumes bottom (${locale}, ${width})`, async ({ page }) => {
            await page.locator('.dock-tabs.main .dock-layout-button').click();
            await page.getByRole('menuitem', { name: 'Reset layout', exact: true }).click();
            await page.setViewportSize({ width, height: 900 });
            await post(page, { type: 'locale', locale });
            await expect(page.locator('[role="tab"]')).toHaveCount(1);
            await page.locator('.toolbar-tools button[aria-pressed]').first().click();
            for (const panel of ['agents', 'background', 'downloads', 'changes', 'activity', 'pullRequests', 'browser']) {
                await page.locator('.dock-tabs.main .dock-add-button').click();
                const blank = page.locator('.new-tab-pane:not(.panel-hidden)');
                await expect(page.getByRole('dialog')).toBeVisible();
                await expect(blank.locator('.new-tab-choice')).toHaveCount(8);
                await blank.locator(`[data-open-panel="${panel}"]`).click();
                await expect(page.locator(`#surface-tab-${panel}`)).toHaveAttribute('aria-selected', 'true');
                await expect(page.locator(`#surface-panel-${panel}`)).toBeVisible();
                await expect(page.locator(`#surface-panel-${panel} ${panel === 'browser' ? 'h2' : 'strong'}`).first()).not.toBeEmpty();
                await expect(page.locator('[role="tab"][data-panel^="new-"]')).toHaveCount(0);
            }
            expect(await page.locator('.app').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

            // Closing Background keeps its process & DOM node alive.
            await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3, output: 'Ready' }] });
            await page.locator('#surface-tab-background').click();
            await expect(page.locator('.background-output')).toContainText('Ready');
            await page.locator('.background-output').evaluate(el => { (el as HTMLElement).dataset.retained = 'yes'; });
            await page.locator('#surface-tab-background').press('Delete');
            await expect(page.locator('#surface-tab-background')).toHaveCount(0);
            await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 4, output: 'Ready\nStill running' }] });
            expect((await sent(page)).some(message => message.type === 'killBackgroundJob')).toBe(false);
            await openWorkPanel(page, 'background');
            await expect(page.locator('.background-output')).toContainText('Still running');
            await expect(page.locator('.background-output')).toHaveAttribute('data-retained', 'yes');
            await page.locator('.bg-job-stop').click();
            expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });

            // Activity jump button resumes following bottom.
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
            await jump.click();
            await expect(jump).toHaveCount(0);
            await expect.poll(() => pane.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(48);
        });
    }

    for (const locale of ['en', 'fa'] as const) {
        test(`review sidebar resizes by pointer and keyboard, preserves other state and survives reload (${locale})`, async ({ page }) => {
            await page.setViewportSize({ width: 900, height: 900 });
            await post(page, { type: 'locale', locale });
            await page.locator('.composer-input').fill('Keep my draft');
            await page.evaluate(() => Object.assign(window, { __xratuUiState: { anotherPreference: 'preserved' } }));
            await openReview(page);
            const handle = page.locator('.review-resize');
            const initialWidth = Number(await handle.getAttribute('aria-valuenow'));
            const box = (await handle.boundingBox())!;
            const x = box.x + box.width / 2;
            await page.mouse.move(x, box.y + 80);
            await page.mouse.down();
            await page.mouse.move(x + (locale === 'fa' ? 120 : -120), box.y + 80, { steps: 8 });
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

        test(`navigation sidebar drag-resize survives reload and fits narrow windows (${locale})`, async ({ page }) => {
            await page.setViewportSize({ width: 1080, height: 900 });
            await post(page, { type: 'locale', locale });
            await page.evaluate(() => Object.assign(window, { __xratuUiState: { unrelated: 'preserve' } }));
            await page.locator('.toolbar > .sidebar-toggle').click();
            const separator = page.locator('.navigation-resize');
            const start = (await separator.boundingBox())!;
            await page.mouse.move(start.x + start.width / 2, start.y + 100);
            await page.mouse.down();
            await page.mouse.move(start.x + start.width / 2 + (locale === 'fa' ? -90 : 90), start.y + 100, { steps: 5 });
            await page.mouse.up();
            await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '308px');
            const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: Record<string, unknown> }).__xratuUiState);
            expect(saved.unrelated).toBe('preserve');
            expect(saved.navigationWidth).toBe(308);
            await page.addInitScript(value => Object.assign(window, { __xratuUiState: value }), saved);
            await page.reload();
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'showChat' });
            await page.locator('.toolbar > .sidebar-toggle').click();
            await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '308px');
            await page.setViewportSize({ width: 420, height: 900 });
            await expect(separator).toBeHidden();
            expect((await page.locator('.workspace-sidebar').boundingBox())!.width).toBeLessThanOrEqual(270);
        });

        test(`Conversation stays anchored, panels dock/reorder, and keyboard layout reset works (${locale})`, async ({ page }) => {
            await page.setViewportSize({ width: 1080, height: 900 });
            await post(page, { type: 'locale', locale });
            await openReview(page, 'Keep this conversation');
            await page.locator('.composer-input').fill('Keep this draft');
            await page.locator('.composer-input').evaluate(el => { (el as HTMLElement).dataset.retained = 'yes'; });
            await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('draggable', 'false');
            await page.locator('#surface-tab-conversation').click({ button: 'right' });
            await expect(page.locator('.dock-layout-menu [role=menuitem]')).toHaveCount(3);
            await page.keyboard.press('Escape');

            // Reorder tab in main strip and drag to sidebar.
            await page.locator('#surface-tab-browser').dragTo(page.locator('#surface-tab-conversation'));
            await expect(page.locator('.dock-tabs.main [role=tab]').first()).toHaveAttribute('data-panel', 'browser');
            await page.locator('#surface-tab-conversation').click();
            await dragToSidebar(page, '#surface-tab-browser');
            await expect(page.locator('.conversation-panel.panel-main')).toBeVisible();
            await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
            await expect(page.locator('.composer-input')).toHaveValue('Keep this draft');
            await expect(page.locator('.composer-input')).toHaveAttribute('data-retained', 'yes');

            // Scroll position survives tab switching.
            for (let i = 0; i < 16; i++) await post(page, { type: 'restoreUser', value: `Saved message ${i} with enough text to wrap` });
            const transcript = page.locator('.messages');
            await transcript.hover();
            await page.mouse.wheel(0, -300);
            await expect.poll(() => transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
            const scroll = await transcript.evaluate(el => el.scrollTop);
            await page.locator('#surface-tab-activity').click();
            await page.locator('#surface-tab-conversation').click();
            await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBe(scroll);

            // Drag Activity to sidebar, drag Changes back to main, keyboard Shift+F10 & Reset layout.
            await dragToSidebar(page, '#surface-tab-activity');
            await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
            await page.locator('.dock-tabs.side #surface-tab-changes').click();
            await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
            await expect(page.locator('.changes-pane.panel-main')).toBeVisible();
            await page.locator('#surface-tab-conversation').click();
            await page.locator('#surface-tab-activity').dragTo(page.locator('.conversation-panel'));
            await expect(page.locator('.activity-pane.panel-main')).toBeVisible();
            await page.locator('#surface-tab-activity').focus();
            await page.locator('#surface-tab-activity').press('Shift+F10');
            await expect(page.locator('.dock-layout-menu')).toBeVisible();
            await page.keyboard.press('Enter');
            await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toBeFocused();
            await expect(page.locator('.activity-pane.panel-side')).toBeVisible();

            // Persist across reload, collapse in narrow, then restore in wide.
            const saved = await page.evaluate(() => (window as unknown as { __xratuUiState: unknown }).__xratuUiState);
            await page.addInitScript(value => Object.assign(window, { __xratuUiState: value }), saved);
            await page.reload();
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'showChat' });
            await expect(page.locator('.dock-tabs.side #surface-tab-activity')).toBeVisible();
            await page.setViewportSize({ width: 420, height: 900 });
            await expect(page.locator('.dock-sidebar')).toBeHidden();
            await page.setViewportSize({ width: 1080, height: 900 });
            await expect(page.locator('.activity-pane.panel-side')).toBeVisible();
            await page.locator('.dock-tabs.side .dock-layout-button').click();
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await expect(page.locator('#surface-tab-activity')).toHaveCount(0);
            await expect(page.locator('.composer-input')).toBeFocused();
            await expect(page.locator('.work-surface')).not.toHaveClass(/review-visible/);
        });

        test(`overflowing tabs scroll by arrows, wheel and keyboard (${locale})`, async ({ page }) => {
            await post(page, { type: 'locale', locale });
            const nav = page.locator('.dock-tabs.main');
            const list = nav.locator('.dock-tab-list');
            for (const panel of ['changes', 'agents', 'background', 'downloads', 'pullRequests']) {
                await nav.locator('.dock-add-button').click();
                await page.locator(`.panel-picker-dialog [data-open-panel="${panel}"]`).click();
            }
            await nav.locator('[role=tab][aria-selected=true]').press('End');
            const previous = nav.getByRole('button', { name: locale === 'en' ? 'Scroll to previous tabs' : 'نمایش تب های قبلی', exact: true });
            const next = nav.getByRole('button', { name: locale === 'en' ? 'Scroll to next tabs' : 'نمایش تب های بعدی', exact: true });
            await expect(previous).toBeVisible();
            await expect(next).toBeVisible();
            const selectedFits = () => list.evaluate(el => {
                const selected = el.querySelector('[role=tab][aria-selected=true]')!.closest('.dock-tab')!.getBoundingClientRect();
                const bounds = el.getBoundingClientRect();
                return { fits: selected.left >= bounds.left - 1 && selected.right <= bounds.right + 1 };
            });
            await expect.poll(selectedFits).toMatchObject({ fits: true });
            await expect(next).toBeDisabled();
            await expect(nav.locator('.dock-tab-close[tabindex="-1"]')).toHaveCount(7);
            await nav.locator('[role=tab][aria-selected=true]').press('Tab');
            if (process.platform === 'darwin') await nav.locator('.dock-add-button').focus();
            else await expect(nav.locator('.dock-add-button')).toBeFocused();
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
    }

    test('sidebar pages fit 320px, preserve drafts, surface agent problems, and Escape leaves dialogs safely', async ({ page }) => {
        await page.locator('.composer-input').fill('Unfinished draft');
        await post(page, { type: 'openCredentials' });
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await post(page, { type: 'savedCredentials', credentials: [{ id: 'one', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', active: true }] });
        await expect(page.locator('.saved-credential')).toHaveCount(1);
        await expect(page.getByRole('dialog')).toHaveCount(0);

        // Provider save-error retains the exact input node and clears on successful save.
        await page.getByRole('button', { name: 'Add connection', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.locator('.compact-dialog .cred-provider-box input')).toBeVisible();
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
        await page.locator('.compact-dialog .cred-provider-box input').fill('Avalai');
        await page.keyboard.press('Enter');
        const apiKey = page.getByRole('dialog').getByRole('textbox', { name: /^API key/ });
        await apiKey.fill('test-key');
        const connectionUrl = page.locator('.compact-dialog .cred-field input').first();
        await connectionUrl.evaluate(element => Object.assign(window, { providerInput: element }));
        await page.locator('.compact-dialog .cred-save').click();
        await expect.poll(async () => (await sent(page)).some(m => m.type === 'saveLlmCredentials')).toBe(true);
        await post(page, { type: 'byokCredentialError', value: 'Connection failed. Check the URL and key, then try again.' });
        await expect(page.locator('.compact-dialog [role="alert"]')).toContainText('Connection failed');
        expect(await connectionUrl.evaluate(element => element === (window as unknown as { providerInput: Element }).providerInput)).toBe(true);
        await apiKey.fill('test-retry-key');
        await page.locator('.compact-dialog .cred-save').click();
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'saveLlmCredentials').length).toBe(2);
        await post(page, { type: 'credentialsSaved' });
        await expect(page.locator('.compact-dialog [role="alert"]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        // Shared appearance hydration does not write defaults back; changes post appearanceSet.
        await post(page, { type: 'appearancePrefs', prefs: { scheme: 'dark', accent: 'violet', interfaceSize: 18 } });
        await expect(page.locator('.app')).toHaveAttribute('data-accent', 'violet');
        expect((await sent(page)).filter(m => m.type === 'appearanceSet')).toHaveLength(0);
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        await expect(page.locator('#appearance-interface-size')).toHaveText('18 px');
        await page.locator('#appearance-interface-size').click();
        await page.getByRole('option', { name: '12 px', exact: true }).click();
        await expect.poll(async () => (await sent(page)).filter(m => m.type === 'appearanceSet').at(-1)).toMatchObject({ type: 'appearanceSet', prefs: { accent: 'violet', interfaceSize: 12 } });

        // Agent loading indicator + invalid profile load problems.
        await openPageNavigation(page);
        await page.locator('.sidebar-item').nth(5).click();
        const loading = page.locator('.agent-loading');
        await expect(loading).toBeVisible();
        const dimensions = await loading.locator('svg').boundingBox();
        expect(dimensions?.width).toBe(14);
        expect(dimensions?.height).toBe(14);
        await post(page, { type: 'agentsState', profiles: [{ name: 'reviewer', description: 'Review code', source: 'project-xratu', editable: true, error: 'No valid tools remain', warning: 'Dropped unknown tool Read' }] });
        await expect(loading).toHaveCount(0);
        await expect(page.locator('.agent-profile')).toContainText('Invalid profile');
        await expect(page.locator('.agent-profile')).not.toContainText('Review code');
        await page.locator('.agent-profile').click();
        await expect(page.locator('.agents-page .inventory-inspector')).toContainText('No valid tools remain');
        await expect(page.locator('.agents-page .inventory-inspector')).toContainText('Dropped unknown tool Read');
        await page.getByRole('button', { name: 'Open file', exact: true }).click();
        expect(await sent(page)).toContainEqual({ type: 'agentFileOpen', name: 'reviewer', source: 'project-xratu' });

        // Preference help & Usage details without API history.
        await post(page, { type: 'openSettings' });
        const help = page.locator('.preference-help').first();
        await help.focus();
        await expect(help).toBeFocused();
        await expect(help).toHaveAccessibleName(/.+/);
        await openPageNavigation(page);
        await page.locator('.sidebar-item').nth(6).click();
        const totals = { input: 0, output: 0, cached: 0, USD: 0, IRT: 0 };
        await post(page, { type: 'usageState', providers: [], rates: [], history: [], allTime: totals, chatgpt: { totals, models: [], hasHistory: true } });
        await expect(page.locator('.usage-subscription-detail')).toBeVisible();
        await expect(page.locator('.cost-toolbar')).toHaveCount(0);
        await page.locator('.usage-view-tabs button').first().click();
        await page.locator('.rate-disclosure > summary').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.rates-add-toggle')).toBeVisible();

        // All 9 sidebar pages fit 320x420 in fa RTL without overflow, and back restores draft.
        await page.setViewportSize({ width: 320, height: 420 });
        await post(page, { type: 'locale', locale: 'fa' });
        for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
            await openPageNavigation(page);
            await page.locator('.sidebar-item').nth(index).click();
            expect(await page.locator('.page-content').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        }
        await page.locator('.toolbar-back-work').click();
        await expect(page.locator('.composer-input')).toHaveValue('Unfinished draft');
    });

    test('sidebar sessions Show more/less, search Escape focus return, and bounded delete confirm', async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 900 });
        await page.locator('.toolbar > .sidebar-toggle').click();
        const sidebar = page.locator('.workspace-sidebar');
        await expect(sidebar.getByRole('button', { name: /^(Workspace|History|فضای کار|تاریخچه)$/ })).toHaveCount(0);
        const items = Array.from({ length: 8 }, (_, index) => ({
            id: `session-${index}`, title: `Conversation ${index + 1}`, workspace: '/project', updatedAt: Date.now() - index * 86_400_000,
        }));
        await post(page, { type: 'sessionList', currentId: 'other', items });
        const sessionRows = sidebar.locator('.session-row');
        const toggle = sidebar.getByRole('button', { name: 'Show more' });
        await expect(sessionRows).toHaveCount(5);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.press('Enter');
        await expect(sessionRows).toHaveCount(8);
        const collapse = sidebar.getByRole('button', { name: 'Show less' });
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await collapse.click();
        await expect(sessionRows).toHaveCount(5);

        await sidebar.locator('.session-search-toggle').click();
        const sessionSearch = sidebar.locator('.session-search input');
        await sessionSearch.fill('Conversation 8');
        await expect.poll(async () => (await sent(page)).some(m => m.type === 'searchSessions' && m.query === 'Conversation 8')).toBe(true);
        const request = (await sent(page)).find(m => m.type === 'searchSessions' && m.query === 'Conversation 8');
        await post(page, { type: 'sessionSearchResults', query: 'Conversation 8', requestId: request?.requestId, items: [items[7]] });
        await expect(sessionRows).toHaveCount(1);
        await expect(toggle).toHaveCount(0);
        await sessionSearch.press('Escape');
        await expect(sessionSearch).toHaveCount(0);
        await expect(sidebar.locator('.session-search-toggle')).toBeFocused();
        await expect(sessionRows).toHaveCount(5);

        // Delete confirmation fits inside sidebar bounds and posts deleteSession.
        await sessionRows.first().hover();
        await sessionRows.first().locator('.session-row-delete').click();
        const confirmation = page.locator('.session-row-confirm');
        expect(await confirmation.evaluate(el => {
            const box = el.closest('.workspace-sidebar')!.getBoundingClientRect();
            return [...el.querySelectorAll('button')].every(button => {
                const rect = button.getBoundingClientRect();
                return rect.left >= box.left && rect.right <= box.right;
            });
        })).toBe(true);
        await confirmation.locator('.session-danger').click();
        expect(await sent(page)).toContainEqual({ type: 'deleteSession', id: 'session-0' });
    });

    test('mode controls, overlay Escape, CTX cap, override isolation, and compaction lifecycle', async ({ page }) => {
        // Context override does not leak to similarly named models.
        await post(page, { type: 'transcriptPrefs', prefs: { expand: {}, options: { showContextMeter: true } } });
        await post(page, { type: 'modelInfo', defaultModel: 'gpt-4o-mini', selectedModel: 'gpt-4o-mini', models: ['gpt-4o', 'gpt-4o-mini'], contextWindows: { 'gpt-4o': 128000 }, overrides: { 'gpt-4o': 8192 } });
        await post(page, { type: 'usage', usage: { input_tokens: 64000, output_tokens: 0 } });
        await expect(page.locator('.tok-meter .tok-pct')).toHaveText('(50%)');

        // CTX caps & refresh icon.
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

        // Mode controls wait for host echo, Escape closes menus & overlays without cancelling.
        await post(page, { type: 'restoreUser', value: 'Compact this long conversation' });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'compactionState', active: true });
        await expect(page.locator('.compaction-status')).toBeVisible();
        const statusBox = await page.locator('.compaction-status').boundingBox();
        const composerBox = await page.locator('.composer').boundingBox();
        expect(statusBox && composerBox && Math.abs(statusBox.x - composerBox.x) <= 2 && Math.abs(statusBox.width - composerBox.width) <= 2).toBe(true);
        await page.locator('[data-policy="mode"]').click();
        await page.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
        expect(await sent(page)).toContainEqual({ type: 'togglePlanMode' });
        await expect(page.locator('[data-policy="mode"]')).toContainText('Build');
        await post(page, { type: 'planMode', enabled: true });
        await expect(page.locator('[data-policy="mode"]')).toContainText('Plan');
        const approval = page.locator('[data-policy="approval"]');
        await expect(approval).toBeDisabled();
        await expect(approval).toHaveText('Tool permissions');
        await post(page, { type: 'yoloMode', enabled: false });
        await expect(approval).toBeEnabled();
        await expect(approval).toContainText('Ask first');
        await approval.click();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu')).toHaveCount(0);
        await post(page, { type: 'openSettings' });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        await expect(page.locator('.page-content')).toBeVisible();
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.keyboard.press('Escape');
        await expect(page.locator('.page-content')).toHaveCount(0);
        expect((await sent(page)).some((m) => m.type === 'cancelRequest')).toBe(false);
        await post(page, { type: 'compactionState', active: false, completed: true });
        await expect(page.locator('.compaction-status')).toHaveCount(0);
        const divider = page.locator('.messages-inner .compaction-divider');
        await expect(divider).toBeVisible();
        await post(page, { type: 'fullResponse', persian: 'Continuing after compaction.', renderedHtml: '<p>Continuing after compaction.</p>' });
        await expect(page.locator('.messages-inner')).toContainText('Continuing after compaction.');
        await expect(divider).toBeVisible();
        const dividerBox = await divider.boundingBox();
        const innerBox = await page.locator('.messages-inner').boundingBox();
        expect(dividerBox && innerBox && Math.abs(dividerBox.x - innerBox.x) <= 2 && Math.abs(dividerBox.width - innerBox.width) <= 2).toBe(true);
        await post(page, { type: 'byokReset' });
        await expect(page.locator('.compaction-status')).toHaveCount(0);
    });

    test('review guards: stale checkpoint rejection, read-only draft retention, session switch, and incremental reloads', async ({ page }) => {
        await page.clock.install();
        await page.locator('.composer-input').fill('My existing draft');
        await post(page, { type: 'restoreUser', value: 'First', cp: sha });
        const previous = await latest(page, 'changesGetState');
        await post(page, { type: 'restoreUser', value: 'Second', cp: otherSha });
        await expect.poll(async () => (await sent(page)).some(m => m.type === 'changesGetState' && m.sha === otherSha)).toBe(true);
        const requests = (await sent(page)).filter(m => m.type === 'changesGetState');
        const current = requests.find(m => m.sha === otherSha)!;
        const historical = requests.find(m => m.sha === sha && m.toSha === otherSha)!;
        await post(page, { ...historical, type: 'changesState', files: [] });
        await post(page, { ...current, type: 'changesState', files: changes });
        await page.locator('#surface-tab-changes').click();
        await replyFile(page);
        await expect(page.locator('.review-current .review-diff')).toBeVisible();
        await expect(page.locator('.review-input')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toHaveCount(0);
        await expect(page.locator('.review-ask')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveValue('My existing draft');

        // Settled requests never time out later; stale file rejected.
        const currentFiles = page.locator('.review-current .review-files');
        await expect(currentFiles.locator('.review-file')).toHaveCount(changes.length);
        await postHostMessageAndWait(page, { ...previous, type: 'changesState', files: [{ ...changes[0], path: 'stale.ts' }] });
        for (const change of changes) await expect(currentFiles).toContainText(change.path);
        await expect(currentFiles).not.toContainText('stale.ts');
        await page.clock.fastForward(46_000);
        await expect(page.locator('.changes-review [role="alert"]')).toHaveCount(0);

        // Open in editor & incremental refresh only reloads changed files.
        await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
        expect(await sent(page)).toContainEqual({ type: 'changeFileOpen', sha: otherSha, path: changes[0].path });
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
        await page.locator('.review-current .review-head').getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect.poll(async () => (await fileRequests('src/first.ts')).length).toBe(firstBefore + 1);

        // Session switch rejects previous file response.
        const prevFile = await latest(page, 'changeFileGet');
        const beforeSwitch = (await sent(page)).length;
        await post(page, { type: 'sessionState', id: 'another-session', title: 'Another session' });
        const currentList = async () => (await sent(page)).slice(beforeSwitch).findLast(message =>
            message.type === 'changesGetState' && message.sha === otherSha && message.toSha === undefined);
        await expect.poll(currentList).toBeDefined();
        const nextList = await currentList();
        await post(page, { ...nextList, type: 'changesState', files: changes });
        await page.locator('#surface-tab-changes').click();
        await replyFile(page, 'new', prevFile.requestId);
        await post(page, { ...prevFile, type: 'changeFileState', errorKey: 'surfaceChangesFailed' });
        await expect(page.locator('.review-diff')).toBeVisible();
        await expect(page.locator('.changes-review [role="alert"]')).toHaveCount(0);
    });

    test('large binary change lists, diff sizing, reused checkpoints, and live latest-edited selection', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await openReview(page);
        const refresh = async (files: Array<Record<string, unknown>>) => {
            const old = await latest(page, 'changesGetState');
            await page.locator('.review-head').getByRole('button', { name: 'Refresh' }).click();
            const request = await latest(page, 'changesGetState', old.requestId);
            await post(page, { ...request, type: 'changesState', files });
        };

        // Long diff omits patch headers and stays bounded when moved to main.
        const fileBefore = await latest(page, 'changeFileGet');
        await refresh(changes);
        await replyFile(page, 'Long source line\n'.repeat(100), fileBefore.requestId);
        await expect.poll(() => page.locator('.review-diff').evaluate((el) => el.clientHeight)).toBeGreaterThan(500);
        await expect(page.locator('.review-diff')).not.toContainText('@@');
        await expect(page.locator('.review-diff')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('.review-diff')).toHaveCSS('border-top-width', '0px');
        await expect(page.locator('.review-diff')).toHaveCSS('border-radius', '0px');

        // Live latest-edited file selection respects manual override until another edit.
        await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 2 }]);
        await expect(page.locator('.review-file.selected')).toContainText('src/second.ts');
        await replyFile(page, 'second changed');
        await page.locator('.review-file').filter({ hasText: 'src/first.ts' }).click();
        await replyFile(page, 'first manually selected');
        await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 2 }]);
        await expect(page.locator('.review-file.selected')).toContainText('src/first.ts');
        await refresh([{ ...changes[0], modifiedAt: 1 }, { ...changes[1], modifiedAt: 3 }]);
        await expect(page.locator('.review-file.selected')).toContainText('src/second.ts');

        // Reused checkpoint does not spawn an empty previous-turn row.
        await post(page, { type: 'restoreUser', value: 'Another turn with same checkpoint', cp: sha });
        await post(page, { type: 'toolResult', tool: 'write_file', output: 'Written', callId: 'next-write' });
        const prev = (await sent(page)).filter(m => m.type === 'changesGetState').at(-1)!;
        const reusedReq = await latest(page, 'changesGetState', prev.requestId);
        expect(reusedReq.toSha).toBeUndefined();
        await post(page, { ...reusedReq, type: 'changesState', files: changes });
        await expect(page.locator('.review-turn')).toHaveCount(0);

        // Moving Changes to main keeps bounded width; large binary lists paginate at 80.
        await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
        expect((await page.locator('.changes-review').boundingBox())!.width).toBeLessThanOrEqual(980);
        await refresh(Array.from({ length: 100 }, (_, i) => ({ path: `assets/image-${i}.png`, added: 0, removed: 0, binary: true })));
        await expect(page.locator('.review-file')).toHaveCount(80);
        await page.locator('.review-more').click();
        await expect(page.locator('.review-file')).toHaveCount(100);
        const binFile = await latest(page, 'changeFileGet');
        await post(page, { ...binFile, type: 'changeFileState', file: { path: binFile.path, kind: 'binary', before: '', after: '' } });
        await expect(page.getByRole('button', { name: 'Open in editor', exact: true })).toBeEnabled();
        await expect(page.locator('.review-diff')).toHaveCount(0);
    });

    test('active diff stays open across empty turns and repeated checkpoint endpoints stay distinct', async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 900 });
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

        const thirdSha = 'c'.repeat(40);
        for (const [index, cp] of [sha, thirdSha].entries()) {
            await post(page, { type: 'restoreUser', value: `Turn ${index + 3}`, cp });
            await post(page, { type: 'startResponse' });
            await post(page, { type: 'fullResponse', persian: `Result ${index + 3}` });
        }
        for (const [from, to] of [[otherSha, sha], [sha, thirdSha], [thirdSha, undefined]]) {
            await expect.poll(async () => (await sent(page)).some(message => message.type === 'changesGetState' && message.sha === from && message.toSha === to)).toBe(true);
            const allReqs = (await sent(page)).filter(message => message.type === 'changesGetState');
            const req = allReqs.filter(message => message.sha === from && message.toSha === to).at(-1)!;
            await post(page, { ...req, type: 'changesState', files: changes });
        }
        await expect(page.locator('.review-turn')).toHaveCount(3);
        const earlierA = page.locator('.review-turn').last();
        const laterA = page.locator('.review-turn').first();
        const initialFileReq = (await sent(page)).filter(message => message.type === 'changeFileGet').at(-1);
        await earlierA.locator('summary').click();
        const first = await latest(page, 'changeFileGet', initialFileReq?.requestId);
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
        await page.getByRole('article').filter({ hasText: 'Result 3' }).locator('.outcome-review').click();
        await expect(page.locator('.review-current')).toContainText('second A result');
    });

    test('Activity timeline ages, read-only observation, side-by-side tasks, follow/scroll, and light-theme review contrast', async ({ page }) => {
        const now = new Date('2026-10-10T12:00:00Z');
        await page.clock.install({ time: now });
        await page.setViewportSize({ width: 1080, height: 640 });
        await post(page, { type: 'restoreUser', value: 'Implement this', cp: sha });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: 'Answer introduction' });
        await post(page, { type: 'toolCall', tool: 'update_task_list', args: '{"tasks":[{"id":"one","label":"Current task","status":"in_progress"}]}', callId: 'tasks' });
        await post(page, { type: 'toolResult', tool: 'update_task_list', output: 'Task list updated', callId: 'tasks' });
        await post(page, { type: 'taskListState', tasks: [{ id: 'one', label: 'Current task', status: 'in_progress' }] });
        await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: '{"command":"npm test"}', callId: 'cmd', timestamp: now.getTime() - 120_000 });
        await post(page, { type: 'needsApproval', approval_id: 'approval', approvals: [{ tool_call_id: 'cmd', tool_name: 'run_terminal_command', args: { command: 'npm test' } }] });

        await dragToSidebar(page, '#surface-tab-activity');
        // No duplicate DOM ids, no approval cards or interactive buttons inside Activity.
        await expect(page.locator('.task-list-inline')).toHaveCount(2);
        expect(await page.locator('[id]').evaluateAll((nodes) => {
            const ids = nodes.map((node) => node.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
        })).toEqual([]);
        await expect(page.locator('.activity-pane .approval-card')).toHaveCount(0);
        await expect(page.locator('.transcript-pane .approval-card')).toBeVisible();
        await expect(page.locator('.activity-pane .icon-btn-mini')).toHaveCount(0);
        await post(page, { type: 'approvalResolved', approval_id: 'approval' });
        await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'Retained tool output', callId: 'cmd', timestamp: now.getTime() - 119_000 });
        await post(page, { type: 'chunk', value: 'Answer conclusion' });
        await post(page, { type: 'fullResponse', persian: 'Answer conclusion' });
        await expect(page.locator('.activity-timeline')).toContainText('Answer introduction');
        await expect(page.locator('.activity-timeline')).not.toContainText('Answer conclusion');
        const cmdPill = page.locator('.activity-timeline details.step').last();
        await expect(cmdPill).toHaveAttribute('title', /2 minutes ago/);
        if (!await cmdPill.evaluate((el) => (el as HTMLDetailsElement).open)) await cmdPill.locator(':scope > summary').click();
        await expect(cmdPill.locator('.activity-age')).toBeVisible();
        await expect(page.locator('.activity-timeline')).toContainText('Retained tool output');
        await page.clock.fastForward(60_000);
        await expect(cmdPill.locator('.activity-age')).toContainText('3 minutes ago');

        // Light-theme outcome review contrast & hide-when-panel-visible.
        await page.evaluate((css) => {
            document.getElementById('xratu-vscode-theme')!.textContent = css;
            document.body.classList.replace('vscode-dark', 'vscode-light');
        }, VSCODE_LIGHT_THEME_CSS);
        await answerChangesUntilReview(page);
        const colors = await page.locator('.outcome-review').evaluate((el) => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(document.querySelector('.toolbar')!).backgroundColor }));
        const luminance = (color: string) => {
            const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map((n) => Number(n) / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        expect((luminance(colors.background) + 0.05) / (luminance(colors.foreground) + 0.05)).toBeGreaterThan(4.5);
        await page.locator('.outcome-review').click();
        await expect(page.locator('.dock-tabs.side #surface-tab-changes')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.outcome-review')).toBeHidden();
        await page.locator('#surface-tab-changes').dragTo(page.locator('.dock-tabs.main'));
        await page.locator('#surface-tab-conversation').click();
        await page.locator('.outcome-review').click();
        await expect(page.locator('.changes-pane.panel-main')).toBeVisible();

        // Background tab stays reachable across surface switches.
        await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }] });
        for (const name of ['changes', 'activity', 'conversation']) {
            await page.locator(`#surface-tab-${name}`).click();
            await expect(page.locator('#surface-tab-background')).toBeVisible();
        }
        await page.locator('#surface-tab-background').click();
        await page.locator('.bg-job-stop').click();
        expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
    });

    test('Activity follows new rows, pauses on manual scroll, resumes at bottom, and survives docking', async ({ page }) => {
        await page.setViewportSize({ width: 1080, height: 640 });
        await post(page, { type: 'startResponse' });
        const add = async (i: number) => {
            const tool = i % 2 ? 'read_file' : 'grep_search';
            await post(page, { type: 'toolCall', tool, args: JSON.stringify({ path: `file-${i}.ts`, pattern: 'test' }), callId: `call-${i}`, timestamp: Date.now() - 120_000 });
            await post(page, { type: 'toolResult', tool, output: `Result ${i}`, callId: `call-${i}` });
        };
        for (let i = 0; i < 24; i++) await add(i);
        await dragToSidebar(page, '#surface-tab-activity');
        const pane = page.locator('.activity-pane');
        const completed = pane.locator('.activity-entry details.step:not(.running)');
        const bottom = () => pane.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        await expect(completed).toHaveCount(24);
        await expect.poll(bottom).toBeLessThan(2);
        await add(24);
        await expect(completed).toHaveCount(25);
        await expect.poll(bottom).toBeLessThan(2);
        await pane.hover();
        await page.mouse.wheel(0, -300);
        await expect.poll(bottom).toBeGreaterThan(100);
        const top = await pane.evaluate((el) => el.scrollTop);
        await add(25);
        await expect(completed).toHaveCount(26);
        await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
        await page.mouse.wheel(0, 10_000);
        await expect.poll(bottom).toBeLessThan(2);
        await add(26);
        await expect(completed).toHaveCount(27);
        await expect.poll(bottom).toBeLessThan(2);
        await page.locator('#surface-tab-activity').dragTo(page.locator('.dock-tabs.main'));
        await expect.poll(bottom).toBeLessThan(2);
        await add(27);
        await expect(completed).toHaveCount(28);
        await expect.poll(bottom).toBeLessThan(2);
    });

    for (const [locale, segments] of [['en', true], ['fa', false]] as const) {
        test(`progress stays in chat until completion, then folds into Activity (${locale}, segments=${segments})`, async ({ page }) => {
            await post(page, { type: 'locale', locale });
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
            await expect(chat).toContainText('The expiry guard needs a regression test.');
            await post(page, { type: 'toolResult', tool: 'run_terminal_command', output: 'Exit code: 0\nSTDOUT:\npassed\nSTDERR:\n(empty)', callId: 'test' });
            await post(page, { type: 'chunk', value: 'Expired tokens are now rejected.' });
            if (segments) await post(page, { type: 'thinking', value: 'Final reasoning bookkeeping' });
            await post(page, {
                type: 'fullResponse',
                persian: 'I will inspect the validation path.The expiry guard needs a regression test.Expired tokens are now rejected.',
                renderedHtml: '<p>I will inspect the validation path.</p><p>The expiry guard needs a regression test.</p><p>Expired tokens are now rejected.</p>',
                ...(segments ? { segmentsHtml: ['<p>I will inspect the validation path.</p>', '<p>The expiry guard needs a regression test.</p>', '<p>Expired tokens are now rejected.</p>'] } : {}),
            });
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
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.composer-input')).toBeVisible();
        });
    }
});

/* ---- standalone layout migration & composer motion tests ------------- */

test('one saved layout migrates legacy presets, keeps DOM on Ctrl+Shift+Arrow dock, and resets cleanly', async ({ page }) => {
    await installVscodeTheme(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
        const legacyLayout = { version: 4, main: ['conversation', 'browser'], side: ['changes', 'activity', 'agents', 'background', 'downloads', 'pullRequests'], mainActive: 'conversation', sideActive: 'changes' };
        let saved: Record<string, unknown> = JSON.parse(sessionStorage.getItem('single-layout') ?? JSON.stringify({
            unrelated: 'retained', surfaceLayout: legacyLayout, surfaceOpenedPanels: ['browser'], surfaceTabsVisible: true,
            surfaceSideOpen: true, surfaceWorkspace: 'control', surfaceLayoutPreset: 'control',
            surfaceWorkspaces: { control: { layout: { ...legacyLayout, main: ['conversation'], side: ['agents'] }, opened: ['agents'], sideOpen: true, tabsChoice: true } },
        }));
        Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => saved, setState: (state: Record<string, unknown>) => { saved = state; sessionStorage.setItem('single-layout', JSON.stringify(state)); } }) });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.workspace-switcher')).toHaveCount(0);
    await expect(page.locator('.toolbar-product-name')).toHaveText('Xratu');
    const input = page.locator('.composer-input');
    await input.fill('Preserve my draft');
    await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 8); });
    await page.evaluate(() => Object.assign(window, { originalInput: document.querySelector('.composer-input'), originalBrowser: document.querySelector('.browser-pane') }));
    await openWorkPanel(page, 'browser');
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowRight']) await page.locator('#surface-tab-browser').press(`Control+Shift+${key}`);
    await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Preserve my draft');
    expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
    expect(await page.evaluate(() => {
        const state = window as unknown as { originalInput: Element; originalBrowser: Element };
        return document.querySelector('.composer-input') === state.originalInput && document.querySelector('.browser-pane') === state.originalBrowser;
    })).toBe(true);
    await page.locator('.toolbar-tools').getByRole('button', { name: 'Toggle work tabs', exact: true }).click();
    await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'read' });
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceTabsVisible)).toBe(false);
    const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceLayout);
    await page.reload();
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceLayout)).toEqual(before);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).unrelated)).toBe('retained');
    await page.locator('.toolbar-tools').getByRole('button', { name: 'Toggle work tabs', exact: true }).click();
    await page.locator('.dock-tabs.main .dock-layout-button').click();
    await page.getByRole('menuitem', { name: 'Reset layout', exact: true }).click();
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
        const state = JSON.parse(sessionStorage.getItem('single-layout')!);
        return { sideOpen: state.surfaceSideOpen, tabs: state.surfaceTabsVisible, opened: state.surfaceOpenedPanels, agentsInMain: state.surfaceLayout.main.includes('agents'), agentsInSide: state.surfaceLayout.side.includes('agents') };
    })).toEqual({ sideOpen: false, tabs: null, opened: [], agentsInMain: true, agentsInSide: false });
});

test('composer collapses monotonically without bounce and hidden tabs never overlap content', async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => { Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => undefined, setState: (s: unknown) => s, postMessage: () => {} }) }); });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'fa' });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'restoreUser', value: 'Keep this conversation' });
    const input = page.locator('.composer-input');
    await input.fill('Three lines\nof text\nremain intact');
    await input.focus();
    await input.evaluate(el => { (el as HTMLTextAreaElement).setSelectionRange(2, 7); });
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '11px');
    const expanded = await page.locator('.composer').evaluate(el => el.getBoundingClientRect().height);
    const frames = await input.evaluate(el => new Promise<Array<{ height: number; settled: boolean }>>((resolve, reject) => {
        const card = el.closest('.input-bar')!.querySelector('.composer')!;
        const samples: Array<{ height: number; settled: boolean }> = [];
        const active = new Map<EventTarget, Set<string>>();
        let started = false;
        let settledFrames = 0;
        let frame = 0;
        const cleanup = () => {
            clearTimeout(timeout);
            cancelAnimationFrame(frame);
            card.removeEventListener('transitionrun', onRun);
            card.removeEventListener('transitionend', onFinish);
            card.removeEventListener('transitioncancel', onFinish);
        };
        const onRun = (event: Event) => {
            const transition = event as TransitionEvent;
            if (transition.pseudoElement) return;
            started = true;
            settledFrames = 0;
            const properties = active.get(event.target!) ?? new Set<string>();
            properties.add(transition.propertyName);
            active.set(event.target!, properties);
        };
        const onFinish = (event: Event) => {
            const transition = event as TransitionEvent;
            if (transition.pseudoElement) return;
            const properties = active.get(event.target!);
            properties?.delete(transition.propertyName);
            if (properties?.size === 0) active.delete(event.target!);
        };
        const timeout = setTimeout(() => { cleanup(); reject(new Error('Composer transitions did not start and settle within 3000ms')); }, 3000);
        card.addEventListener('transitionrun', onRun);
        card.addEventListener('transitionend', onFinish);
        card.addEventListener('transitioncancel', onFinish);
        const sample = () => {
            const settled = started && active.size === 0;
            samples.push({ height: card.getBoundingClientRect().height, settled });
            settledFrames = settled ? settledFrames + 1 : 0;
            if (settledFrames === 3) { cleanup(); resolve(samples); }
            else frame = requestAnimationFrame(sample);
        };
        (el as HTMLTextAreaElement).blur();
        frame = requestAnimationFrame(sample);
    }));
    for (let i = 1; i < frames.length; i++) expect(frames[i].height).toBeLessThanOrEqual(frames[i - 1].height + 0.6);
    const final = frames.at(-1)!.height;
    expect(final).toBeLessThan(expanded);
    for (const sample of frames.filter(frame => frame.settled)) expect(Math.abs(sample.height - final)).toBeLessThan(1);
    await input.focus();
    await expect(input).toHaveValue('Three lines\nof text\nremain intact');
    expect(await input.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([2, 7]);
    await openWorkPanel(page, 'activity');
    await page.locator('.toolbar-tools button[aria-pressed]').first().click();
    const tabs = page.locator('.dock-tabs.main');
    await expect(tabs).toBeHidden();
    expect((await tabs.boundingBox())?.height ?? 0).toBe(0);
    const bounds = await page.locator('.work-surface').evaluate(el => ({ top: el.getBoundingClientRect().top, content: el.querySelector('.activity-pane')!.getBoundingClientRect().top }));
    expect(bounds.content).toBeGreaterThanOrEqual(bounds.top);
});

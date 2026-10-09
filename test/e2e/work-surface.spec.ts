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
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removedLines: ['old'], addedLines: [after] }] }, type: 'changeFileState' });
};
const openReview = async (page: Page) => {
    await post(page, { type: 'restoreUser', value: 'Fix this', cp: sha });
    const request = await latest(page, 'changesGetState');
    await post(page, { ...request, type: 'changesState', files: changes });
    await page.locator('#surface-tab-changes').click();
    await replyFile(page);
    await expect(page.locator('.review-diff')).toBeVisible();
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => undefined, setState: (s: unknown) => s }) });
    });
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
});

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
    expect((await sent(page)).some((m) => m.type === 'cancel')).toBe(false);
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
    expect((await sent(page)).some((m) => m.type === 'sendMessage')).toBe(false);
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
    await replyFile(page, 'changed again', previousFile.requestId);
    await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeVisible();
});

test('background jobs stay controllable from all three surfaces', async ({ page }) => {
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }] });
    await page.locator('.bg-jobs-toggle').click();
    for (const name of ['Changes', 'Activity', 'Conversation']) {
        await page.getByRole('tab', { name, exact: true }).click();
        await expect(page.locator('.bg-job-stop')).toBeVisible();
    }
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

import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation, openWorkPanel } from './navigation';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
const provider = { providerId: 'chatgpt-codex', label: 'ChatGPT', methods: ['browser', 'device'] };
for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`installed UI polish (${theme}, ${locale}, ${width})`, async ({ page }) => {
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await installVscodeTheme(page, theme);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(() => {
            let state: object = {};
            const messages: object[] = [];
            Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ getState: () => state, setState: (value: object) => state = value, postMessage: (value: object) => messages.push(value) }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'sessionState', id: 'current', title: 'Current conversation', workspace: '/project' });
        const input = page.locator('.composer-input');
        await input.fill('Retain my draft and selection');
        await input.evaluate(element => { Object.assign(window, { originalInput: element }); (element as HTMLTextAreaElement).setSelectionRange(2, 6); });
        const evidence = join(process.cwd(), 'output/playwright/installed-polish', `${theme}-${locale}-${width}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => { await page.screenshot({ path: join(evidence, `${name}.png`) }); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1); };
        const navigate = async (section: string) => { await openPageNavigation(page); await page.locator(`.page-sidebar [data-section=${section}]`).click(); };
        await page.locator('.toolbar-tools .ghost-btn').last().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.locator('.new-tab-choice')).toHaveCount(8);
        await expect(page.locator('[role=tab][data-panel^="new-"]')).toHaveCount(0);
        await shot('panel-picker');
        await page.keyboard.press('Escape');
        await expect(input).toHaveValue('Retain my draft and selection');
        await openWorkPanel(page, 'activity');
        const beforeLayout = await page.locator('.work-surface').getAttribute('class');
        await page.locator('.toolbar > .sidebar-toggle').click();
        await post(page, { type: 'sessionList', currentId: 'current', items: [
            { id: 'current', title: 'Current conversation', workspace: '/project', updatedAt: Date.now() },
            { id: 'other', title: 'A long session title that needs the entire row', workspace: '/project', updatedAt: Date.now() },
        ] });
        await expect(page.locator('.session-row-date,.session-row-ws')).toHaveCount(0);
        await page.locator('.session-row.current .session-row-main').click();
        await expect(page.locator('.work-surface')).toHaveAttribute('class', beforeLayout!);
        expect((await sent(page)).filter(m => m.type === 'openSession')).toHaveLength(0);
        if (width < 860) {
            await page.locator('.toolbar > .sidebar-toggle').click();
            await post(page, { type: 'sessionList', currentId: 'current', items: [{ id: 'current', title: 'Current conversation', workspace: '/project', updatedAt: Date.now() }, { id: 'other', title: 'A long session title that needs the entire row', workspace: '/project', updatedAt: Date.now() }] });
        }
        const current = page.locator('.session-row.current');
        await current.hover();
        await expect(current.locator('.session-row-action').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await shot('sessions');
        if (width >= 860) {
            await page.locator('.navigation-resize').press(locale === 'fa' ? 'ArrowLeft' : 'ArrowRight');
            await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '238px');
        }
        await page.locator('.session-row').nth(1).locator('.session-row-main').click();
        expect((await sent(page)).filter(m => m.type === 'openSession')).toEqual([{ type: 'openSession', id: 'other' }]);
        await post(page, { type: 'sessionState', id: 'other', title: 'Other conversation', workspace: '/project' });
        await post(page, { type: 'resetConversation' });
        await expect(page.locator('.work-surface')).toHaveAttribute('class', beforeLayout!);
        if (!await page.locator('.workspace-sidebar').isVisible()) await page.locator('.toolbar > .sidebar-toggle').click();
        await page.locator('.workspace-views').first().getByRole('button', { name: locale === 'en' ? 'Workspace' : 'فضای کار', exact: true }).click();
        await expect(page.locator('.workspace-tools button')).toHaveCount(7);
        const heading = await page.locator('.workspace-recent-heading').boundingBox();
        const tools = await page.locator('.workspace-tools').boundingBox();
        expect(Math.abs(heading!.x + heading!.width / 2 - tools!.x - tools!.width / 2)).toBeLessThan(2);
        await shot('workspace');
        await post(page, { type: 'openSettings' });
        await page.locator('#settings-reply-language').click();
        const list = page.locator('.dropdown-list:visible');
        expect(await list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        await shot('reply-language');
        await page.keyboard.press('Escape');
        await page.locator('.preference-clear-history').scrollIntoViewIfNeeded();
        await page.locator('.preference-clear-history').hover();
        await expect.poll(() => page.locator('.preference-clear-history').evaluate(el => { const probe = document.createElement('span'); probe.style.color = 'var(--vscode-errorForeground)'; el.append(probe); const expected = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(el).color === expected; })).toBe(true);
        const proxy = page.locator('.settings-configure-proxy');
        await proxy.scrollIntoViewIfNeeded();
        const rest = await proxy.evaluate(el => getComputedStyle(el).backgroundColor);
        await proxy.hover();
        await expect.poll(() => proxy.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(rest);
        await shot('proxy-hover');
        await navigate('appearance');
        await page.locator('#appearance-font').click();
        await page.locator('#appearance-font').locator('..').getByRole('option').nth(1).click();
        await expect(page.locator('.page-content')).toHaveCSS('font-family', /Consolas/);
        await navigate('skills');
        await post(page, { type: 'skillsState', skills: [
            { id: 'one', name: 'First skill', description: 'Read the first skill', source: 'project-xratu', dirPath: '/skills/one', enabled: true },
            { id: 'two', name: 'Second skill', description: 'Select the whole row', source: 'project-xratu', dirPath: '/skills/two', enabled: true },
        ] });
        await page.locator('.skill-row').nth(1).locator('.mcp-row-meta').click();
        await expect(page.locator('.skill-row').nth(1).locator('.skill-select')).toBeFocused();
        await expect(page.locator('.inventory-inspector h3')).toHaveText('Second skill');
        const rows = page.locator('.skill-row');
        const firstRow = await rows.first().boundingBox();
        const secondRow = await rows.nth(1).boundingBox();
        expect(Math.abs(firstRow!.y + firstRow!.height - secondRow!.y)).toBeLessThanOrEqual(1);
        await shot('skills');
        await navigate('providers');
        for (const method of ['signed-out', 'browser', 'device', 'connected']) {
            await post(page, { type: 'oauthState', state: { providers: [provider], accounts: method === 'connected' ? [{ providerId: provider.providerId, credentialId: 'oauth', accountLabel: 'user@example.test', active: true, planEnabled: true }] : [], inProgress: method === 'browser' || method === 'device' ? { providerId: provider.providerId, method } : null, authorizeUrl: method === 'browser' ? 'https://example.test/auth' : undefined, deviceCode: method === 'device' ? { userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' } : undefined } });
            await page.locator('.account-connections').scrollIntoViewIfNeeded();
            await shot(`account-${method}`);
        }
        await page.locator('.cred-head .page-add').click();
        const search = page.locator('.connection-drawer .cred-search-wrap input');
        await expect(search).toHaveCSS('border-top-width', '0px');
        await shot('add-provider');
        await page.keyboard.press('Escape');
        await navigate('usage');
        await post(page, { type: 'usageState', providers: [], rates: [], chatgpt: { totals: { input: 12000, output: 3000, cached: 2000, USD: 0, IRT: 0 }, models: [{ model: 'gpt-5.4', tokens: 15000 }], hasHistory: true } });
        await expect(page.locator('.usage-plan-summary')).toBeVisible();
        await shot('plan-usage');
        expect(errors).toEqual([]);
    });
}

for (const locale of ['en', 'fa']) test(`composer collapses once and hidden tabs do not overlap content (${locale})`, async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => { Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => undefined, setState: (s: unknown) => s, postMessage: () => {} }) }); });
    await page.goto('/');
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'restoreUser', value: 'Keep this conversation' });
    const input = page.locator('.composer-input');
    await input.fill('Three lines\nof text\nremain intact');
    await input.focus();
    await input.evaluate(el => { (el as HTMLTextAreaElement).setSelectionRange(2, 7); });
    await expect(page.locator('.composer')).toHaveCSS('border-radius', '11px');
    const frames = await input.evaluate(async el => {
        const card = el.closest('.input-bar')!.querySelector('.composer')!;
        const samples: Array<{ time: number; height: number }> = [];
        const start = performance.now();
        (el as HTMLTextAreaElement).blur();
        while (performance.now() - start < 340) { await new Promise(requestAnimationFrame); samples.push({ time: performance.now() - start, height: card.getBoundingClientRect().height }); }
        return samples;
    });
    for (let i = 1; i < frames.length; i++) expect(frames[i].height).toBeLessThanOrEqual(frames[i - 1].height + .6);
    const final = frames.at(-1)!.height;
    for (const sample of frames.filter(frame => frame.time >= 190)) expect(Math.abs(sample.height - final)).toBeLessThan(1);
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

for (const theme of ['dark', 'light'] as const) test(`saved connection borders follow every accent (${theme})`, async ({ page }) => {
    await installVscodeTheme(page, theme);
    await page.addInitScript(() => { Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => undefined, setState: (s: unknown) => s, postMessage: () => {} }) }); });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'savedCredentials', activeId: 'saved', credentials: [{ id: 'saved', providerId: 'openai', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', label: 'OpenAI', active: true }] });
    await post(page, { type: 'openSettings' });
    const borders = new Set<string>();
    for (const accent of ['Teal', 'Blue', 'Violet', 'Amber', 'Rose', 'Neutral', 'White', 'Graphite']) {
        await openPageNavigation(page);
        await page.locator('.page-sidebar [data-section=appearance]').click();
        await page.getByRole('radio', { name: accent, exact: true }).click();
        await openPageNavigation(page);
        await page.locator('.page-sidebar [data-section=providers]').click();
        const icon = page.locator('.saved-credential-main .provider-mark');
        await expect(icon).toBeVisible();
        borders.add(await icon.evaluate(el => getComputedStyle(el).borderTopColor));
    }
    expect(borders.size).toBe(8);
});

for (const locale of ['en', 'fa']) for (const width of [420, 1080]) test(`session replay preserves the mounted workbench and separate drafts (${locale}, ${width})`, async ({ page }) => {
    await installVscodeTheme(page);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => { let state: unknown; Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (value: unknown) => state = value, postMessage: () => {} }) }); });
    await page.goto('/');
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'sessionState', id: 'a', browserSessionId: 'a', workspace: '/project', title: 'A' });
    await page.locator('.composer-input').fill('Draft in A');
    await post(page, { type: 'restoreUser', value: 'Old conversation' });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'needsApproval', approval_id: 'old', approvals: [{ tool_call_id: 'write', tool_name: 'write_file', args: { path: 'old.txt' } }] });
    await expect(page.locator('.approval-card')).toHaveCount(1);
    await openWorkPanel(page, 'browser');
    if (width >= 860) await page.locator('#surface-tab-browser').press(locale === 'fa' ? 'Control+Shift+ArrowLeft' : 'Control+Shift+ArrowRight');
    await openWorkPanel(page, 'activity');
    const layout = await page.locator('.work-surface').getAttribute('class');
    await page.evaluate(() => Object.assign(window, { retainedTranscript: document.querySelector('.messages'), retainedBrowser: document.querySelector('.browser-pane') }));
    await post(page, { type: 'resetConversation' });
    await post(page, { type: 'sessionState', id: 'b', browserSessionId: 'b', workspace: '/project', title: 'B' });
    await post(page, { type: 'restoreUser', value: 'New conversation' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.work-surface')).toHaveAttribute('class', layout!);
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await expect(page.locator('.msg.user')).toHaveCount(1);
    await expect(page.locator('.msg.user')).toContainText('New conversation');
    expect(await page.evaluate(() => {
        const refs = window as unknown as { retainedTranscript: Element; retainedBrowser: Element };
        return document.querySelector('.messages') === refs.retainedTranscript && document.querySelector('.browser-pane') === refs.retainedBrowser;
    })).toBe(true);
    await openWorkPanel(page, 'conversation');
    await expect(page.locator('.composer-input')).toHaveValue('');
    await page.locator('.composer-input').fill('Draft in B');
    await post(page, { type: 'resetConversation' });
    await post(page, { type: 'sessionState', id: 'a', browserSessionId: 'a', workspace: '/project', title: 'A' });
    await post(page, { type: 'restoreUser', value: 'Old conversation' });
    await expect(page.locator('.composer-input')).toHaveValue('Draft in A');
    await expect(page.locator('.msg.user')).toHaveCount(1);
});

for (const locale of ['en', 'fa']) test(`navigation width supports dragging, restore and narrow windows (${locale})`, async ({ page }) => {
    await installVscodeTheme(page);
    await page.setViewportSize({ width: 1080, height: 900 });
    await page.addInitScript(() => {
        const win = window as unknown as { navigationState?: Record<string, unknown>; acquireVsCodeApi: () => unknown };
        win.navigationState ??= { unrelated: 'preserve' };
        win.acquireVsCodeApi = () => ({ getState: () => win.navigationState, setState: (value: Record<string, unknown>) => win.navigationState = value, postMessage: () => {} });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'showChat' });
    await page.locator('.toolbar > .sidebar-toggle').click();
    const separator = page.locator('.navigation-resize');
    const start = (await separator.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + 100);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + (locale === 'fa' ? -90 : 90), start.y + 100, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '308px');
    const saved = await page.evaluate(() => (window as unknown as { navigationState: Record<string, unknown> }).navigationState);
    expect(saved.unrelated).toBe('preserve');
    expect(saved.navigationWidth).toBe(308);
    await page.addInitScript(value => Object.assign(window, { navigationState: value }), saved);
    await page.reload();
    await post(page, { type: 'locale', locale });
    await post(page, { type: 'showChat' });
    await page.locator('.toolbar > .sidebar-toggle').click();
    await expect(page.locator('.workspace-sidebar')).toHaveCSS('width', '308px');
    await page.setViewportSize({ width: 420, height: 900 });
    await expect(separator).toBeHidden();
    expect((await page.locator('.workspace-sidebar').boundingBox())!.width).toBeLessThanOrEqual(270);
});

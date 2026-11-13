import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation, openWorkPanel } from './navigation';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
const sent = (page: Page): Promise<Array<Record<string, unknown>>> => page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
const choose = async (page: Page, id: string, index: number) => {
    await page.locator(`#${id}`).click();
    await page.locator(`#${id}`).locator('..').getByRole('option').nth(index).click();
};

for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`appearance, compact navigation and populated work panels (${theme}, ${locale}, ${width})`, async ({ page }) => {
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await installVscodeTheme(page, theme);
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(() => {
            let state: Record<string, unknown> = JSON.parse(sessionStorage.getItem('test-webview-state') ?? '{"unrelatedPreference":"retained"}');
            const messages: object[] = [];
            Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: object) => messages.push(message), getState: () => state, setState: (value: Record<string, unknown>) => { state = value; sessionStorage.setItem('test-webview-state', JSON.stringify(value)); } }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        const evidence = join(process.cwd(), 'output', 'playwright', 'refinements', `${theme}-${locale}-${width}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => {
            await page.mouse.move(width - 1, 0);
            await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' });
            expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), name).toBeLessThanOrEqual(1);
        };
        const navigate = async (section: string) => {
            await openPageNavigation(page);
            await page.locator(`.sidebar-item[data-section="${section}"]`).click();
        };
        const input = page.locator('.composer-input');
        await input.fill('Keep my draft');
        await page.locator('input[type="file"]').setInputFiles({ name: 'context.ts', mimeType: 'text/plain', buffer: Buffer.from('export const context = true;') });
        await expect(page.locator('.attach-chip')).toContainText('context.ts');
        const chroma = await page.locator('.attach-chip').evaluate(element => {
            const canvas = document.createElement('canvas').getContext('2d')!;
            canvas.fillStyle = getComputedStyle(element).backgroundColor;
            canvas.fillRect(0, 0, 1, 1);
            const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
            return Math.max(r, g, b) - Math.min(r, g, b);
        });
        expect(chroma).toBeLessThanOrEqual(1);
        await shot('composer-attachment');
        await page.locator('.attach-chip-remove').click();
        await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 7); Object.assign(window, { originalInput: element }); });
        await expect(page.locator('.toolbar-tools').getByRole('button', { name: /^(Settings|Tools|تنظیمات|ابزارها)$/ })).toHaveCount(0);
        await page.locator('.toolbar > .sidebar-toggle').click();
        const sessionList = { type: 'sessionList', currentId: 'current', items: [
            { id: 'current', title: locale === 'en' ? 'Refine project navigation' : 'بهبود ناوبری پروژه', workspace: 'C:\\projects\\xratu', updatedAt: Date.now(), engineId: 'xratu', model: 'qwen3-coder' },
            { id: 'previous', title: locale === 'en' ? 'Review API changes' : 'بررسی تغییرات API', workspace: 'C:\\projects\\xratu', updatedAt: Date.now() - 3600000, engineId: 'opencode', model: 'coder' },
        ] };
        await post(page, sessionList);
        await expect(page.locator('.session-search')).toHaveCount(0);
        await shot('sessions');
        await page.locator('.session-search-toggle').click();
        const search = page.locator('.session-search input');
        await expect(search).toBeFocused();
        await search.fill('navigation');
        await expect.poll(async () => (await sent(page)).some(message => message.type === 'searchSessions' && message.query === 'navigation')).toBe(true);
        await shot('sessions-search');
        await page.keyboard.press('Escape');
        await expect(search).toHaveCount(0);
        await expect(page.locator('.session-search-toggle')).toBeFocused();
        await expect(page.locator('.workspace-sidebar')).toBeVisible();
        await expect(page.locator('.session-row')).toHaveCount(2);
        await page.locator('.workspace-views').first().getByRole('button', { name: locale === 'en' ? 'History' : 'تاریخچه', exact: true }).click();
        await page.locator('.sessions-page .inventory-search input').fill('retained history filter');
        await page.locator('.toolbar-back-work').click();
        if (!await page.locator('.workspace-sidebar').isVisible()) await page.locator('.toolbar > .sidebar-toggle').click();
        await post(page, sessionList);
        if (width >= 860) {
            await expect(search).toBeVisible();
            await expect(search).toHaveValue('retained history filter');
            await search.focus();
            await page.keyboard.press('Escape');
        }
        await expect(search).toHaveCount(0);
        await expect(page.locator('.session-row')).toHaveCount(2);
        await page.locator('.toolbar > .sidebar-toggle').click();

        await post(page, { type: 'openSettings' });
        await navigate('appearance');
        await expect(page.locator('.appearance-control')).toHaveCount(9);
        await shot('appearance');
        await choose(page, 'appearance-text-size', 2);
        await choose(page, 'appearance-code-size', 3);
        await choose(page, 'appearance-font', 1);
        await choose(page, 'appearance-width', 2);
        await choose(page, 'appearance-density', 1);
        await choose(page, 'appearance-motion', 1);
        await expect(page.locator('.appearance-preview')).toHaveCSS('font-size', '16px');
        await expect(page.locator('.appearance-preview pre')).toHaveCSS('font-size', '16px');
        await expect(page.locator('.appearance-preview')).toHaveCSS('font-family', /Consolas/);
        await page.locator('.appearance-preview').scrollIntoViewIfNeeded();
        await shot('appearance-customized');
        await page.locator('.toolbar-back-work').click();
        await expect(input).toHaveValue('Keep my draft');
        expect(await input.evaluate(element => element === (window as unknown as { originalInput: Element }).originalInput)).toBe(true);
        expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 7]);
        await post(page, { type: 'restoreUser', value: 'Retained conversation' });
        await expect(page.locator('.messages-inner')).toHaveCSS('max-width', '900px');
        await expect(page.locator('.messages-inner')).toHaveCSS('gap', '18px');
        await expect(page.locator('.msg-content').first()).toHaveCSS('font-size', '16px');
        await expect(input).toHaveCSS('transition-duration', '1e-05s');
        await page.reload();
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await expect(page.locator('.app')).toHaveAttribute('data-density', 'compact');
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('test-webview-state')!).unrelatedPreference)).toBe('retained');
        await post(page, { type: 'openSettings' });
        await navigate('appearance');
        await expect(page.locator('#appearance-text-size')).toContainText('16 px');
        await page.locator('.appearance-reset').click();
        await expect(page.locator('#appearance-text-size')).toContainText('14 px');
        await expect(page.locator('.appearance-reset')).toBeDisabled();

        await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', installedByXratu: true, version: '2.1.4', busy: false } });
        await navigate('engines');
        await expect(page.locator('.engine-footer button').first()).toHaveCSS('border-radius', '8px');
        await expect(page.locator('.engine-card').last().locator('.engine-footer button')).toHaveCount(2);
        await expect(page.locator('.engine-card').last().locator('.engine-footer button').first().locator('svg')).toBeVisible();
        await expect(page.locator('.engine-installation input')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await shot('engines');
        await page.locator('.engine-installation').scrollIntoViewIfNeeded();
        await shot('engine-installation');
        await navigate('proxy');
        await post(page, { type: 'proxyState', mode: 'auto', proxyUrl: '', noProxy: 'localhost,127.0.0.1', resolvedUrl: 'http://127.0.0.1:7890', resolvedSource: 'system', webSearchUseProxy: true });
        await expect(page.locator('.route-node').first()).toHaveCSS('border-top-width', '0px');
        await page.locator('#proxy-noproxy').fill('localhost,127.0.0.1,.internal');
        const save = page.locator('.proxy-save-row .apply-btn');
        await expect(save).toBeEnabled();
        await expect(save).toHaveCSS('color', theme === 'dark' ? 'rgb(8, 44, 36)' : 'rgb(255, 255, 255)');
        await expect.poll(() => save.evaluate(element => getComputedStyle(element.querySelector('span')!).color === getComputedStyle(element).color)).toBe(true);
        await save.scrollIntoViewIfNeeded();
        await shot('proxy-draft');
        await page.locator('.route-map').scrollIntoViewIfNeeded();
        await shot('proxy');

        await navigate('providers');
        await post(page, { type: 'savedCredentials', credentials: [{ id: 'ollama', label: 'Ollama', providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', maskedKey: '', active: true }] });
        await page.locator('.cred-head .page-add').click();
        await shot('provider-add');
        const providerSearch = page.locator('.cred-provider-box input');
        await providerSearch.fill('Avalai');
        await shot('provider-search');
        await page.keyboard.press('Enter');
        await expect(page.locator('.compact-dialog .cred-field input').first()).toHaveValue('https://api.avalai.ir/v1');
        await page.locator('.compact-dialog input[type="password"]').fill('test-key-not-a-secret');
        const footer = page.locator('.compact-dialog .cred-form-footer');
        const note = (await footer.locator('.cred-security-hint').boundingBox())!;
        const connect = (await footer.locator('.cred-save').boundingBox())!;
        expect(Math.abs(note.y + note.height / 2 - connect.y - connect.height / 2)).toBeLessThan(2);
        await shot('provider-iranian');
        const connectionUrl = page.locator('.compact-dialog .cred-field input').first();
        await connectionUrl.evaluate(element => Object.assign(window, { providerInput: element }));
        await page.locator('.compact-dialog .cred-save').click();
        await expect.poll(async () => (await sent(page)).some(message => message.type === 'saveLlmCredentials')).toBe(true);
        const connectionError = locale === 'en' ? 'Connection failed. Check the URL and key, then try again.' : 'اتصال برقرار نشد. آدرس و کلید رو بررسی کن و دوباره امتحان کن.';
        await post(page, { type: 'byokCredentialError', value: connectionError });
        await expect(page.locator('.compact-dialog [role="alert"]')).toHaveText(connectionError);
        await page.locator('.compact-dialog [role="alert"]').scrollIntoViewIfNeeded();
        expect(await connectionUrl.evaluate(element => element === (window as unknown as { providerInput: Element }).providerInput)).toBe(true);
        await shot('provider-error');
        await page.keyboard.press('Escape');
        const retry = page.locator('.cred-notice-retry');
        await expect(retry).toHaveCSS('color', theme === 'dark' ? 'rgb(248, 81, 73)' : 'rgb(229, 20, 0)');
        await retry.hover();
        await expect(retry.locator('span')).toHaveCSS('color', theme === 'dark' ? 'rgb(248, 81, 73)' : 'rgb(229, 20, 0)');
        await shot('provider-retry');
        await page.locator('.cred-head .page-add').click();
        await page.locator('.compact-dialog input[type="password"]').fill('test-key-not-a-secret');
        await page.locator('.compact-dialog .cred-save').click();
        await post(page, { type: 'savedCredentials', credentials: [
            { id: 'ollama', label: 'Ollama', providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', maskedKey: '', active: false },
            { id: 'avalai', label: 'Avalai', providerId: 'avalai', baseUrl: 'https://api.avalai.ir/v1', maskedKey: '••••cret', active: true },
        ] });
        await post(page, { type: 'credentialsSaved', returnToChat: false, credentialId: 'avalai' });
        await expect(page.locator('.compact-dialog [role="alert"]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.locator('.compact-dialog')).toHaveCount(0);
        await shot('provider-connected');
        await page.locator('.cred-head .page-add').click();
        await providerSearch.fill('Ollama');
        await page.keyboard.press('Enter');
        await page.locator('.compact-dialog input[type="password"]').fill('');
        await shot('provider-local');
        await page.keyboard.press('Escape');
        await post(page, { type: 'credentialsSaved', returnToChat: true, credentialId: 'ollama' });
        await expect(page.locator('.composer-input')).toBeVisible();

        // Real host envelopes populate manually opened work panels.
        const cp = 'a'.repeat(40);
        await post(page, { type: 'restoreUser', value: locale === 'en' ? 'Add search to the project navigation' : 'جستجو رو به ناوبری پروژه اضافه کن', cp });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'edit_file', args: JSON.stringify({ path: 'src/navigation.ts', old_text: 'const search = false;', new_text: 'const search = true;' }), callId: 'edit' });
        await post(page, { type: 'toolResult', tool: 'edit_file', output: 'File updated.', callId: 'edit' });
        await post(page, { type: 'fullResponse', persian: locale === 'en' ? 'Added search to the project sidebar and kept keyboard navigation intact.' : 'جستجو به سایدبار پروژه اضافه شد و ناوبری با کیبورد هم حفظ شد.' });
        await input.fill(locale === 'en' ? 'Next, check the narrow layout' : 'حالا چیدمان باریک رو بررسی کن');
        await input.blur();
        await expect(page.locator('.workspace-switcher')).toHaveCount(0);
        await shot('conversation-completed');
        await openWorkPanel(page, 'changes');
        if (width >= 860) await page.locator('#surface-tab-changes').press(locale === 'fa' ? 'Control+Shift+ArrowLeft' : 'Control+Shift+ArrowRight');
        // The completed turn can supersede the initial checkpoint request.
        // Answer each new request like the host; stale replies must stay rejected.
        let answered: unknown;
        await expect.poll(async () => {
            const request = (await sent(page)).filter(message => message.type === 'changesGetState' && message.sha === cp).at(-1);
            if (request && request.requestId !== answered) {
                answered = request.requestId;
                await post(page, { ...request, type: 'changesState', files: [{ path: 'src/navigation.ts', added: 1, removed: 1, binary: false }, { path: 'test/navigation.test.ts', added: 18, removed: 0, untracked: true, binary: false }] });
            }
            return page.locator('.changes-pane .review-file').count();
        }).toBeGreaterThan(0);
        if (width < 860) await openWorkPanel(page, 'changes');
        await expect(page.locator('.changes-pane .review-file').first()).toBeVisible();
        if (await page.locator('.changes-pane .review-file').first().getAttribute('aria-expanded') !== 'true') await page.locator('.changes-pane .review-file').first().click();
        await expect.poll(async () => (await sent(page)).some(message => message.type === 'changeFileGet')).toBe(true);
        const file = (await sent(page)).filter(message => message.type === 'changeFileGet').at(-1)!;
        await post(page, { ...file, type: 'changeFileState', file: { path: file.path, kind: 'text', before: 'const search = false;', after: 'const search = true;', hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, removedLines: ['const search = false;'], addedLines: ['const search = true;'] }] } });
        await expect(page.locator('.review-diff')).toBeVisible();
        await expect(page.locator('.review-ask')).toHaveCount(0);
        await shot('changes-diff');
        await openWorkPanel(page, 'conversation');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'explore', description: 'Check keyboard navigation' }), callId: 'agent' });
        await post(page, { type: 'subagentState', callId: 'agent', trace: { taskId: 'child', profile: 'explore', description: 'Check keyboard navigation', prompt: 'Inspect search focus and Escape', model: 'qwen3-coder', tools: ['read_file'], resumed: false, status: 'running', startedAt: Date.now() - 4000, updatedAt: Date.now(), toolCalls: 1, inputTokens: 480, outputTokens: 80, entries: [{ id: 'read', kind: 'tool', tool: 'read_file', text: '{"path":"src/navigation.ts"}', output: 'const search = true;', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000 }] } });
        await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'dev', command: 'npm run dev', running: true, uptimeSeconds: 12 }] });
        await openWorkPanel(page, 'agents');
        if (width >= 860) await page.locator('#surface-tab-agents').press(locale === 'fa' ? 'Control+Shift+ArrowLeft' : 'Control+Shift+ArrowRight');
        await expect(page.locator('.agents-pane:not(.panel-hidden)')).toBeVisible();
        await shot('agent-run');
        await openWorkPanel(page, 'background');
        await shot('background-run');
        await openWorkPanel(page, 'conversation');
        await post(page, { type: 'needsApproval', approval_id: 'verify', approvals: [{ tool_call_id: 'check', tool_name: 'run_terminal_command', args: { command: 'npm test' } }] });
        await shot('approval');
        expect(errors).toEqual([]);
    });
}

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import type { ComposerAttachment } from '../../webview-ui/src/types';

async function post(page: Page, message: object) { await page.evaluate((value) => window.postMessage(value, '*'), message); }
async function sent(page: Page) { return page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string; value?: string; requestId?: string; attachments?: ComposerAttachment[] }[] }).__xratuHostMessages); }

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const messages: object[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: object) => messages.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`repeated OpenCode edit failures show recovery and release the composer (${locale}, ${width})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        const state = { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: false, busy: false };
        await post(page, { type: 'enginesState', state });
        await post(page, { type: 'modelInfo', defaultModel: 'fixture/stub', selectedModel: 'fixture/stub', models: ['fixture/stub'] });
        await page.locator('.composer-input').fill('Fix this file');
        await page.locator('.send-btn').click();
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'enginesState', state: { ...state, busy: true } });
        for (let index = 0; index < 3; index++) {
            const callId = `failed-edit-${index}`;
            await post(page, { type: 'toolCall', tool: 'edit_file', callId, args: JSON.stringify({ path: 'game/combat.py' }) });
            await post(page, { type: 'toolResult', tool: 'edit_file', callId, output: 'No changes to apply: oldString and newString are identical.', isError: true });
        }
        await post(page, { type: 'error', valueKey: 'engineRepeatedEditFailures' });
        await post(page, { type: 'enginesState', state });
        await expect(page.locator('.msg-content.msg-text').filter({ hasText: locale === 'en' ? /OpenCode stopped after three consecutive/ : /OpenCode بعد از سه ویرایش ناموفق/ })).toBeVisible();
        await expect(page.locator('.send-btn')).not.toHaveClass(/is-stop/);
        await page.locator('.composer-input').fill('Continue with a corrected edit');
        await expect(page.locator('.send-btn')).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath('edit-failure-recovery.png') });
        await page.locator('.send-btn').click();
        expect(await sent(page)).toContainEqual(expect.objectContaining({ type: 'askQuestion', value: 'Continue with a corrected edit' }));
    });

    test(`OpenCode sends code uploads and workspace references, including steers (${locale}, ${width})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: false, busy: false } });
        await post(page, { type: 'modelInfo', defaultModel: 'fixture/stub', selectedModel: 'fixture/stub', models: ['fixture/stub'] });
        const code = '// full attached code\n'.repeat(1500) + 'const ATTACHMENT_TAIL = true;';
        await page.locator('input[type="file"]').setInputFiles({ name: 'sample.ts', mimeType: 'text/plain', buffer: Buffer.from(code) });
        await expect(page.locator('.attach-chip')).toContainText('sample.ts');
        await page.locator('.composer-input').fill('@src');
        await post(page, { type: 'fileList', files: ['src/reference.ts'] });
        await page.locator('.mention-pop .mention-item').filter({ hasText: 'reference.ts' }).click();
        await expect(page.locator('.attach-chip')).toHaveCount(2);
        if (process.env.XRATU_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('code-attachments.png') });
        await page.locator('.send-btn').click();
        const request = (await sent(page)).findLast((message) => message.type === 'askQuestion')!;
        expect(request.attachments).toHaveLength(2);
        expect(Buffer.from(request.attachments![0].dataBase64, 'base64').toString()).toBe(code);
        expect(request.attachments![1].path).toBe('src/reference.ts');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: 'Reading the files' });
        await page.locator('input[type="file"]').setInputFiles({ name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('STEER_ATTACHMENT') });
        await expect(page.locator('.attach-chip')).toContainText('follow-up.txt');
        await page.locator('.composer-input').fill('Read this too');
        await page.locator('.send-btn').click();
        const steer = (await sent(page)).findLast((message) => message.type === 'steerRun')!;
        expect(Buffer.from(steer.attachments![0].dataBase64, 'base64').toString()).toBe('STEER_ATTACHMENT');
    });

    test(`OpenCode cancellation releases the composer and shared MCPs retain their scope (${locale}, ${width})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        const state = { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: false, busy: false };
        await post(page, { type: 'enginesState', state });
        await post(page, { type: 'modelInfo', defaultModel: 'fixture/stub', selectedModel: 'fixture/stub', models: ['fixture/stub'], displayNames: { 'fixture/stub': 'OpenCode test' }, capabilities: { 'fixture/stub': { provider: 'fixture', free: false } } });
        await page.locator('.composer-input').fill('First request');
        await page.locator('.send-btn').click();
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'enginesState', state: { ...state, busy: true } });
        await post(page, { type: 'chunk', value: 'Working' });
        await page.locator('.send-btn.is-stop').click();
        expect(await sent(page)).toContainEqual({ type: 'cancelRequest' });
        await post(page, { type: 'error', valueKey: 'requestCancelled' });
        await post(page, { type: 'enginesState', state });
        await expect(page.locator('.send-btn')).not.toHaveClass(/is-stop/);
        await page.locator('.composer-input').fill('Continue in this session');
        await expect(page.locator('.send-btn')).toBeEnabled();
        await page.locator('.send-btn').click();
        expect(await sent(page)).toContainEqual(expect.objectContaining({ type: 'askQuestion', value: 'Continue in this session' }));
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'fullResponse', renderedHtml: '<p>Continued successfully</p>' });
        await expect(page.locator('.msg.assistant').last()).toContainText('Continued successfully');
        if (process.env.XRATU_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('cancel-continue.png') });

        await post(page, { type: 'openSettings' });
        await page.locator('.page-sidebar').getByRole('button', { name: locale === 'en' ? 'Servers' : 'سرور ها', exact: true }).click();
        await expect.poll(async () => (await sent(page)).filter((message) => message.type === 'nativeGetState').length).toBeGreaterThan(0);
        const requestId = (await sent(page)).filter((message) => message.type === 'nativeGetState').at(-1)!.requestId;
        await post(page, { type: 'nativeSetupState', state: { requestId, phase: 'ready', integrations: [], servers: [{ name: 'Xratu', status: 'connected' }, { name: 'native-docs', status: 'connected' }], skills: [] } });
        await expect(page.locator('.native-config-row').filter({ hasText: 'Xratu' })).toBeVisible();
        if (process.env.XRATU_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath('native-mcp.png') });
        await page.locator('#settings-engine').click();
        await page.getByRole('option', { name: 'Xratu', exact: true }).click();
        await post(page, { type: 'mcpState', servers: [], hasWorkspace: true, legacyInUse: false });
        await expect(page.locator('.native-config')).toHaveCount(0);
        expect((await sent(page)).some((message) => message.type === 'engineSelect')).toBe(false, 'editing shared MCP settings does not switch the conversation engine');
    });
}

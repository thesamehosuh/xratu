import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

for (const [locale, width] of [['en', 1280], ['fa', 420]] as const) {
    test(`durable child conversations (${locale}, ${width})`, async ({ page }) => {
        await installVscodeTheme(page);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(() => {
            const messages: unknown[] = [];
            Object.assign(window, { __childMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => undefined, setState: () => {} }) });
        });
        await page.goto('/');
        const post = (message: Record<string, unknown>) => page.evaluate(value => window.postMessage(value, '*'), message);
        await post({ type: 'showChat' }); await post({ type: 'locale', locale });
        await post({ type: 'childSessions', rootId: 'family', sessions: [
            { id: 'a', title: 'Check Windows paths', profile: 'explore', model: 'model-alpha', effort: 'high', state: 'running', revision: 1, queued: 0, messages: [{ id: 'm1', role: 'user', content: 'Investigate the path mismatch.' }, { id: 'm2', role: 'assistant', content: 'Checking path ownership.', toolCalls: [{id:'call-1', name:'read_file', arguments:'{"path":"example.txt"}'}] }, {id:'m4', role:'tool', content:'File contents', toolCallId:'call-1'}] },
            { id: 'b', title: 'Inspect persistence', profile: 'general', model: 'model-beta', effort: 'low', state: 'completed', revision: 1, queued: 0, messages: [{ id: 'm3', role: 'assistant', content: 'History is retained.' }] },
        ] });
        await expect(page.locator('.child-sessions')).toBeHidden();
        await page.locator('#surface-tab-agents').click();
        await expect(page.locator('.child-conversation-header')).toContainText('Check Windows paths');
        await expect(page.locator('#surface-tab-agents')).toContainText('1');
        if (width === 420) await page.locator('.child-back').click();
        await expect(page.locator('.child-session-row').first()).toContainText('model-alpha');
        await expect(page.locator('.child-session-row').first()).toContainText('high');
        await page.locator('.child-session-row').first().click();
        await expect(page.locator('.child-conversation-header .child-model-summary')).toContainText('model-alpha');
        await expect(page.locator('.child-conversation-header .child-model-summary')).toContainText('high');
        await expect(page.locator('.child-conversation')).toContainText('Checking path ownership.');
        await page.locator('.child-view-switch button').nth(1).click();
        await expect(page.locator('.child-activity')).toContainText(locale === 'en' ? 'Read file' : 'خواندن فایل');
        await page.locator('.child-view-switch button').first().click();
        await page.locator('.child-composer textarea').fill('Also check UNC paths');
        await page.locator('.child-composer button[type=submit]').click();
        expect(await page.evaluate(() => (window as unknown as { __childMessages: Array<Record<string, unknown>> }).__childMessages)).toContainEqual(expect.objectContaining({ type: 'childSessionAction', rootId: 'family', sessionId: 'a', action: 'send', text: 'Also check UNC paths' }));
        await page.locator('.child-composer textarea').fill('Keep this draft');
        if (width === 420) await page.locator('.child-back').click();
        await page.locator('.child-session-row').nth(1).click();
        await expect(page.locator('.child-messages')).toContainText('History is retained.');
        if (width === 420) await page.locator('.child-back').click();
        await page.locator('.child-session-row').first().click();
        await expect(page.locator('.child-composer textarea')).toHaveValue('Keep this draft');
        await page.locator('.child-conversation-header .agent-run-stop').click();
        expect(await page.evaluate(() => (window as unknown as { __childMessages: Array<Record<string, unknown>> }).__childMessages)).toContainEqual(expect.objectContaining({ type: 'childSessionAction', sessionId: 'a', action: 'stop' }));
        if (width === 420) await page.locator('.child-back').click();
        await page.locator('.child-session-row').nth(1).click();
        await expect(page.locator('.child-conversation-header .child-model-summary')).toContainText('model-beta');
        await expect(page.locator('.child-conversation-header .child-model-summary')).toContainText('low');
        await expect(page.locator('.child-settings')).toHaveCount(0);
        expect(await page.locator('.child-sessions').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    });
}

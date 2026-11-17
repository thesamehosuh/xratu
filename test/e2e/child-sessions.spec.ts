import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

for (const locale of ['en', 'fa']) for (const width of [420, 1280]) {
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
            { id: 'a', title: 'Check Windows paths', profile: 'explore', state: 'running', revision: 1, queued: 0, messages: [{ id: 'm1', role: 'user', content: 'Investigate the path mismatch.' }, { id: 'm2', role: 'assistant', content: 'Checking path ownership.' }] },
            { id: 'b', title: 'Inspect persistence', profile: 'general', state: 'completed', revision: 1, queued: 0, messages: [{ id: 'm3', role: 'assistant', content: 'History is retained.' }] },
        ] });
        await expect(page.locator('.child-sessions')).toBeHidden();
        await page.locator('#surface-tab-agents').click();
        await page.locator('.child-session-row').first().click();
        await expect(page.locator('.child-conversation')).toContainText('Checking path ownership.');
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
        await page.locator('.child-settings summary').click();
        await page.locator('input[name=model]').fill('alternate-model');
        await page.locator('input[name=rounds]').fill('24');
        await page.locator('.child-settings button[type=submit]').click();
        const outbound = await page.evaluate(() => (window as unknown as { __childMessages: Array<Record<string, unknown>> }).__childMessages);
        const configuration = outbound.find(message => message.action === 'configure');
        expect(JSON.parse(String(configuration?.text))).toMatchObject({model:'alternate-model',rounds:24,revision:1});
        expect(await page.locator('.child-sessions').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    });
}

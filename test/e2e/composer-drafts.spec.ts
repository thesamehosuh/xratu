import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, msg: Record<string, unknown>) => page.evaluate(message => window.postMessage(message, '*'), msg);
async function session(page: Page, id: string | null, workspace = '/project', browserSessionId = id ?? 'fresh') {
    await page.evaluate(message => new Promise<void>(resolve => {
        // postMessage delivery is asynchronous. Wait for delivery and React's
        // commit before a fill can target the previous session's textarea.
        window.addEventListener('message', () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), { once: true });
        window.postMessage(message, '*');
    }), { type: 'sessionState', id, title: id, workspace, browserSessionId });
}

test('drafts isolate sessions and survive reload (fa, 420)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        (window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
            postMessage: () => undefined,
            getState: () => JSON.parse(sessionStorage.getItem('webviewState') ?? '{}'),
            setState: (state: unknown) => sessionStorage.setItem('webviewState', JSON.stringify(state)),
        });
    });
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();
    await post(page, { type: 'locale', locale: 'fa' });
    await session(page, 'A');
    await post(page, { type: 'showChat' });
    const input = page.locator('.composer-input');
    await input.fill('draft A');
    await session(page, 'B');
    await expect(input).toHaveValue('');
    await input.fill('draft B');
    await session(page, 'A');
    await expect(input).toHaveValue('draft A');
    await session(page, 'A', '/other-project');
    await expect(input).toHaveValue('');
    await session(page, 'B');
    await expect(input).toHaveValue('draft B');
    await page.reload();
    await expect(page.locator('.app')).toBeAttached();
    await post(page, { type: 'locale', locale: 'fa' });
    await session(page, 'A');
    await post(page, { type: 'showChat' });
    await expect(input).toHaveValue('draft A');
    // Assigning a durable disk ID to this same new chat must keep a
    // follow-up draft typed while the first request was being saved.
    await session(page, null);
    await input.fill('follow-up');
    await session(page, 'created', '/project', 'fresh');
    await expect(input).toHaveValue('follow-up');
    await session(page, 'A');
    await expect(input).toHaveValue('draft A');
    await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', customPath: '', installedByXratu: false, busy: false } });
    await post(page, { type: 'restoreUser', value: 'Previous request' });
    await page.getByRole('button', { name: 'ویرایش پیام', exact: true }).click();
    await expect(input).toHaveValue('Previous request');
    await input.fill('Unsent edit');
    await page.reload();
    await expect(page.locator('.app')).toBeAttached();
    await post(page, { type: 'locale', locale: 'fa' });
    await session(page, 'A');
    await post(page, { type: 'showChat' });
    await expect(input).toHaveValue('draft A');
    await page.getByRole('button', { name: 'بازیابی پیش نویس', exact: true }).click();
    await expect(input).toHaveValue('draft A\n\nUnsent edit');
});

test('send receipts preserve newer typing and reject stale replies (en, 1100)', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const messages: Array<Record<string, unknown>> = [];
        (window as unknown as { draftMessages: unknown }).draftMessages = messages;
        (window as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi = () => ({
            postMessage: (message: Record<string, unknown>) => messages.push(message),
            getState: () => undefined, setState: () => undefined,
        });
    });
    const latest = () => page.evaluate(() => (window as unknown as { draftMessages: Array<Record<string, unknown>> }).draftMessages.filter(m => m.type === 'askQuestion').at(-1)!);
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();
    await post(page, { type: 'locale', locale: 'en' });
    await session(page, 'A');
    await post(page, { type: 'showChat' });
    const input = page.locator('.composer-input');
    await input.fill('rejected draft'); await input.press('Enter');
    const rejected = await latest();
    await expect(input).toHaveValue('rejected draft');
    await post(page, { type: 'sendReceipt', requestId: rejected.requestId, sessionKey: 'A', status: 'rejected' });
    await expect(input).toHaveValue('rejected draft');
    await expect(page.locator('article.msg.user')).toHaveCount(0);
    await input.press('Enter');
    const accepted = await latest();
    await input.fill('newer typing');
    await post(page, { type: 'sendReceipt', requestId: accepted.requestId, sessionKey: 'A', status: 'accepted' });
    await expect(input).toHaveValue('newer typing');
    await post(page, { type: 'sendReceipt', requestId: accepted.requestId, sessionKey: 'A', status: 'accepted' });
    await expect(input).toHaveValue('newer typing');
    await input.press('Enter');
    const switched = await latest();
    await session(page, 'B'); await input.fill('belongs to B');
    await post(page, { type: 'sendReceipt', requestId: switched.requestId, sessionKey: 'A', status: 'rejected' });
    await expect(input).toHaveValue('belongs to B');
    await session(page, null); await input.fill('promoted send'); await input.press('Enter');
    const promoted = await latest();
    await session(page, 'saved-new', '/project', 'fresh');
    await post(page, { type: 'sendReceipt', requestId: promoted.requestId, sessionKey: 'fresh', status: 'accepted' });
    await expect(input).toHaveValue('');
    await post(page, { type: 'startResponse' });
    await input.fill('rejected correction'); await input.press('Enter');
    const steer = await page.evaluate(() => (window as unknown as { draftMessages: Array<Record<string, unknown>> }).draftMessages.filter(m => m.type === 'steerRun').at(-1)!);
    await input.fill('newer draft');
    await post(page, { type: 'composerError', valueKey: 'engineSteerCancelled', steerId: steer.steerId });
    await expect(input).toHaveValue('newer draft');
    await page.getByRole('button', { name: 'Recover draft', exact: true }).click();
    await expect(input).toHaveValue('newer draft\n\nrejected correction');
});

test('edit receipts preserve ordinary and newer edit drafts (en, 420)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const messages: Array<Record<string, unknown>> = [];
        Object.assign(window, { draftMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message), getState: () => undefined, setState: () => undefined }) });
    });
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();
    await post(page, { type: 'locale', locale: 'en' });
    await session(page, 'A');
    await post(page, { type: 'showChat' });
    await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', customPath: '', installedByXratu: false, busy: false } });
    await post(page, { type: 'restoreUser', value: 'Previous request' });
    const input = page.locator('.composer-input');
    await input.fill('Ordinary draft');
    await page.getByRole('button', { name: 'Edit message', exact: true }).click();
    await expect(input).toHaveValue('Previous request');
    await input.fill('Edited request'); await input.press('Enter');
    const latest = () => page.evaluate(() => (window as unknown as { draftMessages: Array<Record<string, unknown>> }).draftMessages.filter(message => message.type === 'editMessage').at(-1)!);
    const rejected = await latest();
    await post(page, { type: 'sendReceipt', requestId: rejected.requestId, sessionKey: 'A', status: 'rejected' });
    await expect(page.locator('.attach-error')).toBeVisible();
    await expect(input).toHaveValue('Edited request');
    await expect(page.locator('article.msg.user')).toContainText('Previous request');
    await input.press('Enter');
    const accepted = await latest();
    expect(accepted.requestId).not.toBe(rejected.requestId);
    await input.fill('Newer edit draft');
    await post(page, { type: 'truncateFromUser', userIndex: 0 });
    await post(page, { type: 'restoreUser', value: 'Edited request' });
    await post(page, { type: 'sendReceipt', requestId: accepted.requestId, sessionKey: 'A', status: 'accepted' });
    await expect(input).toHaveValue('Ordinary draft');
    await page.getByRole('button', { name: 'Recover draft', exact: true }).click();
    await expect(input).toHaveValue('Ordinary draft\n\nNewer edit draft');
});

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const provider = { providerId: 'chatgpt-codex', label: 'ChatGPT', methods: ['browser', 'device'] };
const post = async (page: Page, message: Record<string, unknown>) => {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
};
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        Object.assign(window, { __xratuHostMessages: sent, acquireVsCodeApi: () => ({
            postMessage: (m: unknown) => sent.push(m), getState: () => undefined, setState: (s: unknown) => s,
        }) });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'savedCredentials', credentials: [] });
    await post(page, { type: 'openCredentials' });
});

for (const [locale, width] of [['en', 900], ['fa', 420]] as const) {
    test(`OAuth controls and connected accounts fit cleanly in ${locale} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        for (const method of [null, 'browser', 'device', 'connected']) {
            await post(page, { type: 'oauthState', state: {
                providers: [provider],
                accounts: method === 'connected' ? [{ providerId: provider.providerId, credentialId: 'oauth', accountLabel: 'user@example.test', active: true }] : [],
                inProgress: method && method !== 'connected' ? { providerId: provider.providerId, method } : null,
                authorizeUrl: method === 'browser' ? 'https://auth.openai.com/api/accounts/authorize' : undefined,
                deviceCode: method === 'device' ? { userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' } : undefined,
            } });
            await expect(page.locator('.cred-oauth-list')).toBeVisible();
            if (method === 'browser') await expect(page.locator('.cred-oauth-manual')).toBeVisible();
            if (method === 'device') await expect(page.locator('.cred-oauth-code')).toBeVisible();
            if (method === 'connected') await expect(page.locator('.cred-oauth-account')).toBeVisible();
            const clipped = await page.locator('.cred-oauth-action').evaluateAll((elements) => elements
                .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
                .map((el) => el.textContent));
            expect(clipped).toEqual([]);
            if (method === 'browser') {
                await expect(page.getByRole('button', { name: locale === 'en' ? 'Continue with ChatGPT' : 'ادامه با ChatGPT' })).toHaveCount(0);
                await expect(page.locator('.cred-oauth-manual input')).not.toBeVisible();
                await expect(page.locator('.cred-oauth-url')).toHaveValue('https://auth.openai.com/api/accounts/authorize');
                await page.locator('.cred-oauth-manual summary').click();
                const bounds = await page.locator('.cred-oauth-manual-row').evaluate((row) => {
                    const input = row.querySelector('input')!.getBoundingClientRect();
                    const button = row.querySelector('button')!.getBoundingClientRect();
                    return { width: input.width, overlap: input.right > button.left + 1 && button.right > input.left + 1 && input.bottom > button.top + 1 && button.bottom > input.top + 1 };
                });
                expect(bounds.width).toBeGreaterThan(150);
                expect(bounds.overlap).toBe(false);
            }
        }
        const accounts = [
            { providerId: provider.providerId, credentialId: 'one', accountLabel: 'someone.with.a.very.long.email.address@example.test', active: true },
            { providerId: provider.providerId, credentialId: 'two', accountLabel: 'another.account@example.test', active: false },
        ];
        await post(page, { type: 'savedCredentials', credentials: [
            ...accounts.map((a) => ({ id: a.credentialId, providerId: a.providerId, label: a.accountLabel, baseUrl: 'https://api.openai.com/v1', maskedKey: '', active: a.active, oauth: true })),
            { id: 'byok', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: '••••', active: false },
        ] });
        await post(page, { type: 'oauthState', state: { providers: [provider], accounts,
            registrations: accounts.map((a) => ({ providerId: a.providerId, credentialId: a.credentialId, label: a.accountLabel })) } });
        await expect(page.locator('.cred-oauth-account-card')).toHaveCount(2);
        await expect(page.locator('.cred-oauth-registration')).toHaveCount(0);
        await expect(page.locator('.saved-credential')).toHaveCount(1);
        await expect(page.locator('.cred-oauth-account').first()).toHaveAttribute('title', accounts[0].accountLabel);
        const overflow = await page.locator('.cred-oauth-row').evaluate((row) => row.scrollWidth > row.clientWidth + 1);
        expect(overflow).toBe(false);
        const overlap = await page.locator('.cred-oauth-account-head').evaluateAll((heads) => heads.some((head) => {
            const name = head.querySelector('.cred-oauth-account')!.getBoundingClientRect();
            return [...head.children].filter((el) => !el.matches('.cred-oauth-account')).some((el) => {
                const box = el.getBoundingClientRect();
                return name.left < box.right - 1 && name.right > box.left + 1 && name.top < box.bottom - 1 && name.bottom > box.top + 1;
            });
        }));
        expect(overlap).toBe(false);
        const gaps = await page.locator('.cred-oauth-account-head').evaluateAll((heads) => heads.map((head) => {
            const icon = head.querySelector('.cred-oauth-avatar')!.getBoundingClientRect();
            const name = head.querySelector('bdi')!.getBoundingClientRect();
            return document.querySelector('.app')!.getAttribute('dir') === 'rtl' ? icon.left - name.right : name.left - icon.right;
        }));
        for (const gap of gaps) expect(gap).toBeCloseTo(8, 0);
    });
}

test('account actions, local-runtime sync, remembered reconnect, and delete-as-signout', async ({ page }) => {
    await page.locator('.drawer-head .icon-btn').click();
    // Neutral subscription subtitle and browser-only provider check.
    await post(page, { type: 'oauthState', state: { providers: [{ ...provider, methods: ['browser'] }] } });
    await expect(page.getByText('Use your provider subscription instead of an API key', { exact: true })).toHaveCount(1);
    await expect(page.locator('.cred-oauth-row .cred-oauth-hint')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a device code' })).toHaveCount(0);

    // Remembered registrations stay collapsed until opened and reconnect by credentialId.
    await post(page, { type: 'oauthState', state: { providers: [provider],
        registrations: [{ providerId: provider.providerId, credentialId: 'previous', label: 'previous@example.test' }] } });
    await expect(page.getByText('previous@example.test')).not.toBeVisible();
    await page.locator('.cred-oauth-remembered summary').click();
    await page.getByRole('button', { name: 'Sign in again' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toContainEqual({ type: 'oauthSignIn', providerId: provider.providerId, method: 'browser', credentialId: 'previous' });

    // Multi-account selection and sign-out target the intended credential.
    const accounts = [
        { providerId: provider.providerId, credentialId: 'one', accountLabel: 'first@example.test', active: true },
        { providerId: provider.providerId, credentialId: 'two', accountLabel: 'second@example.test', active: false },
    ];
    await post(page, { type: 'oauthState', state: { providers: [provider], accounts } });
    const second = page.locator('.cred-oauth-account-card').filter({ hasText: 'second@example.test' });
    await second.getByRole('button', { name: 'Use account' }).click();
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toEqual(expect.arrayContaining([
            { type: 'selectLlmCredential', id: 'two' },
            { type: 'oauthSignOut', credentialId: 'two' },
        ]));

    // Activating a local runtime deactivates the subscription even if oauthState lags.
    await post(page, { type: 'savedCredentials', credentials: [
        { id: 'oauth-1', providerId: 'chatgpt-codex', label: 'sub@example.test', baseUrl: 'https://chatgpt.com/backend-api/codex', maskedKey: '', active: false, oauth: true },
        { id: 'local-1', providerId: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', maskedKey: '', active: true, oauth: false },
        { id: 'byok-1', providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', maskedKey: 'sk-•••', active: false, oauth: false },
    ] });
    await post(page, { type: 'oauthState', state: {
        providers: [provider],
        accounts: [{ providerId: provider.providerId, credentialId: 'oauth-1', accountLabel: 'sub@example.test', active: true }],
    } });
    const subCard = page.locator('.cred-oauth-account-card').filter({ hasText: 'sub@example.test' });
    await expect(subCard).not.toHaveClass(/active/);
    await subCard.getByRole('button', { name: 'Use account' }).click();
    const byokRow = page.locator('.saved-credential').filter({ hasText: 'OpenAI' });
    await byokRow.getByRole('button', { name: 'Use connection' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toEqual(expect.arrayContaining([
            { type: 'selectLlmCredential', id: 'oauth-1' },
            { type: 'selectLlmCredential', id: 'byok-1' },
        ]));

    // Deleting a saved OAuth connection invokes sign-out rather than deleteLlmCredential.
    await post(page, { type: 'oauthState', state: { providers: [], accounts: [] } });
    await post(page, { type: 'savedCredentials', credentials: [{ id: 'oauth', providerId: provider.providerId, baseUrl: 'https://api.openai.com/v1', maskedKey: '', label: 'ChatGPT', active: true, oauth: true }], activeId: 'oauth' });
    const button = page.locator('.saved-delete');
    await button.click();
    await button.click();
    const messages = await page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<{ type: string }> }).__xratuHostMessages);
    expect(messages).toContainEqual({ type: 'oauthSignOut', credentialId: 'oauth' });
    expect(messages.some((m) => m.type === 'deleteLlmCredential')).toBe(false);
});

test('device and browser sign-in clipboard ack and manual redirect URL submission', async ({ page }) => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Denied')) } }));
    await post(page, { type: 'oauthState', state: { providers: [provider], inProgress: { providerId: provider.providerId, method: 'device' }, deviceCode: { userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' } } });
    await page.getByRole('button', { name: 'Copy code' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toContainEqual({ type: 'copyToClipboard', value: 'ABCD-1234', requestId: 'oauth-device-code' });
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
    await post(page, { type: 'clipboardResult', requestId: 'oauth-device-code', ok: true });
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    await post(page, { type: 'clipboardResult', requestId: 'oauth-device-code', ok: false });
    await expect(page.getByRole('alert')).toHaveText('Copy failed. Try again.');

    const authorizeUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=test';
    await post(page, { type: 'oauthState', state: { providers: [provider], inProgress: { providerId: provider.providerId, method: 'browser' }, authorizeUrl } });
    const link = page.getByRole('textbox', { name: 'Sign-in link' });
    await expect(link).toHaveValue(authorizeUrl);
    await expect(link).toHaveAttribute('readonly', '');
    await link.focus();
    expect(await link.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe(authorizeUrl);
    await page.getByRole('button', { name: 'Copy link' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toContainEqual({ type: 'copyToClipboard', value: authorizeUrl, requestId: 'oauth-browser-url' });
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
    await post(page, { type: 'clipboardResult', requestId: 'oauth-browser-url', ok: true });
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open browser' })).toHaveAttribute('href', authorizeUrl);
    await page.locator('.cred-oauth-manual summary').click();
    const callback = 'http://127.0.0.1:1455/auth/callback?code=example&state=test&client_id=issued';
    await page.getByRole('textbox', { name: 'Full redirect URL' }).fill(callback);
    await page.getByRole('button', { name: 'Use this URL' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: unknown[] }).__xratuHostMessages))
        .toContainEqual({ type: 'oauthManualCode', code: callback });
});

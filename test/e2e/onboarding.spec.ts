import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function post(page: Page, message: object) { await page.evaluate((value) => { window.postMessage(value, '*'); return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }, message); }
async function messages(page: Page) { return page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string; requestId?: string; [key: string]: unknown }[] }).__xratuHostMessages); }
async function request(page: Page, type = 'setupGetState') { await expect.poll(async () => (await messages(page)).filter((value) => value.type === type).length).toBeGreaterThan(0); return (await messages(page)).filter((value) => value.type === type).at(-1)!; }
async function state(page: Page, input: object) { const req = await request(page); await post(page, { type: 'runtimeSetupState', state: { requestId: req.requestId, engine: req.engine, path: req.path, phase: 'connect', models: [], ...input } }); }
const available = () => ({ id: 'opencode/free', name: 'Free Model', provider: 'opencode', free: true, tools: true, availability: 'available', checkedAt: Date.now() });

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const history: object[] = [];
        Object.assign(window, { __xratuHostMessages: history, acquireVsCodeApi: () => ({ postMessage: (message: object) => history.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
    await expect.poll(async () => (await messages(page)).some((value) => value.type === 'webviewReady')).toBe(true);
});

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`onboarding choices, free installation, model handoff and draft preservation (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await page.locator('.composer-input').fill('existing draft');
        await post(page, { type: 'showWelcome', canBack: true });
        await expect(page.locator('.setup-path')).toHaveCount(3);
        const brand = (await page.locator('.setup-brand').boundingBox())!;
        const language = (await page.locator('.setup-top .lang-choice').boundingBox())!;
        expect(brand.x + brand.width).toBeLessThan(language.x);
        await page.locator('.setup-path').first().click();
        const req = await request(page);
        expect([req.engine, req.path, req.onboarding]).toEqual(['opencode', 'free', true]);
        await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'missing', customPath: '', installedByXratu: false, busy: false } });
        await state(page, { phase: 'install' });
        await page.locator('.setup-install .primary-btn').click();
        expect(await messages(page)).toContainEqual({ type: 'engineInstall' });
        await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', customPath: '', installedByXratu: true, busy: false, version: '2.0.26' } });
        await state(page, { phase: 'ready', models: [available(), { ...available(), id: 'opencode/limited', name: 'Limited Model', availability: 'rateLimited' }] });
        await expect(page.locator('.setup-model').last()).toBeDisabled();
        await expect(page.locator('.setup-start')).toBeEnabled();
        const name = (await page.locator('.setup-model.selected .setup-model-copy').boundingBox())!;
        const badge = (await page.locator('.setup-model.selected .setup-free').boundingBox())!;
        const radio = (await page.locator('.setup-model.selected .setup-model-radio').boundingBox())!;
        expect(radio.x + radio.width).toBeLessThan(name.x);
        expect(badge.x).toBeGreaterThan(name.x + name.width);
        expect(await page.locator('.setup-model.selected .setup-model-status').evaluate((element) => getComputedStyle(element).direction)).toBe('ltr');
        expect(await page.locator('.setup-model.selected .setup-free').evaluate((element) => getComputedStyle(element).direction)).toBe(locale === 'fa' ? 'rtl' : 'ltr');
        const back = page.locator('.setup-footer button');
        expect(await back.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await back.click();
        await page.locator('.setup-footer button').click();
        await expect(page.locator('.composer-input')).toHaveValue('existing draft');
        await post(page, { type: 'showWelcome', path: 'free', canBack: true });
        await state(page, { phase: 'ready', models: [available()] });
        await page.locator('.setup-start').click();
        const current = await request(page);
        expect(await messages(page)).toContainEqual({ type: 'setupComplete', requestId: current.requestId, model: 'opencode/free' });
        await post(page, { type: 'showChat' });
        await expect(page.locator('.onboarding')).toHaveCount(0);
    });
}

test('all free models rate limited: retry and another path remain usable', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showWelcome', path: 'free' });
    await state(page, { phase: 'attention', models: [{ ...available(), availability: 'rateLimited' }] });
    await expect(page.locator('.setup-start')).toBeDisabled();
    await expect(page.locator('.setup-model-status')).toContainText('Rate limited');
    const old = (await request(page)).requestId;
    await page.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect.poll(async () => (await request(page)).requestId).not.toBe(old);
    await page.locator('.setup-footer button').click();
    await page.locator('.setup-path').nth(2).click();
    await state(page, { phase: 'connect' });
    await post(page, { type: 'localModelsDiscovered', runtimes: [] });
    await expect(page.locator('.setup-runtime-links button')).toHaveCount(4);
    await page.locator('.setup-runtime-links button').first().click();
    expect(await messages(page)).toContainEqual({ type: 'setupOpenRuntime', runtime: 'ollama' });
});

test('model-less local server offers setup; a catalog enables model selection without inference', async ({ page }) => {
    await post(page, { type: 'showWelcome', path: 'local' });
    await state(page, { phase: 'model' });
    await post(page, { type: 'localModelsDiscovered', runtimes: [{ id: 'lmstudio', name: 'LM Studio', runtime: 'lmstudio', baseUrl: 'http://localhost:1234/v1', modelCount: 0, models: [] }] });
    await expect(page.locator('.setup-runtime button').first()).toBeDisabled();
    await expect(page.locator('.setup-start')).toHaveCount(0);
    await state(page, { phase: 'ready', credentialId: 'local', models: [{ id: 'loaded', name: 'Loaded Model', provider: 'LM Studio' }] });
    await expect(page.locator('.setup-start')).toBeEnabled();
    expect((await messages(page)).some((value) => value.type === 'pingFreeModel' || value.type === 'benchmarkProvider' || value.type === 'chat')).toBe(false);
});

test('stale readiness cannot overwrite another path; expired free result cannot start', async ({ page }) => {
    await post(page, { type: 'showWelcome', path: 'free' });
    const old = await request(page);
    await page.locator('.setup-footer button').click();
    await page.locator('.setup-path').nth(1).click();
    await request(page);
    await post(page, { type: 'runtimeSetupState', state: { requestId: old.requestId, engine: 'opencode', path: 'free', phase: 'ready', models: [available()] } });
    await expect(page.locator('.setup-start')).toHaveCount(0);
    await post(page, { type: 'showWelcome', path: 'free' });
    await state(page, { phase: 'ready', models: [{ ...available(), checkedAt: Date.now() - 61_000 }] });
    await expect(page.locator('.setup-start')).toBeDisabled();
});

test('provider setup waits for readiness without flashing its form and uses one selection circle', async ({ page }) => {
    await post(page, { type: 'showWelcome' });
    await page.evaluate(() => {
        const seen: boolean[] = [];
        const observer = new MutationObserver(() => seen.push(!!document.querySelector('.setup-credentials')));
        observer.observe(document.querySelector('.setup-shell')!, { childList: true, subtree: true });
        Object.assign(window, { __providerFormFrames: seen });
    });
    await page.locator('.setup-path').nth(1).click();
    await request(page);
    await expect(page.locator('.setup-credentials')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __providerFormFrames: boolean[] }).__providerFormFrames.some(Boolean))).toBe(false);
    await state(page, { phase: 'ready', models: [{ id: 'one', name: 'Model One', provider: 'Provider' }, { id: 'two', name: 'Model Two', provider: 'Provider' }] });
    await expect(page.locator('.setup-model').last().locator('.lucide-circle')).toHaveCount(1);
    await expect(page.locator('.setup-model-status .lucide-circle')).toHaveCount(0);
});

test('provider settings scope lists native connections and does not switch the conversation', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await page.locator('.composer-input').fill('keep draft');
    await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: true, busy: false } });
    await post(page, { type: 'openCredentials' });
    const req = await request(page, 'nativeGetState');
    await post(page, { type: 'nativeSetupState', state: { requestId: req.requestId, phase: 'ready', integrations: [{ id: 'openrouter', name: 'OpenRouter', key: true, oauth: [], connections: [{ label: 'OPENROUTER_API_KEY', source: 'env', needsAuth: false }] }], servers: [], skills: [] } });
    await expect(page.locator('.native-connection')).toContainText('Environment');
    await page.setViewportSize({ width: 420, height: 800 });
    await post(page, { type: 'locale', locale: 'fa' });
    expect(await page.locator('.sidebar-back').evaluate((element) => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().height <= 35)).toBe(true);
    await page.locator('#native-provider').click();
    await page.getByRole('option', { name: 'OpenRouter', exact: true }).click();
    await page.locator('#native-key').fill('test-only-key');
    await page.locator('.native-provider-form .primary-btn').click();
    expect(await messages(page)).toContainEqual({ type: 'nativeConnect', requestId: req.requestId, integrationID: 'openrouter', key: 'test-only-key' });
    await expect(page.locator('#native-key')).toHaveValue('');
    await page.locator('#settings-engine').click();
    await page.getByRole('option', { name: 'Xratu', exact: true }).click();
    expect((await messages(page)).some((value) => value.type === 'engineSelect')).toBe(false);
    await page.locator('.sidebar-back').click();
    await expect(page.locator('.composer-input')).toHaveValue('keep draft');
});

test('native OAuth code submission ignores blank and busy input and trims the code', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: true, busy: false } });
    await post(page, { type: 'openCredentials' });
    const req = await request(page, 'nativeGetState');
    const nativeState = { requestId: req.requestId, phase: 'ready', integrations: [], servers: [], skills: [], oauth: { integrationID: 'test', url: 'https://example.test/auth', instructions: 'Enter code', mode: 'code' } };
    await post(page, { type: 'nativeSetupState', state: nativeState });
    const input = page.getByRole('textbox', { name: 'Sign-in code' });
    const form = page.locator('.native-provider-form form');
    await input.fill('   ');
    await form.evaluate((element) => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect((await messages(page)).some((message) => message.type === 'nativeOAuthCode')).toBe(false);
    await input.fill('  test-code  ');
    await post(page, { type: 'nativeSetupState', state: { ...nativeState, busy: true } });
    await expect(input).toBeDisabled();
    await form.evaluate((element) => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect((await messages(page)).some((message) => message.type === 'nativeOAuthCode')).toBe(false);
    await post(page, { type: 'nativeSetupState', state: nativeState });
    await expect(input).toBeEnabled();
    await input.fill('  test-code  ');
    await input.press('Enter');
    expect(await messages(page)).toContainEqual({ type: 'nativeOAuthCode', requestId: req.requestId, code: 'test-code' });
});

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function post(page: Page, message: object) { await page.evaluate((value) => window.postMessage(value, '*'), message); }
async function sent(page: Page) { return page.evaluate(() => (window as unknown as { __xratuHostMessages: object[] }).__xratuHostMessages); }
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const messages: object[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: object) => messages.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});

for (const locale of ['en', 'fa'] as const) {
    for (const width of [420, 1280]) {
        test(`OpenCode setup and installation controls (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'showChat' });
            await page.locator('.composer-input').fill('keep my draft');
            await post(page, { type: 'openEngines' });
            await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'missing', customPath: '', installedByXratu: false, busy: false } });
            const engine = page.locator('.engine-card').last();
            await expect(engine.locator('details[open]')).toHaveCount(0);
            await engine.locator('.primary-btn').click();
            expect(await sent(page)).toContainEqual({ type: 'engineInstall' });
            await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'installing', customPath: '', installedByXratu: false, downloadedBytes: 4000, totalBytes: 8000, busy: false } });
            await expect(engine.locator('progress')).toHaveAttribute('value', '4000');
            await engine.locator('.setup-install button').click();
            expect(await sent(page)).toContainEqual({ type: 'engineInstallCancel' });
            await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', version: '2.0.26', binaryPath: 'C:\\tools\\opencode.exe', customPath: '', installedByXratu: true, busy: false } });
            await engine.locator('.primary-btn').click();
            expect(await sent(page)).toContainEqual({ type: 'engineSelect', engine: 'opencode' });
            expect((await sent(page)).some((message) => (message as { type: string }).type === 'setupOpen')).toBe(false);
            await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', version: '2.0.26', binaryPath: 'C:\\tools\\opencode.exe', customPath: '', installedByXratu: true, busy: false } });
            await expect(engine).toHaveCSS('border-color', 'rgb(20, 227, 200)');
            await expect(engine.locator('.engine-version')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            await page.locator('.engine-card').first().locator('.secondary-btn').click();
            expect(await sent(page)).toContainEqual({ type: 'engineSelect', engine: 'xratu' });
            await expect(page.locator('.page-content')).toBeVisible();
            expect(await page.locator('.page-content').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await page.locator('.sidebar-back').click();
            await expect(page.locator('.composer-input')).toHaveValue('keep my draft');
        });
        test(`native model providers, free filter, automatic parallel checks and retry (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'showChat' });
            await post(page, { type: 'modelInfo', defaultModel: 'opencode/free', selectedModel: 'opencode/free', models: ['opencode/free', 'openrouter/free', 'opencode/paid'], displayNames: { 'opencode/free': 'Free Model', 'openrouter/free': 'Router Free', 'opencode/paid': 'Paid Model' }, capabilities: { 'opencode/free': { provider: 'opencode', free: true }, 'openrouter/free': { provider: 'openrouter', free: true }, 'opencode/paid': { provider: 'opencode', free: false } } });
            await page.locator('.picker-chip').click();
            await expect(page.locator('.model-pop-head .model-free-filter')).toHaveCount(1);
            await expect(page.getByRole('option')).toHaveCount(2);
            await expect(page.locator('.model-provider').filter({ hasText: 'openrouter' })).toBeVisible();
            expect((await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel')).toEqual([{ type: 'pingFreeModel', model: 'opencode/free', automatic: true }, { type: 'pingFreeModel', model: 'openrouter/free', automatic: true }]);
            expect((await sent(page)).filter((message) => (message as { type: string }).type === 'selectModel')).toHaveLength(0);
            await post(page, { type: 'modelPing', model: 'opencode/free', state: { status: 'checking' } });
            await expect(page.locator('.model-ping').first()).toBeDisabled();
            await expect(page.locator('.model-ping').nth(1)).toBeEnabled();
            await post(page, { type: 'modelPing', model: 'openrouter/free', state: { status: 'checking' } });
            await expect(page.locator('.model-ping').nth(1)).toBeDisabled();
            await post(page, { type: 'modelPing', model: 'opencode/free', state: { status: 'rateLimited', checkedAt: Date.now(), detail: 'Rate limit exceeded' } });
            await expect(page.locator('.model-ping').first()).toHaveClass(/rateLimited/);
            await expect(page.locator('.model-ping').first()).toHaveAttribute('title', /Rate limit exceeded/);
            await expect(page.locator('.model-ping').nth(1)).toBeDisabled();
            await page.getByRole('button', { name: locale === 'en' ? 'Check Free Model availability' : 'تست اتصال Free Model' }).click();
            expect((await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel')).toHaveLength(3);
            await post(page, { type: 'modelPing', model: 'opencode/free', state: { status: 'available', checkedAt: Date.now() } });
            await expect(page.locator('.model-ping').first()).toHaveClass(/available/);
            await page.locator('.model-free-filter').click();
            await expect(page.getByRole('option')).toHaveCount(3);
            await expect(page.locator('.model-row').filter({ hasText: 'Paid Model' }).locator('.model-ping')).toHaveCount(0);
            expect((await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel')).toHaveLength(3);
            expect(await page.locator('.model-pop').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
            await page.keyboard.press('Escape');
            await page.locator('.picker-chip').click();
            await expect(page.locator('.model-pop')).toBeVisible();
            await expect.poll(async () => (await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel').length).toBe(4);
            await page.keyboard.press('Escape');
            const composerBefore = (await page.locator('.composer-input').boundingBox())!;
            await post(page, { type: 'notification', id: 'compact', kind: 'warning', valueKey: 'notifBackgroundJobGone' });
            await expect(page.locator('.notif')).toBeVisible();
            await expect(page.locator('.notif-copy')).toHaveCSS('color', 'rgb(204, 167, 0)');
            const toast = (await page.locator('.notif').boundingBox())!;
            const toolbar = (await page.locator('.toolbar').boundingBox())!;
            expect(toast.height).toBeLessThan(38);
            expect(toast.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
            expect(toast.y + toast.height).toBeLessThan(composerBefore.y);
            expect((await page.locator('.composer-input').boundingBox())!.y).toBe(composerBefore.y);
        });
        test(`removed native model clears selection until a paid model is explicitly chosen (${locale}, ${width})`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await post(page, { type: 'locale', locale });
            await post(page, { type: 'showChat' });
            await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: true, busy: false } });
            await post(page, { type: 'modelInfo', defaultModel: 'opencode/removed-free', selectedModel: 'opencode/removed-free', models: ['opencode/removed-free'], displayNames: { 'opencode/removed-free': 'Removed Free' }, capabilities: { 'opencode/removed-free': { provider: 'opencode', free: true } } });
            await expect(page.locator('.picker-chip')).toContainText('Removed Free');
            await post(page, { type: 'modelInfo', defaultModel: '', selectedModel: '', models: ['opencode/paid'], displayNames: { 'opencode/paid': 'Paid Model' }, capabilities: { 'opencode/paid': { provider: 'opencode', free: false } } });
            await expect(page.locator('.picker-chip')).not.toContainText('Removed Free');
            await expect(page.locator('.picker-chip')).not.toContainText('Paid Model');
            await page.locator('.composer-input').fill('Keep this draft until I choose a model');
            await expect(page.locator('.send-btn')).toBeDisabled();
            await page.locator('.composer-input').press('Enter');
            await expect(page.locator('.composer-input')).toHaveValue('Keep this draft until I choose a model');
            expect((await sent(page)).some((message) => (message as { type: string }).type === 'askQuestion')).toBe(false);
            await page.locator('.picker-chip').click();
            await expect(page.getByRole('option')).toHaveCount(0);
            expect((await sent(page)).some((message) => (message as { type: string }).type === 'selectModel')).toBe(false);
            await page.locator('.model-free-filter').click();
            await page.getByRole('option').click();
            expect(await sent(page)).toContainEqual({ type: 'selectModel', value: 'opencode/paid' });
            await expect(page.locator('.picker-chip')).toContainText('Paid Model');
            await expect(page.locator('.send-btn')).toBeEnabled();
            await page.locator('.send-btn').click();
            expect(await sent(page)).toContainEqual({ type: 'askQuestion', value: 'Keep this draft until I choose a model', attachments: [] });
        });
    }
}

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1280]) {
    test(`native reasoning variants, composer name and search focus (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', customPath: '', installedByXratu: false, busy: false } });
        const model = 'opencode/reasoner-free';
        await post(page, { type: 'modelInfo', defaultModel: model, selectedModel: model, models: [model], displayNames: { [model]: 'DeepSeek V4 Pro' }, capabilities: { [model]: { provider: 'opencode', free: true, variants: ['high', 'adaptive'], noReasoning: false } } });
        await expect(page.locator('.chip-model-name')).toHaveText('DeepSeek V4 Pro');
        await expect(page.locator('.picker-chip .model-provider')).toHaveCount(0);
        expect(await page.locator('.chip-model-name').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        const attach = (await page.locator('.composer-attach').boundingBox())!;
        const picker = (await page.locator('.picker-chip').boundingBox())!;
        const context = (await page.locator('.ctx-wrap').boundingBox())!;
        const send = (await page.locator('.send-btn').boundingBox())!;
        expect(attach.x + attach.width).toBeLessThan(picker.x);
        expect(picker.x + picker.width).toBeLessThanOrEqual(context.x);
        expect(context.x + context.width).toBeLessThan(send.x);
        await page.locator('.picker-chip').click();
        await expect(page.locator('.thinking-seg-opt')).toHaveCount(3);
        await page.locator('.thinking-seg-opt').last().click();
        expect(await sent(page)).toContainEqual({ type: 'setNativeVariant', model, variant: 'adaptive' });
        await expect(page.locator('.chip-think')).toHaveText('adaptive');
        await page.locator('.thinking-seg-opt').first().click();
        expect(await sent(page)).toContainEqual({ type: 'setNativeVariant', model, variant: null });
        await page.locator('.model-search input').focus();
        await expect(page.locator('.model-search input')).toHaveCSS('outline-style', 'none');
        await expect(page.locator('.model-search input')).toHaveCSS('border-top-width', '0px');
        await post(page, { type: 'modelInfo', defaultModel: model, models: [model], capabilities: { [model]: { provider: 'opencode', free: true, variants: [], noReasoning: true } } });
        await expect(page.locator('.thinking-row')).toHaveCount(0);
    });
}

test('models arriving while the picker is open are checked once, excluding paid and unknown prices', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await page.locator('.picker-chip').click();
    const info = { type: 'modelInfo', models: ['opencode/free', 'opencode/paid', 'opencode/unknown'], capabilities: { 'opencode/free': { provider: 'opencode', free: true }, 'opencode/paid': { provider: 'opencode', free: false }, 'opencode/unknown': { provider: 'opencode' } } };
    await post(page, info);
    await expect.poll(async () => (await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel')).toEqual([{ type: 'pingFreeModel', model: 'opencode/free', automatic: true }]);
    await post(page, { type: 'modelPing', model: 'opencode/free', state: { status: 'available', checkedAt: Date.now() } });
    await post(page, info);
    await expect(page.locator('.model-ping')).toHaveClass(/available/);
    expect((await sent(page)).filter((message) => (message as { type: string }).type === 'pingFreeModel')).toHaveLength(1);
});

test('a rejected steer restores the draft and leaves the active turn intact', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'chunk', value: 'Still working' });
    await page.locator('.composer-input').fill('change direction');
    await page.locator('.send-btn').click();
    const steer = (await sent(page)).find((message) => (message as { type: string }).type === 'steerRun') as { steerId: string };
    await post(page, { type: 'composerError', valueKey: 'engineSteerCancelled', steerId: steer.steerId });
    await expect(page.locator('.composer-input')).toHaveValue('change direction');
    await post(page, { type: 'chunk', value: ', continuing' });
    await expect(page.locator('.msg.assistant').last()).toContainText('continuing');
});

test('first-run OpenCode entry and busy/path guards', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showWelcome' });
    await page.locator('.setup-path').first().click();
    await expect.poll(async () => (await sent(page)).some((message) => (message as { type: string }).type === 'setupGetState')).toBe(true);
    await post(page, { type: 'openEngines' });
    await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'unsupported', version: '1.18.35', customPath: '', installedByXratu: false, busy: false } });
    const engine = page.locator('.engine-card').last();
    await engine.locator('summary').filter({ hasText: /^Setup$/ }).click();
    await engine.locator('input').fill('C:\\tools\\opencode.exe');
    await engine.getByRole('button', { name: 'Save and check path' }).click();
    expect(await sent(page)).toContainEqual({ type: 'engineSetPath', path: 'C:\\tools\\opencode.exe' });
    await post(page, { type: 'enginesState', state: { active: 'opencode', phase: 'ready', version: '2.0.26', customPath: '', installedByXratu: false, busy: true } });
    await expect(page.locator('.engine-card').first().getByRole('button')).toBeDisabled();
    await expect(engine.locator('input')).toBeDisabled();
});

test('OpenCode multiple-choice question returns both selections', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'decisionRequest', decision_id: 'native-form', header: 'Options', question: 'Pick several', multiSelect: true, minItems: 2, maxItems: 2, allowCustomAnswer: false, options: [{ label: 'First' }, { label: 'Second' }, { label: 'Third' }] });
    const card = page.locator('.decision-card.pending');
    await card.getByRole('button', { name: 'First', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: 'Second', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await card.getByRole('button', { name: 'Third', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: 'Third', exact: true }).click();
    await expect(card.locator('.decision-other-btn')).toHaveCount(0);
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    expect(await sent(page)).toContainEqual({ type: 'decisionResponse', decisionId: 'native-form', answer: '["First","Second"]', dismissed: undefined });
});

test('free-only selection stays explicit when the catalog only contains paid models', async ({ page }) => {
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await post(page, { type: 'modelInfo', defaultModel: 'opencode/paid', selectedModel: 'opencode/paid', models: ['opencode/paid'], capabilities: { 'opencode/paid': { provider: 'opencode', free: false } } });
    await page.locator('.picker-chip').click();
    await expect(page.locator('.model-free-filter')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.locator('.model-free-filter').click();
    await expect(page.getByRole('option')).toHaveCount(1);
    expect((await sent(page)).some((message) => (message as { type: string }).type === 'pingFreeModel')).toBe(false);
});

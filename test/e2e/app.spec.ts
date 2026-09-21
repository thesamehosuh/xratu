/**
 * Browser smoke tests for the built webview bundle (dist/webview-ui).
 *
 * The bundle normally runs inside a VS Code webview where the host injects
 * `acquireVsCodeApi`.  Here we polyfill it before the app script runs and
 * drive the app by posting the same `FromExtensionMessage` envelopes the
 * host sends, so no VS Code is needed:
 *
 *   - the mocked `postMessage` records everything the webview sends back
 *   - host→webview messages go through `window.postMessage` (App listens on
 *     the window's message event)
 */
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as Record<string, unknown>).__xratuHostMessages = sent;
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (message: unknown) => {
                sent.push(message);
            },
            getState: () => undefined,
            setState: (state: unknown) => state,
        });
    });
});

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

test('webview posts webviewReady and mounts the app shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app')).toBeAttached();
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sent).toContainEqual({ type: 'webviewReady' });
});

test('default locale is fa - root direction is rtl', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app')).toHaveAttribute('dir', 'rtl');
});

test('showChat renders the chat composer', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
});

test('showWelcome renders the welcome screen', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showWelcome' });
    await expect(page.locator('.welcome')).toBeVisible();
});

test('locale message flips direction rtl -> ltr', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app')).toHaveAttribute('dir', 'rtl');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await expect(page.locator('.app')).toHaveAttribute('dir', 'ltr');
});

test('locale flip re-renders EXISTING chat bubbles (memo boundary)', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'restoreUser', value: 'سلام' });
    const bubble = page.locator('article.msg.user').first();
    await expect(bubble).toHaveAttribute('dir', 'rtl');
    // The message prop is unchanged here - only the locale changes, so only the
    // item's comparator can drive the re-render.
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await expect(bubble).toHaveAttribute('dir', 'ltr');
});

test('capabilities refresh spinner keeps spinning until EVERY echo arrives', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    // Open the capabilities page (fa locale by default) and let the initial
    // mcpGetState / skillsGetState echoes settle.
    await page.getByTitle('سرور ها و مهارت ها').click();
    await hostMessage(page, { type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false, registry: [] });
    await hostMessage(page, { type: 'skillsState', skills: [] });
    const spinner = page.locator('.settings-head .spinning');
    await expect(spinner).toHaveCount(0);
    // Refresh sends BOTH requests; the MCP echo lands immediately while the
    // skills echo is delayed. The spinner must still be running after the
    // 800ms minimum - it tracks each response, not a shared timer.
    await page.getByTitle('بروزرسانی').click();
    await hostMessage(page, { type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false, registry: [] });
    await page.waitForTimeout(1000);
    await expect(spinner).toBeVisible();
    await hostMessage(page, { type: 'skillsState', skills: [] });
    await expect(spinner).toHaveCount(0);
});

test('stream follow survives shrink-clamps and a large edit pill', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'restoreUser', value: 'Refactor the handlers module' });
    await hostMessage(page, { type: 'startResponse' });
    for (let i = 0; i < 10; i++) {
        await hostMessage(page, { type: 'chunk', value: `Paragraph ${i}. Analyzing the module structure and exports.\n\n` });
    }
    // A shrinking update: the thinking envelope REPLACES content that is
    // already above the fold. The browser clamps scrollTop down when the
    // document shrinks under a bottom-pinned view - that clamp must not be
    // mistaken for a user scroll-up (it latched atBottom=false and killed
    // the stream follow).
    await hostMessage(page, { type: 'thinking', value: 'Short replacement plan.' });
    // A big edit pill mounting below the fold: pill expansion is invisible
    // to the message-array effect (no new message), so only the content
    // ResizeObserver can pin it - the one that used to never attach.
    const bigPatch = Array.from({ length: 12 }, (_, i) =>
        `<<<<<<< SEARCH\nfunction handler${i}(event) {\n    return format(compute(event.data, ${i}));\n}\n=======\nfunction handler${i}(event) {\n    const value = computeV2(event.data, ${i});\n    if (!value) return fallback(${i});\n    return format(value, { dense: true });\n}\n>>>>>>> REPLACE`,
    ).join('\n');
    await hostMessage(page, { type: 'toolCall', tool: 'apply_patch', args: JSON.stringify({ path: 'src/handlers.ts', patch: bigPatch }), callId: 'c2' });
    await hostMessage(page, { type: 'toolResult', tool: 'apply_patch', callId: 'c2', output: 'Patch applied cleanly.' });
    await page.waitForTimeout(300);
    // Assert BEFORE any further envelope: no new message arrived, so only
    // the content ResizeObserver could have pinned the pill's growth here.
    const afterPill = await page.evaluate(() => {
        const el = document.querySelector('.messages')!;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    expect(afterPill).toBeLessThan(80);
    for (let i = 0; i < 4; i++) {
        await hostMessage(page, { type: 'chunk', value: `Post-edit note ${i}. All twelve handlers now route through v2.\n\n` });
    }
    await hostMessage(page, { type: 'fullResponse', renderedHtml: '<p>Refactor complete.</p>' });
    await page.waitForTimeout(300);
    const dist = await page.evaluate(() => {
        const el = document.querySelector('.messages')!;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    expect(dist).toBeLessThan(80);
});

test('pricing page shows session usage + model overrides at sidebar width (fa/RTL)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });

    // Settings → Usage & pricing
    await page.getByTitle('تنظیمات').first().click();
    await page.locator('.settings-nav-row', { hasText: 'مصرف و قیمت گذاری' }).click();

    // The page asks the host for its state on open.
    const asked = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(asked).toContainEqual({ type: 'pricingGetState' });

    await hostMessage(page, {
        type: 'pricingState',
        providers: [{ host: 'api.avalai.ir', label: 'Avalai', iranian: true, input: 12000, output: 3400, cached: 800 }],
        usage: { input: 12000, output: 3400, cached: 800 },
        costs: [{ amount: 9500, currency: 'IRT' }],
        models: [{ id: 'gpt-4o', input: 1, output: 2, cachedInput: null, currency: 'IRT' }],
    });

    // Usage readout + per-provider breakdown with the Iranian badge.
    await expect(page.locator('.usage-stat')).toHaveCount(4);
    await expect(page.locator('.usage-provider')).toContainText('Avalai');
    await expect(page.locator('.usage-provider .pricing-badge')).toContainText('ایرانی');
    await expect(page.locator('.pricing-row')).toContainText('gpt-4o');
    // Fine print lives in the footer, not the header.
    await expect(page.locator('.mcp-hint.foot')).toBeVisible();

    // The Add form requires BOTH rates (a blank field must not become 0).
    const add = page.locator('.pricing-add .settings-primary-action');
    await expect(add).toBeDisabled();
    await page.locator('.pricing-add input[type="text"]').fill('my-model');
    await page.locator('.pricing-add input[type="number"]').first().fill('1');
    await expect(add).toBeDisabled();
    await page.locator('.pricing-add input[type="number"]').nth(1).fill('2');
    await add.click();
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sent).toContainEqual({
        type: 'pricingSaveModel',
        id: 'my-model',
        input: 1,
        output: 2,
        cachedInput: null,
        currency: 'USD',
    });

    // RTL sidebar layout must not overflow horizontally.
    const overflow = await page.evaluate(() => {
        const el = document.querySelector('.settings-scroll')!;
        return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
});

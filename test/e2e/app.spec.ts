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

test('the composer cost pill opens the usage page and goes back to chat', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    // No pill until the host reports a cost.
    await expect(page.locator('.session-cost')).toHaveCount(0);
    await hostMessage(page, { type: 'sessionCost', cost: { amount: 0.0046, currency: 'USD' } });
    const pill = page.locator('.session-cost');
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page.locator('.settings-nav-row')).toHaveCount(0);
    // The usage page asks the host for its state and renders it.
    const asked = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(asked).toContainEqual({ type: 'usageGetState' });
    await hostMessage(page, {
        type: 'usageState',
        providers: [{ host: 'openode.ai', label: 'OpenCode Go', iranian: false, input: 300, output: 30, cached: 0, USD: 0.0068, IRT: 0 }],
        rates: [],
        history: [],
        allTime: { input: 300, output: 30, cached: 0, USD: 0.0068, IRT: 0 },
    });
    await expect(page.locator('.settings-section-head', { hasText: 'روند هزینه' })).toBeVisible();
    // Back returns to the chat composer, not to Settings.
    await page.getByLabel('بازگشت').click();
    await expect(page.locator('.composer-input')).toBeVisible();
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

test('cost page: stacked model chart, month stepper, filters, provider list (fa/RTL)', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });

    // Settings → Usage
    await page.getByTitle('تنظیمات').first().click();
    await page.locator('.settings-nav-row', { hasText: 'مصرف' }).click();

    const asked = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(asked).toContainEqual({ type: 'usageGetState' });

    // Two calendar months so the stepper has somewhere to go. July mixes both
    // currencies; August is Toman-only (the currency-toggle edge case).
    const history = [
        { day: '2026-07-10', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 100, output: 10, cached: 0, USD: 1, IRT: 5000 }] },
        { day: '2026-07-11', cells: [
            { model: 'gpt-4o', host: 'a.ir', input: 200, output: 20, cached: 0, USD: 2, IRT: 0 },
            { model: 'glm-5.3', host: 'a.ir', input: 50, output: 5, cached: 0, USD: 0.5, IRT: 700 },
        ] },
        { day: '2026-08-05', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 300, output: 30, cached: 0, USD: 0, IRT: 9000 }] },
    ];
    await hostMessage(page, {
        type: 'usageState',
        providers: [
            { host: 'a.ir', label: 'Avalai', iranian: true, input: 650, output: 65, cached: 0, USD: 6.5, IRT: 14000 },
            { host: 'b.ir', label: 'Metis', iranian: true, input: 400, output: 40, cached: 12, USD: 0, IRT: 95000 },
        ],
        rates: [
            // An override is host-independent (host ''); the others are the
            // rate actually resolved for the host the model ran on.
            { id: 'gpt-4o', host: '', input: 1, output: 2, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 14000 },
            { id: 'glm-5.3', host: 'a.ir', input: 0.15, output: 0.5, cachedInput: 0.03, currency: 'USD', source: 'builtin', USD: 0.5, IRT: 0 },
            { id: 'glm-5.3', host: 'b.ir', input: 0.3, output: 1, cachedInput: 0.03, currency: 'USD', source: 'gateway', USD: 1.2, IRT: 0 },
            { id: 'mystery-local', host: 'a.ir', input: 0, output: 0, cachedInput: null, currency: 'USD', source: 'unknown', USD: 0, IRT: 0 },
        ],
        history,
        allTime: { input: 1050, output: 105, cached: 12, USD: 6.5, IRT: 109000 },
    });
    // Latest month (August) is Toman-only: bars render, no currency toggle.
    await expect(page.locator('.cost-col')).toHaveCount(31);
    await expect(page.locator('.cost-legend-item')).toHaveCount(1);
    await expect(page.locator('.cost-legend-item')).toContainText('gpt-4o');
    await expect(page.locator('.cost-currencies')).toHaveCount(0);
    await expect(page.locator('.cost-col:not([aria-label$="-"])')).toHaveCount(1);

    // Stepper moves to July, which has two models and both currencies.
    await page.getByLabel('ماه قبل').click();
    await expect(page.locator('.cost-legend-item')).toHaveCount(2);
    await expect(page.locator('.cost-legend')).toContainText('glm-5.3');
    await expect(page.getByLabel('ماه قبل')).toBeDisabled();
    await expect(page.locator('.cost-currencies')).toBeVisible();

    // Hovering a day WITH usage shows that day's total in the detail line.
    // August has a single model, so no per-model breakdown repeats the total;
    // the axis is the LOCALE month (Jalali here), so pick the first non-empty
    // column by its label rather than assuming a Gregorian day index.
    await page.locator('.cost-col:not([aria-label$="-"])').first().hover();
    await expect(page.locator('.cost-detail')).toContainText('تیر');
    // The detail line must never wrap: a hover cannot change the card's height
    // and shove every section below it.
    const chartHeightHovered = (await page.locator('.settings-card').first().boundingBox())!.height;
    const providersTopHovered = (await page.locator('.settings-card').nth(1).boundingBox())!.y;
    await page.mouse.move(5, 5);
    await expect(page.locator('.cost-detail')).toBeEmpty();
    const chartHeightIdle = (await page.locator('.settings-card').first().boundingBox())!.height;
    const providersTopIdle = (await page.locator('.settings-card').nth(1).boundingBox())!.y;
    expect(Math.round(chartHeightHovered)).toBe(Math.round(chartHeightIdle));
    expect(Math.round(providersTopHovered)).toBe(Math.round(providersTopIdle));

    // Manually pick USD here, then step to the Toman-only month: the choice
    // must NOT persist as an empty chart (the toggle is hidden there).
    await page.locator('.cost-currencies .usage-range', { hasText: 'دلار' }).click();
    await expect(page.locator('.cost-axis')).toContainText('$');
    await page.getByLabel('ماه بعد').click();
    await expect(page.locator('.cost-currencies')).toHaveCount(0);
    await expect(page.locator('.cost-col:not([aria-label$="-"])')).toHaveCount(1);
    await expect(page.locator('.cost-axis')).toContainText('هزار');

    // Model filter (our own dropdown, not a native select) narrows the legend
    // to the selected model.
    const modelFilter = page.locator('.cost-filters .dropdown').first();
    await page.getByLabel('ماه قبل').click();
    await modelFilter.locator('.dropdown-trigger').click();
    await modelFilter.locator('.dropdown-option', { hasText: 'glm-5.3' }).click();
    await expect(page.locator('.cost-legend-item')).toHaveCount(1);
    await expect(page.locator('.cost-legend-item')).toContainText('glm-5.3');

    // Week mode: a 7-day axis with a range label, stepping by week.
    await modelFilter.locator('.dropdown-trigger').click();
    await modelFilter.locator('.dropdown-option', { hasText: 'همه مدل ها' }).click();
    await page.locator('.cost-granularity .usage-range', { hasText: 'هفته' }).click();
    await expect(page.locator('.cost-col')).toHaveCount(7);
    await expect(page.locator('.cost-granularity .usage-range.active')).toContainText('هفته');
    await expect(page.locator('.cost-period-label')).toContainText('–');
    await page.getByLabel('هفته قبل').click();
    // The previous week really has no usage, so the empty state is correct.
    await expect(page.locator('.usage-empty')).toBeVisible();
    // Two more weeks back is the window that holds the July usage.
    await page.getByLabel('هفته قبل').click();
    await page.getByLabel('هفته قبل').click();
    await expect(page.locator('.cost-col')).toHaveCount(7);
    // Back to the month axis.
    await page.locator('.cost-granularity .usage-range', { hasText: 'ماه' }).click();
    await expect(page.locator('.cost-col')).toHaveCount(31);

    // Provider usage: one stat block per provider, with the Iranian badge, its
    // cost, and the input/output/cached split under a composition bar.
    const providerRows = page.locator('.prov-row');
    await expect(providerRows).toHaveCount(2);
    await expect(providerRows.first()).toContainText('Avalai');
    await expect(providerRows.locator('.pricing-badge')).toHaveCount(2);
    await expect(providerRows.nth(1)).toContainText('تومان');
    await expect(providerRows.first().locator('.prov-bar > span')).toHaveCount(2);
    // Metis has cached input too, so its bar carries the third segment.
    await expect(providerRows.nth(1).locator('.prov-bar > span')).toHaveCount(3);
    await expect(page.locator('.usage-alltime')).toBeVisible();

    // Rate sheet: the effective rate per model with its origin, edited inline.
    const rateRows = page.locator('.rate-row');
    await expect(rateRows).toHaveCount(4);
    const overrideRow = rateRows.filter({ hasText: 'gpt-4o' });
    await expect(overrideRow).toContainText('نرخ شما');
    await expect(overrideRow.locator('.rate-values')).toContainText('1');
    // Like a provider row, the money it has cost sits at the row's end.
    await expect(overrideRow.locator('.usage-cost')).toContainText('تومان');
    // A model with no resolvable rate is flagged and points at the fix.
    const unknownRow = rateRows.filter({ hasText: 'mystery-local' });
    await expect(unknownRow).toContainText('نامعلوم');
    await expect(unknownRow.locator('.rate-unknown')).toBeVisible();
    // The same model can carry a different rate per provider, so the host is
    // shown exactly when it ran on more than one.
    const glmRows = rateRows.filter({ hasText: 'glm-5.3' });
    await expect(glmRows).toHaveCount(2);
    await expect(glmRows.nth(0)).toContainText('a.ir');
    await expect(glmRows.nth(1)).toContainText('b.ir');
    await expect(glmRows.nth(1)).toContainText('نرخ گیت وی');

    // Editing opens a panel anchored to the row (not an inline expansion), and
    // "use the built-in rate" only exists for a model the user overrode.
    const builtinRow = glmRows.nth(0);
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    await builtinRow.locator('.icon-btn').click();
    await expect(builtinRow.locator('.rate-pop')).toBeVisible();
    await expect(builtinRow.locator('.rate-edit-grid')).toBeVisible();
    await expect(builtinRow.locator('.settings-ghost-action', { hasText: 'بازگشت' })).toHaveCount(0);
    // Escape closes it without saving.
    await page.keyboard.press('Escape');
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    await builtinRow.locator('.icon-btn').click();
    await builtinRow.locator('.num-field input').first().fill('0.2');
    await builtinRow.locator('.settings-primary-action').click();
    await expect(builtinRow.locator('.rate-pop')).toHaveCount(0);
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sent).toContainEqual({
        type: 'usageSaveModel',
        id: 'glm-5.3',
        input: 0.2,
        output: 0.5,
        cachedInput: 0.03,
        currency: 'USD',
    });
    // An override row offers the way back to the built-in table.
    await overrideRow.locator('.icon-btn').click();
    await expect(overrideRow.locator('.settings-ghost-action', { hasText: 'بازگشت' })).toBeVisible();
    await page.keyboard.press('Escape');

    // An unresolved rate has nothing to prefill: editing it starts empty, so
    // saving a row of zeros takes a deliberate act.
    await unknownRow.locator('.icon-btn').click();
    await expect(unknownRow.locator('.num-field input').first()).toHaveValue('');
    await expect(unknownRow.locator('.settings-primary-action')).toBeDisabled();
    await page.keyboard.press('Escape');

    await expect(page.locator('.mcp-hint.foot')).toBeVisible();

    // The add form is collapsed until asked for, and requires BOTH rates
    // (a blank field must not become 0).
    await expect(page.locator('.pricing-add')).toHaveCount(0);
    await page.locator('.rates-add-toggle').click();
    const add = page.locator('.pricing-add .settings-primary-action');
    const rateInput = page.locator('.pricing-add .num-field input');
    await expect(add).toBeDisabled();
    await page.locator('.pricing-add .pricing-add-id input').fill('my-model');
    await rateInput.first().fill('1');
    // The drawn steppers move the value (the native spinners cannot be themed).
    await page.locator('.pricing-add .num-step').first().click();
    await expect(rateInput.first()).toHaveValue('2');
    await page.locator('.pricing-add .num-step').nth(1).click();
    await expect(rateInput.first()).toHaveValue('1');
    await expect(add).toBeDisabled();
    await rateInput.nth(1).fill('2');
    await add.click();
    const sentAdd = await page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages);
    expect(sentAdd).toContainEqual({
        type: 'usageSaveModel',
        id: 'my-model',
        input: 1,
        output: 2,
        cachedInput: null,
        currency: 'USD',
    });

    // A cramped card must never clip the list: it flips and caps to fit (the
    // card hides its overflow, so an uncapped list gets cut in half).
    await page.setViewportSize({ width: 420, height: 320 });
    await page.locator('.cost-filters .dropdown').first().locator('.dropdown-trigger').click();
    const listBox = await page.locator('.dropdown-list').boundingBox();
    const chartCardBox = await page.locator('.settings-card').first().boundingBox();
    expect(listBox!.y).toBeGreaterThanOrEqual(chartCardBox!.y - 1);
    expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(chartCardBox!.y + chartCardBox!.height + 1);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 420, height: 900 });

    // RTL sidebar layout must not overflow horizontally.
    const overflow = await page.evaluate(() => {
        const el = document.querySelector('.settings-scroll')!;
        return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
});

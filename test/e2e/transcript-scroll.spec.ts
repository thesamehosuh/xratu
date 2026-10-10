/**
 * Transcript scroll-follow behaviour under a LIVE run.
 *
 * The paged window, the auto-follow gate and the jump control all live in
 * App.tsx; these tests pin the reader-facing contract that a live stream must
 * not break: scrolling up detaches the follow, streaming while detached does
 * not move the reader, and scrolling back down re-arms it.
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
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

const hostMessage = (page: Page, message: Record<string, unknown>) =>
    page.evaluate((msg) => window.postMessage(msg, '*'), message);

const metrics = (page: Page) => page.evaluate(() => {
    const el = document.querySelector('.messages') as HTMLElement;
    return {
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        height: el.scrollHeight,
        distance: el.scrollHeight - el.scrollTop - el.clientHeight,
    };
});

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'sessionState', id: 'live', title: null });
});

test('scrolling up during a live run detaches follow and scrolling back re-arms it', async ({ page }) => {
    // A transcript long enough that the tail is genuinely off-screen.
    for (let i = 0; i < 30; i++) {
        await hostMessage(page, { type: 'restoreUser', value: `msg ${i}` });
    }
    await hostMessage(page, { type: 'startResponse' });
    for (let i = 0; i < 12; i++) {
        await hostMessage(page, { type: 'chunk', value: `Streaming paragraph ${i}. `.repeat(12) });
    }

    // Pinned at the tail: no jump control.
    await expect(page.locator('.jump-btn')).toHaveCount(0);
    expect((await metrics(page)).distance).toBeLessThan(80);

    // Scroll up WHILE the run is live. `.jump-btn` renders iff the app has
    // observed an off-tail position, so waiting on it is the observation.
    await page.locator('.messages').evaluate((el) => { el.scrollTop = Math.floor(el.scrollHeight / 2); });
    await expect(page.locator('.jump-btn')).toBeVisible();

    // More output arrives under the detached reader.
    for (let i = 0; i < 12; i++) {
        await hostMessage(page, { type: 'chunk', value: `Later paragraph ${i}. `.repeat(12) });
    }

    // Streaming must not have yanked the reader: still away from the tail,
    // still detached.
    const detached = await metrics(page);
    expect(detached.distance).toBeGreaterThan(80);
    await expect(page.locator('.jump-btn')).toBeVisible();

    // Scrolling back down must actually MOVE the view. This is the regression:
    // a stale position snapshot made every downward event read as a content
    // change, so the reader could not return to the tail.
    await page.locator('.messages').evaluate((el) => {
        el.scrollTop = Math.floor((el.scrollHeight + el.clientHeight) / 2);
    });
    const backDown = await metrics(page);
    expect(backDown.top).toBeGreaterThan(detached.top);

    // Reaching the tail re-arms follow and hides the control again.
    await page.locator('.messages').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.jump-btn')).toHaveCount(0);
    await hostMessage(page, { type: 'chunk', value: 'After returning to the tail. ' });
    expect((await metrics(page)).distance).toBeLessThan(80);
});
for (const locale of ['en', 'fa']) for (const width of [420, 1080]) {
    test(`real wheel navigation remains usable during streaming (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 760 });
        await hostMessage(page, { type: 'locale', locale });
        for (let i = 0; i < 65; i++) await hostMessage(page, { type: 'restoreUser', value: `History ${i}` });
        await hostMessage(page, { type: 'startResponse' });
        for (let i = 0; i < 10; i++) await hostMessage(page, { type: 'chunk', value: `Paragraph ${i}. `.repeat(40) });
        const pane = page.locator('.messages');
        await expect.poll(async () => (await metrics(page)).distance).toBeLessThan(1);
        await pane.hover();
        await page.mouse.wheel(0, -900);
        // Race stream updates against the browser's wheel/scroll delivery.
        for (let i = 0; i < 8; i++) await hostMessage(page, { type: 'chunk', value: 'More live output. '.repeat(30) });
        await expect(page.locator('.jump-btn')).toBeVisible();
        await expect.poll(async () => (await metrics(page)).distance).toBeGreaterThan(80);
        const detached = await metrics(page);
        for (let i = 0; i < 8; i++) await hostMessage(page, { type: 'chunk', value: 'Still working. '.repeat(30) });
        expect((await metrics(page)).top).toBeCloseTo(detached.top, 0);
        await page.mouse.wheel(0, 450);
        await expect.poll(async () => (await metrics(page)).top).toBeGreaterThan(detached.top + 100);
        const jump = page.locator('.jump-btn');
        const [button, transcript] = await Promise.all([jump.boundingBox(), pane.boundingBox()]);
        expect(Math.abs(button!.x + button!.width / 2 - (transcript!.x + transcript!.width / 2))).toBeLessThan(1);
        await jump.click();
        await expect(jump).toBeHidden();
        await expect.poll(async () => (await metrics(page)).distance).toBeLessThan(1);
        await hostMessage(page, { type: 'chunk', value: 'Output after jumping.' });
        await expect.poll(async () => (await metrics(page)).distance).toBeLessThan(1);
        // Switching panels hides the composer without dropping the draft.
        await page.locator('.composer-input').fill('Draft survives');
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.composer-input')).toBeHidden();
        await page.locator('#surface-tab-conversation').click();
        await expect(page.locator('.composer-input')).toHaveValue('Draft survives');
    });
}

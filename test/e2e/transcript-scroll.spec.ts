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
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'sessionState', id: 'live', title: null });
});

const hostMessages = (page: Page, messages: Record<string, unknown>[]) =>
    page.evaluate((batch) => {
        for (const message of batch) window.postMessage(message, '*');
    }, messages);

const hostMessage = (page: Page, message: Record<string, unknown>) =>
    hostMessages(page, [message]);

const metrics = (page: Page) => page.evaluate(() => {
    const el = document.querySelector('.messages') as HTMLElement;
    return {
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
        height: el.scrollHeight,
        distance: el.scrollHeight - el.scrollTop - el.clientHeight,
    };
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
for (const [locale, width] of [['en', 1080], ['fa', 420]] as const) {
    test(`real wheel navigation remains usable during streaming (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 760 });
        await hostMessage(page, { type: 'locale', locale });
        await hostMessages(page, [
            ...Array.from({ length: 65 }, (_, i) => ({ type: 'restoreUser', value: `History ${i}` })),
            { type: 'startResponse' },
            ...Array.from({ length: 10 }, (_, i) => ({ type: 'chunk', value: `Paragraph ${i}. `.repeat(40) })),
        ]);
        const pane = page.locator('.messages');
        await expect.poll(async () => (await metrics(page)).distance).toBeLessThan(1);
        await pane.hover();
        await pane.evaluate((el) => {
            const target = el as HTMLElement & { wheelFinished?: Promise<void> };
            target.wheelFinished = new Promise((resolve) => {
                target.addEventListener('wheel', () => {
                    target.addEventListener('scrollend', () => resolve(), { once: true });
                }, { once: true, passive: true });
            });
        });
        await page.mouse.wheel(0, -900);
        await hostMessages(page, Array.from({ length: 8 }, (_, i) => ({
            type: 'chunk', value: `More live output ${i}. `.repeat(30),
        })));
        await expect(pane).toContainText('More live output 7.');
        await expect(page.locator('.jump-btn')).toBeVisible();
        await expect.poll(async () => (await metrics(page)).distance).toBeGreaterThan(80);
        await pane.evaluate((el) => (el as HTMLElement & { wheelFinished?: Promise<void> }).wheelFinished);
        const detached = await metrics(page);
        await hostMessages(page, Array.from({ length: 8 }, (_, i) => ({
            type: 'chunk', value: `Still working ${i}. `.repeat(30),
        })));
        await expect(pane).toContainText('Still working 7.');
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
        await expect(pane).toContainText('Output after jumping.');
        await expect.poll(async () => (await metrics(page)).distance).toBeLessThan(1);
    });
}

test('tall transcript + live subagent updates never squash or overlap rows', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    for (let m = 0; m < 12; m++) {
        await hostMessage(page, { type: 'startResponse' });
        for (let s = 0; s < 4; s++) {
            await hostMessage(page, { type: 'toolCall', tool: 'read_file', callId: `c${m}_${s}`, args: JSON.stringify({ path: `game/module_${m}_${s}.py` }) });
            await hostMessage(page, { type: 'toolResult', tool: 'read_file', callId: `c${m}_${s}`, output: 'done' });
        }
        await hostMessage(page, { type: 'fullResponse', persian: `Answer ${m} with enough prose to make the bubble tall.\n\n`.repeat(8) });
    }
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, { type: 'toolCall', tool: 'task', callId: 'call_task1', args: JSON.stringify({ subagent_type: 'explore', description: 'Inspect map rendering', prompt: 'x'.repeat(200) }) });
    for (let i = 0; i < 20; i++) {
        await hostMessage(page, { type: 'toolOutput', callId: 'call_task1', value: `↳ read_file game/engine.py chunk ${i}\n` });
    }
    await expect(page.locator('.messages-inner > *')).toHaveCount(13);
    const probe = await page.evaluate(() => {
        const messages = document.querySelector('.messages')!;
        const inner = document.querySelector('.messages-inner')!;
        const rows = [...inner.querySelectorAll(':scope > *')] as HTMLElement[];
        let squashed = 0;
        for (const r of rows) if (r.scrollHeight > r.clientHeight + 2) squashed++;
        const rects = rows.map((r) => r.getBoundingClientRect());
        let overlaps = 0;
        for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
                if (rects[i].bottom > rects[j].top + 1 && rects[j].bottom > rects[i].top + 1) overlaps++;
            }
        }
        return {
            rows: rows.length,
            squashed,
            overlaps,
            messagesClip: messages.scrollHeight < inner.scrollHeight - 2,
            scrollable: messages.scrollHeight > messages.clientHeight,
        };
    });
    expect(probe.rows).toBeGreaterThan(10);
    expect(probe.scrollable).toBe(true);
    expect(probe.squashed).toBe(0);
    expect(probe.overlaps).toBe(0);
    expect(probe.messagesClip).toBe(false);
});

import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

test('tall transcript + live subagent updates never squash rows', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: () => undefined,
            getState: () => undefined,
            setState: (s: unknown) => s,
        });
    });
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });

    // A long transcript of TALL assistant bubbles (deep pill stacks).
    for (let m = 0; m < 12; m++) {
        await hostMessage(page, { type: 'startResponse' });
        for (let s = 0; s < 6; s++) {
            await hostMessage(page, {
                type: 'toolCall',
                tool: 'read_file',
                callId: `c${m}_${s}`,
                args: JSON.stringify({ path: `game/module_${m}_${s}.py` }),
            });
            await hostMessage(page, {
                type: 'toolOutput',
                callId: `c${m}_${s}`,
                value: `line one\nline two\nline three\n`.repeat(3),
            });
            await hostMessage(page, { type: 'toolResult', tool: 'read_file', callId: `c${m}_${s}`, output: 'done' });
        }
        await hostMessage(page, { type: 'fullResponse', persian: `Answer ${m} with enough prose to make the bubble tall.\n\n`.repeat(8) });
    }
    // The live subagent turn.
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'toolCall',
        tool: 'task',
        callId: 'call_task1',
        args: JSON.stringify({
            subagent_type: 'explore',
            description: 'Implement ASCII map rendering for the map command in a Python terminal RPG at repo root',
            prompt: 'x'.repeat(300),
        }, null, 2),
    });
    for (let i = 0; i < 40; i++) {
        await hostMessage(page, { type: 'toolOutput', callId: 'call_task1', value: `↳ read_file game/engine.py chunk ${i}\n` });
    }
    await page.waitForTimeout(150);

    const probe = await page.evaluate(() => {
        const messages = document.querySelector('.messages')!;
        const inner = document.querySelector('.messages-inner')!;
        const rows = [...inner.querySelectorAll(':scope > *')] as HTMLElement[];
        let squashed = 0;
        for (const r of rows) {
            if (r.scrollHeight > r.clientHeight + 2) squashed++;
        }
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
            innerOverflow: inner.scrollHeight - messages.clientHeight,
            liveText: document.querySelector('.sum-sub .sum-live')?.textContent ?? null,
            shrink: rows[0] ? getComputedStyle(rows[0]).flexShrink : null,
        };
    });
    console.log('SQUASH-PROBE', JSON.stringify(probe));
    expect(probe.squashed).toBe(0);
    expect(probe.overlaps).toBe(0);
    expect(probe.messagesClip).toBe(false);
});

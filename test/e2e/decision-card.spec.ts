/**
 * Decision card interaction (the `ask_user_question` UI):
 *  - the question renders as a card, NEVER a tool pill;
 *  - clicking an answer collapses the card into an "Answered" line;
 *  - clicking that line reveals the option that was chosen.
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

const OPTIONS = [
    { label: 'Postgres', description: 'Relational, boring.', recommended: true },
    { label: 'SQLite', description: 'Single file.' },
];

test('the question is a card, its answer collapses to an Answered line', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 820 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as unknown as Record<string, unknown>).__xratuHostMessages = sent;
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (m: unknown) => {
                sent.push(m);
            },
            getState: () => undefined,
            setState: (s: unknown) => s,
        });
    });
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'decisionRequest',
        decision_id: 'dec-e2e',
        header: 'Database',
        question: 'Which database should this service use?',
        options: OPTIONS,
    });
    await page.waitForSelector('.decision-card');

    // No tool pill anywhere in the transcript for the question.
    await expect(page.locator('details.step')).toHaveCount(0);

    // Answer: the card must collapse into the compact Answered line.
    await page.locator('.decision-option', { hasText: 'SQLite' }).click();
    await hostMessage(page, { type: 'decisionResolved', decision_id: 'dec-e2e', answer: 'SQLite' });
    await page.waitForSelector('.decision-collapsed');
    await expect(page.locator('.decision-card')).toHaveCount(0);
    await expect(page.locator('.decision-collapsed')).toContainText('Answered');
    // Chevron/pointing icon beside the line.
    await expect(page.locator('.decision-collapsed svg')).toHaveCount(1);

    // Clicking the line reveals the answer that was chosen.
    await page.locator('.decision-collapsed').click();
    await page.waitForSelector('.decision-card');
    await expect(page.locator('.decision-option.selected')).toContainText('SQLite');
    await expect(page.locator('.decision-card')).toContainText('Which database should this service use?');

    // Still no pill after settling.
    await expect(page.locator('details.step')).toHaveCount(0);
});

test('a dismissed question settles the same way', async ({ page }) => {
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
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'decisionRequest',
        decision_id: 'dec-e2e-2',
        question: 'Ship it?',
        options: OPTIONS,
    });
    await page.waitForSelector('.decision-card');
    await page.locator('.decision-dismiss').click();
    await hostMessage(page, { type: 'decisionResolved', decision_id: 'dec-e2e-2', answer: null });
    await page.waitForSelector('.decision-collapsed');
    await expect(page.locator('.decision-card')).toHaveCount(0);
});

test('two questions in a row keep both Answered lines', async ({ page }) => {
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
    await hostMessage(page, { type: 'startResponse' });

    // Question 1 on the streaming bubble, answered.
    await hostMessage(page, {
        type: 'decisionRequest',
        decision_id: 'q1',
        question: 'Which database?',
        options: OPTIONS,
    });
    await page.locator('.decision-option', { hasText: 'SQLite' }).click();
    await hostMessage(page, { type: 'decisionResolved', decision_id: 'q1', answer: 'SQLite' });
    await page.waitForSelector('.decision-collapsed');

    // Question 2 in the SAME turn - its card must not erase the first line.
    await hostMessage(page, {
        type: 'decisionRequest',
        decision_id: 'q2',
        question: 'Which cache?',
        options: [
            { label: 'Redis', description: 'Fast.', recommended: true },
            { label: 'Memcached', description: 'Simpler.' },
        ],
    });
    await page.waitForSelector('.decision-card');
    // The first record collapsed to a pill; the second question is the open
    // card. Both live on the same bubble - no padded system box.
    await expect(page.locator('.decision-collapsed')).toHaveCount(1);
    await expect(page.locator('.decision-card')).toContainText('Which cache?');
    await expect(page.locator('.decision-holder')).toHaveCount(0);
    await expect(page.locator('.msg.system')).toHaveCount(0);

    await page.locator('.decision-option', { hasText: 'Redis' }).click();
    await hostMessage(page, { type: 'decisionResolved', decision_id: 'q2', answer: 'Redis' });
    await expect(page.locator('.decision-collapsed')).toHaveCount(2);
    // The settled pills sit INLINE (same line), not stacked one per row.
    await page.waitForTimeout(250); // let the entry animation settle
    const pills = await page.locator('.decision-records .decision-collapsed').evaluateAll((els) =>
        els.map((el) => el.getBoundingClientRect()));
    expect(Math.abs(pills[0].top - pills[1].top)).toBeLessThan(4);
    expect(pills[1].left).toBeGreaterThan(pills[0].right - 4);
    await expect(page.locator('details.step')).toHaveCount(0);
});

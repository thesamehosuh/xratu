/**
 * Browser tests for the background-process UI in the built webview bundle.
 *
 * Covers wiring, live log streaming/following, docking, stop-all, exit codes,
 * short-viewport fit, and detached recovered processes.
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, msg: Record<string, unknown>) => page.evaluate(message => window.postMessage(message, '*'), msg);
const sent = (page: Page): Promise<Array<Record<string, unknown>>> =>
    page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);

const dragToSidebar = async (page: Page, selector: string) => {
    const source = (await page.locator(selector).boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, { steps: 3 });
    await expect(page.locator('.dock-sidebar.drag-target')).toBeVisible();
    const destination = (await page.locator('.dock-tabs.side').boundingBox())!;
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 5 });
    await page.mouse.up();
};

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, {
            __xratuHostMessages: messages,
            acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => undefined, setState: (s: unknown) => s }),
        });
    });
    await page.goto('/');
    await post(page, { type: 'showChat' });
    await post(page, { type: 'locale', locale: 'en' });
});

test('terminal handoff swaps to stop, while process tool omits handoff', async ({ page }) => {
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'toolCall', tool: 'process', args: JSON.stringify({ action: 'list' }), callId: 'call-9' });
    await expect(page.locator('.step')).toBeVisible();
    await expect(page.locator('.step button.icon-btn-mini')).toHaveCount(0);
    await post(page, { type: 'toolResult', tool: 'process', callId: 'call-9', output: '[]' });

    await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: JSON.stringify({ command: 'npm run dev' }), callId: 'call-1' });
    const handoff = page.locator('.step.running button.icon-btn-mini');
    await expect(handoff).toHaveCount(1);
    await handoff.click();
    expect(await sent(page)).toContainEqual({ type: 'backgroundTerminal', callId: 'call-1' });

    await post(page, { type: 'terminalBackgrounded', callId: 'call-1', jobId: 'job-7', byUser: true });
    const stop = page.locator('.step button.icon-btn-mini');
    await expect(stop).toHaveCount(1);
    await stop.click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-7' });
    expect((await sent(page)).filter(m => m.type === 'backgroundTerminal')).toHaveLength(1);
});

for (const [locale, width] of [['en', 1080], ['fa', 420]] as const) {
    test(`background jobs: handoff, live follow, docking, exit code, stop-all and read-only Activity (${locale}, ${width})`, async ({ page }) => {
        await post(page, { type: 'transcriptPrefs', prefs: { expand: { terminal: true } } });
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await expect(page.locator('.bg-jobs')).toBeHidden();
        await expect(page.locator('#surface-tab-background')).toHaveCount(0);

        await page.locator('.composer-input').fill('Keep drafting while the server runs');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'run_terminal_command', args: JSON.stringify({ command: 'npm run dev -- --host localhost --port 5173' }), callId: 'cmd' });
        await post(page, { type: 'toolOutput', callId: 'cmd', value: 'Starting server\n' });
        await page.locator('.transcript-pane .icon-btn-mini').click();
        expect(await sent(page)).toContainEqual({ type: 'backgroundTerminal', callId: 'cmd' });
        await post(page, { type: 'terminalBackgrounded', callId: 'cmd', jobId: 'job', byUser: true });
        await post(page, { type: 'toolResult', tool: 'run_terminal_command', callId: 'cmd', output: 'Started background job job' });
        await post(page, { type: 'backgroundJobs', jobs: [
            { jobId: 'job', command: 'npm run dev -- --host localhost --port 5173', running: true, uptimeSeconds: 65 },
            { jobId: 'watch', command: 'npm run watch', running: true, uptimeSeconds: 12 },
        ] });
        await expect(page.locator('#surface-tab-background')).toHaveAttribute('aria-selected', 'false');
        await expect(page.locator('#surface-tab-background .tab-count')).toHaveText('2');

        await post(page, { type: 'fullResponse', persian: 'Server is running' });
        await post(page, { type: 'backgroundJobOutput', jobId: 'job', output: 'Ready at http://localhost:5173\nHot reload connected' });
        const runningPill = page.locator('.transcript-pane details.step');
        await expect(runningPill.locator('.detail-terminal .detail-output')).toContainText('Hot reload connected');
        await expect(page.locator('.transcript-pane .completed-steps')).toHaveCount(0);

        await page.locator('#surface-tab-background').click();
        await expect(page.locator('.background-pane')).toBeVisible();
        await expect(page.locator('.background-output')).toContainText('Hot reload connected');
        await expect(page.locator('.bg-job')).toHaveCount(2);
        await expect(page.locator('.bg-job-cmd').first()).toHaveAttribute('dir', 'ltr');
        if (locale === 'en') await expect(page.locator('.bg-job-stop').first()).toHaveAttribute('aria-label', 'Stop');

        const initialUptime = await page.locator('.bg-job-up').first().textContent();
        await expect.poll(() => page.locator('.bg-job-up').first().textContent()).not.toBe(initialUptime);
        await page.locator('.bg-job-copy').first().click();
        expect(await sent(page)).toContainEqual({ type: 'copyToClipboard', value: 'npm run dev -- --host localhost --port 5173' });

        const streamed = Array.from({ length: 180 }, (_, index) => `line ${index}: hot reload output`).join('\n');
        await post(page, { type: 'backgroundJobOutput', jobId: 'job', output: streamed });
        const log = page.locator('.background-task-detail:not(.panel-hidden) .background-output');
        await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
        await log.hover();
        await page.mouse.wheel(0, -20_000);
        await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(0);
        const follow = page.locator('.background-task-detail:not(.panel-hidden) .background-follow');
        await expect(follow).toHaveAttribute('aria-pressed', 'false');
        const newer = `${streamed}\nnew output while reading history`;
        await post(page, { type: 'backgroundJobOutput', jobId: 'job', output: newer });
        await expect(log).toContainText('new output while reading history');
        expect(await log.evaluate(el => el.scrollTop)).toBe(0);
        await post(page, { type: 'backgroundJobs', jobs: [
            { jobId: 'job', command: 'npm run dev -- --host localhost --port 5173', running: true, uptimeSeconds: 66 },
            { jobId: 'watch', command: 'npm run watch', running: true, uptimeSeconds: 13 },
        ] });
        await expect(log).toHaveText(newer);
        await follow.click();
        await expect.poll(() => log.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1);
        await page.locator('.background-task-detail:not(.panel-hidden) .background-log-bar .bg-job-copy').click();
        expect(await sent(page)).toContainEqual({ type: 'copyToClipboard', value: newer });

        if (width > 900) {
            await dragToSidebar(page, '#surface-tab-background');
            await expect(page.locator('.background-pane')).toHaveClass(/panel-side/);
            await expect(log).toHaveText(newer);
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.background-pane')).toBeVisible();
            await expect(page.locator('.transcript-pane')).toBeVisible();
        }
        await expect(page.locator('.composer .bg-jobs')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveValue('Keep drafting while the server runs');

        await page.locator('.bg-jobs-stopall').click();
        expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job' });
        expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'watch' });

        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-pane .icon-btn-mini')).toHaveCount(0);
        await post(page, { type: 'backgroundJobFinished', jobId: 'job', status: 'exited', exitCode: 2, output: 'Exit code: 2\nSTDOUT:\n(empty)\nSTDERR:\nPort already in use' });
        await post(page, { type: 'backgroundJobs', jobs: [
            { jobId: 'job', command: 'npm run dev -- --host localhost --port 5173', running: false, status: 'exited', exitCode: 2, uptimeSeconds: 66, output: 'Port already in use' },
            { jobId: 'watch', command: 'npm run watch', running: true, uptimeSeconds: 13 },
        ] });
        const pill = page.locator('.activity-pane details.step');
        await expect(pill.locator('.detail-terminal .detail-output')).toHaveText('Port already in use');
        await expect(pill.locator('.detail-exit')).toContainText('2');
        await expect(page.locator('.bg-job')).toHaveCount(2);

        await page.locator('#surface-tab-background').click();
        await page.locator('.background-task-select').first().click();
        await expect(page.locator('.background-task-detail:not(.panel-hidden) .background-exit')).toContainText('2');
        await expect(page.locator('.background-task').first().locator('.bg-job-stop')).toHaveCount(0);
        await expect(page.locator('.bg-job-stop')).toHaveCount(1);

        await post(page, { type: 'backgroundJobStopped', jobId: 'watch' });
        await post(page, { type: 'backgroundJobs', jobs: [] });
        await expect(page.locator('.bg-panel-empty')).toBeVisible();
        await expect(page.locator('#surface-tab-background')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.bg-job')).toHaveCount(0);
        expect((await sent(page)).filter(m => m.type === 'askQuestion')).toHaveLength(0);
    });
}

test('short viewport uses full height and recovered detached jobs stay stoppable', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 300 });
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }] });
    await page.locator('#surface-tab-background').click();
    await expect(page.locator('.bg-job-stop')).toBeVisible();
    await expect(page.locator('.composer-input')).toBeHidden();
    const bounds = await page.evaluate(() => {
        const pane = document.querySelector('.background-pane')!.getBoundingClientRect();
        const row = document.querySelector('.bg-job')!.getBoundingClientRect();
        const atRow = document.elementFromPoint(row.right - 15, row.top + row.height / 2);
        return { inside: row.top >= pane.top && row.bottom <= pane.bottom, insideViewport: pane.bottom <= innerHeight, hit: !!atRow?.closest('.background-pane') };
    });
    expect(bounds.inside).toBe(true);
    expect(bounds.insideViewport).toBe(true);
    expect(bounds.hit).toBe(true);
    await page.locator('.bg-job-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });

    await page.setViewportSize({ width: 420, height: 900 });
    await post(page, { type: 'locale', locale: 'fa' });
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'recovered', command: 'npm run dev', running: true, uptimeSeconds: 123, detached: true, pid: 123, cwd: 'C:\\project' }] });
    await expect(page.locator('.background-output-empty')).toContainText('VS Code');
    await expect(page.locator('.background-output')).toHaveCount(0);
    await page.locator('.background-task-info > summary').click();
    await expect(page.locator('.background-task-info')).toContainText('C:\\project');
    await expect(page.locator('.background-task-info')).toContainText('PID 123');
    await page.locator('.bg-job-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'killBackgroundJob', jobId: 'recovered' });
});

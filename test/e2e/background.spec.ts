/**
 * Browser tests for the background-process UI in the built webview bundle.
 *
 * Driven the same way as `app.spec.ts`: a mocked `acquireVsCodeApi` records
 * what the webview sends, and the host is simulated by posting the real
 * `FromExtensionMessage` envelopes.
 *
 * The point of these is the WIRING, which unit tests cannot see: a button that
 * renders but posts the wrong message type, or a badge that never appears, both
 * pass a render-only test and fail in the real extension host.
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

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

const sentMessages = (page: Page): Array<Record<string, unknown>> =>
    page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<Record<string, unknown>>);

/** A streaming assistant turn with one running terminal call in it. */
async function showStreamingTerminal(page: Page): Promise<void> {
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'toolCall',
        tool: 'run_terminal_command',
        args: JSON.stringify({ command: 'npm run dev' }),
        callId: 'call-1',
    });
    await expect(page.locator('.step.running')).toBeVisible();
}

test('a running terminal call offers "run in background" and posts the handoff', async ({ page }) => {
    await page.goto('/');
    await showStreamingTerminal(page);

    const button = page.locator('.step.running button.icon-btn-mini');
    await expect(button).toHaveCount(1);
    await button.click();

    const sent = await sentMessages(page);
    expect(sent).toContainEqual({ type: 'backgroundTerminal', callId: 'call-1' });
});

test('a backgrounded call swaps the handoff for a stop that posts the job id', async ({ page }) => {
    await page.goto('/');
    await showStreamingTerminal(page);

    await hostMessage(page, {
        type: 'terminalBackgrounded',
        callId: 'call-1',
        jobId: 'job-7',
        byUser: true,
    });

    // Exactly one action button, and it is now the stop.
    const button = page.locator('.step button.icon-btn-mini');
    await expect(button).toHaveCount(1);
    await button.click();

    const sent = await sentMessages(page);
    expect(sent).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-7' });
    expect(sent).not.toContainEqual({ type: 'backgroundTerminal', callId: 'call-1' });
});

test('the background tab lists live jobs and stops them', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });

    // Nothing until the host reports jobs.
    await expect(page.locator('.bg-jobs')).toHaveCount(0);

    await hostMessage(page, {
        type: 'backgroundJobs',
        jobs: [
            { jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 42 },
            { jobId: 'job-2', command: 'npm run watch', running: true, uptimeSeconds: 7 },
            // A finished job is not something the user can still stop.
            { jobId: 'job-3', command: 'npm test', running: false, uptimeSeconds: 90 },
        ],
    });

    // Starting a job announces its count without switching the conversation.
    await expect(page.locator('#surface-tab-background')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#surface-tab-background .tab-count')).toHaveText('2');

    await page.locator('#surface-tab-background').click();
    const chips = page.locator('.bg-job');
    await expect(chips).toHaveCount(3);
    await expect(page.locator('.bg-job-stop')).toHaveCount(2);
    await expect(chips.last().locator('.bg-job-stop')).toHaveCount(0);
    await expect(chips.first().locator('.bg-job-cmd')).toHaveText('npm run dev');
    // Commands are LTR content even in the RTL layout.
    await expect(chips.first().locator('.bg-job-cmd')).toHaveAttribute('dir', 'ltr');
    await expect(chips.first().locator('.bg-job-up')).toHaveText('42s');

    await page.locator('.bg-job-stop').first().click();
    const sent = await sentMessages(page);
    expect(sent).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
});

test('removing the last job hides the background tab', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, {
        type: 'backgroundJobs',
        jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 }],
    });
    await expect(page.locator('.bg-jobs')).toHaveCount(1);

    await hostMessage(page, { type: 'backgroundJobs', jobs: [] });
    await expect(page.locator('.bg-jobs')).toHaveCount(0);
});

test('the background tab respects English direction', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, {
        type: 'backgroundJobs',
        jobs: [{ jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 12 }],
    });

    await expect(page.locator('.app')).toHaveAttribute('dir', 'ltr');
    await page.locator('#surface-tab-background').click();
    await expect(page.locator('.bg-job')).toHaveCount(1);
    // The action label must be the English one, not the raw key.
    await expect(page.locator('.bg-job-stop')).toHaveAttribute('aria-label', 'Stop');
});

test('a short Background panel uses its height without the composer', async ({page}) => {
    await page.setViewportSize({width:420,height:300});
    await page.goto('/'); await hostMessage(page,{type:'showChat'});
    await hostMessage(page,{type:'backgroundJobs',jobs:[{jobId:'job-1',command:'npm run dev',running:true,uptimeSeconds:3}]});
    await page.locator('#surface-tab-background').click();
    await expect(page.locator('.bg-job-stop')).toBeVisible();
    await expect(page.locator('.composer-input')).toBeHidden();
    const bounds=await page.evaluate(()=>{
        const pane=document.querySelector('.background-pane')!.getBoundingClientRect(), row=document.querySelector('.bg-job')!.getBoundingClientRect();
        const atRow=document.elementFromPoint(row.right-15,row.top+row.height/2);
        return {inside:row.top>=pane.top&&row.bottom<=pane.bottom, insideViewport:pane.bottom<=innerHeight,hit:!!atRow?.closest('.background-pane')};
    });
    expect(bounds.inside).toBe(true); expect(bounds.insideViewport).toBe(true); expect(bounds.hit).toBe(true);
    await page.locator('.bg-job-stop').click();
    expect(await sentMessages(page)).toContainEqual({type:'killBackgroundJob',jobId:'job-1'});
});

test('background tab counts running tasks and preserves the draft across views', async ({page}) => {
    await page.goto('/');
    await hostMessage(page,{type:'showChat'});
    await page.locator('.composer-input').fill('A draft stays here');
    await hostMessage(page,{type:'backgroundJobs',jobs:[{jobId:'job-1',command:'npm run dev',running:true,uptimeSeconds:3}]});
    await expect(page.locator('#surface-tab-background .tab-count')).toHaveText('1');
    await page.locator('#surface-tab-background').click();
    await expect(page.locator('.background-pane')).toBeVisible();
    await page.locator('#surface-tab-conversation').click();
    await expect(page.locator('.background-pane')).not.toBeVisible();
    await expect(page.locator('.composer-input')).toHaveValue('A draft stays here');
    await hostMessage(page,{type:'backgroundJobs',jobs:[{jobId:'job-1',command:'npm run dev',running:true,uptimeSeconds:4},{jobId:'job-2',command:'npm run watch',running:true,uptimeSeconds:1}]});
    await expect(page.locator('#surface-tab-background .tab-count')).toHaveText('2');
});

test('copy and stop-all act on the tasks in the background tab', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, {
        type: 'backgroundJobs',
        jobs: [
            { jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 3 },
            { jobId: 'job-2', command: 'npm run watch', running: true, uptimeSeconds: 1 },
        ],
    });
    await page.locator('#surface-tab-background').click();

    await page.locator('.bg-job-copy').first().click();
    await page.locator('.bg-jobs-stopall').click();

    const sent = await sentMessages(page);
    expect(sent).toContainEqual({ type: 'copyToClipboard', value: 'npm run dev' });
    expect(sent).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-1' });
    expect(sent).toContainEqual({ type: 'killBackgroundJob', jobId: 'job-2' });
});

test('the process tool row renders with its own label and no handoff button', async ({ page }) => {
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'toolCall',
        tool: 'process',
        args: JSON.stringify({ action: 'list' }),
        callId: 'call-9',
    });

    await expect(page.locator('.step')).toBeVisible();
    await expect(page.locator('.step button.icon-btn-mini')).toHaveCount(0);
});
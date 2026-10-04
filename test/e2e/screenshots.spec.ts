/**
 * Screenshot harness for the background-process UI.
 *
 * Not a test: it drives the built bundle through the states a reviewer needs to
 * LOOK at and writes PNGs to test/e2e/screenshots/. Run manually:
 *
 *   npm run build:webview
 *   XRATU_SCREENSHOTS=1 npx playwright test -c test/e2e/playwright.config.ts screenshots.spec.ts
 *
 * Both locales and both widths, because RTL breaks differently than LTR and a
 * sidebar is where the composer badge actually has to fit.
 */
import { test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(__dirname, 'screenshots');

test.beforeEach(async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as Record<string, unknown>).__xratuHostMessages = sent;
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (message: unknown) => { sent.push(message); },
            getState: () => undefined,
            setState: (state: unknown) => state,
        });
    });
});

async function host(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

const JOBS = [
    { jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 142 },
    { jobId: 'job-2', command: 'npx tailwindcss --watch', running: true, uptimeSeconds: 37 },
];

for (const locale of ['fa', 'en'] as const) {
    for (const [label, width] of [['sidebar', 420], ['wide', 900]] as const) {
        test(`${locale} ${label}: running command with the background button`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            // The standalone page has NO VS Code theme; without the real
            // tokens every surface renders transparent and the screenshots
            // look plausible while proving nothing.
            await installVscodeTheme(page);
            await page.goto('/');
            await host(page, { type: 'locale', locale });
            await host(page, { type: 'showChat' });
            await host(page, { type: 'startResponse' });
            await host(page, { type: 'toolOutput', callId: 'call-1', value: '> vite v5.4.0\n> Local: http://localhost:5173/\n' });
            await host(page, {
                type: 'toolCall',
                tool: 'run_terminal_command',
                args: JSON.stringify({ command: 'npm run dev' }),
                callId: 'call-1',
            });
            await page.locator('.step.running').waitFor();
            await host(page, { type: 'backgroundJobs', jobs: [JOBS[0]!] });
            await page.locator('.bg-job').waitFor();
            await page.screenshot({ path: join(OUT, `bg-running-${locale}-${label}.png`) });
        });

        test(`${locale} ${label}: backgrounded row with the stop control`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            // The standalone page has NO VS Code theme; without the real
            // tokens every surface renders transparent and the screenshots
            // look plausible while proving nothing.
            await installVscodeTheme(page);
            await page.goto('/');
            await host(page, { type: 'locale', locale });
            await host(page, { type: 'showChat' });
            await host(page, { type: 'startResponse' });
            await host(page, { type: 'toolOutput', callId: 'call-1', value: '> vite v5.4.0\n> Local: http://localhost:5173/\n' });
            await host(page, {
                type: 'toolCall',
                tool: 'run_terminal_command',
                args: JSON.stringify({ command: 'npm run dev' }),
                callId: 'call-1',
            });
            await page.locator('.step.running').waitFor();
            await host(page, { type: 'terminalBackgrounded', callId: 'call-1', jobId: 'job-1', byUser: true });
            await host(page, { type: 'backgroundJobs', jobs: JOBS });
            await page.locator('.bg-job').nth(1).waitFor();
            await page.screenshot({ path: join(OUT, `bg-stop-${locale}-${label}.png`) });
        });

        test(`${locale} ${label}: the process tool managing both jobs`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            // The standalone page has NO VS Code theme; without the real
            // tokens every surface renders transparent and the screenshots
            // look plausible while proving nothing.
            await installVscodeTheme(page);
            await page.goto('/');
            await host(page, { type: 'locale', locale });
            await host(page, { type: 'showChat' });
            await host(page, { type: 'startResponse' });
            await host(page, { type: 'toolCall', tool: 'process', args: JSON.stringify({ action: 'list' }), callId: 'call-2' });
            await host(page, {
                type: 'toolResult',
                tool: 'process',
                output: '2 job(s), 1 still running:\n\njob-1  background  running 142s (pid 4417)\n  $ npm run dev\njob-2  background  exited with code 0\n  $ npm run build',
                callId: 'call-2',
            });
            await host(page, { type: 'backgroundJobs', jobs: [JOBS[0]!] });
            await page.locator('.step').first().waitFor();
            await page.screenshot({ path: join(OUT, `bg-process-${locale}-${label}.png`) });
        });
    }
}
import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { BrowserController } from '../../src/browserController';
import type { BrowserCommand } from '../../src/browserTypes';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: unknown) => page.evaluate(msg => window.postMessage(msg, '*'), message);
const demo = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Browser test</title><style>body{font:20px system-ui;background:#20252c;color:#e7e9ed;margin:24px}input,button{font:inherit}main{min-height:1800px}footer{color:#9de7cd}</style></head><body><main><h1>Live browser</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value">Save</button><output></output><a href="/next">Next page</a></main><footer>End of page</footer><script>console.log('demo loaded')</script></body></html>`;
let server: Server;
let demoUrl: string;
test.beforeAll(async () => {
    server = createServer((request, response) => response.end(request.url === '/next' ? '<title>Next</title><h1>Next page</h1>' : demo));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Demo server did not start');
    demoUrl = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

async function setup(page: Page, launchOptions: Parameters<typeof chromium.launch>[0], locale: string) {
    let delivery: Promise<unknown> = Promise.resolve();
    const errors: unknown[] = [];
    const controller = new BrowserController({ executablePath: () => '', launch: () => chromium.launch(launchOptions), emit: event => {
        delivery = delivery.then(() => post(page, event)).catch(error => errors.push(error));
    } });
    controller.setSession('browser-session');
    await installVscodeTheme(page);
    await page.exposeFunction('__xratuBrowserBridge', async (message: Record<string, unknown>) => {
        switch (message.type) {
            case 'browserGetState': controller.publish(); break;
            case 'browserVisible': await controller.setVisible(String(message.sessionId), String(message.browserId), message.visible === true).catch(() => undefined); break;
            case 'browserFrameAck': controller.ack(String(message.sessionId), String(message.browserId), Number(message.frameId)); break;
            case 'browserCommand': await controller.command(String(message.sessionId), String(message.browserId), message.command as BrowserCommand).catch(error => errors.push(error)); break;
        }
    });
    await page.addInitScript(() => {
        const messages: unknown[] = []; let saved: unknown;
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({
            postMessage: (message: unknown) => { messages.push(message); void (window as unknown as { __xratuBrowserBridge: (message: unknown) => Promise<void> }).__xratuBrowserBridge(message); },
            getState: () => saved, setState: (value: unknown) => { saved = value; },
        }) });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale }); await post(page, { type: 'showChat' });
    await post(page, { type: 'sessionState', id: 'browser-session', title: null });
    await post(page, { type: 'openBrowser' });
    return { controller, errors, settle: () => delivery };
}

for (const locale of ['en', 'fa']) for (const width of [420, 1280]) {
    test(`shared browser navigation, pixels, tools and docking (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        const { controller, errors, settle } = await setup(page, info.project.use.launchOptions, locale);
        try {
            await expect(page.locator('.browser-pane')).toBeVisible();
            await expect(page.locator('.browser-address')).toHaveAttribute('dir', 'ltr');
            await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
            await page.locator('.browser-address').fill(demoUrl); await page.locator('.browser-address').press('Enter');
            await expect(page.locator('.browser-viewport img')).toBeVisible();
            await expect(page.locator('.browser-page-title')).toHaveText('Browser test');
            await page.locator('#surface-tab-conversation').click();
            expect((await controller.tool('browser-session', 'browser_open', { url: demoUrl })).isError).toBeUndefined();
            await expect(page.locator('#surface-tab-browser')).toHaveAttribute('aria-selected', 'true');
            const snapshot = await controller.tool('browser-session', 'browser_snapshot', {});
            expect(JSON.parse(snapshot.output).accessibilityTree).toContain('textbox "Name"');
            expect(snapshot.output).toContain('demo loaded');
            const beforePersistence = controller.getState();
            await post(page, { type: 'sessionState', id: 'persisted-browser-session', title: null, browserSessionId: 'browser-session' });
            await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected', 'true');
            await page.locator('#surface-tab-browser').click();
            controller.publish(); await settle();
            await expect(page.locator('.browser-viewport img')).toBeVisible();
            await expect(page.locator('.browser-address')).toHaveValue(beforePersistence.url);
            expect(controller.getState().browserId).toBe(beforePersistence.browserId);
            expect((await controller.tool('browser-session', 'browser_type', { locator: 'role=textbox[name="Name"]', text: 'Xratu سلام' })).isError).toBeUndefined();
            expect((await controller.tool('browser-session', 'browser_click', { locator: 'role=button[name="Save"]' })).isError).toBeUndefined();
            expect((await controller.tool('browser-session', 'browser_snapshot', {})).output).toContain('Saved Xratu سلام');
            const shot = await controller.tool('browser-session', 'browser_screenshot', {});
            expect(shot.images?.[0].dataBase64.length).toBeGreaterThan(1000);
            // Resize through the tab, proving the displayed viewport is the controlled page.
            await page.locator('.browser-viewport-picker select').selectOption('mobile');
            await expect.poll(() => controller.getState().viewport.width).toBe(390);
            await expect.poll(() => page.locator('.browser-viewport img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(390);
            const box = JSON.parse((await controller.tool('browser-session', 'browser_evaluate', { expression: '(()=>{const r=document.querySelector("input").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()' })).output);
            await page.locator('.browser-viewport img').scrollIntoViewIfNeeded();
            const pixels = await page.locator('.browser-viewport img').boundingBox();
            await page.locator('.browser-viewport img').click({ position: { x: box.x * pixels!.width / 390, y: box.y * pixels!.height / 844 } });
            await expect.poll(async () => (await controller.tool('browser-session', 'browser_evaluate', { expression: 'document.activeElement.tagName' })).output).toBe('"INPUT"');
            await page.locator('.browser-keyboard').press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
            await expect.poll(async () => (await controller.tool('browser-session', 'browser_evaluate', { expression: '(()=>{const el=document.querySelector("input");return el.selectionStart===0 && el.selectionEnd===el.value.length})()' })).output).toBe('true');
            await page.locator('.browser-keyboard').pressSequentially('Human');
            await expect.poll(async () => (await controller.tool('browser-session', 'browser_evaluate', { expression: 'document.querySelector("input").value' })).output).toBe('"Human"');
            await page.locator('.browser-keyboard').focus(); await page.locator('.browser-keyboard').press('Tab');
            await expect.poll(async () => (await controller.tool('browser-session', 'browser_evaluate', { expression: 'document.activeElement.tagName' })).output).toBe('"BUTTON"');
            if (width > 860) {
                await page.locator('#surface-tab-browser').press('Shift+F10');
                await page.locator('.dock-layout-menu [role=menuitem]').first().click();
                await expect(page.locator('.browser-pane')).toHaveClass(/panel-main/);
                await page.locator('#surface-tab-browser').press('Shift+F10');
                await page.locator('.dock-layout-menu [role=menuitem]').first().click();
                await expect(page.locator('.browser-pane')).toHaveClass(/panel-side/);
                await expect(page.locator('.browser-viewport img')).toBeVisible();
                await expect(page.locator('.composer-input')).toBeVisible();
                await page.locator('.composer-input').fill('draft survives browser docking');
                await page.setViewportSize({ width: 420, height: 900 });
                await page.locator('#surface-tab-browser').click();
                await expect(page.locator('.browser-viewport img')).toBeVisible();
                await page.locator('#surface-tab-conversation').click();
                await expect(page.locator('.composer-input')).toHaveValue('draft survives browser docking');
            } else {
                await page.locator('#surface-tab-conversation').click();
                await page.locator('.composer-input').fill('draft survives page changes');
                await page.locator('#surface-tab-browser').click();
                await expect(page.locator('.browser-viewport img')).toBeVisible();
            }
            // Old chat frames must never render after switching sessions.
            const previous = controller.getState(); controller.setSession('next-session');
            await post(page, { type: 'sessionState', id: 'next-session', title: null }); await settle();
            await post(page, { type: 'browserFrame', frame: { sessionId: previous.sessionId, browserId: previous.browserId, frameId: 999, data: shot.images![0].dataBase64, width: 1280, height: 800 } });
            await expect(page.locator('.browser-viewport img')).toHaveCount(0);
            expect(errors).toEqual([]);
        } finally { controller.dispose(); await settle(); }
    });
}

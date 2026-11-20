/**
 * Proxy page tests: host state drives mode/resolution, detected clients,
 * per-MCP routing, connectivity tests, requestId acknowledgment guards,
 * entry-path state requests, and button contrast across themes.
 */
import { openPageNavigation } from './navigation';
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

async function sentMessages(page: Page): Promise<Array<Record<string, unknown>>> {
    return page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
}

async function openProxy(page: Page, locale: 'fa' | 'en' = 'en', theme: 'dark' | 'light' = 'dark', forceDark = false): Promise<void> {
    await installVscodeTheme(page, theme);
    await page.addInitScript(forceDark => {
        const sent: unknown[] = [];
        (window as unknown as Record<string, unknown>).__xratuHostMessages = sent;
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (m: unknown) => { sent.push(m); },
            getState: () => forceDark ? { surfaceAppearance: { scheme: 'dark', accent: 'violet' } } : undefined,
            setState: (s: unknown) => s,
        });
    }, forceDark);
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'openSettings' });
    await hostMessage(page, {
        type: 'proxyState',
        mode: 'auto',
        proxyUrl: 'http://127.0.0.1:7890',
        noProxy: 'localhost,127.0.0.1',
        resolvedUrl: 'http://127.0.0.1:7890',
        resolvedSource: 'system',
        systemProxy: 'http://127.0.0.1:7890',
        noProxyList: 'localhost,127.0.0.1',
    });
    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: /^(Proxy|پروکسی)$/, exact: true }).click();
    await page.waitForSelector('.routing-page');
}

test('proxy page renders resolution, custom fields, shared dropdown, header alignment, and saves composed URL', async ({ page }) => {
    await openProxy(page);
    const btn = page.locator('.proxy-save-row .apply-btn');
    await expect(btn).toBeDisabled();
    await expect(btn.locator('svg')).toHaveCount(0);
    await expect(page.locator('.route-map')).toContainText('http://127.0.0.1:7890');
    await expect(page.locator('.route-current')).toContainText('system proxy');

    // Header title sits at inline start, test action at far end.
    const geometry = await page.evaluate(() => {
        const head = document.querySelector('.routing-page .settings-head')!.getBoundingClientRect();
        const icon = document.querySelector('.routing-page header .proxy-test-action')!.getBoundingClientRect();
        const title = document.querySelector('.routing-page .settings-head-copy')!.getBoundingClientRect();
        return { startGap: title.left - head.left, endGap: head.right - icon.right, iconPastMid: icon.left > head.left + head.width / 2 };
    });
    expect(geometry.startGap).toBeLessThan(24);
    expect(geometry.endGap).toBeLessThan(24);
    expect(geometry.iconPastMid).toBe(true);

    // Custom mode reveals fields with shared dropdown (no native select) and saves composed URL.
    await page.getByRole('button', { name: 'Custom', exact: true }).click();
    await expect(page.locator('#proxy-host')).toHaveValue('127.0.0.1');
    await expect(page.locator('#proxy-port')).toHaveValue('7890');
    await expect(page.locator('.bypass-details')).toHaveAttribute('open', '');
    await expect(page.locator('#proxy-noproxy')).toHaveValue('localhost,127.0.0.1');
    await expect(page.locator('.proxy-field .dropdown-trigger')).toHaveCount(1);
    await expect(page.locator('.proxy-field select')).toHaveCount(0);

    // Unrelated host refresh preserves a drafted custom mode.
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1', resolvedUrl: 'http://changed.example:8080', resolvedSource: 'system' });
    await expect(page.locator('.route-map')).toContainText('http://changed.example:8080');
    await expect(page.getByRole('button', { name: 'Custom', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#proxy-port').fill('7897');
    await expect(btn).toBeEnabled();
    await btn.click();
    const sent = await sentMessages(page);
    expect(sent).toContainEqual({
        type: 'proxySave',
        mode: 'custom',
        proxyUrl: 'http://127.0.0.1:7897',
        noProxy: 'localhost,127.0.0.1',
        webSearchUseProxy: true,
        requestId: expect.any(String),
    });
    const save = sent.filter(m => m.type === 'proxySave').at(-1)!;
    await hostMessage(page, {
        type: 'proxyState', mode: 'custom', proxyUrl: 'http://127.0.0.1:7897', noProxy: 'localhost,127.0.0.1',
        resolvedUrl: 'http://127.0.0.1:7897', resolvedSource: 'setting', systemProxy: null, noProxyList: 'localhost,127.0.0.1',
        requestId: save.requestId,
    });
    await expect(btn).toBeDisabled();
    await expect(btn.locator('svg')).toHaveCount(1);
    const idleBg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(idleBg).not.toBe('rgba(0, 0, 0, 0)');
    await page.locator('#proxy-port').fill('7899');
    await expect(btn).toBeEnabled();
    await expect(btn.locator('svg')).toHaveCount(0);
    await expect.poll(() => btn.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(idleBg);
});

test('full save and mode save honor requestId acknowledgments and preserve drafts on success or failure', async ({ page }) => {
    await openProxy(page);
    await page.locator('#proxy-noproxy').fill('saved.example');
    await page.locator('.proxy-save-row .apply-btn').click();
    const save = (await sentMessages(page)).find(m => m.type === 'proxySave')!;
    expect(save.requestId).toEqual(expect.any(String));
    const off = page.getByRole('button', { name: 'Off', exact: true });
    await expect(off).toBeDisabled();

    // Unrelated echo keeps mode locked; matching requestId unlocks and keeps newer edits.
    await page.locator('#proxy-noproxy').fill('later.example');
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'unrelated.example', resolvedSource: 'system', requestId: 'unrelated' });
    await expect(off).toBeDisabled();
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'saved.example', resolvedSource: 'system', requestId: save.requestId });
    await expect(off).toBeEnabled();
    await expect(page.locator('#proxy-noproxy')).toHaveValue('later.example');

    // Failed full save unlocks and retains unsaved draft.
    await page.locator('.proxy-save-row .apply-btn').click();
    const save2 = (await sentMessages(page)).filter(m => m.type === 'proxySave').at(-1)!;
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'saved.example', resolvedSource: 'system', requestId: save2.requestId });
    await expect(off).toBeEnabled();
    await expect(page.locator('#proxy-noproxy')).toHaveValue('later.example');
    await expect(page.locator('.proxy-save-row .apply-btn')).toBeEnabled();

    // Mode save writes only mode, disables competing candidate use, ignores unrelated echo, and preserves draft.
    await hostMessage(page, { type: 'proxyDetectResult', candidates: [{ service: 'Client', url: 'http://127.0.0.1:7897', ports: [{ port: 7897, protocol: 'http', url: 'http://127.0.0.1:7897', usable: true }] }] });
    const use = page.locator('.proxy-candidate').getByRole('button');
    await expect(use).toBeEnabled();
    await off.click();
    await expect(use).toBeDisabled();
    const modeSave = (await sentMessages(page)).filter(m => m.type === 'proxySaveMode').at(-1)!;
    expect(modeSave).toEqual({ type: 'proxySaveMode', mode: 'off', requestId: expect.any(String) });
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://new.example:8080', noProxy: 'external.example', resolvedUrl: 'http://new.example:8080', resolvedSource: 'system', requestId: 'unrelated' });
    await expect(page.locator('.route-map')).toContainText('http://new.example:8080');
    await expect(off).toBeDisabled();
    await expect(off).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#proxy-noproxy')).toHaveValue('later.example');

    // Failed mode save restores host mode and allows retry while keeping drafts.
    await hostMessage(page, { type: 'proxyState', mode: 'auto', proxyUrl: 'http://new.example:8080', noProxy: 'external.example', resolvedUrl: 'http://new.example:8080', resolvedSource: 'system', requestId: modeSave.requestId });
    await expect(off).toBeEnabled();
    const auto = page.locator('.routing-mode-toolbar').getByRole('button', { name: 'Auto', exact: true });
    await expect(auto).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#proxy-noproxy')).toHaveValue('later.example');

    // Retry Off -> ack -> Auto sends latest modes without saving drafts.
    await off.click();
    const retryOff = (await sentMessages(page)).filter(m => m.type === 'proxySaveMode').at(-1)!;
    await expect(auto).toBeDisabled();
    await hostMessage(page, { type: 'proxyState', mode: 'off', proxyUrl: 'http://new.example:8080', noProxy: 'external.example', resolvedUrl: null, resolvedSource: 'none', requestId: retryOff.requestId });
    await expect(auto).toBeEnabled();
    await auto.click();
    const modeSaves = (await sentMessages(page)).filter(m => m.type === 'proxySaveMode');
    expect(modeSaves.map(m => m.mode)).toEqual(['off', 'off', 'auto']);
    expect(modeSaves.every(m => !('noProxy' in m) && !('proxyUrl' in m))).toBe(true);
    await expect(page.locator('#proxy-noproxy')).toHaveValue('later.example');
});

test('SOCKS URL warning still allows turning proxy routing off', async ({ page }) => {
    await openProxy(page);
    await hostMessage(page, { type: 'proxyState', mode: 'custom', proxyUrl: 'socks5://127.0.0.1:1080', noProxy: 'localhost', resolvedSource: 'none' });
    await expect(page.locator('#proxy-port')).toHaveValue('1080');
    await expect(page.locator('.proxy-hint.warn')).toBeVisible();
    await page.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(page.locator('.proxy-hint.warn')).toHaveCount(0);
    expect(await sentMessages(page)).toContainEqual({ type: 'proxySaveMode', mode: 'off', requestId: expect.any(String) });
});

test('detected clients group ports, per-MCP routing posts targeted mcpSave, and connectivity test displays error', async ({ page }) => {
    await openProxy(page);
    await hostMessage(page, {
        type: 'proxyDetectResult',
        candidates: [
            {
                service: 'Clash Verge Rev',
                url: 'http://127.0.0.1:7897',
                ports: [
                    { port: 7897, protocol: 'mixed', url: 'http://127.0.0.1:7897', usable: true },
                    { port: 7898, protocol: 'socks5', url: 'socks5://127.0.0.1:7898', usable: false },
                ],
            },
            {
                service: 'SOCKS5 proxy',
                url: null,
                ports: [{ port: 1080, protocol: 'socks5', url: 'socks5://127.0.0.1:1080', usable: false }],
            },
        ],
    });
    await expect(page.locator('.proxy-candidate')).toHaveCount(2);
    await expect(page.locator('.proxy-candidate').first().locator('.proxy-port-chip')).toHaveCount(2);
    await expect(page.locator('.proxy-candidate').first()).toContainText('7897');
    await expect(page.locator('.proxy-candidate').first()).toContainText('7898');
    const line = await page.evaluate(() => {
        const name = document.querySelector('.proxy-candidate .proxy-candidate-head strong')!.getBoundingClientRect();
        const chip = document.querySelector('.proxy-candidate .proxy-port-chip')!.getBoundingClientRect();
        return { overlaps: name.bottom > chip.top && name.top < chip.bottom, chipAfterName: chip.left >= name.right - 4 };
    });
    expect(line.overlaps).toBe(true);
    expect(line.chipAfterName).toBe(true);
    await expect(page.locator('.proxy-candidate .apply-btn')).toHaveCount(1);
    await expect(page.locator('.proxy-candidate').nth(1)).toContainText('not supported');

    await hostMessage(page, {
        type: 'mcpState',
        servers: [
            { name: 'context7', url: 'https://mcp.context7.com/mcp', type: 'streamableHttp', state: 'connected', toolCount: 3, lastError: null, source: 'global' },
            { name: 'local-tools', command: 'node', args: ['srv.js'], proxy: 'direct', state: 'connected', toolCount: 5, lastError: null, source: 'workspace' },
        ],
        hasWorkspace: true,
        legacyInUse: false,
    });
    await hostMessage(page, { type: 'proxyTestResult', ok: false, detail: 'fetch failed' });
    await expect(page.locator('.proxy-mcp-row')).toHaveCount(2);
    await expect(page.locator('.proxy-mcp-row').nth(1).locator('.lang-chip.active')).toHaveText(/direct/i);
    await expect(page.locator('.route-test-result')).toHaveClass(/fail/);
    await expect(page.locator('.route-test-result')).toContainText('fetch failed');
    await expect(page.locator('.routing-page header .proxy-test-action')).toBeVisible();
    await page.locator('.proxy-mcp-row').first().locator('.lang-chip', { hasText: /via proxy/i }).click();
    const saves = (await sentMessages(page)).filter((m) => m.type === 'mcpSave');
    expect(saves.length).toBeGreaterThan(0);
    const globalSave = saves.find((m) => m.target === 'global') as { servers: Array<Record<string, unknown>> };
    expect(globalSave.servers.find((s) => s.name === 'context7')?.proxy).toBe('proxy');
});

for (const [theme, locale, width] of [
    ['dark', 'en', 420],
    ['light', 'fa', 1440],
    ['app-dark', 'en', 420],
] as const) {
    test(`routing save keeps readable ink through state changes (${theme}, ${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 960 });
        await openProxy(page, locale, theme === 'app-dark' ? 'light' : theme, theme === 'app-dark');
        await expect(page.locator('.app')).toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        const button = page.locator('.proxy-save-row .apply-btn');
        await expect(button).toBeDisabled();
        const monitor = async (change: () => Promise<unknown>) => {
            await button.evaluate(element => {
                const context = document.createElement('canvas').getContext('2d')!;
                const rgb = (color: string) => {
                    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
                };
                const luminance = (color: string) => {
                    const [r, g, b] = rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
                    return .2126 * r + .7152 * g + .0722 * b;
                };
                Object.assign(window, { routingFrames: new Promise<string[]>(resolve => {
                    const failures: string[] = [];
                    let frames = 0;
                    const sample = () => {
                        const style = getComputedStyle(element);
                        const label = getComputedStyle(element.querySelector('span')!);
                        const a = luminance(style.backgroundColor), b = luminance(label.color);
                        const background = rgb(style.backgroundColor);
                        if ((element as HTMLButtonElement).disabled) {
                            if (Math.max(...background) - Math.min(...background) > 1) failures.push(`Disabled colored surface: ${style.backgroundColor}`);
                        } else if ((Math.max(a, b) + .05) / (Math.min(a, b) + .05) < 4.5) failures.push(`Unreadable active action: ${label.color} on ${style.backgroundColor}`);
                        if (label.color !== style.color) failures.push('Label does not inherit button ink');
                        if (++frames < 18) requestAnimationFrame(sample);
                        else resolve(failures.slice(0, 5));
                    };
                    requestAnimationFrame(sample);
                }) });
            });
            await change();
            expect(await page.evaluate(() => (window as unknown as { routingFrames: Promise<string[]> }).routingFrames)).toEqual([]);
        };
        await page.locator('.routing-mode-toolbar button').last().click();
        const first = (await sentMessages(page)).find(m => m.type === 'proxySaveMode')!;
        await hostMessage(page, { type: 'proxyState', mode: 'off', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1', resolvedUrl: null, resolvedSource: 'none', webSearchUseProxy: true, requestId: first.requestId });
        await monitor(() => page.locator('#proxy-noproxy').fill('draft.example'));
        await expect(button).toBeEnabled();
        await monitor(() => button.hover());
        await button.click();
        const fullSave = (await sentMessages(page)).find(m => m.type === 'proxySave')!;
        await monitor(() => hostMessage(page, { type: 'proxyState', mode: 'off', proxyUrl: 'http://127.0.0.1:7890', noProxy: 'draft.example', resolvedUrl: null, resolvedSource: 'none', webSearchUseProxy: true, requestId: fullSave.requestId }));
        await expect(button).toBeDisabled();
    });
}

test('settings sidebar routes request each destination page state on entry', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
    await installVscodeTheme(page);
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as unknown as Record<string, unknown>).__xratuHostMessages = sent;
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (m: unknown) => { sent.push(m); },
            getState: () => undefined,
            setState: (s: unknown) => s,
        });
    });
    await page.goto('/');
    await hostMessage(page, { type: 'locale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });
    await hostMessage(page, { type: 'openSettings' });
    await page.waitForSelector('.settings-page');
    await expect(page.locator('.settings-page').getByRole('switch', { name: 'Offline mode', exact: true })).toBeVisible();

    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: 'Proxy', exact: true }).click();
    let sent = await sentMessages(page);
    expect(sent.some((m) => m.type === 'proxyGetState')).toBe(true);
    expect(sent.some((m) => m.type === 'mcpGetState')).toBe(true);
    expect(sent.some((m) => m.type === 'proxyDetect')).toBe(true);

    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: 'Providers', exact: true }).click();
    sent = await sentMessages(page);
    expect(sent.some((m) => m.type === 'openCredentials')).toBe(true);

    await openPageNavigation(page);
    await page.locator('.page-sidebar').getByRole('button', { name: 'Servers', exact: true }).click();
    sent = await sentMessages(page);
    expect(sent.some((m) => m.type === 'mcpGetState')).toBe(true);
    expect(sent.some((m) => m.type === 'skillsGetState')).toBe(true);
});

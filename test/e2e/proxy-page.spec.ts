/**
 * Proxy page smoke tests: host messages drive the page (mode + resolution
 * report, detected local clients, per-MCP routing, connectivity test) and the
 * save path must round-trip the composed server URL back to the host.
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

async function openProxy(page: Page, locale: 'fa' | 'en' = 'en'): Promise<void> {
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
    await page.locator('button.settings-nav-row').last().click();
    await page.waitForSelector('.proxy-field-row');
}

test('proxy page renders the resolution report and fields', async ({ page }) => {
    await openProxy(page);
    await expect(page.locator('.proxy-status')).toContainText('http://127.0.0.1:7890');
    await expect(page.locator('.proxy-source-chip')).toContainText('system proxy');
    await expect(page.locator('#proxy-host')).toHaveValue('127.0.0.1');
    await expect(page.locator('#proxy-port')).toHaveValue('7890');
    await expect(page.locator('#proxy-noproxy')).toHaveValue('localhost,127.0.0.1');
    await expect(page.locator('.proxy-save-row .apply-btn')).toBeDisabled();
});

test('saving composes the server URL and posts it', async ({ page }) => {
    await openProxy(page);
    await page.locator('#proxy-port').fill('7897');
    await expect(page.locator('.proxy-save-row .apply-btn')).toBeEnabled();
    await page.locator('.proxy-save-row .apply-btn').click();
    const sent = await page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__xratuHostMessages as unknown[]);
    expect(sent).toContainEqual({
        type: 'proxySave',
        mode: 'auto',
        proxyUrl: 'http://127.0.0.1:7897',
        noProxy: 'localhost,127.0.0.1',
    });
});

test('detected clients group their ports under one family row', async ({ page }) => {
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
    // The Verge family lists BOTH its ports under the single client row.
    await expect(page.locator('.proxy-candidate').first().locator('.proxy-port-chip')).toHaveCount(2);
    await expect(page.locator('.proxy-candidate').first()).toContainText('7897');
    await expect(page.locator('.proxy-candidate').first()).toContainText('7898');
    // Port pills sit BESIDE the client name (same line), not under it.
    const line = await page.evaluate(() => {
        const name = document.querySelector('.proxy-candidate .proxy-candidate-head strong')!;
        const chip = document.querySelector('.proxy-candidate .proxy-port-chip')!;
        const n = name.getBoundingClientRect();
        const c = chip.getBoundingClientRect();
        return { overlaps: n.bottom > c.top && n.top < c.bottom, chipAfterName: c.left >= n.right - 4 };
    });
    expect(line.overlaps).toBe(true);
    expect(line.chipAfterName).toBe(true);
    // The usable family offers a lock ("Use"); the socks-only one explains itself.
    await expect(page.locator('.proxy-candidate .apply-btn')).toHaveCount(1);
    await expect(page.locator('.proxy-candidate').nth(1)).toContainText('not supported');
});

test('per-MCP routing rows and the connectivity test result', async ({ page }) => {
    await openProxy(page);
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
    // Result strip under the header (the test itself runs from the header icon).
    await expect(page.locator('.proxy-test')).toHaveClass(/fail/);
    await expect(page.locator('.proxy-test')).toContainText('fetch failed');
    await expect(page.locator('header .icon-btn')).toBeVisible();
    // Toggling one server's route posts a targeted mcpSave.
    await page.locator('.proxy-mcp-row').first().locator('.lang-chip', { hasText: /via proxy/i }).click();
    const sent = await page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__xratuHostMessages as unknown[]);
    const saves = sent.filter((m) => (m as { type?: string }).type === 'mcpSave');
    expect(saves.length).toBeGreaterThan(0);
    const globalSave = saves.find((m) => (m as { target?: string }).target === 'global') as { servers: Array<Record<string, unknown>> };
    expect(globalSave.servers.find((s) => s.name === 'context7')?.proxy).toBe('proxy');
});

test('proxy page keeps RTL in fa', async ({ page }) => {
    await openProxy(page, 'fa');
    await expect(page.locator('.app')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('.settings-page')).toBeVisible();
});

test('save button is gray until something is drafted', async ({ page }) => {
    await openProxy(page);
    const btn = page.locator('.proxy-save-row .apply-btn');
    await expect(btn).toBeDisabled();
    const idle = await btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor };
    });
    // Quiet gray pill, not a dimmed accent button.
    expect(idle.background).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    await page.locator('#proxy-port').fill('7899');
    await expect(btn).toBeEnabled();
    // Arming the button transitions its background in (motion polish) - poll
    // until the transition settles instead of sampling the first frame.
    await expect
        .poll(() => btn.evaluate((el) => getComputedStyle(el).backgroundColor))
        .not.toBe(idle.background);
});

test('settings page keeps the proxy section in the middle', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
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
    await hostMessage(page, { type: 'openSettings' });
    await page.waitForSelector('.settings-page');
    const heads = await page.locator('.settings-card h3').allInnerTexts();
    const proxyIdx = heads.findIndex((h) => /proxy/i.test(h));
    expect(proxyIdx).toBeGreaterThan(0);
    expect(proxyIdx).toBeLessThan(heads.length - 1);
});

test('proxy page polish assertions', async ({ page }) => {
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
    await hostMessage(page, {
        type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7897', noProxy: 'localhost,127.0.0.1',
        resolvedUrl: 'http://127.0.0.1:7897', resolvedSource: 'system',
        systemProxy: 'http://127.0.0.1:7897', noProxyList: 'localhost,127.0.0.1',
    });
    await hostMessage(page, {
        type: 'proxyDetectResult',
        candidates: [{
            service: 'Clash Verge Rev', url: 'http://127.0.0.1:7897',
            ports: [
                { port: 7897, protocol: 'mixed', url: 'http://127.0.0.1:7897', usable: true },
                { port: 7898, protocol: 'socks5', url: 'socks5://127.0.0.1:7898', usable: false },
            ],
        }],
    });
    await page.locator('button.settings-nav-row').last().click();
    await page.waitForSelector('.proxy-field-row');

    // 1. Header test icon is the plug-style connection icon, not a bolt.
    const iconClass = await page.locator('header .icon-btn svg').getAttribute('class');
    console.log('HEADER ICON', iconClass);
    expect(iconClass).toContain('lucide-plug-zap');

    // 2. Typography matches the other pages' scales.
    const sizes = await page.evaluate(() => {
        const fs = (sel: string) => getComputedStyle(document.querySelector(sel)!).fontSize;
        return {
            clientName: fs('.proxy-candidate-main strong'),
            label: fs('.proxy-field-label'),
            input: fs('#proxy-host'),
            dropdown: fs('.proxy-field .dropdown-trigger'),
            hint: fs('.proxy-hint'),
        };
    });
    console.log('SIZES', JSON.stringify(sizes));
    expect(sizes.clientName).toBe('14px');
    expect(sizes.label).toBe('12.5px');
    expect(sizes.input).toBe('13px');
    expect(sizes.dropdown).toBe('13px');
    expect(sizes.hint).toBe('12px');

    // 3. Scheme uses the shared dropdown, no native select.
    await expect(page.locator('.proxy-field .dropdown-trigger')).toHaveCount(1);
    await expect(page.locator('.proxy-field select')).toHaveCount(0);

    // 4. Save check appears only after a click (and the host echo settles it).
    const btn = page.locator('.proxy-save-row .apply-btn');
    await expect(btn.locator('svg')).toHaveCount(0);
    await page.locator('#proxy-port').fill('7899');
    await btn.click();
    // The host answers with the persisted settings - that settles the draft.
    await hostMessage(page, {
        type: 'proxyState', mode: 'auto', proxyUrl: 'http://127.0.0.1:7899', noProxy: 'localhost,127.0.0.1',
        resolvedUrl: 'http://127.0.0.1:7899', resolvedSource: 'setting',
        systemProxy: 'http://127.0.0.1:7897', noProxyList: 'localhost,127.0.0.1',
    });
    await expect(btn.locator('svg')).toHaveCount(1);
    // ...and drops again when something new is drafted.
    await page.locator('#proxy-port').fill('7900');
    await expect(btn.locator('svg')).toHaveCount(0);

    // 5. Bottom tip is the other pages' foot-note pattern.
    const tip = page.locator('.mcp-hint.foot');
    await expect(tip).toContainText('The proxy applies to every outbound request');
    await expect(tip.locator('svg')).toHaveCount(1);
});

// --- entry-path state loading (regression): every page must request its own
// data on entry - navigating via Settings must not depend on a prior toolbar
// visit anywhere else in the app. ------------------------------------------

test('entering the proxy page from settings requests its state and the MCP list', async ({ page }) => {
    await openProxy(page);
    const sent = await page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__xratuHostMessages as Array<{ type?: string }>);
    expect(sent.some((m) => m.type === 'proxyGetState')).toBe(true);
    // The page lists MCP servers - their state must be requested here too.
    expect(sent.some((m) => m.type === 'mcpGetState')).toBe(true);
    // The local proxy scan runs on mount - no manual rescan per visit.
    expect(sent.some((m) => m.type === 'proxyDetect')).toBe(true);
});

test('entering credentials from settings requests the saved providers', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
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
    await hostMessage(page, { type: 'openSettings' });
    await page.waitForSelector('.settings-page');
    await page.locator('.settings-nav-row', { hasText: /API keys/i }).click();
    const sent = await page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__xratuHostMessages as Array<{ type?: string }>);
    // openCredentials makes the host push the saved provider list.
    expect(sent.some((m) => m.type === 'openCredentials')).toBe(true);
});

test('entering capabilities from settings requests MCP + skills state', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 860 });
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
    await hostMessage(page, { type: 'openSettings' });
    await page.waitForSelector('.settings-page');
    await page.locator('.settings-nav-row', { hasText: /^Servers & Skills/ }).click();
    const sent = await page.evaluate(() =>
        (window as unknown as Record<string, unknown>).__xratuHostMessages as Array<{ type?: string }>);
    expect(sent.some((m) => m.type === 'mcpGetState')).toBe(true);
    expect(sent.some((m) => m.type === 'skillsGetState')).toBe(true);
});

test('header actions sit at the far end (justify-between)', async ({ page }) => {
    await openProxy(page);
    const geometry = await page.evaluate(() => {
        const head = document.querySelector('.settings-head')!.getBoundingClientRect();
        const icon = document.querySelector('header .icon-btn')!.getBoundingClientRect();
        const back = document.querySelector('.settings-head .ghost-btn')!.getBoundingClientRect();
        return {
            headLeft: head.left,
            headRight: head.right,
            headMid: head.left + head.width / 2,
            iconLeft: icon.left,
            iconRight: icon.right,
            backLeft: back.left,
        };
    });
    // Back button at the start, action icon hugging the far end edge.
    expect(geometry.headLeft - geometry.backLeft).toBeLessThan(24);
    expect(geometry.headRight - geometry.iconRight).toBeLessThan(24);
    expect(geometry.iconLeft).toBeGreaterThan(geometry.headMid);
});

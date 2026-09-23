/**
 * MCP marketplace tab - browser smoke tests for the built bundle.
 *
 * Same harness as app.spec.ts: a mocked `acquireVsCodeApi` records what the
 * webview sends, and host→webview envelopes are posted at the window. This
 * covers the parts a unit test cannot: that the tab renders real rows, that
 * search round-trips through the host, and that NOTHING is written to
 * mcp.json before the confirm step (a remote catalog is untrusted input).
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const ENTRIES = [
    {
        id: 'curated:ddg-search',
        source: 'curated',
        serverName: 'ddg-search',
        name: 'ddg-search',
        nameKey: 'mcpRegDdgName',
        descKey: 'mcpRegDdgDesc',
        description: '',
        tags: [],
        install: { kind: 'stdio', command: 'uvx', args: ['duckduckgo-mcp-server==0.7.0'], runtime: 'python' },
        installConfidence: 'curated',
    },
    {
        id: 'cline:airtable',
        source: 'cline',
        serverName: 'airtable',
        name: 'Airtable',
        tagline: 'Manage data in Airtable bases',
        description: 'Airtable MCP integration.',
        author: 'Airtable',
        tags: ['data'],
        verified: true,
        requiresApiKey: true,
        repoUrl: 'https://github.com/Airtable/airtable-mcp-cli',
        install: {
            kind: 'remote',
            type: 'streamableHttp',
            url: 'https://mcp.airtable.com/mcp',
            envVars: [{ name: 'AIRTABLE_TOKEN', required: true, url: 'https://airtable.com/create/tokens' }],
        },
        installConfidence: 'registry',
    },
    {
        id: 'official:nuget-only',
        source: 'official',
        serverName: 'nuget-only',
        name: 'Nuget Only',
        description: 'container runtime we cannot run',
        tags: [],
        repoUrl: 'https://github.com/example/nuget-mcp',
        install: null,
        installConfidence: 'none',
    },
];

const MARKET_STATE = {
    type: 'mcpMarketplaceState',
    query: '',
    entries: ENTRIES,
    sources: ['https://cline.github.io/marketplace/catalog.json'],
    status: 'live',
    fetchedAt: Date.now(),
    error: null,
    liveSearch: false,
};

test.beforeEach(async ({ page }) => {
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

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

async function sentMessages(page: Page): Promise<Array<Record<string, unknown>>> {
    return page.evaluate(() => (window as Record<string, unknown>).__xratuHostMessages as Array<Record<string, unknown>>);
}

/** Open the capabilities page and land on the marketplace tab. */
async function openMarketplace(page: Page): Promise<void> {
    await installVscodeTheme(page);
    await page.goto('/');
    await hostMessage(page, { type: 'showChat' });
    await page.getByTitle('سرور ها و مهارت ها').click();
    await hostMessage(page, { type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false });
    await hostMessage(page, { type: 'skillsState', skills: [] });
    await page.getByRole('tab', { name: 'فروشگاه' }).click();
    // The tab requests the catalog on first open.
    await expect.poll(async () => (await sentMessages(page)).some((m) => m.type === 'mcpMarketplaceGetState')).toBe(true);
    await hostMessage(page, MARKET_STATE);
    // Posting a host message does NOT wait for React to re-render, and several
    // tests probe the DOM immediately after this helper returns. Settle the
    // first row here (auto-retrying, no sleep) or those probes race the render
    // - seen as a flake only under the parallel run, where a second worker
    // competes for CPU and the commit lands later.
    await expect(page.locator('.mp-row').first()).toBeVisible();
}

test('marketplace tab renders catalog rows with their exact command', async ({ page }) => {
    await openMarketplace(page);
    await expect(page.locator('.mp-row')).toHaveCount(3);
    // The command/URL is shown BEFORE anything is added.
    await expect(page.locator('.mp-cmd').first()).toContainText('uvx duckduckgo-mcp-server==0.7.0');
    // Curated entries keep their i18n name; badges mark verified/needs-key rows.
    await expect(page.locator('.mp-row').first()).toContainText('DuckDuckGo Search');
    await expect(page.locator('.mcp-badge.verified')).toHaveCount(1);
    await expect(page.locator('.mcp-badge.warn')).toHaveCount(1);
    // The row that cannot be installed offers detection + manual add instead.
    await expect(page.getByText('افزودن دستی')).toHaveCount(1);
    await expect(page.getByText('تشخیص از README')).toHaveCount(1);
});

test('marketplace rows stay LTR inside the RTL page', async ({ page }) => {
    await openMarketplace(page);
    const probe = await page.evaluate(() => {
        const row = document.querySelector('.mp-row') as HTMLElement;
        const input = document.querySelector('.mp-search input') as HTMLElement;
        const badge = document.querySelector('.mcp-badge.verified') as HTMLElement;
        const page = document.querySelector('.settings-page') as HTMLElement;
        return {
            pageDir: getComputedStyle(document.querySelector('.app') as HTMLElement).direction,
            rowDir: getComputedStyle(row).direction,
            inputDir: input.getAttribute('dir'),
            badgeBg: getComputedStyle(badge).backgroundColor,
            overflow: page.scrollWidth - page.clientWidth,
        };
    });
    expect(probe.pageDir).toBe('rtl');
    expect(probe.rowDir).toBe('ltr');
    // The search box follows the UI language, not the row convention: its
    // placeholder is Persian, so an LTR box rendered the ellipsis backwards.
    expect(probe.inputDir).toBe('rtl');
    // Transparent would mean the theme fixture failed to install.
    expect(probe.badgeBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(probe.overflow).toBeLessThanOrEqual(1);
});

test('adding a row needs a confirm step and writes the parsed install', async ({ page }) => {
    await openMarketplace(page);
    await page.locator('.mp-row').first().getByText('افزودن').click();
    // The confirm panel shows the exact JSON payload first.
    const confirm = page.locator('.mp-confirm-json');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('"command": "uvx"');
    expect((await sentMessages(page)).some((m) => m.type === 'mcpSave')).toBe(false);

    await page.getByText('تایید و افزودن').click();
    const save = (await sentMessages(page)).find((m) => m.type === 'mcpSave') as {
        target: string;
        servers: Array<Record<string, unknown>>;
    };
    expect(save.target).toBe('global');
    expect(save.servers).toHaveLength(1);
    expect(save.servers[0]).toMatchObject({ name: 'ddg-search', command: 'uvx', args: ['duckduckgo-mcp-server==0.7.0'] });
    // A catalog must never pre-approve tools.
    expect(save.servers[0].autoApprove).toBeUndefined();
});

test('a row needing a secret opens the editor instead of writing config', async ({ page }) => {
    await openMarketplace(page);
    const airtable = page.locator('.mp-row').filter({ hasText: 'Airtable' });
    await airtable.getByText('افزودن').click();
    await expect(page.locator('.mp-confirm-json')).toContainText('https://mcp.airtable.com/mcp');
    await page.getByText('افزودن و ویرایش').click();
    // Prefilled edit form, nothing saved yet.
    await expect(page.locator('.mcp-form')).toBeVisible();
    await expect(page.locator('.mcp-form input[dir="ltr"]').first()).toHaveValue('airtable');
    expect((await sentMessages(page)).some((m) => m.type === 'mcpSave')).toBe(false);
});

test('search round-trips to the host and can be cleared', async ({ page }) => {
    await openMarketplace(page);
    await page.locator('.mp-search input').fill('airtable');
    await expect.poll(async () => (await sentMessages(page)).some((m) => m.type === 'mcpMarketplaceGetState' && m.query === 'airtable')).toBe(true);
    await hostMessage(page, { ...MARKET_STATE, query: 'airtable', entries: [ENTRIES[1]], liveSearch: true });
    await expect(page.locator('.mp-row')).toHaveCount(1);
    await expect(page.locator('.mp-status')).toContainText('جستجوی زنده');

    await page.locator('.mp-search button').click();
    await expect.poll(async () => (await sentMessages(page)).some((m) => m.type === 'mcpMarketplaceGetState' && m.query === '')).toBe(true);
    await hostMessage(page, MARKET_STATE);
    await expect(page.locator('.mp-row')).toHaveCount(3);
});

test('an offline catalog still lists the curated fallback and says so', async ({ page }) => {
    await openMarketplace(page);
    await hostMessage(page, {
        ...MARKET_STATE,
        status: 'offline',
        error: 'https://cline.github.io/marketplace/catalog.json: timed out',
        entries: [ENTRIES[0]],
    });
    await expect(page.locator('.mp-status')).toContainText('آفلاین');
    await expect(page.locator('.mcp-hint.warn')).toContainText('timed out');
    await expect(page.locator('.mp-row')).toHaveCount(1);

    // Screenshot artifact for review (fa, sidebar width).
    await page.setViewportSize({ width: 420, height: 900 });
    await page.screenshot({ path: '/tmp/marketplace-fa-offline.png', fullPage: true });
});

test('README detection result opens the editor with the guessed command', async ({ page }) => {
    await openMarketplace(page);
    const row = page.locator('.mp-row').filter({ hasText: 'Nuget Only' });
    await row.getByText('تشخیص از README').click();
    await expect.poll(async () => (await sentMessages(page)).some((m) => m.type === 'mcpMarketplaceDetect')).toBe(true);
    await hostMessage(page, {
        type: 'mcpMarketplaceDetected',
        id: 'official:nuget-only',
        install: { kind: 'stdio', command: 'npx', args: ['-y', 'nuget-mcp'], runtime: 'node' },
        confidence: 'detected',
    });
    await expect(page.locator('.mcp-form')).toBeVisible();
    await expect(page.locator('.mcp-hint.warn')).toContainText('حدس زده شده');
});

test('a large catalog mounts only a window of rows and can reveal more', async ({ page }) => {
    // A full catalog is ~500 rows / 10k+ DOM nodes, and the unmount cost was
    // what made leaving the page feel laggy (measured: 115-126ms against 30ms
    // with a small list). Only MARKET_PAGE rows may be mounted at once.
    const many = Array.from({ length: 130 }, (_, i) => ({
        id: `official:srv-${i}`,
        source: 'official',
        serverName: `srv-${i}`,
        name: `Server ${i}`,
        description: 'generated fixture',
        tags: [],
        install: { kind: 'stdio', command: 'npx', args: ['-y', `pkg-${i}`], runtime: 'node' },
        installConfidence: 'registry',
    }));
    await openMarketplace(page);
    await hostMessage(page, { ...MARKET_STATE, entries: many });

    await expect(page.locator('.mp-row')).toHaveCount(60);
    // The count reports the whole match set, not the mounted window.
    await expect(page.locator('.mp-status')).toContainText('130 سرور');
    await expect(page.locator('.mp-more')).toContainText('70 سرور دیگر');

    await page.locator('.mp-more').click();
    await expect(page.locator('.mp-row')).toHaveCount(120);
    await page.locator('.mp-more').click();
    await expect(page.locator('.mp-row')).toHaveCount(130);
    await expect(page.locator('.mp-more')).toHaveCount(0);

    // Changing a filter starts a fresh window instead of inheriting the
    // expansion (client-side filter: no host round trip involved).
    await page.getByRole('button', { name: 'رسمی' }).click();
    await expect(page.locator('.mp-row')).toHaveCount(60);
});

test('row subtitles are LTR for every row, Persian copy included', async ({ page }) => {
    await openMarketplace(page);
    const dirs = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.mp-row')];
        return rows.map((r) => {
            const sub = r.querySelector('.mcp-row-meta');
            return { name: r.querySelector('strong')?.textContent, dir: sub ? getComputedStyle(sub).direction : null };
        });
    });
    // Rows are LTR by design, so every subtitle lines up with the name above it
    // and the command below it. The bundled Persian descriptions used to
    // re-align themselves to the right edge while the rest of the row sat left.
    expect(dirs.find((d) => d.name === 'Airtable')?.dir).toBe('ltr');
    expect(dirs.find((d) => d.name === 'DuckDuckGo Search')?.dir).toBe('ltr');
});

test('source and tag filters render as two separate groups', async ({ page }) => {
    await openMarketplace(page);
    // They answer different questions - WHICH catalog, and WHAT KIND of server -
    // so they must not share one undifferentiated chip line.
    const sources = page.getByRole('group', { name: 'منبع' });
    const tags = page.getByRole('group', { name: 'برچسب ها' });
    await expect(sources).toBeVisible();
    await expect(tags).toBeVisible();
    // No visible captions - the chip sets are self-evident, and the meaning
    // lives in the group aria-labels (which the role lookups above use).
    await expect(page.locator('.mp-filter-label')).toHaveCount(0);

    await expect(sources.getByRole('button', { name: 'همه' })).toBeVisible();
    // Tag chips are LOCALIZED in fa: the id stays the filter key, the label is
    // ours (the raw ids used to render as "data" / "software").
    await expect(tags.getByRole('button', { name: 'داده و تحلیل' })).toBeVisible();
    // Each chip belongs to exactly one group.
    await expect(tags.getByRole('button', { name: 'همه' })).toHaveCount(0);
    await expect(sources.getByRole('button', { name: 'داده و تحلیل' })).toHaveCount(0);

    // The localized label still filters by the ID: only the Airtable fixture
    // carries the "data" tag.
    await tags.getByRole('button', { name: 'داده و تحلیل' }).click();
    await expect(page.locator('.mp-row')).toHaveCount(1);
    await expect(page.locator('.mp-row')).toContainText('Airtable');

    // Stacked, not sharing a line.
    const a = await sources.boundingBox();
    const b = await tags.boundingBox();
    expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
});

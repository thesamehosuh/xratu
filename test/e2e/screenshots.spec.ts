/**
 * Two suites in one file, because both are "drive the built bundle and LOOK at
 * it" - only the verdict differs.
 *
 * 1. "background process UI" (MANUAL, opt-in) - the original harness. It writes
 *    PNGs of the states a reviewer needs to see into test/e2e/screenshots/ (which
 *    is gitignored on purpose: a PNG nobody reads is noise, not evidence) and
 *    asserts nothing:
 *
 *      npm run build:webview
 *      XRATU_SCREENSHOTS=1 npx playwright test -c test/e2e/playwright.config.ts screenshots.spec.ts
 *
 * 2. "theme contract" (THE CI GATE, default) - the automated form of AGENTS.md's
 *    "screenshot the real UI before/after visual work" ritual, but asserting
 *    COMPUTED STYLES rather than pixels. `webview-ui/src/styles/theme.css` is
 *    the second most-edited file in this repo and had zero automated coverage,
 *    so a colour or RTL regression could ship on a green build.
 *
 *    WHY NOT COMMITTED PNG BASELINES: they were tried first and every one of
 *    the 32 failed on the ubuntu runner. A screenshot baseline is only
 *    comparable against the exact image that produced it - Latin text resolves
 *    to `system-ui`, which is a DIFFERENT FONT on a dev laptop and on
 *    github's runner, and `platform === 'linux'` is not a fix because Linux
 *    distros differ from each other too. Tolerating the delta with a pixel
 *    threshold does not work either: a real accent-colour change moves well
 *    under the threshold needed to absorb the font difference, so the gate
 *    would go green exactly when it mattered.
 *
 *    Colors, direction and layout ARE machine-independent, so that is what is
 *    pinned here: brand token values, the locale-driven root direction,
 *    non-transparent surfaces, and the subject fitting its viewport.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
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

/* ===========================================================================
 * Theme contract - the automated form of AGENTS.md's
 * "screenshot the real UI before/after visual work" ritual.
 * ========================================================================= */

type Locale = 'fa' | 'en';
const LOCALES: readonly Locale[] = ['fa', 'en'];

/** SIDEBAR width is where the product actually lives; 900px is the "wide panel"
 *  shape. Both, because a layout that fits 900 can still break at 420 and RTL
 *  breaks differently from LTR (AGENTS.md, step 4). */
const WIDTHS = [['sidebar', 420], ['wide', 900]] as const;

/** ONE height for the whole matrix: a baseline is only comparable with another
 *  of the same size, and a taller viewport just adds empty shell. */
const BASELINE_HEIGHT = 900;

/**
 * Settings-row labels, per locale. Mirrors webview-ui/src/i18n.ts:
 * `settingsCredentials`, `capTitle`, `settingsUsage`, `settingsProxy`.
 * A renamed key makes the locator match nothing and the test FAIL - it can
 * never quietly screenshot the wrong page.
 */


/* --- fixtures -------------------------------------------------------------
 * Every value here is FIXED. Anything derived from the wall clock (a relative
 * "2 hours ago", a "this month" axis built from `new Date()`) would bake the day
 * the baseline was generated into a committed PNG. */

const LOCAL_RUNTIMES = [
    {
        id: 'ollama',
        runtime: 'ollama',
        name: 'Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelCount: 6,
        models: ['qwen3-coder:30b', 'gpt-oss:20b'],
        supportsTools: true,
        supportsVision: false,
    },
    {
        id: 'lmstudio',
        runtime: 'lmstudio',
        name: 'LM Studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        modelCount: 3,
        models: ['qwen2.5-coder-7b'],
        supportsTools: true,
        supportsVision: true,
    },
];

const SAVED_CREDENTIALS = [
    {
        id: 'cred-1',
        providerId: 'openai-compatible',
        baseUrl: 'https://openode.ai/v1',
        maskedKey: 'sk-****4f2a',
        label: 'OpenCode Go',
        active: true,
    },
    {
        id: 'cred-2',
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        maskedKey: '',
        label: 'Ollama (local)',
        active: false,
    },
];

const MCP_SERVERS = [
    {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/dev/projects'],
        state: 'connected',
        toolCount: 11,
        lastError: null,
        source: 'workspace',
    },
    {
        name: 'github',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '${input:github_token}' },
        state: 'error',
        toolCount: null,
        lastError: 'spawn ENOENT',
        source: 'global',
    },
];

const SKILLS = [
    {
        id: 'project-xratu:webapp-testing',
        name: 'webapp-testing',
        description: 'Drive the local web app with Playwright and capture screenshots.',
        dirPath: '.claude/skills/webapp-testing',
        source: 'project-xratu',
        error: null,
        enabled: true,
    },
    {
        id: 'global-claude:iran-dev-access',
        name: 'iran-dev-access',
        description: 'Which developer services actually work from Iran.',
        dirPath: '~/.claude/skills/iran-dev-access',
        source: 'global-claude',
        error: null,
        enabled: false,
    },
];

/** Two months of ledger so the usage chart has a stepper to step. */
const USAGE_STATE = {
    providers: [
        { host: 'a.ir', label: 'Avalai', iranian: true, input: 650, output: 65, cached: 0, USD: 6.5, IRT: 14000 },
        { host: 'b.ir', label: 'Metis', iranian: true, input: 400, output: 40, cached: 12, USD: 0, IRT: 95000 },
    ],
    rates: [
        { id: 'gpt-4o', host: '', input: 1, output: 2, cachedInput: null, currency: 'IRT', source: 'override', USD: 0, IRT: 14000 },
        { id: 'glm-5.3', host: 'a.ir', input: 0.15, output: 0.5, cachedInput: 0.03, currency: 'USD', source: 'builtin', USD: 0.5, IRT: 0 },
        { id: 'glm-5.3', host: 'b.ir', input: 0.3, output: 1, cachedInput: 0.03, currency: 'USD', source: 'gateway', USD: 1.2, IRT: 0 },
        { id: 'mystery-local', host: 'a.ir', input: 0, output: 0, cachedInput: null, currency: 'USD', source: 'unknown', USD: 0, IRT: 0 },
    ],
    history: [
        { day: '2026-07-10', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 100, output: 10, cached: 0, USD: 1, IRT: 5000 }] },
        {
            day: '2026-07-11',
            cells: [
                { model: 'gpt-4o', host: 'a.ir', input: 200, output: 20, cached: 0, USD: 2, IRT: 0 },
                { model: 'glm-5.3', host: 'a.ir', input: 50, output: 5, cached: 0, USD: 0.5, IRT: 700 },
            ],
        },
        { day: '2026-08-05', cells: [{ model: 'gpt-4o', host: 'a.ir', input: 300, output: 30, cached: 0, USD: 0, IRT: 9000 }] },
    ],
    allTime: { input: 1050, output: 105, cached: 12, USD: 6.5, IRT: 109000 },
};

const PROXY_STATE = {
    mode: 'auto',
    proxyUrl: 'http://127.0.0.1:7890',
    noProxy: 'localhost,127.0.0.1',
    resolvedUrl: 'http://127.0.0.1:7890',
    resolvedSource: 'env',
    systemProxy: 'http://127.0.0.1:7890',
    noProxyList: 'localhost\n127.0.0.1',
};

const PATCH = [
    '<<<<<<< SEARCH',
    'export async function signIn(user: User) {',
    '    const token = localStorage.getItem("token");',
    '    if (!token) return null;',
    '    return verify(token);',
    '}',
    '=======',
    'export async function signIn(user: User) {',
    '    const token = await session.readRefreshToken();',
    '    if (!token) throw new AuthError("session expired");',
    '    return verify(token);',
    '}',
    '>>>>>>> REPLACE',
].join('\n');

/** Shell state every screen shares: the toolbar's connection dot, the model
 *  chip and the session title, so those are in every baseline too. */
async function shell(page: Page, locale: Locale): Promise<void> {
    await host(page, { type: 'locale', locale });
    await host(page, { type: 'connectionStatus', status: 'connected', details: { version: '1.4.2' } });
    await host(page, {
        type: 'modelInfo',
        defaultModel: 'gpt-4o',
        models: ['gpt-4o', 'glm-5.3'],
        selectedModel: 'gpt-4o',
        contextWindows: { 'gpt-4o': 128000, 'glm-5.3': 202752 },
        capabilities: { 'gpt-4o': { vision: true }, 'glm-5.3': { reasoning: true } },
    });
    await host(page, {
        type: 'sessionState',
        id: 's-baseline',
        title: locale === 'fa' ? 'بازطراحی صفحه تنظیمات' : 'Redesign the settings page',
    });
}

/* --- determinism ----------------------------------------------------------
 * A screenshot baseline is only a signal if the SAME pixels come out every run.
 * Four things in this page are otherwise non-deterministic; all four are
 * pinned here, and each pin is asserted rather than hoped for. */

/**
 * Wall-clock freeze. EVERY bubble is stamped with
 * `formatMessageTimestamp(message.createdAt)` ("04:47 PM" / "\u06f1\u06f6:\u06f4\u06f8"), so an
 * unfrozen clock makes every chat baseline a lottery on the minute it was
 * generated - and the stamp renders in LOCAL time, which is why the suite also
 * pins `timezoneId: 'UTC'`: 12:00 UTC is 15:30 in Tehran.
 *
 * Only `Date` is overridden, never the timers. `page.clock.install()` would fake
 * setTimeout and requestAnimationFrame too, and this UI depends on real ones -
 * the ~1s local-scan spinner floor, React's scheduler and the ResizeObserver
 * pin that keeps the transcript at its tail all stop working (or deadlock)
 * under a frozen timer queue.
 */
const FROZEN_EPOCH_MS = Date.UTC(2026, 2, 14, 12, 0, 0);

async function freezeClock(page: Page): Promise<void> {
    await page.addInitScript(({ fixed }) => {
        const Real = Date;
        window.Date = class extends Real {
            constructor(...args: unknown[]) {
                super(...(args.length === 0 ? [fixed] : args) as [number]);
            }
            static override now(): number { return fixed; }
        } as unknown as DateConstructor;
    }, { fixed: FROZEN_EPOCH_MS });
}

/**
 * Vazirmatn is declared `font-display: swap`, so the first paint of any Persian
 * string uses an OS fallback face. That difference is easy to miss in review.
 * Forcing the bundled webfont to load and ASSERTING it resolved means a
 * silently swapped typeface fails the run.
 *
 * The Latin side is deliberately NOT pinned (it resolves to `system-ui`), which
 * is exactly why this suite asserts styles rather than pixels - a pixel
 * comparison would depend on a font this repo does not ship.
 */
async function freezeFonts(page: Page): Promise<void> {
    const loaded = await page.evaluate(async () => {
        await document.fonts.load('400 14px Vazirmatn', 'سلام');
        await document.fonts.ready;
        return document.fonts.status === 'loaded' && document.fonts.check('400 14px Vazirmatn', 'سلام');
    });
    expect(loaded, 'the bundled Vazirmatn webfont must be resolved before the contract is checked').toBe(true);
}

/** Shiki highlighting is async (`useHighlightedCode`). A render captured
 *  before it lands stores the plain-text variant and is then unreviewable. */
async function expectHighlighted(page: Page, selector: string): Promise<void> {
    await expect(page.locator(`${selector} span[style*="color"]`).first()).toBeAttached({ timeout: 20_000 });
}

/** Local discovery is kicked off on mount and holds its spinner for a ~1s
 *  floor, so answer with a fixed list and wait the spinner OUT - a frame caught
 *  mid-scan is the classic flaky baseline. */
async function settleLocalScan(page: Page): Promise<void> {
    await host(page, { type: 'localModelsDiscovered', runtimes: LOCAL_RUNTIMES });
    await expect(page.locator('.spinning, .spinner')).toHaveCount(0);
}

/* --- screens --------------------------------------------------------------
 * One driver per screen; each returns the locator of the thing under
 * inspection (what to settle and scroll into view). */

async function welcomeScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'showWelcome' });
    const view = page.locator('.welcome');
    await expect(view).toBeVisible();
    await settleLocalScan(page);
    await expect(page.locator('.welcome-runtime')).toHaveCount(LOCAL_RUNTIMES.length);
    return view;
}

async function chatScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await host(page, {
        type: 'gitStatusState',
        root: '~/Projects/xratu',
        status: { isRepo: true, branch: 'feat/visual-baselines', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, staged: 1, modified: 3, untracked: 2, conflicted: 0 },
    });
    await host(page, { type: 'restoreUser', value: locale === 'fa' ? 'احراز هویت نشست را اضافه کن و تستش را بنویس' : 'Add session auth and write its test' });
    await host(page, { type: 'startResponse' });
    await host(page, { type: 'chunk', value: locale === 'fa' ? 'مسیر نشست را باز می کنم و توکن را از رفرش می گیرم.' : 'Opening the session helper and reading the refresh token.' });
    // An edit pill renders its diff OPEN by default (transcriptPrefs defaults),
    // so this one turn covers the user capsule, the assistant turn, the tool
    // pill AND the inline diff - the densest screen in the product.
    await host(page, { type: 'toolCall', tool: 'apply_patch', args: JSON.stringify({ path: 'src/auth/session.ts', patch: PATCH }), callId: 'c-patch' });
    await host(page, { type: 'toolResult', tool: 'apply_patch', callId: 'c-patch', output: 'Patch applied cleanly to src/auth/session.ts' });
    await host(page, {
        type: 'fullResponse',
        renderedHtml: locale === 'fa'
            ? '<p>توکن از رفرش خوانده می شود و خطای <strong>AuthError</strong> برگردانده می شود.</p><pre><code>const token = await session.readRefreshToken();</code></pre>'
            : '<p>The token now comes from the refresh path and throws <strong>AuthError</strong>.</p><pre><code>const token = await session.readRefreshToken();</code></pre>',
        usage: { input_tokens: 18400, output_tokens: 620, cached_tokens: 12000, cost: { amount: 0.0046, currency: 'USD' } },
        contextWindow: 128000,
    });
    await host(page, { type: 'sessionCost', cost: { amount: 0.0046, currency: 'USD' } });
    await page.locator('.surface-tabs').getByRole('tab', { name: locale === 'fa' ? 'فعالیت' : 'Activity', exact: true }).click();
    const diff = page.locator('.pill-diff').first();
    await expect(diff).toBeVisible();
    await expectHighlighted(page, '.pill-diff-code');
    // Pin the transcript to its tail explicitly: the app follows the stream,
    // but a follow that loses a race would silently change every chat baseline.
    await page.locator('.activity-pane').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.session-cost')).toBeVisible();
    return diff;
}

async function approvalScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await host(page, { type: 'restoreUser', value: locale === 'fa' ? 'احراز هویت رو اضافه کن و تست هاش رو بنویس' : 'Add auth to the session helper and write its tests' });
    await host(page, { type: 'startResponse' });
    await host(page, { type: 'chunk', value: locale === 'fa' ? 'دارم مسیر احراز هویت رو اضافه می کنم.' : 'Adding the auth path now.' });
    await host(page, {
        type: 'needsApproval',
        approval_id: 'ap-baseline',
        approvals: [
            { tool_call_id: 'a1', tool_name: 'edit_file', args: { path: 'src/auth/session.ts' }, diff: { file: 'src/auth/session.ts', added: 3, removed: 2, lines: ['@@ -12,7 +12,8 @@ export function signIn(user: User) {', '   const token = localStorage.getItem("token");', '-  if (!token) return null;', '+  const token = await session.readRefreshToken();', '+  if (!token) throw new AuthError("session expired");', ' }'] } },
            { tool_call_id: 'a2', tool_name: 'run_terminal_command', args: { command: 'npm run test:host' } },
        ],
    });
    const card = page.locator('.approval-card').last();
    await expect(card).toBeVisible();
    // The ledger rows are collapsed on arrival; the diff table - the densest
    // theme surface in this card (gitDecoration add/del, gutters, shiki spans) -
    // only exists once a row is open, so open the first one.
    await card.locator('.approval-item summary').first().click();
    await expect(card.locator('.approval-diff')).toBeVisible();
    await expectHighlighted(page, '.approval-diff');
    await page.locator('.messages').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    return card;
}

async function credentialsScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await host(page, { type: 'savedCredentials', credentials: SAVED_CREDENTIALS });
    await host(page, { type: 'openCredentials' });
    const view = page.locator('.cred-card').first();
    await expect(view).toBeVisible();
    await settleLocalScan(page);
    await expect(page.locator('.cred-local-runtime')).toHaveCount(LOCAL_RUNTIMES.length);
    return page.locator('.page-layout');
}

async function settingsScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await host(page, { type: 'openSettings' });
    const view = page.locator('.settings-page').first();
    await expect(view).toBeVisible();
    // Three transcript switches = the page really mounted its cards (the same
    // signal app.spec.ts uses), not just an empty scroll shell.
    const activity = page.locator('.settings-card').filter({ has: page.getByRole('heading', {
        name: locale === 'fa' ? 'باز شدن خودکار' : 'Auto-expand', exact: true,
    }) });
    await expect(activity.getByRole('switch')).toHaveCount(3);
    return view;
}

/** Settings is the ONLY entry path to the capabilities / usage / proxy pages -
 *  the host has no `openUsage` envelope, so the nav row must really be clicked
 *  (a text selector, not a row index: the row order is not a contract). */
async function openSettingsSubpage(page: Page, locale: Locale, row: 'capabilities' | 'usage' | 'proxy'): Promise<void> {
    await host(page, { type: 'showChat' });
    await expect(page.locator('.composer-input')).toBeVisible();
    await host(page, { type: 'openSettings' });
    await expect(page.locator('.settings-page').first()).toBeVisible();
    const target = page.locator('.page-sidebar .sidebar-item').nth(row === 'capabilities' ? 1 : row === 'usage' ? 5 : 6);
    await expect(target).toHaveCount(1);
    await target.click();
}

async function capabilitiesScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'mcpState', servers: MCP_SERVERS, hasWorkspace: true, legacyInUse: false });
    await host(page, { type: 'skillsState', skills: SKILLS });
    await openSettingsSubpage(page, locale, 'capabilities');
    const view = page.locator('.settings-page').first();
    await expect(view).toBeVisible();
    await expect(page.locator('.mcp-tabs [role="tab"]')).toHaveCount(3);
    await expect(page.locator('.mcp-row')).toHaveCount(MCP_SERVERS.length);
    return view;
}

async function usageScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'usageState', ...USAGE_STATE });
    await openSettingsSubpage(page, locale, 'usage');
    const view = page.locator('.usage-page');
    await expect(view).toBeVisible();
    // The chart's month axis is built from the LEDGER, never from `new Date()`,
    // so 31 columns for the last (August) month is a fixed, reviewable state.
    await expect(page.locator('.cost-col')).toHaveCount(31);
    await expect(page.locator('.prov-row')).toHaveCount(2);
    return view;
}

async function proxyScreen(page: Page, locale: Locale): Promise<Locator> {
    await shell(page, locale);
    await host(page, { type: 'proxyState', ...PROXY_STATE });
    await host(page, { type: 'mcpState', servers: MCP_SERVERS, hasWorkspace: true, legacyInUse: false });
    await openSettingsSubpage(page, locale, 'proxy');
    const view = page.locator('.settings-page').first();
    await expect(view).toBeVisible();
    await expect(page.locator('.route-map')).toBeVisible();
    await page.getByRole('button', { name: locale === 'fa' ? 'سفارشی' : 'Custom', exact: true }).click();
    await expect(page.locator('.proxy-field-row').first()).toBeVisible();
    return view;
}

const SCREENS: { name: string; drive: (page: Page, locale: Locale) => Promise<Locator> }[] = [
    { name: 'welcome', drive: welcomeScreen },
    { name: 'chat', drive: chatScreen },
    { name: 'chat-approval', drive: approvalScreen },
    { name: 'credentials', drive: credentialsScreen },
    { name: 'settings', drive: settingsScreen },
    { name: 'capabilities', drive: capabilitiesScreen },
    { name: 'usage', drive: usageScreen },
    { name: 'proxy', drive: proxyScreen },
];

/**
 * Brand tokens are asserted BY VALUE on purpose.
 *
 * theme.css is the most-churned file in the repo, so a token edit has to be a
 * deliberate, reviewed diff: changing a line here is the cost of changing the
 * theme, and that is the point. The alternative - asserting only that a token
 * "is some colour" - would have passed while the accent was silently magenta.
 */
const BRAND_TOKENS: ReadonlyArray<readonly [string, string]> = [
    ['--xratu-accent', '#14e3c8'],
    ['--xratu-accent-strong', '#2af0d6'],
];

test.describe('theme contract', () => {
    test.describe.configure({ timeout: 60_000 });
    // `timezoneId` is a determinism pin, not a preference: bubble timestamps and
    // the usage axis render in LOCAL time, so a run in Tehran and a run in CI's
    // UTC must not disagree about what is on screen.
    test.use({ timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce' });

    for (const { name, drive } of SCREENS) {
        for (const locale of LOCALES) {
            for (const [widthLabel, width] of WIDTHS) {
                test(`${name} ${locale} ${widthLabel}`, async ({ page }) => {
                    await freezeClock(page);
                    // The standalone page has NO VS Code theme, so the real
                    // tokens go in FIRST - and before goto, or every surface
                    // renders transparent while still looking plausible.
                    await installVscodeTheme(page);
                    await page.setViewportSize({ width, height: BASELINE_HEIGHT });
                    await page.goto('/');
                    const subject = await drive(page, locale);
                    await expect(subject).toBeVisible();
                    await freezeFonts(page);

                    // R3: direction is locale-driven on the root, never
                    // hardcoded on an inner component.
                    await expect(page.locator('.app'), 'root direction follows the locale')
                        .toHaveAttribute('dir', locale === 'fa' ? 'rtl' : 'ltr');

                    for (const [token, expected] of BRAND_TOKENS) {
                        const actual = await page.evaluate(
                            (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
                            token,
                        );
                        expect(actual, `document token ${token}`).toBe(expected);
                    }

                    // Layout: the subject must fit its viewport horizontally.
                    // Pixel-independent, and the classic sidebar-width
                    // regression (a 900px-fixed panel breaking at 420px).
                    const box = await subject.boundingBox();
                    expect(box, 'the subject has a box').toBeTruthy();
                    if (box) {
                        expect(box.x, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(-1);
                        expect(box.x + box.width, `${name} ends inside the viewport`)
                            .toBeLessThanOrEqual(width + 1);
                    }
                });
            }
        }
    }
});

/* ===========================================================================
 * Manual review harness (opt-in, never a CI gate)
 * ========================================================================= */

test.describe('background process UI', () => {
    test.skip(!process.env.XRATU_SCREENSHOTS, 'set XRATU_SCREENSHOTS=1 to write review PNGs (npm run build:webview first)');

    const JOBS = [
        { jobId: 'job-1', command: 'npm run dev', running: true, uptimeSeconds: 142 },
        { jobId: 'job-2', command: 'npx tailwindcss --watch', running: true, uptimeSeconds: 37 },
    ];
    
    /** The shape that used to break the strip: a whole shell loop on one line.
     *  Chips sized themselves to this and pushed the strip past the panel edge, so
     *  every width/locale combination screenshots it. */
    const LONG_JOB = {
        jobId: 'job-3',
        command: 'for i in $(seq 1 15); do echo "tick $i at $(date +%H:%M:%S)"; sleep 2; done; echo "job finished cleanly"',
        running: true,
        uptimeSeconds: 4210,
    };
    
    
    /** The dock is folded by default - open it before shooting its rows. */
    async function openDock(page: Page): Promise<void> {
        await page.locator('.bg-jobs-toggle').click();
        await page.locator('.bg-job').first().waitFor();
    }
    
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
                await page.locator('.bg-jobs').waitFor();
                // Folded is the resting state a reviewer must see first.
                await page.screenshot({ path: join(OUT, `bg-folded-${locale}-${label}.png`) });
                await openDock(page);
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
                await openDock(page);
                await page.locator('.bg-job').nth(1).hover();
                await page.screenshot({ path: join(OUT, `bg-stop-${locale}-${label}.png`) });
            });
    
            test(`${locale} ${label}: long commands truncate inside the card`, async ({ page }) => {
                await page.setViewportSize({ width, height: 900 });
                await installVscodeTheme(page);
                await page.goto('/');
                await host(page, { type: 'locale', locale });
                await host(page, { type: 'showChat' });
                await host(page, { type: 'backgroundJobs', jobs: [LONG_JOB] });
                await page.locator('.bg-jobs').waitFor();
                await page.screenshot({ path: join(OUT, `bg-long-folded-${locale}-${label}.png`) });
                await host(page, { type: 'backgroundJobs', jobs: [LONG_JOB, ...JOBS] });
                await openDock(page);
                await page.locator('.bg-job').nth(2).hover();
                await page.screenshot({ path: join(OUT, `bg-long-${locale}-${label}.png`) });
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
    }});

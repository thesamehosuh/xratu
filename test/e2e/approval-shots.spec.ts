/**
 * Screenshot harness for the REAL approval card.
 *
 * Not a test: it drives the built bundle into the states a reviewer needs to
 * LOOK at and writes PNGs to test/e2e/screenshots/approval/. The static
 * prototypes that chose direction A live in approval-prototypes.spec.ts; this
 * suite is the proof that the shipped component matches what was approved.
 *
 *   npm run build:webview
 *   XRATU_SCREENSHOTS=1 npx playwright test -c test/e2e/playwright.config.ts approval-shots.spec.ts
 *
 * Every state, both locales, both widths, light AND dark: RTL reorders every
 * row in this block, and the light theme is where the old hardcoded diff
 * palette failed.
 */
import { test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(__dirname, 'screenshots', 'approval');

interface Item {
    tool_call_id: string;
    tool_name: string;
    args?: Record<string, unknown>;
    diff?: { file: string; added: number; removed: number; lines: string[] };
}

/* No `---`/`+++` file headers: the parser has guards for them, but they then
 * render as context rows numbered 0/1. The host's payload does not lead with
 * them, so neither does the fixture. */
const DIFF_LINES = [
    '@@ -12,7 +12,8 @@ export function signIn(user: User) {',
    '   const token = localStorage.getItem("token");',
    '-  if (!token) return null;',
    '-  return verify(token, process.env.JWT_SECRET);',
    '+  const token = await session.readRefreshToken();',
    '+  if (!token) throw new AuthError("session expired");',
    '+  return verify(token, process.env.JWT_SECRET);',
    ' }',
];

const CSS_LINES = [
    '@@ -40,3 +40,4 @@',
    ' .token {',
    '-  color: #f85149;',
    '+  color: var(--token-ink);',
    '+  font-variant-numeric: tabular-nums;',
    ' }',
];

const file = (id: string, f: string, added: number, removed: number, lines = DIFF_LINES): Item =>
    ({ tool_call_id: id, tool_name: 'edit_file', args: { path: f }, diff: { file: f, added, removed, lines } });
const cmd = (id: string, command: string): Item =>
    ({ tool_call_id: id, tool_name: 'run_terminal_command', args: { command } });

const LONG_PATH = 'webview-ui/src/components/settings/credentials/ProvidersSection.tsx';

const STATES: { key: string; note: string; approvals: Item[]; preDenied?: Record<string, boolean> }[] = [
    { key: 'hero', note: 'pending, multi-file, diffs', approvals: [file('c1', 'src/auth/session.ts', 3, 2), file('c2', 'webview-ui/src/styles/token.css', 2, 1, CSS_LINES)] },
    { key: 'command', note: 'pending, one terminal command', approvals: [cmd('c3', 'npm run build:webview && npx tsc --noEmit -p webview-ui/tsconfig.json')] },
    {
        key: 'args', note: 'pending, JSON args fallback',
        approvals: [{ tool_call_id: 'c4', tool_name: 'mcp__github__create_issue', args: { owner: 'xratu', repo: 'vscode-xratu', title: 'Approval card: flat ledger' } }],
    },
    {
        key: 'preDenied', note: 'a preDenied item mixed in',
        approvals: [file('c1', 'src/auth/session.ts', 3, 2), cmd('c5', 'rm -rf build')],
        preDenied: { c5: false },
    },
    {
        key: 'noneApprovable', note: 'nothing approvable',
        approvals: [cmd('c6', 'rm -rf build'), cmd('c7', 'git push --force origin main')],
        preDenied: { c6: false, c7: false },
    },
    { key: 'submitting', note: 'submitting', approvals: [file('c1', 'src/auth/session.ts', 3, 2)] },
    {
        key: 'expanded', note: 'a row expanded',
        approvals: [file('c1', 'src/auth/session.ts', 3, 2), cmd('c3', 'npm run build:webview')],
    },
    {
        key: 'long', note: 'long path + long command',
        approvals: [
            cmd('c8', 'node scripts/release.mjs --tag v1.5.0 --notes "approval card: flat review ledger, tokens first" --publish vsix dist'),
            file('c9', LONG_PATH, 128, 44, CSS_LINES),
        ],
    },
];

async function host(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

test.beforeEach(async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as Record<string, unknown>).__xratuHostMessages = sent;
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (m: unknown) => { sent.push(m); },
            getState: () => undefined,
            setState: (s: unknown) => s,
        });
    });
});

for (const mode of ['dark', 'light'] as const) {
    for (const locale of ['fa', 'en'] as const) {
        for (const [label, width] of [['sidebar', 420], ['wide', 900]] as const) {
            test(`${mode} ${locale} ${label}: the real approval card`, async ({ page }) => {
                await page.setViewportSize({ width, height: 1400 });
                // The standalone page has NO VS Code theme; without the real
                // tokens every surface renders transparent and the screenshots
                // look plausible while proving nothing.
                await installVscodeTheme(page, mode);
                await page.goto('/');
                await host(page, { type: 'locale', locale });
                await host(page, { type: 'showChat' });
                await host(page, {
                    type: 'restoreUser',
                    value: locale === 'fa'
                        ? 'احراز هویت رو اضافه کن و تست هاش رو بنویس'
                        : 'Add auth to the session helper and write its tests',
                });
                await page.locator('.messages-inner').waitFor();

                for (const state of STATES) {
                    await host(page, { type: 'startResponse' });
                    await host(page, {
                        type: 'chunk',
                        value: locale === 'fa'
                            ? 'دارم مسیر احراز هویت رو اضافه می کنم.'
                            : 'Adding the auth path now.',
                    });
                    await host(page, {
                        type: 'needsApproval',
                        approval_id: `ap-${state.key}`,
                        approvals: state.approvals,
                        preDenied: state.preDenied,
                    });
                    const card = page.locator('.approval-card').last();
                    await card.waitFor();
                    if (state.key === 'submitting') {
                        // Drive the real in-flight state rather than faking it.
                        await card.locator('.approval-apply').click();
                    }
                    if (state.key === 'expanded') {
                        await card.locator('.approval-item summary').first().click();
                        await page.waitForTimeout(200);
                    }
                    await card.scrollIntoViewIfNeeded();
                    /* Let the turn's entrance settle before shooting. Element
                     * screenshots capture the box as laid out, so a card caught
                     * mid `transform: scale()` renders distorted - a misleading
                     * artifact that looks like a broken layout. */
                    await card.evaluate((el) => Promise.all(
                        el.getAnimations({ subtree: true })
                            // The submitting spinner iterates forever; awaiting
                            // `finished` on it never resolves. Only the finite
                            // ones (the turn entrance) need to settle.
                            .filter((a) => !(a.effect?.getTiming().iterations ?? 1) || (a.effect?.getTiming().iterations as number) !== Infinity)
                            .map((a) => a.finished.catch(() => undefined)),
                    ));
                    await card.screenshot({
                        path: join(OUT, `real-${state.key}-${locale}-${label}-${mode}.png`),
                        animations: 'disabled',
                    });
                    // Settle this card so the next state is not stacked on top
                    // of it. On an assistant bubble the payload is stripped and
                    // the streamed timeline stays, which is exactly what the
                    // host does while the run resumes.
                    await host(page, {
                        type: 'approvalResolved',
                        approval_id: `ap-${state.key}`,
                        resolution: 'approved',
                    });
                }
            });
        }
    }
}
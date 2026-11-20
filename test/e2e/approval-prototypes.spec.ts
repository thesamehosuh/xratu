/**
 * Approval-card redesign - PROTOTYPE screenshot harness.
 *
 * Not a test: it writes PNGs of the three structural directions (A / B / C) in
 * every state the redesign has to survive, for a human to LOOK at and choose
 * between. The real `ApprovalCard` is deliberately NOT used - these are static
 * blocks (see `approvalPrototypes.ts`), so all three directions render in one
 * run without rebuilding the bundle between shots.
 *
 *   npm run build:webview
 *   XRATU_SCREENSHOTS=1 npx playwright test -c test/e2e/playwright.config.ts approval-prototypes.spec.ts
 *   # then open test/e2e/screenshots/approval/contact-sheet.html
 *
 * Matrix: 3 directions x 12 states x {fa,en} x {420 sidebar, 900 wide} x
 * {dark, light}. RTL breaks differently than LTR, and light is where the
 * current hardcoded diff colours fail, so both are shot for every cell.
 */
import { test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COPY, PROTO_CSS, STATE_ORDER, renderState, type Direction } from './approvalPrototypes';

const OUT = join(__dirname, 'screenshots', 'approval');

const DIRECTIONS: Direction[] = ['a', 'b', 'c'];
const LOCALES = ['en', 'fa'] as const;
const WIDTHS = [{ label: 'sidebar', width: 420 }, { label: 'wide', width: 900 }] as const;
const MODES = ['dark', 'light'] as const;

/** Contact-sheet caption for one direction. */
const DIRECTION_NOTE: Record<Direction, string> = {
    a: 'Flat review ledger - no card; verdict row + dense file table, actions on the header edge.',
    b: 'Verdict bar + action footer - same ledger, actions pinned to the bottom of the scroller.',
    c: 'Summary-first disclosure - one 30px line when idle, expands in place.',
};

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

/**
 * Mount every direction/state as real transcript chrome and return the root.
 *
 * The prototypes are injected into the LIVE bundle rather than a hand-written
 * page: the webview's own font stack (`Vazirmatn`), transcript spacing and
 * scroll container are exactly what the card has to live inside, and a
 * prototype reviewed outside them is a prototype that cannot ship.
 */
async function mountPrototypes(page: Page, locale: 'fa' | 'en'): Promise<void> {
    await page.goto('/');
    await page.evaluate((l) => window.postMessage({ type: 'locale', locale: l }, '*'), locale);
    await page.evaluate(() => window.postMessage({ type: 'showChat' }, '*'));
    await page.locator('.messages-inner').waitFor();
    // One user turn first: without it the transcript shows the empty-state
    // welcome panel, and every prototype frame in the contact sheet starts
    // with half its height spent on suggestion chips instead of the card.
    await page.evaluate((l) => window.postMessage({
        type: 'restoreUser',
        value: l === 'fa'
            ? 'احراز هویت رو اضافه کن و تست هاش رو بنویس'
            : 'Add auth to the session helper and write its tests',
    }, '*'), locale);

    const html = DIRECTIONS
        .map((d) => `<section class="proto-sheet" data-dir="${d}">
            <h2 class="proto-sheet-head" dir="ltr">${d.toUpperCase()}</h2>
            ${STATE_ORDER.map((s) => renderState(d, s.key, locale, s.note)).join('')}
        </section>`)
        .join('');

    await page.evaluate(({ html, css }) => {
        document.getElementById('xratu-proto-style')?.remove();
        const style = document.createElement('style');
        style.id = 'xratu-proto-style';
        style.textContent = css + `
            .proto-sheet { display: flex; flex-direction: column; gap: 18px; padding-block-end: 28px; }
            .proto-sheet-head {
                margin: 0; padding-block: 4px;
                font-size: var(--xratu-fs-xs); font-weight: 600;
                color: var(--vscode-descriptionForeground);
                direction: ltr; text-align: start;
                border-block-end: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
            }
            .proto-state .msg-content p { margin: 0 0 2px; }
            .proto-caption {
                margin: 3px 0 0;
                font-family: var(--vscode-editor-font-family);
                font-size: var(--xratu-fs-xs);
                color: color-mix(in srgb, var(--vscode-descriptionForeground) 80%, transparent);
            }
            .proto-btn:focus-visible, .proto-row:focus-visible, .c-sum:focus-visible {
                outline: 2px solid var(--xratu-accent); outline-offset: 1px;
            }
            @media (prefers-reduced-motion: reduce) {
                .proto-btn .step-status.spinner { animation-duration: 0.8s !important; }
            }
        `;
        document.head.appendChild(style);
        const host = document.createElement('div');
        host.id = 'proto-host';
        host.innerHTML = html;
        document.querySelector('.messages-inner')!.appendChild(host);
    }, { html, css: PROTO_CSS });
}

/** Element-box screenshot of one state block.
 *
 *  The plan says "viewport screenshots, never fullPage". That rule exists
 *  because `fullPage` STITCHES a scrolled page and paints artifacts into
 *  containers that scroll internally. An element shot has neither problem -
 *  Chromium clips to the element's own box in one pass - and it is what makes
 *  the contact sheet comparable: a frame of the card alone, at its real width,
 *  with no toolbar/composer padding to eyeball past. */
async function shoot(page: Page, direction: Direction, state: string, file: string): Promise<string> {
    const block = page.locator(`.proto-state[data-dir="${direction}"][data-state="${state}"]`);
    await block.scrollIntoViewIfNeeded();
    // Let the disclosure/caret transitions land so the shot is not caught
    // mid-rotate.
    await page.waitForTimeout(160);
    const path = join(OUT, file);
    await block.screenshot({ path, animations: 'disabled' });
    return path;
}

for (const mode of MODES) {
    for (const locale of LOCALES) {
        for (const { label, width } of WIDTHS) {
            test(`${mode} ${locale} ${label}: every approval direction in every state`, async ({ page }) => {
                await page.setViewportSize({ width, height: 1400 });
                // A standalone page has NO VS Code theme. Without the real
                // tokens every surface renders transparent and the screenshots
                // look plausible while proving nothing.
                await installVscodeTheme(page, mode);
                await mountPrototypes(page, locale);

                const shots: { file: string; caption: string; direction: Direction }[] = [];
                for (const d of DIRECTIONS) {
                    for (const s of STATE_ORDER) {
                        const file = `${d}-${s.key}-${locale}-${label}-${mode}.png`;
                        await shoot(page, d, s.key, file);
                        shots.push({ file, caption: `${d.toUpperCase()} · ${s.note}`, direction: d });
                    }
                }
                if (mode === 'dark' && locale === 'en' && label === 'sidebar') {
                    writeFileSync(join(OUT, 'index.json'), JSON.stringify(shots, null, 2));
                }
            });
        }
    }
}

/**
 * Contact sheet: every shot side by side, grouped by direction, with the copy
 * each locale actually rendered. Three prototype dirs in one HTML file is the
 * only way A / B / C can be compared honestly - flipping between PNGs hides
 * exactly the density difference the choice turns on.
 */
test('contact sheet', async () => {
    const groups = DIRECTIONS.map((d) => {
        const rows = STATE_ORDER.map((s) => ({
            state: s.key,
            note: s.note,
            cells: LOCALES.flatMap((locale) => WIDTHS.map(({ label, width }) => ({
                locale,
                label,
                width,
                file: `${d}-${s.key}-${locale}-${label}-dark.png`,
            }))),
        }));
        return { direction: d, note: DIRECTION_NOTE[d], rows };
    });

    const section = (g: typeof groups[number]) => `
        <section>
            <h2>${g.direction.toUpperCase()}</h2>
            <p class="note">${g.note}</p>
            ${g.rows.map((r) => `
                <div class="state">
                    <h3 dir="ltr">${r.state} <span>${r.note}</span></h3>
                    <div class="cells">
                        ${r.cells.map((c) => `<figure>
                            <img src="${c.file}" width="${c.width}" alt="${r.state} ${c.locale} ${c.label}" loading="lazy">
                            <figcaption dir="ltr">${c.locale} · ${c.label} · ${c.width}px</figcaption>
                        </figure>`).join('')}
                    </div>
                </div>`).join('')}
        </section>`;

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Approval card - prototype contact sheet</title>
<style>
    body { margin: 0; padding: 24px; background: #1f1f1f; color: #ccc;
           font: 13px/1.5 system-ui, sans-serif; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    .note { color: #9d9d9d; margin: 0 0 20px; max-width: 70ch; }
    section { margin-block-end: 40px; }
    h2 { font-size: 14px; letter-spacing: .04em; }
    h3 { font-size: 12px; margin: 18px 0 8px; color: #ccc; }
    h3 span { color: #9d9d9d; font-weight: 400; }
    .cells { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
    figure { margin: 0; }
    img { display: block; border: 1px solid #3c3c3c; }
    figcaption { font-size: 11px; color: #9d9d9d; margin-block-start: 4px; }
</style></head>
<body>
<h1>Approval card - prototype contact sheet</h1>
<p class="note">Static prototype blocks rendered inside the built webview with real VS Code Dark Modern
tokens. fa (RTL) and en, 420px sidebar and 900px wide. Direction A/B/C are the plan's candidates:
A drops the card entirely, B pins the actions to a footer, C collapses to a single line.
The card must satisfy all twelve states before a direction is chosen.</p>
${groups.map(section).join('')}
</body></html>`;

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'contact-sheet.html'), html);
});

/** The copy the prototypes rendered, kept in the artifact so a reviewer can
 *  check fa/en parity without opening the bundle. */
test('prototype copy', async () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'copy.json'), JSON.stringify(COPY, null, 2));
});
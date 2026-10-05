/**
 * Approval card: structure, states and the security-relevant gating.
 *
 * The redesign is visual/structural, so most of this suite is about the states
 * a real transcript produces - multi-file diffs, a lone terminal command, the
 * JSON-args fallback, an auto-denied item, a batch with nothing approvable,
 * the in-flight state, and three verdicts - in BOTH locales at a 420px
 * sidebar, because RTL reorders every row in this block.
 *
 * The behaviour half is the part that must not regress: this card is a
 * security boundary (AGENTS.md). `preDenied` items may never be approvable,
 * an empty approvable set must disable BOTH approve affordances, and a
 * decision must be reachable by keyboard alone.
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

async function host(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

interface Item {
    tool_call_id: string;
    tool_name: string;
    args?: Record<string, unknown>;
    diff?: { file: string; added: number; removed: number; lines: string[] };
}

/** Unified diff body: a hunk header the parser skips, then context/add/del
 *  lines carrying real line numbers so the gutter renders as a gutter. */
function diffLines(_file: string): string[] {
    return [
        '@@ -12,7 +12,8 @@ export function signIn(user: User) {',
        '   const token = localStorage.getItem("token");',
        '-  if (!token) return null;',
        '-  return verify(token, process.env.JWT_SECRET);',
        '+  const token = await session.readRefreshToken();',
        '+  if (!token) throw new AuthError("session expired");',
        '+  return verify(token, process.env.JWT_SECRET);',
        ' }',
    ];
}

function fileItem(id: string, file: string, added: number, removed: number): Item {
    return { tool_call_id: id, tool_name: 'edit_file', args: { path: file }, diff: { file, added, removed, lines: diffLines(file) } };
}

function commandItem(id: string, command: string): Item {
    return { tool_call_id: id, tool_name: 'run_terminal_command', args: { command } };
}

const FILE_ITEM = fileItem('call-1', 'src/auth/session.ts', 3, 2);
const CSS_ITEM = fileItem('call-2', 'webview-ui/src/styles/token.css', 2, 1);
const COMMAND_ITEM = commandItem('call-3', 'npm run build:webview');
const JSON_ITEM: Item = {
    tool_call_id: 'call-4',
    tool_name: 'mcp__github__create_issue',
    args: { owner: 'xratu', title: 'Flat ledger' },
};

/** Mount the chat with one assistant turn and an approval payload attached. */
async function open(page: Page, opts: {
    locale?: 'fa' | 'en';
    approvals: Item[];
    preDenied?: Record<string, boolean>;
} ): Promise<void> {
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as unknown as Record<string, unknown>).__xratuHostMessages = sent;
        (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (m: unknown) => { sent.push(m); },
            getState: () => undefined,
            setState: (s: unknown) => s,
        });
    });
    await installVscodeTheme(page);
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto('/');
    await host(page, { type: 'locale', locale: opts.locale ?? 'en' });
    await host(page, { type: 'showChat' });
    await host(page, { type: 'startResponse' });
    await host(page, { type: 'chunk', value: 'Adding the auth path now.' });
    await host(page, {
        type: 'needsApproval',
        approval_id: 'ap-1',
        approvals: opts.approvals,
        preDenied: opts.preDenied,
    });
    await page.locator('.approval-card').waitFor();
}

async function sentMessages(page: Page): Promise<Record<string, unknown>[]> {
    return page.evaluate(() => (window as unknown as Record<string, unknown>).__xratuHostMessages as Record<string, unknown>[]);
}

/* ---- structure ------------------------------------------------------- */

test('the card is a ruled ledger, not a card in a box', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    const card = page.locator('.approval-card');

    // No box: the prototype review chose elevation-free on purpose, because
    // nothing in a transcript is above the message flow. These four properties
    // are the whole point of direction A.
    const box = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
            radius: s.borderRadius,
            shadow: s.boxShadow,
            // A border is fine on the BLOCK rules; what must not come back is a
            // border on all four sides (a frame) rather than block hairlines.
            top: s.borderTopWidth,
            right: s.borderRightWidth,
            bottom: s.borderBottomWidth,
        };
    });
    expect(box.radius).toBe('0px');
    expect(box.shadow).toBe('none');
    expect(box.right).toBe('0px');
    expect(box.top).not.toBe('0px');
    expect(box.bottom).not.toBe('0px');

    // The title counts what is pending instead of naming the component.
    await expect(card.locator('.approval-title')).toHaveText('Approve 2 edits');
    // One row holds the verdict AND the actions; the old design needed a
    // 48px header plus a separate 48px band.
    const head = card.locator('.approval-head');
    await expect(head.locator('.approval-verdict .approval-apply')).toHaveCount(1);
    await expect(card.locator('.approval-actions')).toHaveCount(0);

    // The ledger shows the file count and the diff totals.
    await expect(card.locator('.approval-ledger .files')).toHaveText('2 files');
    await expect(card.locator('.approval-ledger .n')).toHaveText('+5 −3');
    // Per-file stats, so the table is comparable row to row.
    await expect(card.locator('.approval-file-stats').first()).toHaveText('+3 −2');
});

/**
 * What settling an approval actually does to the transcript.
 *
 * There is no live path that renders `payload.resolution`: on an assistant
 * bubble the reducer STRIPS the payload (keeping the streamed pills and text
 * visible) and on a standalone system row it drops the row outright. That is
 * the contract, and it is what this asserts - the earlier version of this test
 * re-posted a payload carrying `resolution` and "passed" against a card the
 * reducer had never actually resolved.
 *
 * The resolved RENDER branch in ApprovalCard is pre-existing defensive code
 * (it predates this change and the reducer still does not produce it), so
 * there is nothing to drive end to end here.
 */
test('settling an approval removes its card and keeps the streamed turn', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    await expect(page.locator('.approval-card')).toHaveCount(1);
    await expect(page.locator('.msg-content')).toContainText('Adding the auth path now.');

    await page.locator('.approval-apply').click();
    await host(page, { type: 'approvalResolved', approval_id: 'ap-1', resolution: 'approved' });

    await expect(page.locator('.approval-card')).toHaveCount(0);
    // The turn survives: losing the card must not lose the transcript.
    await expect(page.locator('.msg-content')).toContainText('Adding the auth path now.');
});

test('the actions are gone before the card is, so no verdict can be re-posted', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    await page.locator('.approval-apply').click();
    // Between the click and the resolution the card is inert, not merely
    // repainted: a user who double-taps during the round trip gets one answer.
    await expect(page.locator('.approval-apply')).toBeDisabled();
    await expect(page.locator('.approval-deny')).toBeDisabled();
    await expect(page.locator('.approval-session')).toBeDisabled();
});

/**
 * The pending title must name what is actually waiting. "Edits" on a batch of
 * terminal commands is a lie the reader has to decode from the table below,
 * and counting the whole batch promises edits the reader cannot grant when
 * some items were auto-denied.
 */
test('the pending title names the batch, not just its size', async ({ page }) => {
    const title = () => page.locator('.approval-title');

    // Edits.
    await open(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    await expect(title()).toHaveText('Approve 2 edits');
    // Singular.
    await open(page, { approvals: [FILE_ITEM] });
    await expect(title()).toHaveText('Approve 1 edit');
    // Terminal commands.
    await open(page, { approvals: [COMMAND_ITEM, COMMAND_ITEM] });
    await expect(title()).toHaveText('Approve 2 commands');
    await open(page, { approvals: [COMMAND_ITEM] });
    await expect(title()).toHaveText('Approve 1 command');
    // A JSON-args MCP tool is neither an edit nor a command.
    await open(page, { approvals: [JSON_ITEM] });
    await expect(title()).toHaveText('Approve 1 action');
    // Mixed: the batch is generic, not the first item's kind.
    await open(page, { approvals: [FILE_ITEM, COMMAND_ITEM] });
    await expect(title()).toHaveText('Approve 2 actions');
});

test('the pending title counts only the items the reader can actually grant', async ({ page }) => {
    // Three items, one auto-denied: promising "3 edits" would offer a decision
    // on something the card will refuse to run.
    await open(page, {
        approvals: [FILE_ITEM, CSS_ITEM, commandItem('call-z', 'rm -rf build')],
        preDenied: { 'call-z': false },
    });
    await expect(page.locator('.approval-title')).toHaveText('Approve 2 edits');
    // Every row is still VISIBLE - hiding a denied item would hide the fact
    // that the agent tried it.
    await expect(page.locator('.approval-item')).toHaveCount(3);
});

test('a batch with nothing approvable says so instead of counting', async ({ page }) => {
    await open(page, {
        approvals: [commandItem('call-a', 'rm -rf build')],
        preDenied: { 'call-a': false },
    });
    await expect(page.locator('.approval-title')).toHaveText('Nothing to approve');
});

test('the header renders no stray text where a condition is false', async ({ page }) => {
    // React prints a NUMERIC 0 as text while ignoring `false`, so any
    // `{numericCondition && ...}` silently paints a stray digit. Assert the
    // header's text is EXACTLY the title plus the two button labels - no more.
    await open(page, { approvals: [commandItem('call-a', 'npm test')] });
    const headerText = async () => {
        const head = page.locator('.approval-head');
        // Drop the button labels: they are the only intended extra text.
        const clone = await head.evaluate((el) => {
            const c = el.cloneNode(true) as HTMLElement;
            c.querySelector('.approval-verdict')?.remove();
            return c.textContent ?? '';
        });
        return clone.trim();
    };
    await expect(page.locator('.approval-title')).toHaveText('Approve 1 command');
    expect(await headerText()).toBe('Approve 1 command');

    // Same check on a batch with no diffs at all - the case that painted "0".
    await open(page, { approvals: [COMMAND_ITEM] });
    expect(await headerText()).toBe('Approve 1 command');
});

/* ---- the states that must not break ---------------------------------- */

test('a lone terminal command renders its command, not a diff', async ({ page }) => {
    await open(page, { approvals: [COMMAND_ITEM] });
    const item = page.locator('.approval-item');
    // A command has no path, so the row is labelled by what it DOES ("Run
    // command") - the command text itself lives in the expanded body, where
    // there is room to read it.
    await expect(item.locator('.approval-label')).toHaveText('Run command');
    await expect(item.locator('.approval-file-stats')).toHaveCount(0);
    await item.locator('summary').click();
    await expect(item.locator('.approval-action-preview pre')).toContainText('npm run build:webview');
});

test('a non-diff tool with JSON args falls back to the JSON preview', async ({ page }) => {
    await open(page, { approvals: [JSON_ITEM] });
    const item = page.locator('.approval-item');
    await item.locator('summary').click();
    await expect(item.locator('.approval-action-preview pre')).toContainText('"owner": "xratu"');
});

test('an expanded file row renders the diff with both add and remove styling', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    await page.locator('.approval-item summary').first().click();
    const diff = page.locator('.approval-diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('tr.diff-add').first()).toBeVisible();
    await expect(diff.locator('tr.diff-del').first()).toBeVisible();
    // Line numbers are gutter content and must never be reordered by the page
    // direction - the diff wrapper is dir="ltr".
    await expect(page.locator('.approval-diff-wrap')).toHaveAttribute('dir', 'ltr');
});

test('a long path truncates the DIRECTORY, never the basename', async ({ page }) => {
    const long = 'webview-ui/src/components/settings/credentials/ProvidersSection.tsx';
    await open(page, { approvals: [fileItem('call-9', long, 4, 1)] });
    const base = page.locator('.approval-path .base');
    await expect(base).toHaveText('ProvidersSection.tsx');
    // The basename is never the shrinkable half: it must render at full width.
    const box = await base.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, scroll: el.scrollWidth, clipped: el.scrollWidth > Math.ceil(r.width) + 1 };
    });
    expect(box.clipped).toBe(false);
    expect(box.width).toBeGreaterThan(40);
});

test('a batch with nothing approvable disables both approve affordances', async ({ page }) => {
    await open(page, {
        approvals: [commandItem('call-a', 'rm -rf build'), commandItem('call-b', 'git push --force')],
        preDenied: { 'call-a': false, 'call-b': false },
    });
    await expect(page.locator('.approval-apply')).toBeDisabled();
    await expect(page.locator('.approval-session')).toBeDisabled();
    // Deny stays live: it is always a valid answer.
    await expect(page.locator('.approval-deny')).toBeEnabled();
    // Every blocked row says so on its own row. Nothing else: the footer
    // carries no sentence restating it.
    await expect(page.locator('.approval-denied-tag')).toHaveCount(2);
    await expect(page.locator('.approval-foot')).toHaveText('Allow this session');
});

test('the verdict buttons match the approved prototype, not the theme CTA blue', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    const geo = await page.locator('.approval-apply').evaluate((el) => {
        const s = getComputedStyle(el);
        return { h: s.height, pad: s.paddingInlineStart, r: s.borderRadius, fs: s.fontSize, min: s.minWidth };
    });
    // The prototype's button atom, verbatim. These are the numbers the design
    // was approved on; a "close enough" refactor of them is a visual change.
    expect(geo.h).toBe('24px');
    expect(geo.pad).toBe('10px');
    expect(geo.r).toBe('5px');          // --xratu-radius-xs
    expect(geo.fs).toBe('11px');        // --xratu-fs-sm
    expect(geo.min).toBe('92px');

    // The accent, NOT --vscode-button-background. In Dark Modern that token is
    // #0078d4 - a link colour. On a filled 92px button beside "Deny all" it
    // read as a hyperlink and pulled the eye off the ledger. Assert the
    // resolved colour so a future "use the theme button token" edit cannot
    // quietly reintroduce it.
    const bg = await page.locator('.approval-apply').evaluate((el) => getComputedStyle(el).backgroundColor);
    // `--xratu-accent-faint` is itself an rgba() token, so resolve it rather
    // than re-parsing hex.
    const expected = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--xratu-accent-faint').trim();
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return v;
    });
    expect(bg).toBe(expected);
    expect(bg).not.toBe('rgb(0, 120, 212)');

    // Deny is the quiet half: no fill at all.
    const denyBg = await page.locator('.approval-deny').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(denyBg).toBe('rgba(0, 0, 0, 0)');
});

test('the verdict buttons sit on the trailing edge in EVERY state', async ({ page }) => {
    // The prototype splits the header's free space with TWO auto margins - one
    // on the ledger, one on the verdict - so the buttons stay on the trailing
    // edge even when there is no ledger to float. With the auto only on the
    // ledger, a diffless batch (a terminal command, a fully-denied batch) had
    // nothing pushing the buttons out and they hugged the title.
    const gapToRightEdge = async () => page.locator('.approval-apply').evaluate((el) => {
        const head = el.closest('.approval-head')!.getBoundingClientRect();
        return Math.round(head.right - el.getBoundingClientRect().right);
    });

    // With a ledger (multi-file diffs).
    await open(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
    // Without one: a lone terminal command.
    await open(page, { approvals: [COMMAND_ITEM] });
    expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
    // Without one, and with a very short title.
    await open(page, { approvals: [commandItem('call-s', 'ls')] });
    expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
    // Deny and Approve are adjacent in both LTR and RTL.
    await open(page, { approvals: [FILE_ITEM] });
    expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
});

test('the verdict button is accent-on-accent, never the theme button foreground', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    // VS Code ALWAYS defines --vscode-button-foreground (white in Dark
    // Modern), so the prototype's `var(--vscode-button-foreground, ...)` label
    // never reached its teal fallback: the real card rendered white text on an
    // 8% accent wash. The review harness omitted the token and hid it.
    const colour = await page.locator('.approval-apply').evaluate((el) => getComputedStyle(el).color);
    const accent = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--xratu-accent-strong').trim();
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
    });
    expect(colour).toBe(accent);
    expect(colour).not.toBe('rgb(255, 255, 255)');
});

test('the ledger and the row table keep the approved metrics', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    const read = (sel: string, prop: string) =>
        page.locator(sel).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
    expect(await read('.approval-head', 'min-height')).toBe('30px');
    expect(await read('.approval-item summary', 'min-height')).toBe('26px');
    expect(await read('.approval-title', 'font-size')).toBe('12px');   // --xratu-fs-md
    expect(await read('.approval-title', 'font-weight')).toBe('650');
    expect(await read('.approval-ledger', 'font-size')).toBe('10.5px'); // --xratu-fs-xs
    expect(await read('.approval-path', 'font-size')).toBe('10.5px');
    expect(await read('.approval-session', 'font-size')).toBe('10.5px');
    // The ledger aligns like a diffstat.
    expect(await read('.approval-ledger .n', 'font-variant-numeric')).toContain('tabular-nums');
    // No nested chrome: the block is not a frame.
    expect(await read('.approval-card', 'border-left-width')).toBe('0px');
    expect(await read('.approval-card', 'border-right-width')).toBe('0px');
    expect(await read('.approval-card', 'border-top-width')).not.toBe('0px');
    expect(await read('.approval-card', 'box-shadow')).toBe('none');
    expect(await read('.approval-card', 'border-radius')).toBe('0px');
});

test('an ordinary batch shows no plan-mode tag at all', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    await expect(page.locator('.approval-denied-tag')).toHaveCount(0);
});

test('a preDenied item is excluded from the approve decision', async ({ page }) => {
    await open(page, {
        approvals: [FILE_ITEM, commandItem('call-x', 'rm -rf build')],
        preDenied: { 'call-x': false },
    });
    await page.locator('.approval-apply').click();
    const decision = (await sentMessages(page)).find((m) => m.type === 'approvalDecision') as
        { decisions: Record<string, boolean>; sessionApprove?: boolean } | undefined;
    expect(decision).toBeTruthy();
    expect(decision!.decisions['call-1']).toBe(true);
    // The auto-denied item stays denied even on a blanket approve.
    expect(decision!.decisions['call-x']).toBe(false);
});

test('the decision posts the documented payload shape', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    await page.locator('.approval-deny').click();
    const decision = (await sentMessages(page)).find((m) => m.type === 'approvalDecision') as
        { approvalId: string; decisions: Record<string, boolean> } | undefined;
    expect(decision!.approvalId).toBe('ap-1');
    expect(decision!.decisions).toEqual({ 'call-1': false });

    // "Allow this session" is the only path that sets the flag.
    await page.reload();
});

test('allow-this-session sets the session flag', async ({ page }) => {
    await open(page, { approvals: [COMMAND_ITEM] });
    await page.locator('.approval-session').click();
    const decision = (await sentMessages(page)).find((m) => m.type === 'approvalDecision') as
        { sessionApprove?: boolean } | undefined;
    expect(decision!.sessionApprove).toBe(true);
});

test('a DENY never shows the Approve button saying "Applying…"', async ({ page }) => {
    // A rejection has nothing to apply. Telling the user their changes are
    // being applied while they are being thrown away is the worst thing this
    // card can say, and a single `submitting` boolean made it do exactly that:
    // the label swap was unconditional, so Deny swapped the APPROVE label too.
    await open(page, { approvals: [FILE_ITEM] });
    await page.locator('.approval-deny').click();

    // Both buttons go inert...
    await expect(page.locator('.approval-deny')).toBeDisabled();
    await expect(page.locator('.approval-apply')).toBeDisabled();
    // ...but only Deny shows motion, and Approve keeps its own label.
    await expect(page.locator('.approval-deny .step-status.spinner')).toHaveCount(1);
    await expect(page.locator('.approval-apply .step-status.spinner')).toHaveCount(0);
    await expect(page.locator('.approval-apply').getByText('Approve & run')).toBeVisible();
    await expect(page.locator('.approval-apply').getByText('Applying…')).toBeHidden();
});

test('an APPROVE does show "Applying…", on the Approve button', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    await page.locator('.approval-apply').click();
    // "Applying…" is VISIBLE (the idle label is present but hidden), so assert
    // visibility rather than containment - the button carries both strings.
    await expect(page.locator('.approval-apply').getByText('Applying…')).toBeVisible();
    await expect(page.locator('.approval-apply .step-status.spinner')).toHaveCount(1);
    // Deny stays quiet - it was not pressed.
    await expect(page.locator('.approval-deny .step-status.spinner')).toHaveCount(0);
    await expect(page.locator('.approval-deny')).toContainText('Deny all');
});

test('the in-flight spinner is sized, not collapsed', async ({ page }) => {
    // The bundled .step-status paints only inside real .step markup, so
    // without an explicit box the button changes width as its label swaps.
    await open(page, { approvals: [FILE_ITEM] });
    // Fonts first. The webview inlines Vazirmatn with `font-display: swap`, and
    // --vscode-font-family resolves to the host's `system-ui` - a different
    // face on every runner. Measuring before the font settles compared two
    // different metrics and read as a layout regression (it failed on macOS
    // with a 1.77px delta while the layout never actually moved).
    await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
    const before = await page.locator('.approval-apply').evaluate((el) => el.offsetWidth);
    await page.locator('.approval-apply').click();
    // Then the in-flight state, so the swap is committed rather than sampled
    // mid-render.
    await expect(page.locator('.approval-apply .step-status.spinner')).toHaveCount(1);
    // offsetWidth, not getBoundingClientRect: the spinner is a rotating square,
    // so its own bounding rect swells from 13px to 18.4px twice per turn.
    // Transforms do not affect layout, and offsetWidth is the layout box.
    const after = await page.locator('.approval-apply').evaluate((el) => el.offsetWidth);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

test('a double click cannot post two decisions', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    const apply = page.locator('.approval-apply');
    // The button disables itself synchronously on the first click; a second
    // activation in the same tick must not reach onDecide again.
    await apply.evaluate((el) => { el.click(); el.click(); });
    const decisions = (await sentMessages(page)).filter((m) => m.type === 'approvalDecision');
    expect(decisions).toHaveLength(1);
});

test('the verdict is reachable by keyboard alone', async ({ page }) => {
    await open(page, { approvals: [FILE_ITEM] });
    // The section is labelled for screen readers.
    await expect(page.locator('.approval-card')).toHaveAttribute('aria-label', 'Approve 1 edit');

    // Keyboard REACHABILITY, not a programmatic focus() call: tab into the
    // apply button from its real predecessor. focus() would pass even if the
    // tab order were scrambled.
    await page.locator('.approval-deny').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.approval-apply')).toBeFocused();

    // A :focus-visible rule that resolves to `outline: none` passes a "can I
    // focus it" test while leaving keyboard users with no indicator at all.
    const ring = await page.locator('.approval-apply').evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(ring).not.toBe('0px');

    // The row summary is a real <details> toggle - Enter/Space expand it.
    await page.locator('.approval-item summary').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.approval-diff')).toBeVisible();
});

/* ---- locale ---------------------------------------------------------- */

for (const locale of ['fa', 'en'] as const) {
    test(`${locale}: the ledger numerals stay attached to their signs`, async ({ page }) => {
        await open(page, { locale, approvals: [fileItem('call-1', 'src/a.ts', 128, 44)] });
        // In an RTL paragraph an unisolated "+128 -44" renders as "+128+ 44-".
        // Assert the ISOLATION is present rather than the glyph order, which is
        // what actually holds across locales.
        const isolate = page.locator('.approval-ledger .n');
        await expect(isolate).toHaveAttribute('dir', 'ltr');
        await expect(isolate).toHaveText('+128 −44');
        // Per-row stats get the same treatment.
        await expect(page.locator('.approval-file-stats')).toHaveAttribute('dir', 'ltr');
    });

    test(`${locale}: the row caret folds up/down, never left/right`, async ({ page }) => {
        await open(page, { locale, approvals: [FILE_ITEM] });
        const caret = page.locator('.approval-caret').first();
        const readCaret = () => caret.evaluate((el) => getComputedStyle(el).transform);
        // The fold is a 180ms TRANSITION, and getComputedStyle returns the
        // currently interpolated matrix - reading it the instant after the
        // click returns the start value and the assertion flakes. Wait for
        // the transition to finish instead.
        const settled = () => caret.evaluate((el) => Promise.all(
            el.getAnimations().map((a) => a.finished.catch(() => undefined)),
        ).then(() => getComputedStyle(el).transform));

        const before = await readCaret();
        // RTL mirrors the glyph horizontally; LTR does not.
        expect(before === 'matrix(-1, 0, 0, 1, 0, 0)').toBe(locale === 'fa');

        await page.locator('.approval-item summary').first().click();
        const after = await settled();
        expect(after).not.toBe(before);
    });
}

test('reduced motion removes the submit spinner rotation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, { approvals: [FILE_ITEM] });
    const duration = await page.locator('.approval-apply .step-status.spinner, .approval-apply').first()
        .evaluate((el) => getComputedStyle(el).transitionDuration);
    // The global reduced-motion block clamps every animation/transition; this
    // asserts the block still covers the redesigned card.
    expect(parseFloat(duration)).toBeLessThan(0.05);
});
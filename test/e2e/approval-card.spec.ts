/**
 * Approval card: structure, states and the security-relevant gating.
 *
 * Security boundary (AGENTS.md): `preDenied` items may never be approvable,
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

function diffLines(): string[] {
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
    return { tool_call_id: id, tool_name: 'edit_file', args: { path: file }, diff: { file, added, removed, lines: diffLines() } };
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

let nextApprovalId = 1;

async function bootChat(page: Page, locale: 'fa' | 'en' = 'en'): Promise<void> {
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
    await host(page, { type: 'locale', locale });
    await host(page, { type: 'showChat' });
}

async function showApproval(page: Page, opts: {
    approvals: Item[];
    preDenied?: Record<string, boolean>;
    approvalId?: string;
}): Promise<string> {
    const id = opts.approvalId ?? `ap-${nextApprovalId++}`;
    await host(page, { type: 'startResponse' });
    await host(page, { type: 'chunk', value: 'Adding the auth path now.' });
    await host(page, {
        type: 'needsApproval',
        approval_id: id,
        approvals: opts.approvals,
        preDenied: opts.preDenied,
    });
    await page.locator('.approval-card').last().waitFor();
    return id;
}

async function resolveApproval(page: Page, id: string): Promise<void> {
    await host(page, { type: 'approvalResolved', approval_id: id, resolution: 'approved' });
    await expect(page.locator('.approval-card')).toHaveCount(0);
}

async function sentMessages(page: Page): Promise<Record<string, unknown>[]> {
    return page.evaluate(() => (window as unknown as Record<string, unknown>).__xratuHostMessages as Record<string, unknown>[]);
}

/* ---- structure, titles, previews, and layout ------------------------- */

test('ledger structure, titles, previews, truncation, and alignment', async ({ page }) => {
    await bootChat(page, 'en');

    // 1. Multi-file ruled ledger (elevation-free, accent-on-accent CTA, trailing verdict).
    let id = await showApproval(page, { approvals: [FILE_ITEM, CSS_ITEM] });
    const card = page.locator('.approval-card');
    const box = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return { radius: s.borderRadius, shadow: s.boxShadow, top: s.borderTopWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth };
    });
    expect(box.radius).toBe('0px');
    expect(box.shadow).toBe('none');
    expect(box.right).toBe('0px');
    expect(box.top).not.toBe('0px');
    expect(box.bottom).not.toBe('0px');

    await expect(card.locator('.approval-title')).toHaveText('Approve 2 edits');
    await expect(card.locator('.approval-head .approval-verdict .approval-apply')).toHaveCount(1);
    await expect(card.locator('.approval-actions')).toHaveCount(0);
    await expect(card.locator('.approval-ledger .files')).toHaveText('2 files');
    await expect(card.locator('.approval-ledger .n')).toHaveText('+5 −3');
    await expect(card.locator('.approval-file-stats').first()).toHaveText('+3 −2');
    await expect(card.locator('.approval-denied-tag')).toHaveCount(0);

    // Accent-on-accent button (never VS Code CTA blue or white foreground), quiet Deny.
    const colors = await page.evaluate(() => {
        const apply = getComputedStyle(document.querySelector('.approval-apply')!);
        const deny = getComputedStyle(document.querySelector('.approval-deny')!);
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--xratu-accent-faint)';
        probe.style.color = getComputedStyle(document.querySelector('.workbench')!).getPropertyValue('--xratu-accent-strong').trim();
        document.querySelector('.app')!.appendChild(probe);
        const expectedBg = getComputedStyle(probe).backgroundColor;
        const expectedFg = getComputedStyle(probe).color;
        probe.remove();
        return { applyBg: apply.backgroundColor, applyFg: apply.color, denyBg: deny.backgroundColor, expectedBg, expectedFg };
    });
    expect(colors.applyBg).toBe(colors.expectedBg);
    expect(colors.applyBg).not.toBe('rgb(0, 120, 212)');
    expect(colors.applyFg).toBe(colors.expectedFg);
    expect(colors.applyFg).not.toBe('rgb(255, 255, 255)');
    expect(colors.denyBg).toBe('rgba(0, 0, 0, 0)');

    // Expanded file diff has add/del styling and dir="ltr" gutter.
    const firstFile = card.locator('.approval-item').first();
    await firstFile.locator('summary').click();
    const diff = firstFile.locator('.approval-diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('tr.diff-add').first()).toBeVisible();
    await expect(diff.locator('tr.diff-del').first()).toBeVisible();
    await expect(firstFile.locator('.approval-diff-wrap')).toHaveAttribute('dir', 'ltr');

    const gapToRightEdge = () => page.locator('.approval-apply').evaluate((el) => {
        const head = el.closest('.approval-head')!.getBoundingClientRect();
        return Math.round(head.right - el.getBoundingClientRect().right);
    });
    expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
    await resolveApproval(page, id);

    // 2. Batch titles across kinds, no stray numeric "0", command & JSON previews, trailing edge.
    const titleCases: Array<[Item[], string, Record<string, boolean>?]> = [
        [[FILE_ITEM], 'Approve 1 edit'],
        [[COMMAND_ITEM, commandItem('call-5', 'npm run test:webview')], 'Approve 2 commands'],
        [[COMMAND_ITEM], 'Approve 1 command'],
        [[JSON_ITEM], 'Approve 1 action'],
        [[FILE_ITEM, COMMAND_ITEM], 'Approve 2 actions'],
        [[FILE_ITEM, CSS_ITEM, commandItem('call-z', 'rm -rf build')], 'Approve 2 edits', { 'call-z': false }],
    ];
    for (const [approvals, expectedTitle, preDenied] of titleCases) {
        id = await showApproval(page, { approvals, preDenied });
        await expect(page.locator('.approval-title')).toHaveText(expectedTitle);
        expect(await gapToRightEdge()).toBeLessThanOrEqual(2);
        if (approvals.length === 1 && approvals[0] === COMMAND_ITEM) {
            const headText = await page.locator('.approval-head').evaluate((el) => {
                const clone = el.cloneNode(true) as HTMLElement;
                clone.querySelector('.approval-verdict')?.remove();
                return (clone.textContent ?? '').trim();
            });
            expect(headText).toBe('Approve 1 command');
            const item = page.locator('.approval-item');
            await expect(item.locator('.approval-label')).toHaveText('Run command');
            await expect(item.locator('.approval-file-stats')).toHaveCount(0);
            await item.locator('summary').click();
            await expect(item.locator('.approval-action-preview pre')).toContainText('npm run build:webview');
        }
        if (approvals.length === 1 && approvals[0] === JSON_ITEM) {
            const item = page.locator('.approval-item');
            await item.locator('summary').click();
            await expect(item.locator('.approval-action-preview pre')).toContainText('"owner": "xratu"');
        }
        if (preDenied) {
            await expect(page.locator('.approval-item')).toHaveCount(3);
        }
        await resolveApproval(page, id);
    }

    // 3. Long paths truncate the directory, never the basename.
    id = await showApproval(page, { approvals: [fileItem('call-9', 'webview-ui/src/components/settings/credentials/ProvidersSection.tsx', 4, 1)] });
    const base = page.locator('.approval-path .base');
    await expect(base).toHaveText('ProvidersSection.tsx');
    const baseBox = await base.evaluate((el) => ({ width: el.clientWidth, clipped: el.scrollWidth > el.clientWidth + 1 }));
    expect(baseBox.clipped).toBe(false);
    expect(baseBox.width).toBeGreaterThan(40);
    await resolveApproval(page, id);
});

/* ---- security gating, decisions, and in-flight state ----------------- */

test('preDenied exclusion, empty-approvable lock, payload shapes, and settling', async ({ page }) => {
    await bootChat(page, 'en');

    // 1. Batch with nothing approvable disables both approve affordances; Deny stays enabled.
    let id = await showApproval(page, {
        approvals: [commandItem('call-a', 'rm -rf build'), commandItem('call-b', 'git push --force')],
        preDenied: { 'call-a': false, 'call-b': false },
    });
    await expect(page.locator('.approval-title')).toHaveText('Nothing to approve');
    await expect(page.locator('.approval-apply')).toBeDisabled();
    await expect(page.locator('.approval-session')).toBeDisabled();
    await expect(page.locator('.approval-deny')).toBeEnabled();
    await expect(page.locator('.approval-denied-tag')).toHaveCount(2);
    await expect(page.locator('.approval-foot')).toHaveText('Allow this session');
    await resolveApproval(page, id);

    // 2. preDenied items remain false even on blanket Approve; settling keeps transcript.
    id = await showApproval(page, {
        approvalId: 'ap-predenied',
        approvals: [FILE_ITEM, commandItem('call-x', 'rm -rf build')],
        preDenied: { 'call-x': false },
    });
    await expect(page.locator('.msg-content').last()).toContainText('Adding the auth path now.');
    await page.locator('.approval-apply').click();
    const afterApprove = (await sentMessages(page)).filter((m) => m.type === 'approvalDecision').at(-1) as {
        approvalId: string; decisions: Record<string, boolean>; sessionApprove?: boolean;
    };
    expect(afterApprove.approvalId).toBe('ap-predenied');
    expect(afterApprove.decisions['call-1']).toBe(true);
    expect(afterApprove.decisions['call-x']).toBe(false);
    await resolveApproval(page, id);
    await expect(page.locator('.msg-content').last()).toContainText('Adding the auth path now.');

    // 3. Deny posts false decisions and shows spinner ONLY on Deny (never "Applying…").
    id = await showApproval(page, { approvalId: 'ap-deny', approvals: [FILE_ITEM] });
    await page.locator('.approval-deny').click();
    const denyDecision = (await sentMessages(page)).filter((m) => m.type === 'approvalDecision').at(-1) as {
        approvalId: string; decisions: Record<string, boolean>;
    };
    expect(denyDecision.approvalId).toBe('ap-deny');
    expect(denyDecision.decisions).toEqual({ 'call-1': false });
    await expect(page.locator('.approval-deny')).toBeDisabled();
    await expect(page.locator('.approval-apply')).toBeDisabled();
    await expect(page.locator('.approval-session')).toBeDisabled();
    await expect(page.locator('.approval-deny .step-status.spinner')).toHaveCount(1);
    await expect(page.locator('.approval-apply .step-status.spinner')).toHaveCount(0);
    await expect(page.locator('.approval-apply').getByText('Approve & run')).toBeVisible();
    await expect(page.locator('.approval-apply').getByText('Applying…')).toBeHidden();
    await resolveApproval(page, id);

    // 4. Allow-this-session sets sessionApprove: true.
    id = await showApproval(page, { approvalId: 'ap-session', approvals: [COMMAND_ITEM] });
    await page.locator('.approval-session').click();
    const sessionDecision = (await sentMessages(page)).filter((m) => m.type === 'approvalDecision').at(-1) as {
        approvalId: string; sessionApprove?: boolean;
    };
    expect(sessionDecision.approvalId).toBe('ap-session');
    expect(sessionDecision.sessionApprove).toBe(true);
    await resolveApproval(page, id);
});

test('in-flight approve state, stable button width, and double-click guard', async ({ page }) => {
    await bootChat(page, 'en');
    await showApproval(page, { approvalId: 'ap-dbl', approvals: [FILE_ITEM] });
    await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
    const apply = page.locator('.approval-apply');
    const before = await apply.evaluate((el) => el.offsetWidth);

    // Double activation in the same tick must only post ONE decision.
    await apply.evaluate((el) => { el.click(); el.click(); });
    const decisions = (await sentMessages(page)).filter((m) => m.type === 'approvalDecision');
    expect(decisions).toHaveLength(1);

    await expect(apply.getByText('Applying…')).toBeVisible();
    await expect(apply.locator('.step-status.spinner')).toHaveCount(1);
    await expect(page.locator('.approval-deny .step-status.spinner')).toHaveCount(0);
    await expect(page.locator('.approval-deny')).toContainText('Deny all');
    const after = await apply.evaluate((el) => el.offsetWidth);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});

test('verdict and diff details are reachable by keyboard alone and obey reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bootChat(page, 'en');
    await showApproval(page, { approvals: [FILE_ITEM] });
    await expect(page.locator('.approval-card')).toHaveAttribute('aria-label', 'Approve 1 edit');

    await page.locator('.approval-deny').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.approval-apply')).toBeFocused();
    const ring = await page.locator('.approval-apply').evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(ring).not.toBe('0px');

    await page.locator('.approval-item summary').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.approval-diff')).toBeVisible();

    const duration = await page.locator('.approval-apply').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.05);
});

/* ---- locale & RTL ---------------------------------------------------- */

for (const locale of ['fa', 'en'] as const) {
    test(`${locale}: ledger numerals stay LTR-isolated and row caret rotates on expand`, async ({ page }) => {
        await bootChat(page, locale);
        await showApproval(page, { approvals: [fileItem('call-1', 'src/a.ts', 128, 44)] });
        const isolate = page.locator('.approval-ledger .n');
        await expect(isolate).toHaveAttribute('dir', 'ltr');
        await expect(isolate).toHaveText('+128 −44');
        await expect(page.locator('.approval-file-stats')).toHaveAttribute('dir', 'ltr');

        const caret = page.locator('.approval-caret').first();
        const readCaret = () => caret.evaluate((el) => getComputedStyle(el).transform);
        const settled = () => caret.evaluate((el) => Promise.all(
            el.getAnimations().map((a) => a.finished.catch(() => undefined)),
        ).then(() => getComputedStyle(el).transform));

        const before = await readCaret();
        expect(before === 'matrix(-1, 0, 0, 1, 0, 0)').toBe(locale === 'fa');
        await page.locator('.approval-item summary').first().click();
        const after = await settled();
        expect(after).not.toBe(before);
    });
}

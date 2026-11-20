import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, msg: Record<string, unknown>) => page.evaluate(message => window.postMessage(message, '*'), msg);
const sent = (page: Page): Promise<Array<Record<string, unknown>>> =>
    page.evaluate(() => (window as unknown as { __xratuHostMessages: Array<Record<string, unknown>> }).__xratuHostMessages);
const dragToSidebar = async (page: Page, selector: string) => {
    const source = (await page.locator(selector).boundingBox())!;
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, { steps: 3 });
    await expect(page.locator('.dock-sidebar.drag-target')).toBeVisible();
    const destination = (await page.locator('.dock-tabs.side').boundingBox())!;
    await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, { steps: 5 });
    await page.mouse.up();
};
const trace = (status = 'running', extra = {}) => ({
    taskId: 'child-a', profile: 'explore', description: 'Trace session expiry', prompt: 'Find expiry checks and their tests',
    model: 'child-model', effort: 'high', tools: ['read_file', 'grep_search'], resumed: false, status,
    startedAt: Date.now() - 3000, updatedAt: Date.now(), toolCalls: 2, inputTokens: 1234, outputTokens: 123,
    entries: [
        { id: 'intro', kind: 'text', text: 'Checking expiry before editing.', startedAt: Date.now() - 3000, endedAt: Date.now() - 2000 },
        { id: 'read', kind: 'tool', tool: 'read_file', text: JSON.stringify({ path: 'src/auth.ts' }), output: '[src/auth.ts - lines 38-40 of 100]\nexport function expired(token) {\n  return token.expiresAt < Date.now();\n}', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000 },
        { id: 'grep', kind: 'tool', tool: 'grep_search', text: JSON.stringify({ pattern: 'expired', path: 'src' }), output: 'src/auth.ts:38:export function expired(token) {\ntest/auth.test.ts:5:expired(token)', startedAt: Date.now() - 1000, endedAt: Date.now() },
    ],
    ...extra,
});

test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: unknown[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (m: unknown) => messages.push(m), getState: () => undefined, setState: () => {} }) });
    });
    await page.goto('/');
    await post(page, { type: 'showChat' });
    await post(page, { type: 'locale', locale: 'en' });
});

for (const [locale, width] of [['en', 1080], ['fa', 420]] as const) {
    test(`child observation, structured output, docking, approvals and retained state (${locale}, ${width})`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale });
        await page.locator('.composer-input').fill('Keep my draft');
        await expect(page.locator('#surface-tab-agents')).toHaveCount(0);
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'explore', description: 'Trace session expiry', prompt: 'Find expiry checks' }), callId: 'parent-a' });
        await post(page, { type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'general', description: 'Implement tests' }), callId: 'parent-b' });
        await post(page, { type: 'subagentState', callId: 'parent-a', trace: trace() });
        await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected', 'true');
        await page.locator('.transcript-pane .step').first().locator(':scope > summary').click();
        await page.locator('.transcript-pane .subagent-open').first().click();

        const panel = page.locator('.agents-pane');
        await expect(panel).toBeVisible();
        await expect(panel.locator('.agent-run-card')).toHaveCount(2);
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-run-heading')).toContainText('Trace session expiry');
        await expect(panel.locator('.agent-token-metric').first()).toContainText('1,234');
        await expect(panel.locator('.agent-run-select').first().locator('strong')).toContainText('Trace session expiry');
        await expect(panel.locator('.agent-profile-label').first()).toHaveText('explore');

        const details = panel.locator('.agent-run-view:not(.panel-hidden) .agent-brief');
        await expect(details).not.toHaveAttribute('open');
        await details.locator('summary').click();
        await expect(details.locator('.agent-token-metric')).toBeVisible();
        await details.locator('summary').click();
        await expect(panel).toContainText('Checking expiry before editing.');

        const read = panel.locator('.step').first();
        await read.locator(':scope > summary').click();
        await expect(read.locator('.detail-line-number').first()).toHaveText('38');
        await expect(read.locator('.detail-source-line')).toHaveCount(3);
        await read.locator('.detail-arguments summary').click();
        await expect(read.locator('.detail-arguments pre')).toContainText('src/auth.ts');

        await panel.locator('.agent-run-card').nth(1).click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-empty')).toBeVisible();
        // Structured MCP output inside a child observation stays inspectable.
        await post(page, { type: 'subagentState', callId: 'parent-b', trace: trace('done', {
            taskId: 'child-b', profile: 'general', description: 'Implement tests',
            entries: [{ id: 'report', kind: 'tool', tool: 'mcp__remote__report', text: '{}', output: 'Report complete', structuredContent: { project: 'xratu', count: 3 }, startedAt: Date.now() - 100, endedAt: Date.now() }],
        }) });
        const bStep = panel.locator('.agent-run-view:not(.panel-hidden) .step').first();
        if (await bStep.getAttribute('open') === null) await bStep.locator(':scope > summary').click();
        const data = bStep.locator('.detail-arguments').filter({ hasText: locale === 'en' ? 'Structured data' : 'داده ساختاریافته' });
        await data.locator('summary').click();
        await expect(data.locator('pre')).toContainText('"project": "xratu"');
        await expect(panel.locator('.approval-card')).toHaveCount(0);

        await panel.locator('.agent-run-card').first().click();
        await expect(read).toHaveAttribute('open', '');
        await expect(read.locator('.detail-arguments')).toHaveAttribute('open', '');

        await post(page, { type: 'subagentState', callId: 'parent-a', trace: trace('waiting', { pendingTools: ['edit_file'] }) });
        await post(page, { type: 'needsApproval', approval_id: 'child-approval', source: { parentCallId: 'parent-a', profile: 'explore', description: 'Trace session expiry' }, approvals: [{ tool_call_id: 'child-write', tool_name: 'edit_file', args: { path: 'a.ts', patch: 'old to new' } }] });
        await expect(panel.locator('.approval-card')).toHaveCount(0);
        await expect(panel.locator('.agent-approval-notice')).toContainText('edit_file');
        await panel.locator('.agent-approval-notice button').click();
        await expect(page.locator('.transcript-pane .approval-source')).toContainText('explore');
        await expect(page.locator('.transcript-pane .approval-card')).toBeVisible();
        await page.locator('.approval-source button').click();
        await expect(panel).toBeVisible();
        if (width > 900) {
            await dragToSidebar(page, '#surface-tab-agents');
            await expect(panel).toHaveClass(/panel-side/);
            await expect(panel).toBeVisible();
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.transcript-pane')).toBeVisible();
        }
        await post(page, { type: 'approvalResolved', approval_id: 'child-approval' });
        await post(page, { type: 'subagentState', callId: 'parent-a', trace: trace('done', { endedAt: Date.now(), report: 'Expiry confirmed' }) });
        await post(page, { type: 'toolResult', tool: 'task', callId: 'parent-a', output: 'Expiry confirmed' });
        await post(page, { type: 'toolResult', tool: 'task', callId: 'parent-b', output: 'Tests implemented' });
        await post(page, { type: 'fullResponse', persian: 'Final parent answer' });
        if (width === 420) await page.locator('#surface-tab-agents').click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-run-heading')).toContainText('Trace session expiry');
        await expect(panel.locator('.icon-btn-mini, .msg-footer')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await panel.locator('.agent-view-tabs button').nth(1).click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden)')).toContainText('Checking expiry before editing.');
    });
}

test('current-state tooltips describe mode and permission semantics in en and fa', async ({ page }) => {
    for (const locale of ['en', 'fa'] as const) {
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'planMode', enabled: false });
        await post(page, { type: 'yoloMode', enabled: false });
        const mode = page.locator('[data-policy="mode"]');
        const permission = page.locator('[data-policy="approval"]');
        await expect(mode).toHaveAttribute('title', /Build/);
        await expect(permission).not.toHaveAttribute('title', /YOLO/);
        const build = await mode.getAttribute('title');
        const ask = await permission.getAttribute('title');
        await post(page, { type: 'planMode', enabled: true });
        await post(page, { type: 'yoloMode', enabled: true });
        await expect(mode).toHaveAttribute('title', /Plan/);
        expect(await mode.getAttribute('title')).not.toBe(build);
        expect(await permission.getAttribute('title')).not.toBe(ask);
        await mode.click();
        await expect(page.locator('.composer-policy-menu')).not.toHaveAttribute('aria-label', /read-only/);
        await mode.click();
    }
});

test('selected agent stop uses parent call identity and locale switch preserves expansion', async ({ page }) => {
    await post(page, { type: 'startResponse' });
    for (const callId of ['older', 'live']) {
        await post(page, { type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'explore', description: callId }), callId });
        await post(page, { type: 'subagentState', callId, trace: trace(callId === 'older' ? 'done' : 'running', { description: callId }) });
    }
    await page.locator('.transcript-pane .step').last().locator(':scope > summary').click();
    await page.locator('.transcript-pane .subagent-open').last().click();
    const panel = page.locator('.agents-pane');
    await expect(panel.locator('.agent-group-heading')).toHaveText(['Active1', 'Finished1']);
    await expect(panel.locator('.agent-run-select').first().locator('strong')).toHaveText('live');
    await panel.locator('.agent-run-view:not(.panel-hidden) .agent-run-head .agent-run-stop').click();
    expect(await sent(page)).toContainEqual({ type: 'stopAgent', callId: 'live' });

    const view = panel.locator('.agent-run-view:not(.panel-hidden)');
    await view.locator('.step > summary').first().click();
    await post(page, { type: 'locale', locale: 'fa' });
    await expect(view.locator('.agent-state-text')).toContainText('در حال کار');
    await expect(view.locator('.agent-view-tabs button').first()).toContainText('گفتگو');
    await expect(view.locator('.detail-arguments summary').first()).toContainText('آرگومان ها');
    await expect(view.locator('.step').first()).toHaveAttribute('open', '');
});

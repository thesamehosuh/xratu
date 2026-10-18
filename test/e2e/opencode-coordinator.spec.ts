import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
test.beforeEach(async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const messages: object[] = [];
        Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: object) => messages.push(message), getState: () => undefined, setState: (value: unknown) => value }) });
    });
    await page.goto('/');
});

for (const locale of ['en', 'fa']) for (const width of [420, 1280]) {
    test(`native child decisions retain attribution and observation (${locale}, ${width})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await post(page, { type: 'locale', locale }); await post(page, { type: 'showChat' });
        await post(page, { type: 'restoreUser', value: 'Delegate the review' }); await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'general', description: 'Review permissions', prompt: 'Inspect the native adapter' }), callId: 'native-parent' });
        const trace = { taskId: 'native-child', profile: 'general', description: 'Review permissions', prompt: 'Inspect the native adapter', model: 'opencode/child-model', tools: [], resumed: false, status: 'waiting', startedAt: Date.now(), updatedAt: Date.now(), entries: [{ id: 'native-child:call', kind: 'tool', text: '{"path":"src/engine.ts"}', tool: 'read_file', output: 'Native child output', startedAt: Date.now(), endedAt: Date.now() }], toolCalls: 1, inputTokens: 10, outputTokens: 4, pendingTools: ['ask_user_question'] };
        await post(page, { type: 'subagentState', callId: 'native-parent', trace });
        const source = { parentCallId: 'native-parent', profile: 'general', description: 'Review permissions' };
        await post(page, { type: 'decisionRequest', decision_id: 'native-form', header: locale === 'en' ? 'Review scope' : 'محدوده بررسی', question: locale === 'en' ? 'Which area should the child inspect?' : 'زیرعامل کدوم بخش رو بررسی کنه؟', options: [{ label: 'Permissions' }, { label: 'Sessions' }], allowCustomAnswer: false, source });
        const card = page.locator('.decision-card.pending');
        await expect(card).toBeVisible();
        await page.screenshot({ path: info.outputPath('native-question.png') });
        await expect(card.locator('.approval-source')).toContainText('general');
        await expect(card.locator('.approval-source')).toContainText('Review permissions');
        expect(await card.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await card.locator('.approval-source button').click();
        await expect(page.locator('#surface-tab-agents')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.agents-pane')).toContainText('opencode/child-model');
        await expect(page.locator('.agents-pane .decision-card')).toHaveCount(0);
        await expect(page.locator('.agents-pane')).toContainText(locale === 'en' ? 'Awaiting answer' : 'منتظر پاسخ');
        await expect(page.locator('.agents-pane')).toContainText(locale === 'en' ? 'Answer question' : 'پاسخ به سوال');
        await page.screenshot({ path: info.outputPath('native-observation.png') });
        await page.locator('#surface-tab-conversation').click();
        await post(page, { type: 'decisionResolved', decision_id: 'native-form', answer: null });
        await expect(page.locator('.decision-card.pending')).toHaveCount(0);
        await post(page, { type: 'needsApproval', approval_id: 'native-approval', approvals: [{ tool_call_id: 'native-child:edit', tool_name: 'edit_file', args: { path: 'src/engine.ts' } }], source });
        await expect(page.locator('.approval-card .approval-source')).toContainText('general');
        await post(page, { type: 'approvalResolved', approval_id: 'native-approval', resolution: 'approved' });
        await expect(page.locator('.approval-card.pending')).toHaveCount(0);
        await post(page, { type: 'subagentState', callId: 'native-parent', trace: { ...trace, status: 'done', endedAt: Date.now(), report: 'Review finished' } });
        await expect(page.locator('.send-btn.is-stop')).toBeVisible();
        await post(page, { type: 'fullResponse', persian: 'Review finished', renderedHtml: '<p>Review finished</p>' });
        await expect(page.locator('.send-btn.is-stop')).toHaveCount(0);
    });
}

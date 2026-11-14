import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openWorkPanel } from './navigation';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
const navigation = async (page: Page) => {
    if (!await page.locator('.workspace-sidebar').isVisible()) await page.locator('.toolbar > .sidebar-toggle').click();
};

for (const theme of ['dark', 'light', 'app-dark'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`approved workspace and destinations (${theme}, ${locale}, ${width})`, async ({ page }) => {
        test.setTimeout(120_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await installVscodeTheme(page, theme === 'app-dark' ? 'light' : theme);
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(forceDark => {
            let saved: unknown = forceDark ? { surfaceAppearance: { scheme: 'dark', accent: 'violet' } } : undefined;
            const messages: unknown[] = [];
            Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => saved, setState: (state: unknown) => { saved = state; return state; } }) });
        }, theme === 'app-dark');
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'modelInfo', defaultModel: 'test-model', selectedModel: 'test-model', models: ['test-model', 'reasoning-model'], displayNames: { 'test-model': 'Test Model', 'reasoning-model': 'Reasoning Model' }, capabilities: { 'test-model': { provider: 'local', vision: true }, 'reasoning-model': { provider: 'local', noReasoning: false } } });
        await post(page, { type: 'gitStatusState', root: 'C:\\project\\xratu', status: { isRepo: true, branch: 'main', detached: false, upstream: null, ahead: 1, behind: 0, staged: 0, modified: 1, untracked: 0, conflicted: 0 } });
        const evidence = join(process.cwd(), 'output', 'playwright', 'approved-ui', `${theme}-${locale}-${width}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => {
            await page.mouse.move(width - 1, 0);
            if (theme === 'app-dark') {
                await expect(page.locator('.app')).toHaveCSS('color', 'rgb(212, 212, 212)');
                await expect(page.locator('.app')).toHaveAttribute('data-color-scheme', 'dark');
            }
            await page.screenshot({ path: join(evidence, `${name}.png`) });
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), name).toBeLessThanOrEqual(1);
        };
        const input = page.locator('.composer-input');
        await input.fill('A retained draft');
        await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 8); Object.assign(window, { __originalInput: element }); });
        await input.blur();
        await expect(page.locator('.dock-tabs.main')).toBeHidden();
        await expect(page.locator('.workspace-sidebar')).toHaveCount(0);
        await expect(page.locator('.composer')).toHaveCSS('border-radius', '11px');
        const composer = (await page.locator('.composer').boundingBox())!;
        expect(Math.abs(composer.y + composer.height / 2 - 450)).toBeLessThan(100);
        await shot('empty');
        await page.locator('.picker-chip').click();
        await expect(page.locator('.model-pop')).toBeVisible();
        await page.locator('.model-search input').fill('Reasoning');
        await expect(page.locator('.model-item')).toHaveCount(1);
        await shot('model-picker');
        await page.keyboard.press('Escape');
        await page.locator('.git-status').click();
        await post(page, { type: 'gitBranchesState', branches: ['main', 'feat/workspaces'], current: 'main' });
        await expect(page.locator('.branch-pop')).toBeVisible();
        await shot('branch-picker');
        await page.keyboard.press('Escape');
        await navigation(page);
        await expect(page.locator('.workspace-directory + .workspace-new')).toBeVisible();
        await shot('navigation');
        await page.locator('.toolbar > .sidebar-toggle').click();
        await post(page, { type: 'restoreUser', value: 'Inspect the implementation' });
        await expect(page.locator('.composer')).toHaveCSS('border-radius', '24px');
        await shot('collapsed');
        await input.focus();
        await expect(page.locator('.composer')).toHaveCSS('border-radius', '11px');
        expect(await input.evaluate(element => element === (window as unknown as { __originalInput: Element }).__originalInput)).toBe(true);
        expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
        await expect(input).toHaveValue('A retained draft');
        await shot('focused');
        await page.locator('[data-policy="approval"]').click();
        await expect(page.locator('.composer-policy-menu')).toBeVisible();
        await shot('permissions');
        await page.keyboard.press('Escape');
        // The user's explicit tab hide wins over subsequent work activity.
        await page.locator('.toolbar-tools button[aria-pressed]').first().click();
        await page.locator('.toolbar-tools button[aria-pressed]').first().click();
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'read' });
        await post(page, { type: 'toolResult', tool: 'read_file', output: 'export const a = 1;', callId: 'read' });
        await expect(page.locator('.dock-tabs.main')).toBeHidden();
        await shot('streaming');
        await post(page, { type: 'needsApproval', approval_id: 'approval', approvals: [{ tool_call_id: 'test', tool_name: 'run_terminal_command', args: { command: 'npm test' } }] });
        await input.blur();
        await expect(page.locator('.approval-card')).toBeVisible();
        await shot('approval');
        await post(page, { type: 'approvalResolved', approval_id: 'approval', resolution: 'approved' });
        await post(page, { type: 'fullResponse', persian: 'The implementation is ready.' });
        await expect(page.locator('.session-cost')).toHaveCount(0);
        await expect(page.locator('.completed-steps')).toBeVisible();
        await shot('completed');
        await page.locator('.completed-steps > summary').click();
        await shot('tools-expanded');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'error', value: 'Connection interrupted. Try again.' });
        await shot('failure');
        // Open and arrange panels directly; the input stays mounted.
        await expect(page.locator('.workspace-switcher')).toHaveCount(0);
        for (const panel of ['changes', 'agents', 'background']) {
            await openWorkPanel(page, panel);
            if (width >= 860) await page.locator(`#surface-tab-${panel}`).press(locale === 'fa' ? 'Control+Shift+ArrowLeft' : 'Control+Shift+ArrowRight');
            expect(await input.evaluate(element => element === (window as unknown as { __originalInput: Element }).__originalInput)).toBe(true);
            await shot(`panel-${panel}`);
        }
        await openWorkPanel(page, 'conversation');
        await post(page, { type: 'openSettings' });
        await post(page, { type: 'savedCredentials', credentials: [{ id: 'local', providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', maskedKey: '', label: 'Ollama', active: true }] });
        await post(page, { type: 'usageState', providers: [{ host: 'local', label: 'Ollama', iranian: false, input: 100, output: 20, cached: 0, USD: 0, IRT: 0 }], rates: [], history: [{ day: '2026-11-12', cells: [{ model: 'test-model', host: 'local', input: 100, output: 20, cached: 0, USD: 0, IRT: 0 }] }], allTime: { input: 100, output: 20, cached: 0, USD: 0, IRT: 0 } });
        await post(page, { type: 'proxyState', mode: 'auto', proxyUrl: '', noProxy: 'localhost,127.0.0.1', resolvedUrl: 'http://127.0.0.1:7890', resolvedSource: 'system', webSearchUseProxy: true });
        await post(page, { type: 'enginesState', state: { active: 'xratu', phase: 'ready', installedByXratu: true, busy: false } });
        await post(page, { type: 'mcpState', servers: [{ name: 'docs', command: 'npx', args: ['docs-server'], state: 'connected', toolCount: 2, lastError: null, source: 'workspace' }], hasWorkspace: true, legacyInUse: false });
        await post(page, { type: 'agentsState', profiles: [{ name: 'explore', description: 'Read-only project exploration.', source: 'builtin', editable: false }, { name: 'release', description: 'Release checks', source: 'project-xratu', editable: true, error: 'Unknown tool: Bash' }] });
        await post(page, { type: 'skillsState', skills: [{ id: 'review', name: 'review', description: 'Review project changes', dirPath: 'C:\\project\\.xratu\\skills\\review', source: 'project-xratu', enabled: true, bodyChars: 400 }] });
        await post(page, { type: 'mcpMarketplaceState', query: '', entries: [{ id: 'docs', source: 'curated', serverName: 'docs', name: 'Documentation', description: 'Search project documentation.', tags: [], install: { kind: 'stdio', command: 'npx', args: ['docs-server'], runtime: 'node' }, installConfidence: 'curated' }], sources: [], status: 'live', error: null, liveSearch: false });
        for (const section of ['providers', 'engines', 'mcp', 'marketplace', 'skills', 'agents', 'usage', 'proxy', 'appearance', 'settings']) {
            await navigation(page);
            await page.locator(`.sidebar-item[data-section="${section}"]`).click();
            await expect(page.locator('.page-content h2').first()).toBeVisible();
            await expect(page.locator('.engine-scope')).toHaveCount(0);
            await shot(`page-${section}`);
            for (const group of await page.locator('.page-content .lang-choice').all()) {
                await expect(group).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
                for (const inactive of await group.locator('.lang-chip:not(.active)').all()) await expect(inactive).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
            }
            if (['providers', 'mcp', 'skills', 'agents'].includes(section)) {
                const search = page.locator('.inventory-search input').first();
                await search.fill('no-matching-inventory-item');
                await expect(page.locator('.inventory-inspector')).toHaveCount(0);
                await expect(page.locator('.inventory-no-results')).toBeVisible();
                await shot(`page-${section}-no-results`);
                await search.fill('');
                await expect(page.locator('.inventory-inspector')).toHaveCount(1);
            }
            if (section === 'providers') {
                await expect(page.locator('.provider-comparison')).toHaveCount(0);
                await page.locator('.cred-head .page-add').click();
                await expect(page.locator('.compact-dialog')).toBeVisible();
                const bounds = (await page.locator('.compact-dialog').boundingBox())!;
                expect(bounds.width).toBeLessThanOrEqual(440);
                expect(Math.abs(bounds.x + bounds.width / 2 - width / 2)).toBeLessThan(2);
                await shot('connection-dialog');
                await page.locator('.cred-provider-box input').fill('Avalai');
                await expect(page.locator('.cred-provider-menu [role="option"]')).toHaveCount(1);
                await shot('connection-provider-picker');
                await page.keyboard.press('Enter');
                await expect(page.locator('.compact-dialog .cred-field input').nth(0)).toHaveValue('https://api.avalai.ir/v1');
                await page.keyboard.press('Escape');
                await expect(page.locator('.compact-dialog')).toHaveCount(0);
            }
            if (section === 'settings') {
                await navigation(page);
                const widths = await page.locator('.sidebar-item').evaluateAll(items => items.map(item => item.getBoundingClientRect().width));
                expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
                expect(Math.min(...widths)).toBeGreaterThan(width < 860 ? 240 : 190);
                await expect(page.locator('.sidebar-toggle')).toHaveCount(1);
                if (width < 860) await page.locator('.toolbar > .sidebar-toggle').click();
                await page.locator('.conversation-advanced > summary').click();
                await page.locator('#tx-progress').scrollIntoViewIfNeeded();
                await shot('settings-advanced');
                await page.locator('.preference-clear-history').scrollIntoViewIfNeeded();
                await shot('settings-local-data');
                await page.locator('#settings-language').click();
                await shot('settings-language-picker');
                await page.keyboard.press('Escape');
                const search = page.locator('.preference-search input');
                await search.fill(locale === 'en' ? 'timestamps' : 'زمان توی فعالیت');
                await expect(page.locator('.preference-section')).toHaveCount(1);
                await expect(page.locator('.conversation-advanced')).toHaveAttribute('open', '');
                await expect(page.getByRole('switch')).toHaveCount(1);
                await shot('settings-search');
                await search.fill(locale === 'en' ? 'thinking expanded' : 'فکر کردن باز');
                await expect(page.locator('#tx-reasoning')).toBeVisible();
                await expect(page.locator('.preference-section')).toHaveCount(1);
                await search.fill('no-such-preference');
                await expect(page.locator('.preference-no-results')).toBeVisible();
                await expect(page.locator('.preference-section')).toHaveCount(0);
                await search.fill('');
                await page.locator('.preference-clear-history').click();
                await expect(page.locator('.history-confirm')).toBeVisible();
                await expect(page.locator('.history-confirm-body p')).toBeVisible();
                await shot('settings-history-confirm');
                await page.keyboard.press('Escape');
                await expect(page.locator('.history-confirm')).toHaveCount(0);
                expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string }[] }).__xratuHostMessages.filter(message => message.type === 'clearAllSessions'))).toHaveLength(0);
                await page.locator('.preference-clear-history').click();
                await page.locator('.history-confirm .settings-danger-action').click();
                expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string }[] }).__xratuHostMessages.filter(message => message.type === 'clearAllSessions'))).toHaveLength(1);
            }

            if (section === 'mcp') {
                await page.locator('.servers-page .page-add').click();
                await expect(page.locator('.server-drawer.compact-dialog')).toBeVisible();
                await shot('server-dialog');
                await page.keyboard.press('Escape');
            }
            if (section === 'agents') {
                await page.locator('.agents-page .lang-chip').nth(1).click();
                await expect(page.locator('.agent-profile')).toHaveCount(1);
                await expect(page.locator('.agents-page .inventory-inspector h3')).toHaveText('release');
                await page.locator('.agents-page .lang-chip').first().click();
                await expect(page.locator('.agent-profile')).toHaveCount(2);
            }
            if (section === 'engines') await expect(page.locator('.engine-inspector')).toContainText('Test Model');
            if (section === 'proxy') {
                const accent = await page.locator('.route-node').first().evaluate(element => {
                    const probe = document.createElement('span');
                    probe.style.color = 'var(--surface-accent)';
                    element.appendChild(probe);
                    const color = getComputedStyle(probe).color;
                    probe.remove();
                    return color;
                });
                for (const icon of await page.locator('.route-node svg').all()) await expect(icon).toHaveCSS('color', accent);
            }
            if (section === 'usage') {
                await shot('page-usage-no-cost');
                await post(page, { type: 'usageState', providers: [
                    { host: 'api.openai.com', label: 'OpenAI', iranian: false, input: 1200000, output: 180000, cached: 0, USD: 3.61, IRT: 0 },
                    { host: 'api.anthropic.com', label: 'Anthropic', iranian: false, input: 600000, output: 60000, cached: 0, USD: 1.21, IRT: 0 },
                    { host: 'api.avalai.ir', label: 'Avalai', iranian: true, input: 420000, output: 52000, cached: 0, USD: 0, IRT: 128400 },
                    { host: 'localhost', label: 'Ollama', iranian: false, input: 88000, output: 12000, cached: 0, USD: 0, IRT: 0 },
                ], rates: [], history: [0.38, 0.61, 0.44, 0.89, 0.72, 0.96, 0.82].map((amount, index) => ({ day: `2026-11-${String(6 + index).padStart(2, '0')}`, cells: [
                    { model: 'GPT-4o', host: 'api.openai.com', input: 170000, output: 25000, cached: 0, USD: amount * 0.75, IRT: 0 },
                    { model: 'Claude Sonnet', host: 'api.anthropic.com', input: 85000, output: 8500, cached: 0, USD: amount * 0.25, IRT: 0 },
                    ...(index === 0 ? [{ model: 'GPT-4.1', host: 'api.avalai.ir', input: 420000, output: 52000, cached: 0, USD: 0, IRT: 128400 }, { model: 'local-model', host: 'localhost', input: 88000, output: 12000, cached: 0, USD: 0, IRT: 0 }] : []),
                ] })), allTime: { input: 2308000, output: 304000, cached: 0, USD: 4.82, IRT: 128400 } });
                await page.locator('.cost-granularity .usage-range').first().click();
                await page.locator('.usage-view-tabs button').last().click();
                await page.locator('.cost-currencies .usage-range').last().click();
                await page.locator('.usage-breakdown-tabs button').last().click();
                await expect(page.locator('.usage-input-total')).toBeVisible();
                await expect(page.locator('.usage-provider-list .prov-row')).toHaveCount(4);
                await expect(page.locator('.cost-col-total').first()).toHaveText('$0.38');
                await shot('page-usage');
            }
            if (section === 'appearance') {
                if (theme === 'app-dark') await expect(page.locator('.appearance-theme')).toHaveCount(0);
                else {
                    await page.locator('.appearance-theme button').click();
                    expect(await page.evaluate(() => (window as unknown as { __xratuHostMessages: { type: string }[] }).__xratuHostMessages.some(message => message.type === 'selectColorTheme'))).toBe(true);
                }
            }
        }
        await page.locator('.toolbar-back-work').click();
        await expect(input).toHaveValue('A retained draft');
        for (const destination of ['history', 'workspace']) {
            await navigation(page);
            await page.locator('.workspace-views').first().locator('button').nth(destination === 'history' ? 1 : 0).click();
            await post(page, { type: 'sessionList', currentId: 'current', items: [{ id: 'current', title: 'Current project work', workspace: 'C:\\project\\xratu', engineId: 'xratu', model: 'test-model', updatedAt: Date.now() }, { id: 'native', title: 'Earlier native work', workspace: 'C:\\project\\xratu', engineId: 'opencode', model: 'native-model', updatedAt: Date.now() - 172800000 }] });
            await expect(page.locator('.session-destination-row')).toHaveCount(2);
            if (destination === 'history') await expect(page.locator('.history-group > h3')).toHaveCount(2);
            await shot(`page-${destination}`);
            await page.locator('.toolbar-back-work').click();
        }
        await post(page, { type: 'showWelcome' });
        await expect(page.locator('.onboarding')).toBeVisible();
        await expect(page.locator('.setup-shell')).toHaveCSS('display', 'flex');
        await expect(page.locator('.setup-steps')).toHaveCSS('flex-direction', 'row');
        expect((await page.locator('.setup-shell').boundingBox())!.width).toBeLessThanOrEqual(480);
        await shot('page-welcome');
        expect(errors).toEqual([]);
    });
}

test('one saved layout preserves manual docking and ignores retired workspace presets', async ({ page }) => {
    await installVscodeTheme(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
        const legacyLayout = { version: 4, main: ['conversation', 'browser'], side: ['changes', 'activity', 'agents', 'background', 'downloads', 'pullRequests'], mainActive: 'conversation', sideActive: 'changes' };
        let saved: Record<string, unknown> = JSON.parse(sessionStorage.getItem('single-layout') ?? JSON.stringify({
            unrelated: 'retained', surfaceLayout: legacyLayout, surfaceOpenedPanels: ['browser'], surfaceTabsVisible: true,
            surfaceSideOpen: true, surfaceWorkspace: 'control', surfaceLayoutPreset: 'control',
            surfaceWorkspaces: { control: { layout: { ...legacyLayout, main: ['conversation'], side: ['agents'] }, opened: ['agents'], sideOpen: true, tabsChoice: true } },
        }));
        Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => saved, setState: (state: Record<string, unknown>) => { saved = state; sessionStorage.setItem('single-layout', JSON.stringify(state)); } }) });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.workspace-switcher')).toHaveCount(0);
    await expect(page.locator('.toolbar-product-name')).toHaveText('Xratu');
    const input = page.locator('.composer-input');
    await input.fill('Preserve my draft');
    await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 8); });
    await page.evaluate(() => Object.assign(window, { originalInput: document.querySelector('.composer-input'), originalBrowser: document.querySelector('.browser-pane') }));
    await openWorkPanel(page, 'browser');
    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowRight']) await page.locator('#surface-tab-browser').press(`Control+Shift+${key}`);
    await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Preserve my draft');
    expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
    expect(await page.evaluate(() => {
        const state = window as unknown as { originalInput: Element; originalBrowser: Element };
        return document.querySelector('.composer-input') === state.originalInput && document.querySelector('.browser-pane') === state.originalBrowser;
    })).toBe(true);
    await page.locator('.toolbar-tools').getByRole('button', { name: 'Toggle work tabs', exact: true }).click();
    await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'read' });
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceTabsVisible)).toBe(false);
    const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceLayout);
    await page.reload();
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.browser-pane.panel-side')).toBeVisible();
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).surfaceLayout)).toEqual(before);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('single-layout')!).unrelated)).toBe('retained');
    await page.locator('.toolbar-tools').getByRole('button', { name: 'Toggle work tabs', exact: true }).click();
    await page.locator('.dock-tabs.main .dock-layout-button').click();
    await page.getByRole('menuitem', { name: 'Reset layout', exact: true }).click();
    await expect(page.locator('.dock-tabs.main')).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
        const state = JSON.parse(sessionStorage.getItem('single-layout')!);
        return { sideOpen: state.surfaceSideOpen, tabs: state.surfaceTabsVisible, opened: state.surfaceOpenedPanels, agentsInMain: state.surfaceLayout.main.includes('agents'), agentsInSide: state.surfaceLayout.side.includes('agents') };
    })).toEqual({ sideOpen: false, tabs: null, opened: [], agentsInMain: true, agentsInSide: false });
});

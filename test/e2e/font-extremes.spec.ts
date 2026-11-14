import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation, openWorkPanel } from './navigation';

const post = (page: Page, value: object) => page.evaluate(message => window.postMessage(message, '*'), value);
const choose = async (page: Page, id: string, index: number) => {
    const trigger = page.locator(`#appearance-${id}`);
    await trigger.click();
    await page.getByRole('option').nth(index).click();
};
const profiles = [
    { name: 'interface-small', font: 0, text: 0, code: 0, width: 0, density: 1 },
    { name: 'interface-large', font: 0, text: 3, code: 3, width: 2, density: 0 },
    { name: 'editor-small', font: 1, text: 0, code: 3, width: 2, density: 1 },
    { name: 'editor-large', font: 1, text: 3, code: 0, width: 0, density: 0 },
] as const;

const controlsFit = async (page: Page) => {
    const failures = await page.evaluate(() => {
        const failures: string[] = [];
        const context = document.createElement('canvas').getContext('2d')!;
        for (const button of document.querySelectorAll('button,[role=tab]')) {
            if (!(button as HTMLElement).checkVisibility() || !button.getBoundingClientRect().height) continue;
            if (button.textContent?.trim() && button.scrollHeight > button.clientHeight + 1) failures.push(`${button.className}: control clips vertically`);
            for (const label of [button, ...button.querySelectorAll('span')]) {
                const text = [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
                if (!text) continue;
                const css = getComputedStyle(label);
                context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                const metrics = context.measureText(text);
                if (parseFloat(css.lineHeight) + .5 < metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) failures.push(`${button.className}: font metrics exceed line height`);
            }
        }
        for (const element of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([type=file]):not([type=checkbox]):not([type=range]),select')) {
            if (element.type === 'color' || !element.checkVisibility() || !element.clientHeight) continue;
            const text = element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent : element.value || element.placeholder;
            if (!text) continue;
            const css = getComputedStyle(element);
            context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
            const ink = context.measureText(text);
            const space = element.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
            if (ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent > space + 1) failures.push(`${element.id || element.className}: field clips visible glyphs`);
        }
        if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('Document overflows horizontally');
        return failures;
    });
    expect(failures).toEqual([]);
};

for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) for (const profile of profiles) {
    test(`font extremes (${theme}, ${locale}, ${width}, ${profile.name})`, async ({ page }) => {
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await installVscodeTheme(page, theme);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(() => {
            let state: unknown;
            const messages: unknown[] = [];
            Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ getState: () => state, setState: (value: unknown) => { state = value; }, postMessage: (message: unknown) => messages.push(message) }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'modelInfo', defaultModel: 'test-model', selectedModel: 'test-model', models: ['test-model', 'long-reasoning-model'], capabilities: { 'test-model': { vision: true }, 'long-reasoning-model': { noReasoning: false } } });
        const input = page.locator('.composer-input');
        const draft = locale === 'en' ? 'Keep this draft.\nSecond line here.\nThird line stays.' : 'پیش نویس بمونه.\nخط دوم اینجاست.\nخط سوم هم بمونه.';
        await input.fill(draft);
        await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 8); Object.assign(window, { fontInput: element, fontBrowser: document.querySelector('.browser-pane') }); });
        const navigate = async (section: string) => { await openPageNavigation(page); await page.locator(`.sidebar-item[data-section="${section}"]`).click(); };
        await post(page, { type: 'openSettings' });
        await post(page, { type: 'mcpState', servers: [], hasWorkspace: true, legacyInUse: false });
        await navigate('mcp');
        await page.locator('.servers-page .page-add').click();
        const scopeLabelSize = await page.locator('.mcp-target-row .mcp-field-label').evaluate(element => getComputedStyle(element).fontSize);
        await page.keyboard.press('Escape');
        await navigate('appearance');
        await choose(page, 'font', profile.font);
        await choose(page, 'text-size', profile.text);
        await choose(page, 'code-size', profile.code);
        await choose(page, 'width', profile.width);
        await choose(page, 'density', profile.density);
        await page.evaluate(() => document.fonts.ready);
        await controlsFit(page);
        await page.locator('.toolbar-back-work').click();
        await input.focus();
        const textSize = profile.text === 0 ? 12 : 18;
        await expect(input).toHaveCSS('font-size', `${textSize}px`);
        if (profile.font === 1) await expect(input).toHaveCSS('font-family', /Consolas/);
        await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight), { message: 'short draft grows after font changes' }).toBeLessThanOrEqual(1);
        expect(await input.evaluate(element => element === (window as unknown as { fontInput: Element }).fontInput)).toBe(true);
        expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
        await expect(input).toHaveValue(draft);
        const evidence = join(process.cwd(), 'output', 'playwright', 'font-extremes', `${theme}-${locale}-${width}-${profile.name}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => { await page.mouse.move(width - 1, 0); await controlsFit(page); await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' }); };
        await shot('empty-focused');
        await post(page, { type: 'restoreUser', value: `${draft}\nC:\\projects\\xratu\\${'long-project-directory-'.repeat(8)}index.ts` });
        await input.blur();
        await expect(page.locator('.composer')).toHaveCSS('border-radius', '24px');
        const lineFits = await input.evaluate(element => {
            const css = getComputedStyle(element);
            return element.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) + .5 >= parseFloat(css.lineHeight);
        });
        expect(lineFits, 'collapsed composer must show a whole line at the selected size').toBe(true);
        const centers = await input.evaluate(element => {
            const input = element.getBoundingClientRect();
            const icon = element.closest('.composer')!.querySelector('.send-btn')!.getBoundingClientRect();
            return Math.abs(input.y + input.height / 2 - icon.y - icon.height / 2);
        });
        expect(centers, 'collapsed action stays centered as the font grows').toBeLessThanOrEqual(1);
        await shot('collapsed');
        await input.focus();
        await page.locator('.picker-chip').click();
        await expect(page.locator('.model-pop')).toBeVisible();
        await shot('model-picker');
        await page.keyboard.press('Escape');
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'chunk', value: `${draft}\n${draft}` });
        await shot('streaming');
        await post(page, { type: 'needsApproval', approval_id: 'font-approval', approvals: [{ tool_call_id: 'font-call', tool_name: 'run_terminal_command', args: { command: `npm test -- ${'long-project-name-'.repeat(8)}` } }] });
        await expect(page.locator('.approval-card')).toBeVisible();
        await shot('approval');
        await post(page, { type: 'approvalResolved', approval_id: 'font-approval', resolution: 'approved' });
        await post(page, { type: 'decisionRequest', decision_id: 'font-question', header: 'Scope', question: draft, options: [{ label: 'Project', description: draft }, { label: 'Everywhere', description: draft }] });
        await expect(page.locator('.decision-option').first()).toBeVisible();
        await shot('question');
        await page.locator('.decision-option').first().click();
        await post(page, { type: 'decisionResolved', decision_id: 'font-question', answer: 'Project' });
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'font-read' });
        await post(page, { type: 'toolResult', tool: 'read_file', callId: 'font-read', output: `[src/example.ts - lines 9998-10001 of 20000]\nconst value = '${'long-value-'.repeat(50)}';\nconst second = true;\nconst third = true;\nconst fourth = true;` });
        const work = page.locator('.conversation-work-group');
        if (!await work.evaluate(element => (element as HTMLDetailsElement).open)) await work.locator(':scope > summary').click();
        const tool = work.locator('.step').last();
        if (!await tool.evaluate(element => (element as HTMLDetailsElement).open)) await tool.locator(':scope > summary').click();
        await expect(tool.locator('.detail-source-line, .detail-output').first()).toHaveCSS('font-size', profile.code === 0 ? '12px' : '16px');
        const gutters = await tool.locator('.detail-line-number').evaluateAll(elements => elements.map(element => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
            return { width: box.width, fits: text.left >= box.left - 1 && text.right <= box.right + 1 };
        }));
        expect(gutters.length).toBe(4);
        expect(gutters.every(gutter => gutter.fits)).toBe(true);
        expect(Math.max(...gutters.map(gutter => gutter.width)) - Math.min(...gutters.map(gutter => gutter.width))).toBeLessThanOrEqual(1);
        await shot('tool-output');
        const html = `<h2>${draft.split('\n')[0]}</h2><p>${draft.replaceAll('\n', '<br>')}</p><blockquote><p>${draft}</p></blockquote><ul><li><code>${'long-project-path-'.repeat(20)}</code></li></ul><table><thead><tr><th>Project</th><th>Result</th></tr></thead><tbody><tr><td>${'long-project-directory-'.repeat(20)}</td><td>${draft}</td></tr></tbody></table><div class="code-block"><div class="code-header"><span class="code-title">TypeScript</span></div><div class="code-surface"><pre dir="ltr"><code>${'const project = "xratu";\n'.repeat(15)}</code></pre></div></div>`;
        await post(page, { type: 'fullResponse', persian: draft, renderedHtml: html });
        await expect(page.locator('.completed-steps')).toBeVisible();
        await page.locator('.completed-steps > summary').click();
        await expect(page.locator('.msg-content').last()).toHaveCSS('font-size', `${textSize}px`);
        await expect(page.locator('.code-surface pre').last()).toHaveCSS('font-size', profile.code === 0 ? '12px' : '16px');
        if (profile.font === 1) await expect(page.locator('.msg-content').last()).toHaveCSS('font-family', /Consolas/);
        await shot('completed');
        await input.fill(locale === 'en' ? 'Retain this draft while I inspect font sizes and return to the same conversation.' : 'این پیش نویس رو نگه دار تا اندازه فونت ها رو بررسی کنم و دوباره به همین گفتگو برگردم.');
        const originalWidth = width;
        if (width === 1440) await page.setViewportSize({ width: 420, height: 960 });
        await input.focus();
        await expect.poll(() => input.evaluate(element => element.scrollHeight - element.clientHeight), { message: 'resizing reflows a draft without an unnecessary internal scrollbar' }).toBeLessThanOrEqual(1);
        await shot('reflow');
        if (originalWidth !== 420) await page.setViewportSize({ width: originalWidth, height: 960 });
        await post(page, { type: 'openSettings' });
        await navigate('appearance');
        await page.locator('.appearance-preview').scrollIntoViewIfNeeded();
        await shot('appearance-preview');
        for (const section of ['settings', 'providers', 'engines', 'skills', 'usage', 'proxy']) {
            await navigate(section);
            await shot(`page-${section}`);
        }
        await post(page, { type: 'mcpState', servers: [], hasWorkspace: true, legacyInUse: false });
        await navigate('mcp');
        await page.locator('.servers-page .page-add').click();
        await expect(page.locator('.mcp-target-row .mcp-field-label')).toHaveCSS('font-size', scopeLabelSize);
        await shot('mcp-dialog');
        await page.keyboard.press('Escape');
        await openPageNavigation(page);
        await shot('sidebar');
        expect(await page.evaluate(() => document.querySelector('.browser-pane') === (window as unknown as { fontBrowser: Element }).fontBrowser)).toBe(true);
        expect(errors).toEqual([]);
    });
}

for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`large code stays readable in Changes and Background (${locale}, ${width})`, async ({ page }, info) => {
        await installVscodeTheme(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(() => {
            const messages: Record<string, unknown>[] = [];
            Object.assign(window, { __xratuHostMessages: messages, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => messages.push(message), getState: () => ({ surfaceAppearance: { textSize: 18, codeSize: 16, font: 'editor' } }), setState: (value: unknown) => value }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        const input = page.locator('.composer-input');
        await input.fill('Keep this draft through code panels');
        await input.evaluate(element => Object.assign(window, { largeCodeInput: element }));
        await post(page, { type: 'restoreUser', value: 'Inspect the change', cp: 'a'.repeat(40) });
        const latest = async (type: string) => {
            const get = () => page.evaluate(type => (window as unknown as { __xratuHostMessages: Record<string, unknown>[] }).__xratuHostMessages.filter(message => message.type === type).at(-1), type);
            await expect.poll(get).toBeTruthy();
            return (await get())!;
        };
        await openWorkPanel(page, 'changes');
        const changes = await latest('changesGetState');
        await post(page, { ...changes, type: 'changesState', files: [{ path: 'src/example.ts', added: 1, removed: 1, binary: false }] });
        const file = await latest('changeFileGet');
        await post(page, { ...file, type: 'changeFileState', file: { path: 'src/example.ts', kind: 'text', before: 'const oldValue = true;', after: `const newValue = '${'long-value-'.repeat(30)}';`, hunks: [{ oldStart: 10000, oldCount: 1, newStart: 10000, newCount: 1, removedLines: ['const oldValue = true;'], addedLines: [`const newValue = '${'long-value-'.repeat(30)}';`] }] } });
        await expect(page.locator('.review-diff .pill-diff-code').first()).toHaveCSS('font-size', '16px');
        await controlsFit(page);
        await page.screenshot({ path: info.outputPath('large-diff.png') });
        await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'font-job', command: 'npm run dev', running: true, uptimeSeconds: 10, output: 'Ready at http://localhost:5173\n'.repeat(40) }] });
        await openWorkPanel(page, 'background');
        await expect(page.locator('.background-output')).toHaveCSS('font-size', '16px');
        await expect(page.locator('.background-output')).toContainText('Ready at');
        await controlsFit(page);
        await page.screenshot({ path: info.outputPath('large-background.png') });
        await openWorkPanel(page, 'conversation');
        await expect(input).toHaveValue('Keep this draft through code panels');
        expect(await input.evaluate(element => element === (window as unknown as { largeCodeInput: Element }).largeCodeInput)).toBe(true);
    });
}

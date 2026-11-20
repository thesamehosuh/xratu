import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation, openWorkPanel } from './navigation';

const post = (page: Page, value: object) => page.evaluate((message) => window.postMessage(message, '*'), value);
const choose = async (page: Page, id: string, index: number) => {
    await page.locator(`#appearance-${id}`).click();
    await page.getByRole('option').nth(index).click();
};

const controlsFit = async (page: Page) => {
    const failures = await page.evaluate(() => {
        const failures: string[] = [];
        const context = document.createElement('canvas').getContext('2d')!;
        for (const button of document.querySelectorAll('button,[role=tab]')) {
            if (!(button as HTMLElement).checkVisibility() || !button.getBoundingClientRect().height) continue;
            if (button.textContent?.trim() && button.scrollHeight > button.clientHeight + 1) failures.push(`${button.className}: control clips vertically`);
            for (const label of [button, ...button.querySelectorAll('span')]) {
                const text = [...label.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim();
                if (!text) continue;
                const css = getComputedStyle(label);
                context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                const metrics = context.measureText(text);
                const line = css.lineHeight === 'normal' ? parseFloat(css.fontSize) * 1.2 : parseFloat(css.lineHeight);
                if (line + 0.5 < metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) {
                    failures.push(`${button.className}: font metrics exceed line height`);
                }
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
            if (ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent > space + 1) {
                failures.push(`${element.id || element.className}: field clips visible glyphs`);
            }
        }
        if (document.documentElement.scrollWidth > innerWidth + 1) failures.push('Document overflows horizontally');
        return failures;
    });
    expect(failures).toEqual([]);
};

for (const [locale, width, profile] of [
    ['en', 1280, { font: 0, text: 0, code: 0, width: 0, density: 1 }],
    ['en', 420, { font: 1, text: 3, code: 3, width: 2, density: 0 }],
    ['fa', 420, { font: 1, text: 3, code: 3, width: 2, density: 0 }],
] as const) {
    test(`font extremes fit controls, composer, gutters, and settings (${locale}, ${width}px, text=${profile.text})`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await installVscodeTheme(page, 'dark');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(() => {
            let state: unknown;
            const messages: unknown[] = [];
            Object.assign(window, {
                __xratuHostMessages: messages,
                acquireVsCodeApi: () => ({
                    getState: () => state,
                    setState: (value: unknown) => { state = value; },
                    postMessage: (message: unknown) => messages.push(message),
                }),
            });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await post(page, {
            type: 'modelInfo',
            defaultModel: 'test-model',
            selectedModel: 'test-model',
            models: ['test-model', 'long-reasoning-model'],
            capabilities: { 'test-model': { vision: true }, 'long-reasoning-model': { noReasoning: false } },
        });
        const input = page.locator('.composer-input');
        const draft = locale === 'en' ? 'Keep this draft.\nSecond line here.\nThird line stays.' : 'پیش نویس بمونه.\nخط دوم اینجاست.\nخط سوم هم بمونه.';
        await input.fill(draft);
        await input.evaluate((el) => {
            (el as HTMLTextAreaElement).setSelectionRange(2, 8);
            Object.assign(window, { fontInput: el, fontBrowser: document.querySelector('.browser-pane') });
        });

        const navigate = async (section: string) => {
            await openPageNavigation(page);
            await page.locator(`.sidebar-item[data-section="${section}"]`).click();
        };
        await post(page, { type: 'openSettings' });
        await post(page, { type: 'mcpState', servers: [], hasWorkspace: true, legacyInUse: false });
        await navigate('mcp');
        await page.locator('.servers-page .page-add').click();
        const scopeLabelSize = await page.locator('.mcp-target-row .mcp-field-label').evaluate((el) => getComputedStyle(el).fontSize);
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
        await expect.poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
        expect(await input.evaluate((el) => el === (window as unknown as { fontInput: Element }).fontInput)).toBe(true);
        expect(await input.evaluate((el) => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
        await expect(input).toHaveValue(draft);

        await post(page, { type: 'restoreUser', value: `${draft}\nC:\\projects\\xratu\\${'long-project-directory-'.repeat(8)}index.ts` });
        await input.blur();
        const lineFits = await input.evaluate((el) => {
            const css = getComputedStyle(el);
            return el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom) + 0.5 >= parseFloat(css.lineHeight);
        });
        expect(lineFits, 'collapsed composer must show a whole line at the selected size').toBe(true);
        const centers = await input.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const icon = el.closest('.composer')!.querySelector('.send-btn')!.getBoundingClientRect();
            return Math.abs(box.y + box.height / 2 - icon.y - icon.height / 2);
        });
        expect(centers, 'collapsed action stays centered as the font grows').toBeLessThanOrEqual(1);
        await controlsFit(page);

        await post(page, { type: 'startResponse' });
        await post(page, { type: 'toolCall', tool: 'read_file', args: '{"path":"src/example.ts"}', callId: 'font-read' });
        await post(page, { type: 'toolResult', tool: 'read_file', callId: 'font-read', output: `[src/example.ts - lines 9998-10001 of 20000]\nconst value = '${'long-value-'.repeat(40)}';\nconst second = true;\nconst third = true;\nconst fourth = true;` });
        const work = page.locator('.conversation-work-group');
        if (!await work.evaluate((el) => (el as HTMLDetailsElement).open)) await work.locator(':scope > summary').click();
        const tool = work.locator('.step').last();
        if (!await tool.evaluate((el) => (el as HTMLDetailsElement).open)) await tool.locator(':scope > summary').click();
        await expect(tool.locator('.detail-source-line, .detail-output').first()).toHaveCSS('font-size', profile.code === 0 ? '12px' : '16px');
        const gutters = await tool.locator('.detail-line-number').evaluateAll((elements) => elements.map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const text = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return { width: box.width, fits: text.left >= box.left - 1 && text.right <= box.right + 1 };
        }));
        expect(gutters.length).toBe(4);
        expect(gutters.every((g) => g.fits)).toBe(true);
        expect(Math.max(...gutters.map((g) => g.width)) - Math.min(...gutters.map((g) => g.width))).toBeLessThanOrEqual(1);

        await post(page, { type: 'fullResponse', persian: draft });
        await expect(page.locator('.msg-content').last()).toHaveCSS('font-size', `${textSize}px`);
        if (width > 420) {
            await page.setViewportSize({ width: 420, height: 960 });
            await input.focus();
            await expect.poll(() => input.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
            await page.setViewportSize({ width, height: 960 });
        }

        await post(page, { type: 'openSettings' });
        await navigate('mcp');
        await page.locator('.servers-page .page-add').click();
        await expect(page.locator('.mcp-target-row .mcp-field-label')).toHaveCSS('font-size', scopeLabelSize);
        await controlsFit(page);
        await page.keyboard.press('Escape');
        expect(await page.evaluate(() => document.querySelector('.browser-pane') === (window as unknown as { fontBrowser: Element }).fontBrowser)).toBe(true);
        expect(errors).toEqual([]);
    });
}

test('large code stays readable in Changes and Background without losing draft', async ({ page }) => {
    await installVscodeTheme(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 420, height: 960 });
    await page.addInitScript(() => {
        const messages: Record<string, unknown>[] = [];
        Object.assign(window, {
            __xratuHostMessages: messages,
            acquireVsCodeApi: () => ({
                postMessage: (message: Record<string, unknown>) => messages.push(message),
                getState: () => ({ surfaceAppearance: { textSize: 18, codeSize: 16, font: 'editor' } }),
                setState: (value: unknown) => value,
            }),
        });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'fa' });
    await post(page, { type: 'showChat' });
    const input = page.locator('.composer-input');
    await input.fill('Keep this draft through code panels');
    await input.evaluate((el) => Object.assign(window, { largeCodeInput: el }));
    await post(page, { type: 'restoreUser', value: 'Inspect the change', cp: 'a'.repeat(40) });
    const latest = async (type: string) => {
        const get = () => page.evaluate((t) => (window as unknown as { __xratuHostMessages: Record<string, unknown>[] }).__xratuHostMessages.filter((m) => m.type === t).at(-1), type);
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
    await post(page, { type: 'backgroundJobs', jobs: [{ jobId: 'font-job', command: 'npm run dev', running: true, uptimeSeconds: 10, output: 'Ready at http://localhost:5173\n'.repeat(40) }] });
    await openWorkPanel(page, 'background');
    await expect(page.locator('.background-output')).toHaveCSS('font-size', '16px');
    await expect(page.locator('.background-output')).toContainText('Ready at');
    await controlsFit(page);
    await openWorkPanel(page, 'conversation');
    await expect(input).toHaveValue('Keep this draft through code panels');
    expect(await input.evaluate((el) => el === (window as unknown as { largeCodeInput: Element }).largeCodeInput)).toBe(true);
});

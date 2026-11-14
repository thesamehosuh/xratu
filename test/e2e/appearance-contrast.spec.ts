import { expect, test } from '@playwright/test';
import { installVscodeTheme, VSCODE_DARK_TOKENS, VSCODE_LIGHT_TOKENS } from './vscodeTheme';
import { openPageNavigation } from './navigation';

for (const editor of ['light', 'dark'] as const) for (const scheme of ['editor', 'dark'] as const) {
    test(`light and dark elements adjust independently (${editor}, ${scheme})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(tokens => {
            document.addEventListener('DOMContentLoaded', () => {
                document.getElementById('xratu-vscode-theme')?.remove();
                for (const [name, value] of Object.entries(tokens)) document.body.style.setProperty(name, value);
            });
        }, editor === 'light' ? { ...VSCODE_LIGHT_TOKENS, '--vscode-editor-background': '#e0e0e0' } : VSCODE_DARK_TOKENS);
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => state = next, postMessage: () => {} }) });
        });
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        if (scheme === 'dark') {
            await page.locator('#appearance-scheme').click();
            await page.getByRole('option').nth(1).click();
        }
        const dark = editor === 'dark' || scheme === 'dark';
        const colors = () => page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d')!;
            const channels = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
            return { foreground: channels(getComputedStyle(document.querySelector('.appearance-page')!).color), background: channels(getComputedStyle(document.querySelector('.page-layout')!).backgroundColor) };
        });
        const baseline = await colors();
        const light = page.locator('#appearance-lightContrast');
        const darkSlider = page.locator('#appearance-darkContrast');
        await light.focus();
        for (let i = 0; i < 50; i++) await light.press('ArrowRight');
        const halfwayLight = await colors();
        const initialLight = dark ? baseline.foreground : baseline.background;
        (dark ? halfwayLight.foreground : halfwayLight.background).forEach((channel, i) => expect(Math.abs(channel - (initialLight[i] + 255) / 2)).toBeLessThanOrEqual(1));
        await light.press('End');
        const lighter = await colors();
        expect(dark ? lighter.foreground : lighter.background).toEqual([255, 255, 255]);
        expect(dark ? lighter.background : lighter.foreground).toEqual(dark ? baseline.background : baseline.foreground);
        await darkSlider.focus();
        for (let i = 0; i < 50; i++) await darkSlider.press('ArrowRight');
        const halfwayDark = await colors();
        const initialDark = dark ? baseline.background : baseline.foreground;
        (dark ? halfwayDark.background : halfwayDark.foreground).forEach((channel, i) => expect(Math.abs(channel - initialDark[i] / 2)).toBeLessThanOrEqual(1));
        await darkSlider.press('End');
        const both = await colors();
        expect(dark ? both.background : both.foreground).toEqual([0, 0, 0]);
        expect(dark ? both.foreground : both.background).toEqual(dark ? lighter.foreground : lighter.background);
        await light.press('Home');
        const darker = await colors();
        expect(dark ? darker.foreground : darker.background).toEqual(dark ? baseline.foreground : baseline.background);
        expect(dark ? darker.background : darker.foreground).toEqual([0, 0, 0]);
    });
}

test('keeps separate contrast preferences when the host theme changes live', async ({ page }) => {
    await installVscodeTheme(page, 'dark');
    await page.addInitScript(() => {
        let state: object = {};
        Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => state = next, postMessage: () => {} }) });
    });
    await page.goto('/');
    await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
    await openPageNavigation(page);
    await page.locator('[data-section=appearance]').click();
    const app = page.locator('.appearance-page');
    await page.locator('#appearance-lightContrast').press('End');
    await expect(app).toHaveCSS('color', 'color(srgb 1 1 1)');
    await page.evaluate(tokens => {
        document.getElementById('xratu-vscode-theme')?.remove();
        for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
        document.body.classList.replace('vscode-dark', 'vscode-light');
        document.body.dataset.vscodeThemeKind = 'vscode-light';
    }, VSCODE_LIGHT_TOKENS);
    await expect(app).toHaveCSS('color', 'color(srgb 0.231373 0.231373 0.231373)');
    await page.locator('#appearance-darkContrast').press('End');
    await expect(app).toHaveCSS('color', 'color(srgb 0 0 0)');
    await expect(page.locator('#appearance-lightContrast')).toHaveValue('100');
    await page.evaluate(tokens => {
        for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
        document.body.classList.replace('vscode-light', 'vscode-dark');
        document.body.dataset.vscodeThemeKind = 'vscode-dark';
    }, VSCODE_DARK_TOKENS);
    await expect(app).toHaveCSS('color', 'color(srgb 1 1 1)');
    await expect(page.locator('#appearance-darkContrast')).toHaveValue('100');
});

for (const editor of ['light', 'dark'] as const) for (const scheme of ['editor', 'dark'] as const) {
    test(`inset retains its baseline and follows only its surface slider (${editor}, ${scheme})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(() => Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }) }));
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        if (scheme === 'dark') { await page.locator('#appearance-scheme').click(); await page.getByRole('option').nth(1).click(); }
        await page.evaluate(() => { const el = document.createElement('div'); el.style.background = 'var(--xratu-surface-inset)'; el.id = 'contrast-inset-probe'; document.querySelector('.appearance-page')!.append(el); });
        const color = () => page.locator('#contrast-inset-probe').evaluate(el => {
            const ctx = document.createElement('canvas').getContext('2d')!; ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        });
        const baseline = await color();
        const isDark = editor === 'dark' || scheme === 'dark';
        const surface = page.locator(isDark ? '#appearance-darkContrast' : '#appearance-lightContrast');
        const opposite = page.locator(isDark ? '#appearance-lightContrast' : '#appearance-darkContrast');
        await opposite.press('End');
        expect(await color()).toEqual(baseline);
        await opposite.press('Home');
        await surface.press('ArrowRight');
        (await color()).forEach((channel, i) => expect(Math.abs(channel - baseline[i])).toBeLessThanOrEqual(3));
        await surface.press('End');
        expect(await color()).toEqual(isDark ? [0, 0, 0] : [255, 255, 255]);
    });

    test(`muted and border tones respond independently (${editor}, ${scheme})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(() => Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }) }));
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        if (scheme === 'dark') { await page.locator('#appearance-scheme').click(); await page.getByRole('option').nth(1).click(); }
        const colors = () => page.evaluate(() => {
            const style = getComputedStyle(document.querySelector('.appearance-page')!); const ctx = document.createElement('canvas').getContext('2d')!;
            return ['--page-muted', '--page-line'].map(token => { ctx.fillStyle = style.getPropertyValue(token).trim(); ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); });
        });
        const base = await colors();
        const isDark = editor === 'dark' || scheme === 'dark';
        const ink = page.locator(isDark ? '#appearance-lightContrast' : '#appearance-darkContrast');
        const surface = page.locator(isDark ? '#appearance-darkContrast' : '#appearance-lightContrast');
        await ink.press('End');
        const inkOnly = await colors();
        expect(inkOnly[1]).toEqual(base[1]);
        expect(inkOnly[0]).not.toEqual(base[0]);
        await ink.press('Home'); await surface.press('End');
        const surfaceOnly = await colors();
        expect(surfaceOnly[0]).toEqual(base[0]);
        expect(surfaceOnly[1]).not.toEqual(base[1]);
    });

    if (scheme === 'dark') test(`forced dark input widget and code surfaces follow dark slider (${editor})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(() => Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }) }));
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        await page.locator('#appearance-scheme').click(); await page.getByRole('option').nth(1).click();
        const colors = () => page.evaluate(() => {
            const style = getComputedStyle(document.querySelector('.appearance-page')!);
            const ctx = document.createElement('canvas').getContext('2d')!;
            return ['--vscode-input-background', '--vscode-editorWidget-background', '--vscode-textCodeBlock-background'].map(token => { ctx.fillStyle = style.getPropertyValue(token).trim(); ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); });
        });
        const baseline = await colors();
        await page.locator('#appearance-lightContrast').press('End');
        expect(await colors()).toEqual(baseline);
        await page.locator('#appearance-darkContrast').press('End');
        expect(await colors()).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    });
}

for (const editor of ['light', 'dark'] as const) for (const scheme of ['editor', 'dark'] as const) {
    test(`maximum surface contrast keeps borders visible (${editor}, ${scheme})`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        await page.addInitScript(() => Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }) }));
        await page.goto('/');
        await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();
        if (scheme === 'dark') { await page.locator('#appearance-scheme').click(); await page.getByRole('option').nth(1).click(); }
        const slider = page.locator(editor === 'dark' || scheme === 'dark' ? '#appearance-darkContrast' : '#appearance-lightContrast');
        await slider.press('End');
        const difference = await page.evaluate(() => {
            const style = getComputedStyle(document.querySelector('.appearance-page')!);
            const ctx = document.createElement('canvas').getContext('2d')!;
            const color = (token: string) => { ctx.fillStyle = style.getPropertyValue(token).trim(); ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
            const line = color('--page-line'), canvas = color('--page-canvas');
            return Math.max(...line.map((channel, i) => Math.abs(channel - canvas[i])));
        });
        expect(difference).toBeGreaterThanOrEqual(20);
    });
}

test('follow editor dark surfaces preserve host colors and darken with the slider', async ({ page }) => {
    await installVscodeTheme(page, 'dark');
    await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => document.body.style.setProperty('--vscode-textCodeBlock-background', '#404040'));
        Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({}), setState: () => {}, postMessage: () => {} }) });
    });
    await page.goto('/');
    await page.evaluate(() => { window.postMessage({ type: 'locale', locale: 'en' }, '*'); window.postMessage({ type: 'showChat' }, '*'); window.postMessage({ type: 'openSettings' }, '*'); });
    await openPageNavigation(page);
    await page.locator('[data-section=appearance]').click();
    const colors = () => page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.appearance-page')!); const ctx = document.createElement('canvas').getContext('2d')!;
        return ['--vscode-input-background', '--vscode-editorWidget-background', '--vscode-textCodeBlock-background'].map(token => { ctx.fillStyle = style.getPropertyValue(token).trim(); ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); });
    });
    const baseline = await colors();
    expect(baseline).toEqual([[49, 49, 49], [32, 32, 32], [64, 64, 64]]);
    await page.locator('#appearance-lightContrast').press('End');
    expect(await colors()).toEqual(baseline);
    await page.locator('#appearance-darkContrast').press('End');
    expect(await colors()).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    await page.locator('#appearance-darkContrast').press('Home');
    await page.locator('#appearance-lightContrast').press('Home');
    expect(await colors()).toEqual(baseline);
});

/**
 * Consolidated Appearance & Theme Contrast E2E tests.
 *
 * Replaces 6 overlapping appearance/swatch/contrast specs (~44 loads, ~370 PNGs)
 * with 3 focused tests covering scheme/accent persistence, Shiki dark-code
 * override, brand mask rendering, custom color swatch, independent light/dark
 * contrast sliders, live host-theme switching, and dark-contrast `.git-status`.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installVscodeTheme, VSCODE_LIGHT_TOKENS } from './vscodeTheme';
import { openPageNavigation } from './navigation';

const post = (page: Page, message: object) => page.evaluate((value) => window.postMessage(value, '*'), message);

const actionContrast = (button: Locator) => button.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')!;
    const luminance = (value: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    };
    const style = getComputedStyle(element);
    const a = luminance(style.backgroundColor);
    const b = luminance(style.color);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

test('scheme toggle, accent & custom swatch, Shiki dark-code override, and reload persistence', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await installVscodeTheme(page, 'light');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
        let state: Record<string, unknown> = JSON.parse(sessionStorage.getItem('appearance-state') ?? '{"other":"retained"}');
        Object.assign(window, {
            acquireVsCodeApi: () => ({
                postMessage: () => {},
                getState: () => state,
                setState: (next: Record<string, unknown>) => {
                    state = next;
                    sessionStorage.setItem('appearance-state', JSON.stringify(next));
                },
            }),
        });
    });
    await page.goto('/');
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });

    const input = page.locator('.composer-input');
    await input.fill('Keep this draft while changing appearance');
    await input.evaluate((el) => { (el as HTMLTextAreaElement).setSelectionRange(2, 8); });

    const lightCode = '<div class="code-block"><div class="code-header"><span class="code-title">TypeScript</span></div><div class="code-surface"><pre class="shiki github-light" style="color:#24292e;background-color:#ffffff"><code><span style="color:#d73a49">const</span> value = 1;</code></pre></div></div>';
    await post(page, { type: 'restoreUser', value: 'Show code' });
    await post(page, { type: 'startResponse' });
    await post(page, { type: 'fullResponse', persian: 'const value = 1;', renderedHtml: lightCode });
    await post(page, { type: 'openSettings' });

    const navigate = async (section: string) => {
        await openPageNavigation(page);
        await page.locator(`.sidebar-item[data-section="${section}"]`).click();
    };
    await navigate('appearance');

    // Brand mark decodes an outline mask (not a broken solid square).
    const coverage = await page.locator('.workspace-sidebar-brand .xratu-brand-mark').evaluate(async (el) => {
        const mask = getComputedStyle(el).maskImage;
        const url = mask.match(/^url\("(.*)"\)$/)?.[1];
        if (!url) throw new Error(`Missing brand mask: ${mask}`);
        const img = new Image();
        img.src = url;
        await img.decode();
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.canvas.width = ctx.canvas.height = 64;
        ctx.drawImage(img, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
        return painted / (64 * 64);
    });
    expect(coverage).toBeGreaterThan(0.05);
    expect(coverage).toBeLessThan(0.5);

    await expect(page.locator('.app')).toHaveAttribute('data-color-scheme', 'editor');

    // Custom rainbow swatch renders circular & selects custom accent.
    const customSwatch = page.locator('.appearance-custom-swatch');
    const dims = (await customSwatch.boundingBox())!;
    expect(dims.width).toBeGreaterThanOrEqual(32);
    expect(dims.height).toBeCloseTo(dims.width, 0);
    await expect(customSwatch).toHaveCSS('border-radius', '50%');
    await expect(customSwatch).toHaveCSS('background-image', /conic-gradient/);
    await page.locator('.appearance-color-input').evaluate((el) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '#cc2255');
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(customSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(customSwatch.locator('svg')).toBeVisible();

    // Switch to forced Dark scheme + Violet accent; verify Providers CTA WCAG contrast >= 4.5.
    await page.locator('#appearance-scheme').click();
    await page.getByRole('option').nth(1).click();
    await expect(page.locator('.app')).toHaveCSS('color-scheme', 'dark');
    await expect(page.locator('.appearance-page')).toHaveCSS('background-color', 'rgb(24, 24, 24)');

    const swatches = page.locator('#appearance-accent').getByRole('radio');
    await expect(swatches).toHaveCount(9);
    await swatches.nth(2).click();
    await expect(page.locator('.app')).toHaveAttribute('data-accent', 'violet');

    await navigate('providers');
    await expect.poll(() => actionContrast(page.locator('.cred-head .page-add'))).toBeGreaterThanOrEqual(4.5);

    // Return to work: Shiki light code re-highlighted dark, composer draft & selection preserved.
    await page.locator('.toolbar-back-work').click();
    await expect(page.locator('.code-surface pre.xratu-dark-code')).toBeVisible();
    await expect(page.locator('.code-surface code')).toHaveText('const value = 1;');
    await expect(page.locator('.code-surface code span').first()).not.toHaveCSS('color', 'rgb(215, 58, 73)');
    await expect(input).toHaveValue('Keep this draft while changing appearance');
    expect(await input.evaluate((el) => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);

    // Persists across reload without dropping unrelated saved state.
    await page.reload();
    await post(page, { type: 'locale', locale: 'en' });
    await post(page, { type: 'showChat' });
    await expect(page.locator('.app')).toHaveAttribute('data-color-scheme', 'dark');
    await expect(page.locator('.app')).toHaveAttribute('data-accent', 'violet');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('appearance-state')!).other)).toBe('retained');
    expect(errors).toEqual([]);
});

for (const editor of ['dark', 'light'] as const) {
    test(`independent light/dark contrast sliders, borders, inset, and git bar (${editor} editor)`, async ({ page }) => {
        await installVscodeTheme(page, editor);
        if (editor === 'light') {
            await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => {
                    document.documentElement.style.setProperty('--vscode-editor-background', '#e0e0e0');
                });
            });
        }
        await page.addInitScript(() => {
            let state: object = {};
            Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => state, setState: (next: object) => { state = next; }, postMessage: () => {} }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale: 'en' });
        await post(page, { type: 'showChat' });
        await post(page, { type: 'gitStatusState', root: '~/Projects/xratu', status: { isRepo: true, branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, staged: 2, modified: 1, untracked: 0, conflicted: 0 } });
        await post(page, { type: 'openSettings' });
        await openPageNavigation(page);
        await page.locator('[data-section=appearance]').click();

        const readChannels = () => page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d')!;
            const rgb = (value: string) => {
                ctx.clearRect(0, 0, 1, 1);
                ctx.fillStyle = value;
                ctx.fillRect(0, 0, 1, 1);
                return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const appearancePage = document.querySelector('.appearance-page')!;
            const probe = appearancePage.appendChild(document.createElement('div'));
            const tokenColor = (name: string) => {
                probe.style.backgroundColor = `var(${name})`;
                return rgb(getComputedStyle(probe).backgroundColor);
            };
            const channels = {
                fg: rgb(getComputedStyle(appearancePage).color),
                bg: rgb(getComputedStyle(document.querySelector('.page-layout')!).backgroundColor),
                muted: tokenColor('--page-muted'),
                line: tokenColor('--page-line'),
                canvas: tokenColor('--page-canvas'),
                inset: tokenColor('--xratu-surface-inset'),
            };
            probe.remove();
            return channels;
        });

        const dark = editor === 'dark';
        const base = await readChannels();
        const lightSlider = page.locator('#appearance-lightContrast');
        const darkSlider = page.locator('#appearance-darkContrast');
        const surfaceSlider = dark ? darkSlider : lightSlider;
        const inkSlider = dark ? lightSlider : darkSlider;

        // Max ink slider drives only foreground/muted, leaving surface/borders/inset intact.
        await inkSlider.press('End');
        const maxInk = await readChannels();
        expect(dark ? maxInk.fg : maxInk.bg).toEqual(dark ? [255, 255, 255] : base.bg);
        expect(dark ? maxInk.bg : maxInk.fg).toEqual(dark ? base.bg : [0, 0, 0]);
        expect(maxInk.inset).toEqual(base.inset);
        expect(maxInk.line).toEqual(base.line);
        expect(maxInk.muted).not.toEqual(base.muted);

        // Max surface slider drives surface/inset to extreme while keeping borders visibly distinct (>= 20).
        await inkSlider.press('Home');
        await surfaceSlider.press('End');
        const maxSurface = await readChannels();
        expect(maxSurface.bg).toEqual(dark ? [0, 0, 0] : [255, 255, 255]);
        expect(maxSurface.inset).toEqual(dark ? [0, 0, 0] : [255, 255, 255]);
        expect(Math.max(...maxSurface.line.map((ch, i) => Math.abs(ch - maxSurface.canvas[i])))).toBeGreaterThanOrEqual(20);

        if (dark) {
            // Returning to chat keeps `.git-status` ancestor background pure black at max dark contrast.
            await page.locator('.toolbar-back-work').click();
            await expect(page.locator('.git-status')).toBeVisible();
            const bg = await page.locator('.git-status').evaluate((el) => {
                for (let node: Element | null = el; node; node = node.parentElement) {
                    const color = getComputedStyle(node).backgroundColor;
                    if (color !== 'rgba(0, 0, 0, 0)') return color;
                }
                return '';
            });
            expect(bg).toMatch(/^(rgb\(0, 0, 0\)|color\(srgb 0 0 0\))$/);

            // Live VS Code theme swap switches active contrast polarity cleanly.
            await post(page, { type: 'openSettings' });
            await openPageNavigation(page);
            await page.locator('[data-section=appearance]').click();
            await lightSlider.press('End');
            await expect(page.locator('.appearance-page')).toHaveCSS('color', 'color(srgb 1 1 1)');
            await page.evaluate((tokens) => {
                for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
                document.body.classList.replace('vscode-dark', 'vscode-light');
                document.body.dataset.vscodeThemeKind = 'vscode-light';
            }, VSCODE_LIGHT_TOKENS);
            await expect(page.locator('.appearance-page')).toHaveCSS('color', 'color(srgb 0 0 0)');
        }
    });
}

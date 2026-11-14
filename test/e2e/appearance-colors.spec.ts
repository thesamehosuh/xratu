import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installVscodeTheme } from './vscodeTheme';
import { openPageNavigation } from './navigation';

const post = (page: Page, message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
const choose = async (page: Page, id: string, value: number) => {
    if (id === 'appearance-accent') { await page.locator('#appearance-accent').getByRole('radio').nth(value).click(); return; }
    await page.locator(`#${id}`).click();
    await page.locator(`#${id}`).locator('..').getByRole('option').nth(value).click();
};
const actionContrast = (button: Locator) => button.evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!;
    const luminance = (value: string) => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
    };
    const style = getComputedStyle(element), a = luminance(style.backgroundColor), b = luminance(style.color);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
});
const expectBrand = async (page: Page) => {
    const brand = page.locator('.workspace-sidebar-brand');
    await expect(brand).toBeVisible();
    await expect(brand.locator('strong')).toHaveText(/^(Xratu|خراتو)$/);
    await expect(brand.locator('strong')).toHaveCSS('color', await page.locator('.app').evaluate(element => getComputedStyle(element).color));
    // A syntactically valid mask can still fail to load and paint a square.
    // Decode the actual bundled SVG and confirm it has an outline, not a fill.
    const coverage = await brand.locator('.xratu-brand-mark').evaluate(async element => {
        const mask = getComputedStyle(element).maskImage;
        const url = mask.match(/^url\("(.*)"\)$/)?.[1];
        if (!url) throw new Error(`Missing brand mask: ${mask}`);
        const img = new Image();
        img.src = url;
        await img.decode();
        const context = document.createElement('canvas').getContext('2d')!;
        context.canvas.width = context.canvas.height = 64;
        context.drawImage(img, 0, 0, 64, 64);
        const pixels = context.getImageData(0, 0, 64, 64).data;
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
        return painted / (64 * 64);
    });
    expect(coverage).toBeGreaterThan(.05);
    expect(coverage).toBeLessThan(.5);
    expect(await brand.locator('strong').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
};

for (const editor of ['dark', 'light'] as const) for (const locale of ['en', 'fa'] as const) for (const width of [420, 1440]) {
    test(`accent choices and saved dark appearance (${editor}, ${locale}, ${width})`, async ({ page }) => {
        test.setTimeout(90_000);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await installVscodeTheme(page, editor);
        await page.setViewportSize({ width, height: 960 });
        await page.addInitScript(() => {
            let state: Record<string, unknown> = JSON.parse(sessionStorage.getItem('appearance-state') ?? '{"other":"retained"}');
            Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => state, setState: (next: Record<string, unknown>) => { state = next; sessionStorage.setItem('appearance-state', JSON.stringify(next)); } }) });
        });
        await page.goto('/');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        const input = page.locator('.composer-input');
        await input.fill('Keep this draft while I choose colors');
        await input.evaluate(element => { (element as HTMLTextAreaElement).setSelectionRange(2, 8); Object.assign(window, { inputNode: element, browserNode: document.querySelector('.browser-pane') }); });
        const lightCode = '<div class="code-block"><div class="code-header"><span class="code-title">TypeScript</span></div><div class="code-surface"><pre class="shiki github-light" style="color:#24292e;background-color:#ffffff"><code><span style="color:#d73a49">const</span> value = 1;</code></pre></div></div>';
        await post(page, { type: 'restoreUser', value: 'Show the code' });
        await post(page, { type: 'startResponse' });
        await post(page, { type: 'fullResponse', persian: 'const value = 1;', renderedHtml: lightCode });
        await post(page, { type: 'openSettings' });
        const navigate = async (section: string) => { await openPageNavigation(page); await page.locator(`.sidebar-item[data-section="${section}"]`).click(); };
        await navigate('appearance');
        const evidence = join(process.cwd(), 'output', 'playwright', 'appearance-colors', `${editor}-${locale}-${width}`);
        await mkdir(evidence, { recursive: true });
        const shot = async (name: string) => { await page.mouse.move(width - 1, 0); await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled' }); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1); };
        // The editor's theme remains available; explicit Dark applies only to the app.
        await expect(page.locator('.app')).toHaveAttribute('data-color-scheme', 'editor');
        await choose(page, 'appearance-accent', 1);
        await openPageNavigation(page);
        await expectBrand(page);
        if (width < 860) await page.locator('.toolbar > .sidebar-toggle').click();
        await navigate('providers');
        await expect.poll(() => actionContrast(page.locator('.cred-head .page-add'))).toBeGreaterThanOrEqual(4.5);
        await navigate('appearance');
        await choose(page, 'appearance-scheme', 1);
        await expect(page.locator('.app')).toHaveCSS('color-scheme', 'dark');
        await expect(page.locator('.app')).toHaveCSS('color', 'rgb(212, 212, 212)');
        if (width >= 860) {
            await expect(page.locator('.workspace-sidebar-brand strong')).toHaveCSS('color', 'rgb(212, 212, 212)');
            await expect(page.locator('.xratu-brand-mark').first()).not.toHaveCSS('mask-image', 'none');
        }
        await expect(page.locator('.appearance-page')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
        await expect(page.locator('.appearance-theme')).toHaveCount(0);
        const swatches = page.locator('#appearance-accent').getByRole('radio');
        await expect(swatches).toHaveCount(9);
        await expect(page.locator('#appearance-accent [tabindex="0"]')).toHaveCount(1);
        await swatches.nth(1).focus();
        await page.keyboard.press('End');
        await expect(swatches.last()).toHaveAttribute('aria-checked', 'true');
        await page.keyboard.press('Home');
        await page.keyboard.press(locale === 'fa' ? 'ArrowLeft' : 'ArrowRight');
        await expect(swatches.nth(1)).toHaveAttribute('aria-checked', 'true');
        const colors = ['teal', 'blue', 'violet', 'amber', 'rose', 'neutral', 'white', 'graphite'];
        for (const [index, color] of colors.entries()) {
            await choose(page, 'appearance-accent', index);
            await expect(page.locator('.app')).toHaveAttribute('data-accent', color);
            await expect(swatches.nth(index).locator('svg')).toBeVisible();
            await shot(`appearance-${color}`);
            await openPageNavigation(page);
            await expectBrand(page);
            if (width < 860) await page.locator('.toolbar > .sidebar-toggle').click();
            await navigate('providers');
            await expect(page.locator('.cred-page')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
            await expect.poll(() => actionContrast(page.locator('.cred-head .page-add'))).toBeGreaterThanOrEqual(4.5);
            await expect(page.locator('.cred-head .page-add > span')).toHaveCSS('color', await page.locator('.cred-head .page-add').evaluate(element => getComputedStyle(element).color));
            await shot(`providers-${color}`);
            await navigate('appearance');
        }
        await choose(page, 'appearance-accent', 2);
        await openPageNavigation(page);
        await shot('sidebar-violet');
        await page.locator('.sidebar-item[data-section="engines"]').click();
        await expect(page.locator('.engine-heading .xratu-brand-mark')).not.toHaveCSS('mask-image', 'none');
        await expect(page.locator('.engine-heading h3').first()).toHaveCSS('color', 'rgb(212, 212, 212)');
        await shot('engines-violet');
        await page.locator('.toolbar-back-work').click();
        await expect(page.locator('.code-surface pre.xratu-dark-code')).toBeVisible();
        await expect(page.locator('.code-surface code')).toHaveText('const value = 1;');
        await expect(page.locator('.code-surface code span').first()).not.toHaveCSS('color', 'rgb(215, 58, 73)');
        await expect(input).toHaveValue('Keep this draft while I choose colors');
        expect(await input.evaluate(element => element === (window as unknown as { inputNode: Element }).inputNode)).toBe(true);
        expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
        expect(await page.evaluate(() => document.querySelector('.browser-pane') === (window as unknown as { browserNode: Element }).browserNode)).toBe(true);
        await shot('conversation-violet');
        await post(page, { type: 'openSettings' });
        await navigate('appearance');
        await choose(page, 'appearance-scheme', 0);
        await page.locator('.toolbar-back-work').click();
        await expect(page.locator('.code-surface pre.xratu-dark-code')).toHaveCount(0);
        await expect(page.locator('.code-surface code span').first()).toHaveCSS('color', 'rgb(215, 58, 73)');
        await post(page, { type: 'openSettings' });
        await navigate('appearance');
        await choose(page, 'appearance-scheme', 1);
        await page.reload();
        await expect(page.locator('.app')).toHaveCSS('color-scheme', 'dark');
        await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
        await post(page, { type: 'locale', locale });
        await post(page, { type: 'showChat' });
        await expect(page.locator('.app')).toHaveAttribute('data-color-scheme', 'dark');
        await expect(page.locator('.app')).toHaveAttribute('data-accent', 'violet');
        expect(await page.evaluate(() => document.body.classList.contains('vscode-light'))).toBe(editor === 'light');
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('appearance-state')!).other)).toBe('retained');
        await post(page, { type: 'showWelcome' });
        await expect(page.locator('.app')).toHaveCSS('color-scheme', 'dark');
        await expect(page.locator('.app')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
        await expect(page.locator('.setup-overlay')).toHaveCSS('background-color', 'rgb(24, 24, 24)');
        await expect(page.locator('.setup-brand .xratu-brand-mark')).toHaveCSS('background-color', 'rgb(189, 167, 255)');
        await expect(page.locator('.setup-brand .xratu-brand-mark')).not.toHaveCSS('mask-image', 'none');
        await expect(page.locator('.setup-brand > span').last()).toHaveCSS('color', 'rgb(212, 212, 212)');
        await shot('welcome-dark');
        expect(errors).toEqual([]);
    });
}

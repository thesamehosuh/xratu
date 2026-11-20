import { openWorkPanel } from './navigation';
import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

for (const [locale, width] of [['en', 1280], ['fa', 420]] as const) {
    test(`control labels keep font metrics, center icons, and align visible glyphs (${locale}, ${width})`, async ({ page }) => {
        await installVscodeTheme(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/');
        await page.evaluate((loc) => window.postMessage({ type: 'locale', locale: loc }, '*'), locale);
        await page.evaluate(async () => {
            await document.fonts.load('400 14px Vazirmatn', 'سلام');
            await document.fonts.ready;
        });

        for (const [name, type] of [['chat', 'showChat'], ['activity', 'showChat'], ['agents', 'showChat'], ['background', 'showChat'], ['changes', 'showChat'], ['settings', 'openSettings'], ['providers', 'openCredentials'], ['engines', 'openEngines'], ['welcome', 'showWelcome']]) {
            await page.evaluate((t) => window.postMessage({ type: t }, '*'), type);
            if (['activity', 'agents', 'background', 'changes'].includes(name)) await openWorkPanel(page, name);
            const pageSelector = ({ settings: '.preferences-page', providers: '.cred-page', engines: '.engines-page' } as Record<string, string>)[name];
            if (pageSelector) await expect(page.locator(pageSelector)).toBeVisible();
            if (['activity', 'agents', 'background', 'changes'].includes(name)) await expect(page.locator(`#surface-panel-${name}`)).toBeVisible();
            if (name === 'chat') await expect(page.locator('.composer-input')).toBeVisible();
            if (name === 'welcome') await expect(page.locator('.onboarding')).toBeVisible();

            const failures = await page.evaluate(() => {
                const context = document.createElement('canvas').getContext('2d')!;
                const failures: string[] = [];
                for (const control of document.querySelectorAll('button, [role=tab]')) {
                    if (!(control as HTMLElement).checkVisibility() || !control.getBoundingClientRect().height) continue;
                    if (control.textContent?.trim() && control.clientHeight > 1 && control.scrollHeight > control.clientHeight + 1) {
                        failures.push(`${control.className}: content exceeds control height`);
                    }
                    for (const node of [control, ...control.querySelectorAll('span')]) {
                        const text = [...node.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
                        if (!text) continue;
                        const css = getComputedStyle(node);
                        context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                        const metrics = context.measureText(text);
                        const line = css.lineHeight === 'normal' ? parseFloat(css.fontSize) * 1.2 : parseFloat(css.lineHeight);
                        const natural = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
                        if (line + 0.5 < natural) failures.push(`${node.className || control.className}: ${text} line=${line} font=${natural}`);
                    }
                    const icon = control.querySelector(':scope > svg');
                    if (!icon) continue;
                    const iconBox = icon.getBoundingClientRect();
                    if (!iconBox.height) continue;
                    for (const label of control.querySelectorAll(':scope > span')) {
                        const box = label.getBoundingClientRect();
                        if (!box.height || !label.textContent?.trim()) continue;
                        const delta = Math.abs(box.y + box.height / 2 - iconBox.y - iconBox.height / 2);
                        if (delta > 1) failures.push(`${control.className}: icon/label centers differ by ${delta}px`);
                    }
                }
                return failures;
            });
            expect(failures, name).toEqual([]);
        }
    });

    test(`visible letter ink centers with icons and segmented choices stay centered (${locale}, ${width})`, async ({ page }) => {
        await installVscodeTheme(page);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width, height: 930 });
        await page.addInitScript(() => {
            Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => undefined, setState: (value: unknown) => value }) });
        });
        await page.goto('/');
        await page.evaluate((loc) => {
            window.postMessage({ type: 'locale', locale: loc }, '*');
            window.postMessage({ type: 'showChat', workspaceKind: 'project' }, '*');
            window.postMessage({ type: 'modelInfo', defaultModel: 'reasoner', selectedModel: 'reasoner', models: ['reasoner'], capabilities: { reasoner: { reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] } } }, '*');
        }, locale);
        await expect(page.locator('.composer-policy')).toHaveCount(2);
        await page.evaluate(async () => {
            await document.fonts.load('400 14px Vazirmatn', 'سلام');
            await document.fonts.ready;
        });

        const measurements = await page.locator('.composer-policy').evaluateAll((buttons, loc) => {
            const context = document.createElement('canvas').getContext('2d')!;
            return buttons.map((button) => {
                const label = button.querySelector('span')!;
                const css = getComputedStyle(label);
                context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
                const metrics = context.measureText(loc === 'en' ? 'H' : label.textContent!);
                const marker = document.createElement('i');
                marker.style.cssText = 'display:inline-block;vertical-align:baseline;width:0;height:0;padding:0;margin:0;border:0';
                label.appendChild(marker);
                const baseline = marker.getBoundingClientRect().y;
                marker.remove();
                const icon = button.querySelector('svg')!.getBoundingClientRect();
                const letterCenter = baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2;
                return { text: label.textContent, offset: letterCenter - icon.y - icon.height / 2 };
            });
        }, locale);
        for (const { text, offset } of measurements) {
            expect(Math.abs(offset), `${text}: visible text offset ${offset}px`).toBeLessThanOrEqual(1);
        }

        const assertCentered = async (selector: string) => {
            const offsets = await page.locator(selector).evaluateAll((buttons) => buttons.map((button) => {
                const range = document.createRange();
                range.selectNodeContents(button);
                const text = range.getBoundingClientRect();
                const box = button.getBoundingClientRect();
                return { label: button.textContent, offset: text.x + text.width / 2 - box.x - box.width / 2 };
            }));
            expect(offsets.length).toBeGreaterThan(0);
            for (const { label, offset } of offsets) expect(Math.abs(offset), `${label}: horizontal offset ${offset}px`).toBeLessThanOrEqual(1);
        };
        await page.locator('.picker-chip').click();
        await expect(page.locator('.thinking-seg-opt')).toHaveCount(7);
        await assertCentered('.thinking-seg-opt');
        await page.evaluate(() => window.postMessage({ type: 'openSettings' }, '*'));
        await expect(page.locator('.preferences-page')).toBeVisible();
        await page.locator('.settings-configure-proxy').click();
        await expect(page.locator('.routing-page')).toBeVisible();
        await assertCentered('.routing-page .lang-chip');
    });
}

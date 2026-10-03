/**
 * Tool-image rendering tests for the built webview bundle (dist/webview-ui).
 *
 * Drives the app the same way `app.spec.ts` does - a mocked `acquireVsCodeApi`
 * plus `FromExtensionMessage` envelopes - and asserts that an image a tool
 * returned with its result actually renders in the transcript, at both widths
 * and in both locales (RTL breaks differently than LTR).
 */
import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

// 1x1 PNG.
const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const sent: unknown[] = [];
        (window as Record<string, unknown>).__xratuHostMessages = sent;
        (window as Record<string, unknown>).acquireVsCodeApi = () => ({
            postMessage: (message: unknown) => { sent.push(message); },
            getState: () => undefined,
            setState: (state: unknown) => state,
        });
    });
});

async function hostMessage(page: Page, message: Record<string, unknown>): Promise<void> {
    await page.evaluate((msg) => window.postMessage(msg, '*'), message);
}

/** A one-shot turn: an MCP tool call whose result carries an image. */
async function toolResultWithImages(page: Page, images: Array<{ mimeType: string; dataUrl: string; caption?: string }>) {
    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'toolCall',
        tool: 'mcp__playwright__browser_take_screenshot',
        args: JSON.stringify({ url: 'https://example.com' }),
        callId: 'call1',
    });
    await hostMessage(page, {
        type: 'toolResult',
        tool: 'mcp__playwright__browser_take_screenshot',
        output: 'Screenshot captured.',
        callId: 'call1',
        images,
    });
    await hostMessage(page, { type: 'fullResponse', text: 'The page shows a checkout form.' });
}

for (const [localeName, locale] of [['fa', 'fa'], ['en', 'en']] as const) {
    for (const [widthName, viewport] of [
        ['sidebar', { width: 420, height: 900 }],
        ['wide', { width: 1100, height: 900 }],
    ] as const) {
        test(`${localeName}/${widthName}: a tool image renders in the transcript`, async ({ page }) => {
            await installVscodeTheme(page);
            await page.setViewportSize(viewport);
            await page.goto('/');
            await hostMessage(page, { type: 'setLocale', locale });
            await hostMessage(page, { type: 'showChat' });

            await toolResultWithImages(page, [
                { mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG_1x1}`, caption: 'https://example.com/checkout' },
            ]);

            const img = page.locator('.tool-images img');
            await expect(img).toHaveCount(1);
            // The payload must actually be the data URL, not a broken src.
            expect(await img.getAttribute('src')).toBe(`data:image/png;base64,${PNG_1x1}`);
            await expect(page.locator('.tool-image figcaption')).toContainText('https://example.com/checkout');

            // RTL rule: a URL caption is LTR content regardless of locale.
            await expect(page.locator('.tool-images')).toHaveAttribute('dir', 'ltr');
            await expect(page.locator('.tool-image figcaption')).toHaveAttribute('dir', 'ltr');

            // The tool row is still a completed row, not a spinner.
            await expect(page.locator('.step')).toHaveClass(/step/);
        });
    }
}

test('rendered images are capped and the remainder is stated', async ({ page }) => {
    await installVscodeTheme(page);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto('/');
    await hostMessage(page, { type: 'setLocale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });

    await toolResultWithImages(page, Array.from({ length: 7 }, (_, i) => ({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${PNG_1x1}`,
        caption: `shot ${i + 1}`,
    })));

    await expect(page.locator('.tool-images img')).toHaveCount(4);
    await expect(page.locator('.tool-images-more')).toContainText('3');
});

test('a captionless image still renders with an alt text', async ({ page }) => {
    await installVscodeTheme(page);
    await page.goto('/');
    await hostMessage(page, { type: 'setLocale', locale: 'fa' });
    await hostMessage(page, { type: 'showChat' });

    await toolResultWithImages(page, [
        { mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG_1x1}` },
    ]);

    const img = page.locator('.tool-images img');
    await expect(img).toHaveCount(1);
    await expect(img).toHaveAttribute('alt', /.+/);
    await expect(page.locator('.tool-image figcaption')).toHaveCount(0);
});

test('a text-only tool result renders no image block', async ({ page }) => {
    await installVscodeTheme(page);
    await page.goto('/');
    await hostMessage(page, { type: 'setLocale', locale: 'en' });
    await hostMessage(page, { type: 'showChat' });

    await hostMessage(page, { type: 'startResponse' });
    await hostMessage(page, {
        type: 'toolCall',
        tool: 'read_file',
        args: JSON.stringify({ path: 'a.ts' }),
        callId: 'call1',
    });
    await hostMessage(page, { type: 'toolResult', tool: 'read_file', output: 'file body', callId: 'call1' });
    await hostMessage(page, { type: 'fullResponse', text: 'Read it.' });

    await expect(page.locator('.tool-images')).toHaveCount(0);
    await expect(page.locator('.step')).toContainText('file body');
});
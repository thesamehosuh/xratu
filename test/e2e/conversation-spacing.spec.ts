import { expect, test } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';

for (const theme of ['dark', 'light'] as const) for (const locale of ['en', 'fa']) for (const width of [420, 1440]) {
    test(`completed answer spacing (${theme}, ${locale}, ${width})`, async ({ page }, info) => {
        await installVscodeTheme(page, theme);
        await page.setViewportSize({ width, height: 950 });
        await page.addInitScript(accent => Object.assign(window, { acquireVsCodeApi: () => ({ getState: () => ({ surfaceAppearance: { accent } }), setState: () => {}, postMessage: () => {} }) }), locale === 'en' ? 'teal' : 'blue');
        await page.goto('/');
        const post = (message: object) => page.evaluate(value => window.postMessage(value, '*'), message);
        await post({ type: 'locale', locale });
        await post({ type: 'showChat' });
        const assertBorder = async (active: boolean) => {
            const [actual, expected] = await page.locator('.composer').evaluate((el, active) => {
                const probe = document.createElement('span');
                probe.style.color = active ? 'var(--surface-accent)' : 'var(--page-line)';
                el.appendChild(probe);
                const expected = getComputedStyle(probe).color;
                probe.remove();
                return [getComputedStyle(el).borderTopColor, expected];
            }, active);
            expect(actual).toBe(expected);
        };
        const input = page.locator('.composer-input');
        await input.evaluate(el => (el as HTMLTextAreaElement).blur());
        await assertBorder(false);
        await input.fill('Draft');
        await assertBorder(true);
        await input.evaluate(el => (el as HTMLTextAreaElement).blur());
        await assertBorder(false);
        await page.locator('.composer-engine-picker .dropdown-trigger').click();
        await expect(page.locator('.composer-engine-picker .dropdown-list')).toBeVisible();
        await assertBorder(true);
        await page.keyboard.press('Escape');
        await input.fill('');
        await input.evaluate(el => (el as HTMLTextAreaElement).blur());
        await assertBorder(false);
        await post({ type: 'restoreUser', value: 'Review the project and run its tests.' });
        await post({ type: 'startResponse' });
        await post({ type: 'toolCall', tool: 'read_file', args: '{"path":"src/main.py"}', callId: 'read' });
        await post({ type: 'toolResult', tool: 'read_file', output: 'Project inspected.', callId: 'read' });
        await post({ type: 'decisionRequest', decision_id: 'scope', header: 'Scope', question: 'Run the full suite?', options: [{ label: 'Run tests' }, { label: 'Skip tests' }] });
        await post({ type: 'decisionResolved', decision_id: 'scope', answer: 'Run tests' });
        const text = locale === 'en'
            ? 'I reviewed the project structure and ran the test suite: all 201 tests pass. It is a well-tested, data-driven terminal RPG. One thing to keep in mind is that the working tree already has uncommitted changes, so I avoided overwriting them. A useful next step would be a deeper code review or a feature you have in mind.'
            : 'ساختار پروژه رو بررسی کردم و تست ها رو اجرا کردم. هر ۲۰۱ تست پاس شدن. پروژه یک بازی ترمینالیه و تست های خوبی داره. تغییرات ذخیره نشده از قبل وجود داشتن و اون ها رو دست نخورده نگه داشتم. قدم بعدی میتونه بررسی دقیق تر کد یا اضافه کردن قابلیتی باشه که در نظر داری.';
        await post({ type: 'fullResponse', persian: text, renderedHtml: `<p>${text}</p>` });
        const answer = page.locator('.msg.assistant').last();
        await expect(answer.locator('.msg-footer')).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath('completed-answer.png') });
        const gaps = await answer.evaluate(el => {
            const selectors = ['.completed-steps', '.msg-content', '.decision-stack', '.msg-footer'];
            const boxes = selectors.map(selector => el.querySelector(selector)!.getBoundingClientRect());
            return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
        });
        for (const gap of gaps) expect(gap).toBeCloseTo(16, 0);
        const typography = await answer.locator('.msg-content').evaluate(el => {
            const style = getComputedStyle(el);
            return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
        });
        expect(typography).toBeCloseTo(2, 2);
        await answer.locator('.decision-collapsed').click();
        await expect(answer.locator('.decision-card')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
}

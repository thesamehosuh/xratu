import { expect, type Page } from '@playwright/test';

/** Narrow destinations keep the drawer closed after selection. */
export async function openPageNavigation(page: Page): Promise<void> {
    await expect(page.locator('.page-content')).toBeVisible();
    if (!await page.locator('.page-sidebar').isVisible()) await page.locator('.toolbar > .sidebar-toggle').click();
}

export async function openSettingsFromWork(page: Page): Promise<void> {
    if (!await page.locator('.workspace-sidebar').isVisible()) await page.locator('.toolbar > .sidebar-toggle').click();
    await page.locator('.workspace-settings').click();
    await expect(page.locator('.page-content')).toBeVisible();
}

/** Open an available panel or reveal it through the user's + control. */
export async function openWorkPanel(page: Page, panel: string): Promise<void> {
    const tab = page.locator(`#surface-tab-${panel}`);
    if (await tab.isVisible()) { await tab.click(); return; }
    await page.locator('.toolbar-tools').getByRole('button', { name: /^(Add tab|افزودن تب)$/ }).click();
    await page.locator(`.new-tab-pane:not(.panel-hidden) [data-open-panel="${panel}"]`).click();
}

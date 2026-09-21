/**
 * Bilingual strings for NATIVE VS Code surfaces the webview i18n can't reach:
 * the native-toast fallback (when the webview can't render banners), palette
 * prompts, and host-rendered HTML snippets (code-copy button).
 *
 * Keys MUST mirror their counterparts in webview-ui/src/i18n.ts (which stays
 * the source of truth for everything the webview renders itself).
 */

export type UiLocale = 'fa' | 'en';

let UI_LOCALE: UiLocale = 'fa';

export function setUiLocale(locale: UiLocale): void {
    UI_LOCALE = locale;
}

export function getUiLocale(): UiLocale {
    return UI_LOCALE;
}

const STRINGS: Record<string, { fa: string; en: string }> = {
    notifNoFolder: { fa: 'هیچ پوشه ای باز نیست.', en: 'No folder is open.' },
    notifNoCheckpoints: { fa: 'هنوز نقطه بازیابی وجود ندارد.', en: 'No checkpoints yet.' },
    notifRestoreConfirm: { fa: 'فایل های ورک اسپیس به {target} برمیگردند. ادامه؟', en: 'Workspace files will be restored to {target}. Continue?' },
    notifRestoreAction: { fa: 'بازیابی', en: 'Restore' },
    notifCancel: { fa: 'لغو', en: 'Cancel' },
    notifRestored: { fa: 'به نقطه {sha} بازگردانده شد (وضعیت قبلی با {safety} ذخیره شد).', en: 'Restored to {sha} (previous state saved as {safety}).' },
    notifRestoreFailed: { fa: 'بازیابی ناموفق بود: {error}', en: 'Restore failed: {error}' },
    notifRewindNoText: { fa: 'متن این پیام برای ارسال دوباره پیدا نشد.', en: 'The text of this message could not be found for resending.' },
    notifCpRestoreFailed: { fa: 'بازیابی نقطه بازرسی ناموفق بود: {error}', en: 'Checkpoint restore failed: {error}' },
    notifEditFailed: { fa: 'ویرایش پیام ناموفق بود: {error}', en: 'Editing the message failed: {error}' },
    notifRegenerateFailed: { fa: 'تولید دوباره ناموفق بود: {error}', en: 'Regeneration failed: {error}' },
    copyCode: { fa: 'کپی', en: 'Copy' },
    checkpointRestorePlaceholder: { fa: 'بازیابی فایل ها به این نقطه (وضعیت فعلی هم قبلش ذخیره میشود)', en: 'Restore files to this checkpoint (current state is saved first)' },
    checkpointScopeConfirm: { fa: 'چه چیزی بازیابی شود؟ وضعیت فعلی اول ذخیره میشود.', en: 'What should be restored? The current state is saved first.' },
    checkpointScopeFiles: { fa: 'فقط فایل ها', en: 'Files only' },
    checkpointScopeFilesAndChat: { fa: 'فایل ها و گفتگو', en: 'Files and conversation' },
    checkpointEmptySeed: { fa: 'این نوبت با ورک اسپیس خالی شروع شده بود؛ فایلی برای بازیابی نیست.', en: 'This turn started with an empty workspace; there are no files to restore.' },
    checkpointTurnGone: { fa: 'این نوبت دیگر در تاریخچه نیست؛ بازیابی انجام نشد.', en: 'That turn is no longer in the history; nothing was restored.' },
    sessionSwitchBusy: { fa: 'صبر کنید کار فعلی تمام شود', en: 'Wait for the current run to finish' },
    planModeLiveNote: { fa: 'تغییر حالت برنامه ریزی روی پاسخ در حال اجرا اعمال نمیشود؛ از پیام بعد اعمال میشود.', en: 'Plan mode changes do not affect the response in progress; it applies from the next message.' },
    sessionLoadFailed: { fa: 'بارگذاری گفتگو ناموفق بود.', en: 'Could not load the conversation.' },
    geoBlockedHint: { fa: 'این ارائه دهنده از IP شما پاسخ نمی دهد. به یک ارائه دهنده ایرانی سوئیچ کنید؟', en: 'This provider refuses your region/IP. Switch to an Iranian provider?' },
    geoBlockedSwitch: { fa: 'سوئیچ به ارائه دهنده ایرانی', en: 'Switch to an Iranian provider' },
    geoBlockedSwitched: { fa: 'به ارائه دهنده ایرانی سوئیچ شد.', en: 'Switched to the Iranian provider.' },
    geoBlockedNoProvider: { fa: 'هنوز ارائه دهنده ایرانی ذخیره نشده؛ از تنظیمات اضافه کنید.', en: 'No Iranian provider saved yet; add one in Settings.' },
};

/** Translate a native-surface key with optional {param} interpolation. */
export function ui(key: string, params?: Record<string, string>): string {
    const entry = STRINGS[key];
    let s = entry ? entry[UI_LOCALE] : key;
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            s = s.split(`{${name}}`).join(value);
        }
    }
    return s;
}

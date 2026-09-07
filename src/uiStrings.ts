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
    // Free-runtime rejections - keys mirror webview-ui/src/i18n.ts.
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

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
    notifCheckpointsUnavailable: { fa: 'نقاط بازیابی در دسترس نیست: {error}', en: 'Checkpoints are unavailable: {error}' },
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
    checkpointRestorePlaceholder: { fa: 'بازیابی فایل ها به این نقطه (وضعیت فعلی هم قبلش ذخیره میشه)', en: 'Restore files to this checkpoint (current state is saved first)' },
    checkpointScopeConfirm: { fa: 'چه چیزی بازیابی بشه؟ وضعیت فعلی اول ذخیره میشه.', en: 'What should be restored? The current state is saved first.' },
    checkpointScopeFiles: { fa: 'فقط فایل ها', en: 'Files only' },
    checkpointScopeFilesAndChat: { fa: 'فایل ها و گفتگو', en: 'Files and conversation' },
    checkpointEmptySeed: { fa: 'این نوبت با ورک اسپیس خالی شروع شده بود؛ فایلی برای بازیابی نیست.', en: 'This turn started with an empty workspace; there are no files to restore.' },
    checkpointTurnGone: { fa: 'این نوبت دیگر در تاریخچه نیست؛ بازیابی انجام نشد.', en: 'That turn is no longer in the history; nothing was restored.' },
    sessionSwitchBusy: { fa: 'صبر کن تا کار فعلی تموم بشه', en: 'Wait for the current run to finish' },
    openDiffFailed: { fa: 'diff برای این ویرایش قابل نمایش نیست.', en: 'No diff to show for this edit.' },
    openDiffPick: { fa: 'کدوم فایل؟', en: 'Which file?' },
    planModeLiveNote: { fa: 'تغییر حالت برنامه ریزی روی پاسخ در حال اجرا اعمال نمیشه؛ از پیام بعد اعمال میشه.', en: 'Plan mode changes do not affect the response in progress; it applies from the next message.' },
    sessionLoadFailed: { fa: 'بارگذاری گفتگو ناموفق بود.', en: 'Could not load the conversation.' },
    geoBlockedHint: { fa: 'این ارائه دهنده از IP شما جواب نمیده. سوئیچ کنی به یه ارائه دهنده ایرانی؟', en: 'This provider refuses your region/IP. Switch to an Iranian provider?' },
    geoBlockedSwitch: { fa: 'سوئیچ به ارائه دهنده ایرانی', en: 'Switch to an Iranian provider' },
    geoBlockedSwitched: { fa: 'به ارائه دهنده ایرانی سوئیچ شد.', en: 'Switched to the Iranian provider.' },
    geoBlockedNoProvider: { fa: 'هنوز ارائه دهنده ایرانی ذخیره نشده؛ از تنظیمات اضافه کن.', en: 'No Iranian provider saved yet; add one in Settings.' },
    agentPickerTitle: { fa: 'فایل های زیرعامل', en: 'Agent files' },
    agentPickerPlaceholder: { fa: 'یه زیرعامل انتخاب کن تا فایلش باز بشه', en: 'Pick an agent to open its file' },
    agentCreateItem: { fa: 'ساخت فایل زیرعامل جدید', en: 'Create a new agent file' },
    agentCreateDescription: { fa: 'یه فایل .md توی .xratu/agents/ میسازه', en: 'Writes a .md file into .xratu/agents/' },
    agentCreateTitle: { fa: 'نام زیرعامل', en: 'Agent name' },
    agentCreatePrompt: { fa: 'فقط حروف کوچک انگلیسی، عدد و خط تیره. همین اسم، اسم فایل .md میشه.', en: 'Lowercase letters, digits and single hyphens. This becomes the .md file name.' },
    agentCreateErrorEmpty: { fa: 'اسم لازمه.', en: 'A name is required.' },
    agentCreateErrorName: { fa: 'اسم باید حروف کوچک انگلیسی، عدد و خط تیره تکی باشه (مثلا code-reviewer).', en: 'Use lowercase letters, digits and single hyphens (e.g. code-reviewer).' },
    agentCreateErrorExists: { fa: 'این فایل از قبل هست: {path}', en: 'That file already exists: {path}' },
    agentCreateFailed: { fa: 'ساخت فایل ناموفق بود: {error}', en: 'Could not create the file: {error}' },
    agentStatusOk: { fa: 'سالم', en: 'ok' },
    agentStatusWarning: { fa: 'هشدار', en: 'warning' },
    agentStatusBroken: { fa: 'خراب', en: 'broken' },
    'agentSource.builtin': { fa: 'پیش فرض', en: 'built-in' },
    'agentSource.project-xratu': { fa: 'پروژه (.xratu/agents)', en: 'project (.xratu/agents)' },
    'agentSource.project-agents': { fa: 'پروژه (.agents/agents)', en: 'project (.agents/agents)' },
    'agentSource.project-claude': { fa: 'پروژه (.claude/agents)', en: 'project (.claude/agents)' },
    'agentSource.global-agents': { fa: 'کاربر (~/.agents/agents)', en: 'user (~/.agents/agents)' },
    'agentSource.global-claude': { fa: 'کاربر (~/.claude/agents)', en: 'user (~/.claude/agents)' },
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

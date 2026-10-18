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
    engineCompacting: { fa: "OpenCode داره سابقه گفتگو رو فشرده میکنه.", en: "OpenCode is compacting conversation history." },
    engineCompacted: { fa: "فشرده سازی سابقه OpenCode تموم شد.", en: "OpenCode history compaction finished." },
    engineCompactionFailed: { fa: "فشرده سازی سابقه OpenCode انجام نشد: {error}", en: "OpenCode history compaction failed: {error}" },
    prMonitorPrompt: { fa: "خبر جدیدی برای PR های این گفتگو رسیده. طبق درخواست قبلیم بررسیش کن.", en: "There are updates on this conversation’s pull requests. Review them according to my existing task." },
    engineRewindUnsupported: { fa: "ویرایش پیام های قبلی در موتور OpenCode فعلا پشتیبانی نمیشه. یک گفتگوی تازه بساز.", en: "Editing past messages is not supported by the OpenCode engine yet. Start a new conversation." },
    engineSteerUnsupported: { fa: "برای فرستادن پیام بعدی به OpenCode صبر کن اجرا تموم بشه یا لغوش کن.", en: "Wait for OpenCode to finish, or cancel the run, before sending another message." },
    engineBackgroundFailed: { fa: "انتقال دستور به پس زمینه انجام نشد: {detail}", en: "Could not background the command: {detail}" },
    engineBackgroundNotReady: { fa: "بعد از شروع دستور میتونی به پس زمینه بفرستیش.", en: "Background is available after the command starts." },
    surfaceChangesFailed: { fa: "تغییرات بارگذاری نشد. دوباره تازه سازی کن.", en: "Could not load changes. Try refreshing." },
    surfaceAgentsFailed: { fa: "فایل های ایجنت بارگذاری نشد. دوباره تازه سازی کن.", en: "Could not load agent files. Try refreshing." },
    offlineRemoteBlocked: { fa: 'حالت آفلاین دسترسی به سرویس های ابری رو بسته', en: 'Offline mode blocks cloud services' },
    localModelBusy: { fa: 'اول عملیات فعلی یا گفتگو رو تموم کن', en: 'Finish the current operation or chat first' },
    localModelEndpoint: { fa: 'مدیریت مدل فقط برای Ollama روی همین سیستم فعاله', en: 'Model management is available only for Ollama on this machine' },
    benchmarkSelectModel: { fa: 'اول یه اتصال و مدل انتخاب کن', en: 'Select a connection and model first' },
    notifNoFolder: { fa: 'هیچ پوشه ای باز نیست', en: 'No folder is open' },
    notifNoCheckpoints: { fa: 'هنوز نقطه بازیابی وجود ندارد', en: 'No checkpoints yet' },
    notifCheckpointsUnavailable: { fa: 'نقاط بازیابی در دسترس نیست: {error}', en: 'Checkpoints are unavailable: {error}' },
    notifRestoreConfirm: { fa: 'فایل های ورک اسپیس به {target} برمیگردند. ادامه؟', en: 'Workspace files will be restored to {target}. Continue?' },
    notifRestoreAction: { fa: 'بازیابی', en: 'Restore' },
    notifCancel: { fa: 'لغو', en: 'Cancel' },
    notifRestored: { fa: 'به نقطه {sha} بازگردانده شد (وضعیت قبلی با {safety} ذخیره شد)', en: 'Restored to {sha} (previous state saved as {safety})' },
    notifRestoreFailed: { fa: 'بازیابی ناموفق بود: {error}', en: 'Restore failed: {error}' },
    reviewCheckpointPlaceholder: { fa: 'تغییرات رو از کدوم نقطه بررسی کنم؟', en: 'Review changes since which checkpoint?' },
    reviewFilesPlaceholder: { fa: 'یه فایل برای بررسی انتخاب کن', en: 'Pick a file to review' },
    reviewHunksPlaceholder: { fa: 'کدوم بخش از تغییر رو باز کنم؟', en: 'Open which changed hunk?' },
    reviewFileNew: { fa: 'جدید', en: 'new' },
    reviewFileBinary: { fa: 'باینری', en: 'binary' },
    notifReviewNoChanges: { fa: 'از این نقطه به بعد هیچ فایلی عوض نشده', en: 'No files changed since this checkpoint' },
    notifReviewNoHunks: { fa: 'هیچ تغییر متنی در {file} نیست', en: 'No text changes in {file}' },
    notifReviewBinary: { fa: '{file} باینریه و متنش رو نمیشه نشون داد', en: '{file} is binary - it has no text preview' },
    notifReviewTooLarge: { fa: '{file} خیلی بزرگه و پیش نمایش براش باز نمیشه', en: '{file} is too large to preview' },
    notifReviewFailed: { fa: 'بررسی تغییرات ناموفق بود: {error}', en: 'Reviewing changes failed: {error}' },
    notifRewindNoText: { fa: 'متن این پیام برای ارسال دوباره پیدا نشد', en: 'The text of this message could not be found for resending' },
    notifCpRestoreFailed: { fa: 'بازیابی نقطه بازرسی ناموفق بود: {error}', en: 'Checkpoint restore failed: {error}' },
    notifEditFailed: { fa: 'ویرایش پیام ناموفق بود: {error}', en: 'Editing the message failed: {error}' },
    notifRegenerateFailed: { fa: 'تولید دوباره ناموفق بود: {error}', en: 'Regeneration failed: {error}' },
    notifBackgroundJobGone: { fa: 'این دستور دیگه در حال اجرا نیست', en: 'That command is no longer running' },
    notifBackgroundAdopted: { fa: '{count} پروسه در پس زمینه از قبل اجرا مونده و دوباره به دست اومد', en: '{count} background process(es) from the previous session were recovered' },
    notifBackgroundUnrecoverable: { fa: '{count} پروسه در پس زمینه قابل بازیابی نبود و رها شد', en: '{count} background process record(s) could not be verified and were dropped' },
    notifBackgroundAlreadyRunning: { fa: 'این دستور همین حالا در پس زمینه در حال اجراست', en: 'That command is already running in the background' },
    copyCode: { fa: 'کپی', en: 'Copy' },
    checkpointRestorePlaceholder: { fa: 'بازیابی فایل ها به این نقطه (وضعیت فعلی هم قبلش ذخیره میشه)', en: 'Restore files to this checkpoint (current state is saved first)' },
    checkpointScopeConfirm: { fa: 'فایل های کل پوشه کاری بازیابی میشن. وضعیت فعلی اول ذخیره میشه. گفتگو هم برگرده؟', en: 'Restore files across the whole workspace? The current state is saved first. Also rewind the conversation?' },
    checkpointScopeFiles: { fa: 'فقط فایل ها', en: 'Files only' },
    checkpointScopeFilesAndChat: { fa: 'فایل ها و گفتگو', en: 'Files and conversation' },
    checkpointEmptySeed: { fa: 'این نوبت با ورک اسپیس خالی شروع شده بود؛ فایلی برای بازیابی نیست', en: 'This turn started with an empty workspace; there are no files to restore' },
    checkpointActionStale: { fa: 'گفتگو، نوبت یا پوشه کاری عوض شده. چیزی بازیابی نشد؛ دوباره از گفتگوی فعلی درخواست بده.', en: 'The session, turn or workspace changed. Nothing was restored; request restore again from the current session.' },
    checkpointBackgroundBusy: { fa: 'یه پردازش پس زمینه توی این پوشه هنوز فعاله. از بخش پس زمینه متوقفش کن و دوباره بازیابی رو بزن.', en: 'A background process is still running in this workspace. Stop it from Background, then request restore again.' },
    checkpointTurnGone: { fa: 'این نوبت یا نقطه بازگشت دیگه در دسترس نیست. چیزی بازیابی نشد؛ یه نقطه بازگشت موجود رو انتخاب کن و دوباره امتحان کن.', en: 'That turn or checkpoint is no longer available. Nothing was restored; choose an existing checkpoint and try again.' },
    sessionSwitchBusy: { fa: 'صبر کن تا کار فعلی تموم بشه', en: 'Wait for the current run to finish' },
    openDiffFailed: { fa: 'diff برای این ویرایش قابل نمایش نیست', en: 'No diff to show for this edit' },
    openDiffPick: { fa: 'کدوم فایل؟', en: 'Which file?' },
    planModeLiveNote: { fa: 'تغییر حالت برنامه ریزی روی پاسخ در حال اجرا اعمال نمیشه؛ از پیام بعد اعمال میشه', en: 'Plan mode changes do not affect the response in progress; it applies from the next message' },
    sessionSwitchStale: { fa: 'گفتگو یا پوشه کاری موقع بارگذاری عوض شد. دوباره گفتگوی مورد نظرت رو انتخاب کن.', en: 'The session or workspace changed during loading. Select the intended session again.' },
    gitCheckoutBusy: { fa: 'صبر کن تا اجرای فعلی یا کار گفتگو تموم بشه؛ بعد branch رو عوض کن.', en: 'Wait for the current run or session action to finish before switching branches.' },
    sessionCreateFailed: { fa: 'گفتگوی جدید ساخته نشد. دوباره امتحان کن.', en: 'Could not create a new conversation. Try again.' },
    sessionSaveFailed: { fa: 'تغییر گفتگو انجام شد، ولی ذخیره سازی کامل نشد. قبل از بستن پنجره دوباره امتحان کن.', en: 'The session changed, but saving did not finish. Try again before closing the window.' },
    sessionLoadFailed: { fa: 'گفتگو بارگذاری نشد. گفتگوی فعلیت سر جاشه؛ یه گفتگوی دیگه رو انتخاب کن یا دوباره امتحان کن.', en: 'Could not load the conversation. Your current chat is preserved; choose another session or try again.' },
    geoBlockedHint: { fa: 'این ارائه دهنده از IP شما جواب نمیده. سوئیچ کنی به یه ارائه دهنده ایرانی؟', en: 'This provider refuses your region/IP. Switch to an Iranian provider?' },
    geoBlockedSwitch: { fa: 'سوئیچ به ارائه دهنده ایرانی', en: 'Switch to an Iranian provider' },
    geoBlockedSwitched: { fa: 'به ارائه دهنده ایرانی سوئیچ شد', en: 'Switched to the Iranian provider' },
    geoBlockedNoProvider: { fa: 'هنوز ارائه دهنده ایرانی ذخیره نشده؛ از تنظیمات اضافه کن', en: 'No Iranian provider saved yet; add one in Settings' },
    // OAuth loopback callback pages (host-rendered HTML the BROWSER shows).
    oauthCallbackDone: { fa: 'ورود انجام شد. میتونی این تب رو ببندی.', en: 'Sign-in complete. You can close this tab.' },
    oauthCallbackFailed: { fa: 'ورود انجام نشد. به VS Code برگرد.', en: 'Sign-in did not complete. Return to VS Code.' },
    agentPickerTitle: { fa: 'فایل های زیرعامل', en: 'Agent files' },
    agentPickerPlaceholder: { fa: 'یه زیرعامل انتخاب کن تا فایلش باز بشه', en: 'Pick an agent to open its file' },
    agentCreateItem: { fa: 'ساخت فایل زیرعامل جدید', en: 'Create a new agent file' },
    agentCreateDescription: { fa: 'یه فایل .md توی .xratu/agents/ میسازه', en: 'Writes a .md file into .xratu/agents/' },
    agentCreateTitle: { fa: 'نام زیرعامل', en: 'Agent name' },
    agentCreatePrompt: { fa: 'فقط حروف کوچک انگلیسی، عدد و خط تیره. همین اسم، اسم فایل .md میشه.', en: 'Lowercase letters, digits and single hyphens. This becomes the .md file name.' },
    agentCreateErrorEmpty: { fa: 'اسم لازمه', en: 'A name is required' },
    agentCreateErrorName: { fa: 'اسم باید حروف کوچک انگلیسی، عدد و خط تیره تکی باشه (مثلا code-reviewer)', en: 'Use lowercase letters, digits and single hyphens (e.g. code-reviewer)' },
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

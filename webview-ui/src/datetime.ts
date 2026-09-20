/**
 * Locale-aware date/time formatting for the webview.
 *
 * The webview language is independent of the OS/browser locale (a Persian
 * user often runs an English VS Code), so timestamps must follow the app's
 * locale, not the runtime default.
 */
import { getLocale } from './i18n';

/**
 * Clock time for a message timestamp. Persian uses `fa-IR` (Persian digits,
 * 24-hour clock); English keeps the browser default 12-hour clock.
 */
export function formatClockTime(ts: number): string {
    const date = new Date(ts);
    if (getLocale() === 'fa') {
        return new Intl.DateTimeFormat('fa-IR', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(date);
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

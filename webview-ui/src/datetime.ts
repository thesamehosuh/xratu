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

/**
 * Calendar date for a timestamp. Persian uses the **Jalali (Solar Hijri)**
 * calendar via `fa-IR-u-ca-persian` (Persian digits included); English uses
 * the runtime locale's calendar.
 */
export function formatCalendarDate(ts: number): string {
    const date = new Date(ts);
    if (getLocale() === 'fa') {
        return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        }).format(date);
    }
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Date + time, for tooltips (exact when a relative label is shown inline). */
export function formatFullTimestamp(ts: number): string {
    return `${formatCalendarDate(ts)} ${formatClockTime(ts)}`;
}

/** True when two instants fall on the same LOCAL calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

/** LOCAL calendar day key (YYYY-MM-DD) - never UTC, so chart buckets match the
 *  user's clock (the host ledger buckets days the same way). */
export function localDayKey(ts: number): string {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

/** The local day `delta` days from a YYYY-MM-DD key. */
export function shiftLocalDay(key: string, delta: number): string {
    const [year, month, day] = key.split('-').map(Number);
    return localDayKey(new Date(year, (month || 1) - 1, (day || 1) + delta).getTime());
}

/** LOCAL midnight for a YYYY-MM-DD key (for formatting a bucket). */
export function localDayTimestamp(key: string): number {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1).getTime();
}

/**
 * Message timestamp: just the clock for today, date + clock for older
 * messages. Chat UIs avoid repeating today's date on every bubble, but an
 * older message with only a time is ambiguous.
 */
export function formatMessageTimestamp(ts: number): string {
    return isSameLocalDay(new Date(ts), new Date())
        ? formatClockTime(ts)
        : `${formatCalendarDate(ts)} ${formatClockTime(ts)}`;
}

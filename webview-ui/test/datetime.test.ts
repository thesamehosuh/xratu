import assert from 'node:assert/strict';
import { formatCalendarDate, formatClockTime, formatFullTimestamp, formatMessageTimestamp, isSameLocalDay, localDayKey, localDayTimestamp, shiftLocalDay } from '../src/datetime';
import { setLocale } from '../src/i18n';

// A LOCAL 13:05 - deliberately past noon so a 12-hour clock would render a
// different hour (1) than the 24-hour clock (13). Intl formats in the process
// timezone, so compare against the explicitly-configured formatter instead of
// a hardcoded string; that stays valid on any host and still fails if the
// production options regress (e.g. hour12 flipped on).
const date = new Date(2026, 8, 20, 13, 5, 0);
const ts = date.getTime();

setLocale('fa');
const fa = formatClockTime(ts);
const faExpected = new Intl.DateTimeFormat('fa-IR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
}).format(date);
assert.equal(fa, faExpected, `fa should be fa-IR 24-hour, got ${fa}`);
assert.ok(/[\u06F0-\u06F9]/.test(fa), `fa should use Persian digits, got ${fa}`);

setLocale('en');
const en = formatClockTime(ts);
// The English branch delegates to the runtime locale - assert delegation, not
// a digit script, so a non-Latin host locale doesn't fail the suite.
assert.equal(en, date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

// Jalali (Solar Hijri) calendar for Persian: 20 Sep 2026 falls in 1405.
setLocale('fa');
const jalali = formatCalendarDate(new Date(2026, 8, 20, 12, 5).getTime());
assert.ok(/[\u06F0-\u06F9]/.test(jalali), `Jalali date should use Persian digits, got ${jalali}`);
assert.ok(jalali.includes('۱۴۰۵'), `expected the Jalali year 1405, got ${jalali}`);

// Message timestamp: clock only for today, date + clock for older messages.
// The same-day rule is asserted directly (deterministic); the format check is
// guarded by it so a local-midnight crossing cannot make the test flaky.
assert.equal(isSameLocalDay(new Date(2026, 8, 20, 0, 0), new Date(2026, 8, 20, 23, 59)), true);
assert.equal(isSameLocalDay(new Date(2026, 8, 20, 23, 59), new Date(2026, 8, 21, 0, 0)), false);
const now = Date.now();
if (isSameLocalDay(new Date(now), new Date())) {
    assert.equal(formatMessageTimestamp(now), formatClockTime(now), 'today shows the clock only');
}
const older = now - 30 * 86_400_000;
const olderText = formatMessageTimestamp(older);
assert.ok(olderText.includes(formatCalendarDate(older)), `older messages carry the date, got ${olderText}`);
assert.ok(olderText.includes(formatClockTime(older)), `older messages carry the clock, got ${olderText}`);

// Full timestamp (tooltip) always has both.
assert.ok(formatFullTimestamp(older).includes(formatCalendarDate(older)));
assert.ok(formatFullTimestamp(older).includes(formatClockTime(older)));

// Local day keys must bucket by the LOCAL calendar (the host ledger does the
// same), so a late-evening instant never lands on the next UTC day.
assert.equal(localDayKey(new Date(2026, 8, 20, 23, 30).getTime()), '2026-09-20');
assert.equal(localDayKey(new Date(2026, 8, 20, 0, 15).getTime()), '2026-09-20');
assert.equal(shiftLocalDay('2026-09-20', 1), '2026-09-21');
assert.equal(shiftLocalDay('2026-09-01', -1), '2026-08-31');
assert.equal(shiftLocalDay('2026-12-31', 1), '2027-01-01');
// Month rollover across a leap year.
assert.equal(shiftLocalDay('2028-02-28', 1), '2028-02-29');
// localDayTimestamp is LOCAL midnight of that key, so round-tripping is stable.
assert.equal(localDayKey(localDayTimestamp('2026-09-20')), '2026-09-20');

// Restore the Persian-first default for any later test in the bundle.
setLocale('fa');

console.log('datetime.test.ts: all tests passed');

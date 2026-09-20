import assert from 'node:assert/strict';
import { formatClockTime } from '../src/datetime';
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

// Restore the Persian-first default for any later test in the bundle.
setLocale('fa');

console.log('datetime.test.ts: all tests passed');

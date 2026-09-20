import assert from 'node:assert/strict';
import { formatClockTime } from '../src/datetime';
import { setLocale } from '../src/i18n';

// 12:05 UTC on a fixed day. Intl formats in the process timezone, so assert
// the FORMAT properties (digit script, 24h) rather than an exact string.
const ts = Date.UTC(2026, 8, 20, 12, 5, 0);

setLocale('fa');
const fa = formatClockTime(ts);
assert.ok(/[\u06F0-\u06F9]/.test(fa), `fa should use Persian digits, got ${fa}`);
assert.ok(!/[AP]M/i.test(fa), `fa should be 24-hour, got ${fa}`);

setLocale('en');
const en = formatClockTime(ts);
assert.ok(/[0-9]/.test(en), `en should use Latin digits, got ${en}`);

// Restore the Persian-first default for any later test in the bundle.
setLocale('fa');

console.log('datetime.test.ts: all tests passed');

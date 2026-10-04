#!/usr/bin/env node
/**
 * Transcript-preference store tests - the Settings page's auto-expand
 * switches (diffs / commands / reasoning).
 *
 * The host persists this blob opaquely and never interprets the row ids (the
 * webview owns that schema), so the host's only job is the trust boundary:
 * `transcriptSet` is webview input. Regression coverage pins:
 *   - a corrupt/hand-edited store degrades to "no overrides", never throws;
 *   - non-boolean values and malformed ids are dropped;
 *   - prototype-polluting keys can never enter the map;
 *   - the map is capped so junk input cannot grow the store unbounded;
 *   - folding a toggle is idempotent and preserves untouched ids.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-transcript-prefs.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    parseTranscriptPrefs, withTranscriptPref, emptyTranscriptPrefs, isTranscriptId,
} = require('../out/transcriptPrefs.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- empty / missing store means "no overrides" ---
check('undefined store', parseTranscriptPrefs(undefined), { expand: {} });
check('empty string store', parseTranscriptPrefs(''), { expand: {} });
check('malformed JSON', parseTranscriptPrefs('{nope'), { expand: {} });
check('array root', parseTranscriptPrefs('[]'), { expand: {} });
check('string root', parseTranscriptPrefs('"hi"'), { expand: {} });
check('null map', parseTranscriptPrefs('{"expand":null}'), { expand: {} });
check('array map', parseTranscriptPrefs('{"expand":[]}'), { expand: {} });

// --- a well-formed blob round-trips ---
check('round trip', parseTranscriptPrefs('{"expand":{"edit":true,"terminal":false}}'),
    { expand: { edit: true, terminal: false } });
check('explicit false survives', parseTranscriptPrefs('{"expand":{"edit":false}}').expand.edit, false);
check('thinking id kept', parseTranscriptPrefs('{"expand":{"thinking":true}}').expand.thinking, true);

// --- hostile / junk values are dropped ---
check('non-boolean dropped', parseTranscriptPrefs('{"expand":{"edit":"yes"}}'), { expand: {} });
check('null value dropped', parseTranscriptPrefs('{"expand":{"edit":null}}'), { expand: {} });
check('numeric value dropped', parseTranscriptPrefs('{"expand":{"edit":1}}'), { expand: {} });
check('unknown axis dropped', parseTranscriptPrefs('{"show":{"read":false}}'), { expand: {} });
check('__proto__ id dropped', parseTranscriptPrefs('{"expand":{"__proto__":true}}'), { expand: {} });
check('constructor id dropped', parseTranscriptPrefs('{"expand":{"constructor":true}}'), { expand: {} });
check('uppercase id dropped', parseTranscriptPrefs('{"expand":{"Edit":true}}'), { expand: {} });
check('id with space dropped', parseTranscriptPrefs('{"expand":{"my id":true}}'), { expand: {} });
check('id with slash dropped', parseTranscriptPrefs('{"expand":{"a/b":true}}'), { expand: {} });
check('overlong id dropped', parseTranscriptPrefs(`{"expand":{"${'a'.repeat(33)}":true}}`), { expand: {} });
check('32-char id kept', parseTranscriptPrefs(`{"expand":{"${'a'.repeat(32)}":true}}`).expand['a'.repeat(32)], true);

// --- a parsed proto-polluting payload does not leak onto Object.prototype ---
parseTranscriptPrefs('{"expand":{"__proto__":{"polluted":true}}}');
check('Object.prototype clean', ({}).polluted, undefined);

// --- the map is capped ---
const many = JSON.stringify({ expand: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, true])) });
check('capped at 32 ids', Object.keys(parseTranscriptPrefs(many).expand).length, 32);

// --- id validation ---
check('id ok', isTranscriptId('thinking'), true);
check('id leading digit rejected', isTranscriptId('7zip'), false);
check('id reserved rejected', isTranscriptId('toString'), false);
check('id non-string rejected', isTranscriptId(7), false);

// --- folding one toggle ---
const base = { expand: { edit: true, thinking: false } };
check('fold a new id', withTranscriptPref(base, 'terminal', true),
    { expand: { edit: true, thinking: false, terminal: true } });
check('fold flips a stored true off', withTranscriptPref(base, 'edit', false),
    { expand: { edit: false, thinking: false } });
check('fold is idempotent', withTranscriptPref(base, 'edit', true), base);
check('fold flips a stored false on', withTranscriptPref(base, 'thinking', true),
    { expand: { edit: true, thinking: true } });
check('bad id is a no-op', withTranscriptPref(base, 'Bad Id', false), base);
check('proto id is a no-op', withTranscriptPref(base, '__proto__', false), base);
check('empty id is a no-op', withTranscriptPref(base, '', false), base);
check('base untouched', base, { expand: { edit: true, thinking: false } });

// --- the cap also guards folding, not just parsing ---
const full = { expand: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, true])) };
check('fold beyond cap is a no-op', withTranscriptPref(full, 'terminal', true), full);
check('toggling a full map still works', withTranscriptPref(full, 'k0', false).expand.k0, false);
check('empty helper', emptyTranscriptPrefs(), { expand: {} });

console.log(failed === 0 ? '\ntranscript-prefs: all assertions passed' : `\ntranscript-prefs: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
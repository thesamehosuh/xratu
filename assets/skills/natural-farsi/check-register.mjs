#!/usr/bin/env node
/**
 * check-register.mjs — machine-checkable register/orthography lint for the
 * natural-farsi skill (level-3 colloquial Persian).
 *
 * Usage:
 *   node check-register.mjs draft.txt [more.txt ...]   # lint files
 *   cat draft.txt | node check-register.mjs            # lint stdin
 *   node check-register.mjs --selftest                 # verify the rules
 *
 * Run it on the FINAL Persian output only. Quoted source text in a
 * translation task is supposed to look wrong and is exempt.
 *
 * Windows-first: pure Node, no dependencies, no path assumptions.
 *
 * NOTE: this file is scanned by test/test-farsi-orthography.mjs like any
 * other source file, so every banned character (half-space U+200C, harakat,
 * tatweel U+0640, Arabic yeh/kaf, glued me-prefix + alef madda) is spelled
 * with code points below — the literals would flag the guard.
 */

import { readFileSync } from 'node:fs';

const ZWNJ = '\u200c';
const TATWEEL = '\u0640';
const ALEF_MADDA = '\u0622';
const ARABIC_YEH = '\u064a';
const ARABIC_KAF = '\u0643';

/** Letters that may sit next to a word (Arabic block + presentation forms). */
const PERSIAN_LETTER = '\\u0600-\\u06FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF';

/** [id, regex on ZWNJ-stripped text, suggestion] — word rules. */
const WORD_RULES = [
  ['obj-marker', new RegExp(`(?<![${PERSIAN_LETTER}])را(?![${PERSIAN_LETTER}])`), 'رو'],
  ['demonstrative', /همان/, 'همون'],
  ['demonstrative', new RegExp(`(?<![${PERSIAN_LETTER}])آن(?![${PERSIAN_LETTER}])`), 'اون'],
  // آنها / the half-spaced compounds are spelled with escapes (the compounds
  // carry U+200C in their written form).
  ['demonstrative', new RegExp(`آنها|آن${ZWNJ}جا|آن${ZWNJ}طور|آن${ZWNJ}قدر`), 'اونا / اونجا / اون طور / اون قدر'],
  ['copula', new RegExp(`(?<![${PERSIAN_LETTER}])است(?![${PERSIAN_LETTER}])`), 'attach the eh-clitic (اینه، خوبه) or use هست'],
  ['level1', /میباشد/, 'هست or the eh-clitic'],
  ['level1', /میگردد/, 'میشه'],
  ['literary-future', new RegExp(`(?<![${PERSIAN_LETTER}])خواهد(?![${PERSIAN_LETTER}])`), 'the mi-present (میشه / میره) or قراره'],
  ['verb-3sg', /میدهد/, 'میده'],
  ['verb-3sg', /میکند/, 'میکنه'],
  ['verb-3sg', /میشود/, 'میشه'],
  ['verb-3sg', new RegExp(`(?<![${PERSIAN_LETTER}])دارد(?![${PERSIAN_LETTER}])`), 'داره'],
  ['verb-3sg', /میخواند/, 'میخونه'],
  ['verb-3sg', /میداند/, 'میدونه'],
  ['verb-3sg', /میتواند/, 'میتونه'],
  ['verb-3sg', /میگوید/, 'میگه'],
  ['verb-3sg', /میگذارد/, 'میذاره'],
  // می + alef madda is the glued (wrong) form the guard bans; match it via
  // code points so this file stays clean.
  ['verb-3sg', new RegExp(`می${ALEF_MADDA}ید`), 'میاد'],
  ['verb-3sg', /میرود/, 'میره'],
  ['verb-3sg', /میخواهد/, 'میخواد'],
  ['verb-3pl', /میکنند/, 'میکنن'],
  ['verb-3pl', /میشوند/, 'میشن'],
  ['verb-3pl', /میخواهند/, 'میخوان'],
  ['verb-3pl', /میروند/, 'میرن'],
  ['verb-3pl', new RegExp(`می${ALEF_MADDA}یند`), 'میان'],
  ['verb-3pl', /میدهند/, 'میدن'],
  ['verb-3pl', /میگویند/, 'میگن'],
  ['verb-1sg', /میخواهم/, 'میخوام'],
  ['verb-1sg', /میتوانم/, 'میتونم'],
  ['verb-1sg', /میدانم/, 'میدونم'],
  ['verb-2sg', /میخواهی/, 'میخوای'],
  ['verb-2sg', /میتوانی/, 'میتونی'],
  ['verb-2sg', /میدانی/, 'میدونی'],
  ['verb-2pl', /میخواهید/, 'میخواید'],
  ['verb-2pl', /میتوانید/, 'میتونید'],
  ['verb-2pl', /میکنید/, 'میکنین'],
  ['verb-2pl', /کنید/, 'کنین'],
  ['verb-2pl', /بگویید/, 'بگید'],
  ['verb-2pl', /بیایید/, 'بیاین'],
  ['verb-2pl', /بخوانید/, 'بخونید'],
  ['verb-2pl', /بدانید/, 'بدونید'],
  ['verb-2pl', /بنشینید/, 'بشینید'],
  ['verb-2pl', /بیاورید/, 'بیارید'],
  ['verb-2pl', /بگذارید/, 'بذارید'],
  ['verb-2pl', /بروید/, 'برید'],
];

/** [id, regex, description] — character-class rules. */
const CHAR_RULES = [
  ['zwnj', new RegExp(ZWNJ, 'g'), 'U+200C half-space — remove it (see skill orthography rules)'],
  ['diacritic', /[\u064b-\u0655\u0670]/, 'Arabic harakat/hamza mark — strip it'],
  ['tatweel', new RegExp(TATWEEL, 'g'), 'tatweel/kashida — remove it (clitics attach without it)'],
  ['hamza-letter', /[\u0621\u0623\u0624\u0626]/, 'hamza letter — use the plain Persian letter'],
  ['arabic-yeh-kaf', new RegExp(`[${ARABIC_YEH}${ARABIC_KAF}]`), 'Arabic yeh/kaf — use Persian yeh (U+06CC) / kaf (U+06A9)'],
  ['me-glued-alef', new RegExp(`می${ALEF_MADDA}`), 'me-prefix glued to alef madda — keep a boundary: می آید / میاورد (minus half-space)'],
];

function lintText(text, label) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    CHAR_RULES.forEach(([id, re, desc]) => {
      for (const m of raw.matchAll(new RegExp(re, 'g'))) {
        findings.push({ label, lineNo, col: m.index + 1, id, got: m[0], fix: desc });
      }
    });
    // Word rules run on ZWNJ-stripped text so both the glued and the
    // half-spaced spellings match; the half-space itself is already reported
    // by the char rule.
    const stripped = raw.split(ZWNJ).join('');
    WORD_RULES.forEach(([id, re, fix]) => {
      for (const m of stripped.matchAll(new RegExp(re, 'g'))) {
        findings.push({ label, lineNo, col: m.index + 1, id, got: m[0], fix });
      }
    });
  });
  return findings;
}

function selftest() {
  const cases = [
    ['فایل را میخواند. این بخش مهم است و همان نکته میشود.', ['obj-marker', 'demonstrative', 'copula', 'verb-3sg', 'verb-3sg']],
    ['فایل رو میخونه. این بخش مهمه و همون نکته میشه.', []],
    ['فایل ساده هست. بدون مشکل.', []],
    ['فایل ساده است.', ['copula']],
    ['اگه رو نخونی گم میشی. همون طور که گفتم.', []],
    // half-spaced spellings built from code points (see file note)
    [`نمی${ZWNJ}شود و نمیخواهد و می${ZWNJ}کنند.`, ['zwnj', 'zwnj', 'verb-3sg', 'verb-3sg', 'verb-3pl']],
    [`کاملا${'\u064b'}`, ['diacritic']],
    ['مسأله', ['hamza-letter']],
    [`می${ALEF_MADDA}رود`, ['me-glued-alef']],
    [`این می${ALEF_MADDA}ید`, ['me-glued-alef', 'verb-3sg']],
  ];
  let failed = 0;
  for (const [text, expectIds] of cases) {
    const got = lintText(text, 'selftest').map((f) => f.id);
    const ok = JSON.stringify(got) === JSON.stringify(expectIds);
    if (!ok) {
      failed++;
      console.error(`FAIL: ${text}\n  expected: ${JSON.stringify(expectIds)}\n  got:      ${JSON.stringify(got)}`);
    }
  }
  // Word rules must not fire inside longer words.
  const falsePositives = lintText('راست از استفاده پرداخت درآمد سرایت برادر', 'selftest')
    .filter((f) => f.id === 'obj-marker' || f.id === 'copula');
  if (falsePositives.length) {
    failed++;
    console.error(`FAIL: boundary false positives: ${JSON.stringify(falsePositives)}`);
  }
  console.log(failed === 0 ? 'selftest: all rules pass' : `selftest: ${failed} failure(s)`);
  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  const inputs = args.length
    ? args.map((f) => ({ label: f, text: readFileSync(f, 'utf-8') }))
    : [{ label: '<stdin>', text: readFileSync(0, 'utf-8') }];

  let findings = 0;
  for (const { label, text } of inputs) {
    const found = lintText(text, label);
    findings += found.length;
    for (const f of found) {
      console.log(`${f.label}:${f.lineNo}:${f.col}: [${f.id}] ${f.got} -> ${f.fix}`);
    }
  }
  if (findings === 0) {
    console.log('check-register: clean');
  } else {
    console.log(`check-register: ${findings} finding(s)`);
  }
  process.exit(findings === 0 ? 0 : 1);
}

main();

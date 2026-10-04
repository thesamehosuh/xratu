#!/usr/bin/env node
/**
 * check-register.mjs — machine-checkable register/orthography/language lint
 * for the natural-farsi skill (level-3 colloquial Persian).
 *
 * Usage:
 *   node check-register.mjs draft.txt [more.txt ...]   # lint files
 *   cat draft.txt | node check-register.mjs            # lint stdin
 *   node check-register.mjs --selftest                 # verify the rules
 *   node check-register.mjs --allow-no-persian en.txt  # English source being
 *                                                       # translated FROM:
 *                                                       # skip the
 *                                                       # no-persian check
 *
 * Three families of rule:
 *   1-5  orthography + register (half-space, diacritics, را/است, verb endings)
 *   6    latin-word - every Latin word in prose is tier-A jargon, an acronym,
 *        or a literal code symbol (backticked); anything else is reported with
 *        its Persian equivalent
 *   7    the one-language rule - en-sentence (an English-only sentence inside a
 *        Persian reply) and no-persian (a Persian reply with no Persian in it)
 *
 * Code (fenced blocks, backticks, HTML tags, URLs, link targets) is masked
 * before 6 and 7 run, so identifiers never count as prose.
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

// ---------------------------------------------------------------------------
// Language checks (tier A/B/C/D + the one-language rule)
//
// The register rules above cannot see the failure that actually ships:
// English words that have an obvious Persian equivalent, and whole English
// paragraphs inside an otherwise-Persian reply. Both are checked here.
//
// Code is masked before any of it runs, so backticked identifiers, fenced
// blocks, URLs and HTML never count as prose.
// ---------------------------------------------------------------------------

/** Tier A — the CLOSED list of terms allowed to stay Latin in Persian prose.
 *  English only, by design: this tool must stay language-neutral, so the
 *  Persian side of the vocabulary (what each tier-B/C word becomes) lives in
 *  the skill's tables, curated by a native speaker — never here. */
const TIER_A = new Set([
  'commit', 'push', 'pull', 'pr', 'merge', 'rebase', 'branch', 'checkout',
  'stash', 'cherry-pick', 'lint', 'hook', 'cache', 'endpoint', 'token',
  'git', 'github', 'gitlab', 'vscode', 'venv', 'npm', 'pip',
  'repo', 'patch', 'import', 'helper', 'caller', 'suite', 'shell', 'silence',
]);

/** A token that is shaped like code, not prose: paths, dotted module names,
 *  snake_case, namespaces. Never a language finding. `-` is deliberately NOT
 *  a code character here: `hunk-level` and `case-insensitive` are English
 *  prose, `combat.py` and `quest_progress` are code. */
function isIdentifierShaped(tok) {
  return /[_.\\/:]/.test(tok);
}

/** Match a Latin run TOGETHER with its code punctuation, so `models.py` and
 *  `quest_progress` arrive as one token and `isIdentifierShaped` can see the
 *  dot/underscore. Trailing sentence punctuation is trimmed below. */
const LATIN_RUN = /[A-Za-z][A-Za-z0-9._\-/\\:]*/g;

/** An acronym (API, HTTP, JSON) — Latin by universal convention. */
function isAcronym(tok) {
  return tok.length >= 2 && tok === tok.toUpperCase() && /[A-Z]/.test(tok);
}

/** Replace every non-prose span with spaces, preserving length and newlines
 *  so findings keep their original line/column. */
function maskNonProse(lines) {
  // The OPENING marker is remembered, not just "are we inside a fence": a
  // `~~~` line inside a ``` block is content, and toggling on it would let the
  // rest of the block reach the language checks as prose.
  let fence = null;
  return lines.map((raw) => {
    const open = /^\s*(```|~~~)/.exec(raw);
    if (open) {
      if (!fence) fence = open[1];
      else if (fence === open[1]) fence = null;
      return '';
    }
    if (fence) return '';
    let s = raw;
    // fenced/inline code, HTML tags, URLs, markdown link targets.
    // The tag mask is TAG-SHAPED (`<` `/`? letter) so comparison prose
    // (a < b and c > d) stays visible to the Latin-word checks.
    s = s.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    s = s.replace(/<\/?[A-Za-z][^>]*>/g, (m) => ' '.repeat(m.length));
    s = s.replace(/\bhttps?:\/\/\S+/g, (m) => ' '.repeat(m.length));
    s = s.replace(/\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
    return s;
  });
}

/** An Arabic-script LETTER - not punctuation, not Arabic-Indic digits - and
 *  including the presentation forms. A range test (`\u0600-\u06FF`) would let a
 *  lone `،` or `٥` satisfy "this text is Persian" and let an Arabic-punctuation
 *  segment count as Persian in the one-language rule. */
const PERSIAN_RE = /(?=\p{Script_Extensions=Arabic})\p{L}/u;
const PERSIAN_ANY = /(?=\p{Script_Extensions=Arabic})\p{L}/gu;
const countPersian = (s) => (s.match(PERSIAN_ANY) ?? []).length;
const LATIN_RE = /[A-Za-z]/;

/** Sentence-ish segments of a prose line. A period is NOT a sentence end when it
 *  sits inside a version token (`v1.2`) or a known abbreviation (`e.g.`) -
 *  splitting there would leave sub-3-word fragments and let the whole English
 *  sentence slip through the `en-sentence` check. */
function splitSentences(prose) {
  const guarded = prose
    .replace(/(\d)\.(\d)/g, '$1\u0000$2')
    .replace(/\b(?:e\.g|i\.e|etc|vs|approx|no|fig)\./gi, (m) => m.replace(/\./g, '\u0000'));
  return guarded.split(/[.!?؟؛\n]+/).map((s) => s.replace(/\u0000/g, '.'));
}

function languageFindings(lines, label, opts) {
  const findings = [];
  const masked = maskNonProse(lines);
  const hasPersian = masked.some((l) => PERSIAN_RE.test(l));

  if (!hasPersian && !opts.allowNoPersian) {
    const anyLetters = masked.some((l) => LATIN_RE.test(l));
    if (anyLetters) {
      findings.push({
        label, lineNo: 1, col: 1, id: 'no-persian', got: '(whole text)',
        fix: 'no Persian letters anywhere — a Persian reply must be Persian throughout (pass --allow-no-persian for an English source being translated FROM)',
      });
      return findings;
    }
  }

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const prose = masked[i];
    // NOTE the brackets: an unbracketed /Ae-Zz/g is the literal sequence, not a
    // character class, and silently matches nothing in Persian text.
    const persianChars = countPersian(prose);
    const latinChars = (prose.match(/[A-Za-z]/g) || []).length;

    // Tier B/C/D: any bare Latin word in prose. On a line with no Persian at
    // all the word list is pure noise - the one-language rule below already
    // reports that line once, so skip it here.
    const lineIsEnglish = persianChars === 0 && latinChars > 0;
    if (!lineIsEnglish) {
      for (const m of prose.matchAll(LATIN_RUN)) {
        // `diff.` at the end of a sentence is the word `diff`, not a path.
        const tok = m[0].replace(/[.\-_:]+$/, '');
        if (!tok) continue;
        const lower = tok.toLowerCase();
        if (TIER_A.has(lower) || isAcronym(tok) || isIdentifierShaped(tok)) continue;
        findings.push({
          label, lineNo, col: m.index + 1, id: 'latin-word', got: tok,
          fix: 'not tier-A jargon — write it in Persian script (the skill\'s tier B/C tables give the form), or backtick it if it is a literal code symbol',
        });
      }
    }

    // The one-language rule, per sentence, runs below across the whole file:
    // on THIS line, a Persian line with a long English clause is already fully
    // reported by the word list above, so there is nothing left to add here.
  });

  // The one-language rule, per sentence: no Persian letters at all.
  if (hasPersian) {
    lines.forEach((raw, i) => {
      const prose = masked[i];
      if (!LATIN_RE.test(prose)) return;
      for (const seg of splitSentences(prose)) {
        if (!LATIN_RE.test(seg)) continue;
        if (PERSIAN_RE.test(seg)) continue;
        const words = seg.trim().split(/\s+/).filter(Boolean);
        // Fragments (a table row of hashes, a stray label) are not sentences.
        if (words.length < 3) continue;
        findings.push({
          label, lineNo: i + 1, col: 1, id: 'en-sentence', got: seg.trim().slice(0, 60),
          fix: 'an English-only sentence inside a Persian reply — translate it',
        });
      }
    });
  }

  return findings;
}

function lintText(text, label, opts = {}) {
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
  findings.push(...languageFindings(lines, label, opts));
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
  const state = { get failed() { return failed; }, set failed(v) { failed = v; } };
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
  checkLanguageSelftest(state);
  console.log(failed === 0 ? 'selftest: all rules pass' : `selftest: ${failed} failure(s)`);
  return failed === 0;
}

/** Language rules: the tier list, the masking, and the one-language rule. */
function langCheck(state, name, text, expectIds, opts) {
  const got = lintText(text, 'selftest', opts).map((f) => f.id);
  if (JSON.stringify(got) !== JSON.stringify(expectIds)) {
    state.failed++;
    console.error(`FAIL(lang): ${name}\n  expected: ${JSON.stringify(expectIds)}\n  got:      ${JSON.stringify(got)}`);
  }
}

function checkLanguageSelftest(state) {
  // Tier C words with obvious Persian equivalents are flagged.
  langCheck(state, 'tier C offenders', 'یه debug print جا مونده و schema داده اضافه شده.',
    ['latin-word', 'latin-word', 'latin-word']);
  // Tier A, acronyms, identifiers, paths and URLs must NOT be flagged.
  langCheck(state, 'tier A + acronyms + identifiers',
    'این commit رو روی branch جدید push کن و `API` و `test_sim.py` و https://x.com/a رو نگاه کن.',
    []);
  // Code is masked: an English fenced block or backticked run is not prose.
  langCheck(state, 'fenced code masked',
    '```bash\nthis command line is english\n```\nو بعدش `print(1)` اجرا شد.', []);
  // The one-language rule: an English-only line inside a Persian reply is
  // reported once per sentence, not once per word.
  langCheck(state, 'english line in persian reply',
    'باشه، الان commit ها رو میزنم.\nNow the commits. I am splitting into four here.',
    ['en-sentence', 'en-sentence']);
  // A whole English document, and the escape hatch for translating FROM one.
  langCheck(state, 'english document flagged', 'This is an English source document.\nWith several lines here.',
    ['no-persian']);
  langCheck(state, 'english document allowed', 'This is an English source document.\nWith several lines here.',
    [], { allowNoPersian: true });
  // An abbreviation or a version token must not hide the sentence around it:
  // splitting there would leave sub-3-word fragments and report nothing.
  langCheck(state, 'abbreviation and version inside an english sentence',
    'باشه.\nTry e.g. v1.2 now.', ['en-sentence']);
  // A `~~~` line inside a ``` block is CODE, not a fence close: the rest of the
  // block must stay masked.
  langCheck(state, 'tilde line inside a backtick fence',
    '```bash\n~~~ not a close\nthis command line is english\n```\nو بعدش `print(1)` اجرا شد.', []);
  // Comparison prose is not a tag: `a < b and c > d` must stay visible (five bare
// Latin words), where the old broad mask swallowed `b and c`.
  langCheck(state, 'angle-bracketed comparison is not masked',
    'مثلا a < b and c > d رو ببین.', ['latin-word', 'latin-word', 'latin-word', 'latin-word', 'latin-word']);
  // Clean Persian with tier-A vocabulary must stay clean.
  langCheck(state, 'clean persian', 'همه ۲۲۲ تست سبزن و باید commit کنی.', []);
}

function main() {
  const argv = process.argv.slice(2);
  // Validate BEFORE the --selftest early exit, so a typo fails in every mode:
  // a misspelled `--allow-no-persian` silently lints an English source as a
  // Persian reply and reports no-persian against the translator's own input.
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--selftest' && a !== '--allow-no-persian');
  if (unknown.length) {
    console.error(`check-register: unknown option(s): ${unknown.join(' ')}\n  usage: check-register.mjs [--allow-no-persian] [--selftest] [file.txt ...]`);
    process.exit(2);
  }
  if (argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  const allowNoPersian = argv.includes('--allow-no-persian');
  const files = argv.filter((a) => !a.startsWith('--'));
  const opts = { allowNoPersian };
  const inputs = files.length
    ? files.map((f) => ({ label: f, text: readFileSync(f, 'utf-8') }))
    : [{ label: '<stdin>', text: readFileSync(0, 'utf-8') }];

  let findings = 0;
  for (const { label, text } of inputs) {
    const found = lintText(text, label, opts);
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

#!/usr/bin/env node
/**
 * Grammar coverage for the host-side Shiki renderer.
 *
 * The bug this pins: `initShiki` loaded twelve grammars, `codeToHtml` THROWS
 * for any language that is not loaded, and the `catch` in `highlightCode` was
 * empty. Seventeen everyday fence languages therefore rendered as plain
 * monochrome text with nothing logged anywhere - `tsx`, `jsx`, `go`, `rust`,
 * `c`, `cpp`, `java`, `kotlin`, `swift`, `toml`, `dockerfile`, `scss`, `vue`,
 * `php`, `ruby`, `haskell`, `c++`. It is not detectable by looking at a diff
 * of the rendered output; it is only visible when the colours are missing.
 *
 * The renderer itself cannot be imported: `src/extension.ts` imports `vscode`.
 * So the lists under test are PARSED out of the source instead. That is
 * deliberate - the alternative is a hand-typed copy in the test, which passes
 * happily while the shipped list diverges, which is the whole failure mode.
 *
 * The two structural guards matter as much as the fence tags:
 *
 *  - ONE unknown entry makes the whole `createHighlighter` call reject (it is
 *    not a per-language failure), which leaves `shikiHighlighter` null and
 *    reproduces the original monochrome symptom on a fresh install. A test
 *    that only checked individual fences would miss that entirely.
 *  - `languageLabel` points some fence tags at a DIFFERENT name (`cs` ->
 *    `csharp`, `c++` -> `cpp`). An alias aimed at a grammar that is not loaded
 *    fails the same silent way, so the alias targets are checked too.
 *
 * Run:  npm run test:shiki-langs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHighlighter } from 'shiki';

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repoRoot, 'src', 'extension.ts'), 'utf-8');

// ---------------------------------------------------------------- the source lists

const langsBlock = /const SHIKI_LANGS = \[([\s\S]*?)\] as const;/.exec(src);
ok('SHIKI_LANGS is still declared in src/extension.ts', !!langsBlock,
    'the renderer was restructured - re-point this test at the new shape');
const langs = [...(langsBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

const themesBlock = /themes: \[([^\]]*)\]/.exec(src);
const themes = [...(themesBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

const aliasesBlock = /const aliases: Record<string, string> = \{([\s\S]*?)\n    \};/.exec(src);
ok('the languageLabel alias map is still readable', !!aliasesBlock,
    'the alias map moved - re-point this test at the new shape');
const aliases = new Map(
    [...(aliasesBlock?.[1] ?? '').matchAll(/'?([\w+#.-]+)'?\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
);

ok('the grammar list is not empty', langs.length > 0, `${langs.length} entries`);
ok('both colour themes are declared', themes.length === 2, JSON.stringify(themes));

// ------------------------------------------------------- the list loads as a whole

// The load-bearing assertion: a single bad name rejects this call outright.
let highlighter = null;
try {
    highlighter = await createHighlighter({ themes, langs });
    ok('every declared grammar name is real', true, `${langs.length} names`);
} catch (err) {
    ok('every declared grammar name is real', false, String(err?.message ?? err).slice(0, 160));
}

if (!highlighter) {
    console.log('\nthe grammar list does not load - nothing below can be meaningful');
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
    process.exit(1);
}

const loaded = new Set(highlighter.getLoadedLanguages());

// The fences a model actually writes, plus the ones the old list dropped.
const FENCE_TAGS = [
    'tsx', 'jsx', 'go', 'rust', 'rs', 'c', 'cpp', 'c++', 'java', 'kotlin',
    'swift', 'toml', 'dockerfile', 'scss', 'vue', 'php', 'ruby', 'haskell',
    'js', 'ts', 'py', 'sh', 'shell', 'yml', 'md', 'json', 'yaml', 'html',
    'css', 'sql', 'bash', 'diff', 'xml', 'powershell', 'makefile', 'graphql',
];

/** Deliberately multi-line and multi-token: a single-token snippet could pass
 *  with colours by accident, and a one-line snippet would not catch a theme
 *  that only styles the first line. */
const SAMPLE = "const x = 'y'; // hi\nfunction f() {\n  return 1;\n}\n";

const tokenColours = (lang) => [...highlighter.codeToHtml(SAMPLE, { lang, theme: themes[0] })
    .matchAll(/<span style="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((s) => /color:/.test(s)).length;

console.log('\n--- fence tags must resolve to a grammar AND emit token colours ---');
for (const tag of FENCE_TAGS) {
    const label = aliases.get(tag) ?? tag;
    const resolves = loaded.has(label);
    const colours = resolves ? tokenColours(label) : 0;
    ok(`\`${tag}\``, resolves && colours > 0,
        resolves ? (colours ? '' : 'no token colours emitted') : `"${label}" is not a loaded grammar`);
}

console.log('\n--- every alias target must itself be a loaded grammar ---');
for (const [from, to] of aliases) {
    ok(`alias \`${from}\` -> \`${to}\``, loaded.has(to), 'target grammar is not loaded');
}

console.log('\n--- both themes render ---');
for (const theme of themes) {
    let rendered = '';
    try {
        rendered = highlighter.codeToHtml(SAMPLE, { lang: 'typescript', theme });
    } catch (err) {
        rendered = '';
    }
    ok(`theme \`${theme}\``, rendered.includes('<pre') && /background-color/.test(rendered));
}

// --------------------------------------------------------- unknown languages

// `highlightCode` guards membership and falls back to the plaintext grammar,
// because shiki's own `fallbackLanguage` does NOT stop the throw for a
// grammar that is not loaded at all.
const unknown = 'a-language-that-does-not-exist';
ok('the sentinel really is unloaded', !loaded.has(unknown));
const fallbackLang = loaded.has(unknown) ? unknown : 'plaintext';
let fallbackHtml = '';
try {
    fallbackHtml = highlighter.codeToHtml(SAMPLE, { lang: fallbackLang, theme: themes[0] });
    ok('an unloaded language still renders without throwing', true);
} catch (err) {
    ok('an unloaded language still renders without throwing', false, String(err?.message ?? err));
}
ok('and it still yields a themed block, not bare text',
    fallbackHtml.includes('<pre') && /background-color/.test(fallbackHtml));

// The alias map must not reintroduce an unloaded target for the tags above.
console.log('\n--- the renderer logs instead of swallowing (source check) ---');
ok('highlightCode no longer has an empty catch',
    !/\}\s*catch\s*\{\s*return `<pre><code>/.test(src),
    'the bare catch that hid every one of these failures is back');

highlighter.dispose();

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
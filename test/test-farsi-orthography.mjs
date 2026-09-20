#!/usr/bin/env node
/**
 * Farsi orthography guard.
 *
 * The `natural-farsi` skill is a house rule: NO half-space (ZWNJ, U+200C),
 * NO Arabic yeh/kaf (U+064A/U+0643 - Persian uses U+06CC/U+06A9), NO harakat.
 * It has been violated by hand more than once, so enforce it mechanically on
 * every Persian-bearing source file.
 *
 * The skill file itself is exempt: it contains the offending characters as
 * documentation examples.
 *
 * Run: node test/test-farsi-orthography.mjs
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath: `.pathname` yields `/D:/...` on Windows and double-drives.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'webview-ui/src', 'assets', 'test'];
const SCAN_ROOT_FILES = ['README.fa.md', 'package.nls.fa.json'];
const EXTS = ['.ts', '.tsx', '.css', '.md', '.json', '.yml', '.mjs'];
// Documentation that intentionally shows the bad characters.
const EXEMPT = [join('assets', 'skills', 'natural-farsi', 'SKILL.md')];

const BAD = [
    { name: 'ZWNJ (half-space)', re: /\u200c/g },
    // Spelled with code points so this file itself stays clean.
    { name: 'Arabic yeh U+064A - use Persian yeh U+06CC', re: /\u064a/g },
    { name: 'Arabic kaf U+0643 - use Persian kaf U+06A9', re: /\u0643/g },
    { name: 'harakat/tatweel', re: /[\u064b-\u0652\u0670\u0640]/g },
];

function walk(dir, out = []) {
    let entries;
    try { entries = readdirSync(dir); } catch { return out; }
    for (const name of entries) {
        if (name === 'node_modules' || name === 'dist' || name === 'out' || name === 'dist-tests') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
    }
    return out;
}

const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);
for (const f of SCAN_ROOT_FILES) {
    try { statSync(join(ROOT, f)); files.push(join(ROOT, f)); } catch { /* absent */ }
}

const violations = [];
for (const file of files) {
    const rel = relative(ROOT, file);
    if (EXEMPT.some((e) => rel.endsWith(e))) continue;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        for (const { name, re } of BAD) {
            re.lastIndex = 0;
            if (re.test(line)) violations.push(`${rel}:${i + 1}: ${name} -> ${line.trim().slice(0, 90)}`);
        }
    });
}

if (violations.length) {
    console.error(`\nFarsi orthography violations (${violations.length}):`);
    for (const v of violations) console.error('  ' + v);
    console.error('\nRule: no half-space, no Arabic yeh/kaf, no harakat. See assets/skills/natural-farsi/SKILL.md');
    process.exit(1);
}
console.log(`farsi-orthography: clean (${files.length} files scanned)`);

#!/usr/bin/env node
/**
 * package.nls consistency guard.
 *
 * VS Code resolves `%key%` placeholders in package.json against
 * package.nls.json (default) and package.nls.<locale>.json. A key missing from
 * the default renders literally as `%key%` in the UI, and a key present in only
 * one locale silently falls back to English - both are easy to ship by hand,
 * so they are checked here.
 *
 * Run: node test/test-nls.mjs
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

// fileURLToPath: `.pathname` yields `/D:/...` on Windows and double-drives.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

const pkg = read('package.json');
const en = read('package.nls.json');
const fa = read('package.nls.fa.json');

let failed = 0;
const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (${detail})`}`);
};

// Every `%key%` used in package.json must exist in the default map.
const used = new Set();
const scan = (value) => {
    if (typeof value === 'string') {
        for (const match of value.matchAll(/%([^%]+)%/g)) used.add(match[1]);
    } else if (Array.isArray(value)) {
        value.forEach(scan);
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(scan);
    }
};
scan(pkg);

const enKeys = Object.keys(en);
const faKeys = Object.keys(fa);
const missingEn = [...used].filter((key) => !(key in en));
const missingFa = [...used].filter((key) => !(key in fa));
check('every used key exists in package.nls.json', missingEn.length === 0, missingEn.join(', '));
check('every used key exists in package.nls.fa.json', missingFa.length === 0, missingFa.join(', '));

// Identical key sets: a locale-only key silently falls back to English, and a
// default-only key renders `%key%` for Persian users.
const onlyEn = enKeys.filter((key) => !(key in fa));
const onlyFa = faKeys.filter((key) => !(key in en));
check('no default-only keys', onlyEn.length === 0, onlyEn.join(', '));
check('no Persian-only keys', onlyFa.length === 0, onlyFa.join(', '));

// No dead keys (defined but never referenced from package.json).
const unused = enKeys.filter((key) => !used.has(key));
check('no unused keys', unused.length === 0, unused.join(', '));

// No empty translations.
const emptyEn = enKeys.filter((key) => !String(en[key]).trim());
const emptyFa = faKeys.filter((key) => !String(fa[key]).trim());
check('no empty English values', emptyEn.length === 0, emptyEn.join(', '));
check('no empty Persian values', emptyFa.length === 0, emptyFa.join(', '));

console.log(failed === 0 ? `\nnls: all checks passed (${enKeys.length} keys)` : `\nnls: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

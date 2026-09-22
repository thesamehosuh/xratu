#!/usr/bin/env node
/**
 * edit_file `mode` resolution tests.
 *
 * Regression: the inline check in dispatchTool was
 *
 *     const mode = ['create', 'overwrite', 'append'].includes(args.mode)
 *         ? args.mode : 'overwrite';
 *
 * so an UNRECOGNIZED mode silently became `overwrite`. A model reaching for
 * a partial edit (`mode: "replace"`) or making a typo (`"overwrit"`) therefore
 * got a whole-file overwrite of the file it was trying to patch - the exact
 * opposite of what it asked for, with the cliff guard only catching it when
 * the result happened to shrink the file enough. An unknown mode must abort
 * the call, and the caller must abort before any fs work or checkpoint.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-edit-file-mode.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { resolveEditMode, EDIT_FILE_MODES, EDIT_FILE_DEFAULT_MODE } = require('../out/tooling/editFileArgs.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};
const isError = (r) => typeof r === 'object' && r !== null && typeof r.error === 'string';

// --- schema surface ---------------------------------------------------------
check('exactly three modes', EDIT_FILE_MODES.length, 3);
check('mode order is overwrite/create/append', EDIT_FILE_MODES.join(','), 'overwrite,create,append');
check('documented default is overwrite', EDIT_FILE_DEFAULT_MODE, 'overwrite');

// --- recognized values pass through ----------------------------------------
for (const mode of ['create', 'overwrite', 'append']) {
    const r = resolveEditMode(mode);
    check(`accepts ${mode}`, r.mode, mode);
    ok(`${mode} resolves without error`, !isError(r));
}

// --- absent mode keeps the documented default -------------------------------
check('undefined -> default', resolveEditMode(undefined).mode, 'overwrite');
check('null -> default', resolveEditMode(null).mode, 'overwrite');
check('empty string -> default', resolveEditMode('').mode, 'overwrite');
ok('absent mode is not an error', !isError(resolveEditMode(undefined)));

// --- THE regression: unknown strings must error, never overwrite ------------
const badStrings = [
    'replace',      // the plausible-but-wrong value a model actually sends
    'overwrit',     // typo
    'write',
    'create_file',
    'append_file',
    'Overwrite',    // wrong case - enum is lowercase, fail loudly
    'CREATE',
    'overwrite ',   // trailing space
    ' overwrite',
    'truncate',
];
for (const raw of badStrings) {
    const r = resolveEditMode(raw);
    ok(`rejects ${JSON.stringify(raw)}`, isError(r), JSON.stringify(r));
    ok(`rejection of ${JSON.stringify(raw)} is not a mode`, r.mode === undefined, JSON.stringify(r));
}

// --- non-string values must error too --------------------------------------
for (const raw of [1, 0, true, false, {}, [], ['overwrite'], { mode: 'overwrite' }, () => {}]) {
    const r = resolveEditMode(raw);
    ok(`rejects non-string ${typeof raw === 'object' ? JSON.stringify(raw) : String(raw)}`, isError(r), JSON.stringify(r));
}

// --- error message quality (the model reads this and retries) --------------
const err = resolveEditMode('replace').error;
ok('mentions every valid mode', ['"overwrite"', '"create"', '"append"'].every((m) => err.includes(m)), err);
ok('echoes the offending value', err.includes('"replace"'), err);
ok('points at apply_patch for partial edits', err.includes('apply_patch'), err);
ok('states the omitted-mode default', err.includes('default'), err);
ok('single-line (no raw newline)', !err.includes('\n'), err);
ok('reads as an error the model can act on', /^Error: unknown mode/.test(err), err);

// --- formatting is total: never throws on hostile input --------------------
for (const raw of [{ a: {} }, [null], Number.NaN, Infinity, Symbol('s'), 10n]) {
    let threw = false;
    let result = null;
    try {
        result = resolveEditMode(raw);
    } catch {
        threw = true;
    }
    ok(`never throws on ${String(raw)}`, !threw);
    ok(`hostile input still errors: ${String(raw)}`, isError(result), JSON.stringify(result));
}

{
    // Circular object would throw inside a naive JSON.stringify.
    const circular = {};
    circular.self = circular;
    let threw = false;
    try {
        resolveEditMode(circular);
    } catch {
        threw = true;
    }
    ok('never throws on a circular object', !threw);
}

console.log(failed === 0 ? '\nedit-file-mode tests: all passed' : `\nedit-file-mode tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

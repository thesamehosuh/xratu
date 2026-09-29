#!/usr/bin/env node
/**
 * Tool-call argument parsing + edit content resolution tests.
 *
 * Regression: `parseArguments` returned a silent `{}` for anything it could
 * not parse, so a double-encoded / object-typed / stream-mangled arguments
 * payload made edit_file report "new_content is required and was missing" no
 * matter what the model sent - a resend loop on every large write (observed
 * live: creating and editing a full HTML page failed three times in a row).
 * Unparseable input must be marked and surfaced, and known alias keys
 * (`content`/`contents`/`text`) must resolve like `new_content`.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-tool-args.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseArguments, UNPARSED_ARGS_KEY } = require('../out/local/localAgent.js');
const { resolveEditContentFrom, resolveEditContent, EDIT_CONTENT_ALIASES } = require('../out/tooling/editFileArgs.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
};
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(name, a === e, `(got ${a}, want ${e})`);
};

// --- parseArguments -------------------------------------------------------
eq('plain object string parses', parseArguments('{"path":"a.html","new_content":"x"}'),
    { path: 'a.html', new_content: 'x' });
eq('empty input is an empty object', parseArguments(''), {});
eq('undefined input is an empty object', parseArguments(undefined), {});
eq('object-typed arguments pass through', parseArguments({ path: 'a' }), { path: 'a' });
eq('double-encoded JSON unwraps once', parseArguments('"{\\"path\\":\\"a\\"}"'), { path: 'a' });
eq('unparseable JSON is marked, not swallowed',
    parseArguments('{"path": "a.html", "new_content": "x'), { [UNPARSED_ARGS_KEY]: '{"path": "a.html", "new_content": "x' });
ok('marker keeps a bounded head', parseArguments('{' + 'z'.repeat(500))[UNPARSED_ARGS_KEY].length <= 200);
eq('non-object JSON is marked', parseArguments('[1,2]')[UNPARSED_ARGS_KEY], '[1,2]');
eq('double-encoded non-object is marked', parseArguments('"hello"')[UNPARSED_ARGS_KEY], '"hello"');

// --- resolveEditContentFrom: aliases -------------------------------------
eq('new_content wins over aliases', resolveEditContentFrom({ new_content: 'N', content: 'C' }), { content: 'N' });
for (const key of EDIT_CONTENT_ALIASES) {
    eq(`alias ${key} resolves`, resolveEditContentFrom({ [key]: 'BODY' }), { content: 'BODY' });
}
ok('no content key at all stays the known error',
    resolveEditContentFrom({}).error?.startsWith('Error: new_content is required and was missing'),
    JSON.stringify(resolveEditContentFrom({}).error));
ok('alias with wrong type stays a type error',
    resolveEditContentFrom({ content: 5 }).error?.startsWith('Error: new_content must be a string'),
    JSON.stringify(resolveEditContentFrom({ content: 5 }).error));
eq('null new_content falls through to aliases', resolveEditContentFrom({ new_content: null, content: 'C' }), { content: 'C' });
eq('empty string is valid content', resolveEditContentFrom({ new_content: '' }), { content: '' });
eq('missing still reports the canonical message',
    resolveEditContent(undefined).error?.startsWith('Error: new_content is required'), true);


// --- path argument resolution (live: raw Node TypeError leaked to the model)
const { sanitizePath, withPathAlias, PATH_ALIASES } = require('../out/paths.js');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = os.tmpdir();
const throwsPathError = (fn) => {
    try { fn(); } catch (e) {
        if (!/path/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
        return;
    }
    throw new Error('expected a path error');
};

throwsPathError(() => sanitizePath(undefined, tmpRoot));
throwsPathError(() => sanitizePath('', tmpRoot));
throwsPathError(() => sanitizePath('   ', tmpRoot));
throwsPathError(() => sanitizePath(42, tmpRoot));
ok('undefined path error names the argument',
    (() => { try { sanitizePath(undefined, tmpRoot); return false; } catch (e) {
        return /required and must be a non-empty string/.test(e.message); } })(),
    'message must name the missing "path" argument');
ok('a real path still resolves', typeof sanitizePath('a.txt', tmpRoot) === 'string');

for (const key of PATH_ALIASES) {
    eq(`path alias ${key} fills args.path`, withPathAlias({ [key] : 'a.html' }).path, 'a.html');
}
eq('canonical path wins over aliases', withPathAlias({ path: 'a.html', file: 'b.html' }).path, 'a.html');
eq('empty canonical path falls through to alias', withPathAlias({ path: '  ', file: 'b.html' }).path, 'b.html');
eq('no path at all leaves args unchanged', withPathAlias({ other: 1 }).path, undefined);

console.log(failed === 0 ? '\nall tool-args checks passed (incl. path)' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

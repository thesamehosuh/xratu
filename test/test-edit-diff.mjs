#!/usr/bin/env node
/**
 * editDiffFromArgs guard tests - the args-derived before/after reconstruction
 * behind the edit-step "open diff in editor" button (the fallback used when no
 * edit-time snapshot exists, e.g. a restored session).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-edit-diff.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { editDiffFromArgs } = require('../out/editDiff.js');

let failed = 0;
const check = (name, fn) => {
    try { fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};
const eq = (a, b, label) => {
    if (a !== b) throw new Error(`${label ?? 'value'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

check('apply_patch single block: search/replace become the two sides', () => {
    const r = editDiffFromArgs('apply_patch', JSON.stringify({
        path: 'src/a.ts',
        patch: '<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE',
    }));
    eq(r.path, 'src/a.ts', 'path');
    eq(r.before, 'old line', 'before');
    eq(r.after, 'new line', 'after');
});

check('apply_patch multi-block: sides joined with the block separator', () => {
    const patch = [
        '<<<<<<< SEARCH', 'one', '=======', 'ONE', '>>>>>>> REPLACE',
        '<<<<<<< SEARCH', 'two', '=======', 'TWO', '>>>>>>> REPLACE',
    ].join('\n');
    const r = editDiffFromArgs('apply_patch', JSON.stringify({ path: 'a.txt', patch }));
    eq(r.before, 'one\n\ntwo', 'before');
    eq(r.after, 'ONE\n\nTWO', 'after');
});

check('apply_patch new-file idiom (empty SEARCH): before is empty', () => {
    const r = editDiffFromArgs('apply_patch', JSON.stringify({
        path: 'new.txt',
        patch: '<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE',
    }));
    eq(r.before, '', 'before');
    eq(r.after, 'hello\nworld', 'after');
});

check('replace_in_file: old_str/new_str pair', () => {
    const r = editDiffFromArgs('replace_in_file', JSON.stringify({
        path: 'b.ts', old_str: 'const x = 1;', new_str: 'const x = 2;',
    }));
    eq(r.before, 'const x = 1;', 'before');
    eq(r.after, 'const x = 2;', 'after');
});

check('edit_file create: before empty, after is the payload', () => {
    const r = editDiffFromArgs('edit_file', JSON.stringify({
        path: 'c.ts', mode: 'create', new_content: 'export const a = 1;\n',
    }), 'Successfully created c.ts (1 lines)');
    eq(r.before, '', 'before');
    eq(r.after, 'export const a = 1;\n', 'after');
});

check('edit_file create detected from the result text when mode is absent', () => {
    const r = editDiffFromArgs('edit_file', JSON.stringify({ path: 'd.ts', new_content: 'x' }), 'Successfully created d.ts (1 lines)');
    eq(r.before, '', 'before');
});

check('edit_file overwrite: refuses - the old side is unknowable', () => {
    const r = editDiffFromArgs('edit_file', JSON.stringify({
        path: 'e.ts', mode: 'overwrite', new_content: 'whole new file',
    }), 'Successfully updated e.ts - 10 → 1 lines (-9)');
    if (r !== null) throw new Error(`expected null, got ${JSON.stringify(r)}`);
});

check('raw marker text (not JSON) is diffed as a patch', () => {
    const r = editDiffFromArgs(undefined, '<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE');
    eq(r.before, 'foo', 'before');
    eq(r.after, 'bar', 'after');
});

check('garbage JSON without markers is not diffable', () => {
    if (editDiffFromArgs('edit_file', 'not json') !== null) throw new Error('expected null');
    if (editDiffFromArgs('edit_file', '') !== null) throw new Error('expected null for empty');
});

check('patch with marker-like body refuses (no corrupt diff)', () => {
    const patch = '<<<<<<< SEARCH\nold\n=======\nnew\n=======\nmore\n>>>>>>> REPLACE';
    const r = editDiffFromArgs('apply_patch', JSON.stringify({ path: 'f.ts', patch }));
    if (r !== null) throw new Error(`expected null, got ${JSON.stringify(r)}`);
});

check('persisted clip markers are stripped from both sides', () => {
    const r = editDiffFromArgs('edit_file', JSON.stringify({
        path: 'g.ts',
        mode: 'create',
        new_content: 'line one… [+500 chars truncated]',
    }), 'Successfully created g.ts');
    eq(r.after, 'line one', 'after');
});

check('missing path yields an empty label, not a crash', () => {
    const r = editDiffFromArgs('apply_patch', JSON.stringify({ patch: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE' }));
    eq(r.path, '', 'path');
});

if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('edit-diff: all checks passed');

import assert from 'node:assert/strict';
import { detectMention, applyMentionPick, filterFiles } from '../src/mention';

// --- detectMention ---------------------------------------------------------

// Opens after whitespace / at start, query = text up to the caret.
assert.deepEqual(detectMention('@', 1), { start: 0, caret: 1, query: '' });
assert.deepEqual(detectMention('@src', 4), { start: 0, caret: 4, query: 'src' });
assert.deepEqual(detectMention('fix @util', 9), { start: 4, caret: 9, query: 'util' });
assert.deepEqual(detectMention('a\n@file', 7), { start: 2, caret: 7, query: 'file' });

// Mid-word @ (email), whitespace inside the token, and no @ at all: closed.
assert.equal(detectMention('mail user@example', 17), null);
assert.equal(detectMention('@a b', 4), null);
assert.equal(detectMention('plain text', 10), null);
assert.equal(detectMention('', 0), null);
assert.equal(detectMention('@x', 5), null); // caret beyond text

// --- applyMentionPick ------------------------------------------------------

// Token removed, caret lands at the removal point.
assert.deepEqual(applyMentionPick('fix @util', 4, 9), { text: 'fix ', caret: 4 });
assert.deepEqual(applyMentionPick('@src', 0, 4), { text: '', caret: 0 });
// Following text already starts with whitespace: untouched, caret at start.
assert.deepEqual(applyMentionPick('@a rest', 0, 2), { text: ' rest', caret: 0 });
assert.deepEqual(applyMentionPick('@a  rest', 0, 2), { text: '  rest', caret: 0 });

// --- filterFiles -----------------------------------------------------------

const files = [
    'src/auth/login.ts',
    'src/api/users.ts',
    'webview-ui/src/types.ts',
    'README.md',
    'src/app.py',
];

// Empty query: first N, original order.
assert.deepEqual(filterFiles(files, ''), files);
// Substring match on path.
assert.deepEqual(filterFiles(files, 'auth'), ['src/auth/login.ts']);
// basename matches outrank path matches.
assert.equal(filterFiles(files, 'users')[0], 'src/api/users.ts');
// Multi-term: all terms must match somewhere (basename OR path).
assert.deepEqual(filterFiles(files, 'src app'), ['src/app.py']);
// Terms can be path segments.
assert.ok(filterFiles(files, 'src/ users').includes('src/api/users.ts'));
// Case-insensitive; extension-only queries work.
assert.ok(filterFiles(files, 'readme').includes('README.md'));
assert.equal(filterFiles(files, '.py')[0], 'src/app.py');
// limit bounds the output.
assert.equal(filterFiles(files, 's', 2).length, 2);
assert.equal(filterFiles(files, 'zzz').length, 0);

console.log('mention.test.ts: all assertions passed');

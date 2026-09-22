/**
 * Display-parser regression suite: `parsePatchBlocks` (SEARCH/REPLACE) and
 * `parseUnifiedDiff` (the `---`/`+++`/`@@` fallback).
 *
 * The SEARCH/REPLACE parser is deliberately tolerant (BOM/CRLF, junk in front
 * of a marker, a clipped final block), but that tolerance used to read a marker
 * that continues into code as a real block: a patch carrying the literal
 * `"<<<<<<< SEARCH"` inside a string produced a nonsense diff instead of
 * falling back to the raw view. Real markers are alone on their line.
 *
 * The unified-diff parser has its own two traps: a changed line whose payload
 * starts with `-- ` / `++ ` looks like a file header, and `split('\n')` leaves
 * a trailing empty element on a normally-terminated patch.
 */
import assert from 'node:assert/strict';
import { parsePatchBlocks, parseUnifiedDiff } from '../src/components/MessageItem';

// --- the shape it must parse ----------------------------------------------

assert.deepEqual(
    parsePatchBlocks('<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE'),
    [{ search: 'const a = 1;', replace: 'const a = 2;' }],
    'single SEARCH/REPLACE block',
);

assert.deepEqual(
    parsePatchBlocks([
        '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE',
        '<<<<<<< SEARCH', 'c', '=======', 'd', '>>>>>>> REPLACE',
    ].join('\n')),
    [{ search: 'a', replace: 'b' }, { search: 'c', replace: 'd' }],
    'multiple blocks',
);

assert.deepEqual(
    parsePatchBlocks('<<<<<<< SEARCH\n=======\nnew file\n>>>>>>> REPLACE'),
    [{ search: '', replace: 'new file' }],
    'empty SEARCH is a file creation, not a parse failure',
);

// --- the bug: marker text inside code is content, not a marker -------------

assert.equal(
    parsePatchBlocks([
        '--- a/src/mcp.ts',
        '+++ b/src/mcp.ts',
        '@@ -41,3 +41,4 @@',
        '-const BLOCK = "SEARCH";',
        '+const BLOCK = "<<<<<<< SEARCH";',
        '+const END = ">>>>>>> REPLACE";',
    ].join('\n')),
    null,
    'a unified diff carrying marker text in strings must fall back to raw',
);

assert.equal(
    parsePatchBlocks('const a = "<<<<<<< SEARCH";'),
    null,
    'a lone code line with an embedded marker is not a block',
);

// --- tolerance that must survive -------------------------------------------

const junkPrefixed = parsePatchBlocks('junk <<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE');
assert.ok(
    junkPrefixed && junkPrefixed.length === 1 && junkPrefixed[0].replace === 'y',
    'junk in front of a real marker line still parses',
);

assert.deepEqual(
    parsePatchBlocks('\uFEFF<<<<<<< SEARCH\r\nx\r\n=======\r\ny\r\n>>>>>>> REPLACE'),
    [{ search: 'x', replace: 'y' }],
    'BOM + CRLF are tolerated',
);

assert.deepEqual(
    parsePatchBlocks('<<<<<<< SEARCH\nx\n=======\ny'),
    [{ search: 'x', replace: 'y' }],
    'a clipped final block still yields a partial diff',
);

assert.equal(parsePatchBlocks('just some text\nwith no markers'), null, 'no block structure');
assert.equal(parsePatchBlocks(''), null, 'empty input');

// --- unified diff ----------------------------------------------------------

assert.deepEqual(
    parseUnifiedDiff([
        '--- a/src/mcp.ts',
        '+++ b/src/mcp.ts',
        '@@ -41,3 +41,4 @@',
        '-const BLOCK = "SEARCH";',
        '+const BLOCK = "OPEN";',
        '+const END = "CLOSE";',
    ].join('\n')),
    [
        { kind: 'del', text: 'const BLOCK = "SEARCH";' },
        { kind: 'add', text: 'const BLOCK = "OPEN";' },
        { kind: 'add', text: 'const END = "CLOSE";' },
    ],
    'a hunk becomes add/del lines',
);

// The `---`/`+++` file-header filter must only apply BEFORE the first hunk: a
// changed line whose payload itself starts with `-- ` or `++ ` is real content.
// (Only ONE diff prefix is stripped, so `++ new comment` yields `+ new comment`.)
assert.deepEqual(
    parseUnifiedDiff([
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,2 +1,2 @@',
        '--- old comment',
        '++ new comment',
    ].join('\n')),
    [
        { kind: 'del', text: '-- old comment' },
        { kind: 'add', text: '+ new comment' },
    ],
    'header-looking payload lines inside a hunk are kept',
);

// `split('\n')` leaves a trailing '' for a normally-terminated patch - it must
// not become a spurious blank context line after the final hunk.
assert.equal(
    parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n')?.length,
    2,
    'no spurious trailing blank line',
);

// A genuine blank context line is a single leading space, and survives.
assert.deepEqual(
    parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n \n-b\n+c\n'),
    [
        { kind: 'same', text: 'a' },
        { kind: 'same', text: '' },
        { kind: 'del', text: 'b' },
        { kind: 'add', text: 'c' },
    ],
    'blank context lines are preserved',
);

// "\ No newline at end of file" is a marker, not a line of the file.
assert.deepEqual(
    parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'),
    [
        { kind: 'del', text: 'a' },
        { kind: 'add', text: 'b' },
    ],
    'the no-newline marker is skipped',
);

assert.equal(parseUnifiedDiff('just prose\nno hunks here'), null, 'prose is not a unified diff');
assert.equal(parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n same\n'), null, 'a hunk with no change is not a diff');

console.log('patch-blocks.test.ts: all tests passed');

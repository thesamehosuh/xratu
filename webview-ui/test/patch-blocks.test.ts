/**
 * parsePatchBlocks regression suite.
 *
 * The display parser is deliberately tolerant (BOM/CRLF, junk in front of a
 * marker, a clipped final block), but that tolerance used to read a marker
 * that continues into code as a real block: a patch carrying the literal
 * `"<<<<<<< SEARCH"` inside a string produced a nonsense diff instead of
 * falling back to the raw view. Real markers are alone on their line.
 */
import assert from 'node:assert/strict';
import { parsePatchBlocks } from '../src/components/MessageItem';

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

console.log('patch-blocks.test.ts: all tests passed');

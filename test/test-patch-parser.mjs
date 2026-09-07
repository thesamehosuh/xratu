#!/usr/bin/env node
/**
 * Patch parser guard tests - marker-like lines inside block content.
 *
 * Regression for a live incident: a patch whose block body contained bare
 * '=======' lines was silently re-sliced by the non-greedy parser and the
 * target file was shredded. parsePatchBlocks must now REFUSE such patches
 * loudly instead of returning corrupted blocks.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-patch-parser.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parsePatchBlocks } = require('../out/paths.js');

let failed = 0;
const check = (name, fn) => {
    try { fn(); console.log(`ok   ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
};
const throwsMarker = (patch) => {
    try { parsePatchBlocks(patch); } catch (e) {
        if (!/marker/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
        return;
    }
    throw new Error('expected refusal, got parsed blocks');
};

check('clean patch parses', () => {
    const blocks = parsePatchBlocks('<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE');
    if (blocks.length !== 1 || blocks[0].search !== 'foo' || blocks[0].replace !== 'bar') {
        throw new Error(JSON.stringify(blocks));
    }
});

check('refuses ======= in body (incident shape: marker inside single block)', () => {
    // The first ======= is always consumed as the separator, so an intended
    // content marker lands in the REPLACE body - exactly how a plan file with
    // '=======' lines got shredded live.
    throwsMarker('<<<<<<< SEARCH\nold section\n=======\nnew text with\n=======\nmore text\n>>>>>>> REPLACE');
});

check('refuses <<<<<<< / >>>>>>> inside bodies', () => {
    throwsMarker('<<<<<<< SEARCH\nold\n=======\n<<<<<<< SEARCH\n>>>>>>> REPLACE');
});

check('new-file idiom (empty SEARCH) still parses', () => {
    const blocks = parsePatchBlocks('<<<<<<< SEARCH\n=======\nhello\nworld\n>>>>>>> REPLACE');
    if (blocks.length !== 1 || blocks[0].search !== '' || blocks[0].replace !== 'hello\nworld') {
        throw new Error(JSON.stringify(blocks));
    }
});

process.exit(failed ? 1 : 0);

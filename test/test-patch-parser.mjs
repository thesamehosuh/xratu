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
const { parsePatchBlocks, repairPatchMarkers } = require('../out/paths.js');

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

/** A patch that must be refused with an error matching `re`. */
const throwsWith = (patch, re) => {
    try { parsePatchBlocks(patch); } catch (e) {
        if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`);
        return;
    }
    throw new Error('expected refusal, got parsed blocks');
};

// --- precise diagnosis of an unusable patch --------------------------------
// Regression: a patch sent without its final closing marker parsed to zero
// blocks, and the caller reported only "no valid SEARCH/REPLACE blocks found"
// - naming neither the fault nor the fix, so a one-line syntax slip became a
// dead end (hit live while dogfooding).
check('missing closing marker is named', () => {
    throwsWith('<<<<<<< SEARCH\nold\n=======\nnew\n', /closing/i);
});

check('missing separator is named', () => {
    throwsWith('<<<<<<< SEARCH\nold\n>>>>>>> REPLACE\n', /separator/i);
});

check('closing marker without an opener is named', () => {
    throwsWith('>>>>>>> REPLACE\n', /opening/i);
});

check('unbalanced marker counts are named', () => {
    throwsWith('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n', /match/i);
});

check('stray text on a marker line is named', () => {
    throwsWith('<<<<<<< search\na\n=======\nb\n>>>>>>> replace\n', /exactly/i);
});

check('every diagnosis mentions the marker', () => {
    // The caller surfaces the message verbatim; keep it self-explanatory.
    for (const bad of [
        '<<<<<<< SEARCH\nold\n=======\nnew\n',
        '<<<<<<< SEARCH\nold\n>>>>>>> REPLACE\n',
        '>>>>>>> REPLACE\n',
        '<<<<<<< search\na\n=======\nb\n>>>>>>> replace\n',
    ]) {
        try { parsePatchBlocks(bad); throw new Error(`not refused: ${bad}`); }
        catch (e) { if (!/marker/i.test(e.message)) throw new Error(`no 'marker' in: ${e.message}`); }
    }
});

check('marker-less text still returns [] so the caller keeps its own message', () => {
    const blocks = parsePatchBlocks('plain prose, no markers here at all');
    if (blocks.length !== 0) throw new Error(JSON.stringify(blocks));
});

// --- the shape a flattened tool description TEACHES -------------------------
// The apply_patch description used to join its multi-line example with spaces,
// so the markers rendered INLINE. A model imitating its own tool description
// produced exactly this, and the error reported a "missing separator" the model
// could not see. Name the real fault instead.
check('markers on ONE line are named as such', () => {
    throwsWith('<<<<<<< SEARCH old ======= new >>>>>>> REPLACE', /ONE line/i);
});
check('the one-line message shows the corrected template', () => {
    try {
        parsePatchBlocks('<<<<<<< SEARCH old ======= new >>>>>>> REPLACE');
        throw new Error('expected refusal');
    } catch (e) {
        if (!e.message.includes('<<<<<<< SEARCH\n<current file lines>\n=======')) {
            throw new Error(`no copyable template in: ${e.message}`);
        }
    }
});
check('a two-marker one-liner (no separator) is also caught', () => {
    throwsWith('<<<<<<< SEARCH old >>>>>>> REPLACE', /ONE line/i);
});
check('the separator message shows the corrected template too', () => {
    try {
        parsePatchBlocks('<<<<<<< SEARCH\nold\n>>>>>>> REPLACE\n');
        throw new Error('expected refusal');
    } catch (e) {
        // Assert the COMPLETE copyable shape, not just the '=======' substring
        // (which the base message already contains): this must fail if the
        // template is ever dropped from the diagnostic.
        if (!e.message.includes('<<<<<<< SEARCH\n<current file lines>\n=======\n<replacement lines>\n>>>>>>> REPLACE')) {
            throw new Error(`no full template in: ${e.message}`);
        }
    }
});
check('an inline marker line inside a body is not misreported as flattened', () => {
    // The body contains '<<<<<<< ... =======' but NOT at line start, so the
    // fault is the missing separator - not a flattened patch. (The detector must
    // only fire on a line-INITIAL opener.)
    throwsWith('<<<<<<< SEARCH\nconst s = "a <<<<<<< b ======= c";\n>>>>>>> REPLACE\n', /separator/i);
});
check('inline marker-like text alone is not a patch attempt (returns [])', () => {
    const blocks = parsePatchBlocks('const s = "a <<<<<<< b ======= c";');
    if (blocks.length !== 0) throw new Error(JSON.stringify(blocks));
});
// A correct patch must still parse - the new checks must not over-trigger.
check('a well-formed multi-line patch is unaffected', () => {
    const blocks = parsePatchBlocks('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE');
    if (blocks.length !== 1 || blocks[0].search !== 'a' || blocks[0].replace !== 'b') {
        throw new Error(JSON.stringify(blocks));
    }
});

check('a lone ======= line is prose, not a patch attempt (returns [])', () => {
    // A markdown rule / RST underline must NOT be diagnosed as a broken patch.
    const blocks = parsePatchBlocks('Release notes\n=======\n\n- fixed things');
    if (blocks.length !== 0) throw new Error(JSON.stringify(blocks));
});

// --- a patch that stops before its separator is TRUNCATED, not "missing a closer"
// Regression: hit live many times while dogfooding. The patch arrived as the
// opener plus its search text and nothing else, and the diagnostic blamed the
// closing marker - so the (correct) instruction "re-send the SAME block
// unchanged" pointed at a marker that was never the problem, and every retry
// was a guess. The fault is truncation: there is no separator, so there is no
// knowable search/replacement boundary and nothing can be applied.
check('a patch truncated before its separator is named as truncated', () => {
    throwsWith('<<<<<<< SEARCH\nimport a from "a";\nimport b from "b";\n', /TRUNCATED/i);
});

check('the truncated message does not blame the closing marker', () => {
    try {
        parsePatchBlocks('<<<<<<< SEARCH\nconst x = 1;\n');
        throw new Error('expected refusal');
    } catch (e) {
        if (/most often dropped/i.test(e.message)) {
            throw new Error(`misleading closing-marker message: ${e.message}`);
        }
        if (!/COMPLETE block/i.test(e.message)) {
            throw new Error(`no re-send instruction: ${e.message}`);
        }
    }
});

check('a separator with no closer still gets the closer-specific message', () => {
    // The two shapes must stay distinguishable: this one IS just a lost closer.
    throwsWith('<<<<<<< SEARCH\nold\n=======\nnew\n', /closing/i);
});

// --- the one unambiguous repair: the FINAL closer was dropped --------------
check('repairs a missing final closing marker', () => {
    const { patch, repairs } = repairPatchMarkers('<<<<<<< SEARCH\nold\n=======\nnew\n');
    if (repairs.length !== 1) throw new Error(`expected one repair, got ${JSON.stringify(repairs)}`);
    if (!/closing/i.test(repairs[0])) throw new Error(`repair not named: ${repairs[0]}`);
    const blocks = parsePatchBlocks(patch);
    if (blocks.length !== 1 || blocks[0].search !== 'old' || blocks[0].replace !== 'new') {
        throw new Error(JSON.stringify(blocks));
    }
});

check('repairs only the last of several blocks', () => {
    const { patch, repairs } = repairPatchMarkers(
        '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nc\n=======\nd\n',
    );
    if (repairs.length !== 1) throw new Error(`expected one repair, got ${JSON.stringify(repairs)}`);
    const blocks = parsePatchBlocks(patch);
    if (blocks.length !== 2 || blocks[1].replace !== 'd') throw new Error(JSON.stringify(blocks));
});

check('a complete patch is left untouched', () => {
    const original = '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n';
    const { patch, repairs } = repairPatchMarkers(original);
    if (patch !== original) throw new Error('complete patch was rewritten');
    if (repairs.length !== 0) throw new Error(`unexpected repair: ${JSON.stringify(repairs)}`);
});

check('no separator means no repair (boundary is unknowable)', () => {
    const { patch, repairs } = repairPatchMarkers('<<<<<<< SEARCH\nold\n');
    if (repairs.length !== 0 || patch !== '<<<<<<< SEARCH\nold\n') {
        throw new Error('truncated patch was "repaired"');
    }
});

check('a lone separator is prose and is not repaired', () => {
    const { repairs } = repairPatchMarkers('Release notes\n=======\n\n- fixed things');
    if (repairs.length !== 0) throw new Error(`unexpected repair: ${JSON.stringify(repairs)}`);
});

// The dangerous shape: a block lost its closer in the MIDDLE of a patch. The
// repair must not fire - closing it there would fold the following hunks into
// this replacement and report success while those hunks never applied.
check('a mid-patch loss is not repaired and is still refused', () => {
    const midLoss = '<<<<<<< SEARCH\na\n=======\nb\n<<<<<<< SEARCH\nc\n=======\nd\n>>>>>>> REPLACE\n';
    const { patch, repairs } = repairPatchMarkers(midLoss);
    if (repairs.length !== 0) throw new Error(`mid-patch loss was repaired: ${JSON.stringify(repairs)}`);
    if (patch !== midLoss) throw new Error('mid-patch loss was rewritten');
    try {
        parsePatchBlocks(patch);
        throw new Error('expected refusal, got parsed blocks');
    } catch (e) {
        if (!/marker/i.test(e.message)) throw new Error(`wrong error: ${e.message}`);
    }
});

check('a repaired patch parses to the same blocks as a hand-closed one', () => {
    const open = '<<<<<<< SEARCH\nkeep\n=======\nkept\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ndrop\n=======\ndropped\n';
    const closed = open + '>>>>>>> REPLACE\n';
    const repaired = parsePatchBlocks(repairPatchMarkers(open).patch);
    const expected = parsePatchBlocks(closed);
    if (JSON.stringify(repaired) !== JSON.stringify(expected)) {
        throw new Error(`${JSON.stringify(repaired)} !== ${JSON.stringify(expected)}`);
    }
});

process.exit(failed ? 1 : 0);

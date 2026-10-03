#!/usr/bin/env node
/**
 * External-MCP IMAGE content passthrough + the tool-image pipeline built on it.
 *
 * THE REGRESSION THIS EXISTS FOR: `ExternalMcpManager.callTool` mapped every
 * MCP content block through `c.text ?? ''`. MCP servers return screenshots as
 * `{type:'image', mimeType, data}`, which has NO `text` - so it mapped to `''`.
 * The Playwright MCP entry that ships in `mcpRegistry.ts` looked installed and
 * worked, and `browser_take_screenshot` returned nothing the model could see.
 *
 * These suites cover the mapping, the per-block refusals (oversize, unsupported
 * media type), the four wire serializers, the context-budget accounting, and
 * the metadata-only persistence rule.
 *
 * Run (after `npx tsc -p . --outDir out`):
 *   node test/test-mcp-tool-images.mjs
 */
import { createRequire } from 'module';
import Module from 'module';

// out/externalMcp.js imports `vscode` (via proxyDispatcher) at the top; stub it
// so the pure content mapping is testable in plain node.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: () => ({ get: () => undefined, update: async () => undefined }),
                isTrusted: true,
                workspaceFolders: undefined,
            },
            Uri: { file: (p) => ({ fsPath: p, path: p }) },
            window: { withProgress: async (_o, t) => t() },
            env: { appRoot: undefined },
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const {
    mapMcpToolContent,
} = require('../out/externalMcp.js');
const {
    toolResultContent,
    estimateImageTokens,
    estimateMessageTokens,
    isProviderSafeImageMime,
    base64ByteLength,
    boundToolResults,
    elideOldToolResults,
    MAX_TOOL_IMAGE_BYTES,
    TOOL_RESULT_ELISION_MARKER,
    chatWireMessages,
} = require('../out/local/localAgent.js');
const { persistedEventFromAgentEvent, historyRowFromEvent, toolResultReplayText } = require('../out/local/historyRows.js');
const { boundOutcomeEvents } = require('../out/local/eventBounds.js');

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

// A real 1x1 PNG, so the fixtures carry an actual image signature rather than
// a placeholder that would let a broken extractor pass.
const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** base64 of `n` bytes (no allocation loop cost concern at these sizes). */
function base64OfBytes(n) {
    return Buffer.alloc(n, 65).toString('base64');
}

// --- mapMcpToolContent: the core mapping ---------------------------------
{
    const r = mapMcpToolContent([
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
        { type: 'text', text: 'after' },
    ]);
    eq('text blocks join in order', r.text, 'before\nafter');
    eq('an image block becomes an image', r.images.length, 1);
    eq('the payload survives intact', r.images[0].dataBase64, PNG_1x1);
    eq('the mime is carried', r.images[0].mimeType, 'image/png');
}
{
    // The exact shape Playwright MCP / chrome-devtools MCP return.
    const r = mapMcpToolContent([
        { type: 'image', mimeType: 'image/jpeg', data: PNG_1x1 },
    ]);
    eq('a screenshot-only result is not empty text', r.text, '');
    eq('a screenshot-only result still carries the image', r.images.length, 1);
}
{
    const r = mapMcpToolContent([]);
    eq('empty content yields no images', r.images.length, 0);
    eq('empty content yields empty text', r.text, '');
}
{
    const r = mapMcpToolContent(undefined);
    eq('undefined content is tolerated', r.images.length, 0);
    eq('undefined content is empty text', r.text, '');
}
{
    const r = mapMcpToolContent([{ type: 'text', text: 'plain' }]);
    eq('a text-only result has no images', r.images.length, 0);
    eq('a text-only result keeps its text', r.text, 'plain');
}
{
    // Empty text blocks must not leave blank lines behind.
    const r = mapMcpToolContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: '' },
        { type: 'text', text: 'b' },
    ]);
    eq('empty text blocks are dropped, not joined as blanks', r.text, 'a\nb');
}

// --- refusals: the model must never be misled ----------------------------
{
    const big = base64OfBytes(MAX_TOOL_IMAGE_BYTES + 1024);
    const r = mapMcpToolContent([{ type: 'image', mimeType: 'image/png', data: big }], 'browser_take_screenshot');
    eq('an oversize image is NOT forwarded', r.images.length, 0);
    ok('an oversize image says so', /exceeds the 8 MB limit/.test(r.text), r.text);
    ok('the oversize note names the tool', /browser_take_screenshot/.test(r.text), r.text);
}
{
    // Boundary: exactly at the limit passes, one byte over is refused.
    const atLimit = base64OfBytes(MAX_TOOL_IMAGE_BYTES);
    const overLimit = base64OfBytes(MAX_TOOL_IMAGE_BYTES + 4);
    eq('an image exactly at the limit is forwarded',
        mapMcpToolContent([{ type: 'image', mimeType: 'image/png', data: atLimit }]).images.length, 1);
    eq('an image one step over the limit is refused',
        mapMcpToolContent([{ type: 'image', mimeType: 'image/png', data: overLimit }]).images.length, 0);
}
{
    const r = mapMcpToolContent([{ type: 'image', mimeType: 'image/svg+xml', data: PNG_1x1 }]);
    eq('an unsupported media type is NOT forwarded', r.images.length, 0);
    ok('an unsupported media type says so', /unsupported type image\/svg\+xml/.test(r.text), r.text);
}
{
    const r = mapMcpToolContent([{ type: 'image', data: PNG_1x1 }]);
    eq('an image with no mime is NOT forwarded', r.images.length, 0);
    ok('a mime-less image says why', /unsupported type/.test(r.text), r.text);
}
{
    const r = mapMcpToolContent([{ type: 'image', mimeType: 'image/png' }]);
    eq('an image with no data is NOT forwarded', r.images.length, 0);
    ok('a data-less image says why', /carried no data/.test(r.text), r.text);
}
{
    // Mixed: a good image survives, the bad one is refused with a note, and the
    // text still comes through.
    const r = mapMcpToolContent([
        { type: 'text', text: 'shot taken' },
        { type: 'image', mimeType: 'image/png', data: PNG_1x1 },
        { type: 'image', mimeType: 'image/tiff', data: PNG_1x1 },
    ]);
    eq('a valid image beside an invalid one still lands', r.images.length, 1);
    ok('the refused one is reported', /image\/tiff/.test(r.text), r.text);
    ok('the text survives alongside', /shot taken/.test(r.text), r.text);
}

// --- alternate block shapes ---------------------------------------------
{
    // Some servers embed the screenshot as a binary resource instead.
    const r = mapMcpToolContent([
        { type: 'resource', resource: { mimeType: 'image/png', blob: PNG_1x1, uri: 'file:///shot.png' } },
    ]);
    eq('an embedded blob resource becomes an image', r.images.length, 1);
    eq('the blob payload survives', r.images[0].dataBase64, PNG_1x1);
}
{
    const r = mapMcpToolContent([
        { type: 'resource', resource: { mimeType: 'application/pdf', blob: base64OfBytes(1024) } },
    ]);
    eq('a non-image resource is not forwarded as an image', r.images.length, 0);
    ok('a non-image resource says so', /application\/pdf/.test(r.text), r.text);
}
{
    // A server that mislabels the block as text but still ships a data URL.
    const r = mapMcpToolContent([
        { type: 'text', text: `data:image/png;base64,${PNG_1x1}` },
    ]);
    eq('a data URL mislabelled as text is recovered', r.images.length, 1);
    eq('the recovered payload has no data-URL prefix', r.images[0].dataBase64, PNG_1x1);
}
{
    const r = mapMcpToolContent([
        { type: 'text', text: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    ]);
    eq('a recovered data URL is still media-type checked', r.images.length, 0);
}

// --- hostile / degenerate blocks ---------------------------------------
// These fields come off the wire from a third-party server. Every one of them
// must DEGRADE, never throw: an exception inside tool dispatch loses the whole
// call (and the model's turn) over one malformed image block.
{
    const cases = [
        ['a null block', [null], 0],
        ['a non-object block', [42], 0],
        ['a string block', ['oops'], 0],
        ['a block with no fields', [{}], 0],
        ['an unknown block type', [{ type: 'video', data: 'x' }], 0],
        ['a case-mismatched block type', [{ type: 'Image', mimeType: 'image/png', data: 'QUFB' }], 0],
    ];
    for (const [name, content, wantImages] of cases) {
        let threw = null;
        let result = null;
        try { result = mapMcpToolContent(content); } catch (e) { threw = e; }
        ok(`${name} does not throw`, threw === null, threw ? String(threw.message) : '');
        if (result) eq(`${name} yields no images`, result.images.length, wantImages);
    }
    eq('non-array content is tolerated', mapMcpToolContent({ content: [] }).images.length, 0);
    eq('a non-object (number) is tolerated', mapMcpToolContent(7).images.length, 0);
    ok('a non-string mime does not throw',
        mapMcpToolContent([{ type: 'image', mimeType: {}, data: 'QUFB' }]).images.length === 0);
    ok('a non-string payload does not throw',
        mapMcpToolContent([{ type: 'image', mimeType: 'image/png', data: 123 }]).images.length === 0);
    ok('a non-string resource blob does not throw',
        mapMcpToolContent([{ type: 'resource', resource: { mimeType: 'image/png', blob: {} } }]).images.length === 0);
    // Regression: the isError path read `c.text` off unvalidated entries, so a
    // null block threw INSIDE the try and the catch turned the server's real
    // error into a generic "MCP Call Error" after a wasted reconnect retry.
    ok('a null block in an ERROR payload does not throw',
        (() => { try { mapMcpToolContent([null], 'browser_click'); return true; } catch { return false; } })());
    ok('a null block in an ERROR payload keeps the sibling text',
        mapMcpToolContent([null, { type: 'text', text: 'element not found' }], 'browser_click').text
            === 'element not found');
    ok('an image-only ERROR payload degrades to a note',
        /image block|unsupported/.test(mapMcpToolContent([{ type: 'image', mimeType: 'application/octet-stream', data: PNG_1x1 }], 'browser_click').text));
    eq('a data URL with no comma is not an image',
        mapMcpToolContent([{ type: 'text', text: 'data:image/png;base64' }]).images.length, 0);
    eq('a non-base64 data URL is not an image',
        mapMcpToolContent([{ type: 'text', text: 'data:image/png,rawbytes' }]).images.length, 0);
    ok('a wrapped base64 payload still measures',
        mapMcpToolContent([{ type: 'image', mimeType: 'image/png', data: 'QUFB\nQUJD' }]).images.length === 1);
}
{
    // A server echoing our own object shape must not reach Object.prototype.
    mapMcpToolContent([{ __proto__: { polluted: true }, type: 'image', mimeType: 'image/png', data: 'QUFB' }]);
    ok('a __proto__ key on a block does not pollute Object.prototype',
        {}.polluted === undefined, String({}.polluted));
    ok('base64ByteLength survives a non-string', base64ByteLength({}) === 0);
    ok('base64ByteLength survives null', base64ByteLength(null) === 0);
    ok('base64ByteLength survives undefined', base64ByteLength(undefined) === 0);
}

// --- scale --------------------------------------------------------------
{
    // Count-capped now (see the aggregate section below); this asserts a
    // modest burst still passes through untouched.
    const many = Array.from({ length: 20 }, () => ({ type: 'image', mimeType: 'image/png', data: 'QUFB' }));
    eq('a 20-image burst is all mapped', mapMcpToolContent(many).images.length, 20);
}

// --- scale: aggregate limits -------------------------------------------
// Regression: the per-image cap bounded one block but nothing bounded the
// COUNT, so 50 max-size images were all mapped - measured at 533 MB of base64
// before any downstream context bound ran.
{
    const { MAX_TOOL_IMAGES_PER_CALL, MAX_TOOL_IMAGE_TOTAL_BYTES } = require('../out/externalMcp.js');
    const many = Array.from({ length: MAX_TOOL_IMAGES_PER_CALL + 30 }, () => ({ type: 'image', mimeType: 'image/png', data: PNG_1x1 }));
    const r = mapMcpToolContent(many, 'browser_take_screenshot');
    eq('the image COUNT is capped per call', r.images.length, MAX_TOOL_IMAGES_PER_CALL);
    ok('the count overflow is stated in text', /only the first \d+ images/.test(r.text), r.text.slice(0, 120));

    // Aggregate bytes: images just under the per-image cap, enough of them to
    // cross the per-result total.
    const chunk = base64OfBytes(MAX_TOOL_IMAGE_BYTES - 1);
    const heavy = Array.from({ length: 30 }, () => ({ type: 'image', mimeType: 'image/png', data: chunk }));
    const h = mapMcpToolContent(heavy, 'browser_take_screenshot');
    const kept = h.images.reduce((n, i) => n + base64ByteLength(i.dataBase64), 0);
    ok('the aggregate BYTE total is capped',
        kept <= MAX_TOOL_IMAGE_TOTAL_BYTES, `kept ${(kept / 1024 / 1024).toFixed(1)} MB of ${MAX_TOOL_IMAGE_TOTAL_BYTES / 1024 / 1024} MB`);
    ok('the byte overflow is stated in text', /per-result total/.test(h.text), h.text.slice(0, 160));
    ok('the caps did not swallow the text', typeof h.text === 'string');
}
{
    // A result with exactly the cap is not truncated by it.
    const { MAX_TOOL_IMAGES_PER_CALL } = require('../out/externalMcp.js');
    const exact = Array.from({ length: MAX_TOOL_IMAGES_PER_CALL }, () => ({ type: 'image', mimeType: 'image/png', data: PNG_1x1 }));
    const r = mapMcpToolContent(exact);
    eq('exactly the cap is accepted whole', r.images.length, MAX_TOOL_IMAGES_PER_CALL);
    ok('and no refusal note is emitted', r.text === '', r.text);
}

// --- mime allowlist ------------------------------------------------------
for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/PNG', ' image/png ']) {
    ok(`${mime} is provider-safe`, isProviderSafeImageMime(mime));
}
for (const mime of ['image/svg+xml', 'image/bmp', 'image/tiff', 'application/pdf', 'text/html', '', undefined]) {
    ok(`${String(mime)} is NOT provider-safe`, !isProviderSafeImageMime(mime));
}

// --- base64 length (used for the size cap and the estimator) -------------
eq('base64 byte length of a 4-char payload', base64ByteLength('QUFB'), 3);
eq('base64 with two pad (4 bytes)', base64ByteLength('QUFBQQ=='), 4);
eq('base64 with one pad (2 bytes)', base64ByteLength('QUI='), 2);
eq('unpadded base64', base64ByteLength('QUFB'), 3);
eq('base64 with newlines is measured after stripping', base64ByteLength('QUFB\nQUJD'), 6);
eq('empty base64 is zero bytes', base64ByteLength(''), 0);

// --- toolResultContent: the message each transport serializes -----------
{
    const img = { mimeType: 'image/png', dataBase64: PNG_1x1 };
    eq('no images means a plain string result', toolResultContent('done', undefined, 'data-uri'), 'done');
    eq('an empty image array means a plain string result', toolResultContent('done', [], 'data-uri'), 'done');
    eq('text alone with images present is unchanged',
        toolResultContent('done', [], 'data-uri'), 'done');

    const parts = toolResultContent('done', [img], 'data-uri');
    ok('a multimodal result is an array', Array.isArray(parts));
    eq('text comes FIRST so the model reads it before the picture', parts[0].type, 'text');
    eq('the text is carried verbatim', parts[0].text, 'done');
    eq('then the image', parts[1].type, 'image_url');
    ok('the data-uri form is used by default', parts[1].image_url.url.startsWith('data:image/png;base64,'));

    const raw = toolResultContent('done', [img], 'base64');
    eq('the raw-base64 wire form is used when negotiated', raw[1].image_url.url, PNG_1x1);

    const noText = toolResultContent('', [img], 'data-uri');
    eq('an image-only result does not add an empty text part', noText.length, 1);

    // The tool's own text is kept and the bad image becomes a text marker, so
    // the model reads "here is what happened, this picture could not be shown".
    const bad = toolResultContent('done', [{ mimeType: 'image/svg+xml', dataBase64: 'PHN2Zz4=' }], 'data-uri');
    eq('an unsupported image adds no image block', bad.filter((p) => p.type === 'image_url').length, 0);
    eq('an unsupported image becomes a text marker beside the text', bad.length, 2);
    eq('the original text still leads', bad[0].text, 'done');
    ok('the marker names the type', /image\/svg\+xml/.test(bad[1].text), bad[1].text);
    ok('the marker does not claim success', /omitted/.test(bad[1].text), bad[1].text);

    const many = toolResultContent('done', [img, img, img], 'data-uri');
    eq('multiple images keep their order and count', many.length, 4);
}

// --- token estimation: the mis-count this prevents ----------------------
{
    // The bug class: JSON.stringify of a 300 KB base64 payload over-counts by
    // ~100x, which fires compaction on every run that takes a screenshot.
    const bigImg = { type: 'image_url', image_url: { url: `data:image/png;base64,${base64OfBytes(300_000)}` } };
    const withImage = estimateMessageTokens({ role: 'tool', content: [bigImg] });
    const jsonEstimate = Math.ceil(JSON.stringify([bigImg]).length / 3);
    ok('a 300 KB image is not estimated as its base64 length',
        withImage < jsonEstimate / 10,
        `(image=${withImage}, jsonstringify=${jsonEstimate})`);
    ok('a 300 KB image is estimated in the low thousands',
        withImage > 500 && withImage < 3000, `got ${withImage}`);

    const tiny = estimateMessageTokens({
        role: 'tool',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1x1}` } }],
    });
    ok('a 1x1 image is estimated cheaply', tiny < 300, `got ${tiny}`);

    eq('a text-only result is unaffected', estimateMessageTokens({ role: 'tool', content: 'hello' }), 2);

    const mixed = estimateMessageTokens({
        role: 'tool',
        content: [{ type: 'text', text: 'x'.repeat(300) }, bigImg],
    });
    ok('a multimodal result estimates as text + image, not base64',
        mixed < jsonEstimate / 5, `got ${mixed}`);
    ok('estimateImageTokens is monotonic in payload size',
        estimateImageTokens(`data:image/png;base64,${base64OfBytes(500_000)}`)
        >= estimateImageTokens(`data:image/png;base64,${base64OfBytes(1000)}`));
}

// --- context budgets: an image must not escape the caps ------------------
{
    // A screenshot-only result: array content, no text. Before this change
    // both bound functions keyed on `typeof content === 'string'` and skipped it.
    const images = Array.from({ length: 4 }, () => ({
        mimeType: 'image/png',
        dataBase64: base64OfBytes(400_000),
    }));
    const messages = [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'a', content: toolResultContent('shot', images, 'data-uri') },
    ];
    const beforeChars = JSON.stringify(messages).length;
    ok('a multimodal result is bound to the window', boundToolResults(messages, 8192, 0) === true);
    const afterChars = JSON.stringify(messages).length;
    ok('bounding actually shrinks it', afterChars < beforeChars,
        `(before=${beforeChars}, after=${afterChars})`);
    const text = Array.isArray(messages[1].content)
        ? messages[1].content.map((p) => p.text ?? '').join('')
        : messages[1].content;
    ok('the dropped images are declared, not silently lost',
        /image\(s\) omitted/.test(text), text.slice(0, 200));
}
{
    // The cheap tier must reach array-content results too.
    const many = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 8; i++) {
        many.push({
            role: 'tool',
            tool_call_id: `t${i}`,
            content: toolResultContent('shot', [{ mimeType: 'image/png', dataBase64: base64OfBytes(200_000) }], 'data-uri'),
        });
    }
    const reclaimed = elideOldToolResults(many, 2);
    ok('the cheap elision tier reclaims multimodal results', reclaimed > 0, `got ${reclaimed}`);
    const elided = many.filter((m) => m.content === TOOL_RESULT_ELISION_MARKER).length;
    ok('the oldest multimodal results were elided', elided === 6, `got ${elided}`);
}
{
    // A short multimodal result must NOT be grown into the marker.
    const msgs = [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'a', content: 'ok' },
    ];
    elideOldToolResults(msgs, 0);
    eq('a short result is left alone (no occupancy growth)', msgs[1].content, 'ok');
}
{
    // The run-lifetime event ledger counts and reclaims images.
    const events = [
        { type: 'tool_result', id: 'a', tool: 't', output: 'shot', images: [{ mimeType: 'image/png', dataBase64: base64OfBytes(1_500_000) }] },
        { type: 'tool_result', id: 'b', tool: 't', output: 'shot', images: [{ mimeType: 'image/png', dataBase64: base64OfBytes(1_500_000) }] },
    ];
    ok('the event ledger bounds image payloads', boundOutcomeEvents(events, 2_000_000) === true);
    ok('at least one image was dropped', events.some((e) => !e.images), JSON.stringify(events.map((e) => !!e.images)));
    ok('the dropped image is announced in the text',
        events.some((e) => /image\(s\) dropped/.test(e.output)), JSON.stringify(events.map((e) => e.output.slice(-80))));
}
{
    // Idempotence: the hot path re-runs this after every push. The payload is
    // sized so the FIRST pass genuinely has work to do (text is already under
    // the display limit, so only the image pass can reclaim it).
    const events = [
        { type: 'tool_result', id: 'a', tool: 't', output: 'x'.repeat(500), images: [{ mimeType: 'image/png', dataBase64: base64OfBytes(3_000_000) }] },
    ];
    ok('first pass changes it', boundOutcomeEvents(events, 2_000_000) === true);
    ok('the image was dropped', events[0].images === undefined);
    ok('second pass is a no-op', boundOutcomeEvents(events, 2_000_000) === false);
}

// --- persistence: metadata only, never base64 --------------------------
{
    const event = {
        type: 'toolResult',
        id: 'call1',
        tool: 'mcp__playwright__browser_take_screenshot',
        output: 'Screenshot of example.com',
        images: [{ mimeType: 'image/png', dataBase64: PNG_1x1, caption: 'checkout page' }],
    };
    const persisted = persistedEventFromAgentEvent(event);
    ok('the persisted event records the image', Array.isArray(persisted.images) && persisted.images.length === 1);
    const serialized = JSON.stringify(persisted);
    ok('the persisted event carries NO base64 payload', !serialized.includes(PNG_1x1), serialized.slice(0, 200));
    eq('the persisted image keeps its mime', persisted.images[0].mimeType, 'image/png');
    ok('the persisted image records a byte size', persisted.images[0].bytes > 0, String(persisted.images[0].bytes));
    eq('the caption is kept for the transcript', persisted.images[0].caption, 'checkout page');

    const row = historyRowFromEvent(persisted);
    eq('the replay row is a tool row', row.role, 'tool');
    ok('the replay row says the image is gone',
        /not retained in session history/.test(row.content), row.content);
    ok('the replay row still carries the original text',
        /Screenshot of example.com/.test(row.content), row.content);
}
{
    // A text-only tool result must be byte-UNCHANGED by the new metadata path.
    const persisted = persistedEventFromAgentEvent({
        type: 'toolResult', id: 'c', tool: 'read_file', output: 'file body',
    });
    ok('a text-only result gains no images key', persisted.images === undefined);
    eq('a text-only result replays verbatim', historyRowFromEvent(persisted).content, 'file body');
}
{
    eq('an empty output with images still explains the loss',
        toolResultReplayText('', [{ bytes: 2048 }]),
        '[1 image(s) from this tool result are not retained in session history (2 KB) - re-run the tool if you need to see them again]');
    eq('no images means no note', toolResultReplayText('out', undefined), 'out');
}

// --- chat transport: the multimodal tool row must survive the wire ------
{
    const content = toolResultContent('shot', [{ mimeType: 'image/png', dataBase64: PNG_1x1 }], 'data-uri');
    const wire = chatWireMessages([{ role: 'tool', tool_call_id: 'a', content, isError: false }]);
    ok('the chat wire keeps array tool content', Array.isArray(wire[0].content));
    eq('the chat wire still carries the tool_call_id', wire[0].tool_call_id, 'a');
    ok('the chat wire strips only the internal isError flag', wire[0].isError === undefined);
    eq('the image survives the wire round-trip', wire[0].content[1].image_url.url.length, content[1].image_url.url.length);
}

// --- summary -------------------------------------------------------------
console.log(failed === 0
    ? '\nall external-MCP image passthrough tests passed'
    : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
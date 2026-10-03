#!/usr/bin/env node
/**
 * END-TO-END tool-image tests: drive the REAL `runLocalAgent` loop against a
 * mocked transport and inspect the request bodies each API style actually
 * puts on the wire.
 *
 * `test-mcp-tool-images.mjs` proves the CONTENT BLOCK MAPPING. This suite
 * proves the four wire serializers send the image at all, because each one is a
 * different shape and each failed differently before this change:
 *   - chat       - array `content` on a `role:'tool'` message
 *   - messages   - an `image` block inside `tool_result.content`
 *   - responses  - `function_call_output` is text-only, so the image MUST be
 *                  lifted into a following user message
 *   - google     - `inlineData` riding the same user turn as the
 *                  `functionResponse` (a separate turn breaks alternation)
 *
 * Each assertion reads the captured request body, so a serializer that
 * silently drops the image fails here even though the mapping is correct.
 *
 * Run (after `npx tsc -p . --outDir out`):
 *   node test/test-tool-images-e2e.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    runLocalAgent,
    toolResultContent,
    messagesHaveImages,
    reencodeMessageImages,
    estimateImageTokens,
    chatWireMessages,
} = require('../out/local/localAgent.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(name, a === e, `(got ${a}, want ${e})`);
};

const encoder = new TextEncoder();
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const sse = (lines) => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
        pull(controller) {
            if (!lines.length) { controller.close(); return; }
            controller.enqueue(encoder.encode(lines.shift()));
        },
    }),
    text: async () => '',
});

const PNG_1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The tool the agent calls first: returns text PLUS an image. */
const SHOT_TOOL = [{
    name: 'mcp__playwright__browser_take_screenshot',
    description: 'Take a screenshot',
    inputSchema: { type: 'object', properties: {} },
    requiresApproval: false,
}];

const TOOL_CALL_ARGS = '{"url":"https://example.com"}';

/**
 * One round: the model calls the screenshot tool, the executor returns an
 * image, then the model answers. Captures every request body.
 */
async function drive(apiStyle, { images } = {}) {
    const requests = [];
    let round = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        if (round++ === 0) {
            // Round 1: ask for the tool call, in the shape the style uses.
            if (url.endsWith('/messages')) {
                return sse([
                    frame({
                        type: 'message_start',
                        message: { id: 'm1', role: 'assistant', model: 'test', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
                    }),
                    frame({
                        type: 'content_block_start',
                        index: 0,
                        content_block: { type: 'tool_use', id: 'call1', name: SHOT_TOOL[0].name, input: {} },
                    }),
                    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: TOOL_CALL_ARGS } }),
                    frame({ type: 'content_block_stop', index: 0 }),
                    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
                    frame({ type: 'message_stop' }),
                ]);
            }
            if (url.endsWith('/responses')) {
                // The real three-event shape: `added` opens the item (this is
                // what registers the call), arguments stream as deltas, then
                // `done` carries the complete item.
                return sse([
                    frame({
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: SHOT_TOOL[0].name, arguments: '' },
                    }),
                    frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: TOOL_CALL_ARGS }),
                    frame({
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: SHOT_TOOL[0].name, arguments: TOOL_CALL_ARGS },
                    }),
                    frame({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }),
                ]);
            }
            if (url.includes('GenerateContent')) {
                return sse([
                    frame({
                        candidates: [{
                            content: {
                                role: 'model',
                                parts: [{ functionCall: { name: SHOT_TOOL[0].name, args: { url: 'https://example.com' } } }],
                            },
                            finishReason: 'STOP',
                        }],
                        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
                    }),
                ]);
            }
            return sse([
                frame({
                    choices: [{
                        finish_reason: 'tool_calls',
                        delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: SHOT_TOOL[0].name, arguments: TOOL_CALL_ARGS } }] },
                    }],
                }),
                'data: [DONE]\n\n',
            ]);
        }
        // Round 2: done, no more tools.
        if (url.endsWith('/messages')) {
            return sse([
                frame({
                    type: 'message_start',
                    message: { id: 'm2', role: 'assistant', model: 'test', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
                }),
                frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
                frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The screenshot shows the page.' } }),
                frame({ type: 'content_block_stop', index: 0 }),
                frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
                frame({ type: 'message_stop' }),
            ]);
        }
        if (url.endsWith('/responses')) {
            return sse([
                frame({ type: 'response.output_text.delta', delta: 'The screenshot shows the page.' }),
                frame({
                    type: 'response.completed',
                    response: {
                        usage: { input_tokens: 10, output_tokens: 8 },
                        output: [{ type: 'message', content: [{ type: 'output_text', text: 'The screenshot shows the page.' }] }],
                    },
                }),
            ]);
        }
        if (url.includes('GenerateContent')) {
            return sse([
                frame({
                    candidates: [{ content: { role: 'model', parts: [{ text: 'The screenshot shows the page.' }] }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
                }),
            ]);
        }
        return sse([
            frame({ choices: [{ finish_reason: 'stop', delta: { content: 'The screenshot shows the page.' } }] }),
            'data: [DONE]\n\n',
        ]);
    };

    const events = [];
    try {
        for await (const ev of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'You are a test agent.',
                userText: 'screenshot the page',
                tools: SHOT_TOOL,
                maxRounds: 3,
                contextWindow: 32768,
                apiStyle,
            },
            {
                execute: async () => ({
                    output: 'Screenshot captured.',
                    ...(images ? { images } : {}),
                }),
            },
            { requestApproval: async () => ({}) },
        )) {
            events.push(ev);
        }
    } finally {
        globalThis.fetch = original;
    }
    return { events, requests };
}

/** The second request is the one that carries the tool result. */
function resultRequest(requests, apiStyle) {
    const tail = requests[requests.length - 1];
    ok(`the ${apiStyle} run made a follow-up request`, requests.length >= 2, `got ${requests.length}`);
    return tail.body;
}

const IMG = { mimeType: 'image/png', dataBase64: PNG_1x1, caption: 'checkout page' };

// --- the data-uri -> raw-base64 fallback ---------------------------------
// LM Studio / Ollama reject the OpenAI-standard `data:` URI in image_url.url.
// The recovery flips the encoding and retries; a tool image encoded with the
// OLD format must be flipped too, or the retry re-sends what was just rejected.
{
    const requests = [];
    let round = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        if (round++ === 0) {
            return sse([
                frame({ choices: [{ finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: SHOT_TOOL[0].name, arguments: TOOL_CALL_ARGS } }] } }] }),
                'data: [DONE]\n\n',
            ]);
        }
        if (requests.length === 2) {
            // The wording LM Studio / llama.cpp actually return.
            return { ok: false, status: 400, json: async () => ({}), text: async () => "'url' field must be a base64 encoded image" };
        }
        return sse([
            frame({ choices: [{ finish_reason: 'stop', delta: { content: 'ok' } }] }),
            'data: [DONE]\n\n',
        ]);
    };
    try {
        for await (const _ev of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'You are a test agent.',
                userText: 'screenshot the page',
                tools: SHOT_TOOL,
                maxRounds: 4,
                contextWindow: 32768,
                apiStyle: 'chat',
            },
            { execute: async () => ({ output: 'Screenshot captured.', images: [IMG] }) },
            { requestApproval: async () => ({}) },
        )) { /* drain */ }
    } finally {
        globalThis.fetch = original;
    }
    ok('the 400 triggered a retry', requests.length >= 3, `got ${requests.length}`);
    const retried = JSON.stringify(requests[requests.length - 1]?.body?.messages ?? []);
    ok('the retried request uses RAW base64 for the tool image',
        retried.includes(`"url":"${PNG_1x1}"`), retried.slice(0, 300));
    ok('the retried request carries no leftover data: URI',
        !retried.includes('data:image/png;base64,'), retried.slice(0, 300));
}
{
    // The unit-level contract: a tool-only turn (no user attachment) is still
    // eligible for the fallback, and re-encoding is idempotent in both
    // directions.
    const msgs = [
        { role: 'user', content: 'u' },
        { role: 'tool', tool_call_id: 'a', content: toolResultContent('shot', [IMG], 'data-uri') },
    ];
    ok('a tool-only turn still counts as having images', messagesHaveImages(msgs));
    ok('a text-only turn does not', !messagesHaveImages([{ role: 'user', content: 'hi' }]));
    reencodeMessageImages(msgs, 'base64');
    eq('the tool image was re-encoded to raw base64', msgs[1].content[1].image_url.url, PNG_1x1);
    // The flip is one-way BY DESIGN: raw base64 carries no media type, so
    // re-wrapping would emit `data:;base64,...` which every provider rejects.
    // The run swaps at most once, so this never occurs on the real path - the
    // assertion pins the safe degradation instead.
    reencodeMessageImages(msgs, 'data-uri');
    eq('re-wrapping raw base64 leaves it raw (no mime to restore)', msgs[1].content[1].image_url.url, PNG_1x1);
    ok('it never emits a mime-less data URL', !msgs[1].content[1].image_url.url.startsWith('data:;base64,'),
        msgs[1].content[1].image_url.url.slice(0, 40));
    ok('re-encoding a string-content message is a no-op', (() => {
        const plain = [{ role: 'tool', tool_call_id: 'b', content: 'text only' }];
        reencodeMessageImages(plain, 'base64');
        return plain[0].content === 'text only';
    })());
}

// --- chat completions ----------------------------------------------------
{
    const { events, requests } = await drive('chat', { images: [IMG] });
    const body = resultRequest(requests, 'chat');
    const toolMsg = (body.messages ?? []).find((m) => m.role === 'tool');
    ok('chat: a tool message is present', !!toolMsg);
    ok('chat: the tool message content is multimodal', Array.isArray(toolMsg?.content), JSON.stringify(toolMsg?.content)?.slice(0, 200));
    ok('chat: the text half rides along', /Screenshot captured/.test(JSON.stringify(toolMsg?.content)));
    const imgPart = (toolMsg?.content ?? []).find((p) => p.type === 'image_url');
    ok('chat: the image block is present', !!imgPart);
    ok('chat: the image carries the payload', imgPart?.image_url?.url === `data:image/png;base64,${PNG_1x1}`);
    const resultEvent = events.find((e) => e.type === 'toolResult');
    ok('chat: the host event carries the image too', resultEvent?.images?.length === 1);
}

// --- anthropic messages --------------------------------------------------
{
    const { requests } = await drive('messages', { images: [IMG] });
    const body = resultRequest(requests, 'messages');
    const raw = JSON.stringify(body);
    ok('messages: the request mentions the image media type', /"type":"image"/.test(raw), raw.slice(0, 300));
    const toolBlock = JSON.stringify(body.messages ?? []).match(/"type":"tool_result"[\s\S]{0,4000}/)?.[0] ?? '';
    ok('messages: the tool_result contains an image block', /"type":"image"/.test(toolBlock), toolBlock.slice(0, 300));
    ok('messages: the image uses base64 source form', /"type":"base64"/.test(toolBlock));
    ok('messages: the media type is set', /"media_type":"image\/png"/.test(toolBlock));
    ok('messages: the payload survives', toolBlock.includes(PNG_1x1));
    ok('messages: the text half is still there', toolBlock.includes('Screenshot captured'));
}

// --- responses -----------------------------------------------------------
{
    const { requests } = await drive('responses', { images: [IMG] });
    const body = resultRequest(requests, 'responses');
    const input = body.input ?? [];
    const out = input.find((i) => i.type === 'function_call_output');
    ok('responses: a function_call_output is present', !!out);
    ok('responses: its output is the TEXT half only', typeof out?.output === 'string' && /Screenshot captured/.test(out.output));
    ok('responses: the output carries no base64', typeof out?.output === 'string' && !out.output.includes(PNG_1x1));
    const followUp = input.find((i) => i.role === 'user' && Array.isArray(i.content)
        && i.content.some((c) => c.type === 'input_image'));
    ok('responses: the image is lifted into a follow-up user message', !!followUp);
    const imgPart = followUp?.content?.find((c) => c.type === 'input_image');
    ok('responses: the image part carries the payload', imgPart?.image_url === `data:image/png;base64,${PNG_1x1}`);
    ok('responses: the follow-up says what it is',
        /previous tool call/.test(followUp?.content?.[0]?.text ?? ''), followUp?.content?.[0]?.text);
    ok('responses: the follow-up comes AFTER the call output',
        input.indexOf(out) < input.indexOf(followUp));
}

// --- google --------------------------------------------------------------
{
    const { requests } = await drive('google', { images: [IMG] });
    const body = resultRequest(requests, 'google');
    const contents = body.contents ?? [];
    const userTurn = contents.find((c) => c.role === 'user'
        && c.parts.some((p) => p.functionResponse));
    ok('google: a functionResponse turn is present', !!userTurn);
    const fr = userTurn?.parts?.find((p) => p.functionResponse)?.functionResponse;
    ok('google: the functionResponse is matched by NAME', fr?.name === SHOT_TOOL[0].name, JSON.stringify(fr?.name));
    ok('google: its result carries the text half', /Screenshot captured/.test(JSON.stringify(fr?.response)));
    const inline = userTurn?.parts?.find((p) => p.inlineData);
    ok('google: the image rides the SAME turn as the functionResponse', !!inline);
    ok('google: the inline mime is set', inline?.inlineData?.mimeType === 'image/png');
    ok('google: the inline payload survives', inline?.inlineData?.data === PNG_1x1);
    // Gemini REJECTS two consecutive same-role turns, so the property that
    // matters is that no role repeats back-to-back - the image must have
    // ridden an existing tool-result turn rather than opened a new one.
    const roles = contents.map((c) => c.role);
    const consecutive = roles.some((r, i) => i > 0 && r === roles[i - 1]);
    ok('google: no two consecutive same-role turns', !consecutive, roles.join(','));
    ok('google: the tool-result turn is the last one (the model answers next)',
        roles[roles.length - 1] === 'user', roles.join(','));
}

// --- a text-only tool result must be UNCHANGED by all of this -----------
for (const style of ['chat', 'messages', 'responses', 'google']) {
    const { requests } = await drive(style, { images: undefined });
    const body = resultRequest(requests, style);
    const raw = JSON.stringify(body);
    ok(`${style}: a text-only result sends no image block`, !/"type":"image"|input_image|inlineData|"image_url"/.test(raw));
    ok(`${style}: a text-only result still sends its text`, /Screenshot captured/.test(raw));
}

// --- an unsupported media type must not reach the wire ------------------
{
    const { requests } = await drive('messages', {
        images: [{ mimeType: 'image/svg+xml', dataBase64: 'PHN2Zz48L3N2Zz4=' }],
    });
    const raw = JSON.stringify(resultRequest(requests, 'messages'));
    ok('an unsupported media type sends NO image block', !/"type":"image"/.test(raw), raw.slice(0, 300));
    ok('an unsupported media type is explained in text', /omitted/.test(raw));
    ok('an unsupported media type leaks no payload', !raw.includes('PHN2Zz48L3N2Zz4='));
}

// --- the data-uri -> raw-base64 fallback is CHAT-ONLY ---------------------
// LM Studio / Ollama reject the OpenAI-standard `data:` URI in image_url.url,
// and the recovery flips the encoding and retries. But `image_url.url` is a
// CHAT-COMPLETIONS field: the raw-base64 form is valid only there. On the
// messages / responses / google styles a data URI is the ONLY valid form, so
// flipping silently DROPPED the image - the model got the text and no picture,
// with nothing saying so.
//
// Regression: the swap fired on every style, so one matching gateway 400 was
// enough to make images vanish on three of the four transports.
for (const style of ['messages', 'responses', 'google']) {
    const requests = [];
    let round = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        requests.push({ url, body });
        const toolCallRound = round++ === 0;
        if (toolCallRound) {
            if (style === 'messages') {
                return sse([
                    frame({ type: 'message_start', message: { id: 'm1', role: 'assistant', model: 'test', content: [], usage: { input_tokens: 10, output_tokens: 0 } } }),
                    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call1', name: SHOT_TOOL[0].name, input: {} } }),
                    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: TOOL_CALL_ARGS } }),
                    frame({ type: 'content_block_stop', index: 0 }),
                    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
                    frame({ type: 'message_stop' }),
                ]);
            }
            if (style === 'responses') {
                return sse([
                    frame({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: SHOT_TOOL[0].name, arguments: '' } }),
                    frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: TOOL_CALL_ARGS }),
                    frame({ type: 'response.output_item.done', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: SHOT_TOOL[0].name, arguments: TOOL_CALL_ARGS } }),
                    frame({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }),
                ]);
            }
            return sse([
                frame({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: SHOT_TOOL[0].name, args: { url: 'https://example.com' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
            ]);
        }
        // A gateway 400 whose wording matches IMAGE_FORMAT_ERROR_RE.
        return { ok: false, status: 400, json: async () => ({}), text: async () => "'url' field must be a base64 encoded image" };
    };
    try {
        for await (const _ev of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt: 'You are a test agent.',
                userText: 'screenshot the page',
                tools: SHOT_TOOL,
                maxRounds: 4,
                contextWindow: 32768,
                apiStyle: style,
            },
            { execute: async () => ({ output: 'Screenshot captured.', images: [IMG] }) },
            { requestApproval: async () => ({}) },
        )) { /* drain */ }
    } catch { /* the turn ends in the provider error; we assert the wire, not the outcome */ } finally {
        globalThis.fetch = original;
    }
    const lastBody = JSON.stringify(requests[requests.length - 1]?.body ?? {});
    ok(`${style}: a matching 400 does NOT swap the encoding`, lastBody.includes(PNG_1x1),
        'the image payload is absent from the final request');
    ok(`${style}: the image is NOT silently dropped`,
        /data:image\/png;base64,/.test(lastBody) || /"media_type":"image\/png"/.test(lastBody) || /"inlineData"/.test(lastBody),
        lastBody.slice(0, 400));
}

// --- local-only image fields must never reach the wire ------------------
// `width`/`height` exist purely so `estimateImageTokens` can use the real
// high-detail formula. The chat transport serializes messages near-verbatim,
// so those keys would go out as unknown `image_url` members - and strict
// OpenAI-compatible servers 400 on unknown fields.
{
    const sized = toolResultContent('shot', [{ ...IMG, width: 1280, height: 800 }], 'data-uri');
    ok('the internal part carries the dimensions', sized[1].image_url.width === 1280);
    const wire = JSON.stringify(chatWireMessages([{ role: 'tool', tool_call_id: 'a', content: sized }]));
    ok('the chat wire does NOT leak width', !/"width"/.test(wire), wire.slice(0, 200));
    ok('the chat wire does NOT leak height', !/"height"/.test(wire), wire.slice(0, 200));
    ok('the image itself still goes out', wire.includes(PNG_1x1));

    // A size-less image (every MCP server) is untouched.
    const plain = toolResultContent('shot', [IMG], 'data-uri');
    const plainWire = JSON.stringify(chatWireMessages([{ role: 'tool', tool_call_id: 'b', content: plain }]));
    ok('an unsized image is unaffected', plainWire.includes(PNG_1x1) && !/"width"/.test(plainWire));
}
{
    // The estimator actually uses the dimensions when given them.
    const px = (w, h) => estimateImageTokens({ width: w, height: h, dataBase64: 'x' });
    // OpenAI high-detail: shortest side -> 768, longest side -> 2048, tile 512.
    // Worked examples (proportional scaling, both steps):
    //   1280x800  -> 1229x768        -> 3x2 tiles -> 85 + 6600 = 6685
    //   4096x4096 -> 768x768         -> 2x2 tiles -> 85 + 4400 = 4485
    //   1280x6000 -> 768x3600 -> 437x2048 -> 1x4 tiles -> 85 + 4400 = 4485
    eq('a 1280x800 screenshot matches the high-detail figure', px(1280, 800), 85 + 6 * 1100);
    // The resize steps are load-bearing. Tiling RAW dimensions over-counts a
    // square (compacting away the context for nothing) and UNDER-counts a tall
    // page - the exact shape a full-page browser capture has.
    eq('a 4096x4096 square is NOT 64 tiles', px(4096, 4096), 85 + 4 * 1100);
    ok('a square does not over-count', px(4096, 4096) < 6000, `got ${px(4096, 4096)}`);
    eq('a tall full-page capture is not under-counted', px(1280, 6000), 85 + 4 * 1100);
    ok('a 1920x1080 frame matches the high-detail figure', px(1920, 1080), 85 + 6 * 1100);
    ok('a small icon is cheap', px(64, 64) < px(1280, 800), `icon=${px(64, 64)}`);
    ok('every size stays within one order of magnitude of its true cost',
        [[64, 64], [1280, 800], [1920, 1080], [4096, 4096], [1280, 6000]]
            .every(([w, h]) => px(w, h) > 1000 && px(w, h) < 100_000));
    ok('an unsized image still falls back to the length heuristic',
        estimateImageTokens({ url: `data:image/png;base64,${PNG_1x1}` }) < 300);
    ok('a zero/negative dimension is not trusted',
        estimateImageTokens({ width: 0, height: 0, url: `data:image/png;base64,${PNG_1x1}` }) < 300);
}
{
    // Regression: `reencodeMessageImages` rebuilt `image_url` with only `url`,
    // discarding the dimensions - so after a chat fallback retry the estimator
    // fell back to the length heuristic and charged ~1,100 for what is really
    // a ~6,700-token screenshot, letting the retry overflow the window.
    const msgs = [{
        role: 'tool',
        tool_call_id: 'a',
        content: toolResultContent('shot', [{ ...IMG, width: 1280, height: 800 }], 'data-uri'),
    }];
    reencodeMessageImages(msgs, 'base64');
    const part = msgs[0].content[1].image_url;
    eq('the url is re-encoded', part.url, PNG_1x1);
    eq('the width survives the re-encode', part.width, 1280);
    eq('the height survives the re-encode', part.height, 800);
    ok('so the estimator still charges the real tile cost',
        estimateImageTokens({ url: part.url, width: part.width, height: part.height }) === 85 + 6 * 1100);
}

console.log(failed === 0
    ? '\nall end-to-end tool-image wire tests passed'
    : `\n${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
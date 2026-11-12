import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestStreamingCompletion } = require('../out/local/wireAdapters.js');
const { runLocalAgent } = require('../out/local/localAgent.js');
const { SseDecoder, readSseData, MAX_SSE_EVENT_CHARS, MAX_SSE_RESPONSE_BYTES } = require('../out/local/transport.js');
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const call = { id: 'call-a', name: 'read_file', arguments: '{"path":"a"}' };
const fixtures = {
    chat: [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ],
    messages: [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: call.arguments } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
    ],
    responses: [{ type: 'response.completed', response: { output: [{ ...call, id: 'item-a', call_id: call.id, type: 'function_call' }] } }],
    google: [{ candidates: [{ content: { parts: [{ functionCall: { id: call.id, name: call.name, args: { path: 'a' } } }] }, finishReason: 'STOP' }] }],
};
async function read(style, chunks, options = {}) {
    let cancelled = false, stream;
    globalThis.fetch = async () => {
        let index = 0;
        stream = new ReadableStream({
            pull(controller) {
                if (index < chunks.length) {
                    const chunk = chunks[index++];
                    controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
                } else if (!options.open) controller.close();
            },
            cancel() { cancelled = true; },
        });
        return new Response(stream);
    };
    const result = requestStreamingCompletion({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiStyle: style, systemPrompt: '', tools: [] },
        [{ role: 'user', content: 'Read' }], '', () => {});
    return { result, get cancelled() { return cancelled; }, get locked() { return stream?.locked; } };
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
for (const [style, frames] of Object.entries(fixtures)) {
    test(`${style}: malformed JSON cannot be skipped before authorizing calls`, async () => {
        const run = await read(style, ['data: {broken\n\n', ...frames.map(event)]);
        await assert.rejects(run.result, /malformed.*stream|invalid.*stream/i);
    });
    test(`${style}: parsing failure cancels an open body and releases its reader`, async () => {
        const run = await read(style, [event({ error: { message: 'fixture failure' }, type: 'error' })], { open: true });
        await assert.rejects(run.result, /fixture failure/);
        assert.equal(run.cancelled, true);
        assert.equal(run.locked, false);
    });
    test(`${style}: CR, LF and split CRLF framing preserve tool arguments`, async () => {
        for (const ending of ['\r', '\r\n', '\n']) {
            const wire = '\uFEFF' + frames.map(event).join('').replaceAll('\n', ending);
            const run = await read(style, [...encoder.encode(wire)].map(byte => new Uint8Array([byte])));
            const result = await run.result;
            assert.equal(result.toolCalls.length, 1);
            assert.deepEqual(result.toolCalls[0].arguments, { path: 'a' });
            assert.equal(run.locked, false);
        }
    });
}
test('Google rejects repeated provider IDs instead of executing only the last call', async () => {
    const parts = ['a', 'b'].map(path => ({ functionCall: { id: 'same', name: call.name, args: { path } } }));
    const run = await read('google', [event({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })]);
    await assert.rejects(run.result, /duplicate tool call IDs/);
});
test('Google-generated IDs cannot collide with provider IDs, including later declarations', async () => {
    for (const reverse of [false, true]) {
        const parts = [
            { functionCall: { name: call.name, args: { path: 'synthetic' } } },
            { functionCall: { id: 'google-call-0', name: call.name, args: { path: 'native' } } },
        ];
        if (reverse) parts.reverse();
        const run = await read('google', [event({ candidates: [{ content: { parts }, finishReason: 'STOP' }] })]);
        const result = await run.result;
        assert.equal(result.toolCalls.length, 2);
        assert.equal(new Set(result.toolCalls.map(item => item.id)).size, 2);
        assert.equal(result.toolCalls.find(item => item.id === 'google-call-0').arguments.path, 'native');
    }
});
test('a malformed call identity rejects the entire Chat batch', async () => {
    const frame = { choices: [{ delta: { tool_calls: [
        { index: 0, id: call.id, function: { name: call.name, arguments: '{}' } },
        { index: 1, function: { name: 'run_command', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] };
    const run = await read('chat', [event(frame)]);
    await assert.rejects(run.result, /tool call identity/i);
});
test('Responses rejects duplicate finalized item identities before collapsing its map', async () => {
    const output = [call.id, 'call-b'].map(call_id => ({ type: 'function_call', id: 'same-item', call_id, name: call.name, arguments: '{}' }));
    const run = await read('responses', [event({ type: 'response.completed', response: { output } })]);
    await assert.rejects(run.result, /duplicate.*(item|identity)/i);
});
test('Chat refuses identity replacement at an existing tool index', async () => {
    const run = await read('chat', [event(fixtures.chat[0]), event({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'replacement', function: { arguments: ' ' } },
    ] }, finish_reason: 'tool_calls' }] })]);
    await assert.rejects(run.result, /tool call identity/i);
});
test('Messages refuses a second block start that would erase a call', async () => {
    const run = await read('messages', [event(fixtures.messages[0]), ...fixtures.messages.map(event)]);
    await assert.rejects(run.result, /duplicate.*block/i);
});
test('Messages retains complete initial tool input in execution and replay', async () => {
    const frames = [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: call.id, name: call.name, input: { path: 'initial' } } },
        ...fixtures.messages.slice(2),
    ];
    const run = await read('messages', frames.map(event));
    const result = await run.result;
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'initial' });
    assert.deepEqual(result.providerBlocks[0].input, { path: 'initial' });
});
test('Messages requires the tool block to close before message_stop authorizes it', async () => {
    const run = await read('messages', fixtures.messages.filter(frame => frame.type !== 'content_block_stop').map(event));
    await assert.rejects(run.result, /incomplete tool-call batch/);
});
for (const style of ['chat', 'messages', 'responses', 'google']) {
    test(`${style}: an earlier terminal event cannot authorize later tool declarations`, async () => {
        const frames = fixtures[style];
        const terminal = frames[frames.length - 1];
        const run = await read(style, [event(terminal), ...frames.map(event)]);
        await assert.rejects(run.result, /after.*(complet|finish|terminat)|duplicate/i);
    });
}
test('SSE removes exactly one value space and joins data fields without trimming', () => {
    const decoder = new SseDecoder();
    assert.deepEqual(decoder.push(': ping\r\ndata:  first\r\ndata:\tsecond\r\ndata\r\n\r\n'), [' first\n\tsecond\n']);
    assert.deepEqual(decoder.push('data: incomplete'), [], 'EOF does not dispatch an unterminated event');
});
test('incomplete and multiline SSE frames are bounded, including comments', () => {
    for (const prefix of ['data: ', ': ']) {
        const decoder = new SseDecoder();
        decoder.push(prefix + 'x'.repeat(MAX_SSE_EVENT_CHARS - prefix.length));
        assert.throws(() => decoder.push('x'), /size limit/);
    }
    const decoder = new SseDecoder();
    const line = 'data: ' + 'x'.repeat(1024) + '\n';
    assert.throws(() => { for (let i = 0; i < MAX_SSE_EVENT_CHARS / line.length + 1; i++) decoder.push(line); }, /size limit/);
});
test('SSE caps the whole response even when individual frames are small', async () => {
    const chunk = encoder.encode(': ' + 'x'.repeat(1024 * 1024 - 5) + '\n\n');
    let bytes = 0, cancelled = false;
    const stream = new ReadableStream({ pull(controller) { bytes += chunk.byteLength; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    await assert.rejects(async () => { for await (const _ of readSseData(stream)) { /* comments are ignored */ } }, /response exceeds/);
    assert.ok(bytes <= MAX_SSE_RESPONSE_BYTES + 2 * chunk.byteLength);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
});
test('SSE refuses damaged UTF-8 instead of changing argument bytes', async () => {
    const run = await read('chat', [encoder.encode('data: {"x":"'), new Uint8Array([0xff]), encoder.encode('"}\n\n'), ...fixtures.chat.map(event)]);
    await assert.rejects(run.result, /encoded data|encoding/i);
    assert.equal(run.cancelled, true);
});
test('the actual agent never approves or executes a damaged partial batch', async () => {
    let executed = 0, approved = 0;
    globalThis.fetch = async () => new Response(event(fixtures.chat[0]) + 'data: {broken\n\n' + event(fixtures.chat[1]));
    await assert.rejects(async () => {
        for await (const _ of runLocalAgent({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiStyle: 'chat', systemPrompt: '', userText: 'Read',
            tools: [{ name: 'read_file', description: '', inputSchema: {}, requiresApproval: true }], maxRounds: 1,
        }, { execute: async () => { executed++; return { output: 'bad' }; } }, { requestApproval: async () => { approved++; return {}; } })) { /* Exercise admission too. */ }
    }, /malformed JSON/);
    assert.equal(executed, 0);
    assert.equal(approved, 0);
});
let failures = 0;
try {
    for (const { name, fn } of tests) {
        try { await fn(); console.log(`PASS ${name}`); }
        catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
    }
} finally { globalThis.fetch = originalFetch; }
console.log(`stream-integrity: ${tests.length - failures}/${tests.length} passed`);
process.exitCode = failures ? 1 : 0;

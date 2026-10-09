import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestStreamingCompletion } = require('../out/local/wireAdapters.js');
const { FIRST_BYTE_TIMEOUT_MS, TRANSPORT_TIMEOUT_CODE } = require('../out/local/transport.js');
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let seq = 0;
globalThis.setTimeout = (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
const encoder = new TextEncoder();
const request = { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test', systemPrompt: '', userText: 'hi', tools: [] };
async function exercise(style, firstFrame, hasProgress, cancelled = false) {
    timers.clear();
    const caller = new AbortController();
    let aborts = 0;
    let ready;
    const arrived = new Promise((resolve) => { ready = resolve; });
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
        init.signal.addEventListener('abort', () => { aborts++; controller.error(init.signal.reason); }, { once: true });
        controller.enqueue(encoder.encode(firstFrame));
        // Once the adapter consumes this frame it asks for another chunk.
    }, pull() { ready(); } }), { headers: { 'content-type': 'text/event-stream' } });
    const pending = requestStreamingCompletion({ ...request, apiStyle: style, signal: caller.signal }, [{ role: 'user', content: 'hi' }], '', () => {});
    // Capture rejection immediately; the fake clock does not run real timers.
    const settled = pending.then(() => null, (error) => error);
    await arrived;
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const firstOutput = [...timers.values()].filter((t) => t.delay === FIRST_BYTE_TIMEOUT_MS);
    assert.equal(firstOutput.length, hasProgress ? 0 : 1, `${style}: meaningful progress alone clears first-output deadline`);
    if (cancelled || hasProgress) caller.abort();
    else firstOutput[0].fn();
    const error = await settled;
    assert.equal(aborts, 1);
    if (cancelled || hasProgress) assert.equal(error.name, 'AbortError');
    else {
        assert.equal(error.code, TRANSPORT_TIMEOUT_CODE);
        assert.match(error.message, /first-token timeout/);
    }
    assert.equal(timers.size, 0, `${style}: timers cleaned up`);
}
try {
    for (const style of ['chat', 'messages', 'responses', 'google']) {
        await exercise(style, ': heartbeat\n\n', false);
        await exercise(style, ': heartbeat\n\n', false, true);
    }
    await exercise('chat', 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n', true);
    await exercise('chat', 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n', true);
    await exercise('chat', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n', true);
    console.log('first-token-timeout: heartbeat, cancellation, text, reasoning and tools passed');
} finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}

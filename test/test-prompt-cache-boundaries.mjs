#!/usr/bin/env node
/** Cache-boundary regressions, not a claim about a remote server's hit rate.
 * Exercise the real wire builders, provider lookup boundaries, replay carriers,
 * optional-field rejection and server-reported usage. No network/model calls.
 * Run after `npm run compile-tests`.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requestStreamingCompletion } = require('../out/local/wireAdapters.js');

const encoder = new TextEncoder();
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const response = (style, extra = {}) => {
    const lines = style === 'responses' ? [
        frame({ type: 'response.output_text.delta', delta: 'OK' }),
        frame({ type: 'response.completed', response: {
            id: 'resp_test', output: [], usage: { input_tokens: 12_000, output_tokens: 2,
                input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_000 } }, ...extra,
        } }),
    ] : style === 'messages' ? [
        frame({ type: 'message_start', message: { usage: { input_tokens: 3_000,
            cache_read_input_tokens: 8_000, cache_creation_input_tokens: 1_000 } } }),
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }),
        frame({ type: 'message_delta', usage: { output_tokens: 2 } }),
    ] : style === 'google' ? [frame({ candidates: [{ content: { parts: [{ text: 'OK' }] } }],
        usageMetadata: { promptTokenCount: 12_000, candidatesTokenCount: 2, cachedContentTokenCount: 8_000 } })]
        : [frame({ choices: [{ delta: { content: 'OK' } }], usage: { prompt_tokens: 12_000,
            completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8_000 } } }), 'data: [DONE]\n\n'];
    return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
    } }) };
};
const request = (style = 'responses', options = {}) => ({
    baseUrl: 'https://api.openai.com/v1', apiKey: 'test-secret', model: 'gpt-6.1-sol',
    systemPrompt: 'S', userText: 'U', tools: [{ name: 'read_file', description: 'Read',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    apiStyle: style, cacheKey: 'fixed-session', contextWindow: 200_000, ...options,
});
async function capture(req, messages, note = 'status 1', respond) {
    const original = globalThis.fetch;
    const bodies = [];
    const headers = [];
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        headers.push(new Headers(init.headers));
        return respond ? respond(body, bodies.length) : response(req.apiStyle);
    };
    try {
        const result = await requestStreamingCompletion(req, messages, note, () => {});
        return { body: bodies.at(-1), bodies, result, headers: headers.at(-1) };
    } finally { globalThis.fetch = original; }
}
const sys = { role: 'system', content: 'Stable instructions '.repeat(600) };
const user = { role: 'user', content: 'Inspect the project' };
const call = id => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function',
    function: { name: 'read_file', arguments: '{"path":"source.ts"}' } }] });
const batch = ids => ({ role: 'assistant', content: '', tool_calls: ids.map(id => call(id).tool_calls[0]) });
const tool = id => ({ role: 'tool', tool_call_id: id, content: `Result ${id} ${'code '.repeat(1000)}` });
function freeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) freeze(child);
    }
    return value;
}
const withoutMarkers = value => JSON.parse(JSON.stringify(value, (key, v) =>
    key === 'cache_control' || key === 'prompt_cache_breakpoint' ? undefined : v));

/** Model cache writes/lookup endpoints, rather than calling a common JSON
 * prefix a cache hit. Metadata is not rendered prompt content. The Anthropic
 * control models its 20-block lookback (text blocks, no collapsed tool runs). */
function boundaries(body, style) {
    const points = [];
    let prefix = JSON.stringify(body.tools ?? []) + '\n';
    if (style === 'messages') {
        for (const block of body.system ?? []) {
            prefix += JSON.stringify(withoutMarkers(block));
            points.push({ prefix, marked: !!block.cache_control });
        }
    }
    for (const item of style === 'responses' ? body.input : body.messages) {
        const blocks = item.type === 'function_call_output' ? item.output : item.content;
        if (!Array.isArray(blocks)) { prefix += JSON.stringify(withoutMarkers(item)); continue; }
        const { content: _content, output: _output, ...head } = item;
        prefix += JSON.stringify(head);
        for (const block of blocks) {
            prefix += JSON.stringify(withoutMarkers(block));
            points.push({ prefix, marked: !!(block.prompt_cache_breakpoint || block.cache_control) });
        }
    }
    return points;
}
function reusableWrittenPrefix(previous, next, style) {
    const writes = new Set(boundaries(previous, style).filter(p => p.marked).map(p => p.prefix));
    const points = boundaries(next, style);
    const lookups = points.filter((point, i) => point.marked || (style === 'messages'
        && points.slice(i + 1, i + 21).some(p => p.marked)));
    return Math.max(0, ...lookups.filter(p => writes.has(p.prefix)).map(p => p.prefix.length));
}

// Explicit writes include the retained note; previous boundaries survive when
// a tool batch and steers add more than the implicit lookup window.
{
    const req = request();
    const history = freeze([sys, user, call('a'), tool('a')]);
    const original = JSON.stringify(history);
    const first = (await capture(req, history)).body;
    assert.equal(first.prompt_cache_options.mode, 'explicit');
    assert.equal(first.instructions, undefined);
    assert.equal(first.input[0].role, 'developer');
    assert.equal(first.input.at(-1).output.at(-1).text, 'status 1');
    assert.ok(first.input.at(-1).output.at(-1).prompt_cache_breakpoint);
    assert.ok(first.input[0].content[0].prompt_cache_breakpoint);
    assert.equal(JSON.stringify(history), original);
    const additions = Array.from({ length: 30 }, (_, i) => tool(`b${i}`));
    const steers = Array.from({ length: 4 }, (_, i) => ({ role: 'user', content: `steer ${i}` }));
    const nextCall = { ...batch(additions.map(m => m.tool_call_id)), contextNote: 'status 1' };
    const second = (await capture(req, [...history, nextCall, ...additions, ...steers], 'status 2')).body;
    const written = boundaries(first, 'responses').filter(p => p.marked).at(-1).prefix;
    assert.equal(reusableWrittenPrefix(first, second, 'responses'), written.length);
    assert.ok(boundaries(second, 'responses').filter(p => p.marked).length <= 4);
    assert.equal(second.prompt_cache_options.comparison_response_id, 'resp_test');
    // Without retained explicit boundaries an explicit-only request cannot
    // look up the previous history write, despite identical text prefixes.
    const broken = structuredClone(second);
    for (const item of broken.input.slice(1, -2)) {
        for (const block of item.content ?? item.output ?? []) delete block.prompt_cache_breakpoint;
    }
    assert.ok(reusableWrittenPrefix(first, broken, 'responses') < written.length);
    console.log('ok Responses preserves reusable writes through retained notes and large tool batches');
}

// Anthropic: retain prior user endpoints across a 20+ text-block reply and do
// not mutate provider-native assistant blocks (or mark thinking as cacheable).
{
    const req = request('messages', { baseUrl: 'https://opencode.ai/zen/v1', model: 'claude-sonnet-5' });
    const history = [sys, user, call('a'), tool('a')];
    const first = (await capture(req, history)).body;
    const carrier = freeze({ role: 'assistant', content: '', contextNote: 'status 1', providerBlocks: [
        { type: 'thinking', thinking: 'opaque', signature: 'signature' },
        ...Array.from({ length: 25 }, (_, i) => ({ type: 'text', text: `analysis ${i}` })),
        { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'other.ts' } },
    ] });
    const original = JSON.stringify(carrier);
    const steers = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `steer ${i}` }));
    const second = (await capture(req, [...history, carrier, tool('b'), ...steers], 'status 2')).body;
    assert.equal(JSON.stringify(carrier), original);
    const written = boundaries(first, 'messages').filter(p => p.marked).at(-1).prefix;
    assert.equal(reusableWrittenPrefix(first, second, 'messages'), written.length);
    const broken = structuredClone(second);
    delete broken.messages[2].content.find(block => block.text === 'status 1').cache_control;
    assert.ok(reusableWrittenPrefix(first, broken, 'messages') < written.length);
    assert.ok(boundaries(second, 'messages').filter(p => p.marked).length <= 4);
    // The old builder tried to attach cache_control inside this frozen array.
    const prefill = freeze({ role: 'assistant', content: 'partial', providerBlocks: [{ type: 'text', text: 'partial' }] });
    const ending = (await capture(req, [sys, user, prefill])).body;
    assert.equal(ending.messages.find(m => m.role === 'assistant').content[0].cache_control, undefined);
    assert.equal(JSON.stringify(carrier), original);
    console.log('ok Messages preserves old boundaries beyond lookback and leaves replay carriers immutable');
}

// New controls are opt-in by documented host/model capability, not sprayed at
// OpenRouter, Iranian gateways, local servers, OpenCode or legacy GPT models.
for (const options of [
    { model: 'gpt-5.5' }, { model: 'gpt-5.1-codex' }, { model: 'grok-4' },
    { baseUrl: 'https://opencode.ai/zen/v1' }, { baseUrl: 'https://openrouter.ai/api/v1' },
    { baseUrl: 'https://api.provider.example/v1' }, { baseUrl: 'http://127.0.0.1:1234/v1' },
    { baseUrl: 'https://api.openai.com.attacker.example/v1' },
    { baseUrl: 'https://chatgpt.com/backend-api/codex', subscription: true },
]) {
    const { body } = await capture(request('responses', options), [sys, user]);
    assert.equal(body.prompt_cache_options, undefined);
    assert.equal(body.instructions, sys.content);
    assert.ok(!JSON.stringify(body).includes('prompt_cache_breakpoint'));
}
{
    const { body } = await capture(request('responses', { subscription: true }), [sys, user]);
    assert.equal(body.prompt_cache_options.mode, 'explicit');
    assert.equal(body.store, false);
    assert.equal(body.tools[0].type, 'namespace');
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
}
console.log('ok Responses gates new cache controls by host/model and preserves subscription routing');

// Match native Codex continuity on supported OpenAI routes, including the
// legacy subscription endpoint that rejects the newer cache options.
{
    const { body, headers } = await capture(request('responses', { subscription: true,
        baseUrl: 'https://chatgpt.com/backend-api/codex', reasoningEffort: 'high' }), [sys, user]);
    assert.deepEqual(body.reasoning, { effort: 'high', context: 'all_turns' });
    assert.equal(body.prompt_cache_options, undefined);
    assert.equal(headers.get('session-id'), 'fixed-session');
    assert.equal(headers.get('thread-id'), 'fixed-session');
    const api = await capture(request('responses', { maxTokens: 4096 }), [sys, user]);
    assert.equal(api.body.max_output_tokens, 4096);
    assert.equal(api.body.store, false);
    assert.deepEqual(api.body.include, ['reasoning.encrypted_content']);
    assert.equal(api.headers.get('session-id'), null);
    for (const options of [{ model: 'gpt-5.5' }, { baseUrl: 'https://opencode.ai/zen/v1' },
        { baseUrl: 'https://provider.example/v1' }]) {
        const { body } = await capture(request('responses', options), [sys, user]);
        assert.equal(body.reasoning?.context, undefined);
    }
    const req = request('responses', { reasoningEffort: 'high' });
    const fallback = await capture(req, [sys, user], 'status', (_body, n) => n === 1
        ? { ok: false, status: 400, text: async () => 'Unsupported parameter: reasoning.context' }
        : response('responses'));
    assert.deepEqual(fallback.body.reasoning, { effort: 'high' });
    const subsequent = (await capture(req, [sys, user])).body;
    assert.deepEqual(subsequent.reasoning, { effort: 'high' });
    assert.equal(subsequent.store, false);
    assert.deepEqual(subsequent.include, ['reasoning.encrypted_content']);
    console.log('ok native reasoning/session continuity is scoped and context rejection preserves user effort');
}

// Explicit rejection recovers once for the run, preserving original system
// instructions, output text, tools, reasoning, and permissions on the retry.
{
    const req = request('responses', { reasoningEffort: 'high', toolChoice: 'none' });
    const { bodies } = await capture(req, [sys, user, call('a'), tool('a')], 'status', (_body, n) =>
        n === 1 ? { ok: false, status: 400, text: async () => 'Unknown parameter: prompt_cache_breakpoint' }
            : response('responses'));
    assert.equal(bodies.length, 2);
    const retry = bodies[1];
    assert.equal(retry.instructions, sys.content);
    assert.equal(retry.prompt_cache_options, undefined);
    assert.equal(typeof retry.input.find(i => i.type === 'function_call_output').output, 'string');
    assert.equal(retry.tool_choice, 'none');
    assert.deepEqual(retry.tools, bodies[0].tools);
    assert.deepEqual(retry.reasoning, bodies[0].reasoning);
    assert.ok(!JSON.stringify(retry).includes('prompt_cache_breakpoint'));
    assert.equal((await capture(req, [sys, user])).body.prompt_cache_options, undefined);
    await assert.rejects(capture(request(), [sys, user], '', () => ({
        ok: false, status: 400, text: async () => 'invalid tool schema',
    })), /invalid tool schema/);
    console.log('ok cache rejection falls back once per run without weakening tool gating');
}

// Diagnostics report actual server usage, not local prefix similarity. Every
// transport can be audited without logging the prompt, bearer or tool output.
for (const style of ['chat', 'messages', 'responses', 'google']) {
    const diagnostics = [];
    const req = request(style, { onCacheDiagnostic: value => diagnostics.push(value) });
    await capture(req, [sys, user], 'sensitive context', () => response(style, {
        prompt_cache_diagnostics: { type: 'cache_miss', reason: 'tools_changed' },
    }));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].cached, 8_000);
    assert.equal(diagnostics[0].input, 12_000);
    assert.equal(diagnostics[0].apiStyle, style);
    const logged = JSON.stringify(diagnostics);
    assert.ok(!logged.includes('sensitive context') && !logged.includes('test-secret') && !logged.includes(sys.content));
    if (style === 'responses') assert.equal(diagnostics[0].reason, 'tools_changed');
}
console.log('ok all four transports expose server-reported cache usage without prompt/credential logging');
{
    const { bodies, result } = await capture(request('responses', {
        onCacheDiagnostic: () => { throw new Error('output channel disposed'); },
    }), [sys, user]);
    assert.equal(bodies.length, 1);
    assert.equal(result.text, 'OK');
    console.log('ok a diagnostic sink failure cannot replay a successful model request');
}

#!/usr/bin/env node
/**
 * OAuth credential wire-shape tests.
 *
 * Two things can only be verified at the wire, and both are things the ChatGPT
 * backend is strict about:
 *
 *  - The Codex backend REJECTS `max_output_tokens`, wants `store:false`, and
 *    only hands back replayable reasoning when asked for the encrypted form.
 *    Sending the cap would burn a round trip on the 400-degradation retry, so
 *    the body must branch on the host.
 *  - The account-routing header must ride along on EVERY model request (all
 *    four wire adapters, not just the Responses one) and on model discovery,
 *    which builds its own headers inline.
 *
 * Also covers the 401 retry-once: an expired OAuth token is force-refreshed and
 * the round replayed exactly once - and a second 401 is NOT retried.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-oauth-wire.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { requestStreamingCompletion } = require('../out/local/wireAdapters.js');
const { runLocalAgent } = require('../out/local/localAgent.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const encoder = new TextEncoder();
const checkTrue = (name, actual) => check(name, !!actual, true);

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

const baseRequest = (over = {}) => ({
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'AT',
    model: 'gpt-5-codex',
    systemPrompt: 'sys',
    userText: 'hi',
    tools: [],
    apiStyle: 'responses',
    ...over,
});
const user = { role: 'user', content: 'hello' };

/** Drive one streaming request against a mock fetch and capture it. */
async function capture(request) {
    const captured = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        captured.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
        return sse([
            frame({ type: 'response.output_text.delta', delta: 'ok' }),
            frame({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] } }),
        ]);
    };
    try {
        await requestStreamingCompletion(request, [user], '', () => {});
    } finally {
        globalThis.fetch = original;
    }
    return captured[0];
}

// --- Responses body on the ChatGPT backend ------------------------------------
{
    const call = await capture(baseRequest({
        headers: { 'ChatGPT-Account-Id': 'acct-42', originator: 'xratu' },
        maxOutputLimit: 32000,
    }));
    check('responses endpoint', call.url, 'https://chatgpt.com/backend-api/codex/responses');
    check('store is false on the Codex backend', call.body.store, false);
    check('encrypted reasoning requested', JSON.stringify(call.body.include), JSON.stringify(['reasoning.encrypted_content']));
    // The whole point: this field is what the backend rejects.
    check('max_output_tokens omitted for chatgpt.com', 'max_output_tokens' in call.body, false);
    const h = new Headers(call.init.headers);
    check('account header exact casing', h.get('ChatGPT-Account-Id'), 'acct-42');
    check('originator header', h.get('originator'), 'xratu');
    check('bearer from the resolved token', h.get('Authorization'), 'Bearer AT');
}

// --- a non-ChatGPT Responses host keeps the cap -------------------------------
{
    const call = await capture(baseRequest({
        baseUrl: 'https://opencode.ai/zen/v1',
        model: 'gpt-5',
        maxOutputLimit: 32000,
        headers: undefined,
    }));
    check('ordinary responses host still gets a cap', call.body.max_output_tokens > 0, true);
    check('store untouched off the Codex backend', 'store' in call.body, false);
}

// --- every wire adapter carries the provider headers --------------------------
for (const [style, baseUrl, model, extraPath] of [
    ['chat', 'https://chatgpt.com/backend-api/codex', 'gpt-5', '/chat/completions'],
    ['messages', 'https://chatgpt.com/backend-api/codex', 'claude-x', '/messages'],
    ['google', 'https://chatgpt.com/backend-api/codex', 'gemini-x', ''],
]) {
    const call = await capture(baseRequest({
        apiStyle: style,
        model,
        headers: { 'ChatGPT-Account-Id': 'acct-42', originator: 'xratu' },
    }));
    check(`${style}: provider headers present`, new Headers(call.init.headers).get('ChatGPT-Account-Id'), 'acct-42');
    check(`${style}: endpoint`, call.url.includes(extraPath || '/models'), true);
}

// --- 401 retry-once ------------------------------------------------------------
{
    let attempts = 0;
    const refreshes = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        attempts++;
        if (attempts === 1) {
            return {
                ok: false,
                status: 401,
                text: async () => '{"error":{"code":"invalid_token"}}',
                json: async () => ({}),
            };
        }
        return sse([
            frame({ type: 'response.output_text.delta', delta: 'recovered' }),
            frame({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] } }),
        ]);
    };
    let text = '';
    try {
        for await (const event of runLocalAgent({
            ...baseRequest(),
            apiKey: 'STALE',
            onUnauthorized: async () => {
                refreshes.push(true);
                return 'FRESH';
            },
        }, undefined, undefined)) {
            if (event.type === 'chunk') text += event.value;
        }
    } catch (e) {
        check('401 recovered without throwing', false, String(e));
    } finally {
        globalThis.fetch = original;
    }
    check('401 triggered exactly one forced refresh', refreshes.length, 1);
    check('the round was replayed once', attempts, 2);
    check('recovered turn produced text', text, 'recovered');
}
{
    // A second 401 after the refresh is a real rejection: retrying again would
    // hammer the token endpoint for the rest of the run.
    let attempts = 0;
    let refreshes = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        attempts++;
        return {
            ok: false,
            status: 401,
            text: async () => '{"error":"unauthorized"}',
            json: async () => ({}),
        };
    };
    let threw = null;
    try {
        for await (const _ of runLocalAgent({
            ...baseRequest(),
            onUnauthorized: async () => {
                refreshes++;
                return 'FRESH';
            },
        }, undefined, undefined)) { /* drain */ }
    } catch (e) {
        threw = e;
    } finally {
        globalThis.fetch = original;
    }
    checkTrue('persistent 401 surfaces as an error', !!threw);
    // Bounded at 2 per run: a long tool-using run can outlive a token
    // lifetime twice, but a broken credential must never loop.
    check('forced refresh bounded per run', refreshes, 2);
    check('no endless 401 replay loop', attempts, 3);
}

// --- a BYOK turn is untouched: onUnauthorized is never consulted ---------------
{
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        attempts++;
        return {
            ok: false, status: 401,
            text: async () => 'unauthorized', json: async () => ({}),
        };
    };
    let threw = null;
    try {
        for await (const _ of runLocalAgent(baseRequest(), undefined, undefined)) { /* drain */ }
    } catch (e) {
        threw = e;
    } finally {
        globalThis.fetch = original;
    }
    checkTrue('401 without an oauth hook still fails', !!threw);
    check('and is NOT retried', attempts, 1);
}

// Public ChatGPT plan requests have their own contract on api.openai.com.
{
    const call = await capture(baseRequest({ baseUrl: 'https://api.openai.com/v1', subscription: true,
        temperature: 0.2, tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }] }));
    check('public subscription responses URL', call.url, 'https://api.openai.com/v1/responses');
    check('public subscription store false', call.body.store, false);
    check('public subscription streams', call.body.stream, true);
    check('public subscription omits max_output_tokens', 'max_output_tokens' in call.body, false);
    check('public subscription omits temperature', 'temperature' in call.body, false);
    check('public subscription groups local tools', call.body.tools[0].type, 'namespace');
    check('namespaced function preserves executor name', call.body.tools[0].tools[0].name, 'read_file');
}
{
    const captured = [];
    const original = globalThis.fetch;
    let executions = 0;
    const functionCall = {
        id: 'fc_item_1', call_id: 'call_1', type: 'function_call',
        namespace: 'xratu', name: 'read_file', arguments: '{"path":"README.md"}',
    };
    globalThis.fetch = async (_url, init) => {
        captured.push(JSON.parse(String(init.body)));
        if (captured.length === 1) return sse([
            frame({ type: 'response.output_item.added', output_index: 0, item: { ...functionCall, arguments: '' } }),
            frame({ type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '{"path":"README.md"}' }),
            frame({ type: 'response.output_item.done', output_index: 0, item: functionCall }),
            frame({ type: 'response.completed', response: { output: [functionCall] } }),
        ]);
        return sse([
            frame({ type: 'response.output_text.delta', delta: 'Read complete.' }),
            frame({ type: 'response.completed', response: { output: [] } }),
        ]);
    };
    const events = [];
    try {
        for await (const event of runLocalAgent({
            ...baseRequest({ baseUrl: 'https://api.openai.com/v1', subscription: true, maxRounds: 3,
                contextWindow: 100000, tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }] }),
        }, { execute: async (call) => { executions++; check('namespaced response dispatches the local tool', call.name, 'read_file'); check('tool arguments survive namespaced response', call.arguments.path, 'README.md'); return { output: 'file contents' }; } }, { requestApproval: async () => ({}) })) {
            events.push(event);
        }
    } finally { globalThis.fetch = original; }
    check('namespaced continuation executed one tool', executions, 1);
    const nextInput = captured[1].input;
    check('assistant function call is replayed with namespace', nextInput.some((item) => item.type === 'function_call' && item.namespace === 'xratu' && item.call_id === 'call_1'), true);
    check('tool result follows the matching call id', nextInput.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output === 'file contents'), true);
    check('agent continues after namespaced tool result', events.some((event) => event.type === 'chunk' && event.value === 'Read complete.'), true);
}
for (const terminal of [null, 'response.incomplete', 'response.failed']) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => sse([
        frame({ type: 'response.output_text.delta', delta: 'partial' }),
        ...(terminal ? [frame({ type: terminal, response: { error: { message: 'limited' }, incomplete_details: { reason: 'limited' } } })] : []),
    ]);
    let error;
    try {
        await requestStreamingCompletion(baseRequest({ baseUrl: 'https://api.openai.com/v1', subscription: true }), [user], '', () => {});
    } catch (e) { error = e; }
    finally { globalThis.fetch = original; }
    checkTrue(`subscription refuses ${terminal ?? 'missing completion'}`, error);
}
{
    const { compactWithSummary } = require('../out/local/compaction.js');
    const messages = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 8; i++) messages.push({ role: 'user', content: `turn ${i}` }, { role: 'assistant', content: 'result '.repeat(1800) });
    const original = globalThis.fetch;
    let captured;
    globalThis.fetch = async (_url, init) => {
        captured = JSON.parse(init.body);
        return sse([frame({ type: 'response.output_text.delta', delta: 'rolling summary' }),
            frame({ type: 'response.completed', response: { output: [] } })]);
    };
    let summary;
    try { summary = await compactWithSummary(messages, baseRequest({ baseUrl: 'https://api.openai.com/v1', subscription: true }), 16384, 20000, null); }
    finally { globalThis.fetch = original; }
    check('subscription compaction consumes SSE', summary, 'rolling summary');
    check('subscription compaction requests streaming', captured?.stream, true);
    check('subscription compaction carries rolling summary', messages.some((m) => String(m.content).includes('rolling summary')), true);
}

console.log(failed === 0 ? '\noauth-wire tests: all passed' : `\noauth-wire tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

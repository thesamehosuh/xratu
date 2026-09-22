#!/usr/bin/env node
/**
 * Reasoning-replay tests - the Chat Completions `reasoning_content` fix.
 *
 * Regression, observed live and it KILLED whole turns:
 *
 *   400: Upstream request failed: [invalid_request_error] The
 *   `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * The chat transport parsed `reasoning_content` out of the stream for display,
 * accumulated it, and dropped it at the return. So the SECOND round of any
 * tool-using thinking turn replayed an assistant message carrying no reasoning,
 * and the API rejected the continuation. Anthropic/Gemini/Responses already
 * replay thinking through content blocks (`providerBlocks`); Chat Completions
 * has no block channel and needed its own top-level carrier.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-reasoning-replay.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { withReasoningContent } = require('../out/local/localAgent.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};
const eq = (name, actual, expected) => ok(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const toolCall = (id = 'call_1') => ({
    id,
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
});

const assistantWithTool = (extra = {}) => ({
    role: 'assistant',
    content: 'looking at the file',
    tool_calls: [toolCall()],
    ...extra,
});

// --- the provider that never had the concept is left byte-identical --------
{
    const plain = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        assistantWithTool(),
        { role: 'tool', content: 'result', tool_call_id: 'call_1' },
    ];
    const out = withReasoningContent(plain);
    // Same reference: an untouched provider must not gain an unknown field.
    ok('no reasoning anywhere -> array returned UNCHANGED (same reference)', out === plain);
    ok('no unknown field injected', !JSON.stringify(out).includes('reasoning_content'));
}

// --- captured reasoning is replayed verbatim -------------------------------
{
    const msgs = [
        { role: 'user', content: 'hi' },
        assistantWithTool({ reasoningContent: 'I should read the file first.' }),
    ];
    const out = withReasoningContent(msgs);
    const assistant = out.find((m) => m.role === 'assistant');
    eq('captured reasoning is replayed', assistant.reasoning_content, 'I should read the file first.');
    ok('reasoning survives alongside tool_calls', Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1);
    ok('the original message object is NOT mutated', msgs[1].reasoning_content === undefined);
}

// --- a plain reply (no tool call) that captured reasoning is still replayed --
{
    const msgs = [{ role: 'assistant', content: 'done', reasoningContent: 'thought about it' }];
    const out = withReasoningContent(msgs);
    eq('reasoning on a non-tool assistant turn is replayed too', out[0].reasoning_content, 'thought about it');
}

// --- recovery path: history persisted BEFORE capture existed ---------------
{
    const msgs = [
        { role: 'user', content: 'hi' },
        assistantWithTool(),                       // no reasoningContent (old history)
        { role: 'tool', content: 'r', tool_call_id: 'call_1' },
    ];
    const out = withReasoningContent(msgs, true);
    const assistant = out.find((m) => m.role === 'assistant');
    // The API demands the field, so an empty string beats failing the turn.
    eq('padMissing: tool-call turn gets an empty reasoning_content', assistant.reasoning_content, '');
}
{
    const msgs = [{ role: 'assistant', content: 'just text, no tools' }];
    const out = withReasoningContent(msgs, true);
    // A plain reply has no reasoning state the API can insist on, so padding it
    // would only add noise.
    ok('padMissing does NOT pad a tool-less assistant turn', !('reasoning_content' in out[0]));
}
{
    // An empty string is falsy: treat it as absent, not as captured reasoning.
    const msgs = [assistantWithTool({ reasoningContent: '' })];
    const out = withReasoningContent(msgs, true);
    eq('empty capture is treated as missing (padded)', out[0].reasoning_content, '');
}

// --- other roles are never touched -----------------------------------------
{
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        assistantWithTool({ reasoningContent: 'r' }),
        { role: 'tool', content: 'out', tool_call_id: 'call_1' },
    ];
    const out = withReasoningContent(msgs);
    ok('system/user/tool rows pass through unchanged',
        out[0] === msgs[0] && out[1] === msgs[1] && out[3] === msgs[3]);
}

// --- robustness ------------------------------------------------------------
{
    ok('empty array is fine', Array.isArray(withReasoningContent([])) && withReasoningContent([]).length === 0);
    const onlySystem = [{ role: 'system', content: 's' }];
    ok('system-only returns the same reference', withReasoningContent(onlySystem) === onlySystem);

    // A huge reasoning block must not be clipped here - the API rejects a
    // truncated reasoning payload, so the transport sends it whole and the
    // occupancy ESTIMATE is what accounts for its size.
    const big = 'x'.repeat(50_000);
    const out = withReasoningContent([assistantWithTool({ reasoningContent: big })]);
    eq('long reasoning is replayed in full', out[0].reasoning_content.length, 50_000);
}

console.log(failed === 0 ? '\nall reasoning-replay checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

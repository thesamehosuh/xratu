#!/usr/bin/env node
/**
 * Local-agent compaction + overflow-recovery tests.
 *
 * Covers the Cline-inspired hardening of src/local/localAgent.ts:
 *  - CONTEXT_OVERFLOW_RE recognizes the real overflow wording of Ollama,
 *    LM Studio, llama.cpp, vLLM and OpenAI-compatible servers, and does NOT
 *    match unrelated request failures.
 *  - compactMessages drops whole turns at user-message boundaries, never
 *    splitting an assistant tool_calls message from its tool results.
 *  - serializeForSummary hard-caps tool results (the summarizer runs on the
 *    same small local window - one huge tool output must not overflow it).
 *  - boundHistory drops whole turns at user-message boundaries.
 *  - summaryMaxTokens is window-derived with floor/ceiling.
 *  - Forced (server-confirmed overflow) recovery trims even when the
 *    proactive ratio gate / target would refuse, on any real window.
 *  - summaryInputCharBudget bounds the summarizer's input by the window.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-compaction.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    CONTEXT_OVERFLOW_RE,
    compactMessages,
    serializeForSummary,
    boundHistory,
    summaryMaxTokens,
    summaryInputCharBudget,
    clippedConversationForSummary,
    estimateMessageTokens,
    estimateRunTokens,
    estimateToolTokens,
    clipForSummary,
    boundToolResults,
    HISTORY_TRUNCATION_MARKER,
} = require('../out/local/localAgent.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);
const checkFalse = (name, actual) => check(name, !!actual, false);

// --- CONTEXT_OVERFLOW_RE: real provider wording (regression: any of these
// used to hard-fail the whole turn with no retry) ---
checkTrue('ollama wording', CONTEXT_OVERFLOW_RE.test('input length exceeds context length. please decrease input length or increase context length'));
checkTrue('llama.cpp wording', CONTEXT_OVERFLOW_RE.test('the request exceeds the available context size. Try increasing the context size'));
checkTrue('vllm wording', CONTEXT_OVERFLOW_RE.test("This model's maximum context length is 8192 tokens. However, you requested 9000 tokens"));
checkTrue('lm studio wording', CONTEXT_OVERFLOW_RE.test('Prompt is too long. Please shorten your prompt'));
checkTrue('openai wording', CONTEXT_OVERFLOW_RE.test("This model's maximum context length is 4097 tokens. However, you requested 5000 tokens. Please reduce the length of the messages"));
checkTrue('generic context window', CONTEXT_OVERFLOW_RE.test('Request failed: prompt exceeds the context window of the model'));
checkTrue('too many input tokens', CONTEXT_OVERFLOW_RE.test('400: too many input tokens'));

// --- CONTEXT_OVERFLOW_RE: unrelated failures must NOT trigger recovery ---
checkFalse('image encoding error', CONTEXT_OVERFLOW_RE.test("'url' field must be a base64 encoded image"));
checkFalse('connection refused', CONTEXT_OVERFLOW_RE.test('connect ECONNREFUSED 127.0.0.1:11434'));
checkFalse('model not found', CONTEXT_OVERFLOW_RE.test('model "foo" not found, try pulling it first'));
checkFalse('stream stalled', CONTEXT_OVERFLOW_RE.test('Model stream stalled (no data for 120s).'));
checkFalse('bad json', CONTEXT_OVERFLOW_RE.test('Unexpected token < in JSON at position 0'));

// --- compactMessages: drops whole turns, lands on user boundaries ---
const BIG = 'x'.repeat(9000); // ~3000 estimated tokens per message
function pairTurn(prefix, size) {
    return [
        { role: 'user', content: `${prefix} ${'u'.repeat(size)}` },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `id-${prefix}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: `id-${prefix}`, content: `${prefix} ${'t'.repeat(size)}` },
    ];
}
function overflowMessages() {
    return [
        { role: 'system', content: 'sys' },
        ...pairTurn('t1', 3000),
        ...pairTurn('t2', 3000),
        { role: 'user', content: BIG },
        { role: 'assistant', content: BIG },
    ];
}

const window8192 = 8192;
const msgs = overflowMessages();
const before = estimateRunTokens(msgs);
check('fixture actually overflows 90% of 8192', before >= window8192 * 0.9, true);
const dropped = compactMessages(msgs, window8192, undefined, 0);
check('compaction dropped something', dropped.length > 0, true);
check('truncation marker inserted at index 1', msgs[1].role === 'user' && msgs[1].content === HISTORY_TRUNCATION_MARKER, true);
check('system message untouched at index 0', msgs[0].role === 'system', true);

// Tool-pair integrity: every kept assistant tool_calls message must be
// followed (before the next user message) by its matching tool results -
// and no kept tool result may be orphaned from its assistant tool call.
const retainedCallIds = new Set();
for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) retainedCallIds.add(c.id);
    }
}
let pairsIntact = true;
for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const expected = new Set(m.tool_calls.map((c) => c.id));
        for (let j = i + 1; j < msgs.length && msgs[j].role === 'tool'; j++) {
            expected.delete(msgs[j].tool_call_id);
        }
        if (expected.size !== 0) pairsIntact = false;
    }
    if (m.role === 'tool' && !retainedCallIds.has(m.tool_call_id)) pairsIntact = false;
}
check('no orphaned tool results after compaction', pairsIntact, true);

// --- compactMessages guards ---
check('window below 4096 never compacts', compactMessages(overflowMessages(), 2048, undefined, 0).length, 0);
check('short history never compacts', compactMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: BIG },
    { role: 'assistant', content: BIG },
], 8192, undefined, 0).length, 0);
check('occupancy under ratio never compacts', compactMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'more' },
], 8192, 100, 0).length, 0);

// Tool-schema overhead participates in the occupancy: a history under the
// trigger on its own (~6000 estimated tokens vs 7372 = 90% of 8192) must
// still be trimmed once the (large) schemas are counted.
const underRatio = [
    { role: 'system', content: 'sys' },
    ...pairTurn('t1', 3000), // ~1000 tokens per message
    ...pairTurn('t2', 3000),
];
check('under-ratio history does not compact without schemas', compactMessages(structuredClone(underRatio), 8192, undefined, 0).length, 0);
check('tool schemas counted in occupancy', compactMessages(structuredClone(underRatio), 8192, undefined, 3400).length > 0, true);

// --- forced recovery mode: the server CONFIRMED overflow, so the estimate
// (and its ratio gate) is exactly what failed - recovery must trim anyway.
// Regression: the recovery path used to reuse the proactive gate and could
// return no dropped turns, rethrowing the recognized overflow. ---
const forcedDropped = compactMessages(structuredClone(underRatio), 8192, undefined, 0, true);
check('forced recovery trims under-ratio history', forcedDropped.length, 3);
check('forced 2k window compacts', compactMessages(overflowMessages(), 2048, undefined, 0, true).length, 6);

// A first old turn larger than the room that must be freed: proactive
// compaction declines to over-drop past the target (unchanged), but forced
// recovery still removes at least one complete turn.
// Fixture: ~7042 message tokens + 600 schema tokens ≈ 7642 ≥ 7372 (90% of
// 8192), while the first old turn (~4042) alone would land at ~3600 < 4915
// (target) - so the proactive loop breaks before removing anything.
const oversizedFirst = [
    { role: 'system', content: 'sys' },
    ...pairTurn('t1', 6000),
    { role: 'user', content: BIG },
];
checkTrue('oversized-first fixture triggers proactive gate', estimateRunTokens(oversizedFirst) + 600 >= 8192 * 0.9);
check('proactive compaction does not over-drop past target', compactMessages(structuredClone(oversizedFirst), 8192, undefined, 600).length, 0);
const oversizedForcedMsgs = structuredClone(oversizedFirst);
const oversizedForcedDropped = compactMessages(oversizedForcedMsgs, 8192, undefined, 600, true);
check('forced recovery removes oversized first group', oversizedForcedDropped.length, 3);
check('forced recovery inserts marker', oversizedForcedMsgs[1].role === 'user' && oversizedForcedMsgs[1].content === HISTORY_TRUNCATION_MARKER, true);
check('forced recovery leaves no orphaned tool results', oversizedForcedMsgs.some((m) => m.role === 'tool'), false);

// --- serializeForSummary: tool results hard-capped for the summarizer ---
const hugeTool = 'z'.repeat(50_000);
const serialized = serializeForSummary([
    { role: 'user', content: 'Question about the file' },
    { role: 'tool', tool_call_id: 'id-1', content: hugeTool },
    { role: 'assistant', content: 'Answer' },
]);
const toolLine = serialized.split('\n\n').find((l) => l.startsWith('Tool result'));
check('tool result line present', !!toolLine, true);
checkTrue('tool result capped at ~2000 chars', toolLine.length <= 2100);
checkTrue('tool result clipped with marker', toolLine.includes('[...clipped...]'));
checkTrue('user text preserved in full', serialized.includes('Question about the file'));
checkTrue('assistant text preserved in full', serialized.includes('Answer'));

// --- boundHistory: coarse pre-trim drops whole turns at user boundaries ---
const turn = () => [{ role: 'user', content: 'u'.repeat(3000) }, { role: 'assistant', content: 'a'.repeat(3000) }]; // ~2x1000 tokens
const history4 = [...turn(), ...turn(), ...turn(), ...turn()]; // ~8000 tokens
const boundedNoSystem = boundHistory(history4, 8192, 0);
checkTrue('boundHistory trims oversized history', boundedNoSystem.length < history4.length);
checkTrue('cuts land on user boundaries', boundedNoSystem.length === 0 || boundedNoSystem[0].role === 'user');

// --- summaryMaxTokens: window-derived, floored, capped ---
check('summaryMaxTokens 8k window', summaryMaxTokens(8192), 1228);
check('summaryMaxTokens huge window capped', summaryMaxTokens(1_000_000), 2048);
check('summaryMaxTokens tiny window floored', summaryMaxTokens(2048), 512);
check('summaryMaxTokens null window default', summaryMaxTokens(null), 2048);
check('summaryMaxTokens undefined default', summaryMaxTokens(undefined), 2048);

// --- summaryInputCharBudget: the summarizer rides on the SAME window, so
// its serialized input must shrink with it (regression: the fixed 60k-char
// cap alone cannot fit a 4k model and the summary request overflows,
// degrading compaction to the bare marker) ---
const budget8k = summaryInputCharBudget(3, 8192);
check('budget 8k window', budget8k, 20124);
checkTrue('budget 8k input + output + margin fits window', budget8k / 3 + summaryMaxTokens(8192) + 256 <= 8192);
const budget4k = summaryInputCharBudget(1, 4096);
check('budget 4k window', budget4k, 9678);
checkTrue('budget 4k input + output + margin fits window', budget4k / 3 + summaryMaxTokens(4096) + 256 <= 4096);
check('budget huge window capped at 60k chars', summaryInputCharBudget(1, 1_000_000), 60_000);
check('budget unknown window falls back to 60k chars', summaryInputCharBudget(2, null), 60_000);
check('budget no dropped turns is zero', summaryInputCharBudget(0, 8192), 0);
check('budget oversized overhead collapses to zero', summaryInputCharBudget(1, 2048, 100_000), 0);

// --- clippedConversationForSummary: per-line clipping keeps every turn's
// head+tail, then the aggregate is capped to the budget - the 400-char
// per-line floor must not let many small turns overflow the window together.
const manyTurns = ['a', 'b', 'c', 'd'].map((p) => ([
    { role: 'user', content: p.repeat(1200) },
    { role: 'assistant', content: p.repeat(1200) },
])).flat();
const aggregate = clippedConversationForSummary(manyTurns, 1000, 400);
checkTrue('aggregate conversation capped to budget', aggregate.length <= 1000);
checkTrue('aggregate cap uses middle clip', aggregate.includes('[...clipped...]'));
checkTrue('tiny aggregate budget enforced exactly', clippedConversationForSummary(manyTurns, 3, 400).length <= 3);
checkTrue('small aggregate budget enforced exactly', clippedConversationForSummary(manyTurns, 100, 400).length <= 100);
const smallTalk = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
];
check('small conversation under budget untouched', clippedConversationForSummary(smallTalk, 60_000, 400), 'User: hello\n\nAssistant: hi');

// --- estimator sanity ---
check('estimateMessageTokens chars/3', estimateMessageTokens({ role: 'user', content: 'a'.repeat(30) }), 10);
check('estimateRunTokens sums', estimateRunTokens([
    { role: 'user', content: 'a'.repeat(30) },
    { role: 'assistant', content: 'b'.repeat(30) },
]), 20);
check('estimateToolTokens counts schemas', estimateToolTokens([
    { name: 't', description: 'd'.repeat(60), inputSchema: { type: 'object' } },
]) > 0, true);

// --- clipForSummary: middle clip (allowance > 200) keeps head+tail ---
const clipped = clipForSummary('A'.repeat(1000), 300);
checkTrue('middle clip keeps head', clipped.startsWith('A'));
checkTrue('middle clip keeps tail', clipped.endsWith('A'));
checkTrue('middle clip marked', clipped.includes('[...clipped...]'));
checkTrue('small allowance falls back to head clip', clipForSummary('B'.repeat(1000), 100) === 'B'.repeat(100) + '...');
checkTrue('short text untouched', clipForSummary('short', 100) === 'short');

// --- boundToolResults: a single huge tool result must be clipped to a
// --- window-relative budget, since compactMessages cannot touch the current
// --- turn (regression: one 200k-char terminal result overflowed an 8k window
// --- and forced recovery had nothing left to drop).
{
    const huge = 'x'.repeat(200_000);
    const msgs = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: huge },
    ];
    const changed = boundToolResults(msgs, 8192, 0);
    checkTrue('huge result clipped', changed);
    // perResultCap = floor(8192*3*0.4) = 9830 chars
    checkTrue('result within per-result cap', msgs[3].content.length <= 9830 + 40);
    checkTrue('clip is marked', msgs[3].content.includes('[...clipped...]'));
    checkTrue('clip keeps head', msgs[3].content.startsWith('x'));
    checkTrue('clip keeps tail', msgs[3].content.endsWith('x'));
    // Non-tool history is never touched.
    check('history untouched', msgs[1].content, 'run it');
}

// --- No-op when everything fits; false + identical content ---
{
    const msgs = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' },
        { role: 'tool', tool_call_id: 'c1', content: 'small output' },
    ];
    const changed = boundToolResults(msgs, 8192, 0);
    check('small result not clipped (no change)', changed, false);
    check('small result content intact', msgs[2].content, 'small output');
}

// --- Total budget: many results are trimmed, oldest first, and the aggregate
// --- is ALWAYS enforced (pass 3 omits when the floor cannot fit).
{
    const mk = (i) => ({ role: 'tool', tool_call_id: `c${i}`, content: String(i).repeat(6000) });
    const msgs = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '' },
        mk(0), mk(1), mk(2), mk(3),
    ];
    boundToolResults(msgs, 4096, 0);
    // totalBudget = floor(4096*3*0.5) = 6144 chars.
    const total = msgs.slice(2).reduce((n, m) => n + m.content.length, 0);
    checkTrue('total under budget', total <= 6144);
    // Newest result is preserved longer than the oldest.
    checkTrue('oldest clipped at least as much as newest', msgs[2].content.length <= msgs[5].content.length);
}

// --- Floor-defeating case: many results in a tiny window are still bounded ---
{
    const msgs = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 20; i++) msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'z'.repeat(5000) });
    boundToolResults(msgs, 1024, 0);
    const total = msgs.slice(1).reduce((n, m) => n + m.content.length, 0);
    // totalBudget = floor(1024*3*0.5) = 1536 chars.
    checkTrue('many results still bounded', total <= 1536);
}

// --- Schema-heavy window: tool-schema tokens shrink the result budget ---
{
    const msgs = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 4; i++) msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'q'.repeat(6000) });
    boundToolResults(msgs, 4096, 1000);
    const total = msgs.slice(1).reduce((n, m) => n + m.content.length, 0);
    // totalBudget = 6144 - 1000*3 = 3144 chars.
    checkTrue('schema tokens reduce the budget', total <= 3144);
}

// --- Steering: a tool result pushed behind a later user message is still
// --- bounded (it is not "before the last user message").
{
    const msgs = [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: '' },
        { role: 'tool', tool_call_id: 'c1', content: 'BIG'.repeat(50_000) },
        { role: 'user', content: 'steer' },
        { role: 'assistant', content: '' },
    ];
    boundToolResults(msgs, 4096, 0);
    checkTrue('pre-steer tool result bounded', msgs[2].content.length <= 6144);
}

// --- Tiny windows are left alone (guard) ---
{
    const msgs = [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'c', content: 'y'.repeat(50_000) }];
    check('sub-1k window is a no-op', boundToolResults(msgs, 512, 0), false);
}

console.log(failed === 0 ? '\ncompaction tests: all passed' : `\ncompaction tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

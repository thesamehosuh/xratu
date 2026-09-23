#!/usr/bin/env node
/**
 * End-to-end compaction tests: drive the REAL `runLocalAgent` loop on a mocked
 * transport and assert the compaction contract the host depends on.
 *
 * Covers, against the shipping code rather than a reimplementation:
 *  - proactive compaction fires and emits `compactionSummary` with a
 *    CUMULATIVE `droppedUserTurns` count;
 *  - the summarizer prompt contains the dropped turns but NOT the history
 *    truncation marker (the marker carries the rolling summary, which the
 *    caller passes separately - feeding it back duplicates it);
 *  - the summarizer's output budget is the window-derived value (capped), so a
 *    reasoning model still has headroom to emit text;
 *  - the truncation marker in the run carries the summary;
 *  - the host's replay boundary (`skipLeadingUserTurns` by the reported count)
 *    keeps the compacted turns out of the NEXT turn's request, so they are not
 *    re-sent or re-summarized.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-compaction-e2e.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    runLocalAgent,
    isHistoryTruncationMarker,
    summaryMaxTokens,
} = require('../out/local/localAgent.js');
const { skipLeadingUserTurns } = require('../out/local/historyBounds.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
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
const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });

const SUMMARY_TEXT = '## Goal\nprobe goal\n## State\n- Done: x\n## Highlights\n- none\n## Next\n- none\n## Files\n- none';
const SYSTEM_PROMPT = 'You are Xratu, a coding agent. ' + 'S'.repeat(18000 - 31);

/** A history big enough to trip proactive compaction (history under the 72%
 *  ceiling budget; the large system prompt is what pushes the ASSEMBLED
 *  request past the 90% trigger). */
const TURNS = 3;
const RESULT_CHARS = 9000;
const WINDOW = 16384;
function makeHistory(turns = TURNS) {
    const rows = [];
    for (let i = 0; i < turns; i++) {
        rows.push(
            { role: 'user', content: `turn ${i} please investigate` },
            { role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: `c${i}`, content: `UNIQUE_RESULT_${i} ` + 'R'.repeat(RESULT_CHARS) },
        );
    }
    return rows;
}

function mockFetch(requests, summarizerMode = 'ok', mainUsage = null) {
    let summaryCalls = 0;
    return async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        requests.push({ url, ...body });
        const budget = body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens;
        if (budget === summaryMaxTokens(WINDOW)) {
            summaryCalls++;
            if (summarizerMode === 'fail' || (summarizerMode === 'fail-first' && summaryCalls === 1)) {
                return { ok: false, status: 500, json: async () => ({}), text: async () => 'upstream failed' };
            }
            if (summarizerMode === 'empty') {
                return jsonResponse({ choices: [{ message: { content: '   ' } }] });
            }
            if (summarizerMode === 'temperature-400' && body.temperature !== undefined) {
                return {
                    ok: false,
                    status: 400,
                    json: async () => ({}),
                    text: async () => "Unsupported parameter: 'temperature' is not supported with this model.",
                };
            }
            // Summarizer: answer in the shape of the endpoint it hit.
            if (url.endsWith('/messages')) {
                return jsonResponse({ content: [{ type: 'text', text: SUMMARY_TEXT }] });
            }
            if (url.endsWith('/responses')) {
                return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: SUMMARY_TEXT }] }] });
            }
            if (url.includes(':generateContent')) {
                return jsonResponse({ candidates: [{ content: { parts: [{ text: SUMMARY_TEXT }] } }] });
            }
            return jsonResponse({ choices: [{ message: { content: SUMMARY_TEXT } }] });
        }
        // Main request: answer in the shape of the endpoint it hit.
        if (url.endsWith('/responses')) {
            return sse([
                frame({ type: 'response.output_text.delta', delta: 'final answer' }),
                frame({
                    type: 'response.completed',
                    response: {
                        usage: { input_tokens: 100, output_tokens: 5 },
                        output: [{ type: 'message', content: [{ type: 'output_text', text: 'final answer' }] }],
                    },
                }),
            ]);
        }
        const chatFrames = [frame({ choices: [{ delta: { content: 'final answer' } }] })];
        if (mainUsage) chatFrames.push(frame({ usage: mainUsage }));
        chatFrames.push('data: [DONE]\n\n');
        return sse(chatFrames);
    };
}

async function drive(history, sessionSummary, { ratio = 0.9, systemPrompt = SYSTEM_PROMPT, apiStyle = 'chat', summarizerMode = 'ok', mainUsage = null } = {}) {
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch(requests, summarizerMode, mainUsage);
    const events = [];
    try {
        for await (const event of runLocalAgent(
            {
                baseUrl: 'https://example.invalid/v1',
                apiKey: 'k',
                model: 'test-model',
                systemPrompt,
                userText: 'now do it',
                history,
                tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' }, requiresApproval: false }],
                maxRounds: 3,
                contextWindow: WINDOW,
                apiStyle,
                autoCompactRatio: ratio,
                ...(sessionSummary ? { sessionSummary } : {}),
            },
            { execute: async () => ({ output: 'ok' }) },
            { requestApproval: async () => ({}) },
        )) {
            events.push(event);
        }
    } finally {
        globalThis.fetch = original;
    }
    return { events, requests };
}

// ---------------------------------------------------------------------------
// Turn 1: proactive compaction.
// ---------------------------------------------------------------------------
const history = makeHistory();
const turn1 = await drive(history, null);
const compaction = turn1.events.find((e) => e.type === 'compactionSummary');
ok('proactive compaction fires', !!compaction);
ok('it reports a positive cumulative dropped count',
    !!compaction && compaction.droppedUserTurns >= 1, `dropped=${compaction?.droppedUserTurns}`);
ok('the summary is non-empty', !!compaction && compaction.value.includes('probe goal'));

const summarizerCalls = turn1.requests.filter((r) => r.stream === false);
ok('exactly one summarizer call', summarizerCalls.length === 1, `got ${summarizerCalls.length}`);
{
    const prompt = summarizerCalls[0]?.messages?.[0]?.content ?? '';
    ok('summarizer input contains the dropped turns',
        prompt.includes('UNIQUE_RESULT_0') || prompt.includes('UNIQUE_RESULT_1'));
    ok('summarizer input does NOT contain the truncation marker',
        !prompt.includes('Earlier messages in this conversation were removed'));
    ok('summarizer output budget is window-derived',
        summarizerCalls[0]?.max_tokens === summaryMaxTokens(WINDOW),
        `got ${summarizerCalls[0]?.max_tokens}, want ${summaryMaxTokens(WINDOW)}`);
    ok('summarizer runs non-streaming at low temperature',
        summarizerCalls[0]?.stream === false && summarizerCalls[0]?.temperature === 0.2);
}
{
    const main = turn1.requests.find((r) => r.stream !== false);
    const marker = main?.messages?.[1];
    ok('the run history carries the truncation marker at index 1',
        !!marker && isHistoryTruncationMarker(marker));
    ok('the marker carries the summary', !!marker && String(marker.content).includes('probe goal'));
}

// ---------------------------------------------------------------------------
// Turn 2: the host's replay boundary keeps compacted turns out of the request.
// ---------------------------------------------------------------------------
const dropped = compaction.droppedUserTurns;
const replayed = skipLeadingUserTurns(history, dropped);
const turn2 = await drive(replayed, compaction.value);
{
    const main = turn2.requests.find((r) => r.stream !== false);
    const flat = JSON.stringify(main?.messages ?? []);
    const droppedTurnText = Array.from({ length: dropped }, (_, i) => `turn ${i} please investigate`);
    ok('compacted turns are NOT re-sent on the next turn',
        droppedTurnText.every((text) => !flat.includes(text)),
        `dropped=${dropped}`);
    ok('the retained turn IS sent',
        flat.includes(`turn ${TURNS - 1} please investigate`));

    // The turns were already summarized, so they must not be re-summarized.
    const t2Summarizers = turn2.requests.filter((r) => r.stream === false);
    const t2SummarizerText = t2Summarizers.map((r) => r.messages?.[0]?.content ?? '').join('\n');
    ok('already-compacted turns are not re-summarized',
        !droppedTurnText.some((text) => t2SummarizerText.includes(text)));
}

// ---------------------------------------------------------------------------
// The 72% hard ceiling is SUMMARIZED, not a silent mechanical trim.
// Regression: `boundHistory` ran BEFORE the summarizer, so turns it ate were
// lost permanently (the summary could not cover what was already gone). Raise
// the user threshold out of the way (0.99) so ONLY the ceiling can fire - and
// it must still summarize.
// ---------------------------------------------------------------------------
{
    const bandHistory = makeHistory(5);
    const band = await drive(bandHistory, null, {
        ratio: 0.99,
        systemPrompt: 'You are Xratu, a coding agent.',
    });
    const comp = band.events.find((e) => e.type === 'compactionSummary');
    ok('the 72% ceiling fires when the user threshold does not', !!comp);
    ok('the ceiling pass SUMMARIZES (no silent drop)', band.requests.some((r) => r.stream === false));
    const prompt = band.requests.filter((r) => r.stream === false).map((r) => r.messages?.[0]?.content ?? '').join('\n');
    ok('ceiling-dropped turns reached the summarizer',
        prompt.includes('UNIQUE_RESULT_0') || prompt.includes('UNIQUE_RESULT_1'));
    ok('the ceiling summary is carried into the run marker', !!comp && comp.value.includes('probe goal'));
    ok('the ceiling reports a dropped count', !!comp && comp.droppedUserTurns >= 1);
}

// ---------------------------------------------------------------------------
// The summarizer follows the RESOLVED wire API.
// Regression: it hardcoded /chat/completions. OpenCode Go rejects that for
// responses-style models (grok/gpt return 503) and /messages rejects them too,
// so compaction silently degraded to the bare marker on those models.
// ---------------------------------------------------------------------------
{
    const r = await drive(makeHistory(), null, { apiStyle: 'responses' });
    const comp = r.events.find((e) => e.type === 'compactionSummary');
    ok('responses-style: compaction fires', !!comp);
    const summarizer = r.requests.find((q) => q.url.endsWith('/responses')
        && (q.max_output_tokens ?? q.max_tokens) === summaryMaxTokens(WINDOW));
    ok('summarizer used the /responses endpoint', !!summarizer, r.requests.map((q) => q.url).join(', '));
    ok('summarizer sent the Responses body (string input + max_output_tokens)',
        !!summarizer && typeof summarizer.input === 'string'
        && summarizer.max_output_tokens === summaryMaxTokens(WINDOW));
    ok('summary extracted from the Responses output shape',
        !!comp && comp.value.includes('probe goal'));
}

// ---------------------------------------------------------------------------
// A FAILED summarizer must not COMMIT an unsummarized drop.
// Regression: `compactMessages` dropped the turns as a side effect before the
// summarizer ran, so a timeout / provider error / empty reply left the run with
// turns that were neither summarized nor replayed, plus a stale marker. The
// drop is now reverted; sizing falls to the deterministic `boundHistory`
// fallback, and because NO event is emitted the host keeps replaying the turns
// next turn (no PERMANENT loss).
// ---------------------------------------------------------------------------
for (const mode of ['fail', 'empty']) {
    const r = await drive(makeHistory(), null, { summarizerMode: mode });
    ok(`${mode} summarizer: no compaction event (host keeps replaying)`,
        !r.events.some((e) => e.type === 'compactionSummary'));
    const mainReq = r.requests[r.requests.length - 1];
    ok(`${mode} summarizer: no unsummarized truncation marker is committed`,
        !!mainReq?.messages && !isHistoryTruncationMarker(mainReq.messages[1]),
        JSON.stringify(mainReq?.messages?.[1]?.content ?? '').slice(0, 80));
    ok(`${mode} summarizer: run still completed`, r.events.some((e) => e.type === 'assistantMessage'));
}

// ---------------------------------------------------------------------------
// Unsummarized drops FREEZE the reported replay count.
// A summarized drop after an unsummarized one is not a prefix, so a suffix
// count cannot represent it. Reporting it would make the host skip turns no
// summary covers (permanent loss); freezing replays them instead (a safe
// duplicate). Here the pre-request summarizer fails (mechanical fallback drops
// unsummarized) and a later mid-run compaction succeeds - its report must stay
// at 0, not count the fallback's drops.
// ---------------------------------------------------------------------------
{
    const r = await drive(makeHistory(10), null, {
        summarizerMode: 'fail-first',
        mainUsage: { prompt_tokens: WINDOW, completion_tokens: 10 },
    });
    const comp = r.events.find((e) => e.type === 'compactionSummary');
    ok('freeze: a later summarized compaction still fires', !!comp);
    ok('freeze: unsummarized drops are NOT reported', !!comp && comp.droppedUserTurns === 0,
        `dropped=${comp?.droppedUserTurns}`);
}

// ---------------------------------------------------------------------------
// A temperature-rejecting reasoning model must not break compaction.
// gpt-5 on /responses returns 400 "Unsupported parameter: 'temperature'"; the
// summarizer drops it and retries once instead of degrading to a bare marker.
// ---------------------------------------------------------------------------
{
    const r = await drive(makeHistory(), null, { summarizerMode: 'temperature-400' });
    const comp = r.events.find((e) => e.type === 'compactionSummary');
    ok('temperature-400: compaction still fires', !!comp);
    const summarizers = r.requests.filter((q) => (q.max_tokens ?? q.max_output_tokens) === summaryMaxTokens(WINDOW));
    ok('temperature-400: retried once', summarizers.length === 2, `calls=${summarizers.length}`);
    ok('temperature-400: the retry dropped temperature', summarizers[1] && summarizers[1].temperature === undefined);
    ok('temperature-400: summary extracted after the retry', !!comp && comp.value.includes('probe goal'));
}

if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
}
console.log('\nall compaction-e2e checks passed');

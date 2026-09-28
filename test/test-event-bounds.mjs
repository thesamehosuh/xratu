#!/usr/bin/env node
/**
 * Run-lifetime event ledger bounds for src/local/eventBounds.ts.
 *
 * Covers the caps that keep `outcome.events` (the host's per-RUN display
 * ledger) from growing with raw payloads until the turn ends:
 *  - trimDisplayEvent clips tool_call args / tool results for the transcript,
 *    exempts update_task_list (the checklist re-parses its args), and strips
 *    provider carriers from display rows.
 *  - boundOutcomeEvents bounds the LIVE array in place: thinking blocks to
 *    MAX_CONTENT_CAP, tool outputs under an aggregate budget (oldest first,
 *    byte-identical to trimDisplayEvent), carriers under CARRIER_BUDGET.
 *  - the array reference survives (it is shared with the pending-turn
 *    snapshot) and every pass is idempotent.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-event-bounds.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    DISPLAY_ARG_LIMIT,
    DISPLAY_PATCH_ARG_LIMIT,
    DISPLAY_OUTPUT_LIMIT,
    EVENT_OUTPUT_BUDGET,
    boundOutcomeEvents,
    trimDisplayEvent,
} = require('../out/local/eventBounds.js');
const { MAX_CONTENT_CAP, CARRIER_BUDGET, clipHistoryContent } = require('../out/local/historyBounds.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkTrue = (name, actual) => check(name, !!actual, true);
const checkFalse = (name, actual) => check(name, !!actual, false);
const clipMarker = (text) => text.includes('[...clipped');

// --- trimDisplayEvent: the transcript clip, single source of truth ---------
{
    const small = trimDisplayEvent({ type: 'tool_call', id: 'a', tool: 'write_file', args: { path: 'x.ts' } });
    check('small args pass through untouched', small.args.path, 'x.ts');

    const big = trimDisplayEvent({
        type: 'tool_call', id: 'b', tool: 'write_file',
        args: { path: 'x.ts', new_content: 'y'.repeat(DISPLAY_PATCH_ARG_LIMIT + 100), other: 'z'.repeat(DISPLAY_ARG_LIMIT + 50) },
    });
    check('new_content clips to the PATCH limit', big.args.new_content.length <= DISPLAY_PATCH_ARG_LIMIT + 64, true);
    checkTrue('new_content carries the truncation marker', big.args.new_content.includes('chars truncated'));
    checkTrue('non-patch string leaf clips to the plain limit', big.args.other.length <= DISPLAY_ARG_LIMIT + 64);

    const strArgs = trimDisplayEvent({ type: 'tool_call', id: 'c', tool: 'run_terminal_command', args: 'x'.repeat(DISPLAY_ARG_LIMIT + 10) });
    checkTrue('string args clip to the plain limit', strArgs.args.length <= DISPLAY_ARG_LIMIT + 64);

    const task = 'y'.repeat(5000);
    const taskList = trimDisplayEvent({ type: 'tool_call', id: 'd', tool: 'update_task_list', args: { tasks: task } });
    check('update_task_list args stay whole (checklist re-parses them)', taskList.args.tasks, task);

    const out = trimDisplayEvent({ type: 'tool_result', id: 'e', tool: 'read_file', output: 'o'.repeat(DISPLAY_OUTPUT_LIMIT + 500) });
    check('tool_result output clips to the display limit', out.output.length <= DISPLAY_OUTPUT_LIMIT + 64, true);

    const carrier = trimDisplayEvent({ type: 'assistant_message', content: 'hi', providerBlocks: [{ type: 'text', text: 't' }] });
    check('carriers are stripped from display rows', 'providerBlocks' in carrier, false);
    check('display row content survives', carrier.content, 'hi');
}

// --- boundOutcomeEvents: under budget, nothing changes ----------------------
{
    const events = [
        { type: 'thinking', content: 'r'.repeat(1000) },
        { type: 'assistant_message', content: 'text', tool_calls: [{ id: 'x' }] },
        { type: 'tool_result', id: 'x', tool: 'read_file', output: 'o'.repeat(10_000) },
    ];
    const ref = events;
    checkFalse('under-budget ledger reports no change', boundOutcomeEvents(events));
    check('same array reference (pending-turn shares it)', events === ref, true);
    check('entries untouched', events[2].output.length, 10_000);
}

// --- boundOutcomeEvents: aggregate output budget, oldest first --------------
{
    const raw = (n) => 'o'.repeat(n);
    // 3 x 800k = 2.4M > 2M budget: the OLDEST shrinks first, the newest stays.
    const events = [
        { type: 'tool_result', id: 'a', tool: 'run_terminal_command', output: raw(800_000) },
        { type: 'tool_result', id: 'b', tool: 'run_terminal_command', output: raw(800_000) },
        { type: 'tool_result', id: 'c', tool: 'run_terminal_command', output: raw(800_000) },
    ];
    const ref = events;
    checkTrue('over-budget ledger reports a change', boundOutcomeEvents(events));
    check('same array reference after clipping', events === ref, true);
    check('oldest output re-clipped to display size', events[0].output.length <= DISPLAY_OUTPUT_LIMIT + 64, true);
    check('newest output left whole', events[2].output.length, 800_000);
    const total = events.reduce((n, e) => n + e.output.length, 0);
    checkTrue('aggregate now fits the budget', total <= EVENT_OUTPUT_BUDGET);
    check('pairing fields survive (ids/tools intact)', events.every((e, i) => e.id === 'abc'[i] && e.tool === 'run_terminal_command'), true);

    // Byte-identical to what the turn-end display transfer would produce.
    const viaTransfer = trimDisplayEvent({ type: 'tool_result', id: 'a', tool: 'run_terminal_command', output: raw(800_000) });
    check('clipped bytes match trimDisplayEvent exactly', events[0].output, viaTransfer.output);

    checkFalse('second pass is a no-op (idempotent)', boundOutcomeEvents(events));
}

// --- boundOutcomeEvents: thinking ceiling -----------------------------------
{
    const huge = 'x'.repeat(MAX_CONTENT_CAP + 50_000);
    const events = [{ type: 'thinking', content: huge }];
    checkTrue('oversized thinking block is clipped', boundOutcomeEvents(events));
    check('thinking fits the ceiling', events[0].content.length <= MAX_CONTENT_CAP, true);
    checkTrue('clipped thinking keeps both ends', clipMarker(events[0].content));
    checkFalse('second pass is a no-op (idempotent)', boundOutcomeEvents(events));

    const small = [{ type: 'thinking', content: 'y'.repeat(1000) }];
    checkFalse('small thinking block untouched', boundOutcomeEvents(small));
    check('small thinking content unchanged', small[0].content.length, 1000);
}

// --- boundOutcomeEvents: carrier budget, oldest dropped, rows kept ---------
{
    const carrier = (k) => ({ type: 'text', text: k });
    const bigCarrier = (n) => [{ type: 'text', text: 'x'.repeat(n) }];
    // 11 x ~190k = ~2.09M > 2M CARRIER_BUDGET, each individually under
    // MAX_CONTENT_CAP so they count rather than being dropped as oversized.
    const events = [];
    for (let i = 0; i < 11; i++) {
        events.push({ type: 'assistant_message', content: `step ${i}`, providerBlocks: bigCarrier(190_000) });
    }
    events.push({ type: 'tool_result', id: 'z', tool: 'read_file', output: 'ok' });
    const ref = events;
    checkTrue('over-budget carriers are bounded', boundOutcomeEvents(events));
    check('rows are never dropped - only carriers (same array)', events === ref, true);
    check('row count preserved', events.length, 12);
    check('newest carrier kept', Array.isArray(events[10].providerBlocks), true);
    check('oldest carrier dropped', events[0].providerBlocks, undefined);
    checkFalse('second pass is a no-op (idempotent)', boundOutcomeEvents(events));

    // An individually oversized carrier is dropped outright (cannot be
    // clipped - a truncated provider block is rejected by the API).
    const oversize = [{ type: 'assistant_message', content: 'a', providerBlocks: bigCarrier(MAX_CONTENT_CAP + 1) }];
    checkTrue('oversized carrier dropped at once', boundOutcomeEvents(oversize));
    check('row itself survives', oversize[0].content, 'a');
    check('oversized carrier removed', oversize[0].providerBlocks, undefined);
}

// --- thinking in the pending-turn snapshot (sanity of shared policy) --------
{
    // The sanitizer applies the SAME ceiling; assert the shared constant the
    // sanitizer imports so a drift in one direction is caught here too.
    const clipped = clipHistoryContent('z'.repeat(MAX_CONTENT_CAP + 10), MAX_CONTENT_CAP);
    check('shared ceiling clips to MAX_CONTENT_CAP', clipped.length <= MAX_CONTENT_CAP, true);
    check('carrier budget constant stays at 2MB', CARRIER_BUDGET, 2_000_000);
    check('output budget mirrors the carrier budget', EVENT_OUTPUT_BUDGET, CARRIER_BUDGET);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Bounds for the RUN-LIFETIME display event ledger (`outcome.events` in
 * extension.ts).
 *
 * The persisted snapshot is capped by `sanitizeSnapshot`, and the DISPLAY
 * transfer at turn end applies `trimDisplayEvent` - but the LIVE array between
 * a push and that transfer was not bounded at all: `tool_call` args rode at
 * full size (a whole written file), a reasoning block grew to the model's
 * full cumulative thinking, and a busy run accumulated tool outputs up to the
 * upstream clip for every call of the turn. One long run could therefore hold
 * tens of MB until it ended, and partial persists flushed the untrimmed
 * payloads to disk.
 *
 * Every clip here is lossless for its consumers:
 *  - `tool_call` args are display-only (the model ledger takes tool rows from
 *    `assistant_message.tool_calls`, which are bounded separately); the
 *    display transfer clips them to the SAME values, so trimming at push time
 *    produces a byte-identical transcript. `update_task_list` args are
 *    exempt everywhere (the checklist re-parses them from the events).
 *  - `thinking` events are display-only; the model's reasoning rides
 *    `reasoningContent` on the `assistant_message` (kept whole or dropped,
 *    never clipped).
 *  - Re-clipped old tool outputs under the aggregate budget match
 *    `trimDisplayEvent` byte-for-byte, so the final display ledger is
 *    unchanged; only the model ledger's copy of OLD rows from the CURRENT
 *    turn shrinks - and old tool detail is the first thing compaction and
 *    `elideOldToolResults` strip by design anyway.
 *
 * Dependency-free (no `vscode`), so it is unit-testable in plain node.
 */
import { TASK_LIST_TOOL_NAME } from '../taskList';
import {
    MAX_CONTENT_CAP,
    boundCarriers,
    clipHistoryContent,
    clipJsonValue,
    type CarrierRow,
} from './historyBounds';
import { TOOL_RESULT_ELISION_MARKER } from './localAgent';

/** Display-event payload caps - bounds what the host persists per event.
 *  Non-mutating: returns a clipped copy only when something was trimmed. */
export const DISPLAY_ARG_LIMIT = 300;
/** Edit-family payloads: the patch IS the rendered diff body on reload -
 *  a 300-char clip leaves a mangled partial block in the pill. */
export const DISPLAY_PATCH_KEYS = new Set(['patch', 'new_content']);
export const DISPLAY_PATCH_ARG_LIMIT = 6000;
export const DISPLAY_OUTPUT_LIMIT = 1500;

/** The tail `clipDisplay` appends - matched to detect an ALREADY-clipped
 *  value (see `clipDisplay`). */
const CLIP_DISPLAY_MARKER_RE = /\[\+\d+ chars truncated\]$/;

function clipDisplay(value: string, limit: number): string {
    if (value.length <= limit) return value;
    // Already clipped by an earlier pass: its marker sits INSIDE `limit`, so
    // re-clipping would slice the marker itself and rewrite the count. The
    // push -> transfer path (trimDisplayEvent twice) relies on this to be
    // byte-idempotent.
    if (CLIP_DISPLAY_MARKER_RE.test(value)) return value;
    return `${value.slice(0, limit)}… [+${value.length - limit} chars truncated]`;
}

/** Clip a display event for the transcript - the single source of truth for
 *  what the display ledger, the pending-turn snapshot and the webview keep of
 *  an event. Applied at push time AND at turn-end transfer (idempotent). */
export function trimDisplayEvent(event: any): any {
    // Provider-native replay carriers are MODEL-ledger data: they must never
    // reach the display ledger, the pending-turn snapshot, or the webview.
    if (event?.type === 'assistant_message' && (event.providerBlocks || event.reasoningContent)) {
        const { providerBlocks: _providerBlocks, reasoningContent: _reasoningContent, ...rest } = event;
        event = rest;
    }
    if (event?.type === 'thinking' && typeof event.content === 'string') {
        // Legacy sessions restore thinking from a pending snapshot that was
        // saved before the streaming clip existed - bound it here too.
        return event.content.length > MAX_CONTENT_CAP
            ? { ...event, content: clipHistoryContent(event.content, MAX_CONTENT_CAP) }
            : event;
    }
    if (event?.type === 'result' && typeof event.thinking === 'string'
        && event.thinking.length > MAX_CONTENT_CAP) {
        // The result event rides the LIVE path with the full cumulative value
        // (the completion re-post must stay byte-identical to what streamed);
        // the transcript copy is what gets bounded, at transfer.
        return { ...event, thinking: clipHistoryContent(event.thinking, MAX_CONTENT_CAP) };
    }
    if (event?.type === 'tool_call' && event.tool !== TASK_LIST_TOOL_NAME) {
        if (event.args && typeof event.args === 'object') {
            return {
                ...event,
                args: Object.fromEntries(
                    Object.entries(event.args).map(([k, v]) => {
                        const limit = DISPLAY_PATCH_KEYS.has(k) ? DISPLAY_PATCH_ARG_LIMIT : DISPLAY_ARG_LIMIT;
                        if (typeof v === 'string') return [k, clipDisplay(v, limit)];
                        // Nested objects/arrays: bound every string leaf to
                        // the same per-key limit - a top-level-only pass let a
                        // nested payload (a wrapped file body) bypass the cap.
                        if (v && typeof v === 'object') return [k, clipJsonValue(v, limit)];
                        return [k, v];
                    })
                ),
            };
        }
        if (typeof event.args === 'string') {
            return { ...event, args: clipDisplay(event.args, DISPLAY_ARG_LIMIT) };
        }
    } else if (event?.type === 'tool_result' && typeof event.output === 'string' && event.output.length > DISPLAY_OUTPUT_LIMIT) {
        return { ...event, output: clipDisplay(event.output, DISPLAY_OUTPUT_LIMIT) };
    }
    return event;
}

/**
 * Aggregate ceiling (chars) for tool-result payloads held in ONE run's event
 * ledger.
 *
 * Each output is bounded upstream (terminal 200k, expansion 120k, then the
 * 40k in-memory floor in `persistedEventFromAgentEvent`), but that is per
 * EVENT: a single turn can run unbounded rounds (`resolveAgentRounds`), so
 * hundreds of capped outputs could still reach tens of MB before the turn
 * ends. 2 MB mirrors `CARRIER_BUDGET` and sits far above any realistic turn,
 * so it only fires on pathological input.
 */
export const EVENT_OUTPUT_BUDGET = 2_000_000;

/**
 * Bound the run-lifetime event ledger IN PLACE and return whether anything
 * changed.
 *
 * The array is shared by reference with the pending-turn snapshot, so it is
 * never reassigned or spliced - elements are replaced only. Four idempotent
 * passes, each mirroring a policy the consumer applies anyway:
 *  1. Thinking blocks over `MAX_CONTENT_CAP` are clipped (head+tail): the
 *     stream handler already bounds what it pushes, so this is the safety
 *     net for restored/legacy arrays.
 *  2. Tool outputs over `EVENT_OUTPUT_BUDGET` are re-clipped OLDEST-first to
 *     the display size (`trimDisplayEvent`'s exact output - the transcript is
 *     unchanged). Mirrors `boundCarriers`: newest first, because the model
 *     reasons over the recent results and old detail is elided by design.
 *  3. Still over budget with every output at/below the display size (a run
 *     with 1300+ tool calls): the OLDEST collapse to the elision marker -
 *     pairing (id, tool) survives, only the payload goes.
 *  4. Provider carriers (`providerBlocks`/`reasoningContent`) are kept whole
 *     or dropped under `CARRIER_BUDGET` - the same `boundCarriers` policy the
 *     turn-end ledger trim applies, just applied while the run lives.
 *
 * O(events) per call; called after each tool/assistant push and once when the
 * run settles.
 */
export function boundOutcomeEvents(events: any[], budget = EVENT_OUTPUT_BUDGET): boolean {
    let changed = false;

    // 1. A cumulative reasoning block past the per-message ceiling.
    for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e?.type === 'thinking' && typeof e.content === 'string' && e.content.length > MAX_CONTENT_CAP) {
            events[i] = { ...e, content: clipHistoryContent(e.content, MAX_CONTENT_CAP) };
            changed = true;
        }
    }

    // 2. Aggregate tool-output budget, shrinking the OLDEST payloads first.
    let total = 0;
    for (const e of events) {
        if (e?.type === 'tool_result' && typeof e.output === 'string') total += e.output.length;
    }
    if (total > budget) {
        for (let i = 0; i < events.length && total > budget; i++) {
            const e = events[i];
            if (e?.type !== 'tool_result' || typeof e.output !== 'string') continue;
            if (e.output.length <= DISPLAY_OUTPUT_LIMIT) continue;
            if (CLIP_DISPLAY_MARKER_RE.test(e.output)) continue; // already display-clipped
            const clipped = clipDisplay(e.output, DISPLAY_OUTPUT_LIMIT);
            total -= e.output.length - clipped.length;
            events[i] = { ...e, output: clipped };
            changed = true;
        }
    }

    // 3. Every output now fits the display size but the AGGREGATE still
    // exceeds the budget: collapse the oldest payloads to the marker.
    if (total > budget) {
        for (let i = 0; i < events.length && total > budget; i++) {
            const e = events[i];
            if (e?.type !== 'tool_result' || typeof e.output !== 'string') continue;
            if (e.output === TOOL_RESULT_ELISION_MARKER) continue;
            total -= e.output.length - TOOL_RESULT_ELISION_MARKER.length;
            events[i] = { ...e, output: TOOL_RESULT_ELISION_MARKER };
            changed = true;
        }
    }

    // 4. Carrier budget: `boundCarriers` returns the SAME array when nothing
    // is dropped (no churn on the hot path); when it drops, adopt the result
    // element-wise so the shared reference survives.
    const bounded = boundCarriers(events);
    if (bounded !== events) {
        for (let i = 0; i < bounded.length; i++) events[i] = bounded[i];
        changed = true;
    }
    return changed;
}

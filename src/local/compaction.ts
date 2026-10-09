/**
 * Summarizing compaction for the local agent: serialize the turns being
 * dropped, ask the run's OWN model to summarize them (on the request's
 * resolved wire API), and carry the rolling summary in the truncation
 * marker. The deterministic trim it wraps lives in contextWindow.ts.
 * Split out of localAgent.ts (which re-exports the public names below);
 * VS Code-free.
 */

import { proxyFetch } from '../proxyFetch';
import {
    AUTO_COMPACT_RATIO,
    clipForSummary,
    compactMessages,
    estimateMessageTokens,
    HISTORY_TRUNCATION_MARKER,
} from './contextWindow';
import type { LocalAgentMessage, LocalAgentRequest } from './localTypes';
import { isChatGptSubscriptionHost } from '../providerIdentity';
import { requestStreamingCompletion } from './wireAdapters';
import {
    endpointUrl,
    makeGoogleHeaders,
    makeHeaders,
    makeMessagesHeaders,
    withDispatcher,
} from './transport';

// --- AI compaction for the local loop ---
// Mechanical dropping alone discards everything the removed turns contained.
// Before splicing, the dropped turns are summarized by the user's OWN local
// model (one blocking non-streaming call) and the summary replaces the bare
// truncation marker. Failure degrades to the plain marker - never to a lost
// turn without at least the mechanical trim.

const SUMMARY_MAX_TOTAL_CHARS = 60_000;
const SUMMARY_TIMEOUT_MS = 60_000;
/** Tool results are hard-capped per line regardless of the per-message
 *  allowance: the summarizer call runs on the SAME local model/window, so a
 *  single 60k-char tool output can overflow the summarizer itself and
 *  degrade the whole compaction to the plain marker. (Cline uses the same
 *  2000-char TOOL_RESULT_CHAR_LIMIT before summarizing.) */
const SUMMARY_TOOL_RESULT_CHARS = 2000;

export function serializeForSummary(messages: LocalAgentMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.filter((p) => p.type === 'text' && p.text).map((p) => p.text as string).join('\n')
                : '';
        if (m.role === 'user') {
            lines.push(`User: ${text}`);
        } else if (m.role === 'assistant') {
            if (text) lines.push(`Assistant: ${text}`);
            for (const tc of m.tool_calls ?? []) {
                lines.push(`Assistant tool call: ${tc.function.name}(${tc.function.arguments})`);
            }
        } else if (m.role === 'tool') {
            lines.push(`Tool result${m.tool_call_id ? ` (${m.tool_call_id})` : ''}: ${clipForSummary(text, SUMMARY_TOOL_RESULT_CHARS)}`);
        }
    }
    return lines.join('\n\n');
}

/**
 * Cap on the summarizer's OUTPUT budget. Reasoning models can spend a tight
 * budget on thinking and return NO summary text at all, which silently skips
 * compaction entirely - Cline raised their equivalent default to 8192 for
 * exactly this reason. The window-derived formula below keeps small windows
 * safe (a 4k model is never handed a 4k-token request it cannot satisfy), and
 * the cap only binds on large windows, where the summarizer's INPUT is already
 * capped at SUMMARY_MAX_TOTAL_CHARS so the extra headroom costs nothing.
 */
const SUMMARY_MAX_OUTPUT_CAP = 8192;

/**
 * Output budget for the summarizer call: a cap, not a target. Reasoning
 * models need headroom beyond their thinking output or no summary text ever
 * arrives and compaction is skipped (Cline's rule); deriving it from the
 * window keeps a 4k local model from being handed a 4k-token summary
 * request it can never satisfy.
 */
export function summaryMaxTokens(windowTokens?: number | null): number {
    const derived = windowTokens && windowTokens > 0
        ? Math.floor(windowTokens * 0.15)
        : 2048;
    return Math.min(SUMMARY_MAX_OUTPUT_CAP, Math.max(512, derived));
}

const SUMMARY_PROMPT_TEMPLATE = (
    'You are compacting the context of a coding-agent session. The turns '
    + 'below are about to be dropped from the working context and your '
    + 'summary REPLACES them, so it must be self-contained.\n\n'
    + 'Use EXACTLY these sections:\n'
    + '## Goal\n'
    + "One sentence: what is being built or fixed, plus the user's "
    + 'constraints and explicit instructions.\n'
    + '## State\n'
    + '- Done: completed steps\n'
    + '- In Progress: current work\n'
    + '- Blocked: blockers or open questions\n'
    + '## Highlights\n'
    + 'Key tool findings worth remembering: command outputs, test '
    + 'results, errors, references found, important values. Omit if none.\n'
    + '## Next\n'
    + 'Immediate next steps.\n'
    + '## Files\n'
    + 'Every file that was read, edited or created - its path and what '
    + 'mattered about its contents or the changes made. Use "- none" if none.\n\n'
    + 'Prefer concrete details (paths, names, values, error messages) over '
    + 'vague descriptions. Do not narrate the conversation turn by turn; '
    + 'state the facts as a compact briefing.'
);

/** Safety margin (tokens) on top of the reserved prompt/output budgets: the
 *  chars/token estimate is optimistic for code-dense content. */
const SUMMARY_OVERHEAD_TOKENS = 256;

/**
 * Char budget for the serialized dropped turns handed to the summarizer.
 * The summarizer call runs on the SAME local model/window that just overflowed,
 * so the fixed 60k-char cap must shrink to what the window can actually hold:
 * the fixed instructions, any rolling summary, and the summary's own output
 * (summaryMaxTokens) are reserved first - at ~3 chars/token, matching
 * estimateMessageTokens. An unknown window falls back to the fixed cap.
 */
export function summaryInputCharBudget(
    droppedCount: number,
    windowTokens?: number | null,
    overheadChars = 0,
): number {
    if (droppedCount < 1) return 0;
    if (!windowTokens || windowTokens <= 0) return SUMMARY_MAX_TOTAL_CHARS;
    const overheadTokens = Math.ceil(overheadChars / 3) + SUMMARY_OVERHEAD_TOKENS;
    const inputTokens = Math.floor(windowTokens) - summaryMaxTokens(windowTokens) - overheadTokens;
    if (inputTokens <= 0) return 0;
    return Math.min(SUMMARY_MAX_TOTAL_CHARS, inputTokens * 3);
}

/**
 * Serialized, per-line-clipped view of the dropped turns for the summarizer.
 * Each line is clipped to `perLineAllowance` (the per-dropped-item share of
 * the budget, floored at 400), then the AGGREGATE result is capped to
 * `budget` - the per-line floor means many small turns can still overflow
 * the window together, so the assembled conversation gets the final say.
 */
export function clippedConversationForSummary(
    dropped: LocalAgentMessage[],
    budget: number,
    perLineAllowance: number,
): string {
    let conversation = serializeForSummary(dropped)
        .split('\n\n')
        .map((line) => clipForSummary(line, perLineAllowance))
        .join('\n\n')
        .trim();
    if (conversation.length > budget) {
        // clipForSummary's clip markers ride ON TOP of the allowance - reserve
        // their length so the capped result truly fits the budget.
        const CLIP_MARKER_LEN = '\n[...clipped...]\n'.length;
        conversation = clipForSummary(conversation, Math.max(1, budget - CLIP_MARKER_LEN));
        // The head-clip fallback ('...') can still exceed tiny budgets -
        // enforce the exact aggregate limit as the final word.
        conversation = conversation.slice(0, budget);
    }
    return conversation;
}

/**
 * Run the compaction summarizer on the request's RESOLVED wire API.
 *
 * The summarizer MUST use the same API as the main request: OpenCode Zen/Go
 * route some model families ONLY to `/messages` or `/responses` (grok/gpt
 * return 503 on `/chat/completions`, and `/messages` rejects them as "not
 * supported for format anthropic"), so a hardcoded chat call would fail and
 * compaction would silently degrade to the bare marker on exactly the gateway
 * Xratu supports. Returns the extracted text or null; ChatGPT plan requests use SSE.
 */
async function requestSummaryCompletion(
    request: LocalAgentRequest,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
): Promise<string | null> {
    const style = request.apiStyle ?? 'chat';
    if (style === 'responses' && (request.subscription || isChatGptSubscriptionHost(request.baseUrl))) {
        const result = await requestStreamingCompletion({
            ...request, signal, tools: [], temperature: undefined, reasoningEffort: undefined,
            maxTokens: undefined, maxOutputLimit: undefined, toolChoice: undefined,
            subscription: true,
        }, [{ role: 'user', content: prompt }], '', () => {});
        return result.text.trim() || null;
    }
    const endpoint = style === 'messages' ? 'messages'
        : style === 'responses' ? 'responses'
            : style === 'google' ? `models/${encodeURIComponent(request.model)}:generateContent`
                : 'chat/completions';
    const headers = style === 'messages' ? makeMessagesHeaders(request.apiKey, request.sessionId, request.headers)
        : style === 'google' ? makeGoogleHeaders(request.apiKey, request.sessionId, request.headers)
            : makeHeaders(request.apiKey, request.sessionId, request.headers);
    // This is a non-streaming JSON call; the SSE `Accept` from makeHeaders is
    // wrong here and some gateways branch on it.
    headers.set('Accept', 'application/json');

    let body: Record<string, unknown>;
    if (style === 'messages') {
        body = {
            model: request.model,
            max_tokens: maxTokens,
            temperature: 0.2,
            messages: [{ role: 'user', content: prompt }],
        };
    } else if (style === 'responses') {
        body = { model: request.model, input: prompt, max_output_tokens: maxTokens, temperature: 0.2 };
    } else if (style === 'google') {
        body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
        };
    } else {
        body = {
            model: request.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.2,
            stream: false,
        };
    }

    const send = (): Promise<Response> => proxyFetch(endpointUrl(request.baseUrl, endpoint), withDispatcher({
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify(body),
    }, request.dispatcher));
    let resp = await send();
    // Some reasoning models reject ANY non-default temperature (the gpt-5
    // family: "Unsupported parameter: 'temperature' is not supported with this
    // model"). Drop it and retry once rather than letting compaction degrade to
    // a bare marker - the temperature is a nicety, the summary is not.
    if (!resp.ok && resp.status === 400) {
        const text = await resp.text().catch(() => '');
        if (/temperature/i.test(text) && 'temperature' in body) {
            delete body.temperature;
            resp = await send();
        }
    }
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const text = extractSummaryText(style, data);
    return text && text.trim() ? text.trim() : null;
}

/** Pull the assistant text out of a non-streaming response for each wire API. */
export function extractSummaryText(style: string, data: any): string | null {
    if (style === 'messages') {
        if (!Array.isArray(data?.content)) return null;
        return data.content
            .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
            .map((block: any) => block.text)
            .join('') || null;
    }
    if (style === 'responses') {
        if (!Array.isArray(data?.output)) return null;
        let text = '';
        for (const item of data.output) {
            if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
            for (const block of item.content) {
                if (block?.type === 'output_text' && typeof block.text === 'string') text += block.text;
            }
        }
        return text || null;
    }
    if (style === 'google') {
        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return null;
        return parts
            .filter((part: any) => typeof part?.text === 'string')
            .map((part: any) => part.text)
            .join('') || null;
    }
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content ? content : null;
}

async function summarizeDroppedTurns(
    request: LocalAgentRequest,
    dropped: LocalAgentMessage[],
    existingSummary: string | null,
    windowTokens?: number | null,
): Promise<string | null> {
    if (!dropped.length) return null;
    // Compaction is an optimization: a cancel must not wait out the summarizer.
    if (request.signal?.aborted) return null;
    const overheadChars = SUMMARY_PROMPT_TEMPLATE.length + (existingSummary?.length ?? 0);
    const budget = summaryInputCharBudget(dropped.length, windowTokens, overheadChars);
    // No room for ANY serialized input on this window (instructions + rolling
    // summary + output already fill it) - skip the summarizer call instead of
    // sending a request that cannot fit; the plain marker stands.
    if (budget <= 0) return null;
    const allowance = Math.max(400, Math.floor(budget / dropped.length));
    const conversation = clippedConversationForSummary(dropped, budget, allowance);
    if (!conversation) return null;

    let prompt = SUMMARY_PROMPT_TEMPLATE;
    if (existingSummary) {
        prompt += (
            '\n\nEarlier rolling summary of even older turns (merge it into '
            + 'your output seamlessly; keep anything still relevant, drop what '
            + 'the newer turns supersede):\n'
            + existingSummary
            + '\n\nThe dropped turns below may OVERLAP with that earlier '
            + 'summary. Emit each fact, file, or decision exactly ONCE - merge '
            + 'duplicates into a single entry rather than repeating them.'
        );
    }
    prompt += `\n\nDropped turns:\n${conversation}\n\nSummary:`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    // Cancel the summarizer the moment the run is cancelled - without this the
    // caller's await blocks for up to SUMMARY_TIMEOUT_MS after a user cancel.
    const outerSignal = request.signal;
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
        if (outerSignal.aborted) onOuterAbort();
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
        // Never ask for more than the model can actually emit: the provider/
        // curated output limit only ever LOWERS the window-derived budget (same
        // rule as the main request's cap). `requestSummaryCompletion` picks the
        // endpoint/body/parse for the request's resolved wire API.
        return await requestSummaryCompletion(
            request,
            prompt,
            Math.min(
                summaryMaxTokens(windowTokens),
                request.maxOutputLimit ?? Number.POSITIVE_INFINITY,
            ),
            controller.signal,
        );
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * True for the synthetic marker row that carries the rolling compaction
 * summary. After compaction it sits at index 1 and its content is either the
 * bare `HISTORY_TRUNCATION_MARKER` or that marker followed by the summary.
 */
export function isHistoryTruncationMarker(message: LocalAgentMessage): boolean {
    return message.role === 'user'
        && typeof message.content === 'string'
        && message.content.startsWith(HISTORY_TRUNCATION_MARKER);
}

/**
 * The dropped turns a summarizer should actually read. The truncation marker
 * is EXCLUDED: it is a synthetic carrier whose content is the rolling summary,
 * which the caller already passes as `existingSummary`. Feeding it back would
 * duplicate the previous summary (plus its "messages were removed" boilerplate)
 * in the compaction prompt, weighting the summarizer toward the old summary and
 * drifting it on every re-compaction.
 */
export function summarizableDroppedTurns(dropped: LocalAgentMessage[]): LocalAgentMessage[] {
    return dropped.filter((message) => !isHistoryTruncationMarker(message));
}

/**
 * Write the rolling summary into the history's truncation marker at index 1,
 * replacing any summary already carried there. No-op when the marker is absent
 * (nothing was compacted) or the summary is empty. Exported so the carry
 * contract is unit-testable without a model call.
 */
export function carryCompactionSummary(
    messages: LocalAgentMessage[],
    summary: string | null | undefined,
): boolean {
    if (!summary) return false;
    const marker = messages[1];
    if (!marker || marker.role !== 'user' || typeof marker.content !== 'string'
        || !marker.content.startsWith(HISTORY_TRUNCATION_MARKER)) {
        return false;
    }
    messages[1] = {
        role: 'user',
        content: `${HISTORY_TRUNCATION_MARKER}\n\n[Summary of the removed turns, written by the model itself:]\n${summary}`,
    };
    return true;
}

/**
 * Compaction WITH summarization: mechanically drops the oldest turns, then
 * asks the local model to summarize what was removed and bakes the summary
 * into the truncation marker. Returns the summary (null when compaction did
 * not trigger or summarization failed - in the failure case the drop is
 * REVERTED, see below).
 */
export async function compactWithSummary(
    messages: LocalAgentMessage[],
    request: LocalAgentRequest,
    windowTokens: number | null | undefined,
    usedTokens: number | undefined,
    existingSummary: string | null,
    toolTokens = 0,
    protectFromIndex?: number,
    gateRatio?: number,
): Promise<string | null> {
    // Compact a COPY and commit only on success. `compactMessages` drops turns
    // as a side effect, so summarizing the live array would leave a failed
    // summarizer (timeout / provider error / empty reply) with turns that are
    // neither summarized NOR replayed - silently lost for the rest of the run.
    // It also elides old tool results, but it REPLACES array elements and never
    // mutates a shared message object, so a shallow array copy isolates both.
    const working = messages.slice();
    const dropped = compactMessages(
        working, windowTokens, usedTokens, toolTokens, false,
        gateRatio ?? request.autoCompactRatio ?? AUTO_COMPACT_RATIO,
        protectFromIndex,
    );
    if (!dropped.length) return null;
    // The marker carries the rolling summary and the caller passes that same
    // summary as `existingSummary`, so strip the marker from what the
    // summarizer reads (see `summarizableDroppedTurns`).
    const droppedTurns = summarizableDroppedTurns(dropped);
    const summary = await summarizeDroppedTurns(request, droppedTurns, existingSummary, windowTokens);
    if (!summary || request.signal?.aborted) {
        // Nothing to carry: leave `messages` untouched so forced recovery
        // (deterministic) or the next compaction handles it. The previous
        // rolling summary - if any - is still in the caller's `existingSummary`
        // and in the system prompt, so it is not lost either.
        return null;
    }
    // Commit the compacted copy (in place: callers hold this reference), then
    // bake the merged summary into its marker.
    messages.splice(0, messages.length, ...working);
    carryCompactionSummary(messages, summary);
    return summary;
}

export function boundHistory(
    history: LocalAgentMessage[],
    contextWindow?: number | null,
    toolTokens = 0,
): LocalAgentMessage[] {
    if (!contextWindow || contextWindow < 4096 || history.length < 4) return history;
    const budget = Math.max(2048, Math.floor(contextWindow * 0.72));
    // Tool schemas ride on every request - count them against the budget.
    // The system prompt is deliberately NOT counted here: this is a pure
    // HISTORY bound, applied only as the LAST-RESORT fallback after the
    // summarizing ceiling pass (which does count the assembled system message)
    // could not bring the request under the bound. It drops turns without a
    // summary, so the runtime only reaches it when the summarizer failed or
    // nothing was droppable.
    let total = history.reduce((n, m) => n + estimateMessageTokens(m), 0) + toolTokens;
    if (total <= budget) return history;

    const kept = [...history];
    while (kept.length > 2 && total > budget) {
        const nextUser = kept.findIndex((m, i) => i > 0 && m.role === 'user');
        if (nextUser <= 0) break;
        const removed = kept.splice(0, nextUser);
        total -= removed.reduce((n, m) => n + estimateMessageTokens(m), 0);
    }
    return kept;
}

/**
 * Xratu Local Agent Runtime
 *
 * Provider/runtime-neutral OpenAI-compatible agent loop for local inference.
 * The extension owns the runtime, model HTTP connection, tool execution,
 * approval state, and event streaming in LOCAL mode.
 *
 * This file intentionally does not import VS Code, MCP, or React. The host
 * integration supplies tool definitions + an executor + approval callback.
 */

import { reminderTaskList, taskListReminderLine } from '../taskList';
import { providerHttpStatus } from '../providerErrors';
import { resolveAgentRounds } from '../tooling/agentRounds';
import {
    IMAGE_FORMAT_ERROR_RE,
    imageFallbackApplies,
    messagesHaveImages,
    reencodeMessageImages,
    toolResultContent,
} from './imageFormat';
import type { ImageUrlFormat } from './imageFormat';
import {
    AUTO_COMPACT_RATIO,
    HISTORY_BOUND_RATIO,
    boundToolResults,
    compactMessages,
    contextHint,
    contextStatusLine,
    estimateRunTokens,
    estimateToolTokens,
} from './contextWindow';
import {
    boundHistory,
    carryCompactionSummary,
    compactWithSummary,
    isHistoryTruncationMarker,
} from './compaction';
import type {
    LocalAgentEvent,
    LocalAgentMessage,
    LocalAgentRequest,
    LocalApprovalGate,
    LocalImageAttachment,
    LocalSteerFeed,
    LocalToolCall,
    LocalToolDefinition,
    LocalToolExecutor,
} from './localTypes';
import {
    CONTEXT_OVERFLOW_RE,
    NETWORK_MAX_RETRIES,
    NETWORK_MAX_RESUMES,
    NETWORK_RETRY_MAX_TOTAL_MS,
    OFFLINE_MAX_RETRIES,
    STREAM_RESUME_NOTE,
    abortError,
    describeNetworkError,
    isOfflineNetworkError,
    isRetryableProviderHttpError,
    isTransientNetworkError,
    networkRetryDelayMs,
    shouldResumeStream,
    sleepAbortable,
} from './transport';
import { requestStreamingCompletion, type CompletionResult } from './wireAdapters';

// ---------------------------------------------------------------------------
// Public surface. extension.ts, mcp.ts, externalMcp.ts and the node test
// suites import every name below from `./local/localAgent` - the code lives
// in the seam modules now, the surface stays exactly what it was.
export type {
    LocalAgentEvent,
    LocalAgentMessage,
    LocalAgentRequest,
    LocalApprovalGate,
    LocalChatTextContent,
    LocalImageAttachment,
    LocalSteerFeed,
    LocalSteerMessage,
    LocalToolCall,
    LocalToolDefinition,
    LocalToolExecutor,
    LocalToolImage,
    LocalToolResult,
    LocalUsage,
} from './localTypes';
export {
    MAX_TOOL_IMAGE_BYTES,
    PROVIDER_SAFE_IMAGE_MIME,
    base64ByteLength,
    imageFallbackApplies,
    isProviderSafeImageMime,
    messagesHaveImages,
    reencodeMessageImages,
    toolImageDataUrl,
    toolResultContent,
} from './imageFormat';
export {
    CONTEXT_OVERFLOW_RE,
    MAX_TOKENS_REJECT_RE,
    NETWORK_MAX_RETRIES,
    NETWORK_MAX_RESUMES,
    NETWORK_RETRY_BASE_DELAY_MS,
    NETWORK_RETRY_MAX_DELAY_MS,
    NETWORK_RETRY_MAX_TOTAL_MS,
    OFFLINE_MAX_RETRIES,
    PROMPT_CACHE_KEY_REJECT_RE,
    REASONING_REJECT_RE,
    STREAM_OPTIONS_REJECT_RE,
    STREAM_RESUME_NOTE,
    TOOL_CHOICE_REJECT_RE,
    TRANSPORT_TIMEOUT_CODE,
    isOfflineNetworkError,
    isRetryableProviderHttpError,
    isTransientNetworkError,
    networkRetryDelayMs,
    providerHttpError,
    shouldResumeStream,
} from './transport';
export {
    appendTailNote,
    chatWireMessages,
    parseArguments,
    withReasoningContent,
} from './wireAdapters';
export { UNPARSED_ARGS_KEY } from '../tooling/editFileArgs';
export {
    HISTORY_TRUNCATION_MARKER,
    TOOL_RESULT_ELISION_KEEP,
    TOOL_RESULT_ELISION_MARKER,
    boundToolResults,
    clipForSummary,
    compactMessages,
    elideOldToolResults,
    estimateImageTokens,
    estimateMessageTokens,
    estimateRunTokens,
    estimateToolTokens,
} from './contextWindow';
export {
    boundHistory,
    carryCompactionSummary,
    clippedConversationForSummary,
    extractSummaryText,
    isHistoryTruncationMarker,
    serializeForSummary,
    summarizableDroppedTurns,
    summaryInputCharBudget,
    summaryMaxTokens,
} from './compaction';

/** Forced token refreshes allowed per agent run after a 401 (see the recovery
 *  block in the round loop). Bounds the OAuth replay path without looping. */
const MAX_AUTH_RETRIES = 2;

// ---------------------------------------------------------------------------
// Loop-private helpers (the agent loop's own request/steering assembly).

function toUserContent(request: LocalAgentRequest, imageFormat: ImageUrlFormat): LocalAgentMessage['content'] {
    if (!request.attachments?.length) return request.userText;

    const content: NonNullable<LocalAgentMessage['content']> = [
        {
            type: 'text',
            // Attachment-only turn: some OpenAI-compatible servers reject
            // empty text parts, so always give the model something to read.
            text: request.userText || 'Describe the attached file(s).',
        },
    ];

    for (const image of request.attachments) {
        content.push({
            type: 'image_url',
            image_url: {
                url: imageFormat === 'base64'
                    ? image.dataBase64
                    : `data:${image.mimeType};base64,${image.dataBase64}`,
            },
        });
    }

    return content;
}

/** Steered user message content - same image encoding rules as the opening
 *  prompt (including the mid-run data-uri → raw-base64 swap). */
function steerContent(
    text: string,
    attachments: LocalImageAttachment[] | undefined,
    imageFormat: ImageUrlFormat,
): LocalAgentMessage['content'] {
    if (!attachments?.length) return text;
    const content: NonNullable<LocalAgentMessage['content']> = [];
    if (text) content.push({ type: 'text', text });
    for (const image of attachments) {
        content.push({
            type: 'image_url',
            image_url: {
                url: imageFormat === 'base64'
                    ? image.dataBase64
                    : `data:${image.mimeType};base64,${image.dataBase64}`,
            },
        });
    }
    return content;
}

/** Tagged stream delta so text and cumulative thinking keep their order. */
type StreamDelta = { kind: 'text' | 'thinking'; value: string };

class AsyncPushQueue<T> {
    private values: T[] = [];
    private waiters: Array<(value: T | null) => void> = [];
    private closed = false;

    push(value: T): void {
        if (this.closed) return;
        const waiter = this.waiters.shift();
        if (waiter) waiter(value);
        else this.values.push(value);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of this.waiters.splice(0)) waiter(null);
    }

    async pop(): Promise<T | null> {
        const value = this.values.shift();
        if (value !== undefined) return value;
        if (this.closed) return null;
        return new Promise((resolve) => this.waiters.push(resolve));
    }
}

function toolRequiresApproval(name: string, definitions: LocalToolDefinition[]): boolean {
    return definitions.find((tool) => tool.name === name)?.requiresApproval === true;
}

// While a response streams, an estimated cumulative usage event is emitted
// once per this many NEW estimated output tokens - the context meter ticks
// with the streamed tokens instead of only when a round completes. Mirrors
// STREAM_USAGE_ESTIMATE_STEP in src/routers/chat.py. The round-end usage
// event (server-reported) remains authoritative and overwrites the estimate.
const STREAM_USAGE_ESTIMATE_STEP = 32;

/** Carried in the volatile TAIL NOTE for the ONE wrap-up round that replaces
 *  the old hard stop when the round budget runs out mid-turn: the model must
 *  stop calling tools and deliver its final answer now, so the turn ends
 *  normally (status done) instead of erroring away everything the run did.
 *  It deliberately does NOT rewrite the system prompt: the wrap-up runs at
 *  peak context, so its cached prefix must stay byte-stable. Model-facing wire
 *  string, like HISTORY_TRUNCATION_MARKER. */
const ROUND_LIMIT_WRAPUP_NUDGE =
    '\n\n⚠ ROUND LIMIT REACHED: your tool-call budget for this turn is exhausted. '
    + 'Stop calling tools. Based on the work already done, give your final answer now: '
    + 'state what you completed, what remains, and any next steps for the user.';

// ---------------------------------------------------------------------------

export async function* runLocalAgent(
    request: LocalAgentRequest,
    executor: LocalToolExecutor,
    approvalGate: LocalApprovalGate,
    steerFeed?: LocalSteerFeed,
): AsyncGenerator<LocalAgentEvent> {
    const rounds = resolveAgentRounds(request.maxRounds);
    const windowTokens = request.contextWindow;
    // Threshold for this run: the host's setting, else the default. Used by the
    // mid-run gate, the pre-request compaction and the context hints so all
    // three agree on when the window counts as "full".
    const compactRatio = request.autoCompactRatio ?? AUTO_COMPACT_RATIO;
    // Tool schemas ship on every request and the message-only estimate
    // ignores them - compute once and fold into every occupancy calculation.
    const toolTokens = estimateToolTokens(request.tools);
    // Best occupancy estimate: the stable system prompt, the body messages
    // (history + live prompt), and the tool schemas. Still under-counts code
    // density and chat-template tokens (no client-side tokenizer), so the
    // model should treat the free headroom as optimistic.
    const estimateUsed = (): number => {
        const systemChars = request.systemPrompt.length;
        // The trailing note ships on every request too - count the task-list
        // reminder (unbounded) plus a fixed allowance for the status/hint.
        const tailChars = taskListReminderLine(reminderTaskList(request)).length + 400;
        return Math.ceil((systemChars + tailChars) / 3) + estimateRunTokens(messages.slice(1)) + toolTokens;
    };

    // Context awareness (fill level + progressive hints + task-list reminder)
    // is VOLATILE: it changes every round. It is sent as a TRAILING note, never
    // stored in `messages` and never in the system message - the system prompt
    // must stay byte-stable across rounds or prompt caching (Anthropic
    // cache_control, OpenAI/Google automatic prefix caching) can never hit.
    const tailNoteFor = (usedTokens: number): string =>
        taskListReminderLine(reminderTaskList(request))
        + contextStatusLine(usedTokens, windowTokens)
        + contextHint(usedTokens, windowTokens, compactRatio);

    // The FULL history. `boundHistory` used to trim it mechanically to 72%
    // BEFORE the summarizing compaction could run, so the turns it ate were
    // lost without ever reaching the summary. The pre-request compaction (gated
    // at the 72% ceiling) now does the bounding, WITH summarization.
    const history = request.history ?? [];
    let imageFormat: ImageUrlFormat = 'data-uri';
    let imageFormatSwapped = false;
    // Overflow recovery is a one-shot per run: if the mechanically compacted
    // retry ALSO overflows, the request itself cannot fit - fail the turn.
    let overflowRecovered = false;
    // An OAuth token that expired mid-run is force-refreshed and the round
    // replayed. Bounded, not one-shot: a long tool-using run can outlive a
    // token lifetime twice (the fresh token is only re-resolved at the next
    // TURN, so the rest of THIS run keeps using the one it was given). Two
    // retries cover that and still cannot loop - every further 401 is a real
    // rejection (revoked account, wrong workspace) and must surface.
    let authRetries = 0;
    // The current turn's opening user message is held by REFERENCE so the
    // steering-safe compaction boundary can be recovered after turns are
    // spliced out. A steer is a user row appended AFTER this one, so scanning
    // for the last user row would wrongly protect the steer and let compaction
    // drop the user's actual request.
    let currentTurnMessage: LocalAgentMessage = {
        role: 'user',
        content: toUserContent(request, imageFormat),
    };
    const buildMessages = (): LocalAgentMessage[] => [
        { role: 'system', content: request.systemPrompt },
        ...history,
        currentTurnMessage,
    ];
    let messages: LocalAgentMessage[] = buildMessages();
    /** Index of the current turn's opener in `messages` (undefined when absent
     *  or at the system boundary), for `compactMessages`' protectFromIndex. */
    const turnStartIndex = (): number | undefined => {
        const index = messages.indexOf(currentTurnMessage);
        return index > 1 ? index : undefined;
    };
    // How many user turns the run has folded into the rolling summary so far.
    const historyUserTurns = history.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0);
    // How many user turns the run has folded into the rolling summary, as a
    // count the host can map to its suffix replay boundary. Only a summarized
    // PREFIX can be expressed that way: after any UNSUMMARIZED drop (forced
    // recovery / mechanical fallback) a later summarized drop is no longer a
    // prefix, so freeze the report at that point. The host then replays the
    // unsummarized turns too - a duplicate is safer than an omission.
    let unsummarizedDrop = false;
    let reportedTurns = 0;
    const compactedUserTurns = (): number => {
        if (unsummarizedDrop) return reportedTurns;
        const ts = turnStartIndex();
        if (ts == null) return reportedTurns;
        let remaining = 0;
        for (let i = 1; i < ts; i++) {
            const m = messages[i];
            if (m.role === 'user' && !isHistoryTruncationMarker(m)) remaining++;
        }
        reportedTurns = Math.max(0, historyUserTurns - remaining);
        return reportedTurns;
    };
    // Rolling compaction summary: each compaction's summary is merged into the
    // next one and reported to the host so it survives across requests. Seed
    // from the summary the host carried over from earlier turns so the
    // pre-request compaction merges into it rather than overwriting it.
    let sessionSummary: string | null = request.sessionSummary ?? null;

    // Proactive auto-compact BEFORE the first request. The gate is the LOWER of
    // the user's threshold and the 72% hard memory ceiling: the old
    // `boundHistory` dropped at 72% mechanically, so gating the summarizing
    // compaction at the same point preserves that timing while making every
    // dropped turn land in the summary. A single pass also avoids the
    // double-failure window a separate ceiling pass would open (first
    // summarizer fails, second succeeds, first pass's drops never summarized).
    const preSummary = await compactWithSummary(
        messages, request, windowTokens, undefined, sessionSummary, toolTokens, turnStartIndex(),
        Math.min(request.autoCompactRatio ?? AUTO_COMPACT_RATIO, HISTORY_BOUND_RATIO),
    );
    request.signal?.throwIfAborted();
    if (preSummary) {
        sessionSummary = preSummary;
        yield { type: 'compactionSummary', value: preSummary, droppedUserTurns: compactedUserTurns() };
    }
    // Occupancy shown to the model in the trailing note. Seeded from the
    // estimate, then replaced with server-reported ground truth each round.
    let noteUsed = estimateUsed();
    // Last resort: the summarizing ceiling could not bring the request under
    // the bound (summarizer failed, or nothing was droppable). Fall back to the
    // mechanical `boundHistory` trim so it still fits - unsummarized by
    // necessity, and NOT reported, so the host keeps replaying those turns
    // instead of treating them as compacted. The truncation marker is preserved.
    if (windowTokens && noteUsed > Math.max(2048, Math.floor(windowTokens * HISTORY_BOUND_RATIO))) {
        const historyEnd = turnStartIndex() ?? messages.length;
        const historyRows = messages.slice(1, historyEnd).filter((m) => !isHistoryTruncationMarker(m));
        const bounded = boundHistory(historyRows, windowTokens, toolTokens);
        if (bounded.length !== historyRows.length) {
            const marker = isHistoryTruncationMarker(messages[1]) ? messages[1] : null;
            messages.splice(
                0, messages.length,
                { role: 'system', content: request.systemPrompt },
                ...(marker ? [marker] : []),
                ...bounded,
                currentTurnMessage,
            );
            // These drops are unsummarized: freeze the reported replay count so
            // a later summarized drop cannot advance the host boundary past
            // turns no summary covers.
            unsummarizedDrop = true;
            noteUsed = estimateUsed();
        }
    }

    yield { type: 'status', value: 'connecting' };

    for (let round = 0; round < rounds; round++) {
        yield { type: 'status', value: round === 0 ? 'running' : 'continuing' };

        // Transient-network retry state for THIS round. A round is retried
        // BEFORE any delta reached the user; once text has streamed, a drop is
        // RESUMED instead (continuation request) - restarting would replay
        // content the user already saw, and resuming after a tool call would
        // risk half-parsed arguments. See shouldResumeStream.
        let roundRetries = 0;
        let resumesUsed = 0;
        // Text the user already saw from FAILED attempts this round; the
        // successful attempt's text is appended to it.
        let resumedText = '';
        // The continuation request's messages once a resume is armed.
        let continuationMessages: LocalAgentMessage[] | null = null;
        const retryDeadline = Date.now() + NETWORK_RETRY_MAX_TOTAL_MS;
        let result: CompletionResult | null = null;
        let requestError: unknown = null;
        // Kept at round scope so the settled value is visible below: the
        // `.then` closure assignment to `result` is invisible to TS's
        // control-flow analysis.
        let requestPromise: Promise<CompletionResult | null> | null = null;

        for (;;) {
        const queue = new AsyncPushQueue<StreamDelta>();
        // Text emitted by THIS attempt (the resume prefix on the next try).
        let attemptText = '';
        // A tool-call delta landed this attempt - its arguments may be
        // half-parsed, so the attempt may not be resumed.
        let sawToolCall = false;
        result = null;
        requestError = null;

        // Mid-stream usage estimator: every streamed text delta feeds it and
        // roughly every STREAM_USAGE_ESTIMATE_STEP new output tokens an
        // estimated cumulative usage event is yielded - the context meter
        // moves with the streamed tokens, not only when the round completes.
        // `messages` still holds ONLY the prompt side (system + history +
        // live prompt; the in-flight response is not pushed until the round
        // ends), so estimateUsed() is the prompt-token estimate; the
        // ~3 chars/token density mirrors estimateMessageTokens. The real
        // server-reported usage event below overwrites the estimate.
        let streamedChars = 0;
        let estimatedUsageEmitted = 0;
        const estimatedUsageForDelta = (delta: string): LocalAgentEvent | null => {
            streamedChars += delta.length;
            const completionTokens = Math.ceil(streamedChars / 3);
            if (completionTokens - estimatedUsageEmitted < STREAM_USAGE_ESTIMATE_STEP) return null;
            estimatedUsageEmitted = completionTokens;
            const promptTokens = estimateUsed();
            return {
                type: 'usage',
                estimated: true,
                usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
            };
        };

        // A single huge tool result can exceed the window on its own, and
        // compaction never touches the current turn - bound it before sending.
        // The messages are byte-identical between retries, so bound only once;
        // a resume reuses the same prompt plus the partial answer.
        if (roundRetries === 0 && resumesUsed === 0) boundToolResults(messages, windowTokens, toolTokens);

        // Clear the previous attempt's countdown right before re-dialing: the
        // bubble falls back to typing dots and a hung connect is not mistaken
        // for a stalled UI (mirrors the host's cloud retry protocol).
        if (roundRetries > 0) yield { type: 'attempting' };

        requestPromise = requestStreamingCompletion(
            request,
            continuationMessages ?? messages,
            continuationMessages ? '' : tailNoteFor(noteUsed),
            (delta) => {
                attemptText += delta;
                queue.push({ kind: 'text', value: delta });
            },
            (thinking) => { queue.push({ kind: 'thinking', value: thinking }); },
            () => { sawToolCall = true; },
        )
            .then((value) => { result = value; return value; })
            .catch((err) => { requestError = err; return null; })
            .finally(() => queue.close());

        while (result === null && requestError === null) {
            const delta = await queue.pop();
            if (delta !== null) {
                if (delta.kind === 'thinking') {
                    yield { type: 'thinking', value: delta.value };
                    continue;
                }
                const estUsage = estimatedUsageForDelta(delta.value);
                if (estUsage) yield estUsage;
                yield { type: 'chunk', value: delta.value };
            }
        }
        // Drain anything queued between the final response payload and close().
        while (true) {
            const delta = await queue.pop();
            if (delta === null) break;
            if (delta.kind === 'thinking') {
                yield { type: 'thinking', value: delta.value };
                continue;
            }
            yield { type: 'chunk', value: delta.value };
        }
        await requestPromise;

        if (!requestError) {
            // Splice the failed attempts' text back in front of the resumed
            // answer so the round settles with the COMPLETE message. Cast: the
            // `.then` closure assignment is invisible to control-flow analysis.
            const settled = result as CompletionResult | null;
            if (resumedText && settled) result = { ...settled, text: resumedText + settled.text };
            break;
        }

        // Mid-stream resume: the provider cut the body after text reached the
        // user but before any tool call. Continue the partial answer instead
        // of restarting (which would duplicate visible text) or failing the
        // turn. A continuation carries the partial answer as an assistant turn
        // plus a "continue exactly here" note, so it also works for providers
        // that reject assistant prefill. Offline links earn the larger offline
        // resume budget - an offline drop resumes (never restarts) until the
        // link is back, bounded by the round deadline.
        const transient = isTransientNetworkError(requestError);
        const offline = transient && isOfflineNetworkError(requestError);
        if (shouldResumeStream({
            emittedOutput: attemptText.length > 0,
            sawToolCall,
            transient,
            aborted: !!request.signal?.aborted,
            resumesUsed,
            deadlineMs: retryDeadline,
            maxResumes: offline ? OFFLINE_MAX_RETRIES : NETWORK_MAX_RESUMES,
        })) {
            resumesUsed++;
            resumedText += attemptText;
            continuationMessages = [
                ...messages,
                { role: 'assistant', content: resumedText },
                { role: 'user', content: STREAM_RESUME_NOTE },
            ];
            // Offline: give the link a beat before re-dialing - an immediate
            // continuation on a dead link fails in milliseconds and would burn
            // the whole resume budget before connectivity returns.
            if (offline) {
                await sleepAbortable(networkRetryDelayMs(resumesUsed), request.signal);
                if (request.signal?.aborted || Date.now() >= retryDeadline) break;
            }
            continue;
        }

        // Retry a transient transport drop (terminated / socket reset /
        // timeout) OR a provider "upstream unavailable" status (529/502/503/
        // 504) that happened before any ANSWER text or tool call reached the
        // user, while attempts and the total-time budget allow. A
        // thinking-only attempt is restartable: no answer text is duplicated,
        // the fresh attempt simply opens another thinking pill. Offline
        // (DNS/route) errors earn a larger attempt budget so a link blip does
        // not kill the turn. Everything else - ordinary HTTP rejections,
        // overflow, a user cancel, mid-content death - falls through to the
        // error/recovery path below.
        const retryable = transient || isRetryableProviderHttpError(requestError);
        const maxAttempts = offline ? OFFLINE_MAX_RETRIES + 1 : NETWORK_MAX_RETRIES + 1;
        const canRetry = !attemptText
            && !sawToolCall
            && !request.signal?.aborted
            && roundRetries + 1 < maxAttempts
            && Date.now() < retryDeadline
            && retryable;
        if (!canRetry) break;

        roundRetries++;
        const waitMs = networkRetryDelayMs(roundRetries);
        yield {
            type: 'retrying',
            attempt: roundRetries,
            maxAttempts,
            nextRetryInMs: waitMs,
            offline,
        };
        await sleepAbortable(waitMs, request.signal);
        // Never start another attempt after a cancel, nor once the backoff has
        // consumed the wall-clock budget - the throw below surfaces whichever.
        if (request.signal?.aborted || Date.now() >= retryDeadline) break;
        }

        if (requestError) {
            // A cancel that surfaced as a socket error, or landed during a
            // retry backoff, must reach the host as an AbortError - otherwise
            // it renders as a network error instead of a cancellation.
            if (request.signal?.aborted) throw abortError();
            // OAuth credentials only: a 401 whose access token expired
            // mid-turn is force-refreshed and the round replayed ONCE. Only
            // credentials WITHOUT a static key ever set onUnauthorized, so
            // this branch is dead for BYOK turns. `messages` is reused as-is -
            // no delta reached the user (a 401 with body text would have been
            // a different error), so replaying cannot duplicate output.
            if (
                authRetries < MAX_AUTH_RETRIES
                && request.onUnauthorized
                && providerHttpStatus(requestError)?.status === 401
            ) {
                authRetries++;
                let fresh: string | null = null;
                try {
                    fresh = await request.onUnauthorized();
                } catch {
                    fresh = null; // refresh itself failed - surface the 401
                }
                if (fresh) {
                    request.apiKey = fresh;
                    requestError = null;
                    round--;
                    continue;
                }
            }
            // Some local servers (LM Studio, Ollama) reject the OpenAI-standard
            // data: URI in image_url.url and demand raw base64 - flip the
            // encoding ONCE and retry the round instead of failing the turn.
            // The trigger is ANY image on the wire, including one a TOOL
            // returned: a turn whose only picture is an MCP screenshot has no
            // `attachments`, and gating on that alone would re-400 forever.
            if (
                !imageFormatSwapped
                && imageFallbackApplies(request.apiStyle ?? 'chat')
                && (request.attachments?.length || messagesHaveImages(messages))
                && requestError instanceof Error
                && IMAGE_FORMAT_ERROR_RE.test(requestError.message)
            ) {
                imageFormatSwapped = true;
                imageFormat = 'base64';
                // Replace the opener IN PLACE rather than rebuilding from
                // `history`: a rebuild would discard any compaction already
                // applied to `messages` (and re-add the turns it dropped). The
                // image lives in the CURRENT turn, which compaction never
                // touches, so swapping it here is safe and keeps the protect
                // boundary (`currentTurnMessage`) pointing at the array member.
                {
                    const openerIndex = messages.indexOf(currentTurnMessage);
                    currentTurnMessage = { role: 'user', content: toUserContent(request, imageFormat) };
                    if (openerIndex >= 0) messages[openerIndex] = currentTurnMessage;
                    else messages = buildMessages();
                }
                // Tool-result images were encoded with the format in force when
                // the tool ran, so they need the same flip - otherwise the retry
                // sends the exact payload the server just rejected.
                reencodeMessageImages(messages, imageFormat);
                requestError = null;
                round--;
                continue;
            }
            // Overflow recovery: local servers (Ollama, LM Studio, llama.cpp,
            // vLLM) hard-reject the request when the prompt exceeds the
            // model's context window - each with its own wording. Recovery
            // must be DETERMINISTIC (Cline's rule): the estimate just proved
            // wrong, so a summarizer call riding on the same window could
            // overflow too. Drop the oldest turns mechanically (forced: the
            // ratio gate and estimate are exactly what failed here), keep the
            // truncation marker, and retry ONCE.
            if (
                !overflowRecovered
                && windowTokens
                && requestError instanceof Error
                && CONTEXT_OVERFLOW_RE.test(requestError.message)
            ) {
                overflowRecovered = true;
                if (compactMessages(messages, windowTokens, undefined, toolTokens, true, undefined, turnStartIndex()).length) {
                    // Forced recovery inserts a BARE marker (no summarizer call
                    // - deterministic by design), which would erase the rolling
                    // summary the marker was carrying. Re-attach the best-known
                    // summary without a model call so the retry keeps it.
                    carryCompactionSummary(messages, sessionSummary);
                    // Unsummarized drop: freeze the reported replay count.
                    unsummarizedDrop = true;
                    noteUsed = estimateUsed();
                    requestError = null;
                    round--;
                    continue;
                }
            }
            throw describeNetworkError(requestError);
        }
        // Reached only on a successful attempt, so the settled value is set.
        // `result` is read through the closure-visible promise for typing.
        const finalResult = result ?? (requestPromise ? await requestPromise : null);
        if (!finalResult) throw new Error('Model returned no completion result.');

        if (finalResult.usage) yield { type: 'usage', usage: finalResult.usage };

        // Live awareness + mid-run compaction from ground-truth usage. A
        // local model crossing 90% of its window mid-turn (tool outputs
        // accumulate fast on 4k–16k windows) gets its oldest turns dropped
        // NOW instead of failing the next request outright.
        if (finalResult.usage?.promptTokens != null) {
            let used = finalResult.usage.promptTokens + (finalResult.usage.completionTokens ?? 0);
            if (windowTokens && used >= windowTokens * compactRatio) {
                const summary = await compactWithSummary(
                    // `used` is the server-reported prompt size and already
                    // includes the tool schemas, so toolTokens stays 0 here
                    // (passing it would double-count). `turnStartIndex()` keeps
                    // the steering-safe boundary.
                    messages, request, windowTokens, used, sessionSummary, 0, turnStartIndex(),
                );
                if (summary) {
                    sessionSummary = summary;
                    yield { type: 'compactionSummary', value: summary, droppedUserTurns: compactedUserTurns() };
                }
                used = Math.min(used, estimateUsed());
            }
            // Update the trailing note's occupancy for the NEXT round; the
            // system message itself is left untouched so the prompt prefix
            // stays cacheable.
            noteUsed = used;
        } else {
            // Provider omitted usage: fall back to the estimate so the note
            // does not report stale occupancy as history grows.
            noteUsed = estimateUsed();
        }

        if (!finalResult.toolCalls.length) {
            if (finalResult.text) {
                yield {
                    type: 'assistantMessage', text: finalResult.text, toolCalls: [],
                    ...(finalResult.providerBlocks?.length ? { providerBlocks: finalResult.providerBlocks } : {}),
                    ...(finalResult.reasoningContent ? { reasoningContent: finalResult.reasoningContent } : {}),
                };
            }
            yield { type: 'status', value: 'done' };
            return;
        }

        yield {
            type: 'assistantMessage', text: finalResult.text, toolCalls: finalResult.toolCalls,
            // The host persists these so the NEXT request replays the exact
            // bytes this round sent (see LocalAgentEvent.assistantMessage).
            ...(finalResult.providerBlocks?.length ? { providerBlocks: finalResult.providerBlocks } : {}),
            ...(finalResult.reasoningContent ? { reasoningContent: finalResult.reasoningContent } : {}),
        };

        messages.push({
            role: 'assistant',
            // Always a STRING: strict OpenAI-compatible servers (LM Studio,
            // older llama.cpp) reject assistant messages whose content key is
            // absent/null - empty text rides as "".
            content: finalResult.text || '',
            tool_calls: finalResult.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
            })),
            // Replay provider-native reasoning/thinking blocks on the next
            // request (required when a thinking turn also calls a tool).
            ...(finalResult.providerBlocks?.length ? { providerBlocks: finalResult.providerBlocks } : {}),
            // Chat Completions carries thinking as a top-level field rather
            // than content blocks, so it rides its own property.
            ...(finalResult.reasoningContent ? { reasoningContent: finalResult.reasoningContent } : {}),
        });

        const approvalCalls = finalResult.toolCalls.filter((call) => toolRequiresApproval(call.name, request.tools));
        let decisions: Record<string, boolean> = {};
        if (approvalCalls.length) {
            const approvalId = `local-${cryptoRandomId()}`;
            yield {
                type: 'needsApproval',
                approvalId,
                approvals: approvalCalls.map((call) => ({
                    tool_call_id: call.id,
                    tool_name: call.name,
                    args: call.arguments,
                })),
            };
            yield { type: 'status', value: 'waitingApproval' };
            decisions = await approvalGate.requestApproval(approvalId, approvalCalls);
        }

        // Parallel group (e.g. multiple subagent delegations in one round):
        // calls to `parallelTools` run CONCURRENTLY with each other while the
        // round's other calls keep the serial in-order path - both started at
        // once so a long delegation never delays the rest. Results stream as
        // each call settles and land in the ledger in completion order (the
        // replayed history stores the same order, so cache prefixes match).
        // Rounds without a parallel-tool call take the untouched serial path
        // below.
        const parallelNames = new Set(request.parallelTools ?? []);
        const parallelCalls = parallelNames.size
            ? finalResult.toolCalls.filter((call) => parallelNames.has(call.name))
            : [];
        if (parallelCalls.length) {
            for (const call of finalResult.toolCalls) {
                yield { type: 'toolCall', id: call.id, tool: call.name, args: call.arguments };
            }
            const eventQueue = new AsyncPushQueue<LocalAgentEvent>();
            // The queue closes EXACTLY once, when EVERY call of the round has
            // settled: a denied call settles inside the same try/finally (it
            // used to return early and leak the count, hanging the round), and
            // the serial tail never observes a premature zero between two of
            // its own awaits (which would drop the rest of its results).
            let remaining = finalResult.toolCalls.length;
            let execError: unknown = null;
            const runOne = async (call: LocalToolCall): Promise<void> => {
                try {
                    const approved = !toolRequiresApproval(call.name, request.tools) || decisions[call.id] === true;
                    if (!approved) {
                        const output = 'Tool execution denied by the user.';
                        messages.push({ role: 'tool', tool_call_id: call.id, content: output, isError: true });
                        eventQueue.push({ type: 'toolResult', id: call.id, tool: call.name, output, isError: true });
                        return;
                    }
                    const result = await executor.execute(call, (chunk) =>
                        eventQueue.push({ type: 'toolOutput', id: call.id, value: chunk }));
                    if (!result) throw new Error('Tool executor returned no result.');
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: result.output,
                        isError: result.isError === true,
                    });
                    eventQueue.push({
                        type: 'toolResult',
                        id: call.id,
                        tool: call.name,
                        output: result.output,
                        isError: result.isError,
                    });
                } catch (e) {
                    execError = execError ?? e;
                } finally {
                    if (--remaining === 0) eventQueue.close();
                }
            };
            // Wave-limited launch: a group larger than the cap runs in fixed-size
            // waves, so N delegations cost N-at-a-time rather than N at once.
            // Workers are completion-driven, NOT batched: a queued call starts
            // the moment ANY slot frees, which is what the setting, the README
            // and the task-tool description all promise. Results still stream
            // into the same queue as each call settles (the drain below is
            // unchanged), and `runOne` never rejects, so a worker cannot fail
            // the round.
            const limit = Math.max(1, Math.floor(request.parallelToolLimit ?? parallelCalls.length) || parallelCalls.length);
            void (async () => {
                let next = 0;
                await Promise.all(Array.from(
                    { length: Math.min(limit, parallelCalls.length) },
                    async () => {
                        while (next < parallelCalls.length) {
                            const call = parallelCalls[next++];
                            if (call === undefined) break;
                            await runOne(call);
                        }
                    },
                ));
            })();
            void (async () => {
                for (const call of finalResult.toolCalls) {
                    if (parallelNames.has(call.name)) continue;
                    await runOne(call);
                }
            })();
            while (true) {
                const event = await eventQueue.pop();
                if (event === null) break;
                yield event;
            }
            if (execError) throw execError;
            continue;
        }

        for (const call of finalResult.toolCalls) {
            const approved = !toolRequiresApproval(call.name, request.tools) || decisions[call.id] === true;
            yield { type: 'toolCall', id: call.id, tool: call.name, args: call.arguments };

            if (!approved) {
                const output = 'Tool execution denied by the user.';
                messages.push({ role: 'tool', tool_call_id: call.id, content: output, isError: true });
                yield { type: 'toolResult', id: call.id, tool: call.name, output, isError: true };
                continue;
            }

            // Stream long-running tool output (terminal commands) as it is
            // produced. The queue lets us yield while execute() is still
            // pending - a callback cannot yield into this generator directly.
            const toolQueue = new AsyncPushQueue<string>();
            let execResult: { output: string; isError?: boolean } | null = null;
            let execError: unknown = null;
            const execPromise = executor
                .execute(call, (chunk) => toolQueue.push(chunk))
                .then((r) => { execResult = r; return r; })
                .catch((e) => { execError = e; return null; })
                .finally(() => toolQueue.close());

            while (execResult === null && execError === null) {
                const chunk = await toolQueue.pop();
                if (chunk !== null) yield { type: 'toolOutput', id: call.id, value: chunk };
            }
            while (true) {
                const chunk = await toolQueue.pop();
                if (chunk === null) break;
                yield { type: 'toolOutput', id: call.id, value: chunk };
            }
            // Await the promise for the settled value (the closure assignment
            // above is invisible to TS's control-flow analysis).
            const result = await execPromise;
            if (execError) throw execError;
            if (!result) throw new Error('Tool executor returned no result.');

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: toolResultContent(result.output, result.images, imageFormat),
                isError: result.isError === true,
            });
            yield {
                type: 'toolResult',
                id: call.id,
                tool: call.name,
                output: result.output,
                isError: result.isError,
                ...(result.images?.length ? { images: result.images } : {}),
            };
        }

        // Steering: user messages typed while the run streams join the
        // conversation HERE - after the current tool results, BEFORE the
        // next model request - so the model reads them when it reasons
        // about its next tool call. No turn restart, no lost tool state.
        if (steerFeed) {
            for (const steer of steerFeed.drain()) {
                const text = steer.text.trim();
                if (!text && !steer.attachments?.length) continue;
                messages.push({ role: 'user', content: steerContent(text, steer.attachments, imageFormat) });
                yield {
                    type: 'steer',
                    text,
                    ...(steer.attachments?.length ? { attachments: steer.attachments } : {}),
                    ...(steer.steerId ? { steerId: steer.steerId } : {}),
                };
            }
        }
    }

    // Round budget exhausted while the model was still calling tools. A hard
    // stop here throws away everything the run did mid-turn and surfaces as
    // an error bubble; instead, give the model ONE wrap-up round to deliver
    // its final answer/summary, then end the turn normally.
    //
    // PROMPT CACHING: the wrap-up runs at PEAK context, so its prefix must not
    // change. Keep the same system message and the same tool DEFINITIONS (the
    // old behavior - appending the nudge to the system prompt and sending
    // `tools: []` - rewrote the cached prefix and forced a full cache miss),
    // forbid tool CALLS with `toolChoice: 'none'`, and carry the nudge in the
    // volatile tail note, which sits after every cache breakpoint.
    yield { type: 'status', value: 'continuing' };
    const wrapMessages: LocalAgentMessage[] = messages;
    // The wrap-up runs at peak context - bound tool output too, or the nudge
    // itself overflows a small window. Tool schemas still ride the request.
    boundToolResults(wrapMessages, windowTokens, toolTokens);

    // The wrap-up runs when the conversation is at its largest, so the same
    // one-shot overflow recovery as the main loop applies: on a server-side
    // context-overflow rejection, compact deterministically (forced - the
    // estimate just proved wrong) and retry ONCE. The system message at
    // index 0 survives compaction, so the prefix stays intact on the retry.
    // Transient transport drops get the same pre-output retry as the main
    // loop - the wrap-up is the WORST place to lose a turn, since all the
    // work has already been done and only the summary is missing.
    let wrapRecovered = false;
    let wrapRetries = 0;
    const wrapRetryDeadline = Date.now() + NETWORK_RETRY_MAX_TOTAL_MS;
    let wrapResult: CompletionResult | null = null;
    let wrapError: unknown = null;
    for (;;) {
        let emittedOutput = false;
        const wrapQueue = new AsyncPushQueue<StreamDelta>();
        wrapResult = null;
        wrapError = null;
        if (wrapRetries > 0) yield { type: 'attempting' };
        const wrapPromise = requestStreamingCompletion(
            { ...request, toolChoice: 'none' },
            wrapMessages,
            tailNoteFor(noteUsed) + ROUND_LIMIT_WRAPUP_NUDGE,
            (delta) => { emittedOutput = true; wrapQueue.push({ kind: 'text', value: delta }); },
            (thinking) => { emittedOutput = true; wrapQueue.push({ kind: 'thinking', value: thinking }); },
        )
            .then((value) => { wrapResult = value; return value; })
            // null (not void) on failure: keeps the promise CompletionResult |
            // null so the success re-read below assigns cleanly.
            .catch((err) => { wrapError = err; return null; })
            .finally(() => wrapQueue.close());

        while (wrapResult === null && wrapError === null) {
            const delta = await wrapQueue.pop();
            if (delta !== null) {
                if (delta.kind === 'thinking') {
                    yield { type: 'thinking', value: delta.value };
                    continue;
                }
                yield { type: 'chunk', value: delta.value };
            }
        }
        while (true) {
            const delta = await wrapQueue.pop();
            if (delta === null) break;
            if (delta.kind === 'thinking') {
                yield { type: 'thinking', value: delta.value };
                continue;
            }
            yield { type: 'chunk', value: delta.value };
        }
        await wrapPromise;
        if (!wrapError) {
            wrapResult = await wrapPromise;
            break;
        }

        // Pre-output transient drop: retry BEFORE the overflow recovery, so a
        // flaky link is not misread as a context problem.
        if (
            !emittedOutput
            && !request.signal?.aborted
            && wrapRetries < NETWORK_MAX_RETRIES
            && Date.now() < wrapRetryDeadline
            && isTransientNetworkError(wrapError)
        ) {
            wrapRetries++;
            const waitMs = networkRetryDelayMs(wrapRetries);
            yield {
                type: 'retrying',
                attempt: wrapRetries,
                maxAttempts: NETWORK_MAX_RETRIES + 1,
                nextRetryInMs: waitMs,
            };
            await sleepAbortable(waitMs, request.signal);
            if (request.signal?.aborted || Date.now() >= wrapRetryDeadline) break;
            continue;
        }

        if (
            wrapRecovered
            || !windowTokens
            || !(wrapError instanceof Error)
            || !CONTEXT_OVERFLOW_RE.test(wrapError.message)
        ) break;
        if (!compactMessages(wrapMessages, windowTokens, undefined, toolTokens, true, undefined, turnStartIndex()).length) break;
        // Same as the main loop: forced recovery leaves a bare marker, so
        // re-attach the rolling summary before the one retry. Unsummarized
        // drop - freeze the reported replay count.
        carryCompactionSummary(wrapMessages, sessionSummary);
        unsummarizedDrop = true;
        wrapRecovered = true;
    }
    if (wrapError) throw request.signal?.aborted ? abortError() : describeNetworkError(wrapError);
    if (!wrapResult) throw new Error('Model returned no wrap-up completion result.');
    if (wrapResult.usage) yield { type: 'usage', usage: wrapResult.usage };
    // Tool calls in the wrap-up round are ignored: tools were not offered,
    // the budget is spent, and executing un-reviewed calls would silently
    // extend the run past its limit. A stubborn model that returns ONLY a
    // (ignored) tool call still leaves the turn with a visible final message
    // instead of committing blank.
    yield {
        type: 'assistantMessage',
        text: wrapResult.text
            || `[Round limit reached: the agent used all ${rounds} tool rounds without a final answer. Ask it to continue for the remaining steps.]`,
        toolCalls: [],
        ...(wrapResult.providerBlocks?.length ? { providerBlocks: wrapResult.providerBlocks } : {}),
        ...(wrapResult.reasoningContent ? { reasoningContent: wrapResult.reasoningContent } : {}),
    };
    yield { type: 'status', value: 'done' };
}

function cryptoRandomId(): string {
    const bytes = new Uint8Array(12);
    if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}


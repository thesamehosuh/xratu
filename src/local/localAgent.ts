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

import { reminderTaskList, taskListReminderLine, type TaskListItem } from '../taskList';
import { resolveAgentRounds } from '../tooling/agentRounds';
import { normalizeBaseUrl } from './baseUrl';
import { supportsPromptCacheKey, isOpenRouterHost } from './apiStyle';
import { PROVIDER_HTTP_STATUS_CODE } from '../providerErrors';
import type { ThinkingLevel } from './localTypes';

export type LocalChatTextContent = string;

export interface LocalImageAttachment {
    name: string;
    mimeType: string;
    dataBase64: string;
}

export interface LocalUsage {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    /** Prompt tokens served from the provider's cache, when reported. */
    cachedTokens?: number | null;
    /** Prompt tokens WRITTEN to the provider's cache this request (a subset of
     *  `promptTokens`), when reported. Billed above the plain input rate, so it
     *  is carried separately for cost. */
    cacheWriteTokens?: number | null;
}

export interface LocalToolCall {
    id: string;
    name: string;
    argumentsJson: string;
    arguments: Record<string, unknown>;
}

export interface LocalToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    requiresApproval?: boolean;
}

export type LocalAgentEvent =
    | { type: 'chunk'; value: string }
    | { type: 'thinking'; value: string }
    | { type: 'toolCall'; id: string; tool: string; args: Record<string, unknown> }
    | { type: 'toolResult'; id: string; tool: string; output: string; isError?: boolean }
    /** Incremental output from a still-running tool (terminal commands). */
    | { type: 'toolOutput'; id: string; value: string }
    /**
     * A completed assistant round. `providerBlocks`/`reasoningContent` are the
     * provider-native carriers the NEXT request must replay verbatim (thinking
     * blocks with signatures, Responses reasoning items, `reasoning_content`).
     * The host persists them into the model history: replaying a RECONSTRUCTED
     * assistant turn instead of the bytes the provider saw breaks prefix prompt
     * caching from that message onward, and drops thinking state entirely.
     */
    | {
        type: 'assistantMessage';
        text: string;
        toolCalls: LocalToolCall[];
        providerBlocks?: unknown[];
        reasoningContent?: string;
    }
    | { type: 'steer'; text: string; attachments?: LocalImageAttachment[]; steerId?: string }
    | {
        type: 'needsApproval';
        approvalId: string;
        approvals: Array<{
            tool_call_id: string;
            tool_name: string;
            args: Record<string, unknown>;
        }>;
    }
    | { type: 'status'; value: 'connecting' | 'running' | 'waitingApproval' | 'continuing' | 'done' }
    // Transient transport retry (flaky network): `retrying` drives the
    // countdown on the streaming bubble, `attempting` clears it right before
    // the next fetch. Display-only - never part of the committed transcript.
    | { type: 'retrying'; attempt: number; maxAttempts: number; nextRetryInMs: number; offline?: boolean }
    | { type: 'attempting' }
    // `estimated` marks the mid-stream usage estimates emitted WHILE a
    // response streams - the host must never record them as the turn's
    // real usage (the round-end event carries the authoritative copy).
    | { type: 'usage'; usage: LocalUsage; estimated?: boolean }
    /** `droppedUserTurns` is the CUMULATIVE number of user turns the run has
     *  folded into the rolling summary (relative to the history it was given).
     *  The host advances its replay boundary by this so the next turn does not
     *  re-send turns the summary already covers. */
    | { type: 'compactionSummary'; value: string; droppedUserTurns?: number }
    | { type: 'error'; value: string };

export interface LocalAgentMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | Array<{
        type: 'text' | 'image_url';
        text?: string;
        image_url?: { url: string };
    }>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    /** True when a tool message carries a failure (denied/executor error).
     *  The Messages transport maps it to Anthropic's `is_error`. */
    isError?: boolean;
    /** Provider-native assistant content to replay verbatim (see
     *  CompletionResult.providerBlocks). Only set on assistant messages. */
    providerBlocks?: unknown;
    /** Provider-native reasoning text to replay verbatim on the next request -
     *  the Chat Completions `reasoning_content` field. Thinking-mode APIs reject
     *  a replayed tool-call turn that omits it. Only set on assistant messages
     *  whose response actually streamed reasoning. */
    reasoningContent?: string;
}

export interface LocalAgentRequest {
    baseUrl: string;
    apiKey?: string | null;
    model: string;
    systemPrompt: string;
    userText: string;
    attachments?: LocalImageAttachment[];
    history?: LocalAgentMessage[];
    /** Rolling compaction summary carried from PREVIOUS turns (the host
     *  persists it and injects it into the system prompt). Seeding it here
     *  lets the pre-request compaction MERGE the newly dropped turns into the
     *  accumulated summary instead of starting from scratch and overwriting
     *  it - without this, a session that compacts once per turn keeps only the
     *  latest turn's summary and silently loses everything summarized before. */
    sessionSummary?: string | null;
    tools: LocalToolDefinition[];
    signal?: AbortSignal;
    maxTokens?: number;
    /** Provider/curated maximum output for the model. Used only to LOWER the
     *  derived cap (never to raise it), so a provider with a smaller output
     *  limit does not get a context-derived cap it will reject. Ignored when
     *  `maxTokens` is set - an explicit caller cap always wins. */
    maxOutputLimit?: number;
    temperature?: number;
    /** Reasoning-effort variant; undefined = omit from the body so runtimes
     *  keep their default behavior. `none` explicitly disables reasoning. */
    reasoningEffort?: ThinkingLevel;
    /** Agent-loop rounds allowed in this turn. Resolved by
     *  `resolveAgentRounds` (the host reads `xratu.maxAgentRounds`); absent,
     *  zero or negative means UNLIMITED - the loop then ends when the model
     *  stops calling tools, not at a fixed count. */
    maxRounds?: number;
    contextWindow?: number | null;
    /** Fraction of the window (0-1) at which proactive compaction fires.
     *  Absent uses AUTO_COMPACT_RATIO. The host reads
     *  `xratu.autoCompactThreshold` so the policy is the user's choice rather
     *  than a constant - Cline's rule, and the right one: compacting early
     *  costs cache hits and a summarizer call, compacting late risks overflow. */
    autoCompactRatio?: number;
    /** Current session task list (client-echoed, user edits merged) -
     *  appended to the system message each round so the model stays on-plan
     *  even after compaction dropped the original tool call. */
    taskList?: TaskListItem[];
    /** LIVE task list for the trailing reminder, consulted EVERY round.
     *  `taskList` above is captured once when the run starts, so it stays
     *  frozen for the whole run (up to 32 rounds) and a model that updates its
     *  plan mid-run would never see its own updates. Only the trailing note
     *  reflects this - it is volatile by design and never cached - so prompt
     *  caching is unaffected. Falls back to `taskList` when absent. */
    taskListProvider?: () => TaskListItem[] | undefined;
    /** Optional undici dispatcher (proxy) forwarded to every fetch. Typed
     *  `unknown` so this module stays free of VS Code / undici imports. */
    dispatcher?: unknown;
    /** Wire API to use. Resolved by the host via `resolveApiStyle`; defaults
     *  to OpenAI chat/completions. */
    apiStyle?: 'chat' | 'messages' | 'responses' | 'google';
    /** Stable per-conversation id, sent as `x-opencode-session`. OpenCode Go
     *  rejects requests without it (MissingSessionID). */
    sessionId?: string;
    /** Stable per-conversation identity for provider-side cache ROUTING
     *  (OpenAI `prompt_cache_key`), independent of the OpenCode session header:
     *  direct OpenAI hosts need it too. Only sent on hosts that accept it. */
    cacheKey?: string;
    /** `'none'` disables tool CALLS while keeping the tool DEFINITIONS in the
     *  request. Used by the round-limit wrap-up: dropping the definitions would
     *  change the cached prefix and force a full cache miss on the largest
     *  request of the run. Transports that reject the control fall back to
     *  dropping the definitions themselves. */
    toolChoice?: 'none';
}

export interface LocalToolExecutor {
    execute(
        call: LocalToolCall,
        /** Called with incremental output for long-running tools (terminal
         *  commands). Optional: executors may ignore it. */
        onOutput?: (chunk: string) => void,
    ): Promise<{ output: string; isError?: boolean }>;
}

export interface LocalApprovalGate {
    requestApproval(
        approvalId: string,
        calls: LocalToolCall[],
    ): Promise<Record<string, boolean>>;
}

/** A user message steered into a LIVE run (typed while it streams). Text
 *  attachments arrive already fenced into `text` by the host; images ride
 *  raw and are encoded with the run's current image format. */
export interface LocalSteerMessage {
    text: string;
    attachments?: LocalImageAttachment[];
    /** Opaque webview id echoed back on the `steer` event so the host can
     *  confirm the pending bubble the moment it is actually injected. */
    steerId?: string;
}

/** Injected into a running agent so the loop can pick up steered user
 *  messages at round boundaries (after tool results, before the next model
 *  request). `drain` must atomically empty the queue. */
export interface LocalSteerFeed {
    drain(): LocalSteerMessage[];
}

type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
};

function toOpenAITools(tools: LocalToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}

/**
 * How image attachments are encoded in image_url.url.  OpenAI's spec wants a
 * `data:` URI, but popular local servers disagree: LM Studio (and Ollama's
 * compat endpoint) require RAW base64 and reject data URIs with
 * "'url' field must be a base64 encoded image", while vLLM/llama.cpp want the
 * data URI.  We start with the standard data URI and retry ONCE with raw
 * base64 when the server's 400 matches that error (see runLocalAgent).
 */
type ImageUrlFormat = 'data-uri' | 'base64';

/** Server 400s that indicate the image_url.url encoding was wrong. */
const IMAGE_FORMAT_ERROR_RE = /must be a base64|base64 encoded image|unable to determine.+url|invalid image url/i;

/** Server errors that indicate the prompt exceeded the model's context
 *  window. Local runtimes word it very differently: Ollama "input length
 *  exceeds context length", llama.cpp "exceeds the available context size",
 *  vLLM / OpenAI "maximum context length is N tokens", LM Studio "prompt is
 *  too long". Matches the REQUEST-side overflow only - triggers the
 *  deterministic overflow-recovery compaction + single retry. */
export const CONTEXT_OVERFLOW_RE = /context length|context window|exceeds the available context|input length exceeds|maximum context length|prompt is too long|reduce the length of the messages|too many input tokens/i;

/** A 400 that specifically rejects the non-standard `stream_options` field -
 *  strict OpenAI-compatible servers do this; retry once without it. */
export const STREAM_OPTIONS_REJECT_RE = /stream_options|include_usage|unrecognized|unknown (field|parameter|argument)|extra fields|not permitted|unsupported (field|parameter)/i;

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

function parseArguments(raw: string): Record<string, unknown> {
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : {};
    } catch {
        return {};
    }
}

function extractSseData(buffer: string): { events: string[]; remainder: string } {
    const events: string[] = [];
    let remainder = buffer;

    while (true) {
        const match = remainder.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = remainder.slice(0, match.index);
        remainder = remainder.slice(match.index + match[0].length);

        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data) events.push(data);
    }

    return { events, remainder };
}

function makeHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    });
    if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
    // OpenCode Go rejects requests without a stable per-conversation session
    // id (MissingSessionID); harmless for other providers.
    if (sessionId) headers.set('x-opencode-session', sessionId);
    return headers;
}

/** Idle deadline between SSE chunks: unlike the cloud path (a 300 s total
 *  abort on the whole request), a local runtime may legitimately stream a
 *  long generation for minutes - but a WEDGED server delivers nothing at
 *  all. No bytes for this long means the connection is dead; error out
 *  instead of stalling the agent loop indefinitely. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Deadline for the wait until response headers / the first byte. Slow local
 *  reasoning models can spend minutes on prefill before emitting anything, so
 *  this is deliberately longer than the mid-stream idle deadline. A server
 *  that never answers still fails eventually. */
const FIRST_BYTE_TIMEOUT_MS = 300_000;

/** A 400 that rejects the output cap. Gateways differ on the field name and on
 *  whether they accept a cap at all; retry once without it. */
export const MAX_TOKENS_REJECT_RE = /max_tokens|max_completion_tokens|max_output_tokens|maxOutputTokens/i;

/** A 400 that rejects the reasoning/thinking parameter. The field name differs
 *  per API style (`reasoning_effort`, `thinking`, `thinkingConfig`), and many
 *  models accept none at all - retry once without it so an unsupported level
 *  degrades to the runtime default instead of failing the whole turn. */
export const REASONING_REJECT_RE = /reasoning_effort|reasoning[ ._]effort|thinking[ ._]?budget|thinkingConfig|\bthinking\b|reasoning is not supported|unsupported.{0,40}(reason|think)/i;

/** A 400 that rejects the tool-choice control used by the round-limit wrap-up
 *  (`tool_choice` / Google's `toolConfig`). Not every gateway implements it;
 *  retry without it AND without the tool definitions, so the wrap-up still
 *  cannot call a tool even though the cached prefix is lost. */
export const TOOL_CHOICE_REJECT_RE = /tool_choice|toolChoice|tool[ ._]?config|functionCallingConfig/i;

/** A 400 that rejects the OpenAI `prompt_cache_key` routing hint - retry
 *  without it (caching then falls back to OpenAI's automatic routing). */
export const PROMPT_CACHE_KEY_REJECT_RE = /prompt_cache_key|prompt cache key/i;

/** Anthropic extended-thinking and Gemini thinking budgets for a UI effort
 *  variant. The floor is Anthropic's minimum (1024); the ceiling is Gemini's
 *  max budget. `none` maps to 0 (disable). Ordered minimal → max so a higher
 *  variant never yields a smaller budget. */
function thinkingBudgetFor(level: ThinkingLevel): number {
    switch (level) {
        case 'none': return 0;
        case 'minimal': return 1_024;
        case 'low': return 4_096;
        case 'medium': return 8_192;
        case 'high': return 24_576;
        case 'xhigh': return 32_768;
        case 'max': return 49_152;
    }
}

/** Marks a deadline XRATU itself imposed (no headers, or no chunk for
 *  STREAM_IDLE_TIMEOUT_MS) rather than a provider rejection. The retry layer
 *  treats it as a transient transport failure - but only before any output
 *  reached the user. */
export const TRANSPORT_TIMEOUT_CODE = 'XRATU_TRANSPORT_TIMEOUT';

/** ES2020-safe `error.cause` assignment: the webview tsconfig targets ES2020,
 *  which predates the Error options constructor / `cause` property. */
function setErrorCause<T extends Error>(error: T, cause: unknown): T {
    (error as T & { cause?: unknown }).cause = cause;
    return error;
}

/** Deadline error carrying a stable code so the retry classifier recognizes
 *  it even though its `cause` is the internal AbortError (a user cancel, by
 *  contrast, is never wrapped and never retried). */
function transportTimeoutError(message: string, cause?: unknown): Error {
    const error = new Error(message);
    error.name = 'XratuTransportTimeout';
    (error as Error & { code?: string }).code = TRANSPORT_TIMEOUT_CODE;
    if (cause !== undefined) setErrorCause(error, cause);
    return error;
}

/** A non-OK provider response. Carries the numeric status and the raw body
 *  excerpt so callers can classify without re-reading the response. */
export function providerHttpError(status: number, text: string): Error {
    const error = new Error(`Model request failed (${status}): ${text.slice(0, 600)}`);
    error.name = 'XratuProviderHttpError';
    const tagged = error as Error & { code?: string; status?: number; body?: string };
    tagged.code = PROVIDER_HTTP_STATUS_CODE;
    tagged.status = status;
    tagged.body = text;
    return error;
}

/** Generous output cap derived from the context window (4k floor, 16k
 *  ceiling). The Messages API REQUIRES max_tokens; the chat, Responses and
 *  Google transports get the same derived cap so a full-window prompt plus a
 *  provider's default output maximum cannot overrun the context. An explicit
 *  `request.maxTokens` always wins. */
function derivedMaxTokens(windowTokens?: number | null): number {
    return Math.min(16384, Math.max(4096, Math.floor((windowTokens ?? 8192) / 4)));
}

/** The output cap actually sent: an explicit caller cap wins outright, else
 *  the context-derived cap lowered to the provider's reported maximum. */
function outputCapFor(request: LocalAgentRequest): number {
    if (request.maxTokens != null) return request.maxTokens;
    const derived = derivedMaxTokens(request.contextWindow);
    const limit = request.maxOutputLimit;
    return Number.isFinite(limit) && (limit as number) > 0 ? Math.min(derived, limit as number) : derived;
}

// --- Transient-network retry (flaky-connection hardening) -------------------
// Iranian / mobile links drop mid-stream constantly. Node's fetch surfaces a
// dead connection as `TypeError: terminated` (body cut) or `TypeError: fetch
// failed` (connect cut), with the real reason buried in the `cause` chain -
// undici attaches `SocketError: other side closed (UND_ERR_SOCKET)`,
// `BodyTimeoutError`, `HeadersTimeoutError`, or a raw `ECONNRESET`. Every
// competitor classifies these and retries: Cline's retry middleware names
// exactly `terminated: SocketError: other side closed (UND_ERR_SOCKET)`,
// opencode's retry regex matches `terminated|fetch failed|econnreset|...`,
// Codex backs off 5s→60s on connection failures. This mirrors them, tuned
// for a high-latency, high-loss network: four attempts, ~1s→4s jittered
// backoff, and a hard total-time cap so a dead provider never hangs a turn.

/** Error codes that mean the connection died under a request the provider
 *  never rejected. ECONNREFUSED / ENOTFOUND are DELIBERATELY absent: those
 *  are misconfiguration (server not started, wrong URL) and retrying them
 *  only delays the real error. */
const TRANSIENT_NETWORK_CODES = new Set([
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EAI_AGAIN',
    'ConnectionClosed',
    TRANSPORT_TIMEOUT_CODE,
]);

/** undici wraps every mid-body cut in a TypeError with a generic message;
 *  WebKit says "failed to fetch". */
const TRANSIENT_NETWORK_MESSAGES = new Set(['terminated', 'fetch failed', 'failed to fetch']);

/** Max `cause` hops walked - deep enough for fetch→undici→socket chains. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when an error (anywhere in its `cause` chain) identifies a transient
 * transport interruption - the connection died or timed out underneath a
 * request the provider never rejected. An AbortError anywhere in the chain
 * vetoes the match: cancelled requests surface the same socket vocabulary and
 * a user cancel must never be retried. XRATU's own deadline error is decisive
 * (it wraps an internal abort that is not a user cancel).
 */
export function isTransientNetworkError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    if ((error as { code?: unknown }).code === TRANSPORT_TIMEOUT_CODE) return true;
    let aborted = false;
    let transient = false;
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && typeof current === 'object'; depth++) {
        if (seen.has(current)) break;
        seen.add(current);
        const node = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
        if (node.name === 'AbortError' || node.name === 'ResponseAborted') aborted = true;
        if (typeof node.code === 'string' && TRANSIENT_NETWORK_CODES.has(node.code)) transient = true;
        if (
            current instanceof TypeError
            && typeof node.message === 'string'
            && TRANSIENT_NETWORK_MESSAGES.has(node.message.toLowerCase())
        ) transient = true;
        current = node.cause;
    }
    return transient && !aborted;
}

/** Total attempts = 1 initial + this many retries. */
export const NETWORK_MAX_RETRIES = 3;
/** First backoff; doubles each retry (1s → 2s → 4s) with +0–25% jitter. */
export const NETWORK_RETRY_BASE_DELAY_MS = 1000;
export const NETWORK_RETRY_MAX_DELAY_MS = 15_000;
const NETWORK_RETRY_JITTER = 0.25;
/** Hard ceiling on WALL-CLOCK spent retrying one round (attempt time included),
 *  so a provider that is down cannot make the agent wait forever. Sized above
 *  the 120s stream idle deadline so a single stalled attempt still earns one
 *  retry, but deliberately BELOW FIRST_BYTE_TIMEOUT_MS: a server that takes
 *  minutes to produce headers is treated as unrecoverable within the round
 *  rather than retried, which keeps a dead provider's total wait bounded. */
export const NETWORK_RETRY_MAX_TOTAL_MS = 180_000;

/** Backoff before retry `attempt` (1-based). Jitter spreads retries so a
 *  fleet of clients does not stampede a provider that is coming back up. */
export function networkRetryDelayMs(attempt: number, random = Math.random()): number {
    const base = Math.min(
        NETWORK_RETRY_MAX_DELAY_MS,
        NETWORK_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    );
    return Math.min(NETWORK_RETRY_MAX_DELAY_MS, Math.round(base + base * NETWORK_RETRY_JITTER * random));
}

/**
 * DNS / routing failures: the machine itself cannot reach the network, as
 * opposed to a provider that reset an established connection. These get the
 * longer offline budget below, and the UI says "offline" instead of
 * "retrying" so the user knows it is their link, not the provider.
 */
const OFFLINE_NETWORK_CODES = new Set(['EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']);

/** True when an error (anywhere in its `cause` chain) says the NETWORK is
 *  unreachable, not that the provider refused or dropped us. AbortErrors veto
 *  (a cancel is never "offline"). */
export function isOfflineNetworkError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    let aborted = false;
    let offline = false;
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && typeof current === 'object'; depth++) {
        if (seen.has(current)) break;
        seen.add(current);
        const node = current as { name?: unknown; code?: unknown; cause?: unknown };
        if (node.name === 'AbortError' || node.name === 'ResponseAborted') aborted = true;
        if (typeof node.code === 'string' && OFFLINE_NETWORK_CODES.has(node.code)) offline = true;
        current = node.cause;
    }
    return offline && !aborted;
}

/** Total attempts = 1 initial + this many retries while OFFLINE. A link blip
 *  can last tens of seconds, so the offline path keeps trying past the normal
 *  three-attempt cap, bounded by the round's wall-clock deadline (the user can
 *  cancel at any time). */
export const OFFLINE_MAX_RETRIES = 8;
/** Mid-stream resume attempts per round (see shouldResumeStream). */
export const NETWORK_MAX_RESUMES = 2;

/**
 * A dropped stream is RESUMED rather than restarted when the provider had
 * already produced text the user saw, but had not started a tool call: we
 * re-send the prompt with the partial answer as an assistant turn and ask for
 * the continuation. Restarting would duplicate visible text; resuming after a
 * tool call would risk replaying a call with half-parsed arguments. Pure so
 * the policy is unit-tested (test/test-network-retry.mjs).
 */
export function shouldResumeStream(opts: {
    /** Some text/thinking already reached the user this attempt. */
    emittedOutput: boolean;
    /** A tool-call delta was seen this attempt (arguments may be partial). */
    sawToolCall: boolean;
    /** The attempt failed with a transient transport error. */
    transient: boolean;
    /** The user cancelled. */
    aborted: boolean;
    /** Resumes already used in this round. */
    resumesUsed: number;
    /** Wall-clock deadline for this round. */
    deadlineMs: number;
    /** Injectable clock for tests. */
    now?: number;
    maxResumes?: number;
}): boolean {
    return opts.transient
        && opts.emittedOutput
        && !opts.sawToolCall
        && !opts.aborted
        && opts.resumesUsed < (opts.maxResumes ?? NETWORK_MAX_RESUMES)
        && (opts.now ?? Date.now()) < opts.deadlineMs;
}

/** Instruction appended as a user turn when resuming a cut-off stream. The
 *  partial answer is the preceding assistant message, so the model can see
 *  exactly where it stopped. */
export const STREAM_RESUME_NOTE =
    '[Connection lost. Your previous message was cut off mid-answer. Continue it from the exact point it stopped - do not repeat, summarise, or restart any text already written.]';


/** An AbortError the host recognizes: it maps `err.name === 'AbortError'` to
 *  the localized "request cancelled" state. Used when a cancel surfaces as a
 *  socket error, or lands during a retry backoff, instead of as a clean
 *  AbortError from fetch. */
function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

/** Resolve after `ms`, or immediately when `signal` aborts. Never rejects. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || !signal || signal.aborted) return Promise.resolve();
    const abortSignal = signal;
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        abortSignal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Append the `cause` chain to a transient transport error's message so the
 *  user sees `terminated: other side closed / UND_ERR_SOCKET` instead of the
 *  bare, useless `terminated`. Non-transport errors pass through unchanged. */
function describeNetworkError(error: unknown): unknown {
    if (!(error instanceof Error) || !isTransientNetworkError(error)) return error;
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = (error as Error & { cause?: unknown }).cause;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && typeof current === 'object'; depth++) {
        if (seen.has(current)) break;
        seen.add(current);
        const node = current as { message?: unknown; code?: unknown; cause?: unknown };
        if (typeof node.message === 'string' && node.message && !parts.includes(node.message)) parts.push(node.message);
        if (typeof node.code === 'string' && node.code && !parts.includes(node.code)) parts.push(node.code);
        current = node.cause;
    }
    const detail = parts.join(' / ');
    return detail ? setErrorCause(new Error(`${error.message}: ${detail}`), error) : error;
}

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(transportTimeoutError(`Model stream stalled (no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`)),
                    STREAM_IDLE_TIMEOUT_MS,
                );
            }),
        ]);
    } catch (e) {
        reader.cancel().catch(() => undefined); // release the dead connection
        throw e;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Attach an undici proxy dispatcher to a fetch init when one is provided. */
function withDispatcher(init: RequestInit, dispatcher: unknown): RequestInit {
    return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init;
}

/** Tagged stream delta so text and cumulative thinking keep their order. */
type StreamDelta = { kind: 'text' | 'thinking'; value: string };

/** Append an API path to a base URL without a query/fragment swallowing it
 *  (`https://h/v1?tenant=x` must become `https://h/v1/messages?tenant=x`). */
function endpointUrl(baseUrl: string, endpoint: string): string {
    const base = normalizeBaseUrl(baseUrl);
    try {
        const url = new URL(base);
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
        return url.toString();
    } catch {
        return `${base}/${endpoint}`;
    }
}

interface CompletionResult {
    text: string;
    toolCalls: LocalToolCall[];
    usage: LocalUsage | null;
    /** Provider-native assistant content to replay verbatim on the next request
     *  (Anthropic thinking blocks with signatures, Responses reasoning items).
     *  Required when a thinking/reasoning turn also calls a tool - without it
     *  the continuation is rejected or loses reasoning state. */
    providerBlocks?: unknown[];
    /** Captured reasoning text for transports that replay it as a top-level
     *  field instead of content blocks (Chat Completions `reasoning_content`). */
    reasoningContent?: string;
}

/** Dispatch to the transport the resolved API style calls for. */
/**
 * Append the volatile note to the outgoing request (chat transport).
 *
 * It must NOT be merged into a message that is REPLAYED on the next round:
 * merging made the last stored message's bytes differ from its replayed form
 * (the note is never stored), so the cached prefix ended one message EARLY -
 * every round and every turn. Measured effect: in a tool-using turn the newest
 * tool result (usually the largest message) could never be read from cache,
 * and across turns the previous turn was re-sent as a miss. That is the ~50%
 * cache rate against >98% for a harness that keeps its prefix stable.
 *
 * So the note rides its OWN trailing message - but only when that keeps the
 * turn roles ALTERNATING. Some strict OpenAI-compatible servers and every
 * Gemini endpoint reject consecutive same-role turns ("roles must alternate"),
 * and the last stored message is a `user` on the first round of a turn (the
 * prompt). In that one case the note is merged instead: nothing is cached
 * before the first request of a turn anyway, so the merge costs no cache hit,
 * while the tool rounds - where the large tool results live - still get the
 * separate, byte-stable trailing turn.
 */
export function appendTailNote(messages: LocalAgentMessage[], note: string): LocalAgentMessage[] {
    if (!note) return messages;
    if (!messages.length) return messages;
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
        const merged: LocalAgentMessage = typeof last.content === 'string'
            ? { ...last, content: `${last.content}\n\n${note}` }
            : Array.isArray(last.content)
                ? { ...last, content: [...last.content, { type: 'text', text: note }] }
                : { ...last, content: note };
        return [...messages.slice(0, -1), merged];
    }
    return [...messages, { role: 'user', content: note }];
}

/** Volatile context-awareness note appended as the LAST item of each request.
 *  It is deliberately NOT part of `messages` and NOT in the system prompt:
 *  keeping the prefix byte-stable across rounds is what makes prompt caching
 *  work (Anthropic cache_control, OpenAI/Google automatic prefix caching). */
/** The thinking-mode rejection that demands reasoning be replayed verbatim. */
const REASONING_CONTENT_REJECT_RE = /reasoning_content/i;

/**
 * Re-attach provider-native reasoning to outgoing assistant messages for the
 * Chat Completions transport.
 *
 * Unlike Anthropic/Gemini/Responses - which carry thinking inside content
 * blocks, served by `providerBlocks` - Chat Completions has no block channel
 * for it: reasoning rides a top-level `reasoning_content` field, and
 * thinking-mode APIs reject a replayed tool-call turn that omits it:
 *
 *   400 - The `reasoning_content` in the thinking mode must be passed back
 *   to the API.
 *
 * That killed whole turns: the stream parsed `reasoning_content` for display,
 * accumulated it, and dropped it at the return - so the SECOND round of any
 * tool-using thinking turn replayed an assistant message with no reasoning.
 * The field is added ONLY to messages that actually captured reasoning, so a
 * provider without the concept never sees an unknown field.
 *
 * `padMissing` is the recovery path for history persisted before capture
 * existed: the API demands the field, so send it empty rather than failing the
 * turn outright.
 */
export function withReasoningContent(
    messages: LocalAgentMessage[],
    padMissing = false,
): unknown[] {
    const needs = messages.some((m) => m.role === 'assistant'
        && (m.reasoningContent || (padMissing && (m.tool_calls?.length ?? 0) > 0)));
    if (!needs) return messages;
    return messages.map((m) => {
        if (m.role !== 'assistant') return m;
        // Strip the internal camelCase carriers before serializing: spreading
        // `m` would put BOTH `reasoningContent` AND `reasoning_content` (and
        // `providerBlocks`) on the wire, and a strict server that rejects the
        // unknown field returns a 400 whose text never matches this recovery.
        const { reasoningContent, providerBlocks: _providerBlocks, ...wire } = m;
        if (reasoningContent) return { ...wire, reasoning_content: reasoningContent };
        // Only tool-call turns need the field: a plain assistant reply has no
        // reasoning state the API can insist on.
        if (padMissing && (m.tool_calls?.length ?? 0) > 0) return { ...wire, reasoning_content: '' };
        return wire;
    });
}

/**
 * Project internal messages onto the Chat Completions wire.
 *
 * This transport passes stored messages through to the provider, so every
 * internal-only carrier that leaks here becomes part of the request BYTES. The
 * host rebuilds the next request's history from persisted rows that carry no
 * `isError`/`providerBlocks`, so a leaked field makes the replayed message
 * differ from the one the provider just cached - and prefix caching misses
 * from that message onward. Measured: every turn boundary re-sent the whole
 * previous turn (51%/75%/83% prefix coverage). `isError` is not part of the
 * OpenAI schema anyway; the Messages transport reads it off the stored
 * message (not this projection). `reasoningContent` is deliberately KEPT -
 * `withReasoningContent` turns it into the wire `reasoning_content` field
 * thinking-mode APIs require.
 */
export function chatWireMessages(messages: LocalAgentMessage[]): LocalAgentMessage[] {
    return messages.map((m) => {
        if (m.role === 'tool') {
            const { isError: _isError, ...wire } = m;
            return wire;
        }
        if (m.role === 'assistant') {
            const { providerBlocks: _providerBlocks, isError: _isError, ...wire } = m;
            return wire;
        }
        return m;
    });
}

function requestStreamingCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    if (request.apiStyle === 'messages') {
        return requestMessagesCompletion(request, messages, tailNote, onDelta, onThinking, onToolCall);
    }
    if (request.apiStyle === 'responses') {
        return requestResponsesCompletion(request, messages, tailNote, onDelta, onThinking, onToolCall);
    }
    if (request.apiStyle === 'google') {
        return requestGoogleCompletion(request, messages, tailNote, onDelta, onThinking, onToolCall);
    }
    return requestChatCompletion(request, messages, tailNote, onDelta, onThinking, onToolCall);
}

async function requestChatCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'chat/completions');
    // Wire messages are built ONCE so the 400 recovery below can rebuild the
    // same array (with padding) without reconstructing the tail note.
    const wireMessages = chatWireMessages(tailNote ? appendTailNote(messages, tailNote) : messages);
    const body: Record<string, unknown> = {
        model: request.model,
        // Safe for strict servers, and the prefix before it stays cacheable.
        // Reasoning is re-attached here (see withReasoningContent).
        messages: withReasoningContent(wireMessages),
        stream: true,
        stream_options: { include_usage: true },
    };
    if (request.tools.length) body.tools = toOpenAITools(request.tools);
    body.max_tokens = outputCapFor(request);
    if (request.temperature != null) body.temperature = request.temperature;
    // Reasoning effort. OpenRouter accepts the unified `reasoning: { effort }`
    // object for every reasoning model, while a bare top-level `reasoning_effort`
    // is only honored by the subset that advertises it - so gateways that expose
    // effort selection get the object. Direct OpenAI-compatible servers keep the
    // OpenAI field name.
    if (request.reasoningEffort) {
        if (isOpenRouterHost(request.baseUrl)) body.reasoning = { effort: request.reasoningEffort };
        else body.reasoning_effort = request.reasoningEffort;
    }
    // OpenAI prompt caching: a stable per-conversation key helps route requests
    // that share a prefix to the same cache machine. Only sent to hosts known
    // to accept it (see supportsPromptCacheKey); dropped on a 400 below.
    if (request.cacheKey && supportsPromptCacheKey(request.baseUrl)) {
        body.prompt_cache_key = request.cacheKey;
    }
    // Keep the tool definitions (cacheable prefix) and only forbid CALLS.
    if (request.tools.length && request.toolChoice === 'none') body.tool_choice = 'none';

    // Relay the caller's cancellation AND impose a headers deadline: a
    // wedged local server that accepts the connection but never answers
    // must not hang the agent loop. The idle deadline in readStreamChunk
    // covers the body phase.
    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    // One first-byte deadline PER attempt: a slow first 400 must not eat the
    // retry's own deadline, nor replace a tagged provider HTTP error with a
    // timeout while its body is being read. The body phase has its own idle
    // deadline (readStreamChunk).
    const send = async (payload: Record<string, unknown>): Promise<Response> => {
        const headersTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
        try {
            return await fetch(url, withDispatcher({
                method: 'POST',
                headers: makeHeaders(request.apiKey, request.sessionId),
                body: JSON.stringify(payload),
                signal: controller.signal,
            }, request.dispatcher));
        } finally {
            clearTimeout(headersTimer);
        }
    };

    try {
    let response: Response;
    try {
        response = await send(body);
        // Strict OpenAI-compatible servers reject non-standard or unsupported
        // fields with a 400. Drop them one at a time - `stream_options` first
        // (usage then comes from the final chunk if the server sends it), then
        // the DERIVED `max_tokens`, which not every gateway accepts - and
        // retry rather than failing the whole turn. An explicitly requested
        // cap is never dropped: that is the caller's intent, so the 400 stands.
        for (let attempt = 0; attempt < 3 && !response.ok && response.status === 400; attempt++) {
            const text = await response.text().catch(() => '');
            if (body.stream_options && STREAM_OPTIONS_REJECT_RE.test(text)) {
                delete body.stream_options;
            } else if (request.maxTokens == null && body.max_tokens != null && MAX_TOKENS_REJECT_RE.test(text)) {
                delete body.max_tokens;
            } else if (REASONING_CONTENT_REJECT_RE.test(text)) {
                // Thinking mode demands the assistant turn's reasoning BACK.
                // Checked BEFORE the generic reasoning-effort branch, which also
                // matches this text (it contains "thinking") and would only
                // delete `reasoning_effort` - a no-op when the level is default,
                // which let the 400 escape and killed the turn.
                body.messages = withReasoningContent(wireMessages, true);
            } else if ((body.reasoning_effort != null || body.reasoning != null) && REASONING_REJECT_RE.test(text)) {
                // The model/gateway does not accept the reasoning effort - drop
                // it and keep the run instead of failing on a UI convenience.
                delete body.reasoning_effort;
                delete body.reasoning;
            } else if (body.prompt_cache_key != null && PROMPT_CACHE_KEY_REJECT_RE.test(text)) {
                // Gateway has no prompt-cache routing key; OpenAI's automatic
                // routing still applies. Retry without the hint.
                delete body.prompt_cache_key;
            } else if (body.tool_choice != null && TOOL_CHOICE_REJECT_RE.test(text)) {
                // No tool-choice control: fall back to dropping the tool
                // definitions. The wrap-up still cannot call a tool, but its
                // cached prefix is lost - the old behavior.
                delete body.tool_choice;
                delete body.tools;
            } else {
                throw providerHttpError(400, text);
            }
            response = await send(body);
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw transportTimeoutError(`Model request timed out (no response for ${FIRST_BYTE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerHttpError(response.status, text);
    }

    if (!response.body) {
        throw new Error('Model returned no response body.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage: LocalUsage | null = null;
    const toolDeltas = new Map<number, { id: string; name: string; arguments: string }>();

    const consume = (payload: string) => {
        if (payload === '[DONE]') return;
        let json: any;
        try {
            json = JSON.parse(payload);
        } catch {
            return;
        }

        const rawUsage = json?.usage;
        if (rawUsage) {
            // Cache-hit accounting differs per provider: OpenAI nests it under
            // prompt_tokens_details, Anthropic-style gateways use
            // cache_read_input_tokens, DeepSeek uses prompt_cache_hit_tokens.
            const cachedRaw = rawUsage.prompt_tokens_details?.cached_tokens
                ?? rawUsage.cache_read_input_tokens
                ?? rawUsage.prompt_cache_hit_tokens;
            // Cache-WRITE tokens are reported separately (OpenAI
            // `cache_write_tokens`, Anthropic-style `cache_creation_input_tokens`)
            // and are billed at 1.25x input, so they must reach cost accounting.
            const writeRaw = rawUsage.prompt_tokens_details?.cache_write_tokens
                ?? rawUsage.cache_creation_input_tokens;
            usage = {
                promptTokens: Number.isFinite(rawUsage.prompt_tokens) ? rawUsage.prompt_tokens : null,
                completionTokens: Number.isFinite(rawUsage.completion_tokens) ? rawUsage.completion_tokens : null,
                totalTokens: Number.isFinite(rawUsage.total_tokens) ? rawUsage.total_tokens : null,
                cachedTokens: Number.isFinite(cachedRaw) ? cachedRaw : null,
                cacheWriteTokens: Number.isFinite(writeRaw) ? writeRaw : null,
            };
        }

        const delta = json?.choices?.[0]?.delta;
        if (!delta) return;

        const textDelta = typeof delta.content === 'string' ? delta.content : '';
        if (textDelta) {
            text += textDelta;
            onDelta(textDelta);
        }

        // Reasoning models stream chain-of-thought separately from content.
        // DeepSeek/QwQ use `reasoning_content`; some OpenAI-compatible gateways
        // (e.g. OpenRouter) use `reasoning`. The host's `thinking` event carries
        // a CUMULATIVE snapshot, so accumulate and re-emit the whole block.
        const reasoningDelta = typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
                ? delta.reasoning
                : '';
        if (reasoningDelta) {
            reasoning += reasoningDelta;
            onThinking?.(reasoning);
        }

        const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        if (calls.length) onToolCall?.();
        for (const call of calls) {
            const index = Number(call.index ?? 0);
            const current = toolDeltas.get(index) ?? {
                id: '',
                name: '',
                arguments: '',
            };

            if (call.id) current.id = String(call.id);
            if (call.function?.name) current.name += String(call.function.name);
            if (call.function?.arguments) current.arguments += String(call.function.arguments);

            toolDeltas.set(index, current);
        }
    };

    while (true) {
        const { value, done } = await readStreamChunk(reader);
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        const parsed = extractSseData(buffer);
        buffer = parsed.remainder;
        for (const payload of parsed.events) consume(payload);

        if (done) break;
    }

    const toolCalls: LocalToolCall[] = [];
    for (const call of toolDeltas.values()) {
        if (!call.id || !call.name) continue;
        toolCalls.push({
            id: call.id,
            name: call.name,
            argumentsJson: call.arguments,
            arguments: parseArguments(call.arguments),
        });
    }

    // `reasoning` MUST ride along: it is the only carrier of the thinking state
    // for this transport, and the next round has to replay it (see
    // withReasoningContent). Dropping it here is what caused the 400.
    return { text, toolCalls, usage, reasoningContent: reasoning || undefined };
    } finally {
        // Always detach: a throw during fetch/read/consume must not leave the
        // listener bound to the caller's long-lived run signal (parity with the
        // Messages/Responses/Google transports).
        outerSignal.removeEventListener('abort', onOuterAbort);
    }
}

// --- Anthropic Messages API (/messages) -------------------------------------
// Used by OpenCode Zen/Go for claude-*, qwen* and minimax-* models. The wire
// shape differs from chat/completions: system is a top-level param, content is
// a block array, tool calls are `tool_use` blocks and tool results are
// `tool_result` blocks inside a USER message.

function makeMessagesHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
    const headers = makeHeaders(apiKey, sessionId);
    // Anthropic uses x-api-key; OpenAI-compatible gateways use Bearer. Send
    // both so either front end works (the extra header is ignored).
    if (apiKey) headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
    return headers;
}

function imageBlockFromDataUrl(url: string): Record<string, unknown> | null {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (!match) return null;
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function messagesContentBlocks(content: LocalAgentMessage['content']): any[] {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (!Array.isArray(content)) return [];
    const blocks: any[] = [];
    for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
            const image = imageBlockFromDataUrl(part.image_url.url);
            blocks.push(image ?? { type: 'image', source: { type: 'url', url: part.image_url.url } });
        }
    }
    return blocks;
}

function toMessagesBody(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote = '',
): Record<string, unknown> {
    const systemParts: string[] = [];
    const out: any[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
            continue;
        }
        if (msg.role === 'user') {
            const blocks = messagesContentBlocks(msg.content);
            if (!blocks.length) continue;
            const last = out[out.length - 1];
            if (last && last.role === 'user') last.content.push(...blocks);
            else out.push({ role: 'user', content: blocks });
            continue;
        }
        if (msg.role === 'assistant') {
            // Prefer the provider-native blocks captured while streaming
            // (thinking + signature + tool_use). Reconstructing from text and
            // tool_calls would drop the thinking state the API requires when a
            // thinking turn is continued.
            if (Array.isArray(msg.providerBlocks) && msg.providerBlocks.length) {
                out.push({ role: 'assistant', content: msg.providerBlocks });
                continue;
            }
            const blocks: any[] = [];
            if (typeof msg.content === 'string' && msg.content) {
                blocks.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
                }
            }
            for (const call of msg.tool_calls ?? []) {
                blocks.push({
                    type: 'tool_use',
                    id: call.id,
                    name: call.function.name,
                    input: parseArguments(call.function.arguments),
                });
            }
            if (blocks.length) out.push({ role: 'assistant', content: blocks });
            continue;
        }
        if (msg.role === 'tool') {
            const block: Record<string, unknown> = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : '',
            };
            // Surface failures so the model can react instead of treating a
            // denied/failed tool as success.
            if (msg.isError) block.is_error = true;
            const last = out[out.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content)
                && last.content.every((b: any) => b.type === 'tool_result')) {
                last.content.push(block);
            } else {
                out.push({ role: 'user', content: [block] });
            }
            continue;
        }
    }

    // Anthropic requires tool_result blocks to come FIRST in a user turn.
    for (const turn of out) {
        if (turn.role === 'user' && Array.isArray(turn.content)
            && turn.content.some((b: any) => b.type === 'tool_result')) {
            turn.content.sort((a: any, b: any) => (a.type === 'tool_result' ? 0 : 1) - (b.type === 'tool_result' ? 0 : 1));
        }
    }

    // Second cache breakpoint at the end of the STORED history (everything
    // before the volatile note below). It advances each round, so the growing
    // conversation is cached incrementally rather than only tools + system.
    // Anthropic allows up to 4 breakpoints; two is plenty here.
    const lastStored = out[out.length - 1];
    if (lastStored && Array.isArray(lastStored.content) && lastStored.content.length) {
        const blocks = lastStored.content;
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    }

    // Volatile note rides the tail: merged into a trailing user turn so the
    // cached prefix (tools + system + history) is untouched. The breakpoint
    // above already sits on the last STORED block, so the note is outside the
    // cached prefix and the prefix stays byte-stable across rounds. tool_result
    // blocks stay first in their own turn, which the sort above guarantees.
    if (tailNote) {
        const last = out[out.length - 1];
        if (last && last.role === 'user') last.content.push({ type: 'text', text: tailNote });
        else out.push({ role: 'user', content: [{ type: 'text', text: tailNote }] });
    }

    const body: Record<string, unknown> = {
        model: request.model,
        // max_tokens is REQUIRED by the Messages API. With no explicit cap,
        // derive a generous one from the context window rather than a silent
        // 4096 that truncates long outputs.
        max_tokens: outputCapFor(request),
        messages: out,
        stream: true,
    };
    const system = systemParts.filter(Boolean).join('\n\n');
    // The system prompt is the stable, cacheable prefix: mark its end as an
    // ephemeral cache breakpoint so Anthropic caches tools + system. The
    // volatile status/hint deliberately lives in the trailing note instead.
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (request.tools.length) {
        body.tools = request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
        }));
        // Keep the tool definitions (cached with tools + system) and only
        // forbid CALLS for the wrap-up. Anthropic supports { type: 'none' }.
        if (request.toolChoice === 'none') body.tool_choice = { type: 'none' };
    }
    if (request.temperature != null) body.temperature = request.temperature;
    // Extended thinking: budget_tokens is required, max_tokens MUST exceed it,
    // and Anthropic rejects a modified temperature alongside thinking - so the
    // budget raises the cap and the temperature is dropped when enabled.
    // `none` disables thinking: send no thinking block at all.
    if (request.reasoningEffort && request.reasoningEffort !== 'none') {
        const budget = thinkingBudgetFor(request.reasoningEffort);
        if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 4096;
        body.thinking = { type: 'enabled', budget_tokens: budget };
        delete body.temperature;
    }
    return body;
}

/** Remove every cache_control breakpoint from a Messages body (a gateway
 *  rejected the field). Returns true when something was removed. */
function stripCacheControl(body: Record<string, unknown>): boolean {
    let removed = false;
    const visit = (block: any) => {
        if (block && typeof block === 'object' && block.cache_control) {
            delete block.cache_control;
            removed = true;
        }
    };
    const system = body.system as any[] | undefined;
    if (Array.isArray(system)) system.forEach(visit);
    const messages = body.messages as any[] | undefined;
    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (Array.isArray(message?.content)) message.content.forEach(visit);
        }
    }
    return removed;
}

function mergeMessagesUsage(raw: any, previous: LocalUsage | null): LocalUsage {
    // Anthropic reports `input_tokens` as the UNCACHED input only; the
    // cache-creation and cache-read portions are separate fields. The total
    // prompt - what actually occupies the window - is their sum, otherwise a
    // cached long prefix makes compaction think there is room to spare.
    const num = (value: unknown): number => (Number.isFinite(value) ? (value as number) : 0);
    const totalInput = num(raw?.input_tokens)
        + num(raw?.cache_creation_input_tokens)
        + num(raw?.cache_read_input_tokens);
    const input = totalInput > 0 ? totalInput : previous?.promptTokens ?? null;
    const output = Number.isFinite(raw?.output_tokens) ? raw.output_tokens : previous?.completionTokens ?? null;
    const cached = Number.isFinite(raw?.cache_read_input_tokens) ? raw.cache_read_input_tokens : previous?.cachedTokens ?? null;
    // Newly-written cache tokens are billed at 1.25x input; carry them out of
    // `input_tokens` so cost does not treat them as ordinary uncached input.
    const cacheWrite = Number.isFinite(raw?.cache_creation_input_tokens)
        ? raw.cache_creation_input_tokens
        : previous?.cacheWriteTokens ?? null;
    return { promptTokens: input, completionTokens: output, totalTokens: null, cachedTokens: cached, cacheWriteTokens: cacheWrite };
}

async function requestMessagesCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'messages');
    const body = toMessagesBody(request, messages, tailNote);

    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    // One first-byte deadline PER attempt: a slow first 400 must not eat the
    // retry's own deadline, nor replace a tagged provider HTTP error with a
    // timeout while its body is being read. The body phase has its own idle
    // deadline (readStreamChunk).
    const send = async (payload: Record<string, unknown>): Promise<Response> => {
        const headersTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
        try {
            return await fetch(url, withDispatcher({
                method: 'POST',
                headers: makeMessagesHeaders(request.apiKey, request.sessionId),
                body: JSON.stringify(payload),
                signal: controller.signal,
            }, request.dispatcher));
        } finally {
            clearTimeout(headersTimer);
        }
    };

    try {
    let response: Response;
    try {
        response = await send(body);
        // Some Messages-compatible gateways reject `cache_control` and others
        // reject extended thinking. Strip them one at a time (bounded) rather
        // than failing the turn - caching and thinking are optimizations.
        for (let attempt = 0; attempt < 3 && !response.ok && response.status === 400; attempt++) {
            const text = await response.text().catch(() => '');
            if (/cache_control/i.test(text) && stripCacheControl(body)) {
                response = await send(body);
            } else if (body.thinking && REASONING_REJECT_RE.test(text)) {
                // Gateway/model refuses extended thinking - drop it, restore
                // the temperature and output cap we suppressed for thinking,
                // and let the runtime's own default apply.
                delete body.thinking;
                if (request.temperature != null) body.temperature = request.temperature;
                body.max_tokens = outputCapFor(request);
                response = await send(body);
            } else if (body.tool_choice != null && TOOL_CHOICE_REJECT_RE.test(text)) {
                // No tool-choice control: drop the definitions too, so the
                // wrap-up still cannot call a tool (cached prefix is lost).
                delete body.tool_choice;
                delete body.tools;
                response = await send(body);
            } else {
                throw providerHttpError(400, text);
            }
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw transportTimeoutError(`Model request timed out (no response for ${FIRST_BYTE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerHttpError(response.status, text);
    }
    if (!response.body) throw new Error('Model returned no response body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage: LocalUsage | null = null;
    const toolDeltas = new Map<number | string, { id: string; name: string; arguments: string }>();
    // Provider-native content blocks, in emission order, so a thinking +
    // tool_use turn can be replayed verbatim on the continuation request.
    const blockOrder: number[] = [];
    const blocks = new Map<number, any>();
    const partialJson = new Map<number, string>();

    const consume = (payload: string) => {
        let json: any;
        try {
            json = JSON.parse(payload);
        } catch {
            return;
        }
        switch (json?.type) {
            case 'message_start':
                if (json.message?.usage) usage = mergeMessagesUsage(json.message.usage, usage);
                break;
            case 'content_block_start': {
                const block = json.content_block;
                const index = Number(json.index ?? 0);
                if (block?.type === 'tool_use') {
                    onToolCall?.();
                    toolDeltas.set(index, { id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: '' });
                    blocks.set(index, { type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: {} });
                } else if (block?.type === 'thinking') {
                    const initial = typeof block.thinking === 'string' ? block.thinking : '';
                    if (initial) {
                        reasoning += initial;
                        onThinking?.(reasoning);
                    }
                    blocks.set(index, {
                        type: 'thinking',
                        thinking: initial,
                        signature: typeof block.signature === 'string' ? block.signature : '',
                    });
                } else if (block?.type === 'redacted_thinking') {
                    blocks.set(index, { type: 'redacted_thinking', data: block.data });
                } else if (block?.type === 'text') {
                    const initial = typeof block.text === 'string' ? block.text : '';
                    if (initial) {
                        text += initial;
                        onDelta(initial);
                    }
                    blocks.set(index, { type: 'text', text: initial });
                } else if (block?.type) {
                    blocks.set(index, { ...block });
                }
                if (blocks.has(index) && !blockOrder.includes(index)) blockOrder.push(index);
                break;
            }
            case 'content_block_delta': {
                const delta = json.delta;
                const index = Number(json.index ?? 0);
                const block = blocks.get(index);
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    text += delta.text;
                    onDelta(delta.text);
                    if (block) block.text = (block.text ?? '') + delta.text;
                } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                    reasoning += delta.thinking;
                    onThinking?.(reasoning);
                    if (block) block.thinking = (block.thinking ?? '') + delta.thinking;
                } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
                    if (block) block.signature = (block.signature ?? '') + delta.signature;
                } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                    onToolCall?.();
                    const current = toolDeltas.get(index);
                    if (current) current.arguments += delta.partial_json;
                    partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
                }
                break;
            }
            case 'content_block_stop': {
                const index = Number(json.index ?? 0);
                const block = blocks.get(index);
                if (block?.type === 'tool_use') {
                    const raw = partialJson.get(index) ?? '';
                    if (raw) block.input = parseArguments(raw);
                }
                break;
            }
            case 'message_delta':
                if (json.usage) usage = mergeMessagesUsage(json.usage, usage);
                break;
            case 'error':
                throw new Error(`Model stream error: ${json.error?.message ?? 'unknown error'}`);
        }
    };

    while (true) {
        const { value, done } = await readStreamChunk(reader);
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const parsed = extractSseData(buffer);
        buffer = parsed.remainder;
        for (const payload of parsed.events) consume(payload);
        if (done) break;
    }
    const providerBlocks = blockOrder.map((index) => blocks.get(index)).filter(Boolean);
    return { ...finalizeCompletion(text, toolDeltas, usage), providerBlocks };
    } finally {
        // Always detach: a throw during fetch/read/consume must not leave the
        // listener bound to the caller's long-lived run signal.
        outerSignal.removeEventListener('abort', onOuterAbort);
    }
}

// --- OpenAI Responses API (/responses) --------------------------------------
// Used by OpenCode Zen/Go for gpt-*, grok-* and muse-spark-* models. Streams
// typed events (`response.output_text.delta`, `response.function_call_arguments
// .delta`, `response.completed`) instead of chat-completion chunks.

function responsesUserContent(content: LocalAgentMessage['content']): any[] {
    if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
    if (!Array.isArray(content)) return [];
    const out: any[] = [];
    for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            out.push({ type: 'input_text', text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
            out.push({ type: 'input_image', image_url: part.image_url.url });
        }
    }
    return out;
}

function toResponsesBody(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote = '',
): Record<string, unknown> {
    const instructions: string[] = [];
    const input: any[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string' && msg.content) instructions.push(msg.content);
            continue;
        }
        if (msg.role === 'user') {
            const content = responsesUserContent(msg.content);
            if (content.length) input.push({ role: 'user', content });
            continue;
        }
        if (msg.role === 'assistant') {
            // Prefer the provider-native output items (reasoning + message +
            // function_call) captured while streaming; the Responses API wants
            // them replayed verbatim so reasoning state survives a tool turn.
            if (Array.isArray(msg.providerBlocks) && msg.providerBlocks.length) {
                for (const item of msg.providerBlocks) input.push(item);
                continue;
            }
            const content: any[] = [];
            if (typeof msg.content === 'string' && msg.content) {
                content.push({ type: 'output_text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) content.push({ type: 'output_text', text: part.text });
                }
            }
            if (content.length) input.push({ role: 'assistant', content });
            for (const call of msg.tool_calls ?? []) {
                input.push({
                    type: 'function_call',
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments || '{}',
                });
            }
            continue;
        }
        if (msg.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: typeof msg.content === 'string' ? msg.content : '',
            });
            continue;
        }
    }

    // Volatile note as a trailing developer item - the Responses equivalent of
    // a system note, placed after the stable instructions prefix.
    if (tailNote) {
        input.push({ role: 'developer', content: [{ type: 'input_text', text: tailNote }] });
    }

    const body: Record<string, unknown> = { model: request.model, input, stream: true };
    const sys = instructions.filter(Boolean).join('\n\n');
    if (sys) body.instructions = sys;
    if (request.tools.length) {
        body.tools = request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        }));
    }
    body.max_output_tokens = outputCapFor(request);
    if (request.temperature != null) body.temperature = request.temperature;
    // Responses reasoning models take an effort object (chat uses
    // `reasoning_effort`); forward the user's thinking level.
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
    // OpenAI prompt caching routing hint (see requestChatCompletion).
    if (request.cacheKey && supportsPromptCacheKey(request.baseUrl)) {
        body.prompt_cache_key = request.cacheKey;
    }
    // Keep the tool definitions (cacheable prefix) and only forbid CALLS.
    if (request.tools.length && request.toolChoice === 'none') body.tool_choice = 'none';
    return body;
}

function responsesUsage(raw: any): LocalUsage {
    const cached = raw?.input_tokens_details?.cached_tokens;
    const cacheWrite = raw?.input_tokens_details?.cache_write_tokens;
    return {
        promptTokens: Number.isFinite(raw?.input_tokens) ? raw.input_tokens : null,
        completionTokens: Number.isFinite(raw?.output_tokens) ? raw.output_tokens : null,
        totalTokens: Number.isFinite(raw?.total_tokens) ? raw.total_tokens : null,
        cachedTokens: Number.isFinite(cached) ? cached : null,
        cacheWriteTokens: Number.isFinite(cacheWrite) ? cacheWrite : null,
    };
}

async function requestResponsesCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'responses');
    const body = toResponsesBody(request, messages, tailNote);

    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    // One first-byte deadline PER attempt: a slow first 400 must not eat the
    // retry's own deadline, nor replace a tagged provider HTTP error with a
    // timeout while its body is being read. The body phase has its own idle
    // deadline (readStreamChunk).
    const send = async (payload: Record<string, unknown>): Promise<Response> => {
        const headersTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
        try {
            return await fetch(url, withDispatcher({
                method: 'POST',
                headers: makeHeaders(request.apiKey, request.sessionId),
                body: JSON.stringify(payload),
                signal: controller.signal,
            }, request.dispatcher));
        } finally {
            clearTimeout(headersTimer);
        }
    };

    try {
    let response: Response;
    try {
        response = await send(body);
        // Not every Responses-compatible gateway accepts a derived
        // `max_output_tokens` or the reasoning effort object; drop them one at
        // a time (bounded) rather than fail the turn. An explicitly requested
        // cap is never dropped.
        for (let attempt = 0; attempt < 3 && !response.ok && response.status === 400; attempt++) {
            const text = await response.text().catch(() => '');
            if (request.maxTokens == null && body.max_output_tokens != null && MAX_TOKENS_REJECT_RE.test(text)) {
                delete body.max_output_tokens;
                response = await send(body);
            } else if (body.reasoning && REASONING_REJECT_RE.test(text)) {
                // Model/gateway rejects the reasoning effort object - retry
                // without it so the run proceeds at the runtime default.
                delete body.reasoning;
                response = await send(body);
            } else if (body.prompt_cache_key != null && PROMPT_CACHE_KEY_REJECT_RE.test(text)) {
                // No prompt-cache routing key on this gateway; automatic
                // routing still applies. Retry without the hint.
                delete body.prompt_cache_key;
                response = await send(body);
            } else if (body.tool_choice != null && TOOL_CHOICE_REJECT_RE.test(text)) {
                // No tool-choice control: drop the definitions too, so the
                // wrap-up still cannot call a tool (cached prefix is lost).
                delete body.tool_choice;
                delete body.tools;
                response = await send(body);
            } else {
                throw providerHttpError(400, text);
            }
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw transportTimeoutError(`Model request timed out (no response for ${FIRST_BYTE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerHttpError(response.status, text);
    }
    if (!response.body) throw new Error('Model returned no response body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage: LocalUsage | null = null;
    const toolDeltas = new Map<number | string, { id: string; name: string; arguments: string }>();
    // Output items (reasoning, message, function_call) in order, so a reasoning
    // + tool-call turn can be replayed verbatim on the continuation request.
    const itemsByIndex = new Map<number, any>();
    let completedItems: any[] | null = null;

    const consume = (payload: string) => {
        let json: any;
        try {
            json = JSON.parse(payload);
        } catch {
            return;
        }
        switch (json?.type) {
            case 'response.output_text.delta':
                if (typeof json.delta === 'string' && json.delta) {
                    text += json.delta;
                    onDelta(json.delta);
                }
                break;
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                if (typeof json.delta === 'string' && json.delta) {
                    reasoning += json.delta;
                    onThinking?.(reasoning);
                }
                break;
            case 'response.output_item.added': {
                const item = json.item;
                if (item) itemsByIndex.set(Number(json.output_index ?? 0), item);
                if (item?.type === 'function_call') {
                    onToolCall?.();
                    // Key by the ITEM id: arguments deltas reference it.
                    toolDeltas.set(String(item.id ?? item.call_id ?? ''), {
                        id: String(item.call_id ?? item.id ?? ''),
                        name: String(item.name ?? ''),
                        arguments: '',
                    });
                }
                break;
            }
            case 'response.output_item.done': {
                // The done event carries the COMPLETE item (with arguments and
                // any reasoning payload) - the best thing to replay.
                if (json.item) itemsByIndex.set(Number(json.output_index ?? 0), json.item);
                break;
            }
            case 'response.function_call_arguments.delta': {
                onToolCall?.();
                const current = toolDeltas.get(String(json.item_id ?? ''));
                if (current && typeof json.delta === 'string') current.arguments += json.delta;
                break;
            }
            case 'response.completed':
                if (json.response?.usage) usage = responsesUsage(json.response.usage);
                if (Array.isArray(json.response?.output)) completedItems = json.response.output;
                break;
            case 'response.failed':
                throw new Error(`Model response failed: ${json.response?.error?.message ?? 'unknown error'}`);
            case 'error':
                throw new Error(`Model stream error: ${json.error?.message ?? 'unknown error'}`);
        }
    };

    while (true) {
        const { value, done } = await readStreamChunk(reader);
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const parsed = extractSseData(buffer);
        buffer = parsed.remainder;
        for (const payload of parsed.events) consume(payload);
        if (done) break;
    }
    // If the stream omitted output_item.done / completed.output, the stored
    // function_call item still has empty arguments - backfill from the
    // accumulated deltas so the continuation isn't sent with an empty call.
    for (const item of itemsByIndex.values()) {
        if (item?.type === 'function_call' && !item.arguments) {
            const call = toolDeltas.get(String(item.id ?? item.call_id ?? ''));
            if (call?.arguments) item.arguments = call.arguments;
        }
    }
    const providerBlocks = completedItems
        ?? [...itemsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    return { ...finalizeCompletion(text, toolDeltas, usage), providerBlocks };
    } finally {
        // Always detach: a throw during fetch/read/consume must not leave the
        // listener bound to the caller's long-lived run signal.
        outerSignal.removeEventListener('abort', onOuterAbort);
    }
}

// --- Google Generative Language API (:streamGenerateContent) ----------------
// Used by OpenCode Zen for gemini-* models. Different again: contents/parts,
// functionCall/functionResponse (by NAME, not id), and thought parts.

function makeGoogleHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
    const headers = makeHeaders(apiKey, sessionId);
    if (apiKey) headers.set('x-goog-api-key', apiKey);
    return headers;
}

/** Best-effort MIME type from a URL's extension (Google's fileData needs one). */
function guessImageMime(url: string): string {
    const path = url.split(/[?#]/)[0].toLowerCase();
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
}

function googlePartsFromContent(content: LocalAgentMessage['content']): any[] {
    if (typeof content === 'string') return content ? [{ text: content }] : [];
    if (!Array.isArray(content)) return [];
    const parts: any[] = [];
    for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
            parts.push({ text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
            const match = /^data:([^;]+);base64,(.+)$/i.exec(part.image_url.url);
            if (match) {
                parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            } else if (/^https?:\/\//i.test(part.image_url.url)) {
                // Remote images can't be inlined; hand Google the URI (it
                // fetches/infer the type) instead of silently dropping it.
                parts.push({ fileData: { fileUri: part.image_url.url, mimeType: guessImageMime(part.image_url.url) } });
            }
        }
    }
    return parts;
}

function toGoogleBody(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote = '',
): Record<string, unknown> {
    const systemParts: string[] = [];
    const contents: any[] = [];
    const toolNameById = new Map<string, string>();

    for (const msg of messages) {
        if (msg.role === 'system') {
            if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
            continue;
        }
        if (msg.role === 'user') {
            const parts = googlePartsFromContent(msg.content);
            if (!parts.length) continue;
            const last = contents[contents.length - 1];
            if (last && last.role === 'user') last.parts.push(...parts);
            else contents.push({ role: 'user', parts });
            continue;
        }
        if (msg.role === 'assistant') {
            if (Array.isArray(msg.providerBlocks) && msg.providerBlocks.length) {
                // Replay Google's own model parts (functionCall + thoughtSignature).
                const parts = msg.providerBlocks as any[];
                const last = contents[contents.length - 1];
                if (last && last.role === 'model') last.parts.push(...parts);
                else contents.push({ role: 'model', parts: [...parts] });
                for (const call of msg.tool_calls ?? []) toolNameById.set(call.id, call.function.name);
                continue;
            }
            const parts: any[] = [];
            if (typeof msg.content === 'string' && msg.content) {
                parts.push({ text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) parts.push({ text: part.text });
                }
            }
            for (const call of msg.tool_calls ?? []) {
                toolNameById.set(call.id, call.function.name);
                parts.push({ functionCall: { name: call.function.name, args: parseArguments(call.function.arguments) } });
            }
            if (parts.length) contents.push({ role: 'model', parts });
            continue;
        }
        if (msg.role === 'tool') {
            // Google matches a function response by NAME, not by call id.
            const name = toolNameById.get(msg.tool_call_id ?? '') ?? 'tool';
            const part = {
                functionResponse: { name, response: { result: typeof msg.content === 'string' ? msg.content : '' } },
            };
            const last = contents[contents.length - 1];
            if (last && last.role === 'user' && last.parts.every((p: any) => p.functionResponse)) {
                last.parts.push(part);
            } else {
                contents.push({ role: 'user', parts: [part] });
            }
            continue;
        }
    }

    // Volatile note: Google has no mid-conversation system role, so it rides
    // the last user content (or a fresh one). Gemini REQUIRES alternating
    // user/model contents, so a separate trailing user turn after an existing
    // user turn (functionResponse or prompt) is rejected - merge there. The
    // stable systemInstruction prefix stays byte-identical for implicit caching.
    if (tailNote) {
        const last = contents[contents.length - 1];
        if (last && last.role === 'user') last.parts.push({ text: tailNote });
        else contents.push({ role: 'user', parts: [{ text: tailNote }] });
    }

    const body: Record<string, unknown> = { contents };
    const system = systemParts.filter(Boolean).join('\n\n');
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (request.tools.length) {
        body.tools = [{
            functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            })),
        }];
        // Keep the tool definitions (cacheable prefix) and only forbid CALLS.
        if (request.toolChoice === 'none') {
            body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        }
    }
    const generationConfig: Record<string, unknown> = {};
    let outputCap = outputCapFor(request);
    // Gemini's thinking budget is drawn from maxOutputTokens, so the cap must
    // clear the budget or the answer is starved of output room. includeThoughts
    // makes the model stream its reasoning parts (parsed as `thinking`).
    if (request.reasoningEffort) {
        const budget = thinkingBudgetFor(request.reasoningEffort);
        if (outputCap <= budget) outputCap = budget + 4096;
        generationConfig.thinkingConfig = {
            thinkingBudget: budget,
            // `none` disables reasoning; requesting the thought trace would be
            // contradictory (and some gateways reject it).
            includeThoughts: request.reasoningEffort !== 'none',
        };
    }
    generationConfig.maxOutputTokens = outputCap;
    if (request.temperature != null) generationConfig.temperature = request.temperature;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    return body;
}

function googleUsage(raw: any): LocalUsage {
    const cached = raw?.cachedContentTokenCount;
    return {
        promptTokens: Number.isFinite(raw?.promptTokenCount) ? raw.promptTokenCount : null,
        completionTokens: Number.isFinite(raw?.candidatesTokenCount) ? raw.candidatesTokenCount : null,
        totalTokens: Number.isFinite(raw?.totalTokenCount) ? raw.totalTokenCount : null,
        cachedTokens: Number.isFinite(cached) ? cached : null,
    };
}

async function requestGoogleCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    const base = endpointUrl(
        request.baseUrl,
        `models/${encodeURIComponent(request.model)}:streamGenerateContent`,
    );
    const url = `${base}${base.includes('?') ? '&' : '?'}alt=sse`;
    const body = toGoogleBody(request, messages, tailNote);

    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    // One first-byte deadline PER attempt: a slow first 400 must not eat the
    // retry's own deadline, nor replace a tagged provider HTTP error with a
    // timeout while its body is being read. The body phase has its own idle
    // deadline (readStreamChunk).
    const send = async (payload: Record<string, unknown>): Promise<Response> => {
        const headersTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS);
        try {
            return await fetch(url, withDispatcher({
                method: 'POST',
                headers: makeGoogleHeaders(request.apiKey, request.sessionId),
                body: JSON.stringify(payload),
                signal: controller.signal,
            }, request.dispatcher));
        } finally {
            clearTimeout(headersTimer);
        }
    };

    try {
    let response: Response;
    try {
        response = await send(body);
        // Some Google-compatible gateways reject `generationConfig` fields
        // they do not support; drop them one at a time (bounded). An
        // explicitly requested cap is never dropped.
        for (let attempt = 0; attempt < 3 && !response.ok && response.status === 400; attempt++) {
            const text = await response.text().catch(() => '');
            const config = body.generationConfig as Record<string, unknown> | undefined;
            if (request.maxTokens == null && config?.maxOutputTokens != null && MAX_TOKENS_REJECT_RE.test(text)) {
                delete config.maxOutputTokens;
                if (!Object.keys(config).length) delete body.generationConfig;
                response = await send(body);
            } else if (config?.thinkingConfig && REASONING_REJECT_RE.test(text)) {
                // Gateway rejects thinkingConfig - drop it and restore the
                // output cap the thinking budget had raised, rather than
                // failing the turn.
                delete config.thinkingConfig;
                if (config.maxOutputTokens != null) config.maxOutputTokens = outputCapFor(request);
                if (!Object.keys(config).length) delete body.generationConfig;
                response = await send(body);
            } else if (body.toolConfig && TOOL_CHOICE_REJECT_RE.test(text)) {
                // No functionCallingConfig control: drop the declarations too,
                // so the wrap-up still cannot call a tool (prefix is lost).
                delete body.toolConfig;
                delete body.tools;
                response = await send(body);
            } else {
                throw providerHttpError(400, text);
            }
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw transportTimeoutError(`Model request timed out (no response for ${FIRST_BYTE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerHttpError(response.status, text);
    }
    if (!response.body) throw new Error('Model returned no response body.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage: LocalUsage | null = null;
    const toolDeltas = new Map<number | string, { id: string; name: string; arguments: string }>();
    const modelParts: any[] = [];

    const consume = (payload: string) => {
        let json: any;
        try {
            json = JSON.parse(payload);
        } catch {
            return;
        }
        if (json?.error) throw new Error(`Model stream error: ${json.error?.message ?? 'unknown error'}`);
        if (json?.usageMetadata) usage = googleUsage(json.usageMetadata);
        const parts = json?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
            if (typeof part?.text === 'string' && part.text) {
                // `thought: true` marks the model's internal reasoning.
                if (part.thought === true) {
                    reasoning += part.text;
                    onThinking?.(reasoning);
                } else {
                    text += part.text;
                    onDelta(part.text);
                }
                modelParts.push(part);
            } else if (part?.functionCall) {
                onToolCall?.();
                const id = `google-call-${toolDeltas.size}`;
                toolDeltas.set(id, {
                    id,
                    name: String(part.functionCall.name ?? ''),
                    arguments: JSON.stringify(part.functionCall.args ?? {}),
                });
                modelParts.push(part);
            } else if (part) {
                modelParts.push(part);
            }
        }
    };

    while (true) {
        const { value, done } = await readStreamChunk(reader);
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const parsed = extractSseData(buffer);
        buffer = parsed.remainder;
        for (const payload of parsed.events) consume(payload);
        if (done) break;
    }
    return { ...finalizeCompletion(text, toolDeltas, usage), providerBlocks: modelParts };
    } finally {
        outerSignal.removeEventListener('abort', onOuterAbort);
    }
}

function finalizeCompletion(
    text: string,
    toolDeltas: Map<number | string, { id: string; name: string; arguments: string }>,
    usage: LocalUsage | null,
): CompletionResult {
    const toolCalls: LocalToolCall[] = [];
    for (const call of toolDeltas.values()) {
        if (!call.id || !call.name) continue;
        toolCalls.push({
            id: call.id,
            name: call.name,
            argumentsJson: call.arguments,
            arguments: parseArguments(call.arguments),
        });
    }
    return { text, toolCalls, usage };
}


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

interface CompletionResult {
    text: string;
    toolCalls: LocalToolCall[];
    usage: LocalUsage | null;
    /** Provider-native assistant content to replay verbatim on the next request
     *  (Anthropic thinking blocks with signatures, Responses reasoning items).
     *  Required when a thinking/reasoning turn also calls a tool - without it
     *  the continuation is rejected or loses reasoning state. */
    providerBlocks?: unknown[];
}

function toolRequiresApproval(name: string, definitions: LocalToolDefinition[]): boolean {
    return definitions.find((tool) => tool.name === name)?.requiresApproval === true;
}

export function estimateMessageTokens(message: LocalAgentMessage): number {
    const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
            ? JSON.stringify(message.content)
            : '';
    const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
    // Provider-native reasoning blocks are RESENT on the continuation, so
    // their tokens count too - otherwise a reasoning-heavy turn is
    // under-counted and the continuation overflows without compaction.
    const provider = message.providerBlocks ? JSON.stringify(message.providerBlocks) : '';
    // Chat Completions re-sends captured reasoning the same way, so it counts
    // too - otherwise a thinking-heavy turn is under-counted and the
    // continuation overflows without compaction noticing.
    const reasoning = message.reasoningContent ?? '';
    // ~3 chars/token. This errs HIGH (over-budget) - the safe direction, so
    // the model sees slightly more usage than reality and never overruns.
    return Math.ceil((content.length + calls.length + provider.length + reasoning.length) / 3);
}

export function estimateRunTokens(messages: LocalAgentMessage[]): number {
    return messages.reduce((n, m) => n + estimateMessageTokens(m), 0);
}

/** Rough token cost of the tool schemas shipped with every request - the
 *  message-content estimate misses these entirely, and on 4k–8k models the
 *  ~40 built-in + web tools can be 1.5k–3k tokens, enough to push a prompt
 *  over the window while the estimate still reads "room to spare". */
export function estimateToolTokens(tools: LocalToolDefinition[]): number {
    let chars = 0;
    for (const tool of tools) {
        chars += tool.name.length
            + (tool.description?.length ?? 0)
            + JSON.stringify(tool.inputSchema).length;
    }
    // Same ~3 chars/token as estimateMessageTokens.
    return Math.ceil(chars / 3);
}

// --- Context-window auto-compaction ---
// Local models often run 4k–16k windows, so compaction must trigger
// PROACTIVELY: once a request would fill >= 90% of the window, oldest turns
// are dropped until occupancy is back near 60% - keeping headroom below the
// hint thresholds instead of scraping the ceiling every turn.
const AUTO_COMPACT_RATIO = 0.9;
const AUTO_COMPACT_TARGET_RATIO = 0.6;
// Hard memory ceiling for the pre-request pass, matching `boundHistory`'s 72%
// budget. The pre-request compaction gates at min(user threshold, this), so it
// fires at least as early as the old mechanical trim did - but WITH a summary.
// `boundHistory` ran BEFORE compaction, so the turns it ate were already gone
// by the time the summarizer could preserve them: a silent, permanent loss.
const HISTORY_BOUND_RATIO = 0.72;

// While a response streams, an estimated cumulative usage event is emitted
// once per this many NEW estimated output tokens - the context meter ticks
// with the streamed tokens instead of only when a round completes. Mirrors
// STREAM_USAGE_ESTIMATE_STEP in src/routers/chat.py. The round-end usage
// event (server-reported) remains authoritative and overwrites the estimate.
const STREAM_USAGE_ESTIMATE_STEP = 32;

export const HISTORY_TRUNCATION_MARKER =
    '[Earlier messages in this conversation were removed to fit the context window. '
    + 'Continue seamlessly; do not mention this.]';

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

function contextStatusLine(usedTokens: number, windowTokens?: number | null): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
    return `\n\n[Context status: ${pct}% of the ${windowTokens}-token context window is in use (${usedTokens}/${windowTokens} tokens).]`;
}

function contextHint(
    usedTokens: number,
    windowTokens?: number | null,
    compactRatio: number = AUTO_COMPACT_RATIO,
): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const ratio = usedTokens / windowTokens;
    if (ratio > compactRatio) {
        return '\n\n⚠ CONTEXT CRITICAL: the context window is nearly exhausted and older turns may have been removed. Keep responses minimal, avoid re-reading files, and prefer precise edits.';
    }
    if (ratio > 0.7) {
        return "\n\n⚠ CONTEXT FULL: You are running out of context space. Keep responses concise. Avoid reading files you don't need.";
    }
    if (ratio > 0.5) {
        return '\n\n⚠ Context is getting full. Keep tool output and responses lean to save tokens.';
    }
    return '';
}

/**
 * Proactive auto-compact for the local loop. When the assembled messages
 * fill >= AUTO_COMPACT_RATIO of the model's window, oldest COMPLETE turns
 * are dropped (cuts land on user-message boundaries, so an assistant turn
 * is never separated from its tool results) until occupancy is back near
 * AUTO_COMPACT_TARGET_RATIO, leaving a truncation marker so the model knows
 * history was removed. `usedTokens` (server-reported prompt tokens) seeds
 * the occupancy when available - estimates miss tool schemas and always
 * undercount. Mutates `messages` in place; returns the dropped turns so the
 * caller can summarize them (empty when nothing was dropped).
 *
 * `force` is the server-confirmed-overflow recovery mode: the estimate just
 * proved wrong, so the ratio gate is bypassed and at least one complete
 * turn is always dropped (even past the target) - otherwise a single huge
 * turn or an under-counting estimate would make recovery a no-op that just
 * rethrows the overflow.
 */
export function compactMessages(
    messages: LocalAgentMessage[],
    windowTokens?: number | null,
    usedTokens?: number,
    toolTokens = 0,
    force = false,
    ratio: number = AUTO_COMPACT_RATIO,
    /** Index of the CURRENT TURN's opening user message. Nothing at or after
     *  it is dropped, and its tool results are never elided. Callers that use
     *  STEERING must pass it: a steer is a user row appended AFTER the turn
     *  opener, so the default (the last user row) would protect the steer and
     *  let compaction drop the user's actual request. Defaults to the last
     *  user row, which is correct when no steering occurred. */
    protectFromIndex?: number,
): LocalAgentMessage[] {
    // Proactive compaction keeps its 4k-window floor; forced recovery (the
    // server just rejected the prompt as too long) runs on ANY real window.
    if (!windowTokens || windowTokens < 1 || messages.length < 4) return [];
    // Include tool-schema overhead in the occupancy so the mechanical trim
    // fires on small windows where schemas are a large fraction of the prompt.
    let total = (usedTokens ?? estimateRunTokens(messages)) + toolTokens;
    // `ratio` is the caller's threshold (default AUTO_COMPACT_RATIO, settable
    // per run). Cline makes this user-configurable for good reason: the right
    // point to compact is a policy choice, not a constant - compacting early
    // costs cache hits and a summarizer call, compacting late risks overflow.
    if (!force && (windowTokens < 4096 || total < windowTokens * ratio)) return [];
    // The estimated prompt size that triggered this call. On a FORCED recovery
    // the server just REJECTED a prompt at least this big (the estimator is a
    // lower bound), so the configured window is demonstrably larger than the
    // model's real limit - and targeting a fraction of THIS, rather than of the
    // window, is what clears the real limit in one pass.
    const observed = total;

    // The current turn opens at `protectFromIndex` when the caller knows it
    // (steering-safe), else at the last user row. Everything from there on -
    // the user's request, assistant tool calls, tool results - stays intact.
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = i; break; }
    }
    const turnStart = protectFromIndex != null && protectFromIndex > 1 ? protectFromIndex : lastUser;
    if (turnStart <= 1) return [];

    // Forced recovery targets a fraction of the OBSERVED size, not of the
    // configured window.
    //
    // Regression (measured from the usage ledger): with an override larger than
    // the model's real limit - 1M configured for a 128k model - the
    // window-relative target sat far ABOVE the failing prompt, so recovery
    // dropped exactly ONE turn, re-overflowed on the next request, and dropped
    // another. The user sees a sawtooth (129k -> 99k -> 58k) and loses turns
    // repeatedly, when one decisive trim would have cleared the real limit.
    // Basing the target on what actually failed does that in a single pass.
    const basis = force ? observed : windowTokens;
    const target = Math.max(2048, Math.floor(basis * AUTO_COMPACT_TARGET_RATIO));

    // CHEAP TIER, tried before anything is dropped or summarized: elide stale
    // tool output. It is model-free, costs nothing, and loses far less than
    // dropping a turn (which discards the user's request and the model's
    // reasoning along with the tool output). When it reclaims enough on its
    // own, return [] - no turns dropped and no summarizer call, which is the
    // difference between a gentle trim and an expensive, lossy one.
    //
    // The forced path deliberately does NOT take the early return: there the
    // estimate just proved unreliable (the server rejected the prompt), so a
    // turn is still dropped to guarantee progress. Elision simply means less
    // has to go.
    // `turnStart` bounds elision to the droppable history: the current turn
    // (from `turnStart` on) must stay intact, exactly as the turn loop below
    // guarantees for whole-turn drops.
    const beforeElision = estimateRunTokens(messages);
    if (elideOldToolResults(messages, TOOL_RESULT_ELISION_KEEP, turnStart)) {
        // Reclaim is measurable only in ESTIMATE units, so subtract it from
        // `total` rather than re-deriving `total` from the estimate. The old
        // formula subtracted `observed - estimate(messages) - toolTokens`,
        // which algebraically RESETS total to `estimate(messages) + toolTokens`
        // whenever `usedTokens` was supplied - silently discarding the
        // server-reported occupancy exactly when it matters most (the estimate
        // undercounts dense content, which is why `usedTokens` was passed).
        // Keeping `total`'s units is what makes the cheap tier safe to run
        // before the turn-drop loop on the mid-run, server-confirmed path.
        const reclaimed = Math.max(0, beforeElision - estimateRunTokens(messages));
        total = Math.max(0, total - reclaimed);
        if (!force && total <= target) return [];
    }
    let start = 1;
    while (start < turnStart && (total > target || (force && start === 1))) {
        let end = start + 1;
        while (end < turnStart && messages[end].role !== 'user') end++;
        const groupCost = estimateRunTokens(messages.slice(start, end));
        if (!force && total - groupCost < target) break;
        total -= groupCost;
        start = end;
    }
    if (start <= 1) return [];
    // splice(1, start-1) removes indices 1..start-1; the slice must cover
    // exactly the same range so the summarizer sees every dropped message.
    const dropped = messages.slice(1, start);
    messages.splice(1, start - 1, { role: 'user', content: HISTORY_TRUNCATION_MARKER });
    return dropped;
}

/** ~chars per token used by every estimator in this file. */
const TOOL_RESULT_CHARS_PER_TOKEN = 3;
/** Per-result ceiling as a fraction of the window. */
const TOOL_RESULT_MAX_RATIO = 0.4;
/** Total current-turn tool-output budget as a fraction of the window. */
const TOOL_RESULT_TOTAL_RATIO = 0.5;
/** Never clip a result below this many chars - a clipped stub stays useful. */
const TOOL_RESULT_MIN_CHARS = 800;
/** Last-resort replacement when even the floor cannot fit the budget. */
const TOOL_RESULT_OMISSION = '[tool output omitted to fit the context window]';

/** Tool results kept intact by the cheap elision tier (see below). */
export const TOOL_RESULT_ELISION_KEEP = 5;
/** Replacement for an elided tool result. Says how to recover the content. */
export const TOOL_RESULT_ELISION_MARKER =
    '[older tool result elided to reclaim context - re-run the tool if you need this output again]';

/**
 * CHEAP TIER of context reclamation: elide all but the most recent tool results.
 *
 * Modelled on Claude Code's micro-compaction, which is model-free and targets
 * tool output because that is the primary source of context bloat. It is
 * strictly gentler than what it replaces: dropping a whole turn loses the
 * user's request, the model's reasoning AND the tool output, while this loses
 * only stale tool output - and the model is told how to recover it.
 *
 * Deliberately model-free and free, so it can run BEFORE the expensive
 * summarization path. When it reclaims enough, the run skips both the turn
 * drops and the summarizer call entirely (see `compactMessages`).
 *
 * `beforeIndex` (the caller passes the CURRENT TURN's first index, `lastUser`)
 * bounds elision to turns that compaction may touch at all: a single user turn
 * can call more than `keepLast` tools, and eliding those mid-turn would strip
 * results the model is actively reasoning over - exactly what `compactMessages`
 * guarantees it will not do.
 *
 * A row is only replaced when the marker is genuinely SMALLER: a short result
 * ('ok') can be shorter than the marker, and growing it would raise occupancy
 * while the caller subtracts a zero reclaim, leaving its running estimate
 * stale and its target unmet.
 *
 * Mutates `messages`; returns the estimated tokens reclaimed.
 */
export function elideOldToolResults(
    messages: LocalAgentMessage[],
    keepLast = TOOL_RESULT_ELISION_KEEP,
    beforeIndex = messages.length,
): number {
    const limit = Math.min(beforeIndex, messages.length);
    const idxs: number[] = [];
    for (let i = 1; i < limit; i++) {
        if (messages[i].role === 'tool' && typeof messages[i].content === 'string') idxs.push(i);
    }
    if (idxs.length <= keepLast) return 0;
    const before = estimateRunTokens(messages);
    for (const i of idxs.slice(0, idxs.length - keepLast)) {
        const current = messages[i].content as string;
        if (current === TOOL_RESULT_ELISION_MARKER) continue;
        if (TOOL_RESULT_ELISION_MARKER.length >= current.length) continue;
        messages[i] = { ...messages[i], content: TOOL_RESULT_ELISION_MARKER };
    }
    return Math.max(0, before - estimateRunTokens(messages));
}

/**
 * Bound tool results to a window-relative budget.
 *
 * `compactMessages` only drops COMPLETE turns before the last user message, so
 * a single huge tool output (terminal results are capped at 200k chars,
 * expansion tools at 120k) can overflow a small window on its own and make
 * forced overflow recovery a no-op. Every tool result in the assembled
 * messages is bounded instead - including results that a STEERING message has
 * pushed behind the last user message, and large results kept from recent
 * turns. The most recent results (what the model is about to reason over) are
 * preserved longest.
 *
 * Three passes: a hard per-result cap, then oldest-first shrinking toward the
 * floor, then oldest-first omission. The final pass guarantees the aggregate
 * budget is met even when many results or large tool schemas would otherwise
 * defeat the floor. Accounting uses the ACTUAL returned length (the clip
 * marker is extra), so the tracked total matches what is sent.
 *
 * Mutates `messages`; returns true when anything changed.
 */
export function boundToolResults(
    messages: LocalAgentMessage[],
    windowTokens?: number | null,
    toolTokens = 0,
): boolean {
    if (!windowTokens || windowTokens < 1024) return false;

    const idxs: number[] = [];
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === 'tool' && typeof messages[i].content === 'string') idxs.push(i);
    }
    if (!idxs.length) return false;

    const windowChars = windowTokens * TOOL_RESULT_CHARS_PER_TOKEN;
    const perResultCap = Math.max(TOOL_RESULT_MIN_CHARS, Math.floor(windowChars * TOOL_RESULT_MAX_RATIO));
    // Tool SCHEMAS also consume the window - subtract them from the budget
    // (they may consume it entirely; the omission pass still enforces this).
    const totalBudget = Math.max(
        0,
        Math.floor(windowChars * TOOL_RESULT_TOTAL_RATIO) - toolTokens * TOOL_RESULT_CHARS_PER_TOKEN,
    );

    let changed = false;
    let total = 0;

    // Pass 1: per-result cap.
    for (const i of idxs) {
        const text = messages[i].content as string;
        if (text.length > perResultCap) {
            messages[i] = { ...messages[i], content: clipForSummary(text, perResultCap) };
            changed = true;
        }
        total += (messages[i].content as string).length;
    }
    if (total <= totalBudget) return changed;

    // Pass 2: shrink the OLDEST results toward the floor.
    for (const i of idxs) {
        if (total <= totalBudget) break;
        const text = messages[i].content as string;
        if (text.length <= TOOL_RESULT_MIN_CHARS) continue;
        const target = Math.max(TOOL_RESULT_MIN_CHARS, text.length - (total - totalBudget));
        if (target >= text.length) continue;
        const clipped = clipForSummary(text, target);
        messages[i] = { ...messages[i], content: clipped };
        total -= text.length - clipped.length;
        changed = true;
    }

    // Pass 3: the floor is not enough (many results / schema-heavy window) -
    // omit the OLDEST results outright so the budget is always enforced.
    for (const i of idxs) {
        if (total <= totalBudget) break;
        const text = messages[i].content as string;
        if (text.length <= TOOL_RESULT_OMISSION.length) continue;
        messages[i] = { ...messages[i], content: TOOL_RESULT_OMISSION };
        total -= text.length - TOOL_RESULT_OMISSION.length;
        changed = true;
    }
    return changed;
}

// --- AI compaction for the local loop ---
// Mechanical dropping alone discards everything the removed turns contained.
// Before splicing, the dropped turns are summarized by the user's OWN local
// model (one blocking non-streaming call) and the summary replaces the bare
// truncation marker. Failure degrades to the plain marker - never to a lost
// turn without at least the mechanical trim.

const SUMMARY_MAX_MSG_CHARS = 4000;
const SUMMARY_MAX_TOTAL_CHARS = 60_000;
const SUMMARY_TIMEOUT_MS = 60_000;
/** Tool results are hard-capped per line regardless of the per-message
 *  allowance: the summarizer call runs on the SAME local model/window, so a
 *  single 60k-char tool output can overflow the summarizer itself and
 *  degrade the whole compaction to the plain marker. (Cline uses the same
 *  2000-char TOOL_RESULT_CHAR_LIMIT before summarizing.) */
const SUMMARY_TOOL_RESULT_CHARS = 2000;

export function clipForSummary(text: string, allowance: number): string {
    if (text.length <= allowance) return text;
    if (allowance <= 200) return text.slice(0, allowance) + '...';
    const head = Math.floor(allowance * 0.6);
    const tail = allowance - head;
    return text.slice(0, head) + '\n[...clipped...]\n' + text.slice(-tail);
}

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
 * Xratu supports. Non-streaming; returns the extracted text or null.
 */
async function requestSummaryCompletion(
    request: LocalAgentRequest,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
): Promise<string | null> {
    const style = request.apiStyle ?? 'chat';
    const endpoint = style === 'messages' ? 'messages'
        : style === 'responses' ? 'responses'
            : style === 'google' ? `models/${encodeURIComponent(request.model)}:generateContent`
                : 'chat/completions';
    const headers = style === 'messages' ? makeMessagesHeaders(request.apiKey, request.sessionId)
        : style === 'google' ? makeGoogleHeaders(request.apiKey, request.sessionId)
            : makeHeaders(request.apiKey, request.sessionId);
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
        body = {
            model: request.model,
            input: prompt,
            max_output_tokens: maxTokens,
            temperature: 0.2,
        };
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

    const send = (): Promise<Response> => fetch(endpointUrl(request.baseUrl, endpoint), withDispatcher({
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
async function compactWithSummary(
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
    if (!summary) {
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
        // True once this attempt streamed anything the webview already
        // rendered - retrying after that would duplicate it.
        let emittedOutput = false;
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
                emittedOutput = true;
                attemptText += delta;
                queue.push({ kind: 'text', value: delta });
            },
            (thinking) => { emittedOutput = true; queue.push({ kind: 'thinking', value: thinking }); },
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
        // that reject assistant prefill.
        const transient = isTransientNetworkError(requestError);
        if (shouldResumeStream({
            emittedOutput: attemptText.length > 0,
            sawToolCall,
            transient,
            aborted: !!request.signal?.aborted,
            resumesUsed,
            deadlineMs: retryDeadline,
        })) {
            resumesUsed++;
            resumedText += attemptText;
            continuationMessages = [
                ...messages,
                { role: 'assistant', content: resumedText },
                { role: 'user', content: STREAM_RESUME_NOTE },
            ];
            continue;
        }

        // Retry ONLY a transient transport drop (terminated / socket reset /
        // timeout) that happened before any output reached the user, while
        // attempts and the total-time budget allow. Offline (DNS/route) errors
        // earn a larger attempt budget so a link blip does not kill the turn.
        // Everything else - HTTP rejections, overflow, a user cancel,
        // mid-content death - falls through to the error/recovery path below.
        const offline = transient && isOfflineNetworkError(requestError);
        const maxAttempts = offline ? OFFLINE_MAX_RETRIES + 1 : NETWORK_MAX_RETRIES + 1;
        const canRetry = !emittedOutput
            && !request.signal?.aborted
            && roundRetries + 1 < maxAttempts
            && Date.now() < retryDeadline
            && transient;
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
            // Some local servers (LM Studio, Ollama) reject the OpenAI-standard
            // data: URI in image_url.url and demand raw base64 - flip the
            // encoding ONCE and retry the round instead of failing the turn.
            if (
                !imageFormatSwapped
                && request.attachments?.length
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

            messages.push({ role: 'tool', tool_call_id: call.id, content: result.output, isError: result.isError === true });
            yield {
                type: 'toolResult',
                id: call.id,
                tool: call.name,
                output: result.output,
                isError: result.isError,
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

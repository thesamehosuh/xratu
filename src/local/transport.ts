/**
 * HTTP/SSE transport plumbing and failure classification for the local
 * agent: headers, endpoint URLs, stream deadlines, retry/backoff and the
 * transient/offline classifiers. Split out of localAgent.ts (which
 * re-exports the public names below); VS Code-free.
 */

import { PROVIDER_HTTP_STATUS_CODE } from '../providerErrors';
import { normalizeBaseUrl } from './baseUrl';
import type { LocalAgentRequest } from './localTypes';

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

export function extractSseData(buffer: string): { events: string[]; remainder: string } {
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

export function makeHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
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
export const FIRST_BYTE_TIMEOUT_MS = 300_000;

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
export function transportTimeoutError(message: string, cause?: unknown): Error {
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

/** Generous output cap derived from the context window (8k floor, 16k
 *  ceiling). The Messages API REQUIRES max_tokens; the chat, Responses and
 *  Google transports get the same derived cap so a full-window prompt plus a
 *  provider's default output maximum cannot overrun the context. An explicit
 *  `request.maxTokens` always wins.
 *
 *  The floor matters: tool calls carry WHOLE FILES (edit_file new_content).
 *  A 4k floor truncated a ~15KB HTML write mid-JSON on a small-window model,
 *  which the tool then reported as missing arguments - a resend death loop
 *  (seen live). 8k still fits inside every real window with room for the
 *  prompt, and providers clamp to the true remaining context anyway. */
function derivedMaxTokens(windowTokens?: number | null): number {
    return Math.min(16384, Math.max(8192, Math.floor((windowTokens ?? 8192) / 4)));
}

/** The output cap actually sent: an explicit caller cap wins outright, else
 *  the context-derived cap lowered to the provider's reported maximum. */
export function outputCapFor(request: LocalAgentRequest): number {
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

/** Provider HTTP statuses that mean "the upstream is temporarily unavailable
 *  - retry with backoff" (529 is OpenRouter's overload signal; 502/503/504
 *  are the classic gateways). 4xx rejections (auth, rate limit, bad request)
 *  and bare 500s are DELIBERATELY absent: those need a different turn, not
 *  another attempt at the same one. */
const RETRYABLE_PROVIDER_HTTP_STATUSES = new Set([502, 503, 504, 529]);

/** True for a tagged provider HTTP rejection whose status is worth another
 *  attempt (see RETRYABLE_PROVIDER_HTTP_STATUSES). The transport was healthy
 *  here - the provider said "try again shortly" in status form. */
export function isRetryableProviderHttpError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as { code?: unknown; status?: unknown };
    return e.code === PROVIDER_HTTP_STATUS_CODE
        && typeof e.status === 'number'
        && RETRYABLE_PROVIDER_HTTP_STATUSES.has(e.status);
}
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
export function abortError(): Error {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

/** Resolve after `ms`, or immediately when `signal` aborts. Never rejects. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
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
export function describeNetworkError(error: unknown): unknown {
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

export async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
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
export function withDispatcher(init: RequestInit, dispatcher: unknown): RequestInit {
    return dispatcher ? ({ ...init, dispatcher } as RequestInit) : init;
}

/** Append an API path to a base URL without a query/fragment swallowing it
 *  (`https://h/v1?tenant=x` must become `https://h/v1/messages?tenant=x`). */
export function endpointUrl(baseUrl: string, endpoint: string): string {
    const base = normalizeBaseUrl(baseUrl);
    try {
        const url = new URL(base);
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
        return url.toString();
    } catch {
        return `${base}/${endpoint}`;
    }
}

export function makeMessagesHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
    const headers = makeHeaders(apiKey, sessionId);
    // Anthropic uses x-api-key; OpenAI-compatible gateways use Bearer. Send
    // both so either front end works (the extra header is ignored).
    if (apiKey) headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
    return headers;
}

export function makeGoogleHeaders(apiKey?: string | null, sessionId?: string | null): Headers {
    const headers = makeHeaders(apiKey, sessionId);
    if (apiKey) headers.set('x-goog-api-key', apiKey);
    return headers;
}

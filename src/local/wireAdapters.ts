/**
 * The four provider wire adapters (Chat Completions / Anthropic Messages /
 * OpenAI Responses / Google Generative Language) plus the projections they
 * share: body builders, SSE streaming, 400-field recovery, and the trailing
 * tail-note / reasoning-replay projections. Split out of localAgent.ts;
 * `requestStreamingCompletion` is the dispatch the agent loop calls.
 * VS Code-free: plain fetch + SSE.
 */

import { proxyFetch } from '../proxyFetch';
import { UNPARSED_ARGS_KEY } from '../tooling/editFileArgs';
import { isOpenRouterHost, supportsPromptCacheKey } from './apiStyle';
import { isChatGptSubscriptionHost } from '../providerIdentity';
import { dataUrlMime, dataUrlPayload } from './imageFormat';
import type {
    LocalAgentMessage,
    LocalAgentRequest,
    LocalToolCall,
    LocalToolDefinition,
    LocalUsage,
    ThinkingLevel,
} from './localTypes';
import {
    FIRST_BYTE_TIMEOUT_MS,
    MAX_TOKENS_REJECT_RE,
    PROMPT_CACHE_KEY_REJECT_RE,
    REASONING_REJECT_RE,
    STREAM_OPTIONS_REJECT_RE,
    TOOL_CHOICE_REJECT_RE,
    endpointUrl,
    extractSseData,
    makeGoogleHeaders,
    makeHeaders,
    makeMessagesHeaders,
    outputCapFor,
    providerHttpError,
    readStreamChunk,
    transportTimeoutError,
    withDispatcher,
} from './transport';

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

export function parseArguments(raw: unknown): Record<string, unknown> {
    // Some providers deliver `function.arguments` as an already-parsed object.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return {};
    try {
        const value = JSON.parse(text);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        // Double-encoded arguments (a JSON string of a JSON string): unwrap
        // once - providers that stringify twice still mean the inner object.
        if (typeof value === 'string') {
            try {
                const inner = JSON.parse(value);
                if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
            } catch { /* fall through to the marker */ }
        }
        return { [UNPARSED_ARGS_KEY]: text.slice(0, 200) };
    } catch {
        return { [UNPARSED_ARGS_KEY]: text.slice(0, 200) };
    }
}

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
        case 'ultra': return 65_536;
    }
}

export interface CompletionResult {
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
            return stripLocalImageFields(wire);
        }
        if (m.role === 'assistant') {
            const { providerBlocks: _providerBlocks, isError: _isError, ...wire } = m;
            return stripLocalImageFields(wire);
        }
        return stripLocalImageFields(m);
    });
}

/**
 * Drop the LOCAL `width`/`height` bookkeeping from `image_url` parts.
 *
 * The chat transport serializes `LocalAgentMessage` near-verbatim, so those
 * estimation-only fields would otherwise reach the provider as unknown
 * `image_url` keys - and strict OpenAI-compatible servers 400 on unknown
 * fields (the same reason `prompt_cache_key` is not sent to arbitrary hosts).
 * The other three styles rebuild every image block field by field and never
 * carried the leak.
 */
function stripLocalImageFields(message: LocalAgentMessage): LocalAgentMessage {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
        if (part.type !== 'image_url') return part;
        if (part.image_url?.width === undefined && part.image_url?.height === undefined) return part;
        const { width: _w, height: _h, ...imageUrl } = part.image_url;
        changed = true;
        return { ...part, image_url: imageUrl };
    });
    return changed ? { ...message, content } : message;
}

export async function requestStreamingCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
    onToolCall?: () => void,
): Promise<CompletionResult> {
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    let timedOut = false;
    // SSE heartbeats are transport activity, not model progress. Bound the
    // entire wait for text, thinking or a tool call, including header wait.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FIRST_BYTE_TIMEOUT_MS);
    const progressed = () => clearTimeout(timer);
    const delta = (value: string) => { if (value) progressed(); onDelta(value); };
    const thinking = (value: string) => { if (value) progressed(); onThinking?.(value); };
    const tool = () => { progressed(); onToolCall?.(); };
    const adapter = request.apiStyle === 'messages' ? requestMessagesCompletion
        : request.apiStyle === 'responses' ? requestResponsesCompletion
        : request.apiStyle === 'google' ? requestGoogleCompletion : requestChatCompletion;
    try {
        return await adapter({ ...request, signal }, messages, tailNote, delta, thinking, tool);
    } catch (error) {
        if (timedOut && !request.signal?.aborted) throw transportTimeoutError('Model first-token timeout (300s): no text, thinking or tool call received.');
        throw error;
    } finally { clearTimeout(timer); }
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
            return await proxyFetch(url, withDispatcher({
                method: 'POST',
                headers: makeHeaders(request.apiKey, request.sessionId, request.headers),
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
            if (call.function?.arguments) {
                // Deltas carry strings, but some providers ship the whole
                // arguments object on the first delta - String() would turn it
                // into "[object Object]" and every key would go missing.
                current.arguments += typeof call.function.arguments === 'string'
                    ? call.function.arguments
                    : JSON.stringify(call.function.arguments);
            }

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
            // A tool result may be MULTIModal (MCP screenshots, rendered
            // output): `messagesContentBlocks` already maps both text and
            // image_url parts onto Anthropic blocks, so a screenshot rides the
            // tool_result instead of being dropped.
            const block: Record<string, unknown> = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string'
                    ? msg.content
                    : messagesContentBlocks(msg.content),
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
            return await proxyFetch(url, withDispatcher({
                method: 'POST',
                headers: makeMessagesHeaders(request.apiKey, request.sessionId, request.headers),
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

/**
 * `{inlineData}` for a Google part. Accepts both wire encodings of an image:
 * a `data:` URL (the negotiated default) and RAW base64 (the negotiated swap
 * after a 400 - a bare base64 payload carries no MIME type, so we cannot
 * recover it here and drop the part rather than send an invalid one).
 */
function googleInlineData(url: string): { inlineData: { mimeType: string; data: string } } | null {
    const mime = dataUrlMime(url);
    const data = dataUrlPayload(url);
    if (!mime || !data) return null;
    return { inlineData: { mimeType: mime, data } };
}

/**
 * Whether a Google content part belongs to a tool-result turn (a
 * functionResponse, or an inlineData that rode along with one). Used to decide
 * whether another tool result merges into the existing user turn.
 */
function isGoogleToolResultPart(part: any): boolean {
    return !!part && (!!part.functionResponse || !!part.inlineData);
}

/** The concatenated text parts of a message, ignoring any image parts. */
function textPartOf(content: LocalAgentMessage['content']): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => (p as { text: string }).text)
        .join('\n');
}

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
                    ...(request.subscription ? { namespace: 'xratu' } : {}),
                });
            }
            continue;
        }
        if (msg.role === 'tool') {
            // `function_call_output.output` is a TEXT field. A multimodal tool
            // result therefore splits: the text goes in the call output, and
            // any images follow as a separate user message. This is what goose
            // does for the same reason (formats/openai.rs:352-401) - lifting
            // the image rather than dropping it.
            const text = typeof msg.content === 'string' ? msg.content : textPartOf(msg.content);
            input.push({
                type: 'function_call_output',
                call_id: msg.tool_call_id,
                output: text,
            });
            if (Array.isArray(msg.content)) {
                const imageParts = msg.content.filter(
                    (p) => p.type === 'image_url' && p.image_url?.url,
                ) as Array<{ type: 'image_url'; image_url: { url: string } }>;
                if (imageParts.length) {
                    input.push({
                        role: 'user',
                        content: [
                            {
                                type: 'input_text',
                                text: imageParts.length === 1
                                    ? 'Image returned by the previous tool call:'
                                    : `Images returned by the previous tool call (${imageParts.length}):`,
                            },
                            ...imageParts.map((p) => ({ type: 'input_image', image_url: p.image_url.url })),
                        ],
                    });
                }
            }
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
    // The ChatGPT (Codex) backend REJECTS max_output_tokens, so sending a cap
    // there would spend a round trip on the 400-degradation retry below; it
    // also requires store:false, and only returns replayable reasoning when
    // it is asked for the encrypted form (Codex CLI sends all three).
    if (request.subscription || isChatGptSubscriptionHost(request.baseUrl)) {
        body.store = false;
        body.include = ['reasoning.encrypted_content'];
        if (request.subscription && body.tools) body.tools = [{
            type: 'namespace', name: 'xratu', description: 'Tools executed locally by Xratu', tools: body.tools,
        }];
    } else {
        body.max_output_tokens = outputCapFor(request);
    }
    if (!request.subscription && request.temperature != null) body.temperature = request.temperature;
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
            return await proxyFetch(url, withDispatcher({
                method: 'POST',
                headers: makeHeaders(request.apiKey, request.sessionId, request.headers),
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
    let completed = false;

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
                completed = true;
                if (json.response?.usage) usage = responsesUsage(json.response.usage);
                if (Array.isArray(json.response?.output)) completedItems = json.response.output;
                break;
            case 'response.failed':
                throw new Error(`Model response failed: ${json.response?.error?.message ?? 'unknown error'}`);
            case 'response.incomplete':
                throw new Error(`Model response incomplete: ${json.response?.incomplete_details?.reason ?? 'unknown reason'}`);
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
    if (request.subscription && !completed) throw new Error('Model stream ended without response.completed');
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
                functionResponse: { name, response: { result: textPartOf(msg.content) } },
            };
            const last = contents[contents.length - 1];
            // A multimodal tool result rides the SAME user turn as its
            // functionResponse: Google requires alternating user/model contents,
            // so a separate turn for the image would be rejected. `inlineData`
            // alongside a functionResponse is a legal part mix.
            const imageParts = Array.isArray(msg.content)
                ? msg.content
                    .filter((p) => p.type === 'image_url' && p.image_url?.url)
                    .map((p) => googleInlineData((p as { image_url: { url: string } }).image_url.url))
                    .filter((p): p is { inlineData: { mimeType: string; data: string } } => p !== null)
                : [];
            if (last && last.role === 'user' && last.parts.every(isGoogleToolResultPart)) {
                last.parts.push(part, ...imageParts);
            } else {
                contents.push({ role: 'user', parts: [part, ...imageParts] });
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
            return await proxyFetch(url, withDispatcher({
                method: 'POST',
                headers: makeGoogleHeaders(request.apiKey, request.sessionId, request.headers),
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

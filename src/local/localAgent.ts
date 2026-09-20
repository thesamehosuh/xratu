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

import { taskListReminderLine, type TaskListItem } from '../taskList';
import { normalizeBaseUrl } from './baseUrl';

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
    | { type: 'assistantMessage'; text: string; toolCalls: LocalToolCall[] }
    | { type: 'steer'; text: string; attachments?: LocalImageAttachment[] }
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
    // `estimated` marks the mid-stream usage estimates emitted WHILE a
    // response streams - the host must never record them as the turn's
    // real usage (the round-end event carries the authoritative copy).
    | { type: 'usage'; usage: LocalUsage; estimated?: boolean }
    | { type: 'compactionSummary'; value: string }
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
}

export interface LocalAgentRequest {
    baseUrl: string;
    apiKey?: string | null;
    model: string;
    systemPrompt: string;
    userText: string;
    attachments?: LocalImageAttachment[];
    history?: LocalAgentMessage[];
    tools: LocalToolDefinition[];
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    /** Reasoning effort (OpenAI-style); undefined = omit from the body so
     *  runtimes keep their default behavior. */
    reasoningEffort?: 'low' | 'medium' | 'high';
    maxRounds?: number;
    contextWindow?: number | null;
    /** Current session task list (client-echoed, user edits merged) -
     *  appended to the system message each round so the model stays on-plan
     *  even after compaction dropped the original tool call. */
    taskList?: TaskListItem[];
    /** Optional undici dispatcher (proxy) forwarded to every fetch. Typed
     *  `unknown` so this module stays free of VS Code / undici imports. */
    dispatcher?: unknown;
    /** Wire API to use. Resolved by the host via `resolveApiStyle`; defaults
     *  to OpenAI chat/completions. */
    apiStyle?: 'chat' | 'messages' | 'responses' | 'google';
    /** Stable per-conversation id, sent as `x-opencode-session`. OpenCode Go
     *  rejects requests without it (MissingSessionID). */
    sessionId?: string;
}

export interface LocalToolExecutor {
    execute(
        call: LocalToolCall,
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

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Model stream stalled (no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`)),
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
}

/** Dispatch to the transport the resolved API style calls for. */
/** Volatile context-awareness note appended as the LAST item of each request.
 *  It is deliberately NOT part of `messages` and NOT in the system prompt:
 *  keeping the prefix byte-stable across rounds is what makes prompt caching
 *  work (Anthropic cache_control, OpenAI/Google automatic prefix caching). */
function requestStreamingCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
): Promise<CompletionResult> {
    if (request.apiStyle === 'messages') {
        return requestMessagesCompletion(request, messages, tailNote, onDelta, onThinking);
    }
    if (request.apiStyle === 'responses') {
        return requestResponsesCompletion(request, messages, tailNote, onDelta, onThinking);
    }
    if (request.apiStyle === 'google') {
        return requestGoogleCompletion(request, messages, tailNote, onDelta, onThinking);
    }
    return requestChatCompletion(request, messages, tailNote, onDelta, onThinking);
}

async function requestChatCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'chat/completions');
    const body: Record<string, unknown> = {
        model: request.model,
        // Trailing system message: read by OpenAI-compatible servers while
        // leaving every earlier message untouched (cacheable prefix).
        messages: tailNote ? [...messages, { role: 'system', content: tailNote }] : messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (request.tools.length) body.tools = toOpenAITools(request.tools);
    if (request.maxTokens != null) body.max_tokens = request.maxTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;

    // Relay the caller's cancellation AND impose a headers deadline: a
    // wedged local server that accepts the connection but never answers
    // must not hang the agent loop. The idle deadline in readStreamChunk
    // covers the body phase.
    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    const headersTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);

    const send = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(url, withDispatcher({
            method: 'POST',
            headers: makeHeaders(request.apiKey, request.sessionId),
            body: JSON.stringify(payload),
            signal: controller.signal,
        }, request.dispatcher));

    let response: Response;
    try {
        response = await send(body);
        // Strict OpenAI-compatible servers reject the non-standard
        // `stream_options` field outright. Flip it off ONCE and retry rather
        // than failing the whole turn; usage then comes from the final chunk
        // if the server sends it anyway.
        if (!response.ok && response.status === 400 && body.stream_options) {
            const text = await response.text().catch(() => '');
            if (STREAM_OPTIONS_REJECT_RE.test(text)) {
                delete body.stream_options;
                response = await send(body);
            } else {
                throw new Error(`Model request failed (400): ${text.slice(0, 600)}`);
            }
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw new Error(`Model request timed out (no response for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    } finally {
        clearTimeout(headersTimer);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Model request failed (${response.status}): ${text.slice(0, 600)}`);
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
            usage = {
                promptTokens: Number.isFinite(rawUsage.prompt_tokens) ? rawUsage.prompt_tokens : null,
                completionTokens: Number.isFinite(rawUsage.completion_tokens) ? rawUsage.completion_tokens : null,
                totalTokens: Number.isFinite(rawUsage.total_tokens) ? rawUsage.total_tokens : null,
                cachedTokens: Number.isFinite(cachedRaw) ? cachedRaw : null,
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

    outerSignal.removeEventListener('abort', onOuterAbort);

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

    // Volatile note rides the tail: merged into a trailing user turn so the
    // cached prefix (tools + system + history) is untouched. tool_result
    // blocks must stay first, which the sort below already guarantees.
    if (tailNote) {
        const last = out[out.length - 1];
        if (last && last.role === 'user') last.content.push({ type: 'text', text: tailNote });
        else out.push({ role: 'user', content: [{ type: 'text', text: tailNote }] });
    }

    const body: Record<string, unknown> = {
        model: request.model,
        // max_tokens is REQUIRED by the Messages API. With no explicit cap,
        // derive a generous one from the context window (4k floor, 16k
        // ceiling) rather than a silent 4096 that truncates long outputs.
        max_tokens: request.maxTokens
            ?? Math.min(16384, Math.max(4096, Math.floor((request.contextWindow ?? 8192) / 4))),
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
    }
    if (request.temperature != null) body.temperature = request.temperature;
    return body;
}

function mergeMessagesUsage(raw: any, previous: LocalUsage | null): LocalUsage {
    const input = Number.isFinite(raw?.input_tokens) ? raw.input_tokens : previous?.promptTokens ?? null;
    const output = Number.isFinite(raw?.output_tokens) ? raw.output_tokens : previous?.completionTokens ?? null;
    const cached = Number.isFinite(raw?.cache_read_input_tokens) ? raw.cache_read_input_tokens : previous?.cachedTokens ?? null;
    return { promptTokens: input, completionTokens: output, totalTokens: null, cachedTokens: cached };
}

async function requestMessagesCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'messages');
    const body = toMessagesBody(request, messages, tailNote);

    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    const headersTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);

    const send = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(url, withDispatcher({
            method: 'POST',
            headers: makeMessagesHeaders(request.apiKey, request.sessionId),
            body: JSON.stringify(payload),
            signal: controller.signal,
        }, request.dispatcher));

    try {
    let response: Response;
    try {
        response = await send(body);
        // Some Messages-compatible gateways reject `cache_control`. Drop the
        // breakpoint ONCE and retry rather than failing the turn (caching is
        // an optimization, not a requirement).
        const systemBlocks = body.system as Array<Record<string, unknown>> | undefined;
        if (!response.ok && response.status === 400 && systemBlocks?.[0]?.cache_control) {
            const text = await response.text().catch(() => '');
            if (/cache_control/i.test(text)) {
                delete systemBlocks[0].cache_control;
                response = await send(body);
            } else {
                throw new Error(`Model request failed (400): ${text.slice(0, 600)}`);
            }
        }
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw new Error(`Model request timed out (no response for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    } finally {
        clearTimeout(headersTimer);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Model request failed (${response.status}): ${text.slice(0, 600)}`);
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
    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    if (request.temperature != null) body.temperature = request.temperature;
    // Responses reasoning models take an effort object (chat uses
    // `reasoning_effort`); forward the user's thinking level.
    if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
    return body;
}

function responsesUsage(raw: any): LocalUsage {
    const cached = raw?.input_tokens_details?.cached_tokens;
    return {
        promptTokens: Number.isFinite(raw?.input_tokens) ? raw.input_tokens : null,
        completionTokens: Number.isFinite(raw?.output_tokens) ? raw.output_tokens : null,
        totalTokens: Number.isFinite(raw?.total_tokens) ? raw.total_tokens : null,
        cachedTokens: Number.isFinite(cached) ? cached : null,
    };
}

async function requestResponsesCompletion(
    request: LocalAgentRequest,
    messages: LocalAgentMessage[],
    tailNote: string,
    onDelta: (textDelta: string) => void,
    onThinking?: (thinking: string) => void,
): Promise<CompletionResult> {
    const url = endpointUrl(request.baseUrl, 'responses');
    const body = toResponsesBody(request, messages, tailNote);

    const outerSignal = request.signal ?? new AbortController().signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    const headersTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);

    try {
    let response: Response;
    try {
        response = await fetch(url, withDispatcher({
            method: 'POST',
            headers: makeHeaders(request.apiKey, request.sessionId),
            body: JSON.stringify(body),
            signal: controller.signal,
        }, request.dispatcher));
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw new Error(`Model request timed out (no response for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    } finally {
        clearTimeout(headersTimer);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Model request failed (${response.status}): ${text.slice(0, 600)}`);
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
    // the last user content (or a fresh one) - the stable systemInstruction
    // prefix stays byte-identical for implicit caching.
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
    }
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens != null) generationConfig.maxOutputTokens = request.maxTokens;
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
    const headersTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);

    try {
    let response: Response;
    try {
        response = await fetch(url, withDispatcher({
            method: 'POST',
            headers: makeGoogleHeaders(request.apiKey, request.sessionId),
            body: JSON.stringify(body),
            signal: controller.signal,
        }, request.dispatcher));
    } catch (e) {
        if (controller.signal.aborted && !outerSignal.aborted) {
            throw new Error(`Model request timed out (no response for ${STREAM_IDLE_TIMEOUT_MS / 1000}s).`);
        }
        throw e;
    } finally {
        clearTimeout(headersTimer);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Model request failed (${response.status}): ${text.slice(0, 600)}`);
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
    // ~3 chars/token. This errs HIGH (over-budget) - the safe direction, so
    // the model sees slightly more usage than reality and never overruns.
    return Math.ceil((content.length + calls.length + provider.length) / 3);
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
// The overflow guard in boundHistory only caps history at ~72% of the window.
// Local models often run 4k–16k windows, so compaction must trigger
// PROACTIVELY: once a request would fill >= 90% of the window, oldest turns
// are dropped until occupancy is back near 60% - keeping headroom below the
// hint thresholds instead of scraping the ceiling every turn.
const AUTO_COMPACT_RATIO = 0.9;
const AUTO_COMPACT_TARGET_RATIO = 0.6;

// While a response streams, an estimated cumulative usage event is emitted
// once per this many NEW estimated output tokens - the context meter ticks
// with the streamed tokens instead of only when a round completes. Mirrors
// STREAM_USAGE_ESTIMATE_STEP in src/routers/chat.py. The round-end usage
// event (server-reported) remains authoritative and overwrites the estimate.
const STREAM_USAGE_ESTIMATE_STEP = 32;

export const HISTORY_TRUNCATION_MARKER =
    '[Earlier messages in this conversation were removed to fit the context window. '
    + 'Continue seamlessly; do not mention this.]';

/** Appended to the system message for the ONE tool-free wrap-up round that
 *  replaces the old hard stop when the round budget runs out mid-turn: the
 *  model must stop calling tools and deliver its final answer now, so the
 *  turn ends normally (status done) instead of erroring away everything the
 *  run did. Model-facing wire string, like HISTORY_TRUNCATION_MARKER. */
const ROUND_LIMIT_WRAPUP_NUDGE =
    '\n\n⚠ ROUND LIMIT REACHED: your tool-call budget for this turn is exhausted. '
    + 'Stop calling tools. Based on the work already done, give your final answer now: '
    + 'state what you completed, what remains, and any next steps for the user.';

function contextStatusLine(usedTokens: number, windowTokens?: number | null): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const pct = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
    return `\n\n[Context status: ${pct}% of the ${windowTokens}-token context window is in use (${usedTokens}/${windowTokens} tokens).]`;
}

function contextHint(usedTokens: number, windowTokens?: number | null): string {
    if (!windowTokens || windowTokens <= 0) return '';
    const ratio = usedTokens / windowTokens;
    if (ratio > AUTO_COMPACT_RATIO) {
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
): LocalAgentMessage[] {
    // Proactive compaction keeps its 4k-window floor; forced recovery (the
    // server just rejected the prompt as too long) runs on ANY real window.
    if (!windowTokens || windowTokens < 1 || messages.length < 4) return [];
    // Include tool-schema overhead in the occupancy so the mechanical trim
    // fires on small windows where schemas are a large fraction of the prompt.
    let total = (usedTokens ?? estimateRunTokens(messages)) + toolTokens;
    if (!force && (windowTokens < 4096 || total < windowTokens * AUTO_COMPACT_RATIO)) return [];

    // The LAST user message opens the current turn - everything from there
    // on (assistant tool calls, tool results) must stay intact.
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUser = i; break; }
    }
    if (lastUser <= 1) return [];

    const target = Math.max(2048, Math.floor(windowTokens * AUTO_COMPACT_TARGET_RATIO));
    let start = 1;
    while (start < lastUser && (total > target || (force && start === 1))) {
        let end = start + 1;
        while (end < lastUser && messages[end].role !== 'user') end++;
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
    return Math.min(2048, Math.max(512, derived));
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

async function summarizeDroppedTurns(
    request: LocalAgentRequest,
    dropped: LocalAgentMessage[],
    existingSummary: string | null,
    windowTokens?: number | null,
): Promise<string | null> {
    if (!dropped.length) return null;
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
        );
    }
    prompt += `\n\nDropped turns:\n${conversation}\n\nSummary:`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (request.apiKey) headers['Authorization'] = `Bearer ${request.apiKey}`;
        const resp = await fetch(`${normalizeBaseUrl(request.baseUrl)}/chat/completions`, withDispatcher({
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model: request.model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: summaryMaxTokens(windowTokens),
                temperature: 0.2,
                stream: false,
            }),
        }, request.dispatcher));
        if (!resp.ok) return null;
        const data = await resp.json() as {
            choices?: Array<{ message?: { content?: unknown } }>;
        };
        const summary = data.choices?.[0]?.message?.content;
        if (typeof summary === 'string' && summary.trim()) return summary.trim();
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Compaction WITH summarization: mechanically drops the oldest turns, then
 * asks the local model to summarize what was removed and bakes the summary
 * into the truncation marker. Returns the summary (null when compaction did
 * not trigger or summarization failed - the plain marker stands either way).
 */
async function compactWithSummary(
    messages: LocalAgentMessage[],
    request: LocalAgentRequest,
    windowTokens: number | null | undefined,
    usedTokens: number | undefined,
    existingSummary: string | null,
    toolTokens = 0,
): Promise<string | null> {
    const dropped = compactMessages(messages, windowTokens, usedTokens, toolTokens);
    if (!dropped.length) return null;
    const summary = await summarizeDroppedTurns(request, dropped, existingSummary, windowTokens);
    if (summary) {
        const marker = messages[1];
        if (marker?.role === 'user' && marker.content === HISTORY_TRUNCATION_MARKER) {
            messages[1] = {
                role: 'user',
                content: `${HISTORY_TRUNCATION_MARKER}\n\n[Summary of the removed turns, written by the model itself:]\n${summary}`,
            };
        }
    }
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
    // The system prompt is deliberately NOT counted here: this is the coarse
    // pre-trim, and eating turns here would silently discard material the
    // SUMMARIZING proactive compaction (which does count the assembled
    // system message) could still preserve as a summary.
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
    const rounds = Math.max(1, Math.min(request.maxRounds ?? 12, 32));
    const windowTokens = request.contextWindow;
    // Tool schemas ship on every request and the message-only estimate
    // ignores them - compute once and fold into every occupancy calculation.
    const toolTokens = estimateToolTokens(request.tools);
    // Best occupancy estimate: the stable system prompt, the body messages
    // (history + live prompt), and the tool schemas. Still under-counts code
    // density and chat-template tokens (no client-side tokenizer), so the
    // model should treat the free headroom as optimistic.
    const estimateUsed = (): number => {
        const systemChars = request.systemPrompt.length;
        return Math.ceil(systemChars / 3) + estimateRunTokens(messages.slice(1)) + toolTokens;
    };

    // Context awareness (fill level + progressive hints + task-list reminder)
    // is VOLATILE: it changes every round. It is sent as a TRAILING note, never
    // stored in `messages` and never in the system message - the system prompt
    // must stay byte-stable across rounds or prompt caching (Anthropic
    // cache_control, OpenAI/Google automatic prefix caching) can never hit.
    const tailNoteFor = (usedTokens: number): string =>
        taskListReminderLine(request.taskList ?? [])
        + contextStatusLine(usedTokens, windowTokens)
        + contextHint(usedTokens, windowTokens);

    const history = boundHistory(request.history ?? [], request.contextWindow, toolTokens);
    let imageFormat: ImageUrlFormat = 'data-uri';
    let imageFormatSwapped = false;
    // Overflow recovery is a one-shot per run: if the mechanically compacted
    // retry ALSO overflows, the request itself cannot fit - fail the turn.
    let overflowRecovered = false;
    const buildMessages = (): LocalAgentMessage[] => [
        { role: 'system', content: request.systemPrompt },
        ...history,
        {
            role: 'user',
            content: toUserContent(request, imageFormat),
        },
    ];
    let messages: LocalAgentMessage[] = buildMessages();
    // Rolling compaction summary: each compaction's summary is merged into
    // the next one and reported to the host so it survives across requests.
    let sessionSummary: string | null = null;

    // Proactive auto-compact BEFORE the first request.
    const preSummary = await compactWithSummary(messages, request, windowTokens, undefined, null, toolTokens);
    if (preSummary) {
        sessionSummary = preSummary;
        yield { type: 'compactionSummary', value: preSummary };
    }
    // Occupancy shown to the model in the trailing note. Seeded from the
    // estimate, then replaced with server-reported ground truth each round.
    let noteUsed = estimateUsed();

    yield { type: 'status', value: 'connecting' };

    for (let round = 0; round < rounds; round++) {
        yield { type: 'status', value: round === 0 ? 'running' : 'continuing' };

        const queue = new AsyncPushQueue<StreamDelta>();
        let result: CompletionResult | null = null;
        let requestError: unknown = null;

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
        boundToolResults(messages, windowTokens, toolTokens);

        const requestPromise = requestStreamingCompletion(
            request,
            messages,
            tailNoteFor(noteUsed),
            (delta) => queue.push({ kind: 'text', value: delta }),
            (thinking) => queue.push({ kind: 'thinking', value: thinking }),
        )
            .then((value) => { result = value; return value; })
            .catch((err) => { requestError = err; })
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
        if (requestError) {
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
                messages = buildMessages();
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
            // ratio gate and estimate are exactly what failed here), keep
            // the bare truncation marker, and retry ONCE.
            if (
                !overflowRecovered
                && windowTokens
                && requestError instanceof Error
                && CONTEXT_OVERFLOW_RE.test(requestError.message)
            ) {
                overflowRecovered = true;
                if (compactMessages(messages, windowTokens, undefined, toolTokens, true).length) {
                    noteUsed = estimateUsed();
                    requestError = null;
                    round--;
                    continue;
                }
            }
            throw requestError;
        }
        const finalResult = result ?? await requestPromise.then((r) => r);
        if (!finalResult) throw new Error('Model returned no completion result.');

        if (finalResult.usage) yield { type: 'usage', usage: finalResult.usage };

        // Live awareness + mid-run compaction from ground-truth usage. A
        // local model crossing 90% of its window mid-turn (tool outputs
        // accumulate fast on 4k–16k windows) gets its oldest turns dropped
        // NOW instead of failing the next request outright.
        if (finalResult.usage?.promptTokens != null) {
            let used = finalResult.usage.promptTokens + (finalResult.usage.completionTokens ?? 0);
            if (windowTokens && used >= windowTokens * AUTO_COMPACT_RATIO) {
                const summary = await compactWithSummary(
                    messages, request, windowTokens, used, sessionSummary,
                );
                if (summary) {
                    sessionSummary = summary;
                    yield { type: 'compactionSummary', value: summary };
                }
                used = Math.min(used, estimateUsed());
            }
            // Update the trailing note's occupancy for the NEXT round; the
            // system message itself is left untouched so the prompt prefix
            // stays cacheable.
            noteUsed = used;
        }

        if (!finalResult.toolCalls.length) {
            if (finalResult.text) {
                yield { type: 'assistantMessage', text: finalResult.text, toolCalls: [] };
            }
            yield { type: 'status', value: 'done' };
            return;
        }

        yield { type: 'assistantMessage', text: finalResult.text, toolCalls: finalResult.toolCalls };

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

            const execResult = await executor.execute(call);
            messages.push({ role: 'tool', tool_call_id: call.id, content: execResult.output, isError: execResult.isError === true });
            yield {
                type: 'toolResult',
                id: call.id,
                tool: call.name,
                output: execResult.output,
                isError: execResult.isError,
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
                yield { type: 'steer', text, ...(steer.attachments?.length ? { attachments: steer.attachments } : {}) };
            }
        }
    }

    // Round budget exhausted while the model was still calling tools. A hard
    // stop here throws away everything the run did mid-turn and surfaces as
    // an error bubble; instead, give the model ONE tool-free wrap-up round
    // (tools omitted from the body so strict servers never offer them) to
    // deliver its final answer/summary, then end the turn normally.
    yield { type: 'status', value: 'continuing' };
    const wrapMessages: LocalAgentMessage[] = [
        { role: 'system', content: (messages[0]?.content ?? request.systemPrompt) + ROUND_LIMIT_WRAPUP_NUDGE },
        ...messages.slice(1),
    ];
    // The wrap-up runs at peak context - bound tool output too, or the nudge
    // itself overflows a small window. The wrap-up sends `tools: []`, so no
    // schema tokens need to be reserved.
    boundToolResults(wrapMessages, windowTokens, 0);

    // The wrap-up runs when the conversation is at its largest, so the same
    // one-shot overflow recovery as the main loop applies: on a server-side
    // context-overflow rejection, compact deterministically (forced - the
    // estimate just proved wrong) and retry ONCE. The system message at
    // index 0 survives compaction, so the nudge rides on the retry as-is.
    let wrapRecovered = false;
    let wrapResult: CompletionResult | null = null;
    let wrapError: unknown = null;
    for (let wrapAttempt = 0; wrapAttempt < 2; wrapAttempt++) {
        wrapResult = null;
        wrapError = null;
        const wrapQueue = new AsyncPushQueue<StreamDelta>();
        const wrapPromise = requestStreamingCompletion(
            { ...request, tools: [] },
            wrapMessages,
            tailNoteFor(noteUsed),
            (delta) => wrapQueue.push({ kind: 'text', value: delta }),
            (thinking) => wrapQueue.push({ kind: 'thinking', value: thinking }),
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
        if (
            wrapRecovered
            || !windowTokens
            || !(wrapError instanceof Error)
            || !CONTEXT_OVERFLOW_RE.test(wrapError.message)
            || !compactMessages(wrapMessages, windowTokens, undefined, toolTokens, true).length
        ) break;
        wrapRecovered = true;
    }
    if (wrapError) throw wrapError;
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

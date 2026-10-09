import type { TaskListItem } from '../taskList';

export type XratuRuntimeMode = 'cloud' | 'local';

/**
 * Reasoning-effort variants a model may accept, ordered weakest → strongest.
 * `none` disables reasoning; `default` is encoded as `null`/absent (omit the
 * parameter so the runtime's own default applies). Superset of the efforts
 * providers report (OpenAI's `minimal..high`, OpenRouter's `xhigh`/`max`).
 */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** Ordered weakest → strongest; the single source for validating persisted
 *  levels and filtering provider-reported effort lists. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

/** Effort levels a model accepts with reasoning enabled. Excludes `none`. */
export const REASONING_EFFORTS: readonly ThinkingLevel[] = [
    'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

export interface LocalModelConnection {
    id: string;
    runtime: 'ollama' | 'lm-studio' | 'llama.cpp' | 'vllm' | 'custom';
    name: string;
    baseUrl: string;
    apiKey?: string | null;
    model?: string;
}

/** Provider-reported per-1M-token price, always normalized to USD. */
export interface LocalModelPricing {
    input: number;
    output: number;
    cachedInput?: number;
    /** Cache-WRITE rate (falls back to 1.25x `input` at cost time). */
    cachedInputWrite?: number;
    /** The provider advertises the model as free. */
    free?: boolean;
}

export interface LocalModelInfo {
    id: string;
    object?: string;
    ownedBy?: string;
    /** Human-readable name when the provider sends one (OpenAI `name` style
     *  or Kaya/OpenRouter display names). */
    displayName?: string;
    contextWindow?: number;
    /** True when `contextWindow` came from the provider payload (not the
     *  curated fallback). Only reported windows are persisted per host so a
     *  curated table update is never shadowed by a stale cache. */
    contextWindowReported?: boolean;
    /** Maximum output tokens per response, when reported. */
    maxOutputTokens?: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
    /** True when the model performs internal reasoning / thinking. */
    supportsReasoning?: boolean;
    /** Effort variants the provider reported for this model, ordered. Absent =
     *  the provider does not expose effort selection (offer the default set).
     *  An EMPTY array is never stored - it would wrongly read as "no levels". */
    reasoningLevels?: ThinkingLevel[];
    /** Provider-reported per-1M-token USD pricing. */
    pricing?: LocalModelPricing;
}

export interface LocalRuntimeStatus {
    mode: 'local';
    connectionId: string;
    baseUrl: string;
    connected: boolean;
    models: LocalModelInfo[];
    error?: string;
}

// ---------------------------------------------------------------------------
// Agent-loop types. Moved verbatim from localAgent.ts, which re-exports every
// name below so `import ... from ./local/localAgent` keeps working. Home of
// the shared shapes the wire adapters, context management and compaction all
// need - keeping them here is what lets those modules stay siblings instead
// of importing each other.

export type LocalChatTextContent = string;

export interface LocalImageAttachment {
    name: string;
    mimeType: string;
    dataBase64: string;
}

/**
 * An image produced by a TOOL (not by the user): an MCP screenshot, a rendered
 * chart, whatever a tool decides is worth showing the model. Kept distinct from
 * `LocalImageAttachment` because the lifecycle differs - an attachment is a
 * user-supplied prompt part, a tool image is tool OUTPUT that rides the tool
 * result row.
 *
 * `width`/`height` are declared by the producer when it knows them. They are
 * not on the wire, so they are the only way to estimate an image's token cost
 * without decoding the base64 (see `estimateMessageTokens`); without them the
 * estimate falls back to a conservative fixed figure.
 */
export interface LocalToolImage {
    mimeType: string;
    dataBase64: string;
    /** Intrinsic pixel size, when the producer knows it. */
    width?: number;
    height?: number;
    /** Short description shown in the transcript. Never sent to a provider. */
    caption?: string;
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

/** What one tool execution hands back to the agent loop. */
export interface LocalToolResult {
    /** Text half of the result - always present, may be empty. */
    output: string;
    isError?: boolean;
    /**
     * Image half of the result. Optional everywhere so existing executors and
     * the subagent wrapper need no change; when present the images ride the
     * tool message as inline image blocks (after the text, so the model reads
     * the description first - see the note at each serializer).
     */
    images?: LocalToolImage[];
}

export type LocalAgentEvent =
    | { type: 'chunk'; value: string }
    | { type: 'thinking'; value: string }
    | { type: 'toolCall'; id: string; tool: string; args: Record<string, unknown> }
    | { type: 'toolResult'; id: string; tool: string; output: string; isError?: boolean; images?: LocalToolImage[] }
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
        /**
         * `width`/`height` are LOCAL bookkeeping for token estimation, never
         * serialized (see `estimateImageTokens` and `stripLocalImageFields`).
         * A producer that knows its own output size - a browser screenshot
         * knows its viewport - sets them so the estimate is the real
         * high-detail formula instead of the size-agnostic fallback.
         */
        image_url?: { url: string; width?: number; height?: number };
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
    /** OAuth permission to use a ChatGPT plan via the public Responses API. */
    subscription?: boolean;
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
    /** Provider-specific request headers (OAuth routing headers such as
     *  ChatGPT-Account-Id). Applied AFTER the standard Authorization and
     *  content headers, so a name collision would REPLACE them - which is
     *  correct for an OAuth credential (the resolved bearer is the whole
     *  point) but means a provider must not smuggle a reserved name in
     *  here. */
    headers?: Record<string, string>;
    /** OAuth credentials only: called when the provider answers 401 so the
     *  turn can force a token refresh and replay the request ONCE. Returns
     *  the fresh access token, or null to give up and surface the 401. */
    onUnauthorized?: () => Promise<string | null>;
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
    /** Tool names that run as a CONCURRENT group within a round: several
     *  calls to these tools in one assistant message execute in parallel
     *  (e.g. multiple subagent delegations). Everything else keeps the
     *  serial in-order path. Absent/empty = fully serial rounds, the
     *  default. Tool results stream as each call completes; the model
     *  ledger rows are pushed in completion order (which is what the
     *  replayed history stores, so run and replay stay byte-identical). */
    parallelTools?: string[];
    /** Max simultaneous calls inside a `parallelTools` group; the rest start
     *  as slots free up. Each parallel call can be a whole nested agent loop
     *  with its own context window and round budget, so an uncapped group is
     *  an uncapped bill. Undefined = no limit (every call at once). */
    parallelToolLimit?: number;
}

export interface LocalToolExecutor {
    execute(
        call: LocalToolCall,
        /** Called with incremental output for long-running tools (terminal
         *  commands). Optional: executors may ignore it. */
        onOutput?: (chunk: string) => void,
    ): Promise<LocalToolResult>;
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

export type XratuRuntimeMode = 'cloud' | 'local';

/**
 * Reasoning-effort variants a model may accept, ordered weakest → strongest.
 * `none` disables reasoning; `default` is encoded as `null`/absent (omit the
 * parameter so the runtime's own default applies). Superset of the efforts
 * providers report (OpenAI's `minimal..high`, OpenRouter's `xhigh`/`max`).
 */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ordered weakest → strongest; the single source for validating persisted
 *  levels and filtering provider-reported effort lists. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
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

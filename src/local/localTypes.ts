export type XratuRuntimeMode = 'cloud' | 'local';

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

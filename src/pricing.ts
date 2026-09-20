/**
 * Per-model token pricing and cost estimation.
 *
 * Prices are USD per 1M tokens, curated from each provider's published list.
 * They drift - the table is a convenience default, and `overrides` (from the
 * `xratu.pricing` setting) always win. An unknown model returns null so the UI
 * shows nothing rather than a wrong number.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

export interface ModelPrice {
    /** USD per 1M input tokens. */
    input: number;
    /** USD per 1M output tokens. */
    output: number;
    /** USD per 1M cached-input tokens (falls back to `input`). */
    cachedInput?: number;
}

/** Partial price the user can set in `xratu.pricing[model]`. */
export interface PriceOverride {
    input?: number;
    output?: number;
    cachedInput?: number;
}

export interface CostEstimate {
    /** Amount in the requested currency. */
    amount: number;
    currency: 'USD' | 'IRT';
}

export interface UsageLike {
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens?: number | null;
}

/** Ordered most-specific-first; matched against the lowercased model id. */
const PRICE_TABLE: ReadonlyArray<readonly [RegExp, ModelPrice]> = [
    // Anthropic
    [/claude-(fable|mythos)-5/, { input: 10, output: 50, cachedInput: 0.25 }],
    [/claude-opus-5|claude-opus-4-8|claude-opus-4-7|claude-opus-4-6/, { input: 5, output: 25, cachedInput: 0.5 }],
    [/claude-sonnet-5/, { input: 2, output: 10, cachedInput: 0.2 }],
    [/claude-sonnet-4-6/, { input: 3, output: 15, cachedInput: 0.3 }],
    [/claude-sonnet-4-5|claude-sonnet-4\b/, { input: 3, output: 15, cachedInput: 0.3 }],
    [/claude-haiku-4-5/, { input: 1, output: 5, cachedInput: 0.1 }],
    // OpenAI
    [/gpt-6-astra/, { input: 10, output: 50, cachedInput: 1 }],
    [/gpt-5\.6-sol/, { input: 4, output: 20, cachedInput: 0.4 }],
    [/gpt-5\.6-terra/, { input: 2, output: 12, cachedInput: 0.2 }],
    [/gpt-5\.6-luna/, { input: 0.2, output: 1.2, cachedInput: 0.02 }],
    [/gpt-5\.5-pro/, { input: 30, output: 180, cachedInput: 30 }],
    [/gpt-5\.5/, { input: 5, output: 30, cachedInput: 0.5 }],
    [/gpt-5\.4-pro/, { input: 30, output: 180, cachedInput: 30 }],
    [/gpt-5\.4-mini/, { input: 0.75, output: 4.5, cachedInput: 0.075 }],
    [/gpt-5\.4-nano/, { input: 0.2, output: 1.25, cachedInput: 0.02 }],
    [/gpt-5\.4/, { input: 2.5, output: 15, cachedInput: 0.25 }],
    [/gpt-5\.3-codex|gpt-5\.2-codex|gpt-5\.2/, { input: 1.75, output: 14, cachedInput: 0.175 }],
    [/gpt-5\.1-codex-max/, { input: 1.25, output: 10, cachedInput: 0.125 }],
    [/gpt-5\.1-codex-mini/, { input: 0.25, output: 2, cachedInput: 0.025 }],
    [/gpt-5\.1-codex|gpt-5\.1|gpt-5-codex|gpt-5\b/, { input: 1.07, output: 8.5, cachedInput: 0.107 }],
    [/gpt-5-nano/, { input: 0.05, output: 0.4, cachedInput: 0.005 }],
    [/gpt-4o-mini/, { input: 0.15, output: 0.6, cachedInput: 0.075 }],
    [/gpt-4o/, { input: 2.5, output: 10, cachedInput: 1.25 }],
    [/o3-mini/, { input: 1.1, output: 4.4, cachedInput: 0.55 }],
    // Google
    [/gemini-3\.(8|7|6)-flash/, { input: 1.5, output: 7.5, cachedInput: 0.15 }],
    [/gemini-3\.5-flash-lite/, { input: 0.3, output: 2.5, cachedInput: 0.03 }],
    [/gemini-3\.5-flash/, { input: 1.5, output: 9, cachedInput: 0.15 }],
    [/gemini-3\.1-pro/, { input: 2, output: 12, cachedInput: 0.2 }],
    [/gemini-3-flash/, { input: 0.5, output: 3, cachedInput: 0.05 }],
    // xAI
    [/grok-4\.6|grok-4\.5/, { input: 2, output: 6, cachedInput: 0.5 }],
    // DeepSeek
    [/deepseek-v4-pro/, { input: 1.74, output: 3.48, cachedInput: 0.145 }],
    [/deepseek-v4\.1-flash/, { input: 0.3, output: 1.2, cachedInput: 0.006 }],
    [/deepseek-v4-flash|deepseek-flash/, { input: 0.14, output: 0.28, cachedInput: 0.028 }],
    // Z.AI / GLM
    [/glm-5\.3-flash/, { input: 0.15, output: 0.5, cachedInput: 0.03 }],
    [/glm-5\.(3|2|1)/, { input: 1.4, output: 4.4, cachedInput: 0.26 }],
    [/glm-5\b/, { input: 1, output: 3.2, cachedInput: 0.2 }],
    // Moonshot / Kimi
    [/kimi-k3/, { input: 3, output: 15, cachedInput: 0.3 }],
    [/kimi-k2\.7-code|kimi-k2\.6/, { input: 0.95, output: 4, cachedInput: 0.16 }],
    [/kimi-k2\.5/, { input: 0.6, output: 3, cachedInput: 0.1 }],
    // MiniMax
    [/minimax-m3|minimax-m2\.7|minimax-m2\.5/, { input: 0.3, output: 1.2, cachedInput: 0.06 }],
    // Qwen
    [/qwen3\.8-max/, { input: 2, output: 6, cachedInput: 0.25 }],
    [/qwen3\.8-flash/, { input: 0.15, output: 0.47, cachedInput: 0.016 }],
    [/qwen3\.7-max/, { input: 2.5, output: 7.5, cachedInput: 0.5 }],
    [/qwen3\.7-plus/, { input: 0.4, output: 1.6, cachedInput: 0.04 }],
    [/qwen3\.6-plus/, { input: 0.5, output: 3, cachedInput: 0.05 }],
    [/qwen3\.5-plus/, { input: 0.2, output: 1.2, cachedInput: 0.02 }],
    // Meta Muse Spark
    [/muse-spark-1\.3-contributor|muse-spark-1\.2-contributor/, { input: 0.1, output: 0.2, cachedInput: 0.002 }],
    [/muse-spark-1\.3|muse-spark-1\.2/, { input: 1.25, output: 4.25, cachedInput: 0.15 }],
    // Xiaomi MiMo
    [/mimo-v2\.5-pro/, { input: 0.435, output: 0.87, cachedInput: 0.003625 }],
    [/mimo-v2\.5|mimo-v2-pro|mimo-v2-omni/, { input: 0.14, output: 0.28, cachedInput: 0.0028 }],
    // Others
    [/longcat-2\.0/, { input: 0.3, output: 1.2, cachedInput: 0.006 }],
    [/hy4-preview/, { input: 0.834, output: 2.501, cachedInput: 0.042 }],
    [/hy3/, { input: 0.14, output: 0.58, cachedInput: 0.035 }],
    // Mistral
    [/mistral-large/, { input: 2, output: 6 }],
    [/mistral-small/, { input: 0.2, output: 0.6 }],
];

function sanitizeOverride(override: PriceOverride | undefined): ModelPrice | null {
    if (!override) return null;
    const input = Number.isFinite(override.input) ? (override.input as number) : NaN;
    const output = Number.isFinite(override.output) ? (override.output as number) : NaN;
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    return {
        input,
        output,
        cachedInput: Number.isFinite(override.cachedInput) ? (override.cachedInput as number) : undefined,
    };
}

/** Resolve a model's price: an exact override wins, else the curated table. */
export function priceForModel(
    model: string,
    overrides?: Record<string, PriceOverride> | null,
): ModelPrice | null {
    const id = model.trim().toLowerCase();
    if (!id) return null;

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (key.trim().toLowerCase() === id) {
                const exact = sanitizeOverride(value);
                if (exact) return exact;
            }
        }
    }
    for (const [pattern, price] of PRICE_TABLE) {
        if (pattern.test(id)) return price;
    }
    return null;
}

/**
 * Cost of one usage record. Cached input is priced at `cachedInput` when
 * provided (the uncached remainder at `input`); output at `output`.
 */
export function costForUsage(
    price: ModelPrice,
    usage: UsageLike,
    currency: 'USD' | 'IRT' = 'USD',
): CostEstimate | null {
    const prompt = Number.isFinite(usage.promptTokens) ? (usage.promptTokens as number) : 0;
    const completion = Number.isFinite(usage.completionTokens) ? (usage.completionTokens as number) : 0;
    if (prompt === 0 && completion === 0) return null;

    const cached = Math.min(
        Number.isFinite(usage.cachedTokens) ? Math.max(0, usage.cachedTokens as number) : 0,
        prompt,
    );
    const uncached = prompt - cached;
    const cachedRate = price.cachedInput ?? price.input;

    const usd = (uncached * price.input + cached * cachedRate + completion * price.output) / 1_000_000;
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { amount: usd, currency };
}

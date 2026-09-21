/**
 * Per-model token pricing and cost estimation.
 *
 * International prices are USD per 1M tokens, curated from each provider's
 * published list. Iranian providers bill in Toman: their prices come either
 * from a curated Toman entry, or from a per-host "gateway rate" (Toman per
 * USD) applied to the USD table. A price carries its own currency and the
 * session total is kept PER CURRENCY - nothing is converted between ledgers,
 * so a stale exchange rate can never corrupt a number.
 *
 * `overrides` (from the `xratu.modelPricing` setting) always win; an unknown
 * model returns null so the UI shows nothing rather than a wrong number.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

export interface ModelPrice {
    /** Rate per 1M tokens, in `currency`. */
    input: number;
    /** Rate per 1M tokens, in `currency`. */
    output: number;
    /** Cached-input rate per 1M tokens (falls back to `input`). */
    cachedInput?: number;
    /** Cache-WRITE rate per 1M tokens. Falls back to `input * 1.25`, the
     *  documented 5-minute-TTL write price for Anthropic and GPT-5.6+. */
    cachedInputWrite?: number;
    /** Currency of these rates. Absent = USD (curated table only); an
     *  explicit override always carries `'USD'` or `'IRT'`. */
    currency?: 'USD' | 'IRT';
}

/** Partial price the user can set in `xratu.modelPricing[model]`. */
export interface PriceOverride {
    input?: number;
    output?: number;
    cachedInput?: number;
    /** Currency for this override. Absent = USD. */
    currency?: 'USD' | 'IRT';
}

/** A gateway's own Toman-per-USD rate (plus optional markup), keyed by host. */
export interface GatewayRate {
    /** Toman charged per 1 USD. */
    tomanPerUsd: number;
    /** Markup percentage applied on top (10 = +10%). */
    markupPercent?: number;
}

/** Context for resolving provider-specific pricing. */
export interface PriceLookup {
    /** Base-URL host of the active provider (`providerIdentity.baseUrlHost`). */
    host?: string | null;
    /** True when the provider is a known Iranian (Toman-billed) one. */
    iranian?: boolean;
    /** Per-host gateway rate from `xratu.providerPricing`. */
    gatewayRate?: GatewayRate | null;
    /** Global fallback rate from `xratu.tomanPerUsd`. */
    fallbackRate?: number | null;
    /** Live, provider-reported USD price (per 1M tokens) for the active model.
     *  Preferred over the curated tables, below an explicit user override. */
    providerPrice?: ModelPrice | null;
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
    /** Prompt tokens WRITTEN to the provider's cache this request. They are a
     *  subset of `promptTokens` on every provider whose total counts them
     *  (OpenAI `cache_write_tokens`, Anthropic `cache_creation_input_tokens`),
     *  and are billed above the plain input rate. */
    cacheWriteTokens?: number | null;
}

/** Cache writes are billed at 1.25x the ordinary input rate for both
 *  Anthropic's 5-minute `ephemeral` TTL and OpenAI's GPT-5.6+ caching. */
const CACHE_WRITE_MULTIPLIER = 1.25;

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
    // NOTE: must precede the generic /gpt-5\b/ entry below - the word boundary
    // matches at "gpt-5" in "gpt-5-nano".
    [/gpt-5-nano/, { input: 0.05, output: 0.4, cachedInput: 0.005 }],
    [/gpt-5\.1-codex|gpt-5\.1|gpt-5-codex|gpt-5\b/, { input: 1.07, output: 8.5, cachedInput: 0.107 }],
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

/**
 * Curated Toman prices for Iranian providers' OWN model ids, in Toman per 1M
 * tokens (`currency: 'IRT'`). Keyed by host pattern + model pattern.
 *
 * DELIBERATELY EMPTY for now: published Iranian prices drift and are not
 * independently verifiable, so we do not ship numbers that look authoritative.
 * Toman costs come from a per-host gateway rate (or the fallback rate) applied
 * to the USD table, or from a user override. Add rows here only with a citable
 * source and a last-updated note.
 */
const IRANIAN_PRICE_TABLE: ReadonlyArray<readonly [RegExp, RegExp, ModelPrice]> = [
];

function applyGatewayRate(price: ModelPrice, tomanPerUsd: number, markupPercent?: number): ModelPrice {
    // Only a positive, finite markup is applied - a negative one would discount
    // below the gateway's own rate and understate the cost.
    const markup = Number.isFinite(markupPercent) && (markupPercent as number) > 0 ? (markupPercent as number) : 0;
    const factor = tomanPerUsd * (1 + markup / 100);
    return {
        input: price.input * factor,
        output: price.output * factor,
        ...(price.cachedInput != null ? { cachedInput: price.cachedInput * factor } : {}),
        currency: 'IRT',
    };
}

function sanitizeOverride(override: PriceOverride | undefined): ModelPrice | null {
    if (!override) return null;
    const input = Number.isFinite(override.input) ? (override.input as number) : NaN;
    const output = Number.isFinite(override.output) ? (override.output as number) : NaN;
    // Reject negative rates too: they would understate (or suppress) a cost.
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
    const cachedInput = Number.isFinite(override.cachedInput) ? (override.cachedInput as number) : undefined;
    if (cachedInput != null && cachedInput < 0) return null;
    return {
        input,
        output,
        ...(cachedInput != null ? { cachedInput } : {}),
        // An explicit override always carries a DEFINITE currency, so callers
        // can tell "USD by intent" from "USD by table default". Curated table
        // entries keep omitting it, so a Toman-billed provider still resolves
        // to IRT through the provider/gateway path.
        currency: override.currency === 'IRT' ? 'IRT' : 'USD',
    };
}

/** The curated USD table only (no overrides, no provider context). */
function usdPriceForModel(id: string): ModelPrice | null {
    for (const [pattern, price] of PRICE_TABLE) {
        if (pattern.test(id)) return price;
    }
    return null;
}

/**
 * Sanitize a live provider-reported price. Provider prices are always
 * normalized to USD per 1M tokens by the metadata layer, so the currency is
 * pinned here - a gateway's per-token table is never reinterpreted as Toman.
 */
function sanitizeProviderPrice(price: ModelPrice | null | undefined): ModelPrice | null {
    if (!price) return null;
    const input = Number.isFinite(price.input) ? price.input : NaN;
    const output = Number.isFinite(price.output) ? price.output : NaN;
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
    const cached = Number.isFinite(price.cachedInput) ? (price.cachedInput as number) : undefined;
    if (cached != null && cached < 0) return null;
    return {
        input,
        output,
        ...(cached != null ? { cachedInput: cached } : {}),
        currency: 'USD',
    };
}

/**
 * Where a resolved rate came from. The Usage page shows this per model, so a
 * user can tell their own corrected rate from the curated table or a gateway's
 * Toman conversion.
 */
export type PriceSource = 'override' | 'provider' | 'toman-table' | 'gateway' | 'usd-table';

/** An effective rate plus how it was resolved. */
export interface ResolvedPrice {
    price: ModelPrice;
    source: PriceSource;
}

/**
 * Resolve a model's price. Order (first hit wins):
 *  1. an exact user override (may carry `currency`);
 *  2. a live provider-reported USD price for this host + model;
 *  3. a curated Toman entry for this host + model;
 *  4. for a Toman-billed provider: per-host gateway rate (else the fallback
 *     rate) applied to the USD layer;
 *  5. the curated USD table for everyone else.
 * A Toman-billed provider with no Toman data resolves to null - never a USD
 * list price dressed up as Toman.
 */
export function resolvePrice(
    model: string,
    overrides?: Record<string, PriceOverride> | null,
    lookup?: PriceLookup | null,
): ResolvedPrice | null {
    const id = model.trim().toLowerCase();
    if (!id) return null;

    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (key.trim().toLowerCase() === id) {
                const exact = sanitizeOverride(value);
                if (exact) return { price: exact, source: 'override' };
            }
        }
    }

    // Live provider metadata beats every curated table, but never a user
    // override. It is the same USD layer the curated table feeds.
    const providerUsd = sanitizeProviderPrice(lookup?.providerPrice);
    const usdLayer = (): ModelPrice | null => providerUsd ?? usdPriceForModel(id);

    // A curated Toman row is a curated table too, so a live provider price
    // takes precedence over it (the row is currently empty by design).
    if (!providerUsd) {
        const host = (lookup?.host ?? '').trim().toLowerCase();
        if (host) {
            for (const [hostRe, modelRe, price] of IRANIAN_PRICE_TABLE) {
                if (hostRe.test(host) && modelRe.test(id)) return { price, source: 'toman-table' };
            }
        }
    }

    const gatewayRate = lookup?.gatewayRate;
    const gatewayRateValue = gatewayRate && Number.isFinite(gatewayRate.tomanPerUsd) && gatewayRate.tomanPerUsd > 0
        ? gatewayRate
        : null;

    if (lookup?.iranian) {
        const usd = usdLayer();
        if (usd) {
            if (gatewayRateValue) return { price: applyGatewayRate(usd, gatewayRateValue.tomanPerUsd, gatewayRateValue.markupPercent), source: 'gateway' };
            const fallback = Number(lookup.fallbackRate);
            if (Number.isFinite(fallback) && fallback > 0) return { price: applyGatewayRate(usd, fallback), source: 'gateway' };
        }
        return null;
    }

    // A non-Iranian host with an explicit gateway rate is a self-configured
    // gateway: bill it in Toman too.
    if (gatewayRateValue) {
        const usd = usdLayer();
        if (usd) return { price: applyGatewayRate(usd, gatewayRateValue.tomanPerUsd, gatewayRateValue.markupPercent), source: 'gateway' };
        return null;
    }

    if (providerUsd) return { price: providerUsd, source: 'provider' };
    const usd = usdPriceForModel(id);
    return usd ? { price: usd, source: 'usd-table' } : null;
}

/** The effective rate for a model, without its source. */
export function priceForModel(
    model: string,
    overrides?: Record<string, PriceOverride> | null,
    lookup?: PriceLookup | null,
): ModelPrice | null {
    return resolvePrice(model, overrides, lookup)?.price ?? null;
}

/**
 * Cost of one usage record. Cached input is priced at `cachedInput` when
 * provided (the uncached remainder at `input`); cache WRITES at `cachedInputWrite`
 * (default 1.25x `input`); output at `output`. The price's own currency wins;
 * `currency` is only the fallback for prices that do not carry one.
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
    // Writes can never overlap reads, and both are subsets of the prompt.
    const cacheWrite = Math.min(
        Number.isFinite(usage.cacheWriteTokens) ? Math.max(0, usage.cacheWriteTokens as number) : 0,
        prompt - cached,
    );
    const uncached = Math.max(0, prompt - cached - cacheWrite);
    const cachedRate = price.cachedInput ?? price.input;
    const writeRate = price.cachedInputWrite ?? price.input * CACHE_WRITE_MULTIPLIER;

    const amount = (uncached * price.input + cached * cachedRate + cacheWrite * writeRate + completion * price.output) / 1_000_000;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { amount, currency: price.currency ?? currency };
}

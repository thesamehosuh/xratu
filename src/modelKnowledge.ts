/**
 * Curated model knowledge used ONLY as a fallback.
 *
 * Providers rarely report a model's real context window, max output, or
 * reasoning support over their model-list endpoints. Without a fallback a
 * 200k–1M token model silently runs at the conservative 8192 default and the
 * session compacts far too early. This table fills those gaps for model
 * families we ship prices for.
 *
 * Precedence at every call site is:
 *   1. the provider's own reported value (authoritative, live),
 *   2. this curated table,
 *   3. the caller's hard default.
 *
 * Every entry is a best-effort, family-typical number and MUST stay
 * user-overridable. When a real published spec differs, prefer reporting the
 * provider value; update this row only with a citation and a dated note.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

/** Curated fallback effort variants. `none` is included so a model that can
 *  only turn reasoning off/on (toggle) is offered Default + Off. */
export type KnownReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelKnowledge {
    /** Total context window in tokens. */
    contextWindow?: number;
    /** Maximum output tokens the model may generate in one response. */
    maxOutputTokens?: number;
    /** True when the model accepts image input. */
    supportsVision?: boolean;
    /** True when the model supports function/tool calling. */
    supportsTools?: boolean;
    /** True when the model performs internal reasoning / thinking. */
    supportsReasoning?: boolean;
    /** Thinking levels the model accepts. Absent = provider default set. */
    reasoningLevels?: readonly KnownReasoningLevel[];
}

/**
 * Ordered most-specific-first; matched against the lowercased model id. Keep
 * the ordering discipline of pricing.ts: a broad family pattern comes AFTER
 * every narrower one it would otherwise shadow.
 *
 * `reasoningLevels` mirrors the provider's effort options. Only OpenRouter
 * reports these over its model list (`reasoning.supported_efforts`); every
 * other provider we ship - OpenCode Zen/Go, Kaya, LM Studio, Ollama, Google
 * native, direct OpenAI/Anthropic, generic OpenAI-compatible - returns no
 * variant metadata, so this table is the only source for them. Values are
 * sourced from the models.dev catalog (2026-09), which is also what OpenCode
 * itself serves from.
 */
const KNOWLEDGE_TABLE: ReadonlyArray<readonly [RegExp, ModelKnowledge]> = [
    // --- Anthropic -------------------------------------------------------
    [/claude-(fable|mythos)-5/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    [/claude-opus-5|claude-opus-4-8|claude-opus-4-7/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    [/claude-opus-4-6/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'max'] }],
    [/claude-opus-4-5/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    [/claude-sonnet-5/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    [/claude-sonnet-4-6/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'max'] }],
    [/claude-sonnet-4/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    [/claude-haiku-4-5/, { contextWindow: 200_000, maxOutputTokens: 64_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- OpenAI ----------------------------------------------------------
    [/gpt-6-astra/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    [/gpt-5\.6|gpt-6/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }],
    [/gpt-5\.(5|4)-pro/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['medium', 'high', 'xhigh'] }],
    [/gpt-5\.3-codex-spark/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }],
    [/gpt-5\.(3|2)-codex/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }],
    [/gpt-5\.1-codex-max/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }],
    [/gpt-5\.1-codex/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    [/gpt-5\.(5|4|3|2)/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'] }],
    [/gpt-5\.1/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['none', 'low', 'medium', 'high'] }],
    [/gpt-5-nano|gpt-5\b|gpt-5-codex/, { contextWindow: 400_000, maxOutputTokens: 128_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['minimal', 'low', 'medium', 'high'] }],
    [/gpt-4o/, { contextWindow: 128_000, maxOutputTokens: 16_384, supportsVision: true, supportsTools: true }],
    [/o3-mini|o3\b|o4-mini/, { contextWindow: 200_000, maxOutputTokens: 100_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Google ----------------------------------------------------------
    [/gemini-3-flash|gemini-3\.(5|6)-flash/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['minimal', 'low', 'medium', 'high'] }],
    [/gemini-3-pro\b/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'high'] }],
    [/gemini-3/, { contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- xAI -------------------------------------------------------------
    [/grok-4\.(6|7)/, { contextWindow: 256_000, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }],
    [/grok-4/, { contextWindow: 256_000, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- DeepSeek --------------------------------------------------------
    [/deepseek-v4-pro/, { contextWindow: 128_000, maxOutputTokens: 64_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['high', 'max'] }],
    [/deepseek-v4\.1|deepseek-v4-flash|deepseek-flash/, { contextWindow: 128_000, maxOutputTokens: 64_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'high', 'max'] }],
    // --- Z.AI / GLM ------------------------------------------------------
    [/glm-5\.3/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'high', 'max'] }],
    [/glm-5\.2/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['high', 'max'] }],
    [/glm-5/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Moonshot / Kimi -------------------------------------------------
    [/kimi-k3/, { contextWindow: 256_000, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['max'] }],
    [/kimi-k2\.(5|6|7)/, { contextWindow: 256_000, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- MiniMax ---------------------------------------------------------
    // M3 is the 1M-context generation; the open M2.x checkpoints top out at
    // 196608 (`max_position_embeddings`, MiniMax-M2.5 config.json). A single
    // `/minimax-m/` row claimed 1M for M2.x too - a 5x OVER-estimate, the
    // harmful direction (the run packs context the model cannot accept). Keep
    // the generic row at the conservative checkpoint size, which also holds for
    // the hosted API's ~204800.
    [/minimax-m3/, { contextWindow: 1_000_000, maxOutputTokens: 40_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    [/minimax-m/, { contextWindow: 196_608, maxOutputTokens: 40_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Qwen ------------------------------------------------------------
    [/qwen3\.8-flash/, { contextWindow: 262_144, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'xhigh'] }],
    [/qwen3\.[5-8]/, { contextWindow: 262_144, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Meta Muse Spark -------------------------------------------------
    [/muse-spark/, { contextWindow: 262_144, maxOutputTokens: 32_000, supportsVision: true, supportsTools: true, supportsReasoning: true, reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'] }],
    // --- Xiaomi MiMo -----------------------------------------------------
    [/mimo-v2/, { contextWindow: 262_144, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Others ----------------------------------------------------------
    [/longcat-2\.0|hy4-preview|hy3/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    [/ling-3\.0/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true, supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high'] }],
    // --- Mistral ---------------------------------------------------------
    [/mistral-large/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true }],
    [/mistral-small/, { contextWindow: 128_000, maxOutputTokens: 32_000, supportsTools: true }],
];

/** Curated fallback knowledge for a model id, or null when we have none. */
export function knownModelKnowledge(modelId: string): ModelKnowledge | null {
    const id = modelId.trim().toLowerCase();
    if (!id) return null;
    for (const [pattern, knowledge] of KNOWLEDGE_TABLE) {
        if (pattern.test(id)) return knowledge;
    }
    return null;
}

/** Curated context window only, or undefined. */
export function knownContextWindow(modelId: string): number | undefined {
    return knownModelKnowledge(modelId)?.contextWindow;
}

/** Curated max output only, or undefined. */
export function knownMaxOutputTokens(modelId: string): number | undefined {
    return knownModelKnowledge(modelId)?.maxOutputTokens;
}

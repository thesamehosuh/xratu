/**
 * Provider model-list normalization + a host-scoped metadata cache.
 *
 * Every provider answers a model-list probe with a different shape. This
 * module turns all of them into one `LocalModelInfo[]` - context window, max
 * output, vision/tools/reasoning support, display name, and (when reported)
 * per-1M-token USD pricing - then fills the gaps from the curated
 * `modelKnowledge` table.
 *
 * It also owns the persisted catalog cache: entries are keyed by provider
 * HOST, so the same model id served by two providers never shares a window or
 * a price. A stale entry is still served (better than nothing) but flagged so
 * the caller can refresh in the background.
 *
 * Pure and dependency-free so it can be unit-tested without VS Code.
 */

import { knownModelKnowledge } from '../modelKnowledge';
import { THINKING_LEVELS, REASONING_EFFORTS, type ThinkingLevel, type LocalModelInfo } from './localTypes';

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

/** Largest plausible context window; anything above is a parse artifact. */
const MAX_WINDOW = 10_000_000;

function toWindow(value: unknown): number | undefined {
    const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
    if (!Number.isFinite(n) || n < 1024 || n > MAX_WINDOW) return undefined;
    return Math.floor(n);
}

/** First field that yields a valid window. */
function windowFrom(...values: unknown[]): number | undefined {
    for (const value of values) {
        const n = toWindow(value);
        if (n !== undefined) return n;
    }
    return undefined;
}

/**
 * Normalize a per-token or per-1k price into USD per 1M tokens.
 * `unit` is how many tokens the number covers (1 or 1000).
 */
function toPerMillion(value: unknown, unit: 1 | 1000): number | undefined {
    // null / '' / whitespace must be UNKNOWN, not a free 0 - `Number(null)` and
    // `Number('')` both coerce to 0, which would mark the model free.
    const n = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(n) || n < 0) return undefined;
    const perMillion = n * (1_000_000 / unit);
    // Guard against NaN from weird exponents while keeping tiny real rates.
    return Number.isFinite(perMillion) ? perMillion : undefined;
}

function modalityHasImage(value: unknown): boolean | undefined {
    if (!Array.isArray(value)) return undefined;
    const list = value.map((v) => String(v).toLowerCase());
    if (!list.length) return undefined;
    return list.includes('image') || list.includes('vision');
}

function stringList(value: unknown): string[] | null {
    return Array.isArray(value) ? value.map((v) => String(v).toLowerCase()) : null;
}

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/**
 * Normalize a provider's effort-variant list into our canonical levels,
 * preserving the provider's order (highest first). Unknown spellings are
 * dropped. Returns undefined when the list is absent or holds nothing we
 * recognize, so the caller can fall back to the curated/default set instead
 * of restricting the picker to nothing.
 */
function normalizeEfforts(value: unknown): ThinkingLevel[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<ThinkingLevel>();
    const out: ThinkingLevel[] = [];
    for (const raw of value) {
        const level = String(raw).trim().toLowerCase() as ThinkingLevel;
        if (!THINKING_LEVEL_SET.has(level) || seen.has(level)) continue;
        seen.add(level);
        out.push(level);
    }
    return out.length ? out : undefined;
}

/**
 * Pull the model's effort variants from any provider shape. OpenRouter nests
 * them under `reasoning.supported_efforts`; some gateways use a flat field.
 * An explicit `null` means the gateway accepts every effort, so offer them all
 * (minus `none`, which the picker's Default already implies). The property must
 * be probed with `in` - a `??` chain would treat the meaningful null as absent.
 */
function pickEfforts(m: any): ThinkingLevel[] | undefined {
    const reasoning = m?.reasoning;
    if (reasoning && typeof reasoning === 'object' && 'supported_efforts' in reasoning) {
        if (reasoning.supported_efforts === null) return [...REASONING_EFFORTS];
        const normalized = normalizeEfforts(reasoning.supported_efforts);
        if (normalized) return normalized;
    }
    const raw = m?.reasoning_efforts ?? m?.supported_efforts ?? m?.reasoningLevels;
    if (raw === null) return [...REASONING_EFFORTS];
    return normalizeEfforts(raw);
}

// ---------------------------------------------------------------------------
// Per-shape adapters
// ---------------------------------------------------------------------------

/** OpenAI-compatible `/v1/models` item (also OpenRouter, vLLM, llama.cpp). */
function parseOpenAiItem(m: any): LocalModelInfo | null {
    const id = typeof m?.id === 'string' ? m.id : undefined;
    if (!id) return null;
    const model: LocalModelInfo = { id };
    if (typeof m.object === 'string') model.object = m.object;
    if (typeof m.owned_by === 'string') model.ownedBy = m.owned_by;
    else if (typeof m.ownedBy === 'string') model.ownedBy = m.ownedBy;
    if (typeof m.name === 'string' && m.name.trim() && m.name !== id) model.displayName = m.name;

    model.contextWindow = windowFrom(
        m.context_length,
        m.context_window,
        m.contextWindow,
        m.max_context_length,
        m.max_model_len,
        m.top_provider?.context_length,
    );
    model.maxOutputTokens = windowFrom(
        m.max_completion_tokens,
        m.max_output_tokens,
        m.maxOutputTokens,
        m.top_provider?.max_completion_tokens,
    );

    // OpenRouter nests capability truth under architecture /
    // supported_parameters; other gateways use a flat `capabilities` object.
    const inputModalities = modalityHasImage(m.architecture?.input_modalities);
    if (inputModalities !== undefined) model.supportsVision = inputModalities;
    else if (m.capabilities?.vision === true) model.supportsVision = true;
    else if (m.capabilities?.vision === false) model.supportsVision = false;

    const params = stringList(m.supported_parameters);
    if (params) {
        model.supportsTools = params.includes('tools') || params.includes('tool_choice');
        model.supportsReasoning = params.includes('reasoning')
            || params.includes('reasoning_effort')
            || params.includes('include_reasoning');
    } else if (m.capabilities?.trained_for_tool_use === true) {
        model.supportsTools = true;
    } else if (m.capabilities?.tools === true) {
        model.supportsTools = true;
    } else if (m.capabilities?.tools === false) {
        model.supportsTools = false;
    }

    // Per-model reasoning variants (OpenRouter `reasoning.supported_efforts`).
    // A present `reasoning` object is authoritative for capability too, so it
    // overrides a `supported_parameters` list that omitted the reasoning flags.
    const efforts = pickEfforts(m);
    if (efforts) model.reasoningLevels = efforts;
    if (m.reasoning && typeof m.reasoning === 'object') model.supportsReasoning = true;

    // OpenRouter: pricing is USD per token as a STRING.
    if (m.pricing && typeof m.pricing === 'object') {
        const input = toPerMillion(m.pricing.prompt, 1);
        const output = toPerMillion(m.pricing.completion, 1);
        if (input !== undefined && output !== undefined) {
            const cachedInput = toPerMillion(
                m.pricing.input_cache_read ?? m.pricing.prompt_cache_read ?? m.pricing.cache_read,
                1,
            );
            const cachedInputWrite = toPerMillion(
                m.pricing.input_cache_write ?? m.pricing.prompt_cache_write ?? m.pricing.cache_write,
                1,
            );
            model.pricing = {
                input,
                output,
                ...(cachedInput !== undefined ? { cachedInput } : {}),
                ...(cachedInputWrite !== undefined ? { cachedInputWrite } : {}),
                ...(input === 0 && output === 0 ? { free: true } : {}),
            };
        }
    }
    return model;
}

/** Kaya AI native listing: per-1k prices, `maxTokens` = context window. */
function parseKayaItem(m: any): LocalModelInfo | null {
    const id = typeof m?.id === 'string' ? m.id : (typeof m?.name === 'string' ? m.name : undefined);
    if (!id) return null;
    const model: LocalModelInfo = { id, object: 'model' };
    if (typeof m.provider === 'string') model.ownedBy = m.provider;
    const display = typeof m.displayName === 'string' ? m.displayName : (typeof m.name === 'string' ? m.name : undefined);
    if (display && display !== id) model.displayName = display;

    model.contextWindow = windowFrom(m.maxTokens, m.context_length, m.context_window, m.contextLength);
    model.maxOutputTokens = windowFrom(m.maxOutputTokens, m.max_completion_tokens);

    const modality = modalityHasImage(m.inputModalities);
    if (modality !== undefined) model.supportsVision = modality;
    else if (typeof m.modality === 'string' && /image/.test(m.modality)) model.supportsVision = true;
    if (typeof m.supportsTools === 'boolean') model.supportsTools = m.supportsTools;
    if (typeof m.supportsReasoning === 'boolean') model.supportsReasoning = m.supportsReasoning;
    const efforts = pickEfforts(m);
    if (efforts) model.reasoningLevels = efforts;

    const input = toPerMillion(m.inputPricePer1k, 1000);
    const output = toPerMillion(m.outputPricePer1k, 1000);
    if (input !== undefined && output !== undefined) {
        const cachedInput = toPerMillion(m.cacheReadPricePer1k, 1000);
        const free = m.isFree === true || (input === 0 && output === 0);
        model.pricing = {
            input,
            output,
            ...(cachedInput !== undefined ? { cachedInput } : {}),
            ...(free ? { free: true } : {}),
        };
    }
    return model;
}

/** LM Studio native `/api/v1/models`. */
function parseLmStudioItem(m: any): LocalModelInfo | null {
    const id = m?.key ?? m?.id;
    if (typeof id !== 'string' || !id) return null;
    const model: LocalModelInfo = { id, object: 'model' };
    if (typeof m.publisher === 'string') model.ownedBy = m.publisher;
    if (typeof m.display_name === 'string' && m.display_name !== id) model.displayName = m.display_name;
    model.contextWindow = windowFrom(
        m.loaded_instances?.[0]?.config?.context_length,
        m.max_context_length,
        m.context_length,
    );
    if (m.capabilities?.vision === true) model.supportsVision = true;
    if (m.capabilities?.trained_for_tool_use === true) model.supportsTools = true;
    if (m.capabilities?.reasoning === true) model.supportsReasoning = true;
    return model;
}

/** Ollama `/api/tags` entry - only the name is reliable here. */
function parseOllamaItem(m: any): LocalModelInfo | null {
    const id = m?.name ?? m?.model ?? m?.id;
    if (typeof id !== 'string' || !id) return null;
    const model: LocalModelInfo = { id, object: 'model', ownedBy: 'ollama' };
    const caps = stringList(m.capabilities);
    if (caps && caps.length) {
        model.supportsVision = caps.includes('vision');
        model.supportsTools = caps.includes('tools');
        model.supportsReasoning = caps.includes('thinking') || caps.includes('reasoning');
    }
    return model;
}

/** Google Generative Language `/v1beta/models`. */
function parseGoogleItem(m: any): LocalModelInfo | null {
    const raw = typeof m?.name === 'string' ? m.name : undefined;
    if (!raw) return null;
    // The native list mixes chat models with embedding / image / AQA entries.
    // Only a model that advertises generateContent can drive the agent loop;
    // keep unknown (no method list) so an older shape is not emptied out.
    if (Array.isArray(m.supportedGenerationMethods)) {
        const methods = m.supportedGenerationMethods.map((v: unknown) => String(v));
        if (!methods.includes('generateContent')) return null;
    }
    const id = raw.replace(/^models\//, '');
    if (!id) return null;
    const model: LocalModelInfo = { id, object: 'model', ownedBy: 'google' };
    if (typeof m.displayName === 'string' && m.displayName !== id) model.displayName = m.displayName;
    model.contextWindow = windowFrom(m.inputTokenLimit, m.contextWindow);
    model.maxOutputTokens = windowFrom(m.outputTokenLimit, m.maxOutputTokens);
    return model;
}

// ---------------------------------------------------------------------------
// Shape dispatch
// ---------------------------------------------------------------------------

function looksLikeLmStudio(m: any): boolean {
    return typeof m?.key === 'string' || typeof m?.max_context_length === 'number' || Array.isArray(m?.loaded_instances);
}

function looksLikeKaya(m: any): boolean {
    return m?.inputPricePer1k !== undefined
        || m?.outputPricePer1k !== undefined
        || Array.isArray(m?.inputModalities)
        || typeof m?.maxTokens === 'number';
}

function looksLikeGoogle(m: any): boolean {
    return typeof m?.inputTokenLimit === 'number'
        || Array.isArray(m?.supportedGenerationMethods)
        || (typeof m?.name === 'string' && m.name.startsWith('models/'));
}

function looksLikeOllama(m: any): boolean {
    return (typeof m?.name === 'string' || typeof m?.model === 'string')
        && (m?.digest !== undefined || m?.size !== undefined || m?.modified_at !== undefined || m?.details !== undefined);
}

/**
 * Parse a raw model-list payload into normalized models. Returns null when the
 * payload is not a list we recognize (the caller then treats the endpoint as
 * unreachable, matching probeLocalEndpoint's contract).
 */
export function parseModelList(payload: any): LocalModelInfo[] | null {
    const items: any[] = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
                ? payload.models
                : [];
    if (!items.length) return null;

    const out: LocalModelInfo[] = [];
    for (const m of items) {
        let parsed: LocalModelInfo | null = null;
        if (looksLikeLmStudio(m)) parsed = parseLmStudioItem(m);
        else if (looksLikeKaya(m)) parsed = parseKayaItem(m);
        else if (looksLikeGoogle(m)) parsed = parseGoogleItem(m);
        else if (looksLikeOllama(m)) parsed = parseOllamaItem(m);
        else parsed = parseOpenAiItem(m);
        if (parsed) {
            if (parsed.contextWindow !== undefined) parsed.contextWindowReported = true;
            out.push(parsed);
        }
    }
    return out.length ? out : null;
}

/**
 * Fill missing metadata from the curated knowledge table. Provider-reported
 * values always win (including an explicit `false` capability), so a model the
 * provider has authoritatively described is never second-guessed.
 */
export function applyModelKnowledge(models: LocalModelInfo[]): LocalModelInfo[] {
    return models.map((model) => {
        const known = knownModelKnowledge(model.id);
        if (!known) return model;
        const merged: LocalModelInfo = { ...model };
        if (merged.contextWindow === undefined) merged.contextWindow = known.contextWindow;
        if (merged.maxOutputTokens === undefined) merged.maxOutputTokens = known.maxOutputTokens;
        if (merged.supportsVision === undefined) merged.supportsVision = known.supportsVision;
        if (merged.supportsTools === undefined) merged.supportsTools = known.supportsTools;
        if (merged.supportsReasoning === undefined) merged.supportsReasoning = known.supportsReasoning;
        if (!merged.reasoningLevels?.length && known.reasoningLevels && merged.supportsReasoning !== false) {
            merged.reasoningLevels = [...known.reasoningLevels];
        }
        return merged;
    });
}

// ---------------------------------------------------------------------------
// Host-scoped cache
// ---------------------------------------------------------------------------

export interface ModelCatalogEntry {
    /** Epoch ms of the successful fetch that produced `models`. */
    fetchedAt: number;
    models: LocalModelInfo[];
}

export type ModelCatalog = Record<string, ModelCatalogEntry>;

/** Metadata changes slowly; six hours keeps a long session from re-probing. */
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export function normalizeCatalogHost(host: string | null | undefined): string | null {
    const h = (host ?? '').trim().toLowerCase();
    return h || null;
}

/** Parse a persisted catalog, dropping anything malformed. Never throws. */
export function readModelCatalog(raw: unknown): ModelCatalog {
    let parsed: any = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {};
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const catalog: ModelCatalog = {};
    for (const [host, entry] of Object.entries<any>(parsed)) {
        const key = normalizeCatalogHost(host);
        if (!key || !entry || typeof entry !== 'object') continue;
        const models = Array.isArray(entry.models)
            ? entry.models
                .filter((m: any) => m && typeof m.id === 'string' && m.id)
                .map(sanitizeCachedModel)
            : [];
        if (!models.length) continue;
        catalog[key] = {
            fetchedAt: Number.isFinite(entry.fetchedAt) ? Number(entry.fetchedAt) : 0,
            models,
        };
    }
    return catalog;
}

/** Drop an unrecognized persisted effort variant so a stale/corrupt cache can
 *  never surface a level the picker cannot label or the request cannot send. */
function sanitizeCachedModel(m: any): LocalModelInfo {
    const levels = Array.isArray(m.reasoningLevels)
        ? m.reasoningLevels.filter((l: unknown) => typeof l === 'string' && THINKING_LEVEL_SET.has(l))
        : undefined;
    if (!levels?.length) {
        const copy = { ...m };
        delete copy.reasoningLevels;
        return copy;
    }
    return { ...m, reasoningLevels: levels };
}

export function serializeModelCatalog(catalog: ModelCatalog): string {
    return JSON.stringify(catalog);
}

/** Replace one host's entry, leaving other hosts untouched. */
export function setCatalogEntry(
    catalog: ModelCatalog,
    host: string | null | undefined,
    models: LocalModelInfo[],
    now: number,
): ModelCatalog {
    const key = normalizeCatalogHost(host);
    if (!key) return catalog;
    return { ...catalog, [key]: { fetchedAt: now, models } };
}

export interface CatalogLookup {
    models: LocalModelInfo[];
    fetchedAt: number;
    /** True when the entry is older than the TTL (still served). */
    stale: boolean;
}

/** The cached models for a host, or null when nothing has been cached. */
export function catalogEntryFor(
    catalog: ModelCatalog,
    host: string | null | undefined,
    now: number,
    ttlMs = MODEL_CATALOG_TTL_MS,
): CatalogLookup | null {
    const key = normalizeCatalogHost(host);
    if (!key) return null;
    const entry = catalog[key];
    if (!entry || !entry.models.length) return null;
    return { models: entry.models, fetchedAt: entry.fetchedAt, stale: now - entry.fetchedAt > ttlMs };
}

/** A single model's cached metadata for a host, or null. */
export function cachedModelInfo(
    catalog: ModelCatalog,
    host: string | null | undefined,
    modelId: string,
): LocalModelInfo | null {
    const key = normalizeCatalogHost(host);
    if (!key || !modelId) return null;
    const models = catalog[key]?.models;
    if (!models) return null;
    const want = modelId.trim().toLowerCase();
    for (const m of models) {
        if (m.id.toLowerCase() === want) return m;
    }
    return null;
}

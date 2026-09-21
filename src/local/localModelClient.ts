/**
 * Local model discovery + capability probing.
 *
 * Probes Ollama, LM Studio, llama.cpp, vLLM, and custom OpenAI-compatible
 * servers. Runs entirely in the extension host.
 */

import { LocalModelInfo, LocalModelConnection } from './localTypes';
import { isLikelyLocalUrl } from '../endpointGuard';
import { normalizeBaseUrl } from './baseUrl';
import { applyModelKnowledge, parseModelList } from './modelMetadata';

export interface DiscoveredLocalModel {
    connection: LocalModelConnection;
    models: LocalModelInfo[];
    supportsTools: boolean;
    supportsVision: boolean;
}

// ---------------------------------------------------------------------------
// Known local runtimes and their default endpoints
// ---------------------------------------------------------------------------

interface LocalRuntimePreset {
    runtime: LocalModelConnection['runtime'];
    name: string;
    baseUrl: string;
    /** Path suffix Ollama needs - other runtimes use /v1 */
    apiPath?: string;
}

export const LOCAL_RUNTIME_PRESETS: LocalRuntimePreset[] = [
    { runtime: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434' },
    { runtime: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234' },
    { runtime: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000' },
    { runtime: 'llama.cpp', name: 'llama.cpp', baseUrl: 'http://localhost:8080' },
];

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function fetchJson(url: string, signal?: AbortSignal, timeoutMs = 1800, apiKey?: string | null, dispatcher?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const init: RequestInit = {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                // Remote BYOK providers (OpenAI, Groq, …) require auth even
                // for model listing; local runtimes ignore the header.
                ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            },
            signal: controller.signal,
        };
        // Route remote model-list probes through the proxy too - otherwise a
        // user behind filtering can send prompts but never discover models.
        const response = await fetch(url, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
        if (!response.ok) return null;
        return response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Google's OpenAI-compat base (`/v1beta/openai`) has no model list of its
 *  own; the native Generative Language list lives at `/v1beta/models` and
 *  takes the API key as a `key` query parameter (not a bearer token). */
function isGoogleGenerativeHost(baseUrl: string): boolean {
    try {
        const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `http://${baseUrl.trim()}`).hostname.toLowerCase();
        return host === 'generativelanguage.googleapis.com';
    } catch {
        return false;
    }
}

function googleModelsUrl(apiKey?: string | null): string {
    const base = 'https://generativelanguage.googleapis.com/v1beta/models';
    return apiKey ? `${base}?key=${encodeURIComponent(apiKey)}` : base;
}

async function postJson(url: string, body: unknown, signal?: AbortSignal, timeoutMs = 2500, dispatcher?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const init: RequestInit = {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        };
        const response = await fetch(url, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
        if (!response.ok) return null;
        return response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** Largest `*.context_length` in an Ollama `/api/show` model_info blob.
 *  @internal Exposed for tests. */
export function ollamaContextLength(modelInfo: any): number | undefined {
    if (!modelInfo || typeof modelInfo !== 'object') return undefined;
    let best: number | undefined;
    for (const [key, value] of Object.entries(modelInfo)) {
        if (!key.toLowerCase().endsWith('context_length')) continue;
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1024 && n <= 10_000_000) {
            if (best === undefined || n > best) best = Math.floor(n);
        }
    }
    return best;
}

/**
 * Ollama's `/api/tags` carries no window or capability metadata. `/api/show`
 * does, so enrich each model (bounded, best-effort) with its real context
 * length and `capabilities` list. Failures leave the entry untouched.
 */
async function enrichOllamaModels(
    origin: string,
    models: LocalModelInfo[],
    signal?: AbortSignal,
): Promise<LocalModelInfo[]> {
    const MAX_DETAIL_PROBES = 20;
    return Promise.all(models.map(async (model, index) => {
        if (index >= MAX_DETAIL_PROBES) return model;
        const detail = await postJson(`${origin}/api/show`, { model: model.id }, signal);
        if (!detail) return model;
        const contextWindow = ollamaContextLength(detail.model_info);
        const caps: string[] = Array.isArray(detail.capabilities)
            ? detail.capabilities.map((c: unknown) => String(c).toLowerCase())
            : [];
        return {
            ...model,
            ...(contextWindow !== undefined ? { contextWindow, contextWindowReported: true } : {}),
            ...(caps.length ? {
                supportsVision: caps.includes('vision'),
                supportsTools: caps.includes('tools'),
                supportsReasoning: caps.includes('thinking') || caps.includes('reasoning'),
            } : {}),
        };
    }));
}

/**
 * Probe a single base URL for available models.
 * Returns null if the endpoint is unreachable.
 */
export async function probeLocalEndpoint(
    baseUrl: string,
    signal?: AbortSignal,
    apiKey?: string | null,
    dispatcher?: unknown,
): Promise<{ models: LocalModelInfo[] } | null> {
    const rawBase = baseUrl.trim().replace(/\/+$/, '');
    // Never proxy on-machine runtimes: a proxy would break localhost and is
    // pointless for local traffic.
    const proxy = isLikelyLocalUrl(baseUrl) ? undefined : dispatcher;

    // Localhost runtimes get the tight 1.8s deadline; remote gateways need
    // seconds - e.g. kayaai.ir serves a ~230KB models list that takes
    // 2-3s over a slow international route.
    const probeTimeoutMs = isLikelyLocalUrl(baseUrl) ? 1800 : 10_000;

    // Google's OpenAI-compat root cannot list models; probe the native
    // Generative Language endpoint with the key as a query parameter.
    if (isGoogleGenerativeHost(baseUrl)) {
        const google = await fetchJson(googleModelsUrl(apiKey), signal, probeTimeoutMs, null, proxy);
        const parsed = parseModelList(google);
        if (parsed) return { models: applyModelKnowledge(parsed) };
    }

    // LM Studio's native v1 model endpoint exposes max_context_length and
    // per-loaded-instance context/capability metadata that the OpenAI /v1/models
    // compatibility endpoint often omits. Prefer it when available.
    if (/localhost:1234|127\.0\.0\.1:1234/.test(rawBase)) {
        const native = await fetchJson(`${rawBase}/api/v1/models`, signal, probeTimeoutMs, apiKey, proxy);
        const parsed = parseModelList(native);
        if (parsed) {
            // `type` distinguishes chat models from embedding/reranker entries.
            // Only the native shape carries `models`; anything else is returned
            // as parsed. When the native list has NO chat model, fall through
            // to the OpenAI-compatible probe instead of surfacing models that
            // cannot drive the agent loop.
            if (Array.isArray(native?.models)) {
                const llms = native.models.filter((m: any) => !m?.type || m.type === 'llm');
                const ids = new Set(llms.map((m: any) => m?.key ?? m?.id));
                const chatOnly = parsed.filter((m) => ids.has(m.id));
                if (chatOnly.length) return { models: applyModelKnowledge(chatOnly) };
            } else {
                return { models: applyModelKnowledge(parsed) };
            }
        }
    }

    // Ollama: the native /api/tags + /api/show pair is the only source of real
    // context windows and capabilities - its OpenAI-compat list omits both.
    if (/localhost:11434|127\.0\.0\.1:11434/.test(rawBase)) {
        let origin: string | null = null;
        try {
            origin = new URL(rawBase).origin;
        } catch {
            origin = null;
        }
        if (origin) {
            const tags = await fetchJson(`${origin}/api/tags`, signal, probeTimeoutMs, apiKey, proxy);
            const parsedTags = parseModelList(tags);
            if (parsedTags) {
                const enriched = await enrichOllamaModels(origin, parsedTags, signal);
                return { models: applyModelKnowledge(enriched) };
            }
        }
    }

    // Try OpenAI-compatible /v1/models (vLLM, llama.cpp, custom, OpenRouter,
    // Kaya's /api root, LM Studio fallback). A malformed base URL must keep
    // probeLocalEndpoint's "unreachable -> null" contract - normalizeBaseUrl
    // throws on invalid input, and one throw here would reject the whole
    // discoverLocalRuntimes Promise.all.
    let modelsUrl: string;
    try {
        modelsUrl = `${normalizeBaseUrl(baseUrl)}/models`;
    } catch {
        return null;
    }
    const openai = await fetchJson(modelsUrl, signal, probeTimeoutMs, apiKey, proxy);
    const parsed = parseModelList(openai);
    if (parsed) return { models: applyModelKnowledge(parsed) };

    // Fall back to Ollama's native /api/tags endpoint.
    const ollama = await fetchJson(`${rawBase}/api/tags`, signal, probeTimeoutMs, apiKey, proxy);
    const parsedOllama = parseModelList(ollama);
    if (parsedOllama) return { models: applyModelKnowledge(parsedOllama) };

    return null;
}

/**
 * Discover all reachable local runtimes from the known presets.
 */
export async function discoverLocalRuntimes(
    signal?: AbortSignal,
): Promise<DiscoveredLocalModel[]> {
    const probes = await Promise.all(LOCAL_RUNTIME_PRESETS.map(async (preset) => {
        const probed = await probeLocalEndpoint(preset.baseUrl, signal);
        if (!probed) return null;
        const connection: LocalModelConnection = {
            id: `local-${preset.runtime}`,
            runtime: preset.runtime,
            name: preset.name,
            baseUrl: preset.baseUrl,
            apiKey: null,
            model: probed.models[0]?.id,
        };
        const capabilities = inferCapabilities(preset.runtime, probed.models);
        return { connection, models: probed.models, ...capabilities };
    }));
    return probes.filter((x): x is DiscoveredLocalModel => x !== null);
}

/**
 * Probe a user-configured custom OpenAI-compatible endpoint.
 */
export async function probeCustomEndpoint(
    baseUrl: string,
    signal?: AbortSignal,
    apiKey?: string | null,
    dispatcher?: unknown,
): Promise<DiscoveredLocalModel | null> {
    const probed = await probeLocalEndpoint(baseUrl, signal, apiKey, dispatcher);
    if (!probed) return null;

    const connection: LocalModelConnection = {
        id: `local-custom-${Date.now().toString(36)}`,
        runtime: 'custom',
        name: 'Custom',
        baseUrl,
        apiKey: null,
        model: probed.models[0]?.id,
    };

    const capabilities = inferCapabilities('custom', probed.models);

    return {
        connection,
        models: probed.models,
        ...capabilities,
    };
}

// ---------------------------------------------------------------------------
// Capability inference
// ---------------------------------------------------------------------------

/**
 * Heuristic capability detection. We cannot know for certain whether a local
 * model supports tools or vision without trying it, so we use the model id as
 * a signal and let the user override.
 */
function inferCapabilities(
    runtime: LocalModelConnection['runtime'],
    models: LocalModelInfo[],
): { supportsTools: boolean; supportsVision: boolean } {
    const ids = models.map((m) => m.id.toLowerCase()).join(' ');

    // Vision keywords commonly appear in multimodal model names.
    const visionHints = ['vision', 'vl', 'multimodal', 'llava', 'qwen2-vl', 'qwen-vl', 'minicpm', 'bakllava', 'moondream'];
    const supportsVision = visionHints.some((hint) => ids.includes(hint));

    // Most modern local models support function calling; we assume yes unless
    // the model name suggests otherwise.
    const noToolHints = ['instruct', 'base', 'pretrain'];
    const supportsTools = !noToolHints.some((hint) => ids.includes(hint));

    // Ollama models generally support tools if the model does.
    if (runtime === 'ollama') {
        return { supportsTools, supportsVision };
    }

    return { supportsTools, supportsVision };
}

/**
 * Check whether a specific model id is likely vision-capable.
 */
export function modelIsLikelyVision(modelId: string): boolean {
    const id = modelId.toLowerCase();
    const visionHints = ['vision', 'vl', 'multimodal', 'llava', 'qwen2-vl', 'qwen-vl', 'minicpm', 'bakllava', 'moondream'];
    return visionHints.some((hint) => id.includes(hint));
}

/**
 * Check whether a specific model id is likely to support function calling.
 */
export function modelLikelySupportsTools(modelId: string): boolean {
    const id = modelId.toLowerCase();
    const noToolHints = ['instruct-only', 'base-', '-pretrain'];
    return !noToolHints.some((hint) => id.includes(hint));
}

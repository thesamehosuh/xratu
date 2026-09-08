/**
 * Local model discovery + capability probing.
 *
 * Probes Ollama, LM Studio, llama.cpp, vLLM, and custom OpenAI-compatible
 * servers. Runs entirely in the extension - the remote backend is never
 * responsible for discovering local models.
 */

import { LocalModelInfo, LocalModelConnection } from './localTypes';
import { isLikelyLocalUrl } from '../endpointGuard';

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

async function fetchJson(url: string, signal?: AbortSignal, timeoutMs = 1800, apiKey?: string | null): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                // Remote BYOK providers (OpenAI, Groq, …) require auth even
                // for model listing; local runtimes ignore the header.
                ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            },
            signal: controller.signal,
        });
        if (!response.ok) return null;
        return response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

function numberFromFields(...values: unknown[]): number | undefined {
    for (const value of values) {
        const n = typeof value === 'string' ? Number(value.replaceAll(',', '')) : Number(value);
        if (Number.isFinite(n) && n >= 1024 && n <= 10_000_000) return Math.floor(n);
    }
    return undefined;
}

/**
 * Probe a single base URL for available models.
 * Returns null if the endpoint is unreachable.
 */
export async function probeLocalEndpoint(
    baseUrl: string,
    signal?: AbortSignal,
    apiKey?: string | null,
): Promise<{ models: LocalModelInfo[] } | null> {
    const rawBase = baseUrl.trim().replace(/\/+$/, '');

    // Localhost runtimes get the tight 1.8s deadline; remote gateways need
    // seconds - e.g. kayaai.ir serves a ~230KB models list that takes
    // 2-3s over a slow international route.
    const probeTimeoutMs = isLikelyLocalUrl(baseUrl) ? 1800 : 10_000;

    // LM Studio's native v1 model endpoint exposes max_context_length and
    // per-loaded-instance context/capability metadata that the OpenAI /v1/models
    // compatibility endpoint often omits. Prefer it when available.
    if (/localhost:1234|127\.0\.0\.1:1234/.test(rawBase)) {
        const native = await fetchJson(`${rawBase}/api/v1/models`, signal, probeTimeoutMs, apiKey);
        if (native && Array.isArray(native.models)) {
            return {
                models: native.models
                    .filter((m: any) => !m.type || m.type === 'llm')
                    .map((m: any) => ({
                        id: m.key ?? m.id,
                        object: 'model',
                        ownedBy: m.publisher,
                        contextWindow: numberFromFields(
                            m.loaded_instances?.[0]?.config?.context_length,
                            m.max_context_length,
                            m.context_length,
                        ),
                        supportsVision: m.capabilities?.vision === true,
                        supportsTools: m.capabilities?.trained_for_tool_use === true,
                    }))
                    .filter((m: LocalModelInfo) => !!m.id),
            };
        }
    }

    // Try OpenAI-compatible /v1/models (vLLM, llama.cpp, custom, LM Studio fallback).
    const openai = await fetchJson(`${normalizeForProbe(baseUrl)}/models`, signal, probeTimeoutMs, apiKey);
    if (openai && Array.isArray(openai.data)) {
        return {
            models: openai.data.map((m: any) => ({
                id: m.id,
                object: m.object,
                ownedBy: m.owned_by ?? m.ownedBy,
                contextWindow: numberFromFields(m.context_window, m.context_length, m.max_context_length, m.max_model_len, m.contextWindow),
                supportsVision: m.capabilities?.vision === true || undefined,
                supportsTools: m.capabilities?.trained_for_tool_use === true || undefined,
            })),
        };
    }

    // Kaya AI-style native gateway listing: { models: [{ id, provider,
    // maxTokens, inputModalities, ... }] } at <base>/models when the base
    // is an /api root. Richer than the OpenAI shape - maxTokens is the
    // context window, inputModalities detects vision.
    if (openai && Array.isArray(openai.models) && openai.models.some((m: any) => typeof m?.id === 'string')) {
        return {
            models: openai.models
                .filter((m: any) => typeof m.id === 'string')
                .map((m: any) => ({
                    id: m.id,
                    object: 'model',
                    ownedBy: m.provider ?? m.ownedBy,
                    contextWindow: numberFromFields(m.maxTokens, m.context_length, m.context_window),
                    supportsVision: (Array.isArray(m.inputModalities) && m.inputModalities.includes('image')) || undefined,
                })),
        };
    }

    // Fall back to Ollama's native /api/tags endpoint.
    const ollama = await fetchJson(`${baseUrl.replace(/\/+$/, '')}/api/tags`, signal, probeTimeoutMs, apiKey);
    if (ollama && Array.isArray(ollama.models)) {
        return {
            models: ollama.models.map((m: any) => ({
                id: m.name ?? m.id,
                object: 'model',
                ownedBy: 'ollama',
                contextWindow: numberFromFields(m.context_length, m.context_window),
            })),
        };
    }

    return null;
}

function normalizeForProbe(value: string): string {
    const raw = value.trim().replace(/\/+$/, '');
    return /\/(v1|api)$/.test(raw) ? raw : `${raw}/v1`;
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
): Promise<DiscoveredLocalModel | null> {
    const probed = await probeLocalEndpoint(baseUrl, signal, apiKey);
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

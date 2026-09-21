/**
 * Which HTTP API a provider/model speaks.
 *
 * Xratu's local runtime historically assumed OpenAI `/chat/completions` for
 * everything. OpenCode Zen/Go are OpenAI-compatible for most models but route
 * a few families to the Anthropic Messages API (`/messages`) and others to the
 * OpenAI Responses API (`/responses`) on the SAME base URL - so the endpoint
 * cannot be inferred from the base URL, only from the model id.
 *
 * This is deliberately scoped to hosts we have a documented model->endpoint
 * map for. Everywhere else stays `chat`, because e.g. OpenRouter serves Claude
 * models over `/chat/completions`.
 *
 * Pure and dependency-free so it can be unit-tested.
 */

export type ApiStyle = 'chat' | 'messages' | 'responses' | 'google';

/** OpenCode Zen/Go model families documented under `/messages`. */
const OPENCODE_MESSAGES_PREFIXES = ['claude-', 'qwen', 'minimax-'];

/** OpenCode Zen/Go model families documented under `/responses`. */
const OPENCODE_RESPONSES_PREFIXES = ['gpt-', 'grok-', 'muse-spark-'];

/** OpenCode Zen model families served by the Google Generative Language API
 *  (`/models/{model}:streamGenerateContent`). */
const OPENCODE_GOOGLE_PREFIXES = ['gemini-'];

/** OpenCode models that are NOT chat models and cannot drive the agent loop:
 *  Jev is a structured-decision endpoint (`/systemone`), and the image /
 *  embedding / audio ids are not text generation. Kept out of the picker. */
const OPENCODE_NON_CHAT_RE = /^jev-|image|embedding|embed-|tts-|whisper|dall-e|moderation|rerank/i;

function hostOf(baseUrl: string): string | null {
    const raw = baseUrl.trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        // hostname (not host): an explicit :port must not defeat the match.
        return new URL(withScheme).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** True for opencode.ai (and subdomains), where the model decides the API. */
export function isOpenCodeHost(baseUrl: string): boolean {
    const host = hostOf(baseUrl);
    return host === 'opencode.ai' || (!!host && host.endsWith('.opencode.ai'));
}

/** True for openrouter.ai (and subdomains). OpenRouter serves every model over
 *  `/chat/completions` but only honors the unified `reasoning: { effort }`
 *  parameter for many of them - a bare `reasoning_effort` is dropped/ignored
 *  on those. The chat transport branches on this. */
export function isOpenRouterHost(baseUrl: string): boolean {
    const host = hostOf(baseUrl);
    return host === 'openrouter.ai' || (!!host && host.endsWith('.openrouter.ai'));
}

/**
 * Resolve the API style for a request. Defaults to `chat` unless the host is
 * OpenCode and the model id maps to a different documented endpoint.
 */
export function resolveApiStyle(baseUrl: string, model: string): ApiStyle {
    if (!isOpenCodeHost(baseUrl)) return 'chat';
    const m = model.trim().toLowerCase();
    if (OPENCODE_MESSAGES_PREFIXES.some((prefix) => m.startsWith(prefix))) return 'messages';
    if (OPENCODE_RESPONSES_PREFIXES.some((prefix) => m.startsWith(prefix))) return 'responses';
    if (OPENCODE_GOOGLE_PREFIXES.some((prefix) => m.startsWith(prefix))) return 'google';
    return 'chat';
}

/** True for OpenCode model ids that are not chat models (Jev, image,
 *  embedding, audio) and must not be offered as agent models. */
export function isNonChatModel(model: string): boolean {
    return OPENCODE_NON_CHAT_RE.test(model.trim());
}

/**
 * Hosts where sending a stable `prompt_cache_key` is known to be accepted and
 * to improve caching (OpenAI's own APIs and the OpenCode gateway that proxies
 * them). OpenAI routes a request to a cache machine by hashing the initial
 * tokens plus this key, so reusing one key per conversation raises the cache
 * hit rate on models before GPT-5.6. Deliberately NOT sent to arbitrary
 * OpenAI-compatible servers - strict ones 400 on unknown top-level fields, and
 * a local runtime's cache is per-process anyway.
 */
export function supportsPromptCacheKey(baseUrl: string): boolean {
    const host = hostOf(baseUrl);
    if (!host) return false;
    if (isOpenCodeHost(baseUrl)) return true;
    return host === 'openai.com' || host.endsWith('.openai.com');
}

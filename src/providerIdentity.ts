/**
 * Map a saved base URL back to a provider preset id/label.
 *
 * Keep this in sync with the presets in webview-ui/src/components/
 * CredentialsPage.tsx: a missed host makes a saved credential re-display as
 * "Custom" and lose its identity. Pure and dependency-free so it is testable.
 */

/** Host fragment -> provider id, ordered most-specific first. */
export const PROVIDER_HOSTS: ReadonlyArray<readonly [string, string]> = [
    ['generativelanguage.googleapis.com', 'google'],
    ['opencode.ai', 'opencode'],
    ['openrouter.ai', 'openrouter'],
    ['api.deepseek.com', 'deepseek'],
    ['api.mistral.ai', 'mistral'],
    ['api.x.ai', 'xai'],
    ['x.ai', 'xai'],
    ['api.perplexity.ai', 'perplexity'],
    ['api.cohere.com', 'cohere'],
    ['api.together.xyz', 'together'],
    ['api.fireworks.ai', 'fireworks'],
    ['api.cerebras.ai', 'cerebras'],
    ['integrate.api.nvidia.com', 'nvidia'],
    ['router.huggingface.co', 'huggingface'],
    ['api.sambanova.ai', 'sambanova'],
    ['api.moonshot.cn', 'moonshot'],
    ['api.z.ai', 'zai'],
    ['api.openai.com', 'openai'],
    ['api.groq.com', 'groq'],
    ['googleapis.com', 'google'],
    ['openai.com', 'openai'],
    ['groq.com', 'groq'],
    ['deepseek.com', 'deepseek'],
    ['mistral.ai', 'mistral'],
    ['together.xyz', 'together'],
    ['fireworks.ai', 'fireworks'],
    ['cerebras.ai', 'cerebras'],
    ['anthropic.com', 'anthropic'],
    ['kayaai.ir', 'kayaai'],
    ['api.avalai.ir', 'avalai'],
    ['api.metisai.ir', 'metis'],
    ['ai.liara.ir', 'liara'],
    ['api.arvancloud.ir', 'arvan'],
    ['api.navaan.ai', 'navaan'],
    ['localhost:11434', 'ollama'],
    ['localhost:1234', 'lmstudio'],
    ['localhost:8000', 'vllm'],
];

// Labels mirror the CredentialsPage presets exactly - a saved credential
// shows its stored label, so a divergence surfaces as an inconsistent name.
export const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq', kayaai: 'Kaya AI',
    deepseek: 'DeepSeek', mistral: 'Mistral', together: 'Together AI',
    fireworks: 'Fireworks AI', cerebras: 'Cerebras', anthropic: 'Anthropic',
    google: 'Google Gemini', xai: 'xAI', ollama: 'Ollama', lmstudio: 'LM Studio',
    opencode: 'OpenCode Zen', 'opencode-go': 'OpenCode Go',
    perplexity: 'Perplexity', cohere: 'Cohere',
    nvidia: 'NVIDIA NIM', huggingface: 'Hugging Face', sambanova: 'SambaNova',
    moonshot: 'Moonshot AI', zai: 'Z.AI', vllm: 'vLLM',
    avalai: 'Avalai', metis: 'Metis AI', liara: 'Liara AI',
    arvan: 'ArvanCloud AI', navaan: 'Navaan',
    custom: 'Custom',
};

function parseBaseUrl(baseUrl: string): URL | null {
    const raw = baseUrl.trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        return new URL(withScheme);
    } catch {
        return null;
    }
}

/** @internal Exposed for tests. Returns the host (hostname[:port]) or null. */
export function baseUrlHost(baseUrl: string): string | null {
    return parseBaseUrl(baseUrl)?.host.toLowerCase() ?? null;
}

export function providerIdForUrl(baseUrl: string): string {
    const parsed = parseBaseUrl(baseUrl);
    if (!parsed) return 'custom';
    const host = parsed.host.toLowerCase();
    // OpenCode Zen and Go share the opencode.ai host - the PATH tells them
    // apart (Go lives under /zen/go/v1). Test the parsed pathname so a query
    // or fragment cannot hide it.
    if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
        return /\/zen\/go(?:\/|$)/i.test(parsed.pathname) ? 'opencode-go' : 'opencode';
    }
    for (const [fragment, id] of PROVIDER_HOSTS) {
        // Match the HOST only, on an exact or dot-boundary basis. Matching the
        // whole URL with `includes` let a path, user-info or lookalike domain
        // impersonate a provider (proxy.example/api.openai.com, notopenai.com),
        // and a wrong id makes discovery skip a genuine custom endpoint.
        if (host === fragment || host.endsWith(`.${fragment}`)) return id;
    }
    return 'custom';
}

export function providerLabelForUrl(baseUrl: string): string {
    return PROVIDER_LABELS[providerIdForUrl(baseUrl)] ?? 'Custom';
}

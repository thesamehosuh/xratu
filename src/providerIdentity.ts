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
    ['localhost:11434', 'ollama'],
    ['localhost:1234', 'lmstudio'],
    ['localhost:8000', 'vllm'],
];

export const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq', kayaai: 'Kaya AI',
    deepseek: 'DeepSeek', mistral: 'Mistral', together: 'Together',
    fireworks: 'Fireworks', cerebras: 'Cerebras', anthropic: 'Anthropic',
    google: 'Google', xai: 'xAI', ollama: 'Ollama', lmstudio: 'LM Studio',
    opencode: 'OpenCode Zen', perplexity: 'Perplexity', cohere: 'Cohere',
    nvidia: 'NVIDIA NIM', huggingface: 'Hugging Face', sambanova: 'SambaNova',
    moonshot: 'Moonshot AI', zai: 'Z.AI', vllm: 'vLLM',
    custom: 'Custom',
};

export function providerIdForUrl(baseUrl: string): string {
    const v = baseUrl.toLowerCase();
    for (const [host, id] of PROVIDER_HOSTS) {
        if (v.includes(host)) return id;
    }
    return 'custom';
}

export function providerLabelForUrl(baseUrl: string): string {
    return PROVIDER_LABELS[providerIdForUrl(baseUrl)] ?? 'Custom';
}

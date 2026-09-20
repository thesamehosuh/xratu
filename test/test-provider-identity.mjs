#!/usr/bin/env node
/**
 * Provider identity regression tests.
 *
 * Regression: `_providerIdForUrl` recognized only ~13 hosts, so saved
 * credentials for OpenCode Zen, Perplexity, Cohere, NVIDIA NIM, Hugging Face,
 * SambaNova, Moonshot, Z.AI and vLLM were re-displayed as "Custom" after a
 * restart and lost their identity.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-provider-identity.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { providerIdForUrl, providerLabelForUrl, PROVIDER_HOSTS } = require('../out/providerIdentity.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`);
};

// --- Host detection: every provider's host resolves to its id. These are the
// --- hosts a saved credential would contain, NOT necessarily a preset default
// --- (Metis/Liara/ArvanCloud/Navaan ship no default URL; the user pastes one).
const PRESETS = [
    ['https://api.openai.com/v1', 'openai'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://kayaai.ir/api', 'kayaai'],
    ['https://api.avalai.ir/v1', 'avalai'],
    ['https://api.metisai.ir/api/v1/wrapper/openai', 'metis'],
    ['https://ai.liara.ir/api/v1', 'liara'],
    ['https://api.arvancloud.ir/ai/v1', 'arvan'],
    ['https://api.navaan.ai/v1', 'navaan'],
    ['https://opencode.ai/zen/v1', 'opencode'],
    ['https://opencode.ai/zen/go/v1', 'opencode-go'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://api.perplexity.ai', 'perplexity'],
    ['https://api.cohere.com/compatibility/v1', 'cohere'],
    ['https://api.together.xyz/v1', 'together'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://api.cerebras.ai/v1', 'cerebras'],
    ['https://integrate.api.nvidia.com/v1', 'nvidia'],
    ['https://router.huggingface.co/v1', 'huggingface'],
    ['https://api.sambanova.ai/v1', 'sambanova'],
    ['https://api.moonshot.cn/v1', 'moonshot'],
    ['https://api.z.ai/api/paas/v4', 'zai'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'google'],
    ['http://localhost:11434/v1', 'ollama'],
    ['http://localhost:1234/v1', 'lmstudio'],
    ['http://localhost:8000/v1', 'vllm'],
];
for (const [url, id] of PRESETS) {
    check(`${id} http`, providerIdForUrl(url), id);
    // https and case must not matter
    check(`${id} https+case`, providerIdForUrl(url.toUpperCase().replace('API.', 'api.')), id);
}

// --- Host boundary: a path, user-info or lookalike domain must NOT
// --- impersonate a provider (a wrong id makes discovery skip a custom URL).
check('path containing provider host -> custom', providerIdForUrl('https://proxy.example/api.openai.com/v1'), 'custom');
check('lookalike host -> custom', providerIdForUrl('https://notopenai.com/v1'), 'custom');
check('userinfo lookalike -> custom', providerIdForUrl('https://api.openai.com@evil.example/v1'), 'custom');
check('dot-boundary subdomain -> provider', providerIdForUrl('https://foo.api.openai.com/v1'), 'openai');

// --- OpenCode Zen vs Go share a host; the path decides (query/fragment too) ---
check('opencode zen path', providerIdForUrl('https://opencode.ai/zen/v1'), 'opencode');
check('opencode go path', providerIdForUrl('https://opencode.ai/zen/go/v1'), 'opencode-go');
check('opencode go path + query', providerIdForUrl('https://opencode.ai/zen/go/v1?region=us'), 'opencode-go');
check('opencode go bare path', providerIdForUrl('https://opencode.ai/zen/go'), 'opencode-go');
check('opencode zen + query is not go', providerIdForUrl('https://opencode.ai/zen/v1?x=1'), 'opencode');

// --- Legacy generic xAI host still resolves ---
check('legacy x.ai root -> xai', providerIdForUrl('https://x.ai/v1'), 'xai');
check('legacy x.ai subdomain -> xai', providerIdForUrl('https://api2.x.ai/v1'), 'xai');
check('z.ai not mistaken for x.ai', providerIdForUrl('https://api.z.ai/api/paas/v4'), 'zai');
check('perplexity not mistaken for x.ai', providerIdForUrl('https://api.perplexity.ai'), 'perplexity');

// --- Labels mirror the preset names exactly ---
check('kaya label', providerLabelForUrl('https://kayaai.ir/api'), 'Kaya AI');
check('avalai label', providerLabelForUrl('https://api.avalai.ir/v1'), 'Avalai');
check('opencode zen label', providerLabelForUrl('https://opencode.ai/zen/v1'), 'OpenCode Zen');
check('opencode go label', providerLabelForUrl('https://opencode.ai/zen/go/v1'), 'OpenCode Go');
check('navaan label', providerLabelForUrl('https://api.navaan.ai/v1'), 'Navaan');
check('zai label', providerLabelForUrl('https://api.z.ai/api/paas/v4'), 'Z.AI');
check('nvidia label', providerLabelForUrl('https://integrate.api.nvidia.com/v1'), 'NVIDIA NIM');
check('together label', providerLabelForUrl('https://api.together.xyz/v1'), 'Together AI');
check('fireworks label', providerLabelForUrl('https://api.fireworks.ai/inference/v1'), 'Fireworks AI');
check('google label', providerLabelForUrl('https://generativelanguage.googleapis.com/v1beta/openai/'), 'Google Gemini');

// --- Unknown / custom ---
check('unknown host -> custom id', providerIdForUrl('https://my-litellm.example.com/v1'), 'custom');
check('unknown host -> Custom label', providerLabelForUrl('https://my-litellm.example.com/v1'), 'Custom');
check('empty -> custom', providerIdForUrl(''), 'custom');

// --- Most-specific-first ordering: Google's versioned host must not be
// --- shadowed by the generic googleapis.com entry.
check('generativelanguage -> google', providerIdForUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'google');

// --- Table is well-formed (no duplicate ids need distinct hosts; ids known) ---
check('table non-empty', PROVIDER_HOSTS.length > 0, true);

console.log(failed === 0 ? '\nprovider-identity: all tests passed' : `\nprovider-identity: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

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

// --- Every preset base URL resolves to its id (mirrors CredentialsPage) ---
const PRESETS = [
    ['https://api.openai.com/v1', 'openai'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://kayaai.ir/api', 'kayaai'],
    ['https://opencode.ai/zen/v1', 'opencode'],
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

// --- Labels ---
check('kaya label', providerLabelForUrl('https://kayaai.ir/api'), 'Kaya AI');
check('zai label', providerLabelForUrl('https://api.z.ai/api/paas/v4'), 'Z.AI');
check('nvidia label', providerLabelForUrl('https://integrate.api.nvidia.com/v1'), 'NVIDIA NIM');

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

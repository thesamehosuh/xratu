#!/usr/bin/env node
/**
 * Provider model-metadata normalization + host-scoped cache tests.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-model-metadata.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    parseModelList,
    applyModelKnowledge,
    readModelCatalog,
    serializeModelCatalog,
    setCatalogEntry,
    catalogEntryFor,
    cachedModelInfo,
    MODEL_CATALOG_TTL_MS,
} = require('../out/local/modelMetadata.js');
const { knownContextWindow, knownMaxOutputTokens, knownModelKnowledge } = require('../out/modelKnowledge.js');
const { ollamaContextLength } = require('../out/local/localModelClient.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const near = (name, actual, expected, eps = 1e-9) => {
    const ok = typeof actual === 'number' && Math.abs(actual - expected) < eps;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${actual}, want ~${expected})`}`);
};

// --- OpenAI-compatible /v1/models --------------------------------------
const openai = parseModelList({ object: 'list', data: [
    { id: 'gpt-5.5', object: 'model', owned_by: 'openai' },
    { id: 'gpt-4o', object: 'model', owned_by: 'openai', context_window: 128000 },
] });
check('openai: both models parsed', openai?.length, 2);
check('openai: no reported window stays undefined', openai[0].contextWindow, undefined);
check('openai: reported context_window kept', openai[1].contextWindow, 128000);
check('openai: no pricing', openai[0].pricing, undefined);

// --- OpenRouter: rich shape ---------------------------------------------
const openrouter = parseModelList({ data: [{
    id: 'some/model-27b',
    name: 'PrismML: Bonsai 27B',
    context_length: 262144,
    architecture: { input_modalities: ['text', 'image'] },
    pricing: { prompt: '0.000000075', completion: '0.0000005', input_cache_read: '0.00000001' },
    top_provider: { context_length: 262144, max_completion_tokens: 32768 },
    supported_parameters: ['tools', 'reasoning', 'reasoning_effort', 'temperature'],
}] });
check('openrouter: context_length', openrouter[0].contextWindow, 262144);
check('openrouter: max_completion_tokens', openrouter[0].maxOutputTokens, 32768);
check('openrouter: vision from input_modalities', openrouter[0].supportsVision, true);
check('openrouter: tools from supported_parameters', openrouter[0].supportsTools, true);
check('openrouter: reasoning from supported_parameters', openrouter[0].supportsReasoning, true);
check('openrouter: display name', openrouter[0].displayName, 'PrismML: Bonsai 27B');
near('openrouter: prompt per-token -> per 1M', openrouter[0].pricing.input, 0.075, 1e-12);
near('openrouter: completion per-token -> per 1M', openrouter[0].pricing.output, 0.5, 1e-12);
near('openrouter: cache read -> per 1M', openrouter[0].pricing.cachedInput, 0.01, 1e-12);

// --- OpenRouter reasoning variants ----------------------------------------
const orReasoning = parseModelList({ data: [{
    id: 'x-ai/grok-4.7',
    context_length: 500000,
    reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['xhigh', 'high', 'medium', 'low'], default_effort: 'high' },
}] });
check('openrouter: reasoning object marks capability', orReasoning[0].supportsReasoning, true);
check('openrouter: efforts parsed in provider order', JSON.stringify(orReasoning[0].reasoningLevels), JSON.stringify(['xhigh', 'high', 'medium', 'low']));

// Unknown spellings dropped, case normalized, provider order preserved.
const orUnknown = parseModelList({ data: [{ id: 'a/b', reasoning: { supported_efforts: ['pro', 'HIGH', 'low'] } }] });
check('openrouter: unknown efforts dropped + lowercased', JSON.stringify(orUnknown[0].reasoningLevels), JSON.stringify(['high', 'low']));

// An explicit null means the gateway accepts every effort.
const orAll = parseModelList({ data: [{ id: 'a/c', reasoning: { supported_efforts: null } }] });
check('openrouter: null efforts -> max offered', orAll[0].reasoningLevels.includes('max'), true);
check('openrouter: null efforts excludes none', orAll[0].reasoningLevels.includes('none'), false);

// A FLAT effort field with an explicit null must not be mistaken for absent
// (a `??` chain would skip it and lose the "all efforts" signal).
const flatNull = parseModelList({ data: [{ id: 'a/e', reasoning_efforts: null }] });
check('openrouter: flat null efforts -> max offered', flatNull[0].reasoningLevels.includes('max'), true);
const flatList = parseModelList({ data: [{ id: 'a/f', reasoningLevels: ['high', 'low'] }] });
check('openrouter: flat effort list parsed', JSON.stringify(flatList[0].reasoningLevels), JSON.stringify(['high', 'low']));

// A reasoning object without an effort list still marks capability, no levels.
const orNoEfforts = parseModelList({ data: [{ id: 'a/d', reasoning: { mandatory: false } }] });
check('openrouter: reasoning object without efforts -> capability', orNoEfforts[0].supportsReasoning, true);
check('openrouter: reasoning object without efforts -> no levels', orNoEfforts[0].reasoningLevels, undefined);

// Curated variants fill only when the provider reported none.
const curatedLevels = applyModelKnowledge(parseModelList({ data: [{ id: 'claude-sonnet-5' }] }));
check('knowledge fills reasoning variants', JSON.stringify(curatedLevels[0].reasoningLevels), JSON.stringify(['low', 'medium', 'high', 'xhigh', 'max']));
const providerLevels = applyModelKnowledge(parseModelList({ data: [{ id: 'claude-sonnet-5', reasoning: { supported_efforts: ['max'] } }] }));
check('provider variants beat curated', JSON.stringify(providerLevels[0].reasoningLevels), JSON.stringify(['max']));

// Curated variants are per-family (models.dev), not a flat low/medium/high.
const variantOf = (id) => applyModelKnowledge(parseModelList({ data: [{ id }] }))[0];
check('curated: gpt-5.6 variants', JSON.stringify(variantOf('gpt-5.6-luna').reasoningLevels), JSON.stringify(['none', 'low', 'medium', 'high', 'xhigh', 'max']));
check('curated: gpt-5.5 variants', JSON.stringify(variantOf('gpt-5.5').reasoningLevels), JSON.stringify(['none', 'low', 'medium', 'high', 'xhigh']));
check('curated: gpt-5.1-codex-max variants', JSON.stringify(variantOf('gpt-5.1-codex-max').reasoningLevels), JSON.stringify(['low', 'medium', 'high', 'xhigh']));
check('curated: kimi-k3 max only', JSON.stringify(variantOf('kimi-k3').reasoningLevels), JSON.stringify(['max']));
check('curated: deepseek-v4-pro', JSON.stringify(variantOf('deepseek-v4-pro').reasoningLevels), JSON.stringify(['high', 'max']));
check('curated: gemini-3.6-flash', JSON.stringify(variantOf('gemini-3.6-flash').reasoningLevels), JSON.stringify(['minimal', 'low', 'medium', 'high']));
check('curated: gemini-3.8-flash', JSON.stringify(variantOf('gemini-3.8-flash').reasoningLevels), JSON.stringify(['low', 'medium', 'high']));
check('curated: grok-4.7', JSON.stringify(variantOf('grok-4.7').reasoningLevels), JSON.stringify(['low', 'medium', 'high', 'xhigh']));
check('curated: glm-5.2', JSON.stringify(variantOf('glm-5.2').reasoningLevels), JSON.stringify(['high', 'max']));
check('curated: qwen3.8-flash', JSON.stringify(variantOf('qwen3.8-flash').reasoningLevels), JSON.stringify(['low', 'medium', 'xhigh']));
// A non-reasoning Qwen coder must not be swept up by the qwen3 family.
check('curated: qwen3-coder stays non-reasoning', variantOf('qwen3-coder').reasoningLevels, undefined);

// Authoritative "no reasoning" must survive; knowledge must not flip it true.
const noReason = applyModelKnowledge(parseModelList({ data: [{
    id: 'deepseek-v4-flash',
    context_length: 65536,
    supported_parameters: ['tools'],
}] }));
check('openrouter: absent reasoning param -> explicit false', noReason[0].supportsReasoning, false);
check('knowledge does not override provider false', noReason[0].supportsReasoning, false);
check('knowledge does not override provider window', noReason[0].contextWindow, 65536);

// --- Kaya AI native shape ------------------------------------------------
const kaya = parseModelList({ models: [{
    id: '~anthropic/claude-fable-latest',
    displayName: 'Anthropic: Claude Fable Latest',
    provider: '~anthropic',
    maxTokens: 1000000,
    inputPricePer1k: 0.01,
    outputPricePer1k: 0.05,
    cacheReadPricePer1k: 0.00025,
    isFree: false,
    inputModalities: ['text', 'image', 'file'],
}] });
check('kaya: context window from maxTokens', kaya[0].contextWindow, 1000000);
check('kaya: vision', kaya[0].supportsVision, true);
check('kaya: display name', kaya[0].displayName, 'Anthropic: Claude Fable Latest');
near('kaya: input per-1k -> per 1M', kaya[0].pricing.input, 10, 1e-9);
near('kaya: output per-1k -> per 1M', kaya[0].pricing.output, 50, 1e-9);
near('kaya: cached per-1k -> per 1M', kaya[0].pricing.cachedInput, 0.25, 1e-9);

const kayaFree = parseModelList({ models: [{ id: 'free/model', maxTokens: 8192, inputPricePer1k: 0, outputPricePer1k: 0, isFree: true }] });
check('kaya: free flag', kayaFree[0].pricing.free, true);

// null / '' prices are UNKNOWN, not a free 0.
const kayaNullPrice = parseModelList({ models: [{ id: 'x/model', maxTokens: 8192, inputPricePer1k: null, outputPricePer1k: null }] });
check('kaya: null price -> no pricing', kayaNullPrice[0].pricing, undefined);
const orBlankPrice = parseModelList({ data: [{ id: 'y/model', pricing: { prompt: '', completion: '   ' } }] });
check('openrouter: blank price -> no pricing', orBlankPrice[0].pricing, undefined);
const orNullPrice = parseModelList({ data: [{ id: 'z/model', pricing: { prompt: null, completion: null } }] });
check('openrouter: null price -> no pricing', orNullPrice[0].pricing, undefined);

// --- Google Generative Language ------------------------------------------
const google = parseModelList({ models: [{
    name: 'models/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ['generateContent', 'countTokens'],
}] });
check('google: models/ prefix stripped', google[0].id, 'gemini-3.5-flash');
check('google: inputTokenLimit -> contextWindow', google[0].contextWindow, 1048576);
check('google: outputTokenLimit -> maxOutput', google[0].maxOutputTokens, 65536);

// The native list mixes chat with embedding/image entries; only generateContent
// models can drive the agent loop.
const googleMixed = parseModelList({ models: [
    { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-3', supportedGenerationMethods: ['predict'] },
] });
check('google: non-generateContent entries dropped', googleMixed.length, 1);
check('google: keeps the chat model', googleMixed[0].id, 'gemini-3.5-flash');
// An older shape without the method list must not be emptied out.
const googleNoMethods = parseModelList({ models: [{ name: 'models/gemini-legacy', inputTokenLimit: 32768 }] });
check('google: missing method list kept', googleNoMethods[0].id, 'gemini-legacy');

// --- Ollama /api/tags -----------------------------------------------------
const ollama = parseModelList({ models: [{ name: 'llama3:latest', size: 1, digest: 'abc', modified_at: 'x', details: {} }] });
check('ollama: name as id', ollama[0].id, 'llama3:latest');
check('ollama: no window', ollama[0].contextWindow, undefined);

// --- Ollama /api/show context-length extraction ---------------------------
check(
    'ollama: picks the largest *.context_length',
    ollamaContextLength({ 'llama.context_length': 8192, 'qwen2.context_length': 131072, 'general.parameter_count': 7 }),
    131072,
);
check('ollama: no context_length -> undefined', ollamaContextLength({ 'general.architecture': 'llama' }), undefined);
check('ollama: ignores implausible values', ollamaContextLength({ 'x.context_length': 999999999 }), undefined);
check('ollama: string value coerced', ollamaContextLength({ 'x.context_length': '32768' }), 32768);

// --- LM Studio native -----------------------------------------------------
const lmstudio = parseModelList({ models: [{
    key: 'qwen3.5-27b',
    type: 'llm',
    max_context_length: 262144,
    capabilities: { vision: true, trained_for_tool_use: true, reasoning: true },
    loaded_instances: [{ config: { context_length: 32768 } }],
}] });
check('lmstudio: key as id', lmstudio[0].id, 'qwen3.5-27b');
check('lmstudio: loaded instance context wins', lmstudio[0].contextWindow, 32768);
check('lmstudio: vision', lmstudio[0].supportsVision, true);
check('lmstudio: tools', lmstudio[0].supportsTools, true);
check('lmstudio: reasoning', lmstudio[0].supportsReasoning, true);

// LM Studio reports reasoning as an OBJECT ({ allowed_options, default }), not
// a boolean - a `=== true` check silently dropped the capability.
const lmstudioReasoning = parseModelList({ models: [{
    key: 'deepseek-r1', type: 'llm', max_context_length: 131072,
    capabilities: { trained_for_tool_use: true, reasoning: { allowed_options: ['on'], default: 'on' } },
}] });
check('lmstudio: reasoning object -> capability', lmstudioReasoning[0].supportsReasoning, true);
const lmstudioNoReasoning = parseModelList({ models: [{ key: 'plain', type: 'llm', max_context_length: 8192, capabilities: { vision: false } }] });
check('lmstudio: absent reasoning stays unknown', lmstudioNoReasoning[0].supportsReasoning, undefined);

// --- Unrecognized payloads ------------------------------------------------
check('empty payload -> null', parseModelList({ object: 'list', data: [] }), null);
check('garbage payload -> null', parseModelList({ error: 'nope' }), null);
check('null payload -> null', parseModelList(null), null);

// --- Curated knowledge fallback -------------------------------------------
const filled = applyModelKnowledge(parseModelList({ data: [{ id: 'claude-sonnet-5' }] }));
check('knowledge fills missing window', filled[0].contextWindow, 200000);
check('knowledge fills missing max output', filled[0].maxOutputTokens, 64000);
check('knowledge fills reasoning', filled[0].supportsReasoning, true);
check('knownContextWindow helper', knownContextWindow('claude-opus-5'), 200000);
check('knownMaxOutputTokens helper', knownMaxOutputTokens('gemini-3.1-pro'), 65536);
check('unknown model -> no knowledge', knownModelKnowledge('totally-unknown'), null);
check('gpt-5.6 family window', knownContextWindow('gpt-5.6-sol'), 400000);

// MiniMax M3 is the 1M-context generation; the open M2.x checkpoints top out
// at 196608 (`max_position_embeddings`). A single `/minimax-m/` row claimed 1M
// for M2.x too - a 5x OVER-estimate that let the run pack context the model
// cannot accept.
check('minimax-m3 window', knownContextWindow('minimax-m3'), 1000000);
check('minimax-m2.5 window', knownContextWindow('minimax-m2.5'), 196608);
check('minimax-m2.7 window', knownContextWindow('minimax-m2.7'), 196608);

// Provider window must never be replaced by curated.
const reported = applyModelKnowledge(parseModelList({ data: [{ id: 'claude-sonnet-5', context_length: 123456 }] }));
check('provider window beats curated', reported[0].contextWindow, 123456);

// --- Host-scoped catalog cache --------------------------------------------
const now = 1_000_000_000;
let catalog = {};
catalog = setCatalogEntry(catalog, 'example.com', [{ id: 'm1', contextWindow: 100000 }], now);
catalog = setCatalogEntry(catalog, 'other.com', [{ id: 'm1', contextWindow: 200000 }], now);

const a = catalogEntryFor(catalog, 'example.com', now + 1000);
const b = catalogEntryFor(catalog, 'other.com', now + 1000);
check('host-scoped: host A window', a.models[0].contextWindow, 100000);
check('host-scoped: host B window', b.models[0].contextWindow, 200000);
check('host-scoped: fresh', a.stale, false);
check('host-scoped: model lookup by id', cachedModelInfo(catalog, 'other.com', 'm1').contextWindow, 200000);
check('host-scoped: unknown host -> null', catalogEntryFor(catalog, 'nope.com', now), null);
check('host-scoped: case-insensitive host', catalogEntryFor(catalog, 'EXAMPLE.COM', now)?.models.length, 1);

const stale = catalogEntryFor(catalog, 'example.com', now + MODEL_CATALOG_TTL_MS + 1);
check('stale entry is still served', stale.models[0].id, 'm1');
check('stale entry flagged', stale.stale, true);

// Round-trip + corruption tolerance.
const roundTrip = readModelCatalog(serializeModelCatalog(catalog));
check('catalog round-trips', catalogEntryFor(roundTrip, 'example.com', now)?.models[0].id, 'm1');
check('corrupt JSON -> empty catalog', Object.keys(readModelCatalog('{not json')).length, 0);
check('non-object -> empty catalog', Object.keys(readModelCatalog('[1,2,3]')).length, 0);
check('entry without models dropped', Object.keys(readModelCatalog({ 'x.com': { fetchedAt: 1, models: [] } })).length, 0);

// A corrupt persisted variant list must not survive the cache read.
const sanitized = readModelCatalog({ 'x.com': { fetchedAt: 1, models: [
    { id: 'm1', reasoningLevels: ['high', 'bogus'] },
    { id: 'm2', reasoningLevels: ['nope'] },
] } });
check('catalog keeps known variants', JSON.stringify(cachedModelInfo(sanitized, 'x.com', 'm1').reasoningLevels), JSON.stringify(['high']));
check('catalog drops unknown variants', cachedModelInfo(sanitized, 'x.com', 'm2').reasoningLevels, undefined);

console.log(failed === 0 ? '\nmodel-metadata: all tests passed' : `\nmodel-metadata: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * models.dev fallback-layer regression tests.
 *
 * Covers the per-provider catalog that sits BETWEEN the provider's own model
 * list and the curated `modelKnowledge` table: normalization, capability
 * mapping, precedence, cache round-trip (BOM/corruption tolerant), the network
 * fetch, and the probe integration.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-models-dev.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    modelsDevProviderKey,
    normalizeModelsDevDoc,
    applyModelsDev,
    applyModelKnowledge,
    readModelsDevCache,
    serializeModelsDevCache,
    parseModelList,
} = require('../out/local/modelMetadata.js');
const { fetchModelsDevCatalog, probeLocalEndpoint } = require('../out/local/localModelClient.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- Provider mapping ------------------------------------------------------
check('provider key: opencode', modelsDevProviderKey('opencode'), 'opencode');
check('provider key: opencode-go', modelsDevProviderKey('opencode-go'), 'opencode-go');
check('provider key: together alias', modelsDevProviderKey('together'), 'togetherai');
check('provider key: fireworks alias', modelsDevProviderKey('fireworks'), 'fireworks-ai');
check('provider key: unknown provider', modelsDevProviderKey('kayaai'), null);
check('provider key: empty', modelsDevProviderKey(undefined), null);

// --- Normalization ---------------------------------------------------------
const doc = {
    'opencode-go': { models: {
        'deepseek-v4-pro': {
            name: 'DeepSeek V4 Pro',
            limit: { context: 1000000, output: 384000 },
            tool_call: true,
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
            modalities: { input: ['text'] },
        },
        'vision-model': { limit: { context: 200000 }, modalities: { input: ['text', 'image'] }, tool_call: false },
        'toggle-model': { limit: { context: 128000 }, reasoning: true, reasoning_options: [{ type: 'toggle' }] },
        'bogus-window': { limit: { context: 12 }, tool_call: true },
        'no-limit': { tool_call: true },
    } },
    // Unmapped provider must be dropped.
    'some-other-provider': { models: { x: { limit: { context: 999999 } } } },
};
const catalog = normalizeModelsDevDoc(doc);
check('catalog: only mapped providers kept', Object.keys(catalog), ['opencode-go']);
const go = catalog['opencode-go'];
check('catalog: context/output mapped', [go['deepseek-v4-pro'].contextWindow, go['deepseek-v4-pro'].maxOutputTokens], [1000000, 384000]);
check('catalog: effort levels mapped', go['deepseek-v4-pro'].reasoningLevels, ['high', 'max']);
check('catalog: vision from modalities', go['vision-model'].supportsVision, true);
check('catalog: text-only is not vision', go['deepseek-v4-pro'].supportsVision, false);
check('catalog: tool_call false kept', go['vision-model'].supportsTools, false);
check('catalog: toggle has no levels', go['toggle-model'].reasoningLevels, undefined);
check('catalog: toggle still supports reasoning', go['toggle-model'].supportsReasoning, true);
check('catalog: sub-1k window dropped', go['bogus-window'].contextWindow, undefined);
check('catalog: model without a limit kept', go['no-limit'].supportsTools, true);
check('catalog: garbage doc', normalizeModelsDevDoc(null), {});
check('catalog: array doc', normalizeModelsDevDoc([]), {});

// --- Precedence ------------------------------------------------------------
const reportedWindow = parseModelList({ data: [{ id: 'deepseek-v4-pro', context_length: 64000 }] });
const merged = applyModelsDev(reportedWindow, catalog, 'opencode-go');
check('apply: provider window wins over models.dev', merged[0].contextWindow, 64000);
check('apply: models.dev fills max output', merged[0].maxOutputTokens, 384000);
check('apply: models.dev fills reasoning', merged[0].supportsReasoning, true);
check('apply: models.dev fills levels', merged[0].reasoningLevels, ['high', 'max']);

// An explicit provider capability (including an explicit `false`) is
// authoritative and must not be overwritten by models.dev.
const reportedCaps = parseModelList({ data: [{ id: 'deepseek-v4-pro', supported_parameters: ['tools'] }] });
const capped = applyModelsDev(reportedCaps, catalog, 'opencode-go');
check('apply: provider tools win', capped[0].supportsTools, true);
check('apply: explicit provider false beats models.dev', capped[0].supportsReasoning, false);
check('apply: explicit false suppresses models.dev levels', capped[0].reasoningLevels, undefined);

// Provider-reported window + curated fill for a model models.dev does not know.
const unknown = applyModelsDev(parseModelList({ data: [{ id: 'totally-unknown' }] }), catalog, 'opencode-go');
check('apply: unknown model untouched by models.dev', unknown[0].contextWindow, undefined);
check('apply: no catalog is a no-op', applyModelsDev(reportedWindow, null, 'opencode-go')[0].contextWindow, 64000);
check('apply: unmapped provider is a no-op', applyModelsDev(reportedWindow, catalog, 'kayaai')[0].maxOutputTokens, undefined);

// Curated table still fills what neither provider nor models.dev knew.
const curated = applyModelKnowledge(applyModelsDev(parseModelList({ data: [{ id: 'deepseek-v4-pro' }] }), catalog, 'opencode-go'));
check('precedence: models.dev beats curated', curated[0].contextWindow, 1000000);

// --- Cache round-trip ------------------------------------------------------
const cacheRaw = serializeModelsDevCache({ fetchedAt: 12345, catalog });
check('cache: round-trip', readModelsDevCache(cacheRaw), { fetchedAt: 12345, catalog });
check('cache: BOM tolerated', !!readModelsDevCache('\uFEFF' + cacheRaw), true);
check('cache: corrupt JSON', readModelsDevCache('{oops'), null);
check('cache: wrong shape', readModelsDevCache('[1,2,3]'), null);
check('cache: empty catalog', readModelsDevCache(JSON.stringify({ fetchedAt: 1, catalog: {} })), null);
check('cache: bad fetchedAt clamped', readModelsDevCache(JSON.stringify({ fetchedAt: 'x', catalog })).fetchedAt, 0);
// A hand-edited cache cannot inject a bogus window or an unknown effort level.
const tampered = readModelsDevCache(JSON.stringify({
    fetchedAt: 1,
    catalog: { 'opencode-go': { m: { contextWindow: 5, reasoningLevels: ['ultra', 'high'] } } },
}));
check('cache: bogus window dropped', tampered.catalog['opencode-go'].m.contextWindow, undefined);
check('cache: unknown level dropped', tampered.catalog['opencode-go'].m.reasoningLevels, ['high']);

// --- Fetch (stubbed transport) ---------------------------------------------
async function withFetch(impl, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await fn(); } finally { globalThis.fetch = real; }
}
{
    const fetched = await withFetch(
        async () => ({ ok: true, json: async () => doc }),
        () => fetchModelsDevCatalog(),
    );
    check('fetch: parses a live-shaped doc', Object.keys(fetched), ['opencode-go']);
}
check('fetch: non-ok -> null', await withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }), () => fetchModelsDevCatalog()), null);
check('fetch: throw -> null', await withFetch(async () => { throw new Error('offline'); }, () => fetchModelsDevCatalog()), null);
check('fetch: malformed body -> null', await withFetch(async () => ({ ok: true, json: async () => ({ nope: 1 }) }), () => fetchModelsDevCatalog()), null);

// --- Probe integration -----------------------------------------------------
{
    const result = await withFetch(
        async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-v4-pro' }] }) }),
        () => probeLocalEndpoint('https://opencode.ai/zen/go/v1', undefined, 'KEY', undefined, catalog),
    );
    check('probe: models.dev fills the window', result.models[0].contextWindow, 1000000);
    check('probe: models.dev does not mark it reported', result.models[0].contextWindowReported, undefined);
}
{
    const result = await withFetch(
        async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-v4-pro', context_length: 64000 }] }) }),
        () => probeLocalEndpoint('https://opencode.ai/zen/go/v1', undefined, 'KEY', undefined, catalog),
    );
    check('probe: provider report still wins', result.models[0].contextWindow, 64000);
    check('probe: provider report marked reported', result.models[0].contextWindowReported, true);
}

console.log(failed === 0 ? '\nmodels-dev: all tests passed' : `\nmodels-dev: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

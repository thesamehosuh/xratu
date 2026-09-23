#!/usr/bin/env node
/**
 * Runtime model-discovery regression tests.
 *
 * Drives the REAL `probeLocalEndpoint` against a stubbed `fetch`, asserting the
 * URL each runtime is probed at and the metadata that survives normalization.
 *
 * Regressions covered:
 *  - LM Studio's native `/api/v1/models` hangs off the ORIGIN. The shipped
 *    preset is `http://localhost:1234/v1`, so building the native path from the
 *    raw base produced `/v1/api/v1/models` (404) and EVERY LM Studio model
 *    silently lost its real context window and vision/tool capabilities.
 *  - A remote URL with `localhost:1234` in its path (or a port that merely
 *    starts with the same digits) must NOT be treated as a loopback runtime.
 *  - Google's native list defaults to 50 models per page; the probe must ask
 *    for the 1000-model maximum instead of silently truncating the catalog.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-model-discovery.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { probeLocalEndpoint } = require('../out/local/localModelClient.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

/** Install a fetch stub for the duration of one probe. Routes by URL substring. */
async function withFetch(routes, fn) {
    const real = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        for (const [fragment, payload] of routes) {
            if (u.includes(fragment)) {
                if (payload === null) return { ok: false, status: 404, json: async () => ({}) };
                return { ok: true, status: 200, json: async () => payload };
            }
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    try {
        const result = await fn();
        return { result, calls };
    } finally {
        globalThis.fetch = real;
    }
}

// --- LM Studio native endpoint is rooted at the origin ---------------------
{
    const native = { models: [
        { type: 'llm', key: 'qwen/qwen3-vl-8b', max_context_length: 262144, capabilities: { vision: true, trained_for_tool_use: true } },
        { type: 'embedding', key: 'nomic-embed', loaded_instances: [{ config: { context_length: 2048 } }] },
    ] };
    const { result, calls } = await withFetch([
        ['/api/v1/models', native],
        ['/v1/models', { data: [{ id: 'qwen/qwen3-vl-8b' }] }],
    ], () => probeLocalEndpoint('http://localhost:1234/v1'));
    check('lmstudio: native probed at the origin', calls[0], 'http://localhost:1234/api/v1/models');
    check('lmstudio: chat model kept', result.models.length, 1);
    check('lmstudio: embedding excluded', result.models.some((m) => m.id === 'nomic-embed'), false);
    check('lmstudio: real context window survives', result.models[0].contextWindow, 262144);
    check('lmstudio: window flagged reported', result.models[0].contextWindowReported, true);
    check('lmstudio: vision capability survives', result.models[0].supportsVision, true);
    check('lmstudio: tool capability survives', result.models[0].supportsTools, true);
}

// A bare-origin LM Studio must keep working too.
{
    const { calls } = await withFetch([
        ['/api/v1/models', { models: [{ type: 'llm', key: 'm', max_context_length: 8192 }] }],
    ], () => probeLocalEndpoint('http://localhost:1234'));
    check('lmstudio: bare origin still probed natively', calls[0], 'http://localhost:1234/api/v1/models');
}

// --- A loopback-looking REMOTE url must not hijack the native probe ---------
{
    const { calls } = await withFetch([
        ['/models', { data: [{ id: 'remote-model' }] }],
    ], () => probeLocalEndpoint('https://proxy.example/localhost:1234/v1'));
    check('remote url with localhost:1234 in path uses OpenAI list', calls[0], 'https://proxy.example/localhost:1234/v1/models');
}
{
    const { calls } = await withFetch([
        ['/models', { data: [{ id: 'remote-model' }] }],
    ], () => probeLocalEndpoint('http://localhost:12340/v1'));
    check('port 12340 is not treated as LM Studio', calls[0], 'http://localhost:12340/v1/models');
}

// --- Ollama native endpoint is rooted at the origin ------------------------
{
    const { result, calls } = await withFetch([
        ['/api/tags', { models: [{ name: 'llama3:latest', digest: 'x', size: 1, modified_at: 'now', details: {} }] }],
        ['/api/show', { model_info: { 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] }],
    ], () => probeLocalEndpoint('http://localhost:11434/v1'));
    check('ollama: native tags probed at the origin', calls[0], 'http://localhost:11434/api/tags');
    check('ollama: context window enriched', result.models[0].contextWindow, 131072);
    check('ollama: capabilities enriched', result.models[0].supportsTools, true);
}

// --- Google asks for the maximum page size ---------------------------------
{
    const { result, calls } = await withFetch([
        ['/v1beta/models', { models: [{ name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }] }],
    ], () => probeLocalEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/', undefined, 'KEY'));
    check('google: probe asks for the max page', calls[0].includes('pageSize=1000'), true);
    check('google: key still forwarded', calls[0].includes('key=KEY'), true);
    check('google: model parsed', result.models[0].id, 'gemini-3.5-flash');
}

console.log(failed === 0 ? '\nmodel-discovery: all tests passed' : `\nmodel-discovery: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

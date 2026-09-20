#!/usr/bin/env node
/**
 * Base-URL normalization regression tests.
 *
 * Regression: the old `normalizeBaseUrl` appended `/v1` unless the URL ended
 * in `/v1` or `/api`, corrupting every preset that roots the API at a
 * different version path - Google (`/v1beta/openai`), Z.AI (`/paas/v4`) and
 * Perplexity (bare origin, no version segment at all).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-base-url.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeBaseUrl } = require('../out/local/baseUrl.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const checkThrows = (name, fn) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) failed++;
    console.log(`${threw ? 'ok  ' : 'FAIL'} ${name} (expected throw)`);
};

// --- Versioned / rooted paths are preserved verbatim ---
check('openai /v1', normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
check('openrouter /api/v1', normalizeBaseUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
check('kaya /api', normalizeBaseUrl('https://kayaai.ir/api'), 'https://kayaai.ir/api');
check('groq /openai/v1', normalizeBaseUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1');
check('cohere /compatibility/v1', normalizeBaseUrl('https://api.cohere.com/compatibility/v1'), 'https://api.cohere.com/compatibility/v1');
check('zai /paas/v4', normalizeBaseUrl('https://api.z.ai/api/paas/v4'), 'https://api.z.ai/api/paas/v4');

// --- Regression: Google Gemini base must not gain a trailing /v1 ---
check(
    'google /v1beta/openai (trailing slash stripped)',
    normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/'),
    'https://generativelanguage.googleapis.com/v1beta/openai',
);

// --- Regression: Perplexity serves the chat endpoint from the bare origin ---
check('perplexity bare origin', normalizeBaseUrl('https://api.perplexity.ai'), 'https://api.perplexity.ai');
check('perplexity bare origin + slash', normalizeBaseUrl('https://api.perplexity.ai/'), 'https://api.perplexity.ai');

// --- Bare origins still get /v1 so custom roots keep working ---
check('deepseek bare origin', normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1');
check('localhost bare origin', normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080/v1');
check('custom root + slash', normalizeBaseUrl('https://my-litellm.example.com/'), 'https://my-litellm.example.com/v1');

// --- Trailing slashes are stripped from rooted paths ---
check('rooted path + slash', normalizeBaseUrl('https://host/openai/v1/'), 'https://host/openai/v1');

// --- Invalid input ---
checkThrows('rejects non-http scheme', () => normalizeBaseUrl('ftp://example.com'));
checkThrows('rejects malformed URL', () => normalizeBaseUrl('https://'));

console.log(failed === 0 ? '\nbase-url: all tests passed' : `\nbase-url: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Deterministic Persian error explanations for src/local/errorExplain.ts.
 *
 * Every class the layer knows maps to its key; unknown text passes through
 * (null) so the host keeps the raw message; the raw text always rides
 * `params.detail`; status codes win over wording for the unambiguous classes.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-error-explain.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { explainError } = require('../out/local/errorExplain.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

const cases = [
    ['connect ECONNREFUSED 127.0.0.1:11434', undefined, 'errConnRefused'],
    ['AggregateError [ECONNREFUSED]', undefined, 'errConnRefused'],
    ['socket hang up', undefined, 'errConnReset'],
    ['read ECONNRESET', undefined, 'errConnReset'],
    ['Model request timed out after 300s.', undefined, 'errTimeout'],
    ['Model stream stalled (no data for 120s).', undefined, 'errTimeout'],
    ['getaddrinfo ENOTFOUND api.example.com', undefined, 'errDns'],
    ['self-signed certificate in certificate chain', undefined, 'errTls'],
    ['fetch failed', undefined, 'errNetwork'],
    ['{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', undefined, 'errContextLength'],
    ['context_length_exceeded', undefined, 'errContextLength'],
    ['The model `gpt-9` does not exist', undefined, 'errModelNotFound'],
    ['No such model: llama3.2', undefined, 'errModelNotFound'],
    ['Incorrect API key provided: sk-***', undefined, 'errAuth'],
    ['Unexpected token < in JSON at position 0', undefined, 'errStream'],
    ['internal server error', undefined, 'errServer'],
    ['weird uncategorized failure text', undefined, null],
    ['', undefined, null],
    // Status wins over wording for the unambiguous classes.
    ['anything at all', 401, 'errAuth'],
    ['context length exceeded', 429, 'errRateLimited'],
    ['something', 503, 'errServer'],
    ['something', 500, 'errServer'],
    // Status alone is not enough for the ambiguous classes - wording rules.
    ['nothing recognizable', 404, null],
    ['context_length_exceeded', 400, 'errContextLength'],
];

for (const [text, status, expected] of cases) {
    const got = explainError(text, status)?.valueKey ?? null;
    check(`"${String(text).slice(0, 40)}" (status ${status ?? '-'}) -> ${expected}`, got, expected);
}

{
    const e = explainError('fetch failed');
    check('raw text always rides params.detail', e?.params.detail, 'fetch failed');
    check('every explanation carries a detail param', e ? 'detail' in e.params : false, true);
}

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

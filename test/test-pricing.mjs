#!/usr/bin/env node
/**
 * Cost estimation tests.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-pricing.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { priceForModel, costForUsage } = require('../out/pricing.js');

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

// --- Known models resolve ---
check('claude-sonnet-5 input', priceForModel('claude-sonnet-5')?.input, 2);
check('claude-opus-5 output', priceForModel('claude-opus-5')?.output, 25);
check('gpt-5.6-luna input', priceForModel('gpt-5.6-luna')?.input, 0.2);
check('deepseek-v4-flash output', priceForModel('deepseek-v4-flash')?.output, 0.28);
check('glm-5.3 output', priceForModel('glm-5.3')?.output, 4.4);
check('kimi-k3 input', priceForModel('kimi-k3')?.input, 3);
check('gemini-3.8-flash input', priceForModel('gemini-3.8-flash')?.input, 1.5);
check('unknown model -> null', priceForModel('some-local-model'), null);
check('empty model -> null', priceForModel('   '), null);

// --- Overrides win (case-insensitive, exact id) ---
check('override wins', priceForModel('my-model', { 'my-model': { input: 0.5, output: 1.5 } })?.input, 0.5);
check('override case-insensitive', priceForModel('My-Model', { 'my-model': { input: 0.25, output: 1 } })?.output, 1);
check('override beats table', priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 99, output: 99 } })?.input, 99);
check('incomplete override falls through', priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 1 } })?.input, 2);

// --- Cost math ---
const sonnet = priceForModel('claude-sonnet-5');
const est = costForUsage(sonnet, { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 400_000 });
// uncached 600k * 2 + cached 400k * 0.2 + 1M * 10 = 1.2 + 0.08 + 10 = 11.28
near('cost with cached split', est.amount, 11.28, 1e-6);
check('cost currency', est.currency, 'USD');

const noCache = costForUsage(sonnet, { promptTokens: 1_000_000, completionTokens: 0 });
near('cost without cached', noCache.amount, 2, 1e-9);

const clamped = costForUsage(sonnet, { promptTokens: 1000, completionTokens: 0, cachedTokens: 5000 });
// cached clamped to prompt: 1000 * 0.2 / 1M
near('cached clamped to prompt', clamped.amount, (1000 * 0.2) / 1_000_000, 1e-12);

check('zero usage -> null', costForUsage(sonnet, { promptTokens: 0, completionTokens: 0 }), null);
check('null tokens -> null', costForUsage(sonnet, { promptTokens: null, completionTokens: null }), null);
check('IRT currency passthrough', costForUsage(sonnet, { promptTokens: 1_000_000, completionTokens: 0 }, 'IRT').currency, 'IRT');

console.log(failed === 0 ? '\npricing: all tests passed' : `\npricing: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

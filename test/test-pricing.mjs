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
check('negative override rejected', priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: -1, output: 2 } })?.input, 2);
check('negative cached override rejected', priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 1, output: 2, cachedInput: -1 } })?.input, 2);

// gpt-5-nano must not be shadowed by the generic /gpt-5\b/ entry.
check('gpt-5-nano not shadowed', priceForModel('gpt-5-nano')?.input, 0.05);
check('gpt-5-codex still matches generic', priceForModel('gpt-5-codex')?.input, 1.07);

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

// --- Currency + provider-aware (Toman) resolution ---
const irtOverride = priceForModel('my-model', { 'my-model': { input: 1000, output: 2000, currency: 'IRT' } });
check('override currency IRT', irtOverride?.currency, 'IRT');
check('override IRT input untouched', irtOverride?.input, 1000);

const gw = priceForModel('claude-sonnet-5', null, {
    host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100 },
});
check('gateway rate -> IRT', gw?.currency, 'IRT');
check('gateway rate scales input', gw?.input, 200);

const gwMarkup = priceForModel('claude-sonnet-5', null, {
    host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100, markupPercent: 10 },
});
near('gateway markup applied', gwMarkup?.input, 220, 1e-9);

const gwNegative = priceForModel('claude-sonnet-5', null, {
    host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100, markupPercent: -50 },
});
check('negative markup ignored', gwNegative?.input, 200);

check(
    'Iranian provider with no Toman data -> null',
    priceForModel('claude-sonnet-5', null, { host: 'api.avalai.ir', iranian: true }),
    null,
);

const fb = priceForModel('claude-sonnet-5', null, { host: 'x.ir', iranian: true, fallbackRate: 50 });
check('fallback rate -> IRT', fb?.currency, 'IRT');
check('fallback rate scales input', fb?.input, 100);

const custom = priceForModel('claude-sonnet-5', null, { host: 'gw.example', gatewayRate: { tomanPerUsd: 10 } });
check('custom gateway -> IRT', custom?.currency, 'IRT');
check('custom gateway scales input', custom?.input, 20);

check('non-Iranian host stays USD', priceForModel('claude-sonnet-5', null, { host: 'api.openai.com' })?.currency, undefined);
check('non-Iranian host keeps USD rate', priceForModel('claude-sonnet-5', null, { host: 'api.openai.com' })?.input, 2);

const irtCost = costForUsage(
    { input: 1000, output: 2000, currency: 'IRT' },
    { promptTokens: 1_000_000, completionTokens: 0 },
);
check('cost uses the price currency', irtCost.currency, 'IRT');
near('cost amount in IRT', irtCost.amount, 1000, 1e-9);

console.log(failed === 0 ? '\npricing: all tests passed' : `\npricing: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

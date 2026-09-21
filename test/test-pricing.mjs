#!/usr/bin/env node
/**
 * Cost estimation tests.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-pricing.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { priceForModel, resolvePrice, costForUsage } = require('../out/pricing.js');

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

// Cache WRITES (a subset of promptTokens) are billed at 1.25x input by default.
const write = costForUsage(sonnet, { promptTokens: 1_000_000, completionTokens: 0, cacheWriteTokens: 1_000_000 });
near('cache write priced at 1.25x input', write.amount, 2.5, 1e-9);

const mixed = costForUsage(sonnet, {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 300_000,
    cacheWriteTokens: 200_000,
});
// uncached 500k * 2 + cached 300k * 0.2 + write 200k * 2.5 = 1.0 + 0.06 + 0.5
near('read/write/uncached split', mixed.amount, 1.56, 1e-9);

const explicitWrite = costForUsage({ input: 2, output: 10, cachedInputWrite: 3 }, {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cacheWriteTokens: 1_000_000,
});
near('explicit cache-write rate wins', explicitWrite.amount, 3, 1e-9);

const overClamped = costForUsage(sonnet, {
    promptTokens: 1000,
    completionTokens: 0,
    cachedTokens: 400,
    cacheWriteTokens: 5000,
});
// write clamped to prompt - cached = 600; 400 * 0.2 + 600 * 2.5, all per 1M
near('cache write clamped to the uncached prompt', overClamped.amount, (400 * 0.2 + 600 * 2.5) / 1_000_000, 1e-12);

check('zero usage -> null', costForUsage(sonnet, { promptTokens: 0, completionTokens: 0 }), null);
check('null tokens -> null', costForUsage(sonnet, { promptTokens: null, completionTokens: null }), null);
check('IRT currency passthrough', costForUsage(sonnet, { promptTokens: 1_000_000, completionTokens: 0 }, 'IRT').currency, 'IRT');

// --- Currency + provider-aware (Toman) resolution ---
const irtOverride = priceForModel('my-model', { 'my-model': { input: 1000, output: 2000, currency: 'IRT' } });
check('override currency IRT', irtOverride?.currency, 'IRT');
check('override IRT input untouched', irtOverride?.input, 1000);

// A USD override must stay USD even on a Toman-billed provider: it carries an
// explicit currency so the host does not fall through to the IRT ledger.
const usdOverride = priceForModel(
    'claude-sonnet-5',
    { 'claude-sonnet-5': { input: 3, output: 9 } },
    { host: 'api.avalai.ir', iranian: true, fallbackRate: 100 },
);
check('USD override carries USD currency', usdOverride?.currency, 'USD');
check('USD override beats gateway rate', usdOverride?.input, 3);

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

// --- Rate sources (the Usage page labels every effective rate) ---
check('source: curated USD table', resolvePrice('claude-sonnet-5')?.source, 'usd-table');
check('source: user override', resolvePrice('claude-sonnet-5', { 'claude-sonnet-5': { input: 1, output: 2 } })?.source, 'override');
check(
    'source: gateway conversion',
    resolvePrice('claude-sonnet-5', null, { host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100 } })?.source,
    'gateway',
);
check(
    'source: fallback rate is still a gateway conversion',
    resolvePrice('claude-sonnet-5', null, { host: 'x.ir', iranian: true, fallbackRate: 50 })?.source,
    'gateway',
);
check(
    'source: unknown model resolves to nothing',
    resolvePrice('some-local-model'),
    null,
);
// priceForModel stays the thin wrapper it always was.
check('priceForModel matches resolvePrice', priceForModel('claude-sonnet-5')?.input, resolvePrice('claude-sonnet-5')?.price.input);

// --- Cached-rate fallback: an omitted rate is NOT a free rate ---
const noCached = priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 2, output: 10 } });
check('omitted cachedInput falls back to input', costForUsage(noCached, { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 }).amount, 2);
const zeroCached = priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 2, output: 10, cachedInput: 0 } });
// A free cached rate makes an all-cached round cost nothing, which the cost
// helper reports as "no cost" rather than 0 - the point is that it is NOT the
// same as the fallback above.
check('explicit zero cached rate costs nothing', costForUsage(zeroCached, { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 }), null);

// --- Live provider-reported prices (override > provider > curated) ---
check(
    'provider price beats curated table',
    resolvePrice('claude-sonnet-5', null, { providerPrice: { input: 9, output: 44 } })?.source,
    'provider',
);
check(
    'provider price value used',
    priceForModel('claude-sonnet-5', null, { providerPrice: { input: 9, output: 44 } })?.input,
    9,
);
check(
    'user override still beats provider price',
    priceForModel('claude-sonnet-5', { 'claude-sonnet-5': { input: 1, output: 2 } }, { providerPrice: { input: 9, output: 44 } })?.input,
    1,
);
check(
    'provider price fills a curated gap',
    priceForModel('mystery-gateway-model', null, { providerPrice: { input: 3, output: 6 } })?.output,
    6,
);
check(
    'provider price carries cached rate',
    priceForModel('mystery-gateway-model', null, { providerPrice: { input: 3, output: 6, cachedInput: 0.3 } })?.cachedInput,
    0.3,
);
check(
    'provider price is always USD',
    priceForModel('claude-sonnet-5', null, { host: 'api.openai.com', providerPrice: { input: 9, output: 44 } })?.currency,
    'USD',
);
check(
    'invalid provider price falls through to curated',
    resolvePrice('claude-sonnet-5', null, { providerPrice: { input: -1, output: 2 } })?.source,
    'usd-table',
);
check(
    'Iranian host: provider USD is converted via gateway rate',
    resolvePrice('claude-sonnet-5', null, {
        host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100 },
        providerPrice: { input: 9, output: 44 },
    })?.source,
    'gateway',
);
near(
    'Iranian host: provider base is the converted rate',
    priceForModel('claude-sonnet-5', null, {
        host: 'api.avalai.ir', iranian: true, gatewayRate: { tomanPerUsd: 100 },
        providerPrice: { input: 9, output: 44 },
    })?.input,
    900,
    1e-9,
);

console.log(failed === 0 ? '\npricing: all tests passed' : `\npricing: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

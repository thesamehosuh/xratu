#!/usr/bin/env node
/**
 * Proxy URL resolution tests.
 *
 * The proxy is how users behind filtering reach any provider, so the
 * precedence rules are load-bearing: explicit setting > VS Code http.proxy >
 * HTTPS_PROXY > HTTP_PROXY > ALL_PROXY.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-proxy.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    pickProxyUrl, isSocksProxy, isHttpProxy, redactProxyUrl,
    pickNoProxy, parseNoProxy, hostFromUrl, hostMatchesNoProxy,
    parseWindowsProxyServer, parseScutilProxy, parseGsettingsProxy,
    resolveProxyUrl, normalizeProxyRoute,
} = require('../out/proxy.js');
const { planProxyTest, summarizeProxyTest, PROXY_TEST_ENDPOINTS } = require('../out/proxyTest.js');
const { proxyFetch } = require('../out/proxyFetch.js');
const { ProxyAgent } = require('undici');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- Precedence ---
check('explicit wins', pickProxyUrl({ explicit: 'http://explicit:1', vscodeHttpProxy: 'http://vsc:2', env: { HTTPS_PROXY: 'http://env:3' } }), 'http://explicit:1');
check('http.proxy beats env', pickProxyUrl({ explicit: '', vscodeHttpProxy: 'http://vsc:2', env: { HTTPS_PROXY: 'http://env:3' } }), 'http://vsc:2');
check('HTTPS_PROXY beats HTTP_PROXY', pickProxyUrl({ env: { HTTPS_PROXY: 'http://https:1', HTTP_PROXY: 'http://http:2' } }), 'http://https:1');
check('HTTP_PROXY beats ALL_PROXY', pickProxyUrl({ env: { HTTP_PROXY: 'http://http:2', ALL_PROXY: 'socks5://all:3' } }), 'http://http:2');
check('lowercase env accepted', pickProxyUrl({ env: { https_proxy: 'http://lower:4' } }), 'http://lower:4');

// --- Trimming / empty handling ---
check('whitespace trimmed', pickProxyUrl({ explicit: '  http://trimmed:1  ' }), 'http://trimmed:1');
check('blank explicit falls through', pickProxyUrl({ explicit: '   ', vscodeHttpProxy: 'http://vsc:2' }), 'http://vsc:2');
check('blank env ignored', pickProxyUrl({ env: { HTTPS_PROXY: '   ', HTTP_PROXY: 'http://http:2' } }), 'http://http:2');
check('nothing configured -> null', pickProxyUrl({ env: {} }), null);
check('missing sources -> null', pickProxyUrl({}), null);

// --- Scheme detection ---
check('socks5 detected', isSocksProxy('socks5://127.0.0.1:1080'), true);
check('socks5h detected', isSocksProxy('socks5h://127.0.0.1:1080'), true);
check('socks4 detected', isSocksProxy('socks4://127.0.0.1:1080'), true);
check('SOCKS case-insensitive', isSocksProxy('SOCKS://127.0.0.1:1080'), true);
check('http not socks', isSocksProxy('http://127.0.0.1:7890'), false);
check('http detected', isHttpProxy('http://127.0.0.1:7890'), true);
check('https detected', isHttpProxy('https://proxy.example:443'), true);
check('socks not http', isHttpProxy('socks5://127.0.0.1:1080'), false);

// --- Credential redaction (proxy URLs must never reach logs verbatim) ---
check('redacts user:pass', redactProxyUrl('http://user:s3cret@proxy.example:8080'), 'http://proxy.example:8080/');
check('redacts user only', redactProxyUrl('http://user@proxy.example:8080'), 'http://proxy.example:8080/');
check('no credentials unchanged', redactProxyUrl('http://proxy.example:8080'), 'http://proxy.example:8080/');
check('unparseable -> placeholder', redactProxyUrl('not a url'), 'invalid URL');
check('secret absent after redaction', redactProxyUrl('http://user:s3cret@proxy.example:8080').includes('s3cret'), false);

// --- no_proxy resolution + matching ---
check('noProxy explicit wins', pickNoProxy({ explicit: 'a.example', vscodeHttpNoProxy: 'b.example', env: { NO_PROXY: 'c.example' } }), 'a.example');
check('noProxy http setting beats env', pickNoProxy({ explicit: '', vscodeHttpNoProxy: 'b.example', env: { NO_PROXY: 'c.example' } }), 'b.example');
check('noProxy env fallback', pickNoProxy({ env: { no_proxy: 'c.example' } }), 'c.example');
// VS Code's http.noProxy is an array; it must not throw on .trim().
check('noProxy accepts an array', pickNoProxy({ vscodeHttpNoProxy: ['a.example', 'b.example'] }), 'a.example,b.example');
check('noProxy none -> empty', pickNoProxy({ env: {} }), '');
check('parseNoProxy splits/trims/lowercases', parseNoProxy(' Localhost, .Internal ,, ').join('|'), 'localhost|.internal');

check('hostFromUrl keeps port', hostFromUrl('https://API.OpenAI.com:8443/v1'), 'api.openai.com:8443');
check('hostFromUrl tolerates no scheme', hostFromUrl('localhost:11434/v1'), 'localhost:11434');
check('hostFromUrl invalid -> null', hostFromUrl('::::'), null);

check('noProxy * matches all', hostMatchesNoProxy('anything.example', ['*']), true);
check('noProxy exact host', hostMatchesNoProxy('api.openai.com', ['api.openai.com']), true);
check('noProxy bare domain matches subdomain', hostMatchesNoProxy('api.openai.com', ['openai.com']), true);
check('noProxy dot-prefix matches subdomain', hostMatchesNoProxy('api.openai.com', ['.openai.com']), true);
check('noProxy lookalike does not match', hostMatchesNoProxy('notopenai.com', ['openai.com']), false);
check('noProxy port must match', hostMatchesNoProxy('proxy.example:8080', ['proxy.example:9090']), false);
check('noProxy port match', hostMatchesNoProxy('proxy.example:8080', ['proxy.example:8080']), true);
// A port-scoped pattern must NOT bypass a target with no explicit port.
check('noProxy port pattern skips default-port host', hostMatchesNoProxy('example.com', ['example.com:8080']), false);
check('noProxy port pattern skips other port', hostMatchesNoProxy('example.com:443', ['example.com:8080']), false);
check('noProxy localhost', hostMatchesNoProxy('localhost:11434', ['localhost']), true);
check('noProxy empty list no match', hostMatchesNoProxy('api.openai.com', []), false);

// --- OS system proxy (Clash "System Proxy" mode etc.) ---
check('systemProxy is lowest priority (explicit)', pickProxyUrl({ explicit: 'http://e:1', systemProxy: 'http://sys:2' }), 'http://e:1');
check('systemProxy loses to http.proxy', pickProxyUrl({ vscodeHttpProxy: 'http://v:2', systemProxy: 'http://sys:2' }), 'http://v:2');
check('systemProxy loses to env', pickProxyUrl({ env: { ALL_PROXY: 'http://env:3' }, systemProxy: 'http://sys:2' }), 'http://env:3');
check('systemProxy used when nothing else set', pickProxyUrl({ env: {}, systemProxy: 'http://sys:2' }), 'http://sys:2');
check('blank systemProxy ignored', pickProxyUrl({ env: {}, systemProxy: '   ' }), null);

// --- WinINET ProxyServer parsing (what Clash/v2rayN "System Proxy" writes) ---
check('bare host:port gets http scheme', parseWindowsProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
check('explicit scheme kept', parseWindowsProxyServer('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
check('per-scheme https wins', parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7891');
check('per-scheme falls back to http', parseWindowsProxyServer('http=127.0.0.1:7890;socks=127.0.0.1:1080'), 'http://127.0.0.1:7890');
check('socks-only keeps socks scheme (unsupported is NAMED)', parseWindowsProxyServer('socks=127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
check('empty -> null', parseWindowsProxyServer(''), null);
check('garbage per-scheme -> null', parseWindowsProxyServer('foo=bar'), null);

// --- scutil --proxy parsing (macOS) ---
const SCUTIL = [
    '<dictionary> {',
    '  HTTPEnable : 1',
    '  HTTPPort : 7890',
    '  HTTPProxy : 127.0.0.1',
    '  HTTPSEnable : 1',
    '  HTTPSPort : 7891',
    '  HTTPSProxy : 127.0.0.1',
    '  SOCKSEnable : 0',
    '}',
].join('\n');
check('scutil prefers https', parseScutilProxy(SCUTIL), 'http://127.0.0.1:7891');
check('scutil falls back to http', parseScutilProxy(SCUTIL.replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), 'http://127.0.0.1:7890');
check('scutil disabled -> null', parseScutilProxy(SCUTIL.replace('HTTPEnable : 1', 'HTTPEnable : 0').replace('HTTPSEnable : 1', 'HTTPSEnable : 0')), null);
check('scutil socks-only -> socks scheme', parseScutilProxy('SOCKSEnable : 1\nSOCKSPort : 1080\nSOCKSProxy : 127.0.0.1\n'), 'socks5://127.0.0.1:1080');
check('scutil missing port -> null', parseScutilProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\n'), null);

// --- gsettings parsing (Linux GNOME) ---
check('gsettings manual mode', parseGsettingsProxy("'manual'", "'127.0.0.1'", '7890'), 'http://127.0.0.1:7890');
check('gsettings none mode -> null', parseGsettingsProxy("'none'", "'127.0.0.1'", '7890'), null);
check('gsettings missing host -> null', parseGsettingsProxy("'manual'", "''", '7890'), null);
check('gsettings bad port -> null', parseGsettingsProxy("'manual'", "'127.0.0.1'", 'abc'), null);

// --- mode + provenance (what the Proxy page shows as "currently using") -----
const chain = {
    explicit: 'http://e:1',
    vscodeHttpProxy: 'http://v:2',
    env: { HTTPS_PROXY: 'http://env:3' },
    systemProxy: 'http://sys:4',
};
check('auto reports setting source', resolveProxyUrl({ ...chain, mode: 'auto' }).source, 'setting');
check('auto falls through to vscode', resolveProxyUrl({ ...chain, explicit: '', mode: 'auto' }).source, 'vscode');
check('auto falls through to env', resolveProxyUrl({ ...chain, explicit: '', vscodeHttpProxy: '', mode: 'auto' }).source, 'env');
check('auto falls through to system', resolveProxyUrl({ ...chain, explicit: '', vscodeHttpProxy: '', env: {}, mode: 'auto' }).source, 'system');
check('auto with nothing -> none', resolveProxyUrl({ mode: 'auto' }).source, 'none');
check('custom uses only the explicit URL', resolveProxyUrl({ ...chain, mode: 'custom' }).url, 'http://e:1');
check('custom with empty URL -> none', resolveProxyUrl({ ...chain, explicit: '', mode: 'custom' }).url, null);
check('off is always none', resolveProxyUrl({ ...chain, mode: 'off' }).url, null);
check('off source is none', resolveProxyUrl({ ...chain, mode: 'off' }).source, 'none');
check('default mode behaves as auto', resolveProxyUrl({ explicit: '', vscodeHttpProxy: '', env: {}, systemProxy: 'http://sys:4' }).url, 'http://sys:4');

// --- per-server route field (mcp.json `proxy`) ------------------------------
check('route auto accepted', normalizeProxyRoute('auto'), 'auto');
check('route proxy accepted', normalizeProxyRoute('proxy'), 'proxy');
check('route direct accepted', normalizeProxyRoute('direct'), 'direct');
check('route garbage -> undefined (auto)', normalizeProxyRoute('socks5'), undefined);
check('route missing -> undefined (auto)', normalizeProxyRoute(undefined), undefined);
check('route number -> undefined (auto)', normalizeProxyRoute(1), undefined);

// --- connection-test planning (the false-green guards) ----------------------
{
    // A local provider (localhost runtime) must NOT appear in a PROXY test -
    // it answers without the proxy and would "prove" a dead proxy works.
    const plan = planProxyTest({ proxyUrl: 'http://127.0.0.1:7890', providerUrl: 'http://127.0.0.1:11434', providerIsLocal: true });
    check('local provider excluded from proxy test', plan.targets.some((t) => t.url.includes('11434')), false);
    check('every proxy-test target is forced through the proxy', plan.targets.every((t) => t.throughProxy), true);
    check('external endpoints still probed', plan.targets.length, PROXY_TEST_ENDPOINTS.length);
}
{
    const plan = planProxyTest({ proxyUrl: 'http://127.0.0.1:7890', providerUrl: 'https://opencode.ai/zen/v1', providerIsLocal: false });
    check('external provider rides the proxy first', `${plan.targets[0].url}|${plan.targets[0].throughProxy}`, 'https://opencode.ai/zen/v1|true');
}
{
    const plan = planProxyTest({ proxyUrl: 'socks5://127.0.0.1:1080', providerUrl: null, providerIsLocal: false });
    check('socks proxy blocks the test (named, not silently direct)', plan.blockedKey, 'proxySocksUnsupported');
    check('socks proxy probes nothing', plan.targets.length, 0);
}
{
    const plan = planProxyTest({ proxyUrl: 'ftp://weird:21', providerUrl: null, providerIsLocal: false });
    check('bad scheme blocks the test', plan.blockedKey, 'proxyDetailBadScheme');
}
{
    const plan = planProxyTest({ proxyUrl: null, providerUrl: 'http://127.0.0.1:11434', providerIsLocal: true });
    check('no proxy: direct probe, local provider allowed', `${plan.targets[0].url}|${plan.targets[0].throughProxy}`, 'http://127.0.0.1:11434|false');
    check('no proxy: nothing is forced through a proxy', plan.targets.every((t) => !t.throughProxy), true);
}

// --- connection-test verdict shaping ---------------------------------------
check('any success wins', summarizeProxyTest([
    { ok: false, detailKey: 'proxyDetailTimeout', params: { host: 'a' } },
    { ok: true, detailKey: 'proxyDetailHttp', params: { status: '200', host: 'b' } },
]).ok, true);
check('all timeouts report a timeout', summarizeProxyTest([
    { ok: false, detailKey: 'proxyDetailTimeout', params: { host: 'a' } },
]).detailKey, 'proxyDetailTimeout');
check('concrete failure beats the timeout', summarizeProxyTest([
    { ok: false, detailKey: 'proxyDetailTimeout', params: { host: 'a' } },
    { ok: false, detailKey: 'proxyDetailHttp', params: { status: '502', host: 'b' } },
]).detailKey, 'proxyDetailHttp');
check('empty outcomes say so', summarizeProxyTest([]).detailKey, 'proxyDetailNoResponse');

// --- fetch/agent brand consistency (THE offline regression) -----------------
// Node's global fetch rejects npm-undici agents ("invalid onError method"),
// which killed every proxied request and took the whole extension offline.
// proxyFetch must accept the agent and fail (if at all) at the CONNECTION.
{
    let brandError = null;
    try {
        await proxyFetch('http://example.invalid:8081/', {
            dispatcher: new ProxyAgent('http://127.0.0.1:7898'),
            signal: AbortSignal.timeout(2500),
        });
    } catch (e) {
        brandError = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
    }
    check(
        'proxyFetch dispatches with an undici agent (no brand mismatch)',
        /invalid onError method/i.test(brandError ?? ''),
        false,
    );
}
// Without a dispatcher the global fetch must stay in play - the node test
// harnesses stub `globalThis.fetch` and would be bypassed otherwise.
{
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        return new Response('ok');
    };
    try {
        await proxyFetch('http://example.invalid:8081/');
    } finally {
        globalThis.fetch = realFetch;
    }
    check('no dispatcher: proxyFetch uses the mockable global fetch', called, true);
}

console.log(failed === 0 ? '\nproxy: all tests passed' : `\nproxy: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

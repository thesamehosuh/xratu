#!/usr/bin/env node
/**
 * SSRF guard tests for `fetch_url`, with emphasis on the PROXY case.
 *
 * Regression: the entire IP blocklist sat behind
 * `if (!isProxyConfigured(url))`. The justification was "the proxy resolves
 * hostnames for us" - true for DNS names, false for IP LITERALS, which need
 * no resolution. So configuring a proxy silently disabled the guard for every
 * literal: with a Clash/sing-box system proxy (this product's core audience)
 * `fetch_url` reached 169.254.169.254 (cloud metadata), 127.0.0.1:9229 (Chrome
 * DevTools) and the local Ollama - un-approved, and available in plan mode.
 *
 * Also pinned here: the documented `198.18.0.0/15` fake-IP allowance for
 * proxy-tunnel users must SURVIVE the fix, or every major site breaks for the
 * audience this product exists for. That is the non-regression that matters.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-ssrf-guard.mjs
 */
import Module from 'module';
import { createRequire } from 'module';

const FAKE_SYSTEM_PROXY = 'xratu-test-system-proxy';
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    // webTools imports `vscode`, and reaches the proxy through ./systemProxy.
    // Stubbing systemProxy lets us toggle "a proxy is configured" without
    // depending on the machine's real proxy settings.
    if (request === 'vscode') {
        return {
            workspace: { getConfiguration: () => ({ get: () => undefined }) },
            env: { openExternal: async () => undefined },
        };
    }
    if (request.endsWith('systemProxy')) {
        return {
            getSystemProxyUrl: () => (process.env[FAKE_SYSTEM_PROXY] || ''),
            setSystemProxyUrl: () => undefined,
        };
    }
    return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);

// Hermetic and fast: nothing here may touch the network. Direct-mode requests
// go through `globalThis.fetch` (see proxyFetch.ts), so stubbing it keeps the
// no-proxy cases instant. Proxied requests go through undici's own fetch with
// a dispatcher, which is NOT stubbable - so the fake proxy below points at a
// closed local port, which fails with ECONNREFUSED in milliseconds instead of
// hanging. Only "a proxy is configured" matters to the guard.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
    fetchCalls++;
    return new Response('stubbed body', { status: 200, headers: { 'content-type': 'text/plain' } });
};

const { executeWebTool } = require('../out/webTools.js');
const { isProxyConfigured } = require('../out/proxyDispatcher.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` (${detail})`}`);
};

const cfg = { searchProvider: 'auto', searchUrl: '', searchApiKey: '', maxContentChars: 30000 };

/** Returns 'blocked' | 'attempted' plus the message. */
const probe = async (url) => {
    const r = await executeWebTool('fetch_url', { url, max_chars: 1000 }, cfg);
    return { out: String(r.output ?? ''), blocked: /Refusing non-public/.test(String(r.output ?? '')) };
};

// Literal destinations that must be refused no matter how the request is routed.
const MUST_BLOCK = [
    ['cloud metadata (v4)', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback (v4)', 'http://127.0.0.1:11434/api/tags'],
    ['loopback (v6)', 'http://[::1]:8080/'],
    ['ipv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['decimal-encoded loopback', 'http://2130706433/'],
    ['hex-encoded loopback', 'http://0x7f.0.0.1/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['rfc1918 10/8', 'http://10.0.0.5/'],
    ['rfc1918 172.16/12', 'http://172.16.0.1/'],
    ['rfc1918 192.168/16', 'http://192.168.1.1/'],
    ['cgnat 100.64/10', 'http://100.100.100.200/'],
];

// Scheme / credential rules that must hold in both routing modes.
const MUST_REFUSE = [
    ['file scheme', 'file:///etc/passwd', /Only http/],
    ['embedded credentials', 'http://user:pw@example.com/', /credentials/],
];

// The documented, deliberate exception, which must hold in BOTH routing
// modes: Clash/sing-box fake-IP DNS hands back 198.18.0.0/15 addresses that the
// tunnel intercepts. Refusing it broke every major site for these users, so it
// is the non-regression that matters most here.
const ALLOWED_ANYWAY = [
    ['198.18.0.0/15 fake-IP', 'http://198.18.0.1/'],
    ['198.19.255.255 edge', 'http://198.19.255.255/'],
];

try {
    for (const [label, proxy] of [
        ['NO proxy configured', ''],
        ['system proxy CONFIGURED (the regression)', 'http://127.0.0.1:1'],
    ]) {
        process.env[FAKE_SYSTEM_PROXY] = proxy;
        ok(`[${label}] isProxyConfigured reflects the setting`,
            isProxyConfigured('http://example.com/') === (!!proxy));

        for (const [name, url] of MUST_BLOCK) {
            const before = fetchCalls;
            const { out, blocked } = await probe(url);
            ok(`[${label}] blocks ${name}`, blocked, out.replace(/\s+/g, ' ').slice(0, 70));
            // Blocked BEFORE any request went out, not after it failed.
            ok(`[${label}] ${name}: nothing was sent`, fetchCalls === before,
                `fetch called ${fetchCalls - before} time(s)`);
        }
        for (const [name, url, re] of MUST_REFUSE) {
            const { out } = await probe(url);
            ok(`[${label}] refuses ${name}`, re.test(out), out.replace(/\s+/g, ' ').slice(0, 70));
        }
        for (const [name, url] of ALLOWED_ANYWAY) {
            const { out, blocked } = await probe(url);
            ok(`[${label}] preserves the documented allowance: ${name}`,
                !blocked && !/Only http|Invalid URL/.test(out), out.replace(/\s+/g, ' ').slice(0, 70));
        }
        // A bracketed PUBLIC IPv6 literal used to be rejected outright as
        // "Host could not be resolved" (dns.lookup cannot take the bracketed
        // form). It must now pass the guard and fail only at the network layer.
        const pubV6 = await probe('http://[2606:4700:4700::1111]/');
        ok(`[${label}] public IPv6 literal is not refused by the guard`,
            !/Refusing non-public|Host could not be resolved/.test(pubV6.out),
            pubV6.out.replace(/\s+/g, ' ').slice(0, 70));
    }
} finally {
    delete process.env[FAKE_SYSTEM_PROXY];
    globalThis.fetch = realFetch;
}

console.log(failed === 0 ? '\nAll SSRF guard tests passed.' : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
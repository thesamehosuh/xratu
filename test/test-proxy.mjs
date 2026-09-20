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
const { pickProxyUrl, isSocksProxy, isHttpProxy } = require('../out/proxy.js');

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

console.log(failed === 0 ? '\nproxy: all tests passed' : `\nproxy: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

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
} = require('../out/proxy.js');

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

console.log(failed === 0 ? '\nproxy: all tests passed' : `\nproxy: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

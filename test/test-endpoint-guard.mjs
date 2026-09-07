#!/usr/bin/env node
/**
 * Endpoint guard tests - cleartext API-key protection.
 *
 * Regression for CodeRabbit review round 3: `_isLikelyLocalUrl` used
 * substring/prefix checks, so `http://localhost.attacker.example` and
 * `http://172.200.1.1` (outside 172.16/12) passed as "local" and an API
 * key could be sent over remote cleartext HTTP. Also covers bracketed
 * IPv6 loopback (`URL.hostname` keeps the brackets).
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-endpoint-guard.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isLikelyLocalUrl, insecureRemoteHttpError, mcpCleartextHeadersError } = require('../out/endpointGuard.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};

// --- isLikelyLocalUrl: loopback + RFC1918 allowed ---
check('localhost', isLikelyLocalUrl('http://localhost:11434'), true);
check('localhost case-insensitive', isLikelyLocalUrl('http://LocalHost:1234'), true);
check('.localhost suffix', isLikelyLocalUrl('http://foo.localhost'), true);
check('ipv4 loopback range', isLikelyLocalUrl('http://127.9.9.9:8080'), true);
check('bracketed ipv6 loopback', isLikelyLocalUrl('http://[::1]:11434'), true);
check('10/8', isLikelyLocalUrl('http://10.1.2.3'), true);
check('172.16/12 low', isLikelyLocalUrl('http://172.16.0.1'), true);
check('172.16/12 high', isLikelyLocalUrl('http://172.31.255.255'), true);
check('192.168/16', isLikelyLocalUrl('http://192.168.1.50'), true);
check('https localhost', isLikelyLocalUrl('https://localhost'), true);

// --- isLikelyLocalUrl: lookalikes and remote rejected ---
check('localhost hostname spoof', isLikelyLocalUrl('http://localhost.attacker.example'), false);
check('172.200 outside 172.16/12', isLikelyLocalUrl('http://172.200.1.1'), false);
check('172.32 outside 172.16/12', isLikelyLocalUrl('http://172.32.0.1'), false);
check('public ipv4', isLikelyLocalUrl('http://8.8.8.8'), false);
check('11/8 not private', isLikelyLocalUrl('http://11.0.0.1'), false);
check('public domain', isLikelyLocalUrl('http://example.com'), false);
check('non-http protocol', isLikelyLocalUrl('ftp://localhost'), false);
check('garbage url', isLikelyLocalUrl('not a url'), false);
check('ipv6 public', isLikelyLocalUrl('http://[2001:db8::1]:8000'), false);

// --- insecureRemoteHttpError ---
check('keyless remote http allowed', insecureRemoteHttpError('http://example.com', null), null);
check('empty key allowed', insecureRemoteHttpError('http://example.com', ''), null);
check('keyed remote http blocked', insecureRemoteHttpError('http://example.com', 'sk-123'), 'insecureEndpointHttp');
check('keyed localhost http allowed', insecureRemoteHttpError('http://localhost:11434', 'k'), null);
check('keyed LAN http allowed', insecureRemoteHttpError('http://192.168.1.5:8080', 'k'), null);
check('keyed ipv6 loopback allowed', insecureRemoteHttpError('http://[::1]:11434', 'k'), null);
check('keyed https remote allowed', insecureRemoteHttpError('https://api.openai.com/v1', 'sk-123'), null);
check('keyed spoofed local http blocked', insecureRemoteHttpError('http://localhost.attacker.example', 'sk-123'), 'insecureEndpointHttp');
check('whitespace url trimmed', insecureRemoteHttpError('  http://example.com  ', 'k'), 'insecureEndpointHttp');

// --- mcpCleartextHeadersError (external MCP HTTP/SSE transports) ---
check('mcp: remote https with headers allowed', mcpCleartextHeadersError('https://mcp.example.com/mcp', 2), null);
check('mcp: remote http with headers blocked', mcpCleartextHeadersError('http://mcp.example.com/mcp', 2), 'credential headers require https: for remote endpoints (http://mcp.example.com)');
check('mcp: remote http without headers allowed', mcpCleartextHeadersError('http://mcp.example.com/mcp', 0), null);
check('mcp: localhost http with headers allowed', mcpCleartextHeadersError('http://localhost:3000/mcp', 1), null);
check('mcp: ipv4 loopback http with headers allowed', mcpCleartextHeadersError('http://127.0.0.1:3000/mcp', 1), null);
check('mcp: ipv6 loopback http with headers allowed', mcpCleartextHeadersError('http://[::1]:3000/mcp', 1), null);
check('mcp: LAN http with headers allowed', mcpCleartextHeadersError('http://192.168.1.10:9000/mcp', 1), null);
check('mcp: spoofed local hostname blocked', mcpCleartextHeadersError('http://localhost.attacker.example/mcp', 1), 'credential headers require https: for remote endpoints (http://localhost.attacker.example)');
check('mcp: https never blocked regardless of headers', mcpCleartextHeadersError('https://mcp.internal.corp/mcp', 5), null);
check('mcp: garbage url rejected', !!mcpCleartextHeadersError('not a url', 1), true);

console.log(failed === 0 ? '\nendpoint-guard tests: all passed' : `\nendpoint-guard tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

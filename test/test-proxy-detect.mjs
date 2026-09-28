#!/usr/bin/env node
/**
 * Local proxy-detection tests (the Proxy page's "Scan" backend).
 *
 * The scan decides HOW the user's traffic will be routed: a misclassified
 * port silently becomes a broken proxy URL. So the protocol must come from
 * sniffing (never from the catalog's claim), SOCKS-only listeners must be
 * named but flagged unusable (undici cannot ride them), and a Clash-family
 * controller must refine the service name. Loopback probes run against
 * throwaway ports, not the catalog's real ones.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-proxy-detect.mjs
 */
import { createRequire } from 'module';
import * as net from 'net';
const require = createRequire(import.meta.url);
const {
    PROXY_SERVICE_PORTS,
    isSocks5Reply,
    isHttpProxyConnectReply,
    parseControllerFingerprint,
    serviceLabelFor,
    groupDetectedPorts,
    sniffProxyProtocol,
} = require('../out/proxyDetect.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

// --- catalog sanity ---------------------------------------------------------
check('catalog non-empty', PROXY_SERVICE_PORTS.length > 10, true);
check('clash mixed port present', PROXY_SERVICE_PORTS.some((p) => p.port === 7890 && p.role === 'proxy'), true);
check('verge rev mixed port is 7897', PROXY_SERVICE_PORTS.some((p) => p.port === 7897), true);
check('verge rev controller is 9097', PROXY_SERVICE_PORTS.some((p) => p.port === 9097 && p.role === 'controller'), true);
check('v2rayN mixed port is 10808', PROXY_SERVICE_PORTS.some((p) => p.port === 10808), true);
ok('every entry has a service name', PROXY_SERVICE_PORTS.every((p) => typeof p.service === 'string' && p.service.length > 0));
// Generic default ports (8080/3128/8118/8888) collide with ordinary dev
// servers - naming them after mitmproxy/Squid/Privoxy/Charles misleads.
check('no mitmproxy label', PROXY_SERVICE_PORTS.some((p) => p.service === 'mitmproxy'), false);
check('no 8080 entry', PROXY_SERVICE_PORTS.some((p) => p.port === 8080 && p.role === 'proxy'), false);
check('no 3128 entry', PROXY_SERVICE_PORTS.some((p) => p.port === 3128), false);
check('no 8888 entry', PROXY_SERVICE_PORTS.some((p) => p.port === 8888), false);
check('no 8118 entry', PROXY_SERVICE_PORTS.some((p) => p.port === 8118), false);

// --- sniff reply classification --------------------------------------------
check('socks5 no-auth reply', isSocks5Reply(Buffer.from([0x05, 0x00])), true);
check('socks5 auth reply', isSocks5Reply(Buffer.from([0x05, 0x02])), true);
check('socks5 reject reply', isSocks5Reply(Buffer.from([0x05, 0xff])), true);
check('http banner is not socks', isSocks5Reply(Buffer.from('HTTP/1.1')), false);
check('empty is not socks', isSocks5Reply(Buffer.alloc(0)), false);

check('connect 200 is a proxy', isHttpProxyConnectReply('HTTP/1.1 200 Connection established'), true);
check('connect 407 is a proxy', isHttpProxyConnectReply('HTTP/1.1 407 Proxy Authentication Required'), true);
check('connect 502 is a proxy (upstream failed, still a proxy)', isHttpProxyConnectReply('HTTP/1.1 502 Bad Gateway'), true);
check('garbage is not a proxy', isHttpProxyConnectReply('SSH-2.0-OpenSSH'), false);
check('empty is not a proxy', isHttpProxyConnectReply(''), false);

// --- controller fingerprints -----------------------------------------------
check('hello clash', parseControllerFingerprint(200, '{"hello":"clash"}'), 'clash');
check('hello mihomo', parseControllerFingerprint(200, '{"hello":"mihomo"}'), 'mihomo');
check('meta version is mihomo', parseControllerFingerprint(200, '{"meta":true,"version":"alpha-abc"}'), 'mihomo');
check('plain version is clash', parseControllerFingerprint(200, '{"version":"v1.18.0"}'), 'clash');
check('401 is clash-family (secret set)', parseControllerFingerprint(401, 'Unauthorized'), 'clash-family');
check('html page is not a controller', parseControllerFingerprint(200, '<html></html>'), null);
check('random json is not a controller', parseControllerFingerprint(200, '{"port":7890}'), null);

// --- service labels ---------------------------------------------------------
const ctrl9090m = { port: 9090, fingerprint: 'mihomo' };
const ctrl9090c = { port: 9090, fingerprint: 'clash' };
const ctrl9097 = { port: 9097, fingerprint: 'mihomo' };
check('mihomo fingerprint on mihomo port', serviceLabelFor(7890, 'mixed', ctrl9090m), 'mihomo (Clash Meta)');
check('clash fingerprint on mihomo port', serviceLabelFor(7890, 'mixed', ctrl9090c), 'Clash');
// A Verge Rev controller names its own family even on a fallback port - but
// never overwrites a MORE specific catalog name.
check('verge controller refines generic mihomo port', serviceLabelFor(7890, 'mixed', ctrl9097), 'Clash Verge Rev');
check('verge controller names fallback port', serviceLabelFor(54321, 'http', ctrl9097), 'Clash Verge Rev');
check('specific catalog name beats controller', serviceLabelFor(10808, 'mixed', ctrl9097), 'v2rayN');
check('catalog match by port', serviceLabelFor(7897, 'mixed', null), 'Clash Verge Rev');
check('catalog match v2rayN', serviceLabelFor(10808, 'mixed', null), 'v2rayN');
check('unknown http port stays generic', serviceLabelFor(54321, 'http', null), 'HTTP proxy');
check('unknown socks port stays generic', serviceLabelFor(54321, 'socks5', null), 'SOCKS5 proxy');
check('dev-server port stays generic (no mitmproxy)', serviceLabelFor(8080, 'http', null), 'HTTP proxy');

// --- family grouping (one row per CLIENT, never per port) -------------------
{
    const groups = groupDetectedPorts([
        { port: 7898, protocol: 'socks5', url: 'socks5://127.0.0.1:7898', usable: false },
        { port: 7897, protocol: 'mixed', url: 'http://127.0.0.1:7897', usable: true },
        { port: 7899, protocol: 'http', url: 'http://127.0.0.1:7899', usable: true },
    ]);
    check('clash verge ports fold into one row', groups.length, 1);
    check('family keeps all its ports', groups[0].ports.map((p) => p.port).join(','), '7897,7898,7899');
    check('family locks to the http/mixed port', groups[0].url, 'http://127.0.0.1:7897');
    check('family name', groups[0].service, 'Clash Verge Rev');
}
{
    // Two unrelated listeners on generic labels must NOT merge into one row.
    const groups = groupDetectedPorts([
        { port: 50001, protocol: 'http', url: 'http://127.0.0.1:50001', usable: true },
        { port: 50002, protocol: 'http', url: 'http://127.0.0.1:50002', usable: true },
    ]);
    check('unknown ports stay separate rows', groups.length, 2);
}
{
    const groups = groupDetectedPorts([
        { port: 1080, protocol: 'socks5', url: 'socks5://127.0.0.1:1080', usable: false },
    ]);
    check('socks-only family has nothing to lock to', groups[0].url, null);
    check('socks-only family still named', groups[0].service, 'Shadowsocks / ssh -D');
}

// --- loopback sniffing (throwaway ports) ------------------------------------
function serve(handler) {
    return new Promise((resolve) => {
        const server = net.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}
const address = (server) => server.address();

const mixedServer = await serve((socket) => {
    socket.once('data', (chunk) => {
        if (chunk[0] === 0x05) {
            socket.write(Buffer.from([0x05, 0x00]));
        } else {
            socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        }
    });
});
const mixedPort = address(mixedServer).port;
check('mixed listener sniffs as mixed', await sniffProxyProtocol('127.0.0.1', mixedPort), 'mixed');
mixedServer.close();

const httpServer = await serve((socket) => {
    socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
});
const httpPort = address(httpServer).port;
check('http-only listener sniffs as http', await sniffProxyProtocol('127.0.0.1', httpPort), 'http');
httpServer.close();

const socksServer = await serve((socket) => {
    socket.once('data', () => {
        socket.write(Buffer.from([0x05, 0x00]));
    });
});
const socksPort = address(socksServer).port;
check('socks-only listener sniffs as socks5', await sniffProxyProtocol('127.0.0.1', socksPort), 'socks5');
socksServer.close();

const deadServer = await serve(() => { /* accepts then says nothing */ });
const deadPort = address(deadServer).port;
deadServer.close();
await new Promise((r) => setTimeout(r, 50));
check('closed port sniffs as closed', await sniffProxyProtocol('127.0.0.1', deadPort), 'closed');

console.log(failed === 0 ? '\nproxy-detect: all tests passed' : `\nproxy-detect: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

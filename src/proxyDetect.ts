/**
 * Local proxy-service detection: find the proxy the user's client (Clash
 * family, v2rayN, Surge, …) already runs on this machine, name it, and let
 * the UI "lock" to its port.
 *
 * Pure classification + the port catalog are exported for the node test
 * suite; only `detectLocalProxies()` touches the network, and only against
 * loopback. Port numbers are priors, not truth - every client lets the user
 * change them - so an unrecognized port that SPEAKS http/mixed is still
 * reported (as a generic proxy), and the protocol is decided by sniffing,
 * never by the catalog entry.
 */
import * as net from 'net';

export type ProxyProtocol = 'http' | 'socks5' | 'mixed';

export interface ProxyServicePort {
    /** Client family shown in the UI (display name, English). */
    service: string;
    port: number;
    protocol: ProxyProtocol;
    role: 'proxy' | 'controller';
}

/**
 * Default ports of popular desktop proxy clients (verified against upstream
 * sources; see test/test-proxy-detect.mjs for the pinned expectations):
 *   - mihomo/Clash premium: mixed 7890, socks 7891, controller 9090
 *   - Clash Verge Rev: mixed 7897, socks 7898, http 7899, controller 9097
 *     (auto-falls-back to the next free port when occupied)
 *   - Clash Nyanpasu: mixed 7890, controller 17650
 *   - Mihomo Party: mixed 7890, socks 7891, http 7892 (no controller)
 *   - ClashX: 7890 / controller 9090 (shipped sample config convention)
 *   - v2rayN: mixed 10808 (legacy http 10809); v2rayA: socks 20170 / http 20171
 *   - NekoRay/NekoBox: mixed 2080; Hiddify: mixed 12334; MahsaNG: socks 10809 / http 10810
 *   - shadowsocks-windows: mixed 1080 (same convention as `ssh -D 1080`)
 *   - Surge: http 6152 / socks 6153; Tor 9050, Tor Browser 9150
 *
 * DELIBERATELY absent: mitmproxy (8080), Squid (3128), Privoxy (8118),
 * Charles/Fiddler (8888). Those defaults collide with ordinary dev servers,
 * and a wrong CLIENT NAME misleads more than a generic "HTTP proxy" label -
 * anything on those ports still gets reported, just honestly unnamed.
 */
export const PROXY_SERVICE_PORTS: readonly ProxyServicePort[] = [
    { service: 'mihomo / Clash Meta', port: 7890, protocol: 'mixed', role: 'proxy' },
    { service: 'mihomo / Clash Meta', port: 7891, protocol: 'socks5', role: 'proxy' },
    { service: 'mihomo / Clash Meta', port: 9090, protocol: 'http', role: 'controller' },
    { service: 'Clash Verge Rev', port: 7897, protocol: 'mixed', role: 'proxy' },
    { service: 'Clash Verge Rev', port: 7898, protocol: 'socks5', role: 'proxy' },
    { service: 'Clash Verge Rev', port: 7899, protocol: 'http', role: 'proxy' },
    { service: 'Clash Verge Rev', port: 9097, protocol: 'http', role: 'controller' },
    { service: 'Clash Nyanpasu', port: 17650, protocol: 'http', role: 'controller' },
    { service: 'v2rayN', port: 10808, protocol: 'mixed', role: 'proxy' },
    { service: 'v2rayN', port: 10809, protocol: 'mixed', role: 'proxy' },
    { service: 'v2rayA', port: 20171, protocol: 'http', role: 'proxy' },
    { service: 'v2rayA', port: 20170, protocol: 'socks5', role: 'proxy' },
    { service: 'NekoRay / NekoBox', port: 2080, protocol: 'mixed', role: 'proxy' },
    { service: 'Hiddify', port: 12334, protocol: 'mixed', role: 'proxy' },
    { service: 'MahsaNG', port: 10810, protocol: 'http', role: 'proxy' },
    { service: 'MahsaNG', port: 10809, protocol: 'socks5', role: 'proxy' },
    { service: 'Shadowsocks / ssh -D', port: 1080, protocol: 'mixed', role: 'proxy' },
    { service: 'Surge', port: 6152, protocol: 'http', role: 'proxy' },
    { service: 'Surge', port: 6153, protocol: 'socks5', role: 'proxy' },
    { service: 'Tor', port: 9050, protocol: 'socks5', role: 'proxy' },
    { service: 'Tor Browser', port: 9150, protocol: 'socks5', role: 'proxy' },
];

/** One open listener inside a client family. */
export interface DetectedProxyPort {
    port: number;
    /** What the port actually SPEAKS (sniffed), not what the catalog claims. */
    protocol: ProxyProtocol;
    url: string;
    /** false for socks5-only: undici cannot use it (named but flagged). */
    usable: boolean;
}

/** One CLIENT (Clash Verge Rev, v2rayN, ...) with every port it owns - a
 *  family rows, never one row per port. */
export interface DetectedProxyGroup {
    /** Best-guess client name - catalog match, controller fingerprint, or a
     *  generic label when the port is unrecognized. */
    service: string;
    /** Endpoint "Use" locks to: the first usable http/mixed port, or null
     *  when the family only speaks SOCKS. */
    url: string | null;
    ports: DetectedProxyPort[];
}

/** SOCKS5 greeting reply that proves a SOCKS5 listener (`\x05\x00` no-auth,
 *  `\x05\x02` wants credentials, `\x05\xff` rejecting but still SOCKS). */
export function isSocks5Reply(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x05;
}

/** Classify the status line of a reply to `CONNECT detect.invalid:443`. ANY
 *  HTTP answer means the listener is a forward proxy (web servers do not
 *  implement CONNECT); 407 is the strongest tell after 200. */
export function isHttpProxyConnectReply(statusLine: string): boolean {
    return /^HTTP\/\d\.\d\s+\d{3}/i.test(statusLine.trim());
}

export type ControllerFingerprint = 'clash' | 'mihomo' | 'clash-family';

export interface ControllerHit {
    port: number;
    fingerprint: ControllerFingerprint;
}

/** Identify a Clash-family controller from its `/` or `/version` body.
 *  `{"hello":"mihomo"}` / `meta:true` = mihomo; `{"hello":"clash"}` / plain
 *  `version` = clash/premium; HTTP 401 = same family behind a secret. */
export function parseControllerFingerprint(status: number, body: string): ControllerFingerprint | null {
    if (status === 401) return 'clash-family';
    let parsed: Record<string, unknown> | null = null;
    try {
        const value = JSON.parse(body);
        if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!parsed) return null;
    const hello = typeof parsed.hello === 'string' ? parsed.hello.toLowerCase() : '';
    if (hello === 'mihomo') return 'mihomo';
    if (hello === 'clash') return 'clash';
    if (parsed.meta === true) return 'mihomo';
    if (typeof parsed.version === 'string') return 'clash';
    return null;
}

const GENERIC_LABELS = new Set(['HTTP proxy', 'SOCKS5 proxy']);

/** Display name for a sniffed proxy port. Precedence: the catalog's specific
 *  client name for the port, then the controller family (a 9097 controller IS
 *  Clash Verge Rev even on a fallback port), then a generic label. */
export function serviceLabelFor(
    port: number,
    protocol: ProxyProtocol,
    controller?: ControllerHit | null,
): string {
    const cataloged = PROXY_SERVICE_PORTS.find((p) => p.port === port && p.role === 'proxy');
    if (cataloged) {
        // Never let a generic mihomo/clash fingerprint overwrite a more
        // specific client name (Verge Rev vs bare mihomo).
        if (controller && (cataloged.service.startsWith('mihomo') || cataloged.service === 'Clash')) {
            return controllerName(controller);
        }
        return cataloged.service;
    }
    if (controller) return controllerName(controller);
    return protocol === 'socks5' ? 'SOCKS5 proxy' : 'HTTP proxy';
}

function controllerName(controller: ControllerHit): string {
    if (controller.port === 9097) return 'Clash Verge Rev';
    if (controller.port === 17650) return 'Clash Nyanpasu';
    return controller.fingerprint === 'mihomo' ? 'mihomo (Clash Meta)' : 'Clash';
}

/** Ports group into their CLIENT's family row; unrecognized ports on generic
 *  labels stay one row each (two random HTTP listeners are not one client). */
function groupKeyFor(port: number, label: string): string {
    return GENERIC_LABELS.has(label) ? `port:${port}` : `svc:${label}`;
}

/** Fold sniffed ports into client-family rows (pure - `detectLocalProxies`
 *  probes the network then delegates here). One row per client, every port it
 *  owns listed; `url` is the endpoint "Use" locks to (first http/mixed port,
 *  null when the family is SOCKS-only). */
export function groupDetectedPorts(
    entries: Array<{ port: number; protocol: ProxyProtocol; url: string; usable: boolean }>,
    controller?: ControllerHit | null,
): DetectedProxyGroup[] {
    const byPort = new Map<number, DetectedProxyPort>();
    for (const entry of entries) {
        if (!byPort.has(entry.port)) byPort.set(entry.port, { ...entry });
    }
    const groups = new Map<string, DetectedProxyGroup>();
    for (const entry of byPort.values()) {
        const label = serviceLabelFor(entry.port, entry.protocol, controller);
        const key = groupKeyFor(entry.port, label);
        const group = groups.get(key) ?? { service: label, url: null, ports: [] };
        group.ports.push(entry);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        group.ports.sort((a, b) => a.port - b.port);
        const primary = group.ports.find((p) => p.usable && p.protocol !== 'socks5')
            ?? group.ports.find((p) => p.usable);
        group.url = primary ? primary.url : null;
    }
    return [...groups.values()].sort((a, b) =>
        (a.url ? 0 : 1) - (b.url ? 0 : 1) || (a.ports[0]?.port ?? 0) - (b.ports[0]?.port ?? 0));
}

// --- Network probes (loopback only) -----------------------------------------

const PROBE_TIMEOUT_MS = 400;

function connect(host: string, port: number): Promise<net.Socket | null> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const finish = (value: net.Socket | null) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            if (!value) socket.destroy();
            resolve(value);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
        socket.once('connect', () => finish(socket));
        socket.once('error', () => finish(null));
    });
}

function readOnce(socket: net.Socket, maxBytes: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<Buffer> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            socket.removeAllListeners('data');
            socket.removeAllListeners('end');
            socket.removeAllListeners('timeout');
            socket.removeAllListeners('error');
            resolve(Buffer.concat(chunks));
        };
        socket.setTimeout(timeoutMs, finish);
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total >= maxBytes) finish();
        });
        socket.once('end', finish);
        socket.once('error', finish);
    });
}

/** Sniff one loopback port. Two connections (SOCKS byte + HTTP CONNECT) so a
 *  mixed listener reports both, matching how Clash's mixed-port sniffs the
 *  first byte. `detect.invalid` never resolves, so a real proxy answers with
 *  an error status instead of opening an upstream tunnel. */
export async function sniffProxyProtocol(host: string, port: number): Promise<ProxyProtocol | 'closed'> {
    const socks = await connect(host, port);
    if (!socks) return 'closed';
    let socksOk = false;
    try {
        socks.write(Buffer.from([0x05, 0x01, 0x00]));
        const reply = await readOnce(socks, 2);
        socksOk = isSocks5Reply(reply);
    } finally {
        socks.destroy();
    }

    const http = await connect(host, port);
    if (!http) return socksOk ? 'socks5' : 'closed';
    let httpOk = false;
    try {
        http.write('CONNECT detect.invalid:443 HTTP/1.1\r\nHost: detect.invalid:443\r\n\r\n');
        const reply = await readOnce(http, 128);
        httpOk = isHttpProxyConnectReply(reply.toString('latin1').split('\r\n')[0] ?? '');
    } finally {
        http.destroy();
    }

    if (socksOk && httpOk) return 'mixed';
    if (httpOk) return 'http';
    if (socksOk) return 'socks5';
    return 'closed';
}

/** Probe a Clash-family controller port (`/` then `/version`). */
export async function probeController(host: string, port: number): Promise<ControllerFingerprint | null> {
    for (const path of ['/', '/version']) {
        try {
            const response = await fetch(`http://${host}:${port}${path}`, {
                signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                headers: { Accept: 'application/json' },
            });
            const body = await response.text().catch(() => '');
            const hit = parseControllerFingerprint(response.status, body);
            if (hit) return hit;
        } catch {
            // closed / timed out - try the next path
        }
    }
    return null;
}

/**
 * Scan loopback for known (and unknown-but-speaking) proxy listeners.
 * Parallel, bounded (~2 probe rounds), safe to run on a button press.
 */
/**
 * Scan loopback for known (and controller-named) proxy clients. Results are
 * grouped per CLIENT (one row per family, every port it owns listed), never
 * one row per port. Parallel, bounded (~2 probe rounds), safe on a click.
 */
export async function detectLocalProxies(): Promise<DetectedProxyGroup[]> {
    const hosts = ['127.0.0.1', '::1'];
    const proxyPorts = [...new Set(PROXY_SERVICE_PORTS.filter((p) => p.role === 'proxy').map((p) => p.port))];
    const controllerPorts = [...new Set(PROXY_SERVICE_PORTS.filter((p) => p.role === 'controller').map((p) => p.port))];

    const sniffed = await Promise.all(hosts.flatMap((host) =>
        proxyPorts.map(async (port) => ({ host, port, protocol: await sniffProxyProtocol(host, port) }))));
    const controllers = await Promise.all(hosts.flatMap((host) =>
        controllerPorts.map(async (port) => ({ host, port, fingerprint: await probeController(host, port) }))));
    const hit = controllers.find((c) => c.fingerprint);
    const controller: ControllerHit | null = hit ? { port: hit.port, fingerprint: hit.fingerprint! } : null;

    // Dedupe by port (127.0.0.1 and ::1 answering on the same port = one row).
    const byPort = new Map<number, DetectedProxyPort>();
    for (const sniff of sniffed) {
        if (sniff.protocol === 'closed' || byPort.has(sniff.port)) continue;
        const usable = sniff.protocol !== 'socks5';
        byPort.set(sniff.port, {
            port: sniff.port,
            protocol: sniff.protocol,
            // SOCKS-only listeners get a socks5 URL so the dispatcher layer
            // refuses them by NAME (never a silent direct).
            url: usable ? `http://${formatHost(sniff.host)}:${sniff.port}` : `socks5://${formatHost(sniff.host)}:${sniff.port}`,
            usable,
        });
    }
    return groupDetectedPorts([...byPort.values()], controller);
}

function formatHost(host: string): string {
    return host.includes(':') ? `[${host}]` : host;
}

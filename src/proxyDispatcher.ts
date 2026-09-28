/**
 * VS Code + undici glue for proxying outbound model and web requests.
 *
 * `getProxyDispatcher()` returns an undici `ProxyAgent` that is passed to
 * `proxyFetch()` as the non-standard `dispatcher` option - WITHOUT mutating
 * the process-wide dispatcher (which would leak into other extensions).
 *
 * `proxyFetch()` MUST be used for anything that can carry a dispatcher:
 * Node's GLOBAL fetch runs on a DIFFERENT undici copy (the one built into
 * Node) and brand-checks dispatchers against its own classes - handing it an
 * npm-undici agent fails every request instantly with "invalid onError
 * method". undici's own fetch + undici's own agent always match, whatever
 * undici version VS Code's Node happens to ship.
 */
import * as vscode from 'vscode';
import { ProxyAgent, type Dispatcher } from 'undici';
import { resolveProxyUrl, pickNoProxy, parseNoProxy, hostMatchesNoProxy, hostFromUrl, isHttpProxy, isSocksProxy, redactProxyUrl, type ProxyMode, type ProxyRouteMode, type ResolvedProxy } from './proxy';
import { getSystemProxyUrl } from './systemProxy';


let cachedUrl: string | null = null;
let cachedDispatcher: Dispatcher | undefined;
let warnedUnsupported = false;

/** `xratu.proxyMode`, normalized (unknown values behave as auto). */
export function getProxyMode(): ProxyMode {
    const raw = vscode.workspace.getConfiguration('xratu').get<string>('proxyMode');
    return raw === 'off' || raw === 'custom' ? raw : 'auto';
}

function proxySources() {
    return {
        mode: getProxyMode(),
        explicit: vscode.workspace.getConfiguration('xratu').get<string>('proxyUrl'),
        vscodeHttpProxy: vscode.workspace.getConfiguration('http').get<string>('proxy'),
        env: process.env,
        systemProxy: getSystemProxyUrl(),
    };
}

/** Current proxy URL: `xratu.proxyMode` gates the whole chain, which is
 *  `xratu.proxyUrl` > VS Code `http.proxy` > env > OS system proxy (Clash
 *  "System Proxy" mode etc. - undici never reads it). */
export function getProxyUrl(): string | null {
    return resolveProxyUrl(proxySources()).url;
}

/** Full resolution report for the Proxy page: mode, the URL that won, which
 *  layer produced it, and the OS system proxy (whether it won or not). */
export function getProxyResolution(): ResolvedProxy & { mode: ProxyMode; systemProxy: string | null; noProxy: string } {
    const resolved = resolveProxyUrl(proxySources());
    return { ...resolved, mode: getProxyMode(), systemProxy: getSystemProxyUrl(), noProxy: getNoProxy() };
}

/** Current no_proxy list: `xratu.noProxy` > VS Code `http.noProxy` > env. */
export function getNoProxy(): string {
    return pickNoProxy({
        explicit: vscode.workspace.getConfiguration('xratu').get<string>('noProxy'),
        // http.noProxy is a LIST in VS Code - it can come back as string[].
        vscodeHttpNoProxy: vscode.workspace.getConfiguration('http').get<string | string[]>('noProxy'),
        env: process.env,
    });
}

/**
 * True when a proxy will actually be used for `targetUrl`. The SSRF guard
 * skips its DNS check only when this is true, so it must reflect a USABLE
 * dispatcher for that target - not merely a non-empty setting. A SOCKS or
 * malformed URL, or a no_proxy match, returns false and the guard runs.
 */
export function isProxyConfigured(targetUrl?: string): boolean {
    return getProxyDispatcher(targetUrl) !== undefined;
}

/** Per-consumer routing override (the per-MCP-server policy) - see
 *  `ProxyRouteMode` in proxy.ts. */
export type ProxyRouteOverride = ProxyRouteMode;

/**
 * Dispatcher for the configured proxy, or undefined when none is set, the
 * scheme is unsupported, `override` says direct, or `targetUrl` matches
 * no_proxy. Cached by URL; rebuilt (and the old agent closed) when the URL
 * changes.
 */
export function getProxyDispatcher(targetUrl?: string, override?: ProxyRouteMode): Dispatcher | undefined {
    if (override === 'direct') return undefined;
    const url = getProxyUrl();
    if (!url) {
        disposeCached();
        return undefined;
    }
    // no_proxy bypass: this target talks direct, so the caller's SSRF check
    // must run. A per-server 'proxy' override skips it deliberately. Do NOT
    // dispose the cached agent - other targets still use it.
    if (override !== 'proxy' && targetUrl) {
        const host = hostFromUrl(targetUrl);
        if (host && hostMatchesNoProxy(host, parseNoProxy(getNoProxy()))) return undefined;
    }
    if (isSocksProxy(url)) {
        disposeCached();
        warnUnsupported('SOCKS proxies are not supported yet - set an HTTP proxy instead');
        return undefined;
    }
    if (!isHttpProxy(url)) {
        disposeCached();
        warnUnsupported('Unsupported proxy scheme - use http:// or https://');
        return undefined;
    }
    if (url !== cachedUrl) {
        let next: Dispatcher;
        try {
            next = new ProxyAgent(url);
        } catch {
            disposeCached();
            warnUnsupported(`Invalid proxy URL (${redactProxyUrl(url)}) - ignoring`);
            return undefined;
        }
        disposeCached();
        cachedDispatcher = next;
        cachedUrl = url;
    }
    return cachedDispatcher;
}

/** Close and forget the cached agent so its socket pools are released. */
function disposeCached(): void {
    const old = cachedDispatcher;
    cachedUrl = null;
    cachedDispatcher = undefined;
    if (old) {
        void old.close().catch(() => { /* best effort */ });
    }
}

function warnUnsupported(message: string): void {
    if (warnedUnsupported) return;
    warnedUnsupported = true;
    console.warn(`[xratu] ${message}`);
}

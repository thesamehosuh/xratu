/**
 * VS Code + undici glue for proxying outbound model and web requests.
 *
 * `getProxyDispatcher()` returns an undici `ProxyAgent` that can be passed to
 * `fetch` as the non-standard `dispatcher` option. Node's global fetch is
 * undici-backed, so this routes the request through the proxy without mutating
 * the process-wide dispatcher (which would leak into other extensions).
 */
import * as vscode from 'vscode';
import { ProxyAgent, type Dispatcher } from 'undici';
import { pickProxyUrl, pickNoProxy, parseNoProxy, hostMatchesNoProxy, hostFromUrl, isHttpProxy, isSocksProxy, redactProxyUrl } from './proxy';

let cachedUrl: string | null = null;
let cachedDispatcher: Dispatcher | undefined;
let warnedUnsupported = false;

/** Current proxy URL: `xratu.proxyUrl` > VS Code `http.proxy` > env. */
export function getProxyUrl(): string | null {
    return pickProxyUrl({
        explicit: vscode.workspace.getConfiguration('xratu').get<string>('proxyUrl'),
        vscodeHttpProxy: vscode.workspace.getConfiguration('http').get<string>('proxy'),
        env: process.env,
    });
}

/** Current no_proxy list: `xratu.noProxy` > VS Code `http.noProxy` > env. */
export function getNoProxy(): string {
    return pickNoProxy({
        explicit: vscode.workspace.getConfiguration('xratu').get<string>('noProxy'),
        vscodeHttpNoProxy: vscode.workspace.getConfiguration('http').get<string>('noProxy'),
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

/**
 * Dispatcher for the configured proxy, or undefined when none is set, the
 * scheme is unsupported, or `targetUrl` matches no_proxy. Cached by URL;
 * rebuilt (and the old agent closed) when the URL changes.
 */
export function getProxyDispatcher(targetUrl?: string): Dispatcher | undefined {
    const url = getProxyUrl();
    if (!url) {
        disposeCached();
        return undefined;
    }
    // no_proxy bypass: this target talks direct, so the caller's SSRF check
    // must run. Do NOT dispose the cached agent - other targets still use it.
    if (targetUrl) {
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

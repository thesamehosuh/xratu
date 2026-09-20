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
import { pickProxyUrl, isHttpProxy, isSocksProxy } from './proxy';

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

/** True when any proxy is configured (the SSRF guard trusts a proxy to
 *  resolve the destination, so it skips its own DNS check). */
export function isProxyConfigured(): boolean {
    return !!getProxyUrl();
}

/**
 * Dispatcher for the configured proxy, or undefined when none is set or the
 * scheme is unsupported. Cached by URL; rebuilt when the URL changes.
 */
export function getProxyDispatcher(): Dispatcher | undefined {
    const url = getProxyUrl();
    if (!url) {
        cachedUrl = null;
        cachedDispatcher = undefined;
        return undefined;
    }
    if (isSocksProxy(url)) {
        warnUnsupported('SOCKS proxies are not supported yet - set an HTTP proxy instead');
        return undefined;
    }
    if (!isHttpProxy(url)) {
        warnUnsupported(`Unsupported proxy scheme: ${url}`);
        return undefined;
    }
    if (url !== cachedUrl) {
        try {
            cachedDispatcher = new ProxyAgent(url);
            cachedUrl = url;
        } catch {
            warnUnsupported(`Invalid proxy URL: ${url}`);
            cachedUrl = null;
            cachedDispatcher = undefined;
            return undefined;
        }
    }
    return cachedDispatcher;
}

function warnUnsupported(message: string): void {
    if (warnedUnsupported) return;
    warnedUnsupported = true;
    console.warn(`[xratu] ${message}`);
}

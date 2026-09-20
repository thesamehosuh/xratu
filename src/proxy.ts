/**
 * Proxy URL resolution shared by the agent runtime and the web tools.
 *
 * Pure and dependency-free so it can be unit-tested without VS Code; the
 * VS Code / undici glue lives in `proxyDispatcher.ts`.
 */

export interface ProxySources {
    /** `xratu.proxyUrl` setting - highest priority. */
    explicit?: string | null;
    /** VS Code's `http.proxy` setting. */
    vscodeHttpProxy?: string | null;
    /** Process environment (upper/lower case accepted). */
    env?: Record<string, string | undefined>;
}

const ENV_KEYS = [
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
];

/** Resolve the proxy URL to use, or null when none is configured. */
export function pickProxyUrl(sources: ProxySources): string | null {
    const explicit = (sources.explicit ?? '').trim();
    if (explicit) return explicit;

    const http = (sources.vscodeHttpProxy ?? '').trim();
    if (http) return http;

    const env = sources.env ?? {};
    for (const key of ENV_KEYS) {
        const value = (env[key] ?? '').trim();
        if (value) return value;
    }
    return null;
}

/** True for socks://, socks4://, socks4a://, socks5://, socks5h://. */
export function isSocksProxy(url: string): boolean {
    return /^socks(4|4a|5|5h)?:\/\//i.test(url.trim());
}

/** True for http:// and https:// proxies. */
export function isHttpProxy(url: string): boolean {
    return /^https?:\/\//i.test(url.trim());
}

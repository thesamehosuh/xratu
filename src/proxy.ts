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

export interface NoProxySources {
    /** `xratu.noProxy` setting - highest priority. */
    explicit?: string | null;
    /** VS Code's `http.noProxy` setting. */
    vscodeHttpNoProxy?: string | null;
    /** Process environment (upper/lower case accepted). */
    env?: Record<string, string | undefined>;
}

const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

/** Resolve the no_proxy list (comma separated), or '' when none is set. */
export function pickNoProxy(sources: NoProxySources): string {
    const explicit = (sources.explicit ?? '').trim();
    if (explicit) return explicit;

    const vscode = (sources.vscodeHttpNoProxy ?? '').trim();
    if (vscode) return vscode;

    const env = sources.env ?? {};
    for (const key of NO_PROXY_ENV_KEYS) {
        const value = (env[key] ?? '').trim();
        if (value) return value;
    }
    return '';
}

/** Split a no_proxy list into lowercase patterns. */
export function parseNoProxy(value: string): string[] {
    return value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Host (hostname[:port]) from a URL, or null when unparseable. */
export function hostFromUrl(url: string): string | null {
    const raw = url.trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        return new URL(withScheme).host.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * True when `host` matches any no_proxy pattern. Supports `*`, exact hosts,
 * bare or dot-prefixed domain suffixes, and `host:port` entries. CIDR ranges
 * are not supported (documented limitation).
 */
export function hostMatchesNoProxy(host: string, patterns: string[]): boolean {
    const h = host.trim().toLowerCase();
    if (!h) return false;
    const [hname, hport] = splitHostPort(h);

    for (const raw of patterns) {
        if (!raw) continue;
        if (raw === '*') return true;
        const pattern = raw.startsWith('*') ? raw.slice(1) : raw;
        const [pname, pport] = splitHostPort(pattern);
        if (pport && hport && pport !== hport) continue;
        if (!pname) continue;
        const bare = pname.startsWith('.') ? pname.slice(1) : pname;
        if (hname === bare || hname.endsWith(`.${bare}`)) return true;
    }
    return false;
}

function splitHostPort(value: string): [string, string | null] {
    const idx = value.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(value.slice(idx + 1))) {
        return [value.slice(0, idx), value.slice(idx + 1)];
    }
    return [value, null];
}

/** True for socks://, socks4://, socks4a://, socks5://, socks5h://. */
export function isSocksProxy(url: string): boolean {
    return /^socks(4|4a|5|5h)?:\/\//i.test(url.trim());
}

/** True for http:// and https:// proxies. */
export function isHttpProxy(url: string): boolean {
    return /^https?:\/\//i.test(url.trim());
}

/**
 * Strip embedded credentials from a proxy URL before it reaches a log.
 * Returns a safe placeholder for anything unparseable.
 */
export function redactProxyUrl(url: string): string {
    try {
        const parsed = new URL(url.trim());
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return 'invalid URL';
    }
}

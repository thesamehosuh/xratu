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
    /** OS/system proxy (Clash "System Proxy" mode, WinINET, scutil). Node's
     *  fetch never reads these on its own - lowest priority, because an
     *  explicit setting or env var is a deliberate override. */
    systemProxy?: string | null;
}

const ENV_KEYS = [
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
];

/** User-facing proxy mode. `custom` = the explicit URL only (never env or
 *  system), `off` = never proxy (even when the OS has one). */
export type ProxyMode = 'auto' | 'custom' | 'off';

/** Which resolution layer produced the URL - shown on the Proxy page so the
 *  user can see WHY their traffic routes the way it does. */
export type ProxySourceKind = 'setting' | 'vscode' | 'env' | 'system' | 'none';

/** Per-consumer routing policy (the per-MCP-server `proxy` field):
 *  `'direct'` bypasses the proxy, `'proxy'` forces it even past no_proxy,
 *  `'auto'` follows the global chain. Absent = auto. */
export type ProxyRouteMode = 'auto' | 'proxy' | 'direct';

/** Normalize a hand-edited mcp.json `proxy` value. Unknown/typo'd values
 *  fall back to undefined (= auto) instead of failing the whole entry. */
export function normalizeProxyRoute(value: unknown): ProxyRouteMode | undefined {
    return value === 'auto' || value === 'proxy' || value === 'direct' ? value : undefined;
}

export interface ResolvedProxy {
    url: string | null;
    source: ProxySourceKind;
}

/** Resolve the proxy with mode + provenance. Pure counterpart of
 *  `getProxyUrl()` (the VS Code glue) so tests pin the exact chain. */
export function resolveProxyUrl(sources: ProxySources & { mode?: ProxyMode | null }): ResolvedProxy {
    const mode = sources.mode ?? 'auto';
    if (mode === 'off') return { url: null, source: 'none' };
    const explicit = (sources.explicit ?? '').trim();
    if (mode === 'custom') {
        return explicit ? { url: explicit, source: 'setting' } : { url: null, source: 'none' };
    }
    if (explicit) return { url: explicit, source: 'setting' };

    const http = (sources.vscodeHttpProxy ?? '').trim();
    if (http) return { url: http, source: 'vscode' };

    const env = sources.env ?? {};
    for (const key of ENV_KEYS) {
        const value = (env[key] ?? '').trim();
        if (value) return { url: value, source: 'env' };
    }

    const system = (sources.systemProxy ?? '').trim();
    if (system) return { url: system, source: 'system' };
    return { url: null, source: 'none' };
}

/** Resolve the proxy URL to use, or null when none is configured. */
export function pickProxyUrl(sources: ProxySources): string | null {
    return resolveProxyUrl(sources).url;
}

export interface NoProxySources {
    /** `xratu.noProxy` setting - highest priority. */
    explicit?: string | null;
    /** VS Code's `http.noProxy` setting. NOTE: VS Code defines this as a
     *  LIST of hosts, so it can arrive as string[]. */
    vscodeHttpNoProxy?: string | string[] | null;
    /** Process environment (upper/lower case accepted). */
    env?: Record<string, string | undefined>;
}

/** Normalize a no_proxy source (string, list, or unset) to a comma list. */
function normalizeNoProxyValue(value: string | string[] | null | undefined): string {
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(',');
    return (value ?? '').trim();
}

const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

/** Resolve the no_proxy list (comma separated), or '' when none is set. */
export function pickNoProxy(sources: NoProxySources): string {
    const explicit = normalizeNoProxyValue(sources.explicit);
    if (explicit) return explicit;

    const vscode = normalizeNoProxyValue(sources.vscodeHttpNoProxy);
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
        // A port-scoped pattern matches ONLY a target with that explicit port;
        // otherwise `internal.corp:443` would bypass `http://internal.corp`.
        if (pport && hport !== pport) continue;
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

/** Add http:// to a bare host:port; keep explicit schemes (incl. socks*). */
function withDefaultScheme(value: string, fallbackScheme = 'http'): string {
    const v = value.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `${fallbackScheme}://${v}`;
}

/**
 * Parse a WinINET `ProxyServer` registry value (Clash/v2rayN "System Proxy"
 * writes exactly this). Two forms: bare `host:port`, or the per-scheme
 * `http=host:port;https=host:port;socks=host:port` list. Per-scheme entries
 * are preference-ordered https > http > socks (WinINET's `https=` names the
 * proxy used for https TARGETS - the proxy itself is plain HTTP).
 */
export function parseWindowsProxyServer(value: string): string | null {
    const raw = (value ?? '').trim();
    if (!raw) return null;
    if (!raw.includes('=')) return withDefaultScheme(raw);
    const entries = new Map<string, string>();
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        entries.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }
    const https = entries.get('https');
    if (https) return withDefaultScheme(https);
    const http = entries.get('http');
    if (http) return withDefaultScheme(http);
    const socks = entries.get('socks');
    // Scheme kept as socks* so the dispatcher layer reports the real
    // limitation instead of silently talking HTTP CONNECT to a SOCKS port.
    return socks ? withDefaultScheme(socks, 'socks5') : null;
}

/**
 * Parse `scutil --proxy` output (macOS system proxy). Prefers HTTPS then
 * HTTP; a SOCKS-only setup surfaces as a socks5 URL (unsupported, but named).
 */
export function parseScutilProxy(output: string): string | null {
    const fields = new Map<string, string>();
    for (const line of (output ?? '').split('\n')) {
        const match = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (match) fields.set(match[1].toLowerCase(), match[2]);
    }
    const enabled = (key: string) => fields.get(key) === '1';
    const pair = (proto: 'https' | 'http' | 'socks'): string | null => {
        const host = fields.get(`${proto}proxy`);
        const port = fields.get(`${proto}port`);
        if (!host || !port) return null;
        return withDefaultScheme(`${host}:${port}`, proto === 'socks' ? 'socks5' : 'http');
    };
    if (enabled('httpsenable')) {
        const url = pair('https');
        if (url) return url;
    }
    if (enabled('httpenable')) {
        const url = pair('http');
        if (url) return url;
    }
    if (enabled('socksenable')) return pair('socks');
    return null;
}

/**
 * Parse GNOME gsettings values for the system proxy: the `mode` string and
 * the https (preferred) or http host/port. Only `manual` mode is actionable.
 */
export function parseGsettingsProxy(mode: string, host: string, port: string): string | null {
    const clean = (value: string) => (value ?? '').trim().replace(/^'|'$/g, '');
    if (clean(mode) !== 'manual') return null;
    const h = clean(host);
    const p = clean(port);
    if (!h || !/^\d+$/.test(p)) return null;
    return withDefaultScheme(`${h}:${p}`);
}

/**
 * Extension-host web tools for the LOCAL agent runtime.
 *
 * Cloud mode never touches this file: the backend implements web_search /
 * fetch_url server-side (src/web_tools.py). These are mirror implementations
 * so local mode gets the same tools without a backend round-trip. Behavior,
 * limits, and error strings intentionally match the backend.
 */
import * as vscode from 'vscode';
import * as dns from 'dns';
import { isIPv4 } from 'net';

const TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 8000;
const MAX_FETCH_BYTES = 2000000;
const MAX_REDIRECTS = 4;

export interface WebToolConfig {
    provider: 'auto' | 'searxng' | 'brave' | 'parallel';
    searchUrl: string;
    searchApiKey: string;
}

/** Read the web-search provider settings (xratu.webSearch*). */
export function getWebToolConfig(): WebToolConfig {
    const cfg = vscode.workspace.getConfiguration('xratu');
    const provider = cfg.get<string>('webSearchProvider', 'auto');
    return {
        provider: provider === 'searxng' || provider === 'brave' || provider === 'parallel' ? provider : 'auto',
        searchUrl: (cfg.get<string>('webSearchUrl') ?? '').trim(),
        searchApiKey: (cfg.get<string>('webSearchApiKey') ?? '').trim(),
    };
}

/** A proxy is configured (VS Code http.proxy or env) - the proxy resolves the
 *  destination, so local SSRF IP validation is skipped to avoid false
 *  positives on private/proxy-tunnel addresses (mirrors the backend). */
function proxyConfigured(): boolean {
    const httpProxy = (vscode.workspace.getConfiguration('http').get<string>('proxy') ?? '').trim();
    return !!httpProxy || !!process.env.HTTPS_PROXY || !!process.env.https_proxy || !!process.env.HTTP_PROXY || !!process.env.http_proxy;
}

/**
 * Expand an IPv6 address to its 8 16-bit groups. Handles `::` compression and
 * embedded dotted-quad tails (`::ffff:127.0.0.1`), which dns.lookup can return
 * verbatim for IPv4-mapped literals. Returns null for anything unparseable.
 */
function expandIpv6(addr: string): number[] | null {
    let s = addr.toLowerCase();
    const embedded = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (embedded) {
        const o = embedded[2].split('.').map(Number);
        if (o.length !== 4 || o.some((p) => p > 255)) return null;
        s = embedded[1] + (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
    }
    const dbl = s.split('::');
    if (dbl.length > 2) return null;
    const head = dbl[0] ? dbl[0].split(':') : [];
    const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
    const groups: string[] = dbl.length === 2
        ? [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail]
        : head;
    if (dbl.length === 2 && groups.length !== 8) return null;
    if (dbl.length === 1 && groups.length !== 8) return null;
    const nums: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        nums.push(parseInt(g, 16));
    }
    return nums;
}

function embeddedIpv4(groups: number[]): string | null {
    // IPv4-mapped ::ffff:0:0/96, deprecated IPv4-compatible ::/96, and
    // NAT64 64:ff9b::/96 all place a real IPv4 address in the low 32 bits -
    // the address must be judged by the IPv4 rules, not the prefix text.
    const zeroTo4 = groups.slice(0, 5).every((g) => g === 0);
    const mappedOrCompat = zeroTo4 && (groups[5] === 0xffff || groups[5] === 0);
    const nat64 = groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0);
    if (!mappedOrCompat && !nat64) return null;
    const [h, l] = [groups[6], groups[7]];
    return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
}

/**
 * 198.18.0.0/15 (RFC 2544 benchmark range) is DELIBERATELY not forbidden,
 * unlike the backend's copy of this guard. It is not routable on the public
 * internet; its only real-world appearance is fake-IP DNS from proxy-tunnel
 * clients (Clash Verge, sing-box TUN mode) - common on the censored networks
 * this product targets. There the fetch is transparently intercepted by the
 * tunnel and succeeds; refusing it (the backend's behavior unless PROXY_URL
 * is set) breaks every major site in local mode. Cloud mode is unchanged.
 */
function isForbiddenAddress(ip: string): boolean {
    const addr = ip.includes('/') ? ip.split('/')[0] : ip;
    if (isIPv4(addr)) {
        const [a, b] = addr.split('.').map(Number);
        if (a === 198 && (b === 18 || b === 19)) return false;
        return (
            a === 10 || a === 127 || a === 0 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127) ||
            a >= 224
        );
    }
    const groups = expandIpv6(addr);
    // Unparseable input is refused - never allowed.
    if (!groups) return true;
    const g0 = groups[0];
    if ((g0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
    // :: (unspecified) and ::1 (loopback) fall out of the embedded-IPv4
    // branch as 0.0.0.0 / 0.0.0.1 - both forbidden there.
    const v4 = embeddedIpv4(groups);
    if (v4) return isForbiddenAddress(v4);
    return false;
}

async function validatePublicUrl(url: string): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(url.trim());
    } catch {
        throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http:// and https:// URLs are allowed');
    }
    if (parsed.username || parsed.password) {
        throw new Error('URLs with embedded credentials are not allowed');
    }
    if (!proxyConfigured()) {
        const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
        let infos: dns.LookupAddress[];
        try {
            infos = await dns.promises.lookup(host, { all: true });
        } catch {
            throw new Error(`Host could not be resolved: ${host}`);
        }
        if (infos.length === 0) {
            throw new Error(`Host could not be resolved: ${host}`);
        }
        for (const info of infos) {
            if (isForbiddenAddress(info.address)) {
                throw new Error(`Refusing non-public destination: ${host} (${info.address})`);
            }
        }
    }
    return parsed.toString();
}

function cleanHtml(text: string): string {
    return text
        .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => {
            try { return String.fromCodePoint(Number(code)); } catch { return ' '; }
        })
        .replace(/[\t\r ]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

function fetchWithTimeout(url: string, init: RequestInit, connectTimeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Read with a per-read idle deadline: the fetch timeout above only covers
 *  headers, so a drip-feeding server (1 byte / 30 s) would otherwise hold
 *  the tool call open indefinitely while staying under the byte cap. The
 *  abort signal keeps working across reads since the controller outlives
 *  the fetch promise. */
async function readBodyWithIdleTimeout(response: Response, controller: AbortController, idleMs: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty response body');
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
        while (true) {
            const timer = setTimeout(() => controller.abort(), idleMs);
            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
                readResult = await reader.read();
            } finally {
                clearTimeout(timer);
            }
            const { done, value } = readResult;
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            if (received > MAX_FETCH_BYTES) {
                throw new Error(`response exceeds ${MAX_FETCH_BYTES} bytes.`);
            }
        }
    } catch (e) {
        try { await reader.cancel(); } catch { /* already gone */ }
        throw e;
    }
    return concatChunks(chunks, received);
}

async function fetchUrlLocal(url: string, maxChars: number): Promise<string> {
    if (!Number.isFinite(maxChars) || maxChars < 1000 || maxChars > 120000) {
        return 'Error: max_chars must be between 1000 and 120000.';
    }
    let current: string;
    try {
        current = await validatePublicUrl(url);
    } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Controller lives for the WHOLE hop (headers + body) so the idle
        // deadline below can abort a stalled read, not just the fetch.
        const controller = new AbortController();
        try {
            let response: Response;
            try {
                const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
                try {
                    response = await fetch(current, {
                        redirect: 'manual',
                        headers: { 'User-Agent': 'Xratu/1.0' },
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timer);
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return /abort/i.test(msg) ? 'Error: request timed out.' : `Error: network error: ${msg}.`;
            }
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('location');
                if (!location) return 'Error: redirect response has no Location header.';
                try {
                    current = await validatePublicUrl(new URL(location, current).toString());
                } catch (e) {
                    return `Error: ${e instanceof Error ? e.message : String(e)}`;
                }
                continue;
            }
            if (response.status >= 400) {
                return `Error: HTTP ${response.status} fetching URL.`;
            }
            const ctype = (response.headers.get('content-type') ?? '').toLowerCase();
            if (!['text/', 'json', 'xml', 'javascript', 'css'].some((x) => ctype.includes(x))) {
                return `Error: unsupported content type: ${ctype || 'unknown'}.`;
            }
            let bytes: Uint8Array;
            try {
                bytes = await readBodyWithIdleTimeout(response, controller, TIMEOUT_MS);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return /abort/i.test(msg) ? 'Error: request timed out.' : `Error: ${msg}`;
            }
            const charset = /charset=([\w-]+)/i.exec(ctype)?.[1] ?? 'utf-8';
            let text: string;
            try {
                text = new TextDecoder(charset, { fatal: false }).decode(bytes);
            } catch {
                text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            }
            if (ctype.includes('html')) {
                text = cleanHtml(text);
            }
            if (text.length > maxChars) {
                return text.slice(0, maxChars) + `\n… [truncated at ${maxChars} characters]`;
            }
            return text;
        } finally {
            controller.abort(); // release any surviving keep-alive/streams
        }
    }
    return 'Error: too many redirects.';
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function webSearchLocal(query: string, maxResults: number, domains: string[], config: WebToolConfig): Promise<string> {
    query = query.trim();
    if (!query) return 'Error: query cannot be empty.';
    maxResults = Math.max(1, Math.min(Math.floor(maxResults) || 8, 20));
    const domainList = domains.map((d) => d.trim().toLowerCase()).filter(Boolean);

    const provider = config.provider === 'auto'
        ? (config.searchUrl ? 'searxng' : 'brave')
        : config.provider;

    if (provider === 'parallel') {
        // Mirrors the backend's parallel branch: mode "fast" keeps the
        // agent-loop latency low; domain filters ride the source policy.
        if (!config.searchApiKey) return 'Error: no web-search provider is configured.';
        const advanced: Record<string, unknown> = { max_results: maxResults };
        if (domainList.length) {
            advanced.source_policy = { include_domains: domainList };
        }
        try {
            const resp = await fetchWithTimeout(
                'https://api.parallel.ai/v1/search',
                {
                    method: 'POST',
                    headers: {
                        'x-api-key': config.searchApiKey,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        objective: query,
                        search_queries: [query],
                        mode: 'fast',
                        advanced_settings: advanced,
                    }),
                },
                TIMEOUT_MS,
            );
            if (resp.status === 401) return 'Error: Parallel Search API key is invalid (HTTP 401).';
            if (resp.status === 403) return 'Error: Parallel Search API access denied (HTTP 403).';
            if (resp.status === 429) return 'Error: Parallel Search API rate limit reached (HTTP 429).';
            if (resp.status >= 400) return `Error: Parallel Search API returned HTTP ${resp.status}.`;
            const data = await resp.json() as { results?: Array<{ title?: string; url?: string; excerpts?: string[] }> };
            const rows = (data.results ?? []).slice(0, maxResults).map(
                (item, i) => `${i + 1}. ${item.title ?? ''}\n   ${item.url ?? ''}\n   ${(item.excerpts ?? [])[0] ?? ''}`,
            );
            return rows.join('\n') || 'No results found.';
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return /abort/i.test(msg) ? 'Error: web search request timed out.' : `Error: web search network error: ${msg}.`;
        }
    }

    if (provider === 'brave') {
        if (!config.searchApiKey) return 'Error: no web-search provider is configured.';
        let q = query;
        if (domainList.length) q += ' ' + domainList.map((d) => `site:${d}`).join(' ');
        try {
            const resp = await fetchWithTimeout(
                'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + `&count=${maxResults}`,
                { headers: { 'X-Subscription-Token': config.searchApiKey, 'Accept': 'application/json' } },
                TIMEOUT_MS,
            );
            if (resp.status === 401) return 'Error: Brave Search API key is invalid (HTTP 401).';
            if (resp.status === 403) return 'Error: Brave Search API access denied (HTTP 403).';
            if (resp.status === 429) return 'Error: Brave Search API rate limit reached (HTTP 429).';
            if (resp.status >= 400) return `Error: Brave Search API returned HTTP ${resp.status}.`;
            const data = await resp.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
            const rows = (data.web?.results ?? []).slice(0, maxResults).map(
                (item, i) => `${i + 1}. ${item.title ?? ''}\n   ${item.url ?? ''}\n   ${item.description ?? ''}`,
            );
            return rows.join('\n') || 'No results found.';
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return /abort/i.test(msg) ? 'Error: web search request timed out.' : `Error: web search network error: ${msg}.`;
        }
    }

    if (!config.searchUrl) return 'Error: no web-search provider is configured.';
    const endpoint = config.searchUrl.replace(/\/+$/, '') + '/search';
    const params = new URLSearchParams({ q: query, format: 'json', categories: 'general,it,science,news' });
    if (domainList.length) {
        params.set('q', query + ' ' + domainList.map((d) => `site:${d}`).join(' '));
    }
    try {
        const resp = await fetchWithTimeout(
            `${endpoint}?${params.toString()}`,
            { headers: { 'User-Agent': 'Xratu/1.0' } },
            TIMEOUT_MS,
        );
        if (resp.status === 403) return 'Error: search endpoint returned HTTP 403. JSON output format may be disabled in SearXNG.';
        if (resp.status >= 400) return `Error: search endpoint returned HTTP ${resp.status}.`;
        const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string; snippet?: string }> };
        const rows = (data.results ?? []).slice(0, maxResults).map(
            (item, i) => `${i + 1}. ${item.title ?? ''}\n   ${item.url ?? ''}\n   ${item.content || item.snippet || ''}`,
        );
        return rows.join('\n') || 'No results found.';
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return /abort/i.test(msg) ? 'Error: web search request timed out.' : `Error: web search network error: ${msg}.`;
    }
}

/** Execute one local web tool. Returns the same { output, isError } shape as
 *  the workspace tool executor. Errors are returned as strings (never
 *  thrown) so the model can read them - same contract as the backend. */
export async function executeWebTool(
    name: string,
    args: Record<string, unknown>,
    config: WebToolConfig = getWebToolConfig(),
): Promise<{ output: string; isError?: boolean }> {
    try {
        if (name === 'web_search') {
            const query = String(args.query ?? '');
            const maxResults = Number(args.max_results ?? 8);
            const domains = Array.isArray(args.domains) ? args.domains.map(String) : [];
            return { output: await webSearchLocal(query, maxResults, domains, config) };
        }
        if (name === 'fetch_url') {
            const url = String(args.url ?? '');
            const maxChars = Number(args.max_chars ?? 30000);
            return { output: await fetchUrlLocal(url, maxChars) };
        }
        return { output: `Unknown tool: ${name}`, isError: true };
    } catch (e) {
        return { output: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
}

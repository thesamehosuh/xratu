/**
 * Live MCP marketplace - host glue: settings, network, disk cache.
 *
 * Parsing lives in `mcpMarketplace.ts` (pure, unit-tested); this file only
 * orchestrates: read the configured catalog URLs, fetch them (through the
 * user's proxy when one is set, so a filtered network still reaches the
 * catalog), cache the result on disk, and merge it with the vendored curated
 * list so the marketplace keeps working offline.
 *
 * The webview can never fetch anything itself (`connect-src 'none'`), which is
 * deliberate - every byte comes through here, where the proxy, the timeouts
 * and the size caps live.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getProxyDispatcher } from './proxyDispatcher';
import {
    CLINE_CATALOG_URL,
    MARKETPLACE_CACHE_VERSION,
    OFFICIAL_REGISTRY_URL,
    curatedMarketplaceEntries,
    detectInstallFromReadme,
    detectPayloadShape,
    mergeMarketplaceEntries,
    parseCatalogTagLabels,
    parseMarketplacePayload,
    searchMarketplaceEntries,
    type MarketplaceCacheFile,
    type MarketplaceEntry,
} from './mcpMarketplace';

/** How long a cached catalog is considered fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 8_000;
/** Refuse oversized catalogs instead of buffering them. */
const MAX_BYTES = 4_000_000;
/** Pages followed per registry source (100 entries each). */
const MAX_PAGES = 4;
const MAX_ENTRIES_PER_SOURCE = 400;
/** Session cache for live search responses. */
const SEARCH_CACHE_LIMIT = 40;

export interface MarketplaceState {
    /** Curated + remote entries, deduped. */
    entries: MarketplaceEntry[];
    /** Catalog-published tag labels (id → human label) - the UI localizes the
     *  ids it knows and falls back to these for anything new. */
    tagLabels: Record<string, string>;
    /** Configured catalog URLs (for the status line). */
    sources: string[];
    /** `live` = just fetched, `cached` = from disk, `offline` = fetch failed. */
    status: 'live' | 'cached' | 'offline';
    /** Epoch ms of the last successful fetch, or null. */
    fetchedAt: number | null;
    /** Short technical reason when the last fetch failed (never a raw dump). */
    error: string | null;
    /** True when this response included a server-side search. */
    liveSearch: boolean;
}

/** Catalog URLs from settings; falls back to the two shipped sources. */
export function getMarketplaceSources(): string[] {
    const configured = vscode.workspace.getConfiguration('xratu').get<string[]>('mcpMarketplaceSources');
    const raw = Array.isArray(configured) ? configured : [CLINE_CATALOG_URL, OFFICIAL_REGISTRY_URL];
    const out: string[] = [];
    for (const value of raw) {
        const url = String(value ?? '').trim();
        if (!url) continue;
        // Only http(s) catalogs - never file:/data: from a settings entry.
        if (!/^https?:\/\//i.test(url)) continue;
        if (!out.includes(url)) out.push(url);
    }
    return out;
}

function shortenError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const trimmed = message.replace(/\s+/g, ' ').trim();
    return trimmed.length > 120 ? trimmed.slice(0, 119) + '\u2026' : trimmed || 'unknown error';
}

function withParams(sourceUrl: string, params: Record<string, string>): string {
    try {
        const url = new URL(sourceUrl);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
    } catch {
        return sourceUrl;
    }
}

/** One JSON GET: proxied, timed out, size-capped, never throwing. */
async function fetchJson(url: string, timeoutMs: number): Promise<{ payload: unknown; error: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const init: RequestInit & { dispatcher?: unknown } = {
            headers: { Accept: 'application/json', 'User-Agent': 'Xratu' },
            signal: controller.signal,
        };
        // Node's global fetch is undici-backed and honors `dispatcher`, so a
        // configured proxy routes the catalog request too.
        const dispatcher = getProxyDispatcher(url);
        if (dispatcher) init.dispatcher = dispatcher;
        const response = await fetch(url, init as RequestInit);
        if (!response.ok) return { payload: null, error: `HTTP ${response.status}` };
        const text = await response.text();
        if (text.length > MAX_BYTES) return { payload: null, error: 'catalog too large' };
        return { payload: JSON.parse(text), error: null };
    } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        return { payload: null, error: aborted ? 'timed out' : shortenError(err) };
    } finally {
        clearTimeout(timer);
    }
}

function nextCursorOf(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const metadata = (payload as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') return null;
    const cursor = (metadata as { nextCursor?: unknown }).nextCursor;
    return typeof cursor === 'string' && cursor ? cursor : null;
}

/** Fetch one catalog, following registry pagination when present. */
async function fetchSourceEntries(
    sourceUrl: string,
): Promise<{ entries: MarketplaceEntry[]; tagLabels: Record<string, string>; error: string | null }> {
    const first = await fetchJson(withParams(sourceUrl, { limit: '100' }), FETCH_TIMEOUT_MS);
    if (first.error) return { entries: [], tagLabels: {}, error: first.error };
    const entries = parseMarketplacePayload(first.payload);
    const tagLabels = parseCatalogTagLabels(first.payload);
    if (detectPayloadShape(first.payload) !== 'official') return { entries, tagLabels, error: null };

    const out = [...entries];
    let cursor = nextCursorOf(first.payload);
    for (let page = 1; page < MAX_PAGES && cursor && out.length < MAX_ENTRIES_PER_SOURCE; page++) {
        const next = await fetchJson(withParams(sourceUrl, { limit: '100', cursor }), FETCH_TIMEOUT_MS);
        if (next.error) break;
        out.push(...parseMarketplacePayload(next.payload));
        cursor = nextCursorOf(next.payload);
    }
    return { entries: out.slice(0, MAX_ENTRIES_PER_SOURCE), tagLabels, error: null };
}

/** Server-side search for registries that support it (the official one does).
 *  Cline's static catalog has no query API - local filtering covers it. */
async function searchSourceEntries(sourceUrl: string, query: string): Promise<MarketplaceEntry[]> {
    const url = withParams(sourceUrl, { search: query, limit: '50' });
    const { payload, error } = await fetchJson(url, SEARCH_TIMEOUT_MS);
    if (error) return [];
    return parseMarketplacePayload(payload);
}

export class McpMarketplaceStore {
    private searchCache = new Map<string, MarketplaceEntry[]>();
    /** Last loaded catalog, keyed by entry id - lets the README detection
     *  path look an entry up by id instead of trusting a webview-supplied URL. */
    private loaded = new Map<string, MarketplaceEntry>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    /** An entry from the most recent load, or null. */
    findEntry(id: string): MarketplaceEntry | null {
        return this.loaded.get(id) ?? null;
    }

    get cachePath(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'mcp-marketplace.json');
    }

    private readCache(): MarketplaceCacheFile | null {
        try {
            if (!fs.existsSync(this.cachePath)) return null;
            const text = fs.readFileSync(this.cachePath, 'utf-8').replace(/^\uFEFF/, '');
            const parsed = JSON.parse(text) as MarketplaceCacheFile;
            if (!parsed || typeof parsed !== 'object') return null;
            if (parsed.version !== MARKETPLACE_CACHE_VERSION) return null;
            if (!Array.isArray(parsed.entries)) return null;
            return parsed;
        } catch (err) {
            console.error('xratu: failed to read the MCP marketplace cache', err);
            return null;
        }
    }

    private async writeCache(file: MarketplaceCacheFile): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
            await fs.promises.writeFile(this.cachePath, JSON.stringify(file), 'utf-8');
        } catch (err) {
            // A cache write failure must never break the marketplace.
            console.error('xratu: failed to write the MCP marketplace cache', err);
        }
    }

    /** Curated entries are always merged in, so an offline or empty catalog
     *  still leaves a usable marketplace. */
    private withCurated(remote: MarketplaceEntry[]): MarketplaceEntry[] {
        return mergeMarketplaceEntries([curatedMarketplaceEntries(), remote]);
    }

    /**
     * Load the marketplace. `query` additionally runs a server-side search
     * (debounced by the caller) and `force` bypasses the cache TTL.
     */
    async load(options: { query?: string; force?: boolean } = {}): Promise<MarketplaceState> {
        const sources = getMarketplaceSources();
        const query = (options.query ?? '').trim();
        const cached = this.readCache();
        const sameSources = !!cached && JSON.stringify(cached.sources) === JSON.stringify(sources);
        const fresh = sameSources && cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

        let status: MarketplaceState['status'] = 'cached';
        let error: string | null = null;
        let fetchedAt = cached?.fetchedAt ?? null;
        let remote: MarketplaceEntry[] = fresh && cached ? cached.entries : [];
        let tagLabels: Record<string, string> = cached?.tagLabels ?? {};

        if (!fresh || options.force) {
            const results = await Promise.all(sources.map(async (source) => ({
                source,
                ...(await fetchSourceEntries(source)),
            })));
            const ok = results.filter((r) => !r.error);
            if (ok.length) {
                remote = ok.flatMap((r) => r.entries);
                // Earlier sources win a label collision (they are listed first
                // in the setting, which is the user's priority order).
                const mergedLabels: Record<string, string> = {};
                for (const result of ok) {
                    for (const [id, label] of Object.entries(result.tagLabels)) {
                        if (!(id in mergedLabels)) mergedLabels[id] = label;
                    }
                }
                tagLabels = mergedLabels;
                fetchedAt = Date.now();
                status = 'live';
                await this.writeCache({
                    version: MARKETPLACE_CACHE_VERSION,
                    fetchedAt,
                    sources,
                    entries: remote,
                    tagLabels,
                });
                // A partial failure is worth surfacing, but the catalog works.
                const failed = results.filter((r) => r.error);
                error = failed.length ? `${failed[0].source}: ${failed[0].error}` : null;
            } else {
                remote = cached?.entries ?? [];
                status = 'offline';
                error = results.length
                    ? `${results[0].source}: ${results[0].error}`
                    : 'no catalog configured';
            }
        }

        let entries = this.withCurated(remote);
        this.loaded = new Map(entries.map((entry) => [entry.id, entry]));
        let liveSearch = false;

        if (query) {
            // Local filter first: instant, works offline, covers every source.
            entries = searchMarketplaceEntries(entries, query);
            const searchable = sources.filter((source) => /modelcontextprotocol\.io/i.test(source));
            if (searchable.length) {
                const live = await this.liveSearch(searchable[0], query);
                if (live.length) {
                    liveSearch = true;
                    // Server hits first (they matched the registry's own index),
                    // then the locally-filtered rows, deduped across both.
                    entries = mergeMarketplaceEntries([live, entries]).slice(0, 200);
                }
            }
        }

        return { entries, tagLabels, sources, status, fetchedAt, error, liveSearch };
    }

    /** Live search with a small in-session cache so repeated keystrokes after
     *  a debounce do not re-hit the network. */
    private async liveSearch(sourceUrl: string, query: string): Promise<MarketplaceEntry[]> {
        const key = `${sourceUrl}\u0000${query.toLowerCase()}`;
        const hit = this.searchCache.get(key);
        if (hit) return hit;
        const entries = await searchSourceEntries(sourceUrl, query);
        if (this.searchCache.size >= SEARCH_CACHE_LIMIT) {
            const oldest = this.searchCache.keys().next().value;
            if (oldest !== undefined) this.searchCache.delete(oldest);
        }
        this.searchCache.set(key, entries);
        return entries;
    }

    /** Force-fetch a repo README and detect a runnable install command. Used
     *  only when the user asks, for entries a catalog shipped without install
     *  metadata. */
    async detectFromReadme(entry: MarketplaceEntry): Promise<MarketplaceEntry> {
        const repo = entry.repoUrl;
        if (!repo) return entry;
        const readme = await this.fetchReadme(repo);
        if (!readme) return entry;
        const install = detectInstallFromReadme(readme);
        if (!install) return entry;
        return { ...entry, install, installConfidence: 'detected' };
    }

    /** README text from a GitHub repo URL (raw.githubusercontent.com). */
    private async fetchReadme(repoUrl: string): Promise<string | null> {
        let url: URL;
        try {
            url = new URL(repoUrl);
        } catch {
            return null;
        }
        if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        const [owner, repo] = parts;
        for (const branch of ['HEAD', 'main', 'master']) {
            for (const name of ['README.md', 'readme.md']) {
                const raw = `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${branch}/${name}`;
                // A README is plain text - fetchJson would fail on it.
                const text = await fetchText(raw, SEARCH_TIMEOUT_MS);
                if (text) return text;
            }
        }
        return null;
    }
}

/** Plain-text GET (READMEs), proxied and size-capped like fetchJson. */
async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const init: RequestInit & { dispatcher?: unknown } = {
            headers: { Accept: 'text/plain', 'User-Agent': 'Xratu' },
            signal: controller.signal,
        };
        const dispatcher = getProxyDispatcher(url);
        if (dispatcher) init.dispatcher = dispatcher;
        const response = await fetch(url, init as RequestInit);
        if (!response.ok) return null;
        const text = await response.text();
        if (!text || text.length > MAX_BYTES) return null;
        return text;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Versioned display evidence. Never insert this carrier into model history. */
export type ResearchOutcome = 'success' | 'empty' | 'unavailable' | 'rate-limited' | 'authentication-required' | 'cancelled' | 'blocked' | 'unsupported' | 'timeout';
export type SearchProvider = 'parallel' | 'exa';
export interface ResearchSource {
    id: string;
    truncated?: boolean;
    warnings?: string[];
    url: string;
    requestedUrl?: string;
    title?: string;
    excerpts: string[];
    publishedAt?: string;
    retrievedAt: string;
    route: string;
}
export interface ResearchEvidence {
    version: 1;
    outcome: ResearchOutcome;
    provider: string;
    freshness: 'unknown' | 'live' | 'cached';
    sources: ResearchSource[];
    warnings: string[];
    filters?: { domains: string[]; enforced: string[]; requested: Record<string, string> };
    truncated?: boolean;
    document?: { handle: string; start: number; end: number; total: number };
    retryAfterMs?: number;
}
export interface ResearchResult { output: string; isError?: boolean; research: ResearchEvidence }
export interface WebToolConfig {
    useProxy?: boolean;
    trusted?: boolean;
}
export class ResearchError extends Error {
    constructor(readonly outcome: ResearchOutcome, message: string, readonly retryAfterMs?: number) { super(message); }
}
export function publicLink(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 4096) return undefined;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
        return url.href;
    } catch { return undefined; }
}

/** Accept only the display contract, with independent bounds at restore/wire boundaries. */
export function readResearchEvidence(value: unknown): ResearchEvidence | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as ResearchEvidence;
    const outcomes: ResearchOutcome[] = ['success', 'empty', 'unavailable', 'rate-limited', 'authentication-required', 'cancelled', 'blocked', 'unsupported', 'timeout'];
    if (raw.version !== 1 || !outcomes.includes(raw.outcome) || typeof raw.provider !== 'string') return undefined;
    const clip = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';
    return { version: 1, outcome: raw.outcome, provider: raw.provider.slice(0, 80), freshness: ['live', 'cached'].includes(raw.freshness) ? raw.freshness : 'unknown',
        sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 20).flatMap(item => {
            if (!item || typeof item !== 'object') return [];
            const url = publicLink(item.url);
            if (!url) return [];
            return [{ id: clip(item.id, 64), url, truncated: !!item.truncated, title: clip(item.title, 500), requestedUrl: publicLink(item.requestedUrl),
                excerpts: Array.isArray(item.excerpts) ? item.excerpts.slice(0, 2).map(text => clip(text, 1200)) : [],
                publishedAt: clip(item.publishedAt, 100) || undefined, retrievedAt: clip(item.retrievedAt, 100), route: clip(item.route, 80) }];
        }) : [], warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 8).map(text => clip(text, 300)) : [], truncated: !!raw.truncated,
        ...(raw.filters && Array.isArray(raw.filters.domains) ? { filters: { domains: raw.filters.domains.slice(0, 20).map(text => clip(text, 253)), enforced: Array.isArray(raw.filters.enforced) ? raw.filters.enforced.slice(0, 8).map(text => clip(text, 40)) : [], requested: raw.filters.requested && typeof raw.filters.requested === 'object' ? Object.fromEntries(Object.entries(raw.filters.requested).slice(0, 8).map(([key, value]) => [key.slice(0, 40), clip(value, 100)])) : {} } } : {}),
        ...(Number.isFinite(raw.retryAfterMs) ? { retryAfterMs: Math.min(3_600_000, Math.max(0, raw.retryAfterMs!)) } : {}),
    };
}

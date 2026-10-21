import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'crypto';
import { abortable } from '../oauth/refreshLock';
import { mcpFetch } from './transport';
import { ResearchError, publicLink, type ResearchSource, type SearchProvider, type WebToolConfig } from './types';

export interface SearchRequest { query: string; objective: string; maxResults: number; domains: string[]; hints: Record<string, string> }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
export function normalizeDomains(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw new ResearchError('blocked', 'domains must contain at most 20 hostnames.');
    return [...new Set(value.map(item => {
        if (typeof item !== 'string' || !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}$/i.test(item.trim())) throw new ResearchError('blocked', 'Each domain must be a plain public hostname, without a URL, path, or search operators.');
        return item.trim().toLowerCase();
    }))];
}
export function matchesDomains(url: string, domains: string[]): boolean {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return !domains.length || domains.some(domain => host === domain || host.endsWith('.' + domain));
}
export function source(urlValue: unknown, provider: string, data: Record<string, unknown> = {}): ResearchSource | undefined {
    const url = publicLink(urlValue);
    if (!url) return undefined;
    const excerpts = Array.isArray(data.excerpts) ? data.excerpts : [data.text ?? data.description ?? data.content ?? data.snippet];
    const date = string(data.publish_date ?? data.publishedDate ?? data.page_age ?? data.published_at, 100);
    return { id: createHash('sha256').update(url).digest('hex').slice(0, 16), url,
        ...(string(data.title, 500) ? { title: string(data.title, 500) } : {}),
        truncated: excerpts.length > 4 || excerpts.some(value => typeof value === 'string' && value.length > 2400),
        excerpts: excerpts.filter(x => typeof x === 'string').slice(0, 4).map(x => string(x, 2400)),
        ...(date ? { publishedAt: date } : {}), retrievedAt: new Date().toISOString(), route: provider };
}
export function extractSources(value: unknown, provider: string): ResearchSource[] {
    const root = record(value);
    const nested = record(root.result ?? root.data);
    const list = Array.isArray(root.results) ? root.results : Array.isArray(nested.results) ? nested.results : undefined;
    const errors = Array.isArray(root.errors) ? root.errors : Array.isArray(nested.errors) ? nested.errors : [];
    const explicitError = root.error ?? nested.error;
    if (explicitError || errors.length && !list?.length) {
        const detail = JSON.stringify(explicitError ?? errors).slice(0, 4000);
        const outcome = /429|rate.?limit|quota/i.test(detail) ? 'rate-limited' : /401|402|403|unauthoriz|forbidden/i.test(detail) ? 'authentication-required' : 'unavailable';
        throw new ResearchError(outcome, 'Research provider returned an error inside its response.', outcome === 'rate-limited' ? 30_000 : undefined);
    }
    if (!list) throw new ResearchError('unavailable', 'Research response does not contain a supported results envelope.');
    const sources = list.slice(0, 100).flatMap(item => {
        const data = record(item);
        const result = source(data.url, provider, data);
        return result ? [result] : [];
    });
    if (errors.length && sources.length) sources[0].warnings = ['Research provider returned partial results with extraction errors.'];
    return sources;
}
/** Exa currently returns a documented text envelope rather than structuredContent. */
export function parseExaText(text: string): ResearchSource[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { /* Supported text contract below. */ }
    if (parsed !== undefined) return extractSources(parsed, 'exa');
    if (!text.trim()) return [];
    const chunks = text.split(/(?=^Title:)/m).filter(chunk => /^Title:/m.test(chunk));
    if (!chunks.length) {
        if (/no (?:results|relevant results)/i.test(text)) return [];
        throw new ResearchError('unavailable', 'Exa returned an unsupported response format.');
    }
    return chunks.slice(0, 100).flatMap(chunk => {
        const url = /^URL:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
        const title = /^Title:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
        const publishedDate = /^Published(?: Date)?:\s*(.+)$/m.exec(chunk)?.[1]?.trim();
        const text = /^(?:Text|Content|Summary):\s*([\s\S]*)/m.exec(chunk)?.[1] ?? '';
        const result = source(url, 'exa', { title, publishedDate, text });
        return result ? [result] : [];
    });
}
export async function hostedCall(provider: 'parallel' | 'exa', name: string, args: Record<string, unknown>, signal: AbortSignal, useProxy = true): Promise<{ structured: unknown; text: string }> {
    const client = new Client({ name: 'xratu-research', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(provider === 'parallel' ? 'https://search.parallel.ai/mcp' : 'https://mcp.exa.ai/mcp'), { fetch: mcpFetch(signal, useProxy) });
    try {
        await abortable(client.connect(transport, { signal, timeout: 9000 }), signal);
        const listing = await abortable(client.listTools(undefined, { signal, timeout: 9000 }), signal);
        const tool = listing.tools.find(tool => tool.name === name);
        const schema = record(tool?.inputSchema);
        const properties = record(schema.properties);
        const required = Array.isArray(schema.required) ? schema.required : [];
        // Remote descriptions and optional controls never enter the built-in schema.
        if (!tool || required.some(key => typeof key !== 'string' || !(key in args)) || Object.keys(args).some(key => !(key in properties))) throw new ResearchError('unavailable', `${provider} research protocol changed; no compatible tool is available.`);
        const response = await abortable(client.callTool({ name, arguments: args }, undefined, { signal, timeout: 9000 }), signal);
        const text = Array.isArray(response.content) ? response.content.filter(x => record(x).type === 'text').map(x => string(record(x).text, 100_000)).join('\n').slice(0, 200_000) : '';
        if (response.isError) {
            const outcome = /429|rate.?limit|quota/i.test(text) ? 'rate-limited' : /401|402|403|unauthoriz|forbidden/i.test(text) ? 'authentication-required' : 'unavailable';
            throw new ResearchError(outcome, `${provider} research failed: ${text.slice(0, 500)}`, outcome === 'rate-limited' ? 30_000 : undefined);
        }
        return { structured: response.structuredContent, text };
    } finally { void client.close().catch(() => undefined); }
}
export async function searchProvider(provider: SearchProvider, request: SearchRequest, config: WebToolConfig, signal: AbortSignal, conversationID: string): Promise<ResearchSource[]> {
    const domainQuery = request.domains.length ? ` (${request.domains.map(domain => `site:${domain}`).join(' OR ')})` : '';
    const query = request.query + domainQuery;
    const objective = [request.objective, ...Object.entries(request.hints).map(([key, value]) => `${key}: ${value}`)].join('\n');
    const response = await hostedCall(provider, provider === 'parallel' ? 'web_search' : 'web_search_exa', provider === 'parallel'
        ? { objective, search_queries: [query], session_id: conversationID }
        : { query, objective, numResults: request.maxResults }, signal, config.useProxy !== false);
    if (response.structured) return extractSources(response.structured, provider);
    if (provider === 'exa') return parseExaText(response.text);
    let parsed: unknown;
    try { parsed = JSON.parse(response.text); }
    catch { throw new ResearchError('unavailable', 'Parallel returned an unsupported response format.'); }
    return extractSources(parsed, provider);
}

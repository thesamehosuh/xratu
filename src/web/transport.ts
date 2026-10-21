import { proxyFetch } from '../proxyFetch';
import { getProxyDispatcher } from '../proxyDispatcher';
import { abortable } from '../oauth/refreshLock';
import { ResearchError } from './types';

export const MAX_BODY_BYTES = 2_000_000;
export function routedFetch(url: string, init: RequestInit, useProxy = true): Promise<Response> {
    const dispatcher = getProxyDispatcher(url, useProxy ? 'auto' : 'direct');
    return proxyFetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) });
}
export async function boundedBody(response: Response, signal: AbortSignal, limit = MAX_BODY_BYTES): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
        while (true) {
            const idle = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
            const { done, value } = await abortable(reader.read(), idle);
            if (done) { complete = true; break; }
            total += value.byteLength;
            if (total > limit) throw new ResearchError('unsupported', `Response exceeds ${limit} bytes.`);
            chunks.push(value);
        }
    } finally { if (!complete) void reader.cancel().catch(() => undefined); }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return data;
}
export function checkStatus(response: Response): void {
    if (response.ok) return;
    void response.body?.cancel().catch(() => undefined);
    const retry = response.headers.get('retry-after');
    const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 30_000;
    if (response.status === 429) throw new ResearchError('rate-limited', 'Research quota reached (HTTP 429).', Math.max(1000, Math.min(retryMs || 30_000, 3_600_000)));
    if ([401, 402, 403].includes(response.status)) throw new ResearchError('authentication-required', `Research access requires valid credentials or account access (HTTP ${response.status}).`);
    throw new ResearchError('unavailable', `Research service returned HTTP ${response.status}.`);
}
/** Wrap each SDK HTTP exchange too: the SDK normally parses unbounded JSON/SSE. */
export function mcpFetch(signal: AbortSignal, useProxy = true): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const response = await abortable(routedFetch(url, { ...init, redirect: 'error', signal }, useProxy), signal);
        if (!response.ok) { checkStatus(response); }
        // Hosted research has no notifications/subscriptions. Bound its entire reply,
        // then let the SDK parse the supported JSON or SSE response normally.
        if (response.status === 204) return response;
        const bytes = await boundedBody(response, signal);
        const headers = new Headers(response.headers);
        headers.delete('content-encoding'); headers.delete('content-length');
        return new Response(bytes as BodyInit, { status: response.status, headers });
    }) as typeof fetch;
}

import { proxyFetch } from '../proxyFetch';
import { isLoopbackUrl, isOfflineMode } from '../networkPolicy';
import { readStreamChunk } from './transport';

export interface ModelProgress { status: string; completed?: number; total?: number }

export function ollamaManagementUrl(baseUrl: string, action: 'pull' | 'delete'): string {
    const url = new URL(baseUrl);
    if (!isLoopbackUrl(url) || url.port !== '11434' || !['', '/', '/v1', '/v1/'].includes(url.pathname) || url.search || url.hash) {
        throw new Error('Model management requires a loopback Ollama endpoint on port 11434.');
    }
    return new URL(`/api/${action}`, url.origin).href;
}

export async function manageOllamaModel(
    baseUrl: string, action: 'pull' | 'delete', model: string,
    signal: AbortSignal, onProgress: (progress: ModelProgress) => void,
): Promise<void> {
    const url = ollamaManagementUrl(baseUrl, action);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model) || model.includes('..')) throw new Error('Invalid Ollama model name.');
    if (action === 'pull' && isOfflineMode()) throw new Error('Model downloads are disabled in offline mode.');
    const version = await proxyFetch(new URL('/api/version', url), { signal, redirect: 'error' });
    if (!version.ok || typeof (await version.json() as { version?: unknown }).version !== 'string') {
        throw new Error('This endpoint is not an Ollama runtime.');
    }
    const response = await proxyFetch(url, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...(action === 'pull' ? { stream: true } : {}) }),
        signal, redirect: 'error',
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    if (action === 'delete') return;
    if (!response.body) throw new Error('Ollama returned an empty download stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let success = false;
    const consume = (line: string) => {
        if (line.length > 64_000) throw new Error('Ollama download status exceeds the size limit.');
        if (!line.trim()) return;
        const item = JSON.parse(line);
        if (item.error) throw new Error(String(item.error).slice(0, 2000));
        if (typeof item.status !== 'string') throw new Error('Invalid Ollama download status.');
        success ||= item.status === 'success';
        onProgress({ status: item.status.slice(0, 200), completed: item.completed, total: item.total });
    };
    try {
        while (true) {
            signal.throwIfAborted();
            const chunk = await readStreamChunk(reader);
            pending += decoder.decode(chunk.value, { stream: !chunk.done });
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
                consume(pending.slice(0, newline));
                pending = pending.slice(newline + 1);
            }
            if (pending.length > 64_000) throw new Error('Ollama download status exceeds the size limit.');
            if (chunk.done) break;
        }
        consume(pending);
        if (!success) throw new Error('Ollama download ended before reporting success.');
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

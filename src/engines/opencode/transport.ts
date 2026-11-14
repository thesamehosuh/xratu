import { Agent, fetch as undiciFetch } from 'undici';
import { setTimeout as delay } from 'timers/promises';

// VS Code can proxy its global fetch even for loopback. Keep SDK requests and
// SSE on the same direct transport, independent of the host/global dispatcher.
const dispatcher = new Agent();
const ACTIVATION_BACKOFF = [250, 500, 1000, 2000];
export const openCodeFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const signal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
    for (let attempt = 0; ; attempt++) {
        const response = await undiciFetch(input as never, { ...init, dispatcher, redirect: 'error' } as never) as unknown as Response;
        // OpenCode can accept connections before location plugins are ready.
        // Only retry this explicit precondition failure on safe reads. Prompts,
        // credentials, approvals and other mutations must never be replayed.
        if (!['GET', 'HEAD'].includes(method) || response.status !== 503 || attempt >= ACTIVATION_BACKOFF.length) return response;
        const body = await response.clone().text();
        if (!body.includes('Location plugins did not finish activating')) return response;
        await response.body?.cancel();
        await delay(ACTIVATION_BACKOFF[attempt], undefined, { signal: signal ?? undefined });
    }
};

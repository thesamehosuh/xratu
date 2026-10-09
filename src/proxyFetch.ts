/**
 * The ONE fetch used for anything that can carry a proxy dispatcher.
 *
 * When a dispatcher IS present the request MUST go through undici's own
 * fetch: Node's GLOBAL fetch runs on a DIFFERENT undici copy (the one built
 * into Node) and brand-checks dispatchers against its own classes - handing
 * it an npm-undici `ProxyAgent` fails EVERY request instantly with
 * "InvalidArgumentError: invalid onError method". That mismatch once took
 *  the whole extension offline as soon as a proxy was detected (pinned by
 * test/test-proxy.mjs).
 *
 * Without a dispatcher the global fetch is used as-is: it is the same
 * network stack for direct traffic, and it stays mockable by the node test
 * harnesses (which stub `globalThis.fetch`).
 */
import { fetch as undiciFetch } from 'undici';
import { isOfflineMode, networkSignal } from './networkPolicy';

export async function proxyFetch(
    input: string | URL | Request,
    init?: RequestInit & { dispatcher?: unknown },
): Promise<Response> {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    const signal = networkSignal(url, init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined));
    // Offline requests cannot follow a local endpoint's redirect off-machine.
    init = { ...init, signal, ...(isOfflineMode() ? { redirect: 'error' as const, dispatcher: undefined } : {}) };
    if (init && (init as { dispatcher?: unknown }).dispatcher) {
        return undiciFetch(input as never, init as never) as unknown as Promise<Response>;
    }
    return fetch(input, init);
}

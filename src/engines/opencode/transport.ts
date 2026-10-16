import { Agent, fetch as undiciFetch } from 'undici';

// VS Code can proxy its global fetch even for loopback. Keep SDK requests and
// SSE on the same direct transport, independent of the host/global dispatcher.
const dispatcher = new Agent();
export const openCodeFetch: typeof fetch = async (input, init) =>
    undiciFetch(input as never, { ...init, dispatcher, redirect: 'error' } as never) as unknown as Promise<Response>;

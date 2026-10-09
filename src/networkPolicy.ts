/** Offline mode governs Xratu-managed requests, not terminal subprocesses. */
let offline = false;
let onlineRequests = new AbortController();

export function isLoopbackUrl(value: string | URL): boolean {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && !url.username && !url.password
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    } catch { return false; }
}

export function isOfflineMode(): boolean { return offline; }

export function setOfflineMode(enabled: boolean): void {
    if (offline === enabled) return;
    offline = enabled;
    if (enabled) onlineRequests.abort();
    else onlineRequests = new AbortController();
}

export function networkSignal(value: string | URL, signal?: AbortSignal | null): AbortSignal | undefined {
    if (isLoopbackUrl(value)) return signal ?? undefined;
    if (offline) throw new Error('Xratu offline mode blocks remote network requests.');
    return signal ? AbortSignal.any([signal, onlineRequests.signal]) : onlineRequests.signal;
}

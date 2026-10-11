// T3 Code subscribes before prompting and tolerates unknown OpenCode 2 events.
// Keep terminal envelopes even when newer servers add fields (see notices).
export interface NativeEvent { type: string; data: Record<string, unknown> }
export async function subscribeEvents(baseUrl: string, headers: Record<string, string>, signal: AbortSignal): Promise<AsyncIterable<NativeEvent>> {
    const response = await fetch(`${baseUrl}/api/event`, { headers: { ...headers, Accept: 'text/event-stream' }, signal });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    return (async function* () {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const next = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode stopped sending events')), 45_000); }),
                ]).finally(() => clearTimeout(timer));
                signal.throwIfAborted();
                if (next.done) throw new Error('OpenCode event stream closed');
                buffer += decoder.decode(next.value, { stream: true });
                if (buffer.length > 4 * 1024 * 1024) throw new Error('OpenCode event exceeds size limit');
                let boundary: RegExpExecArray | null;
                while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                    const frame = buffer.slice(0, boundary.index);
                    buffer = buffer.slice(boundary.index + boundary[0].length);
                    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
                    if (!data) continue;
                    let event: unknown;
                    try { event = JSON.parse(data); } catch { continue; }
                    if (!event || typeof event !== 'object') continue;
                    const envelope = event as { type?: unknown; data?: unknown };
                    if (typeof envelope.type === 'string' && envelope.data && typeof envelope.data === 'object') yield envelope as NativeEvent;
                }
            }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    })();
}

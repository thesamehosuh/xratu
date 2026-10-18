// Request ownership and settlement adapted from T3 Code's v2/adapter.ts.
// Waiting for a card must never stop consumption of OpenCode's event stream.
import { abortable } from '../../oauth/refreshLock';

export class NativeDecisionSettled extends DOMException {
    constructor(readonly resolution: 'approved' | 'rejected') { super('OpenCode decision settled', 'AbortError'); }
}

export class NativeDecisions {
    private readonly pending = new Map<string, { controller: AbortController; answering: boolean; work: Promise<void> }>();
    private readonly seen = new Set<string>();
    constructor(private readonly signal: AbortSignal, private readonly fail: (error: unknown) => void) {}

    start(id: string, run: (signal: AbortSignal, answering: () => void) => Promise<void>): void {
        if (this.seen.has(id) || this.signal.aborted) return;
        // A malicious/broken runtime cannot grow the request registry forever.
        if (this.seen.size >= 4096) { this.fail(new Error('OpenCode decision limit exceeded')); return; }
        this.seen.add(id);
        const controller = new AbortController();
        const signal = AbortSignal.any([this.signal, controller.signal]);
        const entry = { controller, answering: false, work: Promise.resolve() };
        this.pending.set(id, entry);
        entry.work = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return abortable(run(signal, () => { entry.answering = true; }), signal);
        }).catch(error => {
            if (!signal.aborted) this.fail(error);
        }).finally(() => { this.pending.delete(id); });
    }

    settle(id: string, resolution: 'approved' | 'rejected' = 'rejected'): void {
        const entry = this.pending.get(id);
        // Our own reply can be announced before its HTTP response arrives.
        if (entry && !entry.answering) entry.controller.abort(new NativeDecisionSettled(resolution));
    }

    async close(): Promise<void> {
        const entries = [...this.pending.values()];
        for (const entry of entries) entry.controller.abort(new DOMException('OpenCode turn ended', 'AbortError'));
        await Promise.all(entries.map(entry => entry.work));
    }
    settleSession(sessionID: string): void {
        for (const id of this.pending.keys()) if (id.startsWith(`${sessionID}:`)) this.settle(id);
    }
}

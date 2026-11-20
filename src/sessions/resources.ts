import {SessionOwnershipError} from './ownership';
import { FileCoordinatorStore } from './store';
import { TOOL_POLICY } from '../tooling/toolPolicy';

export function mutatesWorkspace(name: string): boolean {
    if (name === 'task') return false; // Its child acquires ownership; the parent must never hold it while waiting.
    const policy = TOOL_POLICY[name];
    return !policy || policy.effect === 'write' || policy.effect === 'execute';
}

/** A checkout has one writer across sessions and windows; waiting is abortable. */
export class WorkspaceWriter {
    private tail: Promise<void> = Promise.resolve();
    constructor(private readonly ownershipFile: string) {}
    async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const previous = this.tail;
        this.tail = previous.then(() => released);
        const owner = new FileCoordinatorStore(this.ownershipFile);
        try {
            await cancelled(previous, signal);
            signal.throwIfAborted();
            for (let delay = 125; ; delay = Math.min(delay * 2, 1000)) {
                try { await owner.load(signal); break; }
                catch (error) {
                    if (!(error instanceof SessionOwnershipError)) throw error;
                    await cancelled(new Promise<void>(resolve => setTimeout(resolve, delay)), signal);
                }
            }
            signal.throwIfAborted();
            return await work();
        } finally {
            try { await owner.close(); } finally { release(); }
        }
    }
}
function cancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
        signal.addEventListener('abort', abort, {once:true});
        void work.then(value => {signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
}

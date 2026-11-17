import { randomUUID } from 'crypto';
import type { ChildSession, CoordinatorSnapshot, CoordinatorStore, SessionDriver, SessionExecution, SessionMessage, SessionResult } from './types';

const ACTIVE = new Set(['queued', 'running', 'waiting_for_workspace', 'stopping']);
const copy = <T>(value: T): T => structuredClone(value);

/** One execution authority. Command serialization never waits for a driver. */
export class SessionCoordinator {
    private sessions = new Map<string, ChildSession>();
    private commands: Promise<unknown> = Promise.resolve();
    private readonly drivers = new Map<string, SessionDriver>();
    private readonly controls = new Map<string, AbortController>();
    private readonly listeners = new Set<(sessions: ChildSession[]) => void>();
    private readonly tasks = new Set<Promise<void>>();
    private readonly waiters = new Map<string, Set<() => void>>();
    private active = 0;
    private closed = false;
    private fault: unknown;
    private constructor(private readonly store: CoordinatorStore, private capacity: number) {}

    static async open(store: CoordinatorStore, capacity = 4): Promise<SessionCoordinator> {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32) throw new Error('Invalid session capacity');
        const coordinator = new SessionCoordinator(store, capacity);
        try {
        const snapshot = await store.load();
        if (snapshot) {
            if (snapshot.version !== 1 || !Array.isArray(snapshot.sessions)) throw new Error('Unsupported session store');
            for (const session of snapshot.sessions) {
                if (!session || typeof session.id !== 'string' || !session.id || typeof session.parentId !== 'string'
                    || !Array.isArray(session.executions) || !Array.isArray(session.messages) || !Array.isArray(session.results)
                    || !Number.isSafeInteger(session.generation) || session.generation < 0 || coordinator.sessions.has(session.id)
                    || typeof session.title !== 'string' || typeof session.profile !== 'string'
                    || !session.executions.every(execution => execution && typeof execution.id === 'string' && Number.isSafeInteger(execution.generation)
                        && ['queued','running','waiting_for_workspace','stopping','completed','cancelled','failed','interrupted'].includes(execution.state) && Array.isArray(execution.messageIds))
                    || !session.messages.every(message => message && typeof message.id === 'string' && typeof message.text === 'string'
                        && ['parent','user'].includes(message.source) && ['queued','delivered','cancelled'].includes(message.state))
                    || !session.results.every(result => result && result.sessionId === session.id && typeof result.id === 'string'
                        && typeof result.text === 'string' && ['pending','delivered'].includes(result.state))) throw new Error('Invalid session store');
                const restored = copy(session);
                for (const execution of restored.executions) {
                    if (ACTIVE.has(execution.state)) {
                        execution.state = 'interrupted';
                        execution.endedAt = Date.now();
                    }
                }
                // A queued instruction from before a crash never silently runs.
                for (const message of restored.messages) if (message.state === 'queued') message.state = 'cancelled';
                coordinator.sessions.set(restored.id, restored);
            }
            await coordinator.persist();
        }
        return coordinator;
        } catch (error) {
            await store.close?.().catch(() => undefined);
            throw error;
        }
    }

    list(parentId?: string): ChildSession[] {
        return copy([...this.sessions.values()].filter(session => !parentId || session.parentId === parentId));
    }
    get unavailable(): boolean { return this.closed || !!this.fault; }
    setCapacity(value: number): void {
        if (!Number.isInteger(value) || value < 1 || value > 32) throw new Error('Invalid session capacity');
        this.capacity = value;
        this.pump();
    }
    subscribe(listener: (sessions: ChildSession[]) => void): () => void {
        this.listeners.add(listener);
        listener(this.list());
        return () => { this.listeners.delete(listener); };
    }
    bind(sessionId: string, driver: SessionDriver): void {
        this.get(sessionId);
        this.drivers.set(sessionId, driver);
    }
    private get(id: string): ChildSession {
        const session = this.sessions.get(id);
        if (!session) throw new Error('Unknown child session');
        return session;
    }
    private command<T>(action: () => Promise<T>): Promise<T> {
        const run = this.commands.then(async () => {
            if (this.closed) throw new Error('Session coordinator is closed');
            if (this.fault) throw new Error('Session storage failed; execution is fenced');
            return action();
        });
        this.commands = run.catch(() => undefined);
        return run;
    }
    private async persist(): Promise<void> {
        const snapshot: CoordinatorSnapshot = { version: 1, sessions: this.list() };
        try { await this.store.save(snapshot); }
        catch (error) {
            this.fault = error;
            for (const controller of this.controls.values()) controller.abort();
            for (const session of this.sessions.values()) for (const execution of session.executions) {
                if (ACTIVE.has(execution.state)) {
                    execution.state = 'interrupted'; execution.errorCode = 'storage_failed'; execution.endedAt = Date.now();
                }
            }
            for (const listener of this.listeners) {
                try { listener(this.list()); } catch { /* Keep the execution fence even if a view fails. */ }
            }
            for (const callbacks of this.waiters.values()) for (const callback of [...callbacks]) callback();
            throw error;
        }
        for (const listener of this.listeners) {
            try { listener(copy(snapshot.sessions)); } catch { /* A view cannot break execution ownership. */ }
        }
        for (const callbacks of this.waiters.values()) for (const callback of callbacks) callback();
    }
    async create(parentId: string, profile: string, title: string, driver: SessionDriver, creationId?: string, checkpoint?: unknown): Promise<ChildSession> {
        if (typeof parentId !== 'string' || !parentId || typeof profile !== 'string' || !profile || typeof title !== 'string' || title.length > 1000
            || creationId !== undefined && (typeof creationId !== 'string' || !creationId || creationId.length > 200)) throw new Error('Invalid child assignment');
        return this.command(async () => {
            const previous = creationId ? [...this.sessions.values()].find(session => session.parentId === parentId && session.creationId === creationId) : undefined;
            if (previous) {
                if (previous.title !== title || previous.profile !== profile) throw new Error('Creation receipt reused with a different assignment');
                return copy(previous);
            }
            const session: ChildSession = { id: randomUUID(), parentId, profile, title, createdAt: Date.now(), revision: 0,
                creationId, checkpoint: copy(checkpoint), generation: 0, messages: [], executions: [], results: [] };
            this.sessions.set(session.id, session);
            this.drivers.set(session.id, driver);
            await this.persist();
            return copy(session);
        });
    }
    /** Receipt IDs make retried sends idempotent; follow-ups serialize behind active work. */
    async send(sessionId: string, text: string, source: SessionMessage['source'], receipt: string = randomUUID()): Promise<SessionMessage> {
        if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || typeof receipt !== 'string' || !receipt || receipt.length > 200
            || !['parent','user'].includes(source)) throw new Error('Invalid child instruction');
        const message = await this.command(async () => {
            const session = this.get(sessionId);
            const existing = session.messages.find(item => item.id === receipt);
            if (existing) {
                if (existing.text !== text || existing.source !== source) throw new Error('Instruction receipt reused with different content');
                return copy(existing);
            }
            if (!this.drivers.has(sessionId)) throw new Error('Child runtime must be reconnected before continuing');
            const item: SessionMessage = { id: receipt, text, source, state: 'queued' };
            session.messages.push(item);
            session.revision++;
            if (!session.executions.some(execution => ACTIVE.has(execution.state))) this.enqueue(session);
            await this.persist();
            return copy(item);
        });
        this.pump();
        return message;
    }
    private enqueue(session: ChildSession): void {
        session.executions.push({ id: randomUUID(), generation: ++session.generation, state: 'queued', messageIds: [] });
    }
    private pump(): void {
        if (this.closed || this.fault) return;
        // Claims occur in the same command queue as Stop and Send.
        const task = this.command(async () => {
            for (const session of this.sessions.values()) {
                if (this.active >= this.capacity) break;
                const execution = session.executions.find(item => item.state === 'queued');
                const driver = this.drivers.get(session.id);
                if (!execution || !driver) continue;
                const controller = new AbortController();
                this.controls.set(session.id, controller);
                execution.state = 'running'; execution.startedAt = Date.now();
                for (const message of session.messages.filter(item => item.state === 'queued')) {
                    message.state = 'delivered'; message.executionId = execution.id;
                    execution.messageIds.push(message.id);
                }
                this.active++;
                await this.persist();
                this.launch(session, execution, driver, controller);
            }
        }).catch(error => { this.fault = error; });
        this.track(task);
    }
    private track(task: Promise<void>): void {
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    }
    private launch(session: ChildSession, execution: SessionExecution, driver: SessionDriver, controller: AbortController): void {
        const task = (async () => {
            let report = ''; let failure: unknown;
            try {
                report = await driver.execute({ session: copy(session), execution: copy(execution), signal: controller.signal,
                    state: value => this.command(async () => {
                        controller.signal.throwIfAborted();
                        if (session.generation !== execution.generation) throw new Error('Obsolete child execution');
                        execution.state = value; session.revision++;
                        await this.persist();
                    }),
                    drain: () => this.command(async () => {
                        if (session.generation !== execution.generation || controller.signal.aborted) return [];
                        const messages = session.messages.filter(message => message.state === 'queued');
                        if (messages.length) {
                            for (const message of messages) {
                                message.state = 'delivered'; message.executionId = execution.id;
                                execution.messageIds.push(message.id);
                            }
                            session.revision++;
                            await this.persist();
                        }
                        return copy(messages);
                    }),
                    checkpoint: value => {
                        const snapshot = copy(value);
                        return this.command(async () => {
                            if (session.generation !== execution.generation) throw new Error('Obsolete child execution');
                            session.checkpoint = snapshot; session.revision++;
                            await this.persist();
                        });
                    } });
            } catch (error) { failure = error; }
            try {
                await this.command(async () => {
                    if (session.generation !== execution.generation) return;
                    execution.state = controller.signal.aborted ? 'cancelled' : failure ? 'failed' : 'completed';
                    execution.endedAt = Date.now();
                    if (failure && !controller.signal.aborted) execution.error = failure instanceof Error ? failure.message : String(failure);
                    const fullReport = report || execution.error || (controller.signal.aborted ? 'Cancelled' : '');
                    session.results.push({ id: execution.id, sessionId: session.id, executionId: execution.id,
                        text: fullReport.length > 48_000 ? `${fullReport.slice(0,47_900)}\n[Report shortened. Inspect the child conversation for details.]` : fullReport, state: 'pending' });
                    if (session.messages.some(message => message.state === 'queued')) this.enqueue(session);
                    session.revision++;
                    await this.persist();
                });
            } finally { this.active--; this.controls.delete(session.id); }
        })().catch(error => { this.fault = error; }).finally(() => this.pump());
        this.track(task);
    }
    async stop(sessionId: string): Promise<void> {
        await this.command(async () => {
            const session = this.get(sessionId);
            for (const message of session.messages) if (message.state === 'queued') message.state = 'cancelled';
            for (const execution of session.executions) {
                if (execution.state === 'queued') { execution.state = 'cancelled'; execution.endedAt = Date.now(); }
                else if (execution.state === 'running' || execution.state === 'waiting_for_workspace') execution.state = 'stopping';
            }
            // Fence first, even if the disk write subsequently fails.
            this.controls.get(sessionId)?.abort();
            session.revision++;
            await this.persist();
        });
    }
    pendingResults(parentId: string): SessionResult[] {
        return this.list(parentId).flatMap(session => session.results.filter(result => result.state === 'pending'));
    }
    /** Acknowledge only after the parent has durably committed this result ID. */
    async acknowledge(sessionId: string, resultId: string): Promise<void> {
        await this.command(async () => {
            const result = this.get(sessionId).results.find(item => item.id === resultId);
            if (!result) throw new Error('Unknown child result');
            result.state = 'delivered';
            await this.persist();
        });
    }
    async updateCheckpoint(sessionId: string, revision: number, update: (value: unknown) => unknown): Promise<void> {
        await this.command(async () => {
            const session = this.get(sessionId);
            if (session.revision !== revision || session.executions.some(execution => ACTIVE.has(execution.state))) throw new Error('Child configuration changed or execution is active');
            session.checkpoint = copy(update(copy(session.checkpoint)));
            session.revision++;
            await this.persist();
        });
    }
    /** Event-driven wait; abort removes the subscription without stopping the child. */
    async wait(sessionId: string, signal?: AbortSignal): Promise<ChildSession> {
        const settled = () => !this.get(sessionId).executions.some(item => ACTIVE.has(item.state));
        if (!settled()) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { this.waiters.get(sessionId)?.delete(check); signal?.removeEventListener('abort', abort); };
            const check = () => {
                if (this.fault || settled()) {
                    cleanup();
                    if (this.fault) reject(this.fault);
                    else resolve();
                }
            };
            const abort = () => { cleanup(); reject(new DOMException('Wait cancelled', 'AbortError')); };
            const callbacks = this.waiters.get(sessionId) ?? new Set();
            callbacks.add(check); this.waiters.set(sessionId, callbacks);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort(); else check();
        });
        return copy(this.get(sessionId));
    }
    async close(): Promise<void> {
        if (this.fault) {
            this.closed = true;
            for (const controller of this.controls.values()) controller.abort();
            await Promise.all([...this.tasks]);
            await this.store.close?.();
            return;
        }
        for (const session of this.sessions.values()) await this.stop(session.id);
        while (this.tasks.size) await Promise.all([...this.tasks]);
        this.closed = true;
        await this.store.close?.();
    }
}

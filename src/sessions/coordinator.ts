import { randomUUID } from 'crypto';
import type { ChildSession, CoordinatorSnapshot, CoordinatorStore, SessionDriver, SessionExecution, SessionMessage, SessionResult } from './types';
import { MAX_COORDINATOR_STORE_BYTES } from './store';

const ACTIVE = new Set(['queued', 'running', 'waiting_for_workspace', 'stopping']);
const MAX_SETTLED_MESSAGES = 200;
const MAX_SETTLED_EXECUTIONS = 100;
const MAX_DELIVERED_RESULTS = 50;
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
    private persisting = false;
    private closing = false;
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
    get unavailable(): boolean { return this.closed || this.closing || !!this.fault; }
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
    private command<T>(action: () => Promise<T>, internal = false): Promise<T> {
        if (!internal && (this.closed || this.closing)) return Promise.reject(new Error('Session coordinator is closed'));
        const run = this.commands.then(async () => {
            if (this.closed || (!internal && this.closing)) throw new Error('Session coordinator is closed');
            if (this.fault) throw new Error('Session storage failed; execution is fenced');
            return action();
        });
        this.commands = run.catch(() => undefined);
        return run;
    }
    private boundHistory(): void {
        for (const session of this.sessions.values()) {
            const activeExecIds = new Set(session.executions.filter(e => ACTIVE.has(e.state)).map(e => e.id));
            const pendingExecIds = new Set(session.results.filter(r => r.state === 'pending').map(r => r.executionId));
            const keepExecIds = new Set([...activeExecIds, ...pendingExecIds]);
            const latestExec = session.executions.at(-1);
            if (latestExec) keepExecIds.add(latestExec.id);
            if (session.executions.length > MAX_SETTLED_EXECUTIONS) {
                const keptSettled = session.executions.filter(e => !keepExecIds.has(e.id)).slice(-MAX_SETTLED_EXECUTIONS);
                const keepSet = new Set([...keepExecIds, ...keptSettled.map(e => e.id)]);
                session.executions = session.executions.filter(e => keepSet.has(e.id));
            }
            const activeMsgIds = new Set(session.executions.filter(e => activeExecIds.has(e.id)).flatMap(e => e.messageIds));
            if (session.messages.length > MAX_SETTLED_MESSAGES) {
                const keepMsg = new Set(session.messages.filter(m => m.state === 'queued' || activeMsgIds.has(m.id)).map(m => m.id));
                const settledMsgs = session.messages.filter(m => !keepMsg.has(m.id)).slice(-MAX_SETTLED_MESSAGES);
                for (const m of settledMsgs) keepMsg.add(m.id);
                session.messages = session.messages.filter(m => keepMsg.has(m.id));
            }
            const deliveredResults = session.results.filter(r => r.state === 'delivered');
            if (deliveredResults.length > MAX_DELIVERED_RESULTS) {
                const keepDelivered = new Set(deliveredResults.slice(-MAX_DELIVERED_RESULTS).map(r => r.id));
                session.results = session.results.filter(r => r.state === 'pending' || keepDelivered.has(r.id));
            }
        }
    }
    private compactForStorage(maxBytes = MAX_COORDINATOR_STORE_BYTES): void {
        this.boundHistory();
        const fits = () => Buffer.byteLength(JSON.stringify({ version: 1, sessions: [...this.sessions.values()] })) <= maxBytes;
        if (fits()) return;
        // Pass 1: Keep all pending reports and the latest result per session; archive older delivered report text.
        for (const session of this.sessions.values()) {
            const latestId = session.results.at(-1)?.id;
            session.results = session.results.filter(r => r.state === 'pending' || r.id === latestId);
            for (const r of session.results) {
                if (r.state === 'delivered' && r.text.length > 512) r.text = '[Archived delivered report.]';
            }
        }
        if (fits()) return;
        // Pass 2: Trim settled executions and older message bodies while preserving recent retry receipts.
        for (const session of this.sessions.values()) {
            const activeExecIds = new Set(session.executions.filter(e => ACTIVE.has(e.state)).map(e => e.id));
            const pendingExecIds = new Set(session.results.filter(r => r.state === 'pending').map(r => r.executionId));
            const latestExecId = session.executions.at(-1)?.id;
            session.executions = session.executions.filter(e => activeExecIds.has(e.id) || pendingExecIds.has(e.id) || e.id === latestExecId);
            const activeMsgIds = new Set(session.executions.filter(e => activeExecIds.has(e.id)).flatMap(e => e.messageIds));
            const keepMsg = new Set(session.messages.filter(m => m.state === 'queued' || activeMsgIds.has(m.id)).map(m => m.id));
            for (const m of session.messages.filter(m => !keepMsg.has(m.id)).slice(-50)) keepMsg.add(m.id);
            session.messages = session.messages.filter(m => keepMsg.has(m.id));
        }
        if (fits()) return;
        // Pass 3: Trim display traces and oldest checkpoint rows so a family near the 32 MiB ceiling can recover.
        for (const session of this.sessions.values()) {
            const cp = session.checkpoint as { trace?: unknown; rows?: Array<{ role?: string }>; historyTrimmed?: boolean; replayUserTurns?: number } | undefined;
            if (!cp || typeof cp !== 'object') continue;
            if (!session.executions.some(e => ACTIVE.has(e.state))) delete cp.trace;
        }
        for (let pass = 0; pass < 16 && !fits(); pass++) {
            let trimmed = false;
            for (const session of this.sessions.values()) {
                const cp = session.checkpoint as { rows?: Array<{ role?: string }>; historyTrimmed?: boolean; replayUserTurns?: number } | undefined;
                if (!cp || !Array.isArray(cp.rows) || cp.rows.length <= 2) continue;
                const drop = Math.max(1, Math.ceil(cp.rows.length / 2));
                cp.rows = cp.rows.slice(drop);
                cp.historyTrimmed = true;
                if (typeof cp.replayUserTurns === 'number') {
                    const userCount = cp.rows.filter(r => r?.role === 'user').length;
                    cp.replayUserTurns = Math.min(cp.replayUserTurns, userCount);
                }
                trimmed = true;
            }
            if (!trimmed) break;
        }
    }
    private async persist(): Promise<void> {
        this.compactForStorage();
        const snapshot: CoordinatorSnapshot = { version: 1, sessions: this.list() };
        this.persisting = true;
        try { await this.store.save(snapshot); }
        catch (error) {
            this.persisting = false;
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
        this.persisting = false;
        for (const listener of this.listeners) {
            try { listener(copy(snapshot.sessions)); } catch { /* A view cannot break execution ownership. */ }
        }
        for (const callbacks of this.waiters.values()) for (const callback of [...callbacks]) callback();
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
        if (this.closed || this.closing || this.fault) return;
        // Claims occur in the same command queue as Stop and Send.
        const task = this.command(async () => {
            if (this.closing) return;
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
        }, true).catch(error => { this.fault = error; });
        this.track(task);
    }
    private track(task: Promise<void>): void {
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    }
    private launch(session: ChildSession, execution: SessionExecution, driver: SessionDriver, controller: AbortController): void {
        const task = (async () => {
            let report = ''; let failed = false; let failure: unknown;
            try {
                report = await driver.execute({ session: copy(session), execution: copy(execution), signal: controller.signal,
                    state: value => this.command(async () => {
                        controller.signal.throwIfAborted();
                        if (session.generation !== execution.generation) throw new Error('Obsolete child execution');
                        execution.state = value; session.revision++;
                        await this.persist();
                    }, true),
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
                    }, true),
                    checkpoint: value => {
                        const snapshot = copy(value);
                        return this.command(async () => {
                            if (session.generation !== execution.generation) throw new Error('Obsolete child execution');
                            session.checkpoint = snapshot; session.revision++;
                            await this.persist();
                        }, true);
                    } });
            } catch (error) { failed = true; failure = error; }
            try {
                await this.command(async () => {
                    if (session.generation !== execution.generation) return;
                    execution.state = controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed';
                    execution.endedAt = Date.now();
                    if (failed && !controller.signal.aborted) {
                        const detail = failure instanceof Error ? failure.message : String(failure ?? '');
                        execution.error = detail || 'Child execution failed';
                    }
                    const fullReport = report || execution.error || (controller.signal.aborted ? 'Cancelled' : '');
                    session.results.push({ id: execution.id, sessionId: session.id, executionId: execution.id,
                        text: fullReport.length > 48_000 ? `${fullReport.slice(0,47_900)}\n[Report shortened. Inspect the child conversation for details.]` : fullReport, state: 'pending' });
                    if (!this.closing && session.messages.some(message => message.state === 'queued')) this.enqueue(session);
                    session.revision++;
                    await this.persist();
                }, true);
            } finally { this.active--; this.controls.delete(session.id); }
        })().catch(error => { this.fault = error; }).finally(() => this.pump());
        this.track(task);
    }
    private stopSession(sessionId: string, internal = false): Promise<void> {
        return this.command(async () => {
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
        }, internal);
    }
    async stop(sessionId: string): Promise<void> {
        await this.stopSession(sessionId, false);
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
    private async waitUntil(sessionId: string, predicate: (session: ChildSession) => boolean, signal?: AbortSignal): Promise<ChildSession> {
        if (this.fault) throw this.fault;
        const ready = () => !this.persisting && predicate(this.get(sessionId));
        if (!ready()) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { this.waiters.get(sessionId)?.delete(check); signal?.removeEventListener('abort', abort); };
            const check = () => {
                if (this.fault || ready()) {
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
    /** Event-driven wait; abort removes the subscription without stopping the child. */
    async wait(sessionId: string, signal?: AbortSignal): Promise<ChildSession> {
        return this.waitUntil(sessionId, session => !session.executions.some(item => ACTIVE.has(item.state)), signal);
    }
    /** Wait for the execution that claimed a specific instruction (or its cancellation). */
    async waitForInstruction(sessionId: string, messageId: string, signal?: AbortSignal): Promise<ChildSession> {
        return this.waitUntil(sessionId, session => {
            const message = session.messages.find(item => item.id === messageId);
            if (!message) return !session.executions.some(item => ACTIVE.has(item.state));
            if (message.state === 'queued') return false;
            if (message.state === 'cancelled') return true;
            const execution = message.executionId ? session.executions.find(item => item.id === message.executionId) : undefined;
            return !execution || !ACTIVE.has(execution.state);
        }, signal);
    }
    async close(): Promise<void> {
        this.closing = true;
        let closeError: unknown;
        try {
            await this.commands;
            if (!this.fault) {
                for (const session of [...this.sessions.values()]) {
                    try { await this.stopSession(session.id, true); }
                    catch (error) { closeError ??= error; break; }
                }
            }
        } finally {
            for (const controller of this.controls.values()) controller.abort();
            while (this.tasks.size) await Promise.all([...this.tasks]);
            await this.commands;
            this.closed = true;
            try { await this.store.close?.(); }
            catch (error) { closeError ??= error; }
        }
        if (closeError) throw closeError;
    }
}

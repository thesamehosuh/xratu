/** Durable session state. Transport credentials and live handles never belong here. */
export type ExecutionState = 'queued' | 'running' | 'waiting_for_workspace' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface SessionMessage {
    id: string;
    text: string;
    source: 'parent' | 'user';
    state: 'queued' | 'delivered' | 'cancelled';
    executionId?: string;
}
export interface SessionExecution {
    id: string;
    generation: number;
    state: ExecutionState;
    messageIds: string[];
    startedAt?: number;
    endedAt?: number;
    error?: string;
    errorCode?: 'storage_failed';
}
export interface SessionResult {
    id: string;
    sessionId: string;
    executionId: string;
    text: string;
    state: 'pending' | 'delivered';
}
export interface ChildSession {
    id: string;
    parentId: string;
    creationId?: string;
    title: string;
    profile: string;
    createdAt: number;
    revision: number;
    generation: number;
    messages: SessionMessage[];
    executions: SessionExecution[];
    results: SessionResult[];
    /** Engine-owned committed history, validated by the driver on resume. */
    checkpoint?: unknown;
}
export interface CoordinatorSnapshot { version: 1; sessions: ChildSession[] }
export interface CoordinatorStore {
    load(): Promise<CoordinatorSnapshot | undefined>;
    save(snapshot: CoordinatorSnapshot): Promise<void>;
    close?(): Promise<void>;
}
export interface SessionDriverContext {
    session: ChildSession;
    execution: SessionExecution;
    signal: AbortSignal;
    /** Persist a committed model boundary before advancing execution. */
    checkpoint(value: unknown): Promise<void>;
    drain(): Promise<SessionMessage[]>;
    state(value: 'running' | 'waiting_for_workspace'): Promise<void>;
}
export interface SessionDriver {
    execute(context: SessionDriverContext): Promise<string>;
}

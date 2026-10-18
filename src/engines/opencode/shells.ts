import type { OpenCodeClient, ShellInfo1 } from '@opencode/client';

export interface NativeJobView {
    jobId: string; command: string; running: boolean; uptimeSeconds: number;
    status: 'running' | 'exited' | 'killed' | 'failed'; exitCode: number | null;
    startedAt: number; finishedAt?: number; cwd: string; pid?: number; output: string;
}
export interface NativeShellUpdate {
    jobs: NativeJobView[];
    callId?: string;
    jobId?: string;
    output?: string;
    background?: boolean;
    byUser?: boolean;
}
interface TrackedShell { info: ShellInfo1; workspace: string; callId?: string; background: boolean; byUser: boolean; output: string; cursor: number; finishedRead?: boolean }

/** Observe native shells through their API; never pretend they are local terminal jobs. */
export class NativeShellMonitor {
    private readonly sessions = new Map<string, string>();
    private readonly shells = new Map<string, TrackedShell>();
    private readonly userCalls = new Set<string>();
    private timer?: ReturnType<typeof setInterval>;
    private controller = new AbortController();
    private refreshing = false;
    constructor(private readonly connect: () => Promise<OpenCodeClient>, private readonly emit: (update: NativeShellUpdate) => void) {}
    watch(sessionID: string, workspace: string): void {
        const first = !this.sessions.has(sessionID);
        this.sessions.set(sessionID, workspace);
        if (!this.timer) { this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, 1000); this.timer.unref?.(); }
        void this.refresh().catch(() => undefined);
        if (first) void this.restore(sessionID).catch(() => undefined);
    }
    unwatch(sessionID: string): void {
        this.sessions.delete(sessionID);
        if (!this.sessions.size) { clearInterval(this.timer); this.timer = undefined; }
    }
    private async restore(sessionID: string): Promise<void> {
        const client = await this.connect();
        const messages = await client.message.list({ sessionID, limit: 50 }, { signal: this.signal() });
        for (const message of messages.data) {
            if (message.type !== 'assistant') continue;
            for (const part of message.content) {
                if (part.type !== 'tool' || part.name !== 'shell' || part.state.status !== 'completed') continue;
                const id = part.state.metadata?.shellID;
                if (typeof id === 'string' && (part.state.metadata?.status === 'running' || part.state.input.background === true)) await this.track(id, sessionID, part.id, true).catch(() => undefined);
            }
        }
    }
    hasRunningCall(callID: string): boolean { return [...this.shells.values()].some((shell) => shell.callId === callID && shell.info.status === 'running'); }
    markUser(callID: string): void { this.userCalls.add(callID); }
    async track(id: string, sessionID: string, callId?: string, background = false): Promise<void> {
        const workspace = this.sessions.get(sessionID);
        if (!workspace || this.controller.signal.aborted) return;
        const client = await this.connect();
        const { data: info } = await client.shell.get({ id, location: { directory: workspace } }, { signal: this.signal() });
        // A guessed shell id must never attach another session's process.
        if (info.metadata.sessionID !== sessionID) return;
        const current = this.shells.get(id) ?? { info, workspace, background: false, byUser: false, output: '', cursor: 0 };
        current.info = info;
        current.callId ??= callId;
        current.byUser ||= !!callId && this.userCalls.has(callId);
        current.background ||= background || current.byUser;
        this.shells.set(id, current);
        this.bound();
        this.emit({ jobs: this.views(), callId: current.callId, jobId: `opencode:${id}`, background: current.background, byUser: current.byUser });
    }
    private signal(): AbortSignal { return AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]); }
    private bound(): void {
        if (this.shells.size <= 64) return;
        for (const [id, shell] of this.shells) {
            if (shell.info.status !== 'running') this.shells.delete(id);
            if (this.shells.size <= 64) break;
        }
    }
    views(): NativeJobView[] {
        return [...this.shells].filter(([, shell]) => shell.background).map(([id, shell]) => ({
            jobId: `opencode:${id}`, command: shell.info.command, running: shell.info.status === 'running',
            uptimeSeconds: Math.max(0, Math.floor(((shell.info.time.completed ?? Date.now()) - shell.info.time.started) / 1000)),
            status: shell.info.status === 'timeout' ? 'failed' : shell.info.status, exitCode: shell.info.exit ?? null,
            startedAt: shell.info.time.started, finishedAt: shell.info.time.completed, cwd: shell.info.cwd, pid: shell.info.pid, output: shell.output,
        }));
    }
    async refresh(): Promise<void> {
        if (this.refreshing || this.controller.signal.aborted) return;
        this.refreshing = true;
        try {
            const client = await this.connect();
            for (const workspace of new Set(this.sessions.values())) {
                const { data } = await client.shell.list({ location: { directory: workspace } }, { signal: this.signal() });
                for (const info of data) {
                    if (typeof info.metadata.sessionID !== 'string' || !this.sessions.has(info.metadata.sessionID)) continue;
                    const tracked = this.shells.get(info.id);
                    if (tracked) tracked.info = info;
                    // A shell in the running list alone does not prove it was backgrounded.
                }
            }
            for (const [id, tracked] of this.shells) {
                if (tracked.finishedRead) continue;
                const location = { directory: tracked.workspace };
                if (tracked.info.status === 'running') tracked.info = (await client.shell.get({ id, location }, { signal: this.signal() })).data;
                const output = (await client.shell.output({ id, location, cursor: tracked.cursor, limit: 20_000 }, { signal: this.signal() })).data;
                tracked.cursor = output.cursor;
                tracked.finishedRead = tracked.info.status !== 'running' && !output.truncated;
                if (output.output) {
                    tracked.output = (tracked.output + output.output).slice(-20_000);
                    this.emit({ jobs: this.views(), callId: tracked.callId, jobId: `opencode:${id}`, output: tracked.background ? tracked.output : output.output, background: tracked.background, byUser: tracked.byUser });
                }
            }
            this.bound();
            this.emit({ jobs: this.views() });
        } finally { this.refreshing = false; }
    }
    async stop(jobId: string): Promise<boolean> {
        const id = jobId.startsWith('opencode:') ? jobId.slice('opencode:'.length) : '';
        const tracked = this.shells.get(id);
        if (!tracked || !tracked.background) return false;
        const client = await this.connect();
        await client.shell.remove({ id, location: { directory: tracked.workspace } }, { signal: this.signal() });
        tracked.info = { ...tracked.info, status: 'killed', time: { ...tracked.info.time, completed: Date.now() } };
        tracked.finishedRead = true;
        this.emit({ jobs: this.views() });
        return true;
    }
    dispose(): void { this.controller.abort(); clearInterval(this.timer); this.sessions.clear(); this.shells.clear(); this.userCalls.clear(); }
}

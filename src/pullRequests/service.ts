import { randomUUID } from 'crypto';
import { isOfflineMode } from '../networkPolicy';
import { PullRequestStore } from './store';
import { GitHubPullRequests } from './github';
import { evaluatePullRequestWatch } from './watch';
import { PullRequestError, pullRequestTarget, pullRequestKey, type PullRequestSession, type PullRequestExecution, type PullRequestSnapshot, type PullRequestLink, type PullRequestEvent } from './types';

export interface PullRequestContext { sessionId: string; workspace: string }
type Provider = Pick<GitHubPullRequests, 'read'>;
const boundedSnapshot = (snapshot: PullRequestSnapshot): PullRequestSnapshot => ({ ...snapshot, commentCount: snapshot.comments.length, comments: snapshot.comments.slice(-50).map(comment => ({ ...comment, body: comment.body.slice(0, 1000) })) });
const pruneWithdrawnDelivery = (state: PullRequestSession) => {
    if (state.delivery && state.delivery.status !== 'running' && !state.delivery.ids.some(id => state.events.some(event => event.id === id))) delete state.delivery;
};
export class PullRequestService {
    private timer?: ReturnType<typeof setInterval>;
    private sweeping = false;
    private readonly abort = new AbortController();
    private rateLimitedUntil = 0;
    constructor(readonly store: PullRequestStore, private readonly provider: Provider = new GitHubPullRequests(), private readonly changed: (context: PullRequestContext) => void = () => {}, private readonly diagnostic: (error: unknown) => void = console.error) {}
    start(): Promise<void> {
        if (this.timer) return Promise.resolve();
        this.timer = setInterval(() => { void this.sweep().catch(this.diagnostic); }, 120_000);
        this.timer.unref?.();
        // Recover an interrupted delivery visibly; never replay it silently.
        return this.recover().then(() => this.sweep());
    }
    dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.abort.abort(); }
    private async recover(): Promise<void> {
        for (const context of await this.store.sessions()) {
            const state = await this.store.load(context.sessionId, context.workspace);
            if (state.delivery?.status === 'running') {
                let alive = true;
                try { process.kill(state.delivery.owner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
                if (!alive) await this.change(context, value => { if (value.delivery?.status === 'running') value.delivery.status = 'interrupted'; });
            }
        }
    }
    private async change(context: PullRequestContext, operation: (state: PullRequestSession) => void): Promise<PullRequestSession> {
        const result = await this.store.update(context.sessionId, context.workspace, state => {
            if (state.deleted) throw new PullRequestError('prSessionRequired');
            operation(state);
        });
        this.changed(context);
        return result;
    }
    async link(context: PullRequestContext, value: unknown, source: 'user' | 'agent'): Promise<PullRequestLink> {
        const target = pullRequestTarget(value);
        const state = await this.change(context, state => {
            if (state.links.some(link => pullRequestKey(link) === pullRequestKey(target))) return;
            if (state.links.length >= 50) throw new PullRequestError('prLinkLimit');
            state.links.push({ ...target, source, linkedAt: new Date().toISOString(), generation: randomUUID(), snapshot: null, failures: 0 });
        });
        return state.links.find(link => pullRequestKey(link) === pullRequestKey(target))!;
    }
    async unlink(context: PullRequestContext, value: unknown): Promise<void> {
        const key = pullRequestKey(pullRequestTarget(value));
        await this.change(context, state => { state.links = state.links.filter(link => pullRequestKey(link) !== key); state.events = state.events.filter(event => event.key !== key); pruneWithdrawnDelivery(state); });
    }
    async watch(context: PullRequestContext, value: unknown, resume?: PullRequestExecution): Promise<void> {
        if (isOfflineMode()) throw new PullRequestError('prOffline');
        const link = await this.link(context, value, 'agent');
        if (link.watch) {
            if (resume) await this.change(context, state => {
                const current = state.links.find(item => pullRequestKey(item) === pullRequestKey(link));
                if (!current?.watch || current.generation !== link.generation) throw new PullRequestError('prChangedDuringRead');
                current.resume = resume;
                current.generation = randomUUID();
            });
            return;
        }
        const snapshot = await this.provider.read(link, context.workspace, this.abort.signal);
        if (snapshot.state !== 'open') throw new PullRequestError('prNotOpen');
        const now = new Date().toISOString();
        const baseline = evaluatePullRequestWatch({ startedAt: now, headSha: snapshot.headSha, failedChecks: [], passed: false, passedChecks: [], remarksThrough: now, remarkIds: [], conflicting: false, wakes: 0 }, snapshot, []);
        await this.change(context, state => {
            const current = state.links.find(item => pullRequestKey(item) === pullRequestKey(link) && item.generation === link.generation);
            if (!current) throw new PullRequestError('prChangedDuringRead');
            current.snapshot = boundedSnapshot(snapshot);
            current.generation = randomUUID(); current.watch = baseline.next; current.resume = resume;
            current.failures = 0; delete current.errorKey; delete current.errorDetail;
        });
    }
    async unwatch(context: PullRequestContext, value: unknown): Promise<void> {
        const key = pullRequestKey(pullRequestTarget(value));
        await this.change(context, state => {
            const link = state.links.find(link => pullRequestKey(link) === key);
            if (link) { delete link.watch; delete link.resume; link.generation = randomUUID(); }
            // Stop also withdraws queued automatic continuation for this PR.
            state.events = state.events.filter(event => event.key !== key);
            pruneWithdrawnDelivery(state);
        });
    }
    async stop(context: PullRequestContext): Promise<void> {
        await this.change(context, state => {
            for (const link of state.links) { delete link.watch; delete link.resume; link.generation = randomUUID(); }
            state.events = []; delete state.delivery;
        });
    }
    async refresh(context: PullRequestContext, value: unknown): Promise<void> {
        const target = pullRequestTarget(value);
        const state = await this.store.load(context.sessionId, context.workspace);
        const link = state.links.find(link => pullRequestKey(link) === pullRequestKey(target));
        if (!link) throw new PullRequestError('prNotLinked');
        await this.refreshLink(context, link);
    }
    private async refreshLink(context: PullRequestContext, expected: PullRequestLink, read?: Promise<PullRequestSnapshot>): Promise<void> {
        if (isOfflineMode()) throw new PullRequestError('prOffline');
        try {
            const snapshot = await (read ?? this.provider.read(expected, context.workspace, this.abort.signal));
            if (this.abort.signal.aborted) return;
            await this.change(context, state => {
                const link = state.links.find(link => pullRequestKey(link) === pullRequestKey(expected) && link.generation === expected.generation);
                if (!link) return;
                link.snapshot = boundedSnapshot(snapshot); link.generation = randomUUID(); link.failures = 0; delete link.errorKey; delete link.errorDetail;
                if (!link.watch) return;
                const report = evaluatePullRequestWatch(link.watch, snapshot, snapshot.comments);
                const reason = snapshot.state !== 'open' ? snapshot.state : report.exhausted ? 'comment-limit' : undefined;
                if (report.changes.length || reason) {
                    if (state.events.length >= 32) {
                        delete link.watch; delete link.resume; link.errorKey = 'prQueueFull'; return;
                    }
                    let omittedItems = 0;
                    const changes = report.changes.map(change => {
                        if (change.kind === 'remarks') { omittedItems += Math.max(0, change.remarks.length - 10); return { ...change, remarks: change.remarks.slice(0, 10).map(comment => ({ ...comment, body: comment.body.slice(0, 1000) })) }; }
                        if (change.kind === 'checks-failed') { omittedItems += Math.max(0, change.failed.length - 50); return { ...change, failed: change.failed.slice(0, 50) }; }
                        return change;
                    });
                    state.events.push({ id: randomUUID(), key: pullRequestKey(link), url: link.url, number: link.number, createdAt: new Date().toISOString(), headSha: snapshot.headSha, changes, reason, resume: link.resume, ...(omittedItems ? { omittedItems } : {}) });
                }
                if (reason) { delete link.watch; delete link.resume; }
                else link.watch = report.next;
            });
        } catch (error) {
            if (this.abort.signal.aborted) return;
            const failure = error instanceof PullRequestError ? error : new PullRequestError('prReadFailed', error instanceof Error ? error.message : String(error));
            if (failure.valueKey === 'prRateLimited') this.rateLimitedUntil = Date.now() + 5 * 60_000;
            await this.change(context, state => {
                const link = state.links.find(link => pullRequestKey(link) === pullRequestKey(expected) && link.generation === expected.generation);
                if (!link) return;
                link.errorKey = failure.valueKey; link.errorDetail = failure.detail;
                if (link.watch && !['prRateLimited', 'prOffline', 'prCancelled'].includes(failure.valueKey)) {
                    link.failures++;
                    if (link.failures >= 8) {
                        if (state.events.length < 32) state.events.push({ id: randomUUID(), key: pullRequestKey(link), url: link.url, number: link.number, createdAt: new Date().toISOString(), headSha: link.snapshot?.headSha ?? null, changes: [], reason: 'unreadable', resume: link.resume });
                        delete link.watch; delete link.resume;
                    }
                }
            });
            throw failure;
        }
    }
    async sweep(): Promise<void> {
        if (this.sweeping || this.abort.signal.aborted || isOfflineMode() || Date.now() < this.rateLimitedUntil) return;
        this.sweeping = true;
        try {
            const reads = new Map<string, Promise<PullRequestSnapshot>>();
            for (const context of await this.store.sessions()) {
                try {
                    const state = await this.store.load(context.sessionId, context.workspace);
                    for (const link of state.links.filter(link => link.watch)) {
                        if (this.abort.signal.aborted || isOfflineMode() || Date.now() < this.rateLimitedUntil) return;
                        const key = `${context.workspace}\0${pullRequestKey(link)}`;
                        let read = reads.get(key);
                        if (!read) { read = this.provider.read(link, context.workspace, this.abort.signal); reads.set(key, read); }
                        await this.refreshLink(context, link, read).catch(this.diagnostic);
                    }
                    if (state.events.length) this.changed(context);
                } catch (error) { this.diagnostic(error); }
            }
        } finally { this.sweeping = false; }
    }
    async beginDelivery(context: PullRequestContext, ids: string[], retry = false): Promise<PullRequestEvent[]> {
        let events: PullRequestEvent[] = [];
        await this.change(context, state => {
            if (state.delivery && (!retry || state.delivery.status === 'running')) return;
            events = state.events.filter(event => ids.includes(event.id));
            if (events.length) state.delivery = { ids: events.map(event => event.id), status: 'running', owner: process.pid };
        });
        return events;
    }
    async finishDelivery(context: PullRequestContext, ids: string[], delivered: boolean): Promise<void> {
        await this.change(context, state => {
            if (!state.delivery || state.delivery.ids.join() !== ids.join()) return;
            if (delivered) { state.events = state.events.filter(event => !ids.includes(event.id)); delete state.delivery; }
            else if (!state.delivery.ids.some(id => state.events.some(event => event.id === id))) delete state.delivery;
            else state.delivery.status = 'failed';
        });
    }
    async dismiss(context: PullRequestContext): Promise<void> {
        await this.change(context, state => { if (state.delivery?.status === 'running') return; state.events = []; delete state.delivery; });
    }
}

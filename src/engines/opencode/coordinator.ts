// Session ownership, child attachment and report settlement adapted from
// T3 Code's provider-opencode/server/v2/adapter.ts (see third-party notices).
import { readResearchEvidence } from '../../web/types';
import type { LocalAgentEvent } from '../../local/localTypes';
import { SubagentTraceCollector, type SubagentApprovalSource, type SubagentTrace } from '../../subagentObservation';
import type { NativeEvent } from './events';
import { nativeToolDisplayArgs } from './services';
import { mapMcpToolContent } from '../../mcpToolContent';

interface NativeCall { name: string; input: Record<string, unknown> }
interface Delegation {
    owner: NativeSession; id: string; nativeID: string; input: Record<string, unknown>; child?: NativeSession;
    finished: boolean; error: boolean; report?: string; collector?: SubagentTraceCollector;
    /** Set when the user stopped this child; the observation ends cancelled. */
    stopped?: boolean;
    /** Interrupt for the attached child, or the deferred one for a child that
     *  has only been announced so far. */
    stop?: (sessionID: string) => void;
    stopRequested?: boolean;
}
export interface NativeSession {
    id: string; parentID?: string; model: string; agent: string; running: boolean; execution: number;
    calls: Map<string, NativeCall>; delegations: Map<string, Delegation>;
    reports: Set<string>; delegation?: Delegation; pending: NativeEvent[]; pendingChars: number; reasoning: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const reportText = (value: string) => /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(value.trim())?.[1] ?? value;

/** Own an entire native execution tree, including work backgrounded by a
 * child. Xratu keeps the turn/Stop control claimed until reports are delivered
 * and every execution settles; a child never runs after its host goes away. */
export class NativeSessionCoordinator {
    readonly sessions = new Map<string, NativeSession>();
    readonly root: NativeSession;
    private readonly replay: NativeEvent[] = [];
    private readonly claims = new Map<string, string>();
    constructor(rootID: string, model: string, private readonly displayName: (name: string) => string,
        private readonly publish: (callId: string, trace: SubagentTrace) => void,
        private readonly childAdded: (id: string) => void) {
        this.root = this.add(rootID, undefined, model, 'build');
    }
    private add(id: string, parentID: string | undefined, model: string, agent: string): NativeSession {
        if (this.sessions.size >= 128) throw new Error('OpenCode child session limit exceeded');
        const state: NativeSession = { id, parentID, model, agent, running: false, execution: 0, calls: new Map(), delegations: new Map(), reports: new Set(), pending: [], pendingChars: 0, reasoning: '' };
        this.sessions.set(id, state);
        if (parentID) this.childAdded(id);
        return state;
    }
    owns(id: string): boolean { return this.sessions.has(id); }
    claim(id: string, ownerID: string, callID: string): boolean {
        const key = `${ownerID}:${callID}`;
        if (this.claims.has(id) && this.claims.get(id) !== key) return false;
        this.claims.set(id, key); return true;
    }
    release(id: string, ownerID: string, callID: string): void {
        if (this.claims.get(id) === `${ownerID}:${callID}`) this.claims.delete(id);
    }
    /** Reused sessions must be verified through the SDK before a permission is
     * answered. Never trust a model-supplied sessionID or a progress frame. */
    admit(id: string, parentID: string, model: string, agent: string): void {
        const parent = this.sessions.get(parentID);
        if (!parent || (this.sessions.has(id) && this.sessions.get(id)?.parentID !== parentID)) throw new Error('OpenCode child session ownership mismatch');
        if (!this.sessions.has(id)) this.add(id, parentID, model, agent);
    }
    call(sessionID: string, id: string): NativeCall | undefined { return this.sessions.get(sessionID)?.calls.get(id); }
    displayID(sessionID: string, id: string): string {
        const execution = this.sessions.get(sessionID)?.execution ?? 0;
        if (execution > 1) return `${sessionID}:${execution}:${id}`;
        return sessionID === this.root.id ? id : `${sessionID}:${id}`;
    }
    reusable(id: string): boolean {
        const below = (state: NativeSession): boolean => state.id === id || !!state.parentID && below(this.sessions.get(state.parentID)!);
        return ![...this.sessions.values()].some(state => below(state) && (state.running || state.reports.size || [...state.delegations.values()].some(call => !call.finished)));
    }
    /** Stop ONE delegated child (and its descendants). A child that has only
     *  been announced is interrupted as soon as `attach()` binds it, because a
     *  model-supplied id is never trusted before admission. The parent's turn
     *  keeps running; only this subtree is asked to end. */
    requestStop(callId: string, interrupt: (sessionID: string) => void): boolean {
        const call = this.root.delegations.get(callId);
        if (!call || call.collector?.trace.endedAt || (call.finished && (!call.child || call.child.delegation !== call))) return false;
        call.stopped = true;
        call.stop = interrupt;
        if (call.child) this.interruptSubtree(call.child, interrupt);
        else call.stopRequested = true;
        return true;
    }
    private interruptSubtree(state: NativeSession, interrupt: (sessionID: string) => void, seen = new Set<string>()): void {
        if (seen.has(state.id) || seen.size >= 128) return;
        seen.add(state.id);
        interrupt(state.id);
        for (const session of this.sessions.values()) if (session.parentID === state.id) this.interruptSubtree(session, interrupt, seen);
    }
    source(sessionID: string): SubagentApprovalSource | undefined {
        const group = this.group(this.sessions.get(sessionID));
        return group ? { parentCallId: group.id, profile: group.collector?.trace.profile ?? text(group.input.agent), description: text(group.input.description) } : undefined;
    }
    private group(state?: NativeSession): Delegation | undefined {
        let call = state?.delegation;
        while (call?.owner.delegation) call = call.owner.delegation;
        return call;
    }
    private emit(state: NativeSession, event: LocalAgentEvent): void { this.group(state)?.collector?.receive(event, `${state.id}:${state.execution}`); }
    waiting(sessionID: string, approvalId: string, tool: string, callID?: string): void {
        const state = this.sessions.get(sessionID);
        const event: LocalAgentEvent = { type: 'needsApproval', approvalId, approvals: [{ tool_call_id: approvalId, tool_name: tool, args: {} }] };
        if (state === this.root && callID) state.delegations.get(this.displayID(sessionID, callID))?.collector?.receive(event);
        else if (state) this.emit(state, event);
    }
    private collector(call: Delegation): SubagentTraceCollector {
        const now = Date.now();
        return new SubagentTraceCollector({ taskId: `opencode:${this.root.id}:${call.id}`, profile: text(call.input.agent),
            description: text(call.input.description), prompt: text(call.input.prompt), model: this.root.model, resumed: !!call.input.sessionID,
            tools: [], status: 'running', startedAt: now, updatedAt: now, entries: [], toolCalls: 0, inputTokens: 0, outputTokens: 0 }, trace => this.publish(call.id, trace));
    }
    private attach(call: Delegation, childID: string): void {
        const child = this.sessions.get(childID);
        if (!child || child.parentID !== call.owner.id || (child.delegation && child.delegation !== call && !child.delegation.finished)) throw new Error('OpenCode child session ownership mismatch');
        if (call.child === child) return;
        call.child = child; child.delegation = call;
        this.childAdded(child.id);
        if (call.stopRequested) { call.stopRequested = false; if (call.stop) this.interruptSubtree(child, call.stop); }
        const group = this.group(child);
        if (group !== call && group?.stopped && group.stop) this.interruptSubtree(child, group.stop);
        if (call.owner === this.root) {
            call.collector ??= this.collector(call);
            Object.assign(call.collector.trace, { taskId: child.id, model: child.model, profile: text(call.input.agent) || child.agent, status: 'running', pendingTools: undefined });
            call.collector.flush();
        }
        const pending = child.pending.splice(0); child.pendingChars = 0;
        this.replay.push(...pending);
    }
    drain(): NativeEvent[] { return this.replay.splice(0); }
    bound(id: string): boolean { return id === this.root.id || !!this.sessions.get(id)?.delegation; }
    /** A child announced before its owner's `subagent` call carried
     *  `metadata.sessionID` can only ever bind through an UNFINISHED delegation
     *  of its parent - `attach()` runs from that delegation's tool progress or
     *  success. Once every delegation of the parent has finished (or the parent
     *  never delegated at all), its buffered events can never be replayed, and
     *  counting them as work would hold the turn open forever after the root
     *  execution already succeeded. */
    private bindable(state: NativeSession): boolean {
        const parent = state.parentID ? this.sessions.get(state.parentID) : undefined;
        return !!parent && [...parent.delegations.values()].some(call => !call.finished);
    }
    pendingWork(): boolean {
        return [...this.sessions.values()].some(state => state.running || state.reports.size
            || (state.pending.length > 0 && (!!state.delegation || this.bindable(state)))
            || [...state.delegations.values()].some(call => !call.finished));
    }
    private finishGroups(): void {
        for (const call of this.root.delegations.values()) {
            if (!call.collector || !call.finished || call.collector.trace.endedAt) continue;
            const under = (state: NativeSession) => this.group(state) === call;
            if ([...this.sessions.values()].some(state => under(state) && (state.running || state.reports.size || [...state.delegations.values()].some(nested => !nested.finished)))) continue;
            call.collector.finish(call.stopped ? 'cancelled' : call.error ? 'error' : 'done', call.report);
        }
    }
    /** A stopped child may never produce a parent tool result (background
     *  launches already returned). Settle the delegation once its subtree is
     *  idle so `pendingWork()` releases the turn instead of holding Stop. */
    private settleStopped(): void {
        for (const call of this.root.delegations.values()) {
            if (!call.stopped || call.finished || !call.child) continue;
            const under = (state: NativeSession) => this.group(state) === call;
            if ([...this.sessions.values()].some(state => under(state) && (state.running || state.reports.size || [...state.delegations.values()].some(nested => !nested.finished)))) continue;
            call.finished = true; call.error = true; call.report = 'Stopped by the user.';
        }
    }
    finish(status: 'cancelled' | 'interrupted' | 'error'): void {
        for (const call of this.root.delegations.values()) if (call.collector && !call.collector.trace.endedAt) call.collector.finish(status, call.report);
    }
    /** Returns true for child events: their prose/tools stay out of the parent
     * ledger. Usage is returned separately by the adapter for shared accounting. */
    accept(event: NativeEvent): boolean {
        const data = event.data;
        if (event.type === 'session.created' && typeof data.parentID === 'string' && this.owns(data.parentID)) {
            const id = text(data.sessionID);
            const model = record(data.model);
            if (!id || this.sessions.has(id)) return true;
            this.add(id, data.parentID, model.providerID && model.id ? `${model.providerID}/${model.id}` : this.sessions.get(data.parentID)!.model, text(data.agent));
            return true;
        }
        const form = record(data.form);
        const sessionID = event.type === 'form.created' ? text(form.sessionID) : text(data.sessionID);
        const state = this.sessions.get(sessionID);
        if (!state) return true;
        const child = state !== this.root;
        if (child && !state.delegation) {
            // Stop still reaches an announced child before progress attaches it.
            const size = JSON.stringify(event).length;
            if (state.pending.length >= 128 || state.pendingChars + size > 128_000) throw new Error('OpenCode unbound child event limit exceeded');
            state.pending.push(event); state.pendingChars += size;
            return true;
        }
        const id = text(data.id);
        const displayID = this.displayID(sessionID, id);
        switch (event.type) {
            case 'session.execution.started': state.running = true; state.reasoning = ''; state.execution++; state.calls.clear(); break;
            case 'session.execution.succeeded':
            case 'session.execution.failed':
            case 'session.execution.interrupted':
                state.running = false;
                // A user-stopped child ends interrupted by design; only a real
                // runtime failure should paint an error on its observation.
                if (child && event.type !== 'session.execution.succeeded' && !this.group(state)?.stopped) this.emit(state, { type: 'error', value: text(record(data.error).message) || event.type });
                break;
            case 'session.model.selected':
            case 'session.step.started': {
                const model = record(data.model);
                if (model.providerID && model.id) state.model = `${model.providerID}/${model.id}`;
                const group = this.group(state);
                if (group?.child === state && group.collector) group.collector.trace.model = state.model;
                break;
            }
            case 'session.tool.input.started': state.calls.set(id, { name: text(data.name), input: {} }); break;
            case 'session.tool.called': {
                if (state.calls.size >= 1024) throw new Error('OpenCode pending tool limit exceeded');
                const call = state.calls.get(id) ?? { name: text(data.name), input: {} };
                call.input = record(data.input); state.calls.set(id, call);
                if (call.name === 'subagent' && !state.delegations.has(displayID)) {
                    if (state.delegations.size >= 512) throw new Error('OpenCode delegation limit exceeded');
                    const input = { agent: text(call.input.agent).slice(0, 160), description: text(call.input.description).slice(0, 1000), prompt: text(call.input.prompt).slice(0, 8000), sessionID: text(call.input.sessionID).slice(0, 100), background: call.input.background === true };
                    const delegation: Delegation = { owner: state, id: displayID, nativeID: id, input, finished: false, error: false };
                    state.delegations.set(displayID, delegation);
                    if (state === this.root) delegation.collector = this.collector(delegation);
                }
                if (child) this.emit(state, { type: 'toolCall', id: displayID, tool: this.displayName(call.name), args: nativeToolDisplayArgs(this.displayName(call.name), call.input) });
                break;
            }
            case 'session.tool.progress': {
                const call = state.delegations.get(displayID);
                const childID = record(data.metadata).sessionID;
                if (call && typeof childID === 'string') this.attach(call, childID);
                break;
            }
            case 'session.tool.success':
            case 'session.tool.failed': {
                const call = state.calls.get(id);
                const delegation = state.delegations.get(displayID);
                const metadata = record(data.metadata);
                const content = mapMcpToolContent(Array.isArray(data.content) ? data.content : []);
                const research = readResearchEvidence(data.xratuResearch);
                const isError = !!research && !['success', 'empty'].includes(research.outcome) || event.type.endsWith('failed') || (typeof metadata.exit === 'number' && metadata.exit !== 0);
                if (delegation) {
                    if (typeof metadata.sessionID === 'string') this.attach(delegation, metadata.sessionID);
                    // Launch success for a background call is not completion.
                    if (metadata.status !== 'running' || isError) {
                        delegation.finished = true; delegation.error = isError;
                        delegation.report = reportText(content.text || text(record(data.error).message));
                        if (typeof call?.input.sessionID === 'string') this.release(call.input.sessionID, sessionID, id);
                    }
                }
                if (child) this.emit(state, { type: 'toolResult', id: displayID, tool: this.displayName(call?.name ?? 'tool'), output: content.text || text(record(data.error).message), isError, ...(data.xratuResearch ? { research: readResearchEvidence(data.xratuResearch) } : {}) });
                state.calls.delete(id);
                break;
            }
            case 'session.text.delta': if (child) this.emit(state, { type: 'chunk', value: text(data.delta) }); break;
            case 'session.reasoning.delta':
                state.reasoning = (state.reasoning + text(data.delta)).slice(-12_000);
                if (child) this.emit(state, { type: 'thinking', value: state.reasoning });
                break;
            case 'session.inbox.enqueued': {
                const item = record(data.item); const payload = record(item.payload); const metadata = record(payload.metadata);
                if (item.type !== 'synthetic' || metadata.source !== 'subagent') break;
                const call = this.sessions.get(text(metadata.childID))?.delegation;
                if (!call || call.owner !== state) break;
                state.reports.add(text(data.inboxID));
                call.finished = true; call.error = metadata.state === 'error' || metadata.state === 'cancelled'; call.report = reportText(text(payload.text));
                if (typeof call.input.sessionID === 'string') this.release(call.input.sessionID, sessionID, call.nativeID);
                break;
            }
            case 'session.inbox.delivered':
                // Delivery can precede execution.started. Keep ownership until
                // the execution answering this report emits its terminal.
                if (state.reports.delete(text(data.inboxID))) state.running = true;
                break;
            case 'session.inbox.cancelled': state.reports.delete(text(data.inboxID)); break;
        }
        this.settleStopped();
        this.finishGroups();
        return child;
    }
    usage(sessionID: string, event: LocalAgentEvent): void { const state = this.sessions.get(sessionID); if (state && state !== this.root) this.emit(state, event); }
}

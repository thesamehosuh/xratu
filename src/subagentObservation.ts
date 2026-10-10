import type { LocalAgentEvent } from './local/localTypes';

export interface SubagentApprovalSource { parentCallId: string; profile: string; description: string }

/** Display-only child history. Never enters the parent's model ledger. */
export interface SubagentTraceEntry {
    id: string;
    kind: 'text' | 'thinking' | 'tool';
    text: string;
    startedAt: number;
    endedAt?: number;
    tool?: string;
    output?: string;
    live?: string;
    isError?: boolean;
    /** Transient host-sanitized markup; disk normalization always discards it. */
    html?: string;
}
export interface SubagentTrace {
    taskId: string;
    profile: string;
    description: string;
    prompt: string;
    model: string;
    effort?: string;
    tools: string[];
    resumed: boolean;
    status: 'running' | 'waiting' | 'done' | 'error' | 'cancelled' | 'interrupted';
    startedAt: number;
    updatedAt: number;
    endedAt?: number;
    entries: SubagentTraceEntry[];
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    report?: string;
    error?: string;
    pendingTools?: string[];
    truncated?: boolean;
}
export const TRACE_ENTRIES = 120;
export const TRACE_CHARS = 48_000;
/** Older run details can be reclaimed without removing their task identity. */
export const SESSION_TRACE_CHARS = 512_000;

export function boundSubagentEvents<T extends { subagent?: unknown }>(groups: T[][]): T[][] {
    let budget = SESSION_TRACE_CHARS;
    return groups.map(group => [...group]).reverse().map(group => group.reverse().map(event => {
        if (!event?.subagent) return event;
        let trace = readSubagentTrace(event.subagent);
        if (!trace) return { ...event, subagent: undefined };
        const size = JSON.stringify(trace).length;
        if (size > budget) {
            trace = { ...trace, entries: [], prompt: '', report: undefined, error: undefined, tools: [], pendingTools: undefined, truncated: true };
        } else budget -= size;
        return { ...event, subagent: trace };
    }).reverse()).reverse();
}

/** Bound and validate disk data too; old/malformed sessions remain readable. */
export function readSubagentTrace(value: unknown, restored = false): SubagentTrace | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as SubagentTrace;
    const states = ['running', 'waiting', 'done', 'error', 'cancelled', 'interrupted'];
    if (typeof v.taskId !== 'string' || !v.taskId || typeof v.profile !== 'string' || !states.includes(v.status) || !Array.isArray(v.entries)) return undefined;
    let budget = TRACE_CHARS;
    let truncated = !!v.truncated || v.entries.length > TRACE_ENTRIES;
    const text = (s: unknown, cap = 8_000): string => {
        if (typeof s !== 'string') return '';
        const kept = s.slice(0, Math.max(0, Math.min(cap, budget)));
        if (kept.length < s.length) truncated = true;
        budget -= kept.length;
        return kept;
    };
    const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
    const result: SubagentTrace = {
        taskId: v.taskId.slice(0, 100), profile: v.profile.slice(0, 160),
        description: text(v.description, 1_000), prompt: text(v.prompt), model: text(v.model, 160), effort: text(v.effort, 40) || undefined,
        tools: Array.isArray(v.tools) ? v.tools.filter((s): s is string => typeof s === 'string').slice(0, 100).map(s => s.slice(0, 160)) : [],
        resumed: !!v.resumed, status: restored && ['running', 'waiting'].includes(v.status) ? 'interrupted' : v.status,
        startedAt: number(v.startedAt), updatedAt: number(v.updatedAt), endedAt: v.endedAt === undefined ? undefined : number(v.endedAt),
        toolCalls: number(v.toolCalls), inputTokens: number(v.inputTokens), outputTokens: number(v.outputTokens),
        report: text(v.report, 12_000) || undefined, error: text(v.error, 2_000) || undefined,
        pendingTools: Array.isArray(v.pendingTools) ? v.pendingTools.filter(s => typeof s === 'string').slice(0, 40).map(s => s.slice(0, 160)) : undefined,
        entries: [],
    };
    // Preserve the newest work when the trace reaches its bounded history.
    for (const e of v.entries.slice(-TRACE_ENTRIES).reverse()) {
        if (!e || !['text', 'thinking', 'tool'].includes(e.kind) || typeof e.id !== 'string') continue;
        result.entries.unshift({ id: e.id.slice(0, 160), kind: e.kind, text: text(e.text), startedAt: number(e.startedAt),
            endedAt: e.endedAt === undefined ? undefined : number(e.endedAt), tool: text(e.tool, 160) || undefined,
            output: e.output === undefined ? undefined : text(e.output), live: e.live === undefined ? undefined : text(e.live), isError: !!e.isError });
    }
    result.truncated = truncated;
    return result;
}

/** Assemble actual nested-loop events rather than infer activity from prose. */
export class SubagentTraceCollector {
    private sequence = 0;
    private lastEmit = 0;
    constructor(public trace: SubagentTrace, private publish: (trace: SubagentTrace) => void, private now = Date.now) { this.emit(true); }
    private emit(force = false) {
        const now = this.now();
        this.trace.updatedAt = now;
        if (!force && now - this.lastEmit < 80) return;
        this.lastEmit = now;
        const snapshot = readSubagentTrace(this.trace)!;
        this.trace = { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry })) };
        this.publish(snapshot);
    }
    receive(event: LocalAgentEvent) {
        const trace = this.trace;
        const now = this.now();
        const last = trace.entries.at(-1);
        switch (event.type) {
            case 'chunk':
                if (last?.kind === 'thinking' && !last.endedAt) last.endedAt = now;
                if (last?.kind === 'text' && !last.endedAt) last.text = (last.text + event.value).slice(-12_000);
                else trace.entries.push({ id: `text-${++this.sequence}`, kind: 'text', text: event.value, startedAt: now });
                break;
            case 'thinking':
                if (last?.kind === 'text' && !last.endedAt) last.endedAt = now;
                if (last?.kind === 'thinking' && !last.endedAt) last.text = event.value.slice(-12_000);
                else trace.entries.push({ id: `think-${++this.sequence}`, kind: 'thinking', text: event.value.slice(-12_000), startedAt: now });
                break;
            case 'assistantMessage':
                if (last?.kind === 'thinking' && !last.endedAt) last.endedAt = now;
                if (last?.kind === 'text' && !last.endedAt) { last.text = event.text.slice(0, 12_000); last.endedAt = now; }
                else if (event.text) trace.entries.push({ id: `text-${++this.sequence}`, kind: 'text', text: event.text.slice(0, 12_000), startedAt: now, endedAt: now });
                break;
            case 'toolCall':
                if (last && last.kind !== 'tool' && !last.endedAt) last.endedAt = now;
                trace.status = 'running'; trace.pendingTools = undefined; trace.toolCalls++;
                trace.entries.push({ id: event.id, kind: 'tool', tool: event.tool, text: JSON.stringify(event.args), startedAt: now });
                break;
            case 'toolOutput': {
                const entry = trace.entries.find(e => e.kind === 'tool' && e.id === event.id);
                if (entry) { const text = (entry.live ?? '') + event.value; entry.live = text.slice(-8_000); if (text.length > 8_000) trace.truncated = true; }
                break;
            }
            case 'toolResult': {
                const entry = trace.entries.find(e => e.kind === 'tool' && e.id === event.id);
                trace.status = 'running'; trace.pendingTools = undefined;
                if (entry) { entry.output = event.output.slice(0, 8_000); entry.endedAt = now; entry.isError = !!event.isError; entry.live = undefined; }
                if (event.output.length > 8_000) trace.truncated = true;
                break;
            }
            case 'needsApproval': trace.status = 'waiting'; trace.pendingTools = event.approvals.map(a => a.tool_name); break;
            case 'usage':
                if (!event.estimated) { trace.inputTokens += event.usage.promptTokens ?? 0; trace.outputTokens += event.usage.completionTokens ?? 0; }
                break;
            case 'error': trace.error = event.value.slice(0, 2_000); break;
            default: return;
        }
        if (['chunk', 'thinking', 'assistantMessage'].includes(event.type) && trace.entries.some(entry => entry.text.length >= 12_000)) trace.truncated = true;
        if (trace.entries.length > TRACE_ENTRIES) { trace.entries = trace.entries.slice(-TRACE_ENTRIES); trace.truncated = true; }
        this.emit(['toolCall', 'toolResult', 'needsApproval', 'assistantMessage', 'error', 'usage'].includes(event.type));
    }
    finish(status: SubagentTrace['status'], report?: string) {
        this.trace.status = status; this.trace.report = report; this.trace.endedAt = this.now(); this.trace.pendingTools = undefined;
        for (const entry of this.trace.entries) if (!entry.endedAt) entry.endedAt = this.trace.endedAt;
        this.emit(true);
    }
}

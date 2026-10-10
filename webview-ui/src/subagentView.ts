import type { ChatMessage, Step, SubagentTrace } from './types';

export interface AgentRun { id: string; call: Step; trace?: SubagentTrace; title: string; profile: string; status: SubagentTrace['status'] | 'queued'; createdAt: number }
export function collectAgentRuns(messages: ChatMessage[]): AgentRun[] {
    return messages.flatMap(message => message.steps.filter(step => step.kind === 'toolCall' && step.tool === 'task').map(call => {
        let args: Record<string, unknown> = {};
        try { const value = JSON.parse(call.text); if (value && typeof value === 'object' && !Array.isArray(value)) args = value; } catch { /* Legacy malformed arguments remain inspectable. */ }
        const trace = call.subagent;
        const done = call.result !== undefined;
        const status = trace?.status ?? (done ? /^Subagent (?:failed|run cancelled)|finished without a final report/.test(call.result!) ? 'error' : 'done' : message.status !== 'streaming' ? 'interrupted' : call.live ? 'running' : 'queued');
        return { id: call.id, call, trace, title: trace?.description || String(args.description ?? args.subagent_type ?? ''), profile: trace?.profile || String(args.subagent_type ?? args.task_id ?? ''), status, createdAt: call.startedAt ?? message.createdAt };
    }));
}

/** Reuse the real transcript renderers; child tools never acquire execution controls. */
export function agentMessage(run: AgentRun): ChatMessage {
    const trace = run.trace;
    const steps: Step[] = trace?.entries.map(entry => ({
        id: `${run.id}:${entry.id}`, kind: entry.kind === 'tool' ? 'toolCall' : entry.kind,
        tool: entry.tool, text: entry.text, html: entry.html, startedAt: entry.startedAt, endedAt: entry.endedAt,
        callId: entry.kind === 'tool' ? `${run.id}:${entry.id}` : undefined, result: entry.output,
        live: entry.live, isError: entry.isError,
        interrupted: entry.kind === 'tool' && entry.output === undefined && !['queued', 'running', 'waiting'].includes(run.status),
    })) ?? [];
    return { id: run.id, role: 'assistant', text: trace?.entries.filter(entry => entry.kind === 'text').map(entry => entry.text).join('\n\n') ?? '', steps, createdAt: trace?.startedAt ?? run.createdAt,
        completedAt: trace?.endedAt, status: ['queued', 'running', 'waiting'].includes(run.status) ? 'streaming' : run.status === 'done' ? 'done' : 'error' };
}

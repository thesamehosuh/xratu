import type { ChildSession, ExecutionState } from './types';
import type { SubagentTrace } from '../subagentObservation';

interface DisplayCheckpoint {
    parentCallId?: string;
    definition?: {model?: string; reasoningEffort?: string; maxRounds?: number};
    contextIdentity?: {model: string};
    trace?: SubagentTrace;
    rows?: Array<{role: string; content?: string; tool_calls?: Array<{id?: unknown; function?: {name?: unknown; arguments?: unknown}}>; tool_call_id?: unknown; isError?: boolean; compactedToolCalls?: string[]}>;
}

export interface ChildSessionView {
    id: string;
    title: string;
    profile: string;
    state: ExecutionState | 'idle' | 'waiting_for_approval' | 'waiting_for_answer';
    readOnly?: boolean;
    configurable?: boolean;
    limited?: boolean;
    parentCallId?: string;
    liveText?: string;
    model?: string;
    effort?: string;
    rounds?: number;
    reportState?: 'pending' | 'delivered';
    revision: number;
    generation?: number;
    displayRevision?: number;
    activeTool?: {name: string; live?: string};
    queued: number;
    receipts: Array<{id: string; state: 'queued' | 'delivered' | 'cancelled'}>;
    error?: string;
    errorKey?: 'childStorageFailed';
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'tool'; content: string; html?: string; source?: 'parent' | 'user'; toolCalls?: Array<{id: string; name: string; arguments: string; live?: string}>; toolCallId?: string; isError?: boolean }>;
}
/** Project plain display content only; provider-native replay carriers stay on the host. */
export function childSessionView(session: ChildSession, render?: (text: string) => string): ChildSessionView {
    const record = session.checkpoint as DisplayCheckpoint | undefined;
    const execution = session.executions.at(-1);
    const liveTrace = execution?.state === 'running' && record?.trace?.generation === session.generation ? record.trace : undefined;
    const activeTool = liveTrace?.entries.slice().reverse().find(entry => entry.kind === 'tool' && !entry.endedAt);
    return { id: session.id, title: session.title, profile: session.profile, state: liveTrace?.status === 'waiting' ? liveTrace.pendingTools?.includes('ask_session_question') ? 'waiting_for_answer' : 'waiting_for_approval' : execution?.state ?? 'idle',
        parentCallId: record?.parentCallId,
        model: record?.definition?.model ?? record?.contextIdentity?.model,
        effort: record?.definition?.reasoningEffort,
        rounds: record?.definition?.maxRounds ?? 50,
        reportState: session.results.at(-1)?.state,
        liveText: liveTrace?.entries.slice().reverse().find(entry => entry.kind === 'text' && !entry.endedAt)?.text,
        activeTool: activeTool ? {name: activeTool.tool ?? '', live: activeTool.live} : undefined,
        revision: session.revision, queued: session.messages.filter(message => message.state === 'queued').length,
        generation: session.generation,
        displayRevision: record?.trace?.generation === session.generation ? record.trace.sequence ?? record.trace.updatedAt : undefined,
        error: execution?.error,
        errorKey: execution?.errorCode === 'storage_failed' ? 'childStorageFailed' : undefined,
        receipts: session.messages.slice(-100).map(message => ({id: message.id, state: message.state})),
        limited: (record?.rows??[]).some(row=>(row.content?.length??0)>24_000) || record?.trace?.truncated,
        messages: (record?.rows ?? []).filter(row => ['user', 'assistant', 'tool'].includes(row.role) && !row.compactedToolCalls).flatMap((row, index) =>
            displayInstructions(row.role,row.content??'').map((part,partIndex)=>({
                id: `${session.id}:${index}:${partIndex}`, role: row.role as 'user' | 'assistant' | 'tool',
                ...part, content:part.content.slice(0,24_000),
                ...(row.role === 'assistant' && Array.isArray(row.tool_calls) ? {toolCalls: row.tool_calls.slice(0, 100).flatMap(call => typeof call?.id === 'string' && typeof call.function?.name === 'string' ? [{id: call.id.slice(0, 300), name: call.function.name.slice(0, 300), arguments: typeof call.function.arguments === 'string' ? call.function.arguments.slice(0, 24_000) : ''}] : [])} : {}),
                ...(row.role === 'tool' && typeof row.tool_call_id === 'string' ? {toolCallId: row.tool_call_id.slice(0, 300), isError: row.isError === true} : {}),
                ...(row.role==='assistant'&&render?{html:render(part.content.slice(0,24_000))}:{}),
            }))),
    };
}

function displayInstructions(role: string, content: string): Array<{content: string; source?: 'parent' | 'user'}> {
    if(role==='user') {
        try {
            const packets=content.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line) as {sender?: unknown; instruction?: unknown});
            if(packets.length && packets.every(value=>(value.sender==='parent'||value.sender==='user')&&typeof value.instruction==='string')) {
                return packets.map(value=>({content:value.instruction as string,source:value.sender as 'parent'|'user'}));
            }
        } catch { /* Older child ledgers carry plain text. */ }
        const legacy=/^\[(parent|user)\]\n([\s\S]*)$/.exec(content);
        if(legacy) return [{content:legacy[2],source:legacy[1] as 'parent'|'user'}];
    }
    return [{content}];
}

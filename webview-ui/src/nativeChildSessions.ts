import type { ChildSessionView } from '../../src/sessions/view';
import type { AgentRun } from './subagentView';

/** Native observations keep native identity; they never pretend to be replayable local ledgers. */
export function nativeChildSessions(runs: AgentRun[]): ChildSessionView[] {
    const sessions = new Map<string, ChildSessionView>();
    for (const run of runs) {
        const trace = run.trace;
        if (!trace) continue;
        const id = trace.taskId;
        const previous = sessions.get(id);
        const state = trace.status === 'done' ? 'completed' : trace.status === 'error' ? 'failed'
            : trace.status === 'waiting' ? trace.pendingTools?.includes('ask_user_question') ? 'waiting_for_answer' : 'waiting_for_approval' : trace.status;
        const messages: ChildSessionView['messages'] = trace.entries.filter(entry => entry.kind !== 'thinking').flatMap((entry): ChildSessionView['messages'] => {
            const id = `${run.id}:${entry.id}`;
            if (entry.kind === 'tool') return [
                {id, role:'assistant' as const, content:'', toolCalls:[{id, name:entry.tool ?? '', arguments:entry.text}]},
                ...(entry.output !== undefined || entry.live !== undefined ? [{id:`${id}:result`, role:'tool' as const, content:entry.output ?? entry.live ?? '', toolCallId:id, isError:entry.isError}] : []),
            ];
            return [{id, role:entry.kind === 'user' ? 'user' as const : 'assistant' as const, ...(entry.kind === 'user' ? {source:'user' as const} : {}), content:entry.text, ...(entry.html ? {html:entry.html} : {})}];
        });
        sessions.set(id,{id,title:run.title,profile:run.profile,state,revision:trace.updatedAt,queued:trace.pendingInstructions??0,receipts:[],
            parentCallId:run.call.callId,model:trace.model,effort:trace.effort,readOnly:!trace.canSend,configurable:false,limited:trace.truncated,
            messages:[...(previous?.messages??[]),...messages],error:trace.error});
    }
    return [...sessions.values()];
}

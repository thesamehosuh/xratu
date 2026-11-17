import type { ChildSessionView } from '../../src/sessions/view';
import type { ChatMessage, Step } from './types';

/** Convert display-only child rows into the same paired tool steps as chat. */
export function childTranscript(child: ChildSessionView): ChatMessage[] {
    const results = new Map(child.messages.filter(row => row.role === 'tool' && row.toolCallId).map(row => [row.toolCallId!, row]));
    const live = ['queued', 'running', 'waiting_for_workspace', 'waiting_for_approval', 'waiting_for_answer', 'stopping'].includes(child.state);
    const messages: ChatMessage[] = child.messages.filter(row => row.role === 'assistant').map(row => {
        const steps: Step[] = [];
        if (row.content) steps.push({id: `${row.id}:text`, kind: 'text', text: row.content, html: row.html});
        for (const call of row.toolCalls ?? []) {
            const result = results.get(call.id);
            steps.push({id: `${row.id}:${call.id}`, kind:'toolCall', callId:call.id, tool:call.name, text:call.arguments,
                result:result?.content, isError:result?.isError, interrupted:!result && !live});
        }
        return {id:row.id, role:'assistant', text:row.content, steps, status:live ? 'streaming' : 'done', createdAt:0};
    });
    const declared = new Set(child.messages.flatMap(row => row.toolCalls?.map(call => call.id) ?? []));
    for (const row of child.messages.filter(row => row.role === 'tool' && (!row.toolCallId || !declared.has(row.toolCallId)))) {
        messages.push({id:row.id, role:'assistant', text:'', status:'done', createdAt:0,
            steps:[{id:`${row.id}:output`, kind:'toolResult', text:row.content, isError:row.isError}]});
    }
    if (child.activeTool) messages.push({id:`${child.id}:active`, role:'assistant', text:'', status:'streaming', createdAt:0,
        steps:[{id:`${child.id}:active-tool`, kind:'toolCall', tool:child.activeTool.name, text:'', live:child.activeTool.live}]});
    return messages;
}

import type { LocalToolDefinition } from '../local/localTypes';
import type { SubagentDefinition, SubagentRunner } from '../subagents';
import { buildTaskToolSchema, buildTaskToolDescription } from '../subagents';

export const SESSION_TOOLS = new Set(['spawn_agent', 'send_agent', 'inspect_agents', 'wait_agents', 'stop_agent']);
export function sessionToolDefinitions(profiles: readonly SubagentDefinition[]): LocalToolDefinition[] {
    const reference = { type: 'string', description: 'Durable child session ID returned by spawn_agent or inspect_agents.' };
    return [
        { name: 'spawn_agent', description: `${buildTaskToolDescription(profiles)} Launches in the background and returns its durable ID immediately. Use send_agent for follow-ups and wait_agents for required results before finishing.`, inputSchema: buildTaskToolSchema(profiles), requiresApproval: false },
        { name: 'send_agent', description: 'Send a follow-up assignment to an existing child conversation. Queues behind active work without discarding its context. Returns a receipt immediately; wait_agents receives the result.', inputSchema: { type: 'object', properties: { session_id: reference, prompt: {type:'string'} }, required:['session_id','prompt'] }, requiresApproval: false },
        { name: 'inspect_agents', description: 'Inspect this conversation’s child sessions, execution states, queued instructions and latest results. Does not start model work.', inputSchema: {type:'object',properties:{}}, requiresApproval:false },
        { name: 'wait_agents', description: 'Wait for selected child sessions to settle and receive their reports. Event-driven: do useful independent work before waiting; do not poll inspect_agents repeatedly.', inputSchema:{type:'object',properties:{session_ids:{type:'array',items:reference,minItems:1,maxItems:32}},required:['session_ids']},requiresApproval:false },
        { name: 'stop_agent', description:'Cancel one child’s active work and queued instructions while preserving its conversation. Continue later with send_agent.',inputSchema:{type:'object',properties:{session_id:reference},required:['session_id']},requiresApproval:false },
    ];
}
export async function executeSessionTool(name: string, args: Record<string, unknown>, runner: SubagentRunner | undefined, callId?: string, signal?: AbortSignal): Promise<{output:string;isError?:boolean}> {
    if (!runner?.sessions) return {output:'Child session coordination is unavailable in this context.',isError:true};
    if (name==='inspect_agents') return {output:JSON.stringify((await runner.sessions()).map(session=>({id:session.id,title:session.title,profile:session.profile,state:session.executions.at(-1)?.state??'idle',queued:session.messages.filter(message=>message.state==='queued').length,latestResult:session.results.at(-1)})))};
    if (name==='wait_agents') {
        if (!Array.isArray(args.session_ids)||!args.session_ids.length||args.session_ids.length>32||!args.session_ids.every(id=>typeof id==='string')) return {output:'Provide 1–32 child session IDs.',isError:true};
        if (!runner.wait) return {output:'Waiting is unavailable.',isError:true};
        const sessions = await runner.wait(args.session_ids as string[],signal);
        return {output:JSON.stringify(sessions.map(session => ({session_id:session.id,state:session.executions.at(-1)?.state,
            results:session.results.slice(-16)})))};
    }
    const sessionId=typeof args.session_id==='string'?args.session_id:'';
    if (!sessionId) return {output:'Missing session_id.',isError:true};
    if (name==='stop_agent') { await runner.stop?.(sessionId);return {output:'Stop requested; inspect or wait for settlement.'}; }
    if (typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>100000) return {output:'Provide a nonempty prompt of at most 100000 characters.',isError:true};
    return runner.run({taskId:sessionId,subagentType:'',description:'',prompt:args.prompt,parentCallId:callId,background:true});
}

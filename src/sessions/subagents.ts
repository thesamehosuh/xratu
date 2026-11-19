import { randomUUID } from 'crypto';
import {mutatesWorkspace} from './resources';
import { SessionCoordinator } from './coordinator';
import { runSubagentTask, type SubagentHostContext, type SubagentRunRecord, type SubagentRunRegistry } from '../local/subagentRunner';
import { resolveSubagent, type SubagentDefinition, type SubagentRunRequest, type SubagentRunner } from '../subagents';
import type { ChildSession, SessionDriver } from './types';

/** Heal only the model protocol; never repeat a tool whose result was lost. */
export function recoverChildHistory(record: SubagentRunRecord): SubagentRunRecord {
    const rows: SubagentRunRecord['rows'] = [];
    let pending = new Set<string>();
    const settle = () => {
        for (const id of pending) rows.push({ role: 'tool', tool_call_id: id, isError: true,
            content: 'Execution was interrupted before this result was committed. Effects may already have occurred. Inspect current state before repeating this action.' });
        pending = new Set();
    };
    for (const row of record.rows) {
        if (row.role !== 'tool') settle();
        rows.push(row);
        if (row.role === 'assistant') pending = new Set((row.tool_calls ?? []).map(call => String(call.id)));
        if (row.role === 'tool' && row.tool_call_id) pending.delete(row.tool_call_id);
    }
    settle();
    return { ...record, rows, running: false };
}

/** Built-in engine driver. UI and parent follow-ups share the same admission path. */
export class CoordinatedSubagents implements SubagentRunner {
    private ready: Promise<SessionCoordinator>;
    constructor(private host: SubagentHostContext, private definitions: readonly SubagentDefinition[],
        private readonly registry: SubagentRunRegistry) {
        this.ready = this.connect(host);
        void this.ready.catch(() => undefined);
    }
    private connect(host: SubagentHostContext): Promise<SessionCoordinator> {
        return SessionCoordinator.open(host.store!, host.maxParallel ?? 4).then(coordinator => {
            for (const session of coordinator.list()) this.bind(coordinator, session);
            coordinator.subscribe(sessions => this.host.onSessions?.(sessions));
            return coordinator;
        });
    }
    configure(host: SubagentHostContext, definitions: readonly SubagentDefinition[]): void {
        this.host = host; this.definitions = definitions;
        this.ready = this.ready.catch(() => this.connect(host)).then(async coordinator => {
            if (coordinator.unavailable) {
                await coordinator.close();
                return this.connect(host);
            }
            coordinator.setCapacity(host.maxParallel ?? 4);
            this.host.onSessions?.(coordinator.list());
            return coordinator;
        });
        void this.ready.catch(() => undefined);
    }
    private seed(definition: SubagentDefinition): SubagentRunRecord {
        const conversationId=randomUUID();
        const base=this.host.baseRequest(definition,conversationId);
        return {defName:definition.name,rows:[],startedAt:Date.now(),conversationId,
            definition:{...structuredClone(definition),model:base.model,reasoningEffort:base.reasoningEffort},
            contextIdentity:{connectionId:this.host.connectionId,baseUrl:base.baseUrl,model:base.model,apiStyle:base.apiStyle}};
    }
    private bind(coordinator: SessionCoordinator, session: ChildSession, parentCallId?: string): void {
        const driver: SessionDriver = { execute: async execution => {
            const saved = execution.session.checkpoint as SubagentRunRecord | undefined;
            if (saved?.contextIdentity?.connectionId && saved.contextIdentity.connectionId !== this.host.connectionId) throw new Error('Reconnect the original child model connection before continuing.');
            if (saved) this.registry.set(session.id, recoverChildHistory(saved));
            else if (!this.registry.has(session.id)) this.registry.set(session.id, {
                defName: session.profile, rows: [], startedAt: Date.now(),
                definition: structuredClone(resolveSubagent(this.definitions, session.profile)!),
            });
            let latestRecord = this.registry.get(session.id)!;
            const committed = new Set(latestRecord.deliveredMessageIds ?? []);
            // Delivery and a model checkpoint are separate durable boundaries.
            // On an explicit resume, preserve instructions accepted just before
            // a crash without ever replaying a tool or starting work on restore.
            const prompts = execution.session.messages.filter(message => execution.execution.messageIds.includes(message.id)
                || message.state === 'delivered' && !committed.has(message.id));
            latestRecord.deliveredMessageIds = [...new Set([...committed, ...prompts.map(message => message.id)])];
            let latestTrace = latestRecord.trace;
            const run = () => runSubagentTask({ ...this.host, store: undefined,
                executionGeneration: execution.execution.generation,
                onControl: undefined,
                steerFeed: {drain: async () => (await execution.drain()).map(message => ({text:JSON.stringify({sender:message.source,instruction:message.text}),steerId:message.id}))},
                onObservation: (callId, trace) => {
                    latestTrace = trace;
                    this.host.onObservation?.(callId, trace);
                    // Streaming display traces must reach durable child views
                    // before the next model/tool checkpoint is committed.
                    this.host.onSessions?.(coordinator.list().map(child => child.id === session.id
                        ? { ...child, checkpoint: { ...latestRecord, trace } } : child));
                },
                baseRequest: (definition, conversationId) => ({ ...this.host.baseRequest(definition, conversationId), signal: execution.signal }),
                onCheckpoint: async (_id, record) => {
                    latestRecord = record;
                    await execution.checkpoint({...record, trace: latestTrace});
                },
            }, this.definitions, { taskId: session.id, subagentType: session.profile,
                description: session.title, prompt: prompts.map(message => JSON.stringify({sender:message.source,instruction:message.text})).join('\n\n'), parentCallId: parentCallId ?? session.id }, this.registry);
            const definition = latestRecord.definition ?? resolveSubagent(this.definitions, session.profile);
            const writer = definition && this.host.tools(definition).some(tool => mutatesWorkspace(tool.name));
            if (writer && this.host.withWorkspaceWriter) await execution.state('waiting_for_workspace');
            const result = writer && this.host.withWorkspaceWriter ? await this.host.withWorkspaceWriter(execution.signal, async () => {
                await execution.state('running');
                return run();
            }) : await run();
            const record = this.registry.get(session.id);
            if (record) await execution.checkpoint({...record, trace: latestTrace});
            if (result.isError && !execution.signal.aborted) throw new Error(result.output);
            return result.output.replace('resumable while this chat stays open', 'durable child session; continue with task_id');
        } };
        coordinator.bind(session.id, driver);
    }
    async run(request: SubagentRunRequest): Promise<{ output: string; isError?: boolean }> {
        try {
            const coordinator = await this.ready;
            if (request.taskId && request.model) return { output: 'Omit model when continuing an existing child.', isError: true };
            let session = request.taskId ? coordinator.list().find(item => item.id === request.taskId) : undefined;
            if (request.taskId && !session) return { output: 'Unknown child session. Start a new assignment.', isError: true };
            if (!session) {
                const definition = resolveSubagent(this.definitions, request.subagentType);
                if (!definition) return { output: 'Unknown child profile.', isError: true };
                if (request.model && !this.host.childModelIds?.has(request.model)) {
                    return { output: 'The requested model is unavailable for child tools on the active connection.', isError: true };
                }
                session = await coordinator.create(this.host.parentSessionId!, definition.name, request.description, { execute: async () => '' }, request.parentCallId,
                    this.seed(request.model ? { ...definition, model: request.model } : definition));
            }
            if (request.subagentType && request.subagentType !== session.profile) return { output: 'Child session profile mismatch.', isError: true };
            this.bind(coordinator, session, request.parentCallId ?? session.id);
            const definition = (session.checkpoint as SubagentRunRecord | undefined)?.definition ?? resolveSubagent(this.definitions, session.profile);
            if (!definition) return { output: 'Child profile is unavailable.', isError: true };
            const parentSignal = this.host.baseRequest(definition, session.id).signal;
            const stop = () => { void coordinator.stop(session!.id).catch(() => undefined); };

            try {
                if (parentSignal?.aborted) return { output: 'Parent execution cancelled.', isError: true };
                await coordinator.send(session.id, request.prompt, 'parent', request.parentCallId);
                this.host.onControl?.(request.parentCallId, stop);
                if (request.background) return {output:JSON.stringify({session_id:session.id,state:'queued',instruction:'Use send_agent for follow-ups and wait_agents for the report.'})};
                const settled = await coordinator.wait(session.id, parentSignal);
                const execution = settled.executions.at(-1)!;
                return { output: `${settled.results.at(-1)?.text ?? 'Child execution cancelled.'}\n[child_result: ${execution.id}]`, isError: execution.state !== 'completed' };
            } finally {
                this.host.onControl?.(request.parentCallId, undefined);
            }
        } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
    }
    async create(profile: string, prompt: string, receipt: string): Promise<string> {
        const coordinator = await this.ready;
        const definition=resolveSubagent(this.definitions,profile);
        if (!definition || typeof prompt!=='string' || !prompt.trim() || prompt.length>100000 || typeof receipt!=='string' || !receipt || receipt.length>200) throw new Error('Invalid child assignment');
        const session = await coordinator.create(this.host.parentSessionId!, profile, prompt.split('\n')[0].slice(0, 100), {execute: async () => ''}, receipt, this.seed(definition));
        this.bind(coordinator, session, session.id);
        await coordinator.send(session.id, prompt, 'user', receipt);
        return session.id;
    }
    async configureChild(sessionId: string, patch: {model?: string; effort?: string; rounds: number; revision: number}): Promise<void> {
        if (!Number.isInteger(patch.rounds) || patch.rounds < 1 || patch.rounds > 500 || typeof patch.model !== 'string' || patch.model.length > 300
            || typeof patch.effort !== 'string' || !['','none','minimal','low','medium','high','xhigh','max'].includes(patch.effort)) throw new Error('Invalid child model or budget');
        const coordinator = await this.ready;
        await coordinator.updateCheckpoint(sessionId, patch.revision, value => {
            const record = value as SubagentRunRecord;
            if (!record?.definition) throw new Error('Child configuration is unavailable');
            return {...record,definition:{...record.definition,model:patch.model?.trim() || undefined,
                reasoningEffort:patch.effort || undefined,maxRounds:patch.rounds}};
        });
    }
    async report(sessionId: string): Promise<import('./types').SessionResult> {
        const coordinator=await this.ready;
        const session=coordinator.list().find(child=>child.id===sessionId);
        if (!session || ['queued','running','waiting_for_workspace','stopping'].includes(session.executions.at(-1)?.state??'queued')) throw new Error('Child result is not settled');
        const result=session.results.at(-1);
        if (!result) throw new Error('No child result is available');
        return result;
    }
    async acknowledgeCommitted(ids: string[]): Promise<void> {
        const coordinator = await this.ready;
        const accepted = new Set(ids);
        for (const result of coordinator.pendingResults(this.host.parentSessionId!)) {
            if (accepted.has(result.id)) await coordinator.acknowledge(result.sessionId, result.id);
        }
    }
    async wait(sessionIds: string[], signal?: AbortSignal): Promise<ChildSession[]> {
        const coordinator=await this.ready;
        return Promise.all([...new Set(sessionIds)].map(id=>coordinator.wait(id,signal)));
    }
    async sessions(): Promise<ChildSession[]> { return (await this.ready).list(); }
    async stopAll(): Promise<void> {
        const coordinator = await this.ready;
        if(coordinator.unavailable){await coordinator.close();return;}
        const sessions = coordinator.list();
        await Promise.all(sessions.map(session => coordinator.stop(session.id)));
        await Promise.all(sessions.map(session => coordinator.wait(session.id)));
    }
    async close(): Promise<void> { await (await this.ready).close(); }
    async send(sessionId: string, text: string, receipt: string): Promise<void> {
        await (await this.ready).send(sessionId, text, 'user', receipt);
    }
    async stop(sessionId: string): Promise<void> { await (await this.ready).stop(sessionId); }
}

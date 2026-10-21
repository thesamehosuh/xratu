// Event and permission mapping adapted from T3 Code's OpenCode 2 adapter.
// Native OpenCode owns tools/history; Xratu owns the display and decision cards.
import { readResearchEvidence } from '../../web/types';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { isSessionNotFoundError, type FormInfo1, type ModelInfo, type OpenCodeClient } from '@opencode/client';
import type { LocalAgentEvent, LocalSteerMessage } from '../../local/localTypes';
import type { AgentEngine, EngineHost, EngineTurn } from '../types';
import { ENGINE_CAPABILITIES } from '../types';
import { nativeToolDisplayArgs } from './services';
import { mapMcpToolContent } from '../../mcpToolContent';
import type { NativeIntegration } from '../nativeSetup';
import { OpenCodeServer } from './server';
import { subscribeEvents } from './events';
import { openCodePermissions } from './permissions';
import { NativeShellMonitor, type NativeShellUpdate } from './shells';
import { OpenCodeMcpBridge, type NativeMcpSource } from './mcpBridge';
import { abortable } from '../../oauth/refreshLock';
import { OpenCodeAttachmentStore } from './attachments';
import { NativeDecisions } from './decisions';
import { NativeSessionCoordinator } from './coordinator';
import { NativeSessionTree } from './sessionTree';

export class EngineError extends Error {
    constructor(readonly valueKey: string) { super(valueKey); }
}
const TOOL_NAMES: Record<string, string> = { shell: 'run_terminal_command', bash: 'run_terminal_command', read: 'read_file', edit: 'edit_file', write: 'write_file', glob: 'glob_search', grep: 'grep_search', websearch: 'opencode_websearch', webfetch: 'opencode_webfetch', question: 'ask_user_question' };
function toolName(name: string): string { return name === 'subagent' ? 'task' : TOOL_NAMES[name] ?? `opencode_${name}`; }
function errorText(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    return JSON.stringify(error) ?? 'OpenCode execution failed';
}
export function isFreeModel(model: Pick<ModelInfo, 'id' | 'providerID' | 'cost'>): boolean {
    // Subscription providers also report zero token costs. Only public free
    // routes qualify for onboarding and automatic generation checks.
    const publicRoute = model.providerID === 'opencode'
        ? model.id === 'big-pickle' || model.id.endsWith('-free')
        : model.providerID === 'openrouter' && (model.id.endsWith(':free') || model.id === 'openrouter/free');
    return publicRoute && model.cost.length > 0 && model.cost.every((cost) => [cost.input, cost.output, cost.cache.read, cost.cache.write].every((value) => value === 0));
}

export class OpenCodeEngine implements AgentEngine {
    readonly id = 'opencode' as const;
    readonly capabilities = ENGINE_CAPABILITIES.opencode;
    private readonly server: Pick<OpenCodeServer, 'connect' | 'dispose'>;
    private active?: { client: OpenCodeClient; sessionID: string; signal: AbortSignal; calls: Set<string>; steers: Map<string, LocalSteerMessage>; cancelChild: (id: string) => void };
    private shellMonitor?: NativeShellMonitor;
    private probing = false;
    private coordinator?: NativeSessionCoordinator;
    private readonly mcpBridge?: OpenCodeMcpBridge;
    private readonly mcpRegistrations = new WeakMap<OpenCodeClient, Map<string, { fingerprint: string; enabled: boolean }>>();
    private mcpSync: Promise<void> = Promise.resolve();
    private readonly attachments: OpenCodeAttachmentStore;
    observeShells(sessionID: string, workspace: string, emit: (update: NativeShellUpdate) => void): void {
        this.shellMonitor ??= new NativeShellMonitor(async () => (await this.server.connect()).client, emit);
        this.shellMonitor.watch(sessionID, workspace);
    }
    backgroundJobs() { return this.shellMonitor?.views() ?? []; }
    stopShell(jobID: string): Promise<boolean> { return this.shellMonitor?.stop(jobID) ?? Promise.resolve(false); }
    /** Stop one delegated native child by the parent call identity published to
     *  the observation. Sibling children and the parent turn keep running. */
    async stopSubagent(callId: string): Promise<boolean> {
        const active = this.active;
        const coordinator = this.coordinator;
        if (!active || !coordinator) return false;
        return coordinator.requestStop(callId, sessionID => { active.cancelChild(sessionID); void this.interruptSubagent(active.client, active.signal, sessionID); });
    }
    private async interruptSubagent(client: OpenCodeClient, turnSignal: AbortSignal, sessionID: string): Promise<void> {
        const signal = AbortSignal.any([turnSignal, AbortSignal.timeout(15_000)]);
        try {
            await client.session.interrupt({ sessionID, resume: false }, { signal });
            // Inputs queued for the stopped child must not run on the next turn.
            const inbox = await client.session.inbox.list({ sessionID }, { signal });
            for (const item of inbox) await client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal });
        } catch {
            // A child that already settled is fine; whole-tree settlement
            // failures stay owned by the turn's Stop path.
        }
    }
    constructor(readonly binary: string, env?: NodeJS.ProcessEnv, server?: Pick<OpenCodeServer, 'connect' | 'dispose'>, private readonly mcpSource?: NativeMcpSource, attachmentRoot = path.join(tmpdir(), 'xratu-opencode-attachments')) {
        this.server = server ?? new OpenCodeServer(binary, env);
        this.attachments = new OpenCodeAttachmentStore(attachmentRoot);
        if (mcpSource) this.mcpBridge = new OpenCodeMcpBridge(mcpSource);
    }
    private async syncMcp(client: OpenCodeClient, workspace: string, signal: AbortSignal): Promise<void> {
        const bridge = this.mcpBridge;
        const source = this.mcpSource;
        if (!bridge || !source || this.active) return;
        const sync = this.mcpSync.catch(() => undefined).then(async () => {
            signal.throwIfAborted();
            const tools = await abortable(source.listTools(), signal);
            if (this.active) return;
            signal.throwIfAborted();
            const fingerprint = JSON.stringify([workspace, tools]);
            let registrations = this.mcpRegistrations.get(client);
            if (!registrations) { registrations = new Map(); this.mcpRegistrations.set(client, registrations); }
            const previous = registrations.get(workspace);
            bridge.setTools(tools);
            if (previous?.fingerprint === fingerprint) return;
            const location = { directory: workspace };
            if (tools.length) {
                const connection = await bridge.connect();
                // Runtime registration never writes OpenCode configuration or credentials.
                await client.mcp.add({ server: bridge.name, location, config: { type: 'remote', ...connection, oauth: false, codemode: false } }, { signal });
                // Initial Location startup connects asynchronously; explicitly connect
                // so the first model request includes the shared tool catalog.
                await client.mcp.connect({ server: bridge.name, location }, { signal });
                const registered = (await client.mcp.list({ location }, { signal })).data.find((entry) => entry.name === bridge.name);
                if (registered?.status.status !== 'connected') throw new EngineError('engineMcpBridgeFailed');
            } else if (previous?.enabled) {
                await client.mcp.remove({ server: bridge.name, location }, { signal });
            }
            registrations.set(workspace, { fingerprint, enabled: tools.length > 0 });
        });
        this.mcpSync = sync;
        await abortable(sync, signal);
    }
    async models(workspace: string, signal = AbortSignal.timeout(30_000)) {
        const { client } = await this.server.connect();
        // First location initialization can return before providers are ready.
        let result = await client.model.list({ location: { directory: workspace } }, { signal });
        for (let attempt = 0; !result.data.length && attempt < 5; attempt++) {
            await delay(200 * (attempt + 1), undefined, { signal });
            result = await client.model.list({ location: { directory: workspace } }, { signal });
        }
        return result.data.filter((model) => model.enabled && model.status !== 'deprecated' && model.capabilities.tools && model.capabilities.output.includes('text'));
    }
    async configuration(workspace: string, signal: AbortSignal) {
        const { client } = await this.server.connect();
        await this.syncMcp(client, workspace, signal);
        const input = { location: { directory: workspace } };
        let agentsErrorKey: string | undefined;
        const [integrations, servers, skills, agents] = await Promise.all([
            client.integration.list(input, { signal }), client.mcp.list(input, { signal }), client.skill.list(input, { signal }),
            client.agent.list(input, { signal }).catch(() => {
                signal.throwIfAborted();
                agentsErrorKey = 'nativeAgentsLoadFailed';
                return { data: [] };
            }),
        ]);
        return {
            integrations: integrations.data.map((entry): NativeIntegration => ({
                id: entry.id, name: entry.name,
                key: entry.methods.some((method) => method.type === 'key' && (!method.form || !Object.keys(method.form).length)),
                oauth: entry.methods.filter((method) => method.type === 'oauth' && (!method.form || !Object.keys(method.form).length)).map((method) => ({ id: 'id' in method ? method.id : '', label: 'label' in method ? method.label ?? '' : '' })),
                connections: entry.connections.map((connection) => ({ label: connection.type === 'env' ? connection.name : connection.label, source: connection.type, needsAuth: connection.status?.status === 'needs_auth' })),
            })),
            servers: servers.data.filter(server => server.name !== this.mcpBridge?.name).map(server => ({ name: server.name, status: server.status.status })),
            skills: skills.data.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
            agents: agents.data.filter(agent => !agent.hidden).map(agent => ({ id: agent.id, name: agent.name, description: agent.description, mode: agent.mode })),
            ...(agentsErrorKey ? { agentsErrorKey } : {}),
        };
    }
    async connectKey(integrationID: string, key: string, workspace: string, signal: AbortSignal): Promise<void> {
        const { client } = await this.server.connect();
        const location = { directory: workspace };
        const integration = await client.integration.get({ integrationID, location }, { signal });
        if (!integration.data.methods.some((method) => method.type === 'key' && (!method.form || !Object.keys(method.form).length))) throw new EngineError('setupNativeUnavailable');
        await client.integration.connect.key({ integrationID, key, location }, { signal });
    }
    async oauthConnect(integrationID: string, methodID: string, workspace: string, signal: AbortSignal) {
        const { client } = await this.server.connect();
        const location = { directory: workspace };
        const integration = await client.integration.get({ integrationID, location }, { signal });
        if (!integration.data.methods.some((method) => method.type === 'oauth' && method.id === methodID && (!method.form || !Object.keys(method.form).length))) throw new EngineError('setupNativeUnavailable');
        return (await client.integration.oauth.connect({ integrationID, methodID, location }, { signal })).data;
    }
    async oauthStatus(integrationID: string, attemptID: string, workspace: string, signal: AbortSignal) {
        const { client } = await this.server.connect();
        return (await client.integration.oauth.status({ integrationID, attemptID, location: { directory: workspace } }, { signal })).data;
    }
    async oauthComplete(integrationID: string, attemptID: string, workspace: string, code: string, signal: AbortSignal): Promise<void> {
        const { client } = await this.server.connect();
        await client.integration.oauth.complete({ integrationID, attemptID, location: { directory: workspace }, code }, { signal });
    }
    async oauthCancel(integrationID: string, attemptID: string, workspace: string): Promise<void> {
        const { client } = await this.server.connect();
        await client.integration.oauth.cancel({ integrationID, attemptID, location: { directory: workspace } }, { signal: AbortSignal.timeout(5000) });
    }
    async ping(modelID: string, workspace: string, signal: AbortSignal): Promise<void> {
        const catalog = await this.models(workspace, signal);
        const model = catalog.find((entry) => `${entry.providerID}/${entry.id}` === modelID);
        if (!model || !isFreeModel(model)) throw new EngineError('enginePingFreeOnly');
        const { client } = await this.server.connect();
        // Free-tier generation is permitted through the native session runner.
        // A separate adapter observes its events without taking over the chat's run.
        const probe = new OpenCodeEngine(this.binary, undefined, this.server);
        probe.probing = true;
        let sessionID: string | undefined;
        try {
            for await (const event of probe.runTurn({ prompt: 'Connectivity check. Reply only OK. Do not use any tools.', model: modelID, workspace, signal, plan: true, yolo: false }, {
                approvals: { requestApproval: async () => ({}) },
                questions: { ask: async () => ({ kind: 'dismissed' }) },
                onSession: async (session) => { sessionID = session.nativeSessionId; },
            })) { if (event.type === 'toolCall') throw new EngineError('enginePingUnexpectedTool'); }
        } finally { if (sessionID) await client.session.remove({ sessionID }, { signal: AbortSignal.timeout(5000) }).catch(() => undefined); }
    }
    async steer(message: LocalSteerMessage): Promise<boolean> {
        const active = this.active;
        if (!active || active.signal.aborted) return false;
        const id = `msg_xratu_${randomUUID()}`;
        active.steers.set(id, message);
        try {
            const prompt = await this.attachments.prepare(active.sessionID, message.text, message.attachments, active.signal);
            if (this.active !== active) { active.steers.delete(id); return false; }
            await active.client.session.prompt({ sessionID: active.sessionID, id, delivery: 'steer', ...prompt }, { signal: active.signal });
            return true;
        } catch (error) { active.steers.delete(id); throw error; }
    }
    async background(callID: string): Promise<boolean> {
        const active = this.active;
        if (!active?.calls.has(callID) || !this.shellMonitor?.hasRunningCall(callID)) return false;
        this.shellMonitor?.markUser(callID);
        await active.client.session.background({ sessionID: active.sessionID }, { signal: active.signal });
        return true;
    }
    async *runTurn(turn: EngineTurn, host: EngineHost): AsyncIterable<LocalAgentEvent> {
        turn.signal.throwIfAborted();
        const slash = turn.model.indexOf('/');
        if (slash <= 0) throw new EngineError('engineModelMissing');
        if (turn.session?.workspace && turn.session.workspace !== turn.workspace) throw new EngineError('engineWorkspaceMismatch');
        if (turn.session?.binaryPath && turn.session.binaryPath !== this.binary) throw new EngineError('engineSessionRuntimeChanged');
        yield { type: 'status', value: 'connecting' };
        const { client, baseUrl, headers } = await this.server.connect();
        turn.signal.throwIfAborted();
        await this.syncMcp(client, turn.workspace, turn.signal);
        const options = { signal: turn.signal };
        const catalogModel = turn.variant ? (await this.models(turn.workspace, turn.signal)).find((entry) => `${entry.providerID}/${entry.id}` === turn.model) : undefined;
        const variant = catalogModel?.variants.some((entry) => entry.id === turn.variant) ? turn.variant : 'default';
        const model = { providerID: turn.model.slice(0, slash), id: turn.model.slice(slash + 1), variant };
        // Keep the native tool catalog while refusing every request. Free
        // models require OpenCode's harness, including its tool definitions.
        const permissions = this.probing ? [{ action: '*', resource: '*', effect: 'ask' as const }, { action: 'subagent', resource: '*', effect: 'deny' as const }] : [
            ...openCodePermissions(turn.plan, turn.yolo),
            ...(this.mcpBridge?.hasResearch() ? ['websearch', 'webfetch'].map(action => ({ action, resource: '*', effect: 'deny' as const })) : []),
            ...(turn.plan ? this.mcpBridge?.planActions() ?? [] : this.mcpBridge?.trustedActions() ?? []).map((action) => ({ action, resource: '*', effect: 'allow' as const })),
        ];
        const mcpNames = this.mcpBridge?.toolNames();
        const displayToolName = (name: string) => mcpNames?.get(name) ?? toolName(name);
        let sessionID = turn.session?.nativeSessionId;
        if (sessionID) {
            try {
                const session = await client.session.get({ sessionID }, options);
                if (session.location.directory !== turn.workspace) throw new EngineError('engineWorkspaceMismatch');
            } catch (error) {
                turn.signal.throwIfAborted();
                if (isSessionNotFoundError(error)) throw new EngineError('engineSessionMissing');
                throw error;
            }
            // Fence the previous execution tree before changing its model/mode.
            const restored = new NativeSessionTree(client, sessionID, turn.workspace);
            try {
                const running = await restored.active(turn.signal);
                if (running.length) await restored.stop(running, AbortSignal.any([turn.signal, AbortSignal.timeout(30_000)]));
                else await restored.drainPending(sessionID, turn.signal);
                await restored.stopChildShells(turn.signal);
            } catch (error) { await this.server.dispose(); throw error; }
            await client.session.switchModel({ sessionID, model }, options);
            await client.session.switchAgent({ sessionID, agent: turn.plan ? 'plan' : 'build' }, options);
            await client.session.update({ sessionID, permissions }, options);
        } else {
            const session = await client.session.create({ model, agent: turn.plan ? 'plan' : 'build', location: { directory: turn.workspace }, permissions }, options);
            sessionID = session.id;
        }
        await host.onSession?.({ engineId: 'opencode', nativeSessionId: sessionID, workspace: turn.workspace, binaryPath: this.binary });
        const tree = new NativeSessionTree(client, sessionID, turn.workspace);
        const streamController = new AbortController();
        const abort = () => streamController.abort(turn.signal.reason);
        let decisionFailure: { error: unknown } | undefined;
        const decisions = new NativeDecisions(turn.signal, error => {
            decisionFailure ??= { error };
            streamController.abort(error);
        });
        turn.signal.addEventListener('abort', abort, { once: true });
        if (turn.signal.aborted) abort();
        const calls = new Map<string, { name: string; input: Record<string, unknown>; nativeEdit?: boolean }>();
        const childControllers = new Map<string, AbortController>();
        const active = { client, sessionID, signal: turn.signal, calls: new Set<string>(), steers: new Map<string, LocalSteerMessage>(), cancelChild: (id: string) => {
            childControllers.get(id)?.abort();
            decisions.settleSession(id);
            this.mcpBridge?.deactivate(id);
        } };
        let text = '';
        let reasoning = '';
        let completed = false;
        let executionStarted = false;
        let heldSuccess = false;
        let failedEdits = 0;
        const coordinator = new NativeSessionCoordinator(sessionID, turn.model, displayToolName,
            (callId, trace) => host.onObservation?.(callId, trace), id => {
                let controller = childControllers.get(id);
                if (!controller || controller.signal.aborted) { controller = new AbortController(); childControllers.set(id, controller); }
                this.mcpBridge?.activate(id, turn.plan, AbortSignal.any([turn.signal, controller.signal]), sessionID, turn.signal);
                this.shellMonitor?.watch(id, turn.workspace);
            });
        this.coordinator = coordinator;
        this.mcpBridge?.activate(sessionID, turn.plan, turn.signal);
        try {
            const stream = await subscribeEvents(baseUrl, headers, streamController.signal);
            // Native instructions persist separately from conversation messages.
            // Read them on resume too: a previous process may have installed an
            // older policy (or build-mode tools before switching to plan mode).
            const entries = await client.session.instructions.entry.list({ sessionID }, options);
            const current = entries.find((entry) => entry.key === 'xratu.policy');
            if (turn.context) {
                if (current?.value !== turn.context) await client.session.instructions.entry.put({ sessionID, key: 'xratu.policy', value: turn.context }, options);
            } else if (current) {
                await client.session.instructions.entry.remove({ sessionID, key: 'xratu.policy' }, options);
            }
            const prompt = await this.attachments.prepare(sessionID, turn.prompt, turn.attachments, turn.signal);
            await client.session.prompt({ sessionID, ...prompt }, options);
            this.active = active;
            for (const message of host.steer?.drain() ?? []) await this.steer(message);
            yield { type: 'status', value: 'running' };
            for await (const streamedEvent of stream) {
                const queue = [streamedEvent];
                for (let index = 0; index < queue.length; index++) {
                    const event = queue[index];
                    turn.signal.throwIfAborted();
                    if (decisionFailure) throw decisionFailure.error;
                    const data = event.data;
                    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
                        const content = mapMcpToolContent(data.content);
                        const research = this.mcpBridge?.takeResearch(String(data.sessionID), content.text);
                        if (research) data.xratuResearch = research;
                    }
                    const form = data.form as FormInfo1 | undefined;
                    const eventSessionID = String(event.type === 'form.created' ? form?.sessionID : data.sessionID);
                    if (eventSessionID === sessionID && !executionStarted && event.type !== 'session.execution.started') continue;
                    const childEvent = coordinator.accept(event);
                    queue.push(...coordinator.drain());
                    if (!coordinator.owns(eventSessionID)) continue;
                    if (!coordinator.bound(eventSessionID)) continue;
                    if (childControllers.get(eventSessionID)?.signal.aborted && ['permission.asked', 'form.created'].includes(event.type)) continue;
                    if (event.type.startsWith('session.execution.') && !event.type.endsWith('started')) decisions.settleSession(eventSessionID);
                    if (event.type === 'permission.replied') decisions.settle(`${eventSessionID}:permission:${String(data.requestID)}`, data.reply === 'reject' ? 'rejected' : 'approved');
                    if (event.type === 'form.replied' || event.type === 'form.cancelled') decisions.settle(`${eventSessionID}:form:${String(data.id)}`);
                    if (childEvent && !['permission.asked', 'form.created', 'session.step.ended'].includes(event.type)) {
                        const shellID = (data.metadata as { shellID?: unknown } | undefined)?.shellID;
                        if (typeof shellID === 'string') await this.shellMonitor?.track(shellID, eventSessionID, coordinator.displayID(eventSessionID, String(data.id)), true).catch(() => undefined);
                        if (heldSuccess && !active.steers.size && !coordinator.pendingWork() && (event.type.startsWith('session.execution.') || event.type === 'session.inbox.cancelled')) {
                            completed = true;
                            yield { type: 'assistantMessage', text, toolCalls: [] };
                            yield { type: 'status', value: 'done' };
                            return;
                        }
                        continue;
                    }
                    switch (event.type) {
                        case 'session.execution.started':
                            if (executionStarted && text) { text += '\n\n'; yield { type: 'chunk', value: '\n\n' }; }
                            executionStarted = true; heldSuccess = false; reasoning = ''; break;
                        case 'session.retry.scheduled':
                            if (this.probing) throw new Error(errorText(data.error));
                            if (typeof data.attempt === 'number' && typeof data.at === 'number' && Number.isFinite(data.attempt) && Number.isFinite(data.at)) {
                                yield { type: 'retrying', attempt: Math.max(1, data.attempt), maxAttempts: 0, nextRetryInMs: Math.max(0, data.at - Date.now()) };
                            }
                            break;
                        case 'session.step.started': yield { type: 'attempting' }; break;
                        case 'session.compaction.started': yield { type: 'engineNotice', kind: 'info', valueKey: 'engineCompacting' }; break;
                        case 'session.compaction.ended': yield { type: 'engineNotice', kind: 'info', valueKey: 'engineCompacted' }; break;
                        case 'session.compaction.failed': yield { type: 'engineNotice', kind: 'warning', valueKey: 'engineCompactionFailed', params: { error: errorText(data.error) } }; break;
                        case 'session.inbox.delivered': {
                            const message = active.steers.get(String(data.inboxID));
                            if (message) { active.steers.delete(String(data.inboxID)); yield { type: 'steer', ...message }; }
                            break;
                        }
                        case 'session.inbox.cancelled': {
                            const message = active.steers.get(String(data.inboxID));
                            if (message) { active.steers.delete(String(data.inboxID)); host.onSteerRejected?.(message.steerId); }
                            if (heldSuccess && active.steers.size === 0 && !coordinator.pendingWork()) {
                                completed = true;
                                yield { type: 'assistantMessage', text, toolCalls: [] };
                                yield { type: 'status', value: 'done' };
                                return;
                            }
                            break;
                        }
                        case 'session.text.delta':
                            if (typeof data.delta === 'string') { text += data.delta; yield { type: 'chunk', value: data.delta }; }
                            break;
                        case 'session.reasoning.delta':
                            if (typeof data.delta === 'string') { reasoning += data.delta; yield { type: 'thinking', value: reasoning }; }
                            break;
                        case 'session.tool.input.started':
                            if (typeof data.id === 'string' && typeof data.name === 'string') calls.set(coordinator.displayID(sessionID, data.id), { name: displayToolName(data.name), input: {}, nativeEdit: ['edit', 'write', 'apply_patch', 'multiedit'].includes(data.name) });
                            break;
                        case 'session.tool.called': {
                            const id = coordinator.displayID(sessionID, String(data.id));
                            const call = calls.get(id) ?? { name: 'opencode_tool', input: {} };
                            call.input = data.input && typeof data.input === 'object' ? data.input as Record<string, unknown> : {};
                            calls.set(id, call);
                            if (call.name === 'run_terminal_command') active.calls.add(id);
                            yield { type: 'toolCall', id, tool: call.name, args: nativeToolDisplayArgs(call.name, call.input) };
                            break;
                        }
                        case 'session.tool.progress': {
                            const metadata = data.metadata as { shellID?: string } | undefined;
                            if (typeof metadata?.shellID === 'string') await this.shellMonitor?.track(metadata.shellID, sessionID, coordinator.displayID(sessionID, String(data.id)), calls.get(coordinator.displayID(sessionID, String(data.id)))?.input.background === true).catch(() => undefined);
                            break;
                        }
                        case 'session.tool.success':
                        case 'session.tool.failed': {
                            const id = coordinator.displayID(sessionID, String(data.id));
                            const call = calls.get(id);
                            const metadata = data.metadata as { exit?: number; shellID?: string; status?: string } | undefined;
                            if (typeof metadata?.shellID === 'string') await this.shellMonitor?.track(metadata.shellID, sessionID, id, metadata.status === 'running').catch(() => undefined);
                            const research = readResearchEvidence(data.xratuResearch);
                            const isError = !!research && !['success', 'empty'].includes(research.outcome) || event.type.endsWith('failed') || (typeof metadata?.exit === 'number' && metadata.exit !== 0);
                            if (call) failedEdits = call.nativeEdit && isError ? failedEdits + 1 : 0;
                            // V2 represents MCP images as file parts with data URIs.
                            // Reuse shared image bounds; never fetch native file/HTTP URIs.
                            const content = mapMcpToolContent(Array.isArray(data.content) ? data.content.map(part => part?.type === 'file' && typeof part.uri === 'string' && /^data:image\//i.test(part.uri) ? { type: 'text', text: part.uri } : part) : [], call?.name);
                            yield { type: 'toolResult', id, tool: call?.name ?? 'opencode_tool', output: content.text.slice(0, 200_000) || (event.type.endsWith('failed') ? errorText(data.error) : ''), isError, ...(content.images.length ? { images: content.images } : {}), ...(data.xratuResearch ? { research: readResearchEvidence(data.xratuResearch) } : {}) };
                            calls.delete(id);
                            active.calls.delete(id);
                            // Native tools own their arguments and retries. Stop a
                            // failing edit loop through the normal interrupt/wait
                            // cleanup rather than rewriting or replaying edits.
                            if (failedEdits >= 3) throw new EngineError('engineRepeatedEditFailures');
                            break;
                        }
                        case 'permission.asked': {
                            const approvalId = `opencode:${eventSessionID}:${String(data.id)}`;
                            const source = data.source as { type?: string; id?: string } | undefined;
                            const nativeID = source?.type === 'tool' && source.id ? source.id : approvalId;
                            const id = coordinator.displayID(eventSessionID, nativeID);
                            const call = coordinator.call(eventSessionID, nativeID);
                            const name = call ? displayToolName(call.name) : displayToolName(String(data.action));
                            const args = nativeToolDisplayArgs(name, { ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}), ...call?.input, action: data.action, resources: data.resources });
                            decisions.start(`${eventSessionID}:permission:${String(data.id)}`, async (signal, answering) => {
                                let allowed = !turn.plan;
                                if (this.mcpBridge?.hasResearch() && ['websearch', 'webfetch'].includes(String(data.action))) allowed = false;
                                if (data.action === 'subagent') {
                                    // Model-supplied native ids may name another chat.
                                    // Replace a reused child's old mode before admission.
                                    allowed &&= call?.name === 'subagent';
                                    const childID = call?.input.sessionID;
                                    if (allowed && typeof childID === 'string' && childID) {
                                        const child = await client.session.get({ sessionID: childID }, { signal });
                                        allowed = child.parentID === eventSessionID && child.location.directory === turn.workspace;
                                        if (allowed) allowed = !(childID in await client.session.active({ signal })) && coordinator.reusable(childID) && coordinator.claim(childID, eventSessionID, nativeID);
                                        if (allowed) {
                                            await tree.drainPending(childID, signal);
                                            await client.session.update({ sessionID: childID, permissions }, { signal });
                                            coordinator.admit(childID, eventSessionID, child.model ? `${child.model.providerID}/${child.model.id}` : turn.model, child.agent ?? '');
                                        }
                                    }
                                }
                                const attribution = coordinator.source(eventSessionID);
                                // YOLO is one live grant for the whole run tree, so a
                                // native child runs unattended exactly like the built-in
                                // runner's children. Plan still denies above, and a
                                // `subagent` request still had to pass ownership checks.
                                const unattended = host.isYolo?.() ?? turn.yolo;
                                if (allowed && !unattended) coordinator.waiting(eventSessionID, approvalId, name, nativeID);
                                const decision = !allowed ? {} : unattended ? { [id]: true } : await abortable(host.approvals.requestApproval(approvalId, [{ id, name, arguments: args, argumentsJson: JSON.stringify(args) }], attribution, signal), signal);
                                if (!decision[id] && typeof call?.input.sessionID === 'string') coordinator.release(call.input.sessionID, eventSessionID, nativeID);
                                signal.throwIfAborted();
                                answering();
                                // A bare reject is OpenCode's Stop. A declined tool
                                // should return control to the model, like Xratu.
                                await client.permission.reply({ sessionID: eventSessionID, requestID: String(data.id), decision: decision[id] ? 'once' : 'reject', ...(!decision[id] ? { message: !allowed ? 'This tool is unavailable in this session or mode.' : 'The user declined this request. Do not retry it.' } : {}) }, { signal });
                            });
                            break;
                        }
                        case 'form.created':
                            if (form) {
                                coordinator.waiting(eventSessionID, form.id, 'ask_user_question');
                                decisions.start(`${eventSessionID}:form:${form.id}`, (signal, answering) => this.answerForm(client, form, host, signal, answering, coordinator.source(eventSessionID), error => { decisionFailure ??= { error }; }));
                            }
                            break;
                        case 'session.step.ended': {
                            const tokens = data.tokens as { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined;
                            if (tokens && [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
                                const usage: LocalAgentEvent = { type: 'usage', usage: { promptTokens: tokens.input + tokens.cache.read + tokens.cache.write, completionTokens: tokens.output + tokens.reasoning, cachedTokens: tokens.cache.read, cacheWriteTokens: tokens.cache.write, totalTokens: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning, ...(typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0 ? { costUsd: data.cost } : {}) } };
                                coordinator.usage(eventSessionID, usage);
                                yield usage;
                            }
                            break;
                        }
                        case 'session.execution.failed': if (executionStarted) throw new Error(errorText(data.error)); break;
                        case 'session.execution.interrupted': if (executionStarted) throw new DOMException('OpenCode interrupted', 'AbortError'); break;
                        case 'session.execution.succeeded':
                            if (!executionStarted) break;
                            // OpenCode can finish one execution before delivering a steer.
                            // Its following execution belongs to this same Xratu turn.
                            if (active.steers.size || coordinator.pendingWork()) { heldSuccess = true; break; }
                            completed = true;
                            yield { type: 'assistantMessage', text, toolCalls: [] };
                            yield { type: 'status', value: 'done' };
                            return;
                    }
                }
            }
        } catch (error) {
            throw decisionFailure?.error ?? error;
        } finally {
            if (this.active === active) this.active = undefined;
            for (const controller of childControllers.values()) controller.abort();
            for (const id of coordinator.sessions.keys()) this.mcpBridge?.deactivate(id);
            if (this.coordinator === coordinator) this.coordinator = undefined;
            for (const message of active.steers.values()) host.onSteerRejected?.(message.steerId);
            turn.signal.removeEventListener('abort', abort);
            streamController.abort();
            await decisions.close();
            coordinator.finish(turn.signal.aborted ? 'cancelled' : decisionFailure ? 'error' : 'interrupted');
            // Interrupt also on a broken stream: never leave a native agent running unseen.
            if (!completed) {
                try {
                    await tree.stop(coordinator.sessions.keys(), AbortSignal.timeout(30_000));
                } catch {
                    // A stuck runtime cannot keep running unseen or poison the next turn.
                    // Native session identity/history survives the managed server restart.
                    await this.server.dispose();
                }
            }
            try { await tree.stopChildShells(AbortSignal.timeout(5000)); }
            catch { await this.server.dispose(); }
            for (const id of coordinator.sessions.keys()) if (id !== sessionID) this.shellMonitor?.unwatch(id);
        }
    }
    private async answerForm(client: OpenCodeClient, form: FormInfo1, host: EngineHost, signal: AbortSignal, answering: () => void, source?: import('../../subagentObservation').SubagentApprovalSource, noteFailure?: (error: unknown) => void): Promise<void> {
        const answer: Record<string, string | number | boolean | string[]> = {};
        try {
            // Validate the whole form before displaying any of its fields.
            // Partial answers cannot represent hidden or conditional fields.
            const keys = new Set<string>();
            for (const field of form.fields) {
                if (field.type === 'external' || field.hidden || field.when?.length || keys.has(field.key)) throw new EngineError('engineFormUnsupported');
                keys.add(field.key);
                if (field.type === 'string' || field.type === 'multiselect') {
                    const labels = field.options?.map(option => option.label) ?? [];
                    const values = field.options?.map(option => option.value) ?? [];
                    if (new Set(labels).size !== labels.length || new Set(values).size !== values.length || labels.some(label => !label.trim())) throw new EngineError('engineFormUnsupported');
                }
            }
            for (const field of form.fields) {
                if (field.type === 'external' || field.hidden || field.when?.length) throw new EngineError('engineFormUnsupported');
                const options = field.type === 'string' || field.type === 'multiselect' ? field.options ?? [] : [];
                const outcome = await abortable(host.questions.ask({ source, header: form.title, question: [field.title ?? field.key, field.description].filter(Boolean).join('\n'), multiSelect: field.type === 'multiselect', minItems: field.type === 'multiselect' ? field.minItems : undefined, maxItems: field.type === 'multiselect' ? field.maxItems : undefined, allowCustomAnswer: (field.type === 'string' || field.type === 'multiselect') ? field.custom === true || options.length === 0 : true, options: options.map((option) => ({ label: option.label, description: option.description ?? '', recommended: false })) }, signal), signal);
                signal.throwIfAborted();
                if (outcome.kind === 'dismissed') { answering(); await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal }); return; }
                const value = outcome.kind === 'selected' ? options.find((option) => option.label === outcome.label)?.value ?? outcome.label : outcome.text;
                if (field.type === 'multiselect') {
                    const labels: unknown = outcome.kind === 'custom' ? JSON.parse(outcome.text) : [outcome.label];
                    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string') || new Set(labels).size !== labels.length) throw new EngineError('engineFormInvalidAnswer');
                    const values = labels.map((label) => options.find((option) => option.label === label)?.value ?? label);
                    if ((field.minItems !== undefined && values.length < field.minItems) || (field.maxItems !== undefined && values.length > field.maxItems) || (options.length > 0 && field.custom !== true && values.some((item) => !options.some((option) => option.value === item)))) throw new EngineError('engineFormInvalidAnswer');
                    answer[field.key] = values;
                } else if (field.type === 'number' || field.type === 'integer') {
                    const number = Number(value);
                    if (!value.trim() || !Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)) || (field.minimum !== undefined && number < field.minimum) || (field.maximum !== undefined && number > field.maximum)) throw new EngineError('engineFormInvalidAnswer');
                    answer[field.key] = number;
                } else if (field.type === 'boolean') {
                    if (!['true', 'false'].includes(value.toLowerCase())) throw new EngineError('engineFormInvalidAnswer');
                    answer[field.key] = value.toLowerCase() === 'true';
                } else {
                    if (field.type !== 'string' || (options.length > 0 && field.custom !== true && !options.some(option => option.value === value)) || (field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength)) throw new EngineError('engineFormInvalidAnswer');
                    answer[field.key] = value;
                }
            }
            signal.throwIfAborted();
            answering();
            await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer }, { signal });
        } catch (error) {
            // An external reply/cancel or terminal event already owns native
            // settlement. Never send a second answer from a stale UI card.
            if (signal.aborted) throw error;
            noteFailure?.(error);
            answering();
            await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
            throw error;
        }
    }
    async dispose(): Promise<void> {
        this.shellMonitor?.dispose(); this.shellMonitor = undefined;
        await this.server.dispose();
        await this.mcpBridge?.dispose();
    }
}

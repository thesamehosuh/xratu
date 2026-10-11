// Event and permission mapping adapted from T3 Code's OpenCode 2 adapter.
// Native OpenCode owns tools/history; Xratu owns the display and decision cards.
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { isSessionNotFoundError, type FormInfo1, type ModelInfo, type OpenCodeClient } from '@opencode/client';
import type { LocalAgentEvent, LocalSteerMessage } from '../../local/localTypes';
import type { AgentEngine, EngineHost, EngineTurn } from '../types';
import type { NativeIntegration } from '../nativeSetup';
import { OpenCodeServer } from './server';
import { subscribeEvents } from './events';
import { openCodePermissions } from './permissions';
import { NativeShellMonitor, type NativeShellUpdate } from './shells';

export class EngineError extends Error {
    constructor(readonly valueKey: string) { super(valueKey); }
}
const TOOL_NAMES: Record<string, string> = { shell: 'run_terminal_command', bash: 'run_terminal_command', read: 'read_file', edit: 'edit_file', write: 'write_file', glob: 'glob_search', grep: 'grep_search', websearch: 'web_search', webfetch: 'fetch_url', question: 'ask_user_question' };
function toolName(name: string): string { return TOOL_NAMES[name] ?? `opencode_${name}`; }
function contentText(content: unknown): string {
    return Array.isArray(content) ? content.map((part) => part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n').slice(0, 200_000) : '';
}
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
    readonly capabilities = { steering: true, rewind: false, localTools: false };
    private readonly server: Pick<OpenCodeServer, 'connect' | 'dispose'>;
    private active?: { client: OpenCodeClient; sessionID: string; signal: AbortSignal; calls: Set<string>; steers: Map<string, LocalSteerMessage> };
    private shellMonitor?: NativeShellMonitor;
    private probing = false;
    observeShells(sessionID: string, workspace: string, emit: (update: NativeShellUpdate) => void): void {
        this.shellMonitor ??= new NativeShellMonitor(async () => (await this.server.connect()).client, emit);
        this.shellMonitor.watch(sessionID, workspace);
    }
    backgroundJobs() { return this.shellMonitor?.views() ?? []; }
    stopShell(jobID: string): Promise<boolean> { return this.shellMonitor?.stop(jobID) ?? Promise.resolve(false); }
    constructor(readonly binary: string, env?: NodeJS.ProcessEnv, server?: Pick<OpenCodeServer, 'connect' | 'dispose'>) { this.server = server ?? new OpenCodeServer(binary, env); }
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
        const input = { location: { directory: workspace } };
        const [integrations, servers, skills] = await Promise.all([
            client.integration.list(input, { signal }), client.mcp.list(input, { signal }), client.skill.list(input, { signal }),
        ]);
        return {
            integrations: integrations.data.map((entry): NativeIntegration => ({
                id: entry.id, name: entry.name,
                key: entry.methods.some((method) => method.type === 'key' && (!method.form || !Object.keys(method.form).length)),
                oauth: entry.methods.filter((method) => method.type === 'oauth' && (!method.form || !Object.keys(method.form).length)).map((method) => ({ id: 'id' in method ? method.id : '', label: 'label' in method ? method.label ?? '' : '' })),
                connections: entry.connections.map((connection) => ({ label: connection.type === 'env' ? connection.name : connection.label, source: connection.type, needsAuth: connection.status?.status === 'needs_auth' })),
            })),
            servers: servers.data.map((server) => ({ name: server.name, status: server.status.status })),
            skills: skills.data.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
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
            await active.client.session.prompt({ sessionID: active.sessionID, id, delivery: 'steer', text: message.text, ...(message.attachments?.length ? { files: message.attachments.map((image) => ({ name: image.name, uri: `data:${image.mimeType};base64,${image.dataBase64}` })) } : {}) }, { signal: active.signal });
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
        const options = { signal: turn.signal };
        const catalogModel = turn.variant ? (await this.models(turn.workspace, turn.signal)).find((entry) => `${entry.providerID}/${entry.id}` === turn.model) : undefined;
        const variant = catalogModel?.variants.some((entry) => entry.id === turn.variant) ? turn.variant : 'default';
        const model = { providerID: turn.model.slice(0, slash), id: turn.model.slice(slash + 1), variant };
        // Keep the native tool catalog while refusing every request. Free
        // models require OpenCode's harness, including its tool definitions.
        const permissions = this.probing ? [{ action: '*', resource: '*', effect: 'ask' as const }, { action: 'subagent', resource: '*', effect: 'deny' as const }] : openCodePermissions(turn.plan, turn.yolo);
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
            await client.session.switchModel({ sessionID, model }, options);
            await client.session.switchAgent({ sessionID, agent: turn.plan ? 'plan' : 'build' }, options);
            await client.session.update({ sessionID, permissions }, options);
        } else {
            const session = await client.session.create({ model, agent: turn.plan ? 'plan' : 'build', location: { directory: turn.workspace }, permissions }, options);
            sessionID = session.id;
        }
        await host.onSession?.({ engineId: 'opencode', nativeSessionId: sessionID, workspace: turn.workspace, binaryPath: this.binary });
        const streamController = new AbortController();
        const abort = () => streamController.abort(turn.signal.reason);
        turn.signal.addEventListener('abort', abort, { once: true });
        const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
        const active = { client, sessionID, signal: turn.signal, calls: new Set<string>(), steers: new Map<string, LocalSteerMessage>() };
        let text = '';
        let reasoning = '';
        let completed = false;
        let executionStarted = false;
        let heldSuccess = false;
        try {
            const stream = await subscribeEvents(baseUrl, headers, streamController.signal);
            await client.session.prompt({ sessionID, text: [turn.context, turn.prompt].filter(Boolean).join('\n\n'), ...(turn.attachments?.length ? { files: turn.attachments.map((image) => ({ name: image.name, uri: `data:${image.mimeType};base64,${image.dataBase64}` })) } : {}) }, options);
            this.active = active;
            for (const message of host.steer?.drain() ?? []) await this.steer(message);
            yield { type: 'status', value: 'running' };
            for await (const event of stream) {
                turn.signal.throwIfAborted();
                const data = event.data;
                const form = data.form as FormInfo1 | undefined;
                if ((event.type === 'form.created' ? form?.sessionID : data.sessionID) !== sessionID) continue;
                switch (event.type) {
                    case 'session.execution.started': executionStarted = true; heldSuccess = false; break;
                    case 'session.retry.scheduled':
                        if (this.probing) throw new Error(errorText(data.error));
                        break;
                    case 'session.inbox.delivered': {
                        const message = active.steers.get(String(data.inboxID));
                        if (message) { active.steers.delete(String(data.inboxID)); yield { type: 'steer', ...message }; }
                        break;
                    }
                    case 'session.inbox.cancelled': {
                        const message = active.steers.get(String(data.inboxID));
                        if (message) { active.steers.delete(String(data.inboxID)); host.onSteerRejected?.(message.steerId); }
                        if (heldSuccess && active.steers.size === 0) {
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
                        if (typeof data.id === 'string' && typeof data.name === 'string') calls.set(data.id, { name: toolName(data.name), input: {} });
                        break;
                    case 'session.tool.called': {
                        const id = String(data.id);
                        const call = calls.get(id) ?? { name: 'opencode_tool', input: {} };
                        call.input = data.input && typeof data.input === 'object' ? data.input as Record<string, unknown> : {};
                        calls.set(id, call);
                        if (call.name === 'run_terminal_command') active.calls.add(id);
                        yield { type: 'toolCall', id, tool: call.name, args: call.input };
                        break;
                    }
                    case 'session.tool.progress': {
                        const metadata = data.metadata as { shellID?: string } | undefined;
                        if (typeof metadata?.shellID === 'string') await this.shellMonitor?.track(metadata.shellID, sessionID, String(data.id), calls.get(String(data.id))?.input.background === true).catch(() => undefined);
                        break;
                    }
                    case 'session.tool.success':
                    case 'session.tool.failed': {
                        const id = String(data.id);
                        const metadata = data.metadata as { exit?: number; shellID?: string; status?: string } | undefined;
                        if (typeof metadata?.shellID === 'string') await this.shellMonitor?.track(metadata.shellID, sessionID, id, metadata.status === 'running').catch(() => undefined);
                        yield { type: 'toolResult', id, tool: calls.get(id)?.name ?? 'opencode_tool', output: contentText(data.content) || (event.type.endsWith('failed') ? errorText(data.error) : ''), isError: event.type.endsWith('failed') || (typeof metadata?.exit === 'number' && metadata.exit !== 0) };
                        calls.delete(id);
                        active.calls.delete(id);
                        break;
                    }
                    case 'permission.asked': {
                        const approvalId = `opencode:${sessionID}:${String(data.id)}`;
                        const source = data.source as { type?: string; id?: string } | undefined;
                        const id = source?.type === 'tool' && source.id ? source.id : approvalId;
                        const args = { action: data.action, resources: data.resources, ...(data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) };
                        const name = toolName(String(data.action));
                        const decision = turn.plan ? {} : await host.approvals.requestApproval(approvalId, [{ id, name, arguments: args, argumentsJson: JSON.stringify(args) }]);
                        await client.permission.reply({ sessionID, requestID: String(data.id), decision: decision[id] ? 'once' : 'reject' }, options);
                        break;
                    }
                    case 'form.created':
                        if (form) await this.answerForm(client, form, host, turn.signal);
                        break;
                    case 'session.step.ended': {
                        const tokens = data.tokens as { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined;
                        if (tokens && [tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) yield { type: 'usage', usage: { promptTokens: tokens.input + tokens.cache.read + tokens.cache.write, completionTokens: tokens.output + tokens.reasoning, cachedTokens: tokens.cache.read, cacheWriteTokens: tokens.cache.write, totalTokens: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning, ...(typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0 ? { costUsd: data.cost } : {}) } };
                        break;
                    }
                    case 'session.execution.failed': if (executionStarted) throw new Error(errorText(data.error)); break;
                    case 'session.execution.interrupted': if (executionStarted) throw new DOMException('OpenCode interrupted', 'AbortError'); break;
                    case 'session.execution.succeeded':
                        if (!executionStarted) break;
                        // OpenCode can finish one execution before delivering a steer.
                        // Its following execution belongs to this same Xratu turn.
                        if (active.steers.size) { heldSuccess = true; break; }
                        completed = true;
                        yield { type: 'assistantMessage', text, toolCalls: [] };
                        yield { type: 'status', value: 'done' };
                        return;
                }
            }
        } finally {
            if (this.active === active) this.active = undefined;
            for (const message of active.steers.values()) host.onSteerRejected?.(message.steerId);
            turn.signal.removeEventListener('abort', abort);
            streamController.abort();
            // Interrupt also on a broken stream: never leave a native agent running unseen.
            if (!completed) await client.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
        }
    }
    private async answerForm(client: OpenCodeClient, form: FormInfo1, host: EngineHost, signal: AbortSignal): Promise<void> {
        const answer: Record<string, string | number | boolean | string[]> = {};
        try {
            for (const field of form.fields) {
                if (field.type === 'external' || field.hidden || field.when?.length) throw new EngineError('engineFormUnsupported');
                const options = field.type === 'string' || field.type === 'multiselect' ? field.options ?? [] : [];
                const outcome = await host.questions.ask({ header: form.title, question: [field.title ?? field.key, field.description].filter(Boolean).join('\n'), multiSelect: field.type === 'multiselect', allowCustomAnswer: (field.type === 'string' || field.type === 'multiselect') ? field.custom === true || options.length === 0 : true, options: options.map((option) => ({ label: option.label, description: option.description ?? '', recommended: false })) });
                signal.throwIfAborted();
                if (outcome.kind === 'dismissed') { await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal }); return; }
                const value = outcome.kind === 'selected' ? options.find((option) => option.label === outcome.label)?.value ?? outcome.label : outcome.text;
                if (field.type === 'multiselect') {
                    const labels: unknown = outcome.kind === 'custom' ? JSON.parse(outcome.text) : [outcome.label];
                    if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) throw new EngineError('engineFormUnsupported');
                    const values = labels.map((label) => options.find((option) => option.label === label)?.value ?? label);
                    if ((field.minItems !== undefined && values.length < field.minItems) || (field.maxItems !== undefined && values.length > field.maxItems) || (field.custom !== true && values.some((item) => !options.some((option) => option.value === item)))) throw new EngineError('engineFormUnsupported');
                    answer[field.key] = values;
                } else if (field.type === 'number' || field.type === 'integer') {
                    const number = Number(value);
                    if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) throw new EngineError('engineFormUnsupported');
                    answer[field.key] = number;
                } else if (field.type === 'boolean') {
                    if (!['true', 'false'].includes(value.toLowerCase())) throw new EngineError('engineFormUnsupported');
                    answer[field.key] = value.toLowerCase() === 'true';
                } else answer[field.key] = value;
            }
            await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer }, { signal });
        } catch (error) {
            await client.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
            throw error;
        }
    }
    dispose(): Promise<void> { this.shellMonitor?.dispose(); this.shellMonitor = undefined; return this.server.dispose(); }
}

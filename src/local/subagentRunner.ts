/**
 * Nested-run orchestration for the `task` tool: drive a child runLocalAgent
 * loop on behalf of a tool call and collapse it to a single final report.
 *
 * VS Code-free (like localAgent.ts) so the nested path gets a node test
 * suite that drives REAL loops against a mocked fetch.
 *
 * Two structural recursion denies, neither of which is a prompt hint:
 *   1. the child toolset never contains `task` (filterToolsForSubagent),
 *   2. the child executor rejects `task` and any tool outside the child's
 *      allow-list even if the model hallucinates the call (wrapRestrictedExecutor).
 */

import {
    runLocalAgent,
    type LocalAgentMessage,
    type LocalAgentRequest,
    type LocalApprovalGate,
    type LocalToolDefinition,
    type LocalToolExecutor,
    type LocalUsage,
} from './localAgent';
import {
    DEFAULT_SUBAGENT_ROUNDS,
    SUBAGENT_TOOL_NAME,
    resolveSubagent,
    type SubagentDefinition,
    type SubagentRunRequest,
    type SubagentRunner,
} from '../subagents';

export interface SubagentHostContext {
    /** Model/transport identity shared with the parent run. The runner fills
     *  in the per-agent pieces (systemPrompt, userText, history, tools,
     *  maxRounds) - `maxRounds`/`sessionSummary`/`taskList`/`toolChoice`
     *  from the parent must NOT leak into the child. */
    request: Omit<
        LocalAgentRequest,
        'systemPrompt' | 'userText' | 'history' | 'tools'
        | 'maxRounds' | 'sessionSummary' | 'taskList' | 'taskListProvider' | 'toolChoice'
    >;
    /** Build the child toolset (host applies plan/yolo/external/skills, this
     *  layer only enforces the per-agent allow-list and the recursion deny). */
    tools(def: SubagentDefinition): LocalToolDefinition[];
    systemPrompt(def: SubagentDefinition): string;
    /** Child tool executor WITHOUT a SubagentRunner attached. */
    executor: LocalToolExecutor;
    approvalGate: LocalApprovalGate;
    /** Child model usage, forwarded so cost ledgers count delegated work. */
    onUsage?(usage: LocalUsage): void;
}

/** Reject tool calls outside the child's toolset. The agent loop executes
 *  whatever tool_calls the model emits (hallucinated names included), so the
 *  allow-list must hold at execution time, not only in the advertised set. */
export function wrapRestrictedExecutor(
    base: LocalToolExecutor,
    allowed: ReadonlySet<string>,
): LocalToolExecutor {
    return {
        execute: async (call, onOutput) => {
            if (call.name === SUBAGENT_TOOL_NAME || !allowed.has(call.name)) {
                return { output: `Tool not available to this subagent: ${call.name}`, isError: true };
            }
            return base.execute(call, onOutput);
        },
    };
}

function traceArgs(args: Record<string, unknown>): string {
    let s: string;
    try {
        s = JSON.stringify(args) ?? '';
    } catch {
        s = '';
    }
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

function traceLine(output: string): string {
    const first = (output.split('\n')[0] ?? '').trim();
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

/** Run one delegated task to completion and return the child's final report.
 *  Intermediate child activity (tool calls, errors) streams to `onOutput` so
 *  the parent's task pill shows a live trace; the model only ever sees the
 *  returned output string. */
export async function runSubagentTask(
    ctx: SubagentHostContext,
    defs: readonly SubagentDefinition[],
    req: SubagentRunRequest,
): Promise<{ output: string; isError?: boolean }> {
    const onOutput = req.onOutput;
    const def = resolveSubagent(defs, req.subagentType);
    if (!def) {
        const names = defs.filter((d) => !d.error).map((d) => d.name).join(', ');
        return {
            output: `Unknown subagent_type "${req.subagentType}". Available types: ${names}`,
            isError: true,
        };
    }
    const tools = ctx.tools(def);
    const allowed = new Set(tools.map((t) => t.name));
    allowed.delete(SUBAGENT_TOOL_NAME);
    onOutput?.(`▶ ${def.name}\n`);

    const request: LocalAgentRequest = {
        ...ctx.request,
        systemPrompt: ctx.systemPrompt(def),
        userText: req.prompt,
        // Fresh context by contract: the prompt must be self-contained.
        history: [] as LocalAgentMessage[],
        tools,
        maxRounds: def.maxRounds ?? DEFAULT_SUBAGENT_ROUNDS,
    };

    let finalText = '';
    let lastError = '';
    try {
        for await (const event of runLocalAgent(
            request,
            wrapRestrictedExecutor(ctx.executor, allowed),
            ctx.approvalGate,
        )) {
            switch (event.type) {
                case 'assistantMessage':
                    if (!event.toolCalls.length) finalText = event.text;
                    break;
                case 'toolCall':
                    onOutput?.(`→ ${event.tool} ${traceArgs(event.args)}\n`);
                    break;
                case 'toolResult':
                    onOutput?.(`${event.isError ? '✗' : '✓'} ${traceLine(event.output)}\n`);
                    break;
                case 'needsApproval':
                    onOutput?.(`… waiting for approval: ${event.approvals.map((a) => a.tool_name).join(', ')}\n`);
                    break;
                case 'error':
                    lastError = event.value;
                    onOutput?.(`! ${traceLine(event.value)}\n`);
                    break;
                case 'usage':
                    // Estimates stay display-only; the authoritative
                    // round-end copy is what cost ledgers count.
                    if (!event.estimated) ctx.onUsage?.(event.usage);
                    break;
                default:
                    break;
            }
        }
    } catch (err) {
        // A cancelled parent run aborts the child via the shared signal;
        // fetch/droppped-stream aborts surface as AbortError or
        // ResponseAborted. Either way the tool call must settle.
        if (ctx.request.signal?.aborted
            || (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted'))) {
            return { output: 'Subagent run cancelled.', isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `Subagent failed: ${msg}`, isError: true };
    }
    if (finalText.trim()) {
        return { output: finalText.trim() };
    }
    if (lastError) {
        return { output: `Subagent failed: ${lastError}`, isError: true };
    }
    return { output: '(the subagent finished without a final report)', isError: true };
}

/** Adapter onto the SubagentRunner seam mcp.ts dispatches through. */
export function createSubagentRunner(
    ctx: SubagentHostContext,
    defs: readonly SubagentDefinition[],
): SubagentRunner {
    return {
        run: (req) => runSubagentTask(ctx, defs, req),
    };
}

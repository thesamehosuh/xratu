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

import * as crypto from 'crypto';
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
    persistedEventFromAgentEvent,
    historyRowFromEvent,
    buildReplayHistory,
} from './historyRows';
import type { LocalSessionHistoryMessage } from './localSessionStore';
import {
    DEFAULT_SUBAGENT_ROUNDS,
    SUBAGENT_TOOL_NAME,
    resolveSubagent,
    type SubagentDefinition,
    type SubagentRunRequest,
    type SubagentRunner,
} from '../subagents';

export interface SubagentHostContext {
    /** Model/transport identity shared with the parent run - called ONCE PER
     *  TASK so every child gets a fresh conversation identity (cacheKey /
     *  OpenCode sessionId): two delegated tasks are two different
     *  conversations and must not share a provider-side session. The runner
     *  fills in the per-agent pieces (systemPrompt, userText, history, tools,
     *  maxRounds) - `maxRounds`/`sessionSummary`/`taskList`/`toolChoice`/
     *  `attachments` from the parent must NOT leak into the child (the
     *  delegation prompt is text-only). */
    baseRequest(): Omit<
        LocalAgentRequest,
        'systemPrompt' | 'userText' | 'history' | 'tools' | 'attachments'
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

// ---------------------------------------------------------------------------
// Run registry: one entry per delegated task, so a follow-up `task` call can
// CONTINUE a run (task_id) with its context restored instead of restarting
// from zero. This is the resume/heal path for interrupted or stuck runs.
// Host-owned (session-scoped): the map outlives a single parent turn.
// ---------------------------------------------------------------------------

export interface SubagentRunRecord {
    /** The profile the run launched with. */
    defName: string;
    /** Committed model-ledger rows of everything the run has done so far. */
    rows: LocalSessionHistoryMessage[];
    startedAt: number;
    /** True while a run is inside `runLocalAgent`. A resume (task_id) targeting
     *  an in-flight run would replay the same committed rows from two
     *  interleaved loops and corrupt them - rejected in `runSubagentTask`.
     *  Set synchronously before the loop starts (no await between the check
     *  and the set, so two concurrent calls cannot both pass), cleared in the
     *  run's `finally`. */
    running?: boolean;
}

export type SubagentRunRegistry = Map<string, SubagentRunRecord>;

/** Registry bound: oldest runs are evicted first (Map = insertion order;
 *  a resume moves the entry to the tail). */
export const MAX_SUBAGENT_RUNS = 8;

/** Row bound per run: a pathological resume marathon must not grow the
 *  in-memory transcript without limit. */
export const MAX_SUBAGENT_RUN_ROWS = 600;

function newTaskId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function rememberRun(registry: SubagentRunRegistry, id: string, record: SubagentRunRecord): void {
    // Re-insert so the most recently active run survives eviction longest.
    registry.delete(id);
    registry.set(id, record);
    while (registry.size > MAX_SUBAGENT_RUNS) {
        const oldest = registry.keys().next();
        if (oldest.done) break;
        registry.delete(oldest.value);
    }
}

function withTaskIdNote(output: string, taskId: string, toolCalls: number): string {
    // The count rides the note so the UI can show "how many tool calls did
    // this run make" even after a session restore (the live trace is
    // display-only and not persisted).
    return `${output}\n\n[task_id: ${taskId} · ${toolCalls} tool calls]`;
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

/** Keys tried in order for a human title of a tool call - the trace line
 *  reads `↳ read_file game/engine.py`, never the raw arguments JSON
 *  (opencode-style: tool + primary subject). */
const TITLE_KEYS = ['path', 'command', 'pattern', 'query', 'url', 'skill', 'name', 'description'];

function callTitle(args: Record<string, unknown>): string | null {
    for (const key of TITLE_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) {
            const firstLine = value.trim().split('\n')[0];
            return firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
        }
    }
    return null;
}

function traceLine(output: string): string {
    const first = (output.split('\n')[0] ?? '').trim();
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

/** Run one delegated task to completion and return the child's final report.
 *  Intermediate child activity (tool calls, errors) streams to `onOutput` so
 *  the parent's task pill shows a live trace; the model only ever sees the
 *  returned output string.
 *
 *  Continuity: each run is registered under a task_id (returned in the
 *  output). A later call carrying that task_id CONTINUES the same subagent -
 *  its committed history is restored - so an interrupted, cancelled or
 *  stuck run resumes where it stopped instead of a full relaunch, and
 *  follow-up work builds on what the run already did. */
export async function runSubagentTask(
    ctx: SubagentHostContext,
    defs: readonly SubagentDefinition[],
    req: SubagentRunRequest,
    registry: SubagentRunRegistry,
): Promise<{ output: string; isError?: boolean }> {
    const onOutput = req.onOutput;

    // Resume path: task_id identifies an existing run and wins over
    // subagent_type (it IS the instance).
    let record: SubagentRunRecord;
    let taskId = '';
    let resumed = false;
    if (req.taskId) {
        const existing = registry.get(req.taskId);
        if (!existing) {
            const known = Array.from(registry.keys()).join(', ') || 'none';
            return {
                output: `Unknown task_id "${req.taskId}". Available task_ids: ${known}. Start a new run with subagent_type instead.`,
                isError: true,
            };
        }
        if (req.subagentType && req.subagentType !== existing.defName) {
            return {
                output: `task_id ${req.taskId} belongs to subagent_type "${existing.defName}", not "${req.subagentType}". Continue it without subagent_type.`,
                isError: true,
            };
        }
        if (existing.running) {
            return {
                output: `task_id ${req.taskId} is still running; wait for it to finish before continuing it. Concurrent resumes of one run would corrupt its history.`,
                isError: true,
            };
        }
        taskId = req.taskId;
        record = existing;
        resumed = true;
    } else {
        const def0 = resolveSubagent(defs, req.subagentType);
        if (!def0) {
            const names = defs.filter((d) => !d.error).map((d) => d.name).join(', ');
            return {
                output: `Unknown subagent_type "${req.subagentType}". Available types: ${names}`,
                isError: true,
            };
        }
        taskId = newTaskId();
        record = { defName: def0.name, rows: [], startedAt: Date.now() };
    }

    const def = resolveSubagent(defs, record.defName);
    if (!def) {
        return {
            output: `Subagent profile "${record.defName}" is no longer available; its run cannot continue.`,
            isError: true,
        };
    }

    const tools = ctx.tools(def);
    const allowed = new Set(tools.map((t) => t.name));
    allowed.delete(SUBAGENT_TOOL_NAME);
    onOutput?.(`▶ ${def.name}${resumed ? ' (resume)' : ''}\n`);

    const base = ctx.baseRequest();
    const request: LocalAgentRequest = {
        ...base,
        systemPrompt: ctx.systemPrompt(def),
        userText: req.prompt,
        // Fresh context by contract on a NEW run; a resume replays the run's
        // committed rows so the child remembers its own earlier work (and
        // never the parent's conversation).
        history: buildReplayHistory(record.rows),
        tools,
        maxRounds: def.maxRounds ?? DEFAULT_SUBAGENT_ROUNDS,
    };

    // Everything THIS invocation commits is appended to the registry on the
    // way out (success, failure or abort) - that is what makes an
    // interrupted run resumable instead of lost.
    const turnRows: LocalSessionHistoryMessage[] = [];
    const commitTurn = (): void => {
        record.rows.push({ role: 'user', content: req.prompt }, ...turnRows);
        if (record.rows.length > MAX_SUBAGENT_RUN_ROWS) {
            record.rows = record.rows.slice(-MAX_SUBAGENT_RUN_ROWS);
        }
        rememberRun(registry, taskId, record);
    };

    rememberRun(registry, taskId, record);
    let finalText = '';
    let lastError = '';
    let toolCallCount = 0;
    // Marked synchronously (no await since the resume check above), so two
    // concurrent `task` calls carrying this task_id cannot both start.
    record.running = true;
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
                    toolCallCount++;
                    onOutput?.(`↳ ${event.tool} ${callTitle(event.args) ?? traceArgs(event.args)}\n`);
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
            // Committed model-ledger rows only (assistant/tool carriers).
            const persisted = persistedEventFromAgentEvent(event);
            const row = persisted ? historyRowFromEvent(persisted) : null;
            if (row) turnRows.push(row);
        }
    } catch (err) {
        commitTurn();
        // A cancelled parent run aborts the child via the shared signal;
        // fetch/dropped-stream aborts surface as AbortError or
        // ResponseAborted. Either way the tool call must settle - and the
        // task_id note stays so the model can HEAL the run by continuing it.
        if (base.signal?.aborted
            || (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted'))) {
            return { output: withTaskIdNote('Subagent run cancelled.', taskId, toolCallCount), isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { output: withTaskIdNote(`Subagent failed: ${msg}`, taskId, toolCallCount), isError: true };
    } finally {
        record.running = false;
    }
    commitTurn();
    if (finalText.trim()) {
        return { output: withTaskIdNote(finalText.trim(), taskId, toolCallCount) };
    }
    if (lastError) {
        return { output: withTaskIdNote(`Subagent failed: ${lastError}`, taskId, toolCallCount), isError: true };
    }
    return { output: withTaskIdNote('(the subagent finished without a final report)', taskId, toolCallCount), isError: true };
}

/** Adapter onto the SubagentRunner seam mcp.ts dispatches through. */
export function createSubagentRunner(
    ctx: SubagentHostContext,
    defs: readonly SubagentDefinition[],
    registry: SubagentRunRegistry,
): SubagentRunner {
    return {
        run: (req) => runSubagentTask(ctx, defs, req, registry),
    };
}

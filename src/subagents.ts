/**
 * Subagents (the `task` tool): named, reusable agent profiles that the local
 * runtime can delegate a self-contained task to. A subagent runs a nested
 * agent loop in a FRESH context (no parent history) and returns only its
 * final report.
 *
 * This module is pure host-side logic (Node builtins only, no vscode) so the
 * discovery, parsing, filtering and validation rules get node test suites -
 * the precedent is skills.ts / endpointGuard.ts. The nested-loop orchestration
 * lives in local/subagentRunner.ts (also vscode-free).
 *
 * Definition files are flat markdown with YAML frontmatter:
 *
 *   .xratu/agents/code-reviewer.md
 *   ---
 *   name: code-reviewer          # optional, must match the file name
 *   description: Reviews code…   # required (when-to-use, shown to the model)
 *   tools: read_file, grep_search  # optional allow-list; omit = all tools
 *   model: qwen3-coder            # optional child model; omit = parent model
 *   reasoning_effort: low         # optional thinking level for the child
 *   max_rounds: 30               # optional child loop budget
 *   ---
 *   System prompt body…
 *
 * Tool names in `tools:` are validated against the toolset the host would give
 * the child (see `toolNames` on discoverSubagents). Names that do not exist
 * are DROPPED with a warning - and a `tools:` list that resolves to NOTHING is
 * a definition ERROR, never a silently tool-less subagent. That distinction is
 * the whole point: xratu also reads `.claude/agents/` and `~/.agents/agents/`,
 * whose files spell tools `Read, Grep, Bash`, and a mismatched allow-list used
 * to produce a child that could do nothing at all while looking perfectly
 * valid to the model.
 *
 * Windows-first: BOM and CRLF are tolerated like every other user-editable
 * file parser in this repo.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { USER_QUESTION_TOOL_NAME } from './tooling/userQuestion';

/** Model-facing name of the delegation tool. */
export const SUBAGENT_TOOL_NAME = 'task';

/** Tools that write PARENT-session state through host listeners
 *  (xratu_mcp_tools.ts: the shared task checklist and the plan-mode flag).
 *  A nested run must not reach them even if a profile allow-lists them -
 *  the checklist is the parent's plan artifact and plan mode is the user's
 *  gate, both meaningless (and dangerous) one level down. */
export const SESSION_CONTROL_TOOLS = new Set(['update_task_list', 'exit_plan_mode']);

/** Default child loop budget. The parent loop is unlimited by design; a
 *  delegated task must be FINITE - a runaway child cannot be steered or
 *  interrupted from the UI mid-run without cancelling the parent too. */
export const DEFAULT_SUBAGENT_ROUNDS = 50;

/** Hard cap on definitions (builtin + custom) exposed to the model: the task
 *  tool description embeds one line per type. */
export const MAX_SUBAGENT_DEFINITIONS = 32;

const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_PROMPT_CHARS = 20000;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type SubagentSource =
    | 'builtin'
    | 'project-xratu'
    | 'project-agents'
    | 'project-claude'
    | 'global-agents'
    | 'global-claude';

export interface SubagentDefinition {
    name: string;
    /** When-to-use text shown to the model in the task tool description. */
    description: string;
    /** System prompt for the child run (markdown body of the file). */
    prompt: string;
    /** Allow-list of tool names the child may use; undefined = everything
     *  the parent has, minus the `task` tool itself (no recursion). */
    tools?: string[];
    /** Child round budget; undefined = DEFAULT_SUBAGENT_ROUNDS. */
    maxRounds?: number;
    /** Child model; undefined = the parent's model. */
    model?: string;
    /** Child thinking level; undefined = the parent's selection. */
    reasoningEffort?: string;
    source: SubagentSource;
    /** Absolute path of the defining file (absent for builtins) - the
     *  diagnostics surfaces reveal it in the editor. */
    filePath?: string;
    /** Parse/validation failure (kept so surfaces can show why an agent
     *  file is not loading; never offered to the model). */
    error?: string;
    /** Non-fatal problem: the profile loads and runs, but something in it was
     *  ignored (unknown tool names in `tools:`, a model this provider does not
     *  list). Surfaced next to the definition, never to the model. */
    warning?: string;
}

/** Model-facing launch request as validated from tool arguments. `taskId`
 *  continues a previous run of this session (context restored); omit it to
 *  start a fresh subagent. */
export interface SubagentRunRequest {
    subagentType: string;
    description: string;
    prompt: string;
    taskId?: string;
    onOutput?: (chunk: string) => void;
    /** Host identity of the parent task call, never a model argument. */
    parentCallId?: string;
}

/** Host-injected nested-run capability. Present only in the local runtime's
 *  main executor: child executors deliberately lack it, which is the
 *  structural recursion deny (see local/subagentRunner.ts). */
export interface SubagentRunner {
    run(request: SubagentRunRequest): Promise<{ output: string; isError?: boolean }>;
}

export function builtinSubagents(): SubagentDefinition[] {
    return [
        {
            name: 'explore',
            description: 'Read-only codebase research. Reads, searches and inspects the workspace (including running read-only commands to check a claim) and reports findings with file references; never changes a file.',
            prompt: [
                'You are a codebase research subagent. Investigate the workspace and answer the task you were given with evidence: file paths and line numbers for every claim.',
                'You do not modify the workspace: no edits, no writes, no installs, no commits. Gather facts from files, searches and (if needed) the web, then report.',
                'You MAY run commands in the terminal, and you should when a claim needs verifying (build, type-check, tests, linters, `git log`, `--help` output). Use read-only invocations only, expect a normal approval prompt for each one, and never run something that writes to the workspace.',
                'Prefer targeted searches over reading whole files.',
            ].join(' '),
            tools: [
                'read_file', 'grep_search', 'glob_search', 'list_files',
                'list_code_definition_names', 'web_search', 'fetch_url', 'skill',
                // Terminal for VERIFICATION (build/test/lint/`--help`), not for
                // changing anything: the tool still passes the parent's approval
                // gate, and the profile has no editing tools at all. Without it
                // the subagent can only ever report what it read, never what it
                // confirmed - which is what made it useless for real research.
                'run_terminal_command',
            ],
            source: 'builtin',
        },
        {
            name: 'general',
            description: 'General-purpose subagent for multi-step work: inspects the workspace, makes edits, runs commands and verifies results.',
            prompt: [
                'You are a general-purpose coding subagent. Complete the task you were given on your own: inspect the relevant code, make the changes (or gather the answers), and verify the result before finishing.',
                'Keep the work scoped to the task; do not wander into unrelated refactors.',
            ].join(' '),
            source: 'builtin',
        },
    ];
}

export interface ParsedSubagentMd {
    name?: string;
    description?: string;
    tools?: string[];
    maxRounds?: number;
    model?: string;
    reasoningEffort?: string;
    prompt: string;
}

/** Parse an agent definition file: `---`-delimited YAML frontmatter (first
 *  line, BOM tolerated) + markdown body = system prompt. Only the spec
 *  fields are read; unknown fields are ignored. `tools` is a comma-separated
 *  list on one line (a nested YAML list is treated as absent - same rule as
 *  the skills parser: unparseable structure means the field is missing). */
export function parseSubagentDefinition(raw: string): ParsedSubagentMd {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if ((lines[0] ?? '').trim() !== '---') {
        return { prompt: text.trim() };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            end = i;
            break;
        }
    }
    if (end === -1) {
        return { prompt: text.trim() };
    }
    const parsed: ParsedSubagentMd = { prompt: lines.slice(end + 1).join('\n').trim() };
    for (const line of lines.slice(1, end)) {
        const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        let value = m[2].trim();
        if (value.length >= 2
            && ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        // Same guard as the skills parser: block scalars, anchors, flow
        // collections and list items are structures this tiny parser does
        // not read - treat the field as absent instead of garbage.
        if (/^[>|&*!%@`]/.test(value) || /^-\s/.test(value)) {
            continue;
        }
        if (value === '') {
            continue;
        }
        if (key === 'name' || key === 'description' || key === 'model') {
            parsed[key] = value;
        } else if (key === 'tools') {
            const names = value.split(',').map((s) => s.trim()).filter(Boolean);
            if (names.length > 0) parsed.tools = names;
        } else if (key === 'reasoning_effort' || key === 'reasoningEffort') {
            parsed.reasoningEffort = value;
        } else if (key === 'max_rounds' || key === 'maxRounds') {
            const n = Number.parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) parsed.maxRounds = n;
        }
    }
    return parsed;
}

function readCapped(filePath: string): string | null {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return raw.length > MAX_PROMPT_CHARS + 4000 ? raw.slice(0, MAX_PROMPT_CHARS + 4000) : raw;
    } catch {
        return null;
    }
}

/** Names quoted back in a "none of these tools exist" error, capped so the
 *  message stays readable in a terminal and in the manage-agent picker. */
const MAX_NAMES_IN_MESSAGE = 24;

function nameList(names: Iterable<string>): string {
    const all = Array.from(new Set(names)).sort();
    const shown = all.slice(0, MAX_NAMES_IN_MESSAGE).join(', ');
    return all.length > MAX_NAMES_IN_MESSAGE ? `${shown}, … (+${all.length - MAX_NAMES_IN_MESSAGE} more)` : shown;
}

/** Tools a profile may name but never gets: they are stripped for every child
 *  (see filterToolsForSubagent). Saying so beats a bare "unknown tool". */
const ALWAYS_STRIPPED_HINT = new Set<string>([
    SUBAGENT_TOOL_NAME,
    ...SESSION_CONTROL_TOOLS,
    USER_QUESTION_TOOL_NAME,
]);

/** Extra names this host knows about, used only to VALIDATE a definition. */
export interface SubagentValidationContext {
    /** Every tool name a child could be offered in this run (the union over
     *  plan mode, so a plan-mode run never makes a valid name look unknown).
     *  Omitted = skip tool-name validation (standalone/pure use). */
    toolNames?: ReadonlySet<string>;
    /** Model ids the active provider lists. Omitted or EMPTY = the catalog has
     *  not been discovered yet, so an unknown `model:` is not flagged. */
    knownModels?: ReadonlySet<string>;
}

function buildFileDefinition(
    filePath: string,
    baseName: string,
    source: SubagentSource,
    validation?: SubagentValidationContext,
): SubagentDefinition {
    const raw = readCapped(filePath);
    if (raw === null) {
        return { name: baseName, description: '', prompt: '', source, filePath, error: `${baseName}.md is not readable` };
    }
    const parsed = parseSubagentDefinition(raw);
    const nameError = (parsed.name !== undefined && parsed.name !== baseName)
        ? `name "${parsed.name}" does not match the file name "${baseName}"`
        : (!NAME_RE.test(baseName)
            ? `file name "${baseName}" is invalid (lowercase alphanumeric with single hyphens)`
            : (baseName.length > MAX_NAME_CHARS ? `name exceeds ${MAX_NAME_CHARS} characters` : undefined));
    const description = (parsed.description ?? '').trim();
    // `tools:` is resolved against the real toolset here, at LOAD time, so a
    // typo or a foreign tool vocabulary (Claude Code's `Read`/`Bash`) can
    // never reach the model as a launchable-but-useless profile.
    const warnings: string[] = [];
    let tools = parsed.tools;
    let toolsError: string | undefined;
    if (parsed.tools && validation?.toolNames) {
        const resolved = parsed.tools.filter((n) => validation.toolNames!.has(n) && !ALWAYS_STRIPPED_HINT.has(n));
        const stripped = parsed.tools.filter((n) => ALWAYS_STRIPPED_HINT.has(n));
        const missing = parsed.tools.filter((n) => !validation.toolNames!.has(n) && !ALWAYS_STRIPPED_HINT.has(n));
        if (stripped.length > 0) {
            warnings.push(`tools: ${stripped.join(', ')} can never be used by a subagent (always removed) and were dropped`);
        }
        if (missing.length > 0) {
            warnings.push(`tools: unknown tool names ignored: ${nameList(missing)}`);
        }
        if (resolved.length === 0) {
            toolsError = `tools: none of the listed tools exist (${nameList(parsed.tools)}). `
                + `Valid names: ${nameList(validation.toolNames)}`;
        } else {
            tools = resolved;
        }
    }
    if (parsed.model && validation?.knownModels && validation.knownModels.size > 0
        && !validation.knownModels.has(parsed.model)) {
        warnings.push(`model: "${parsed.model}" is not in this provider's model list; the request may fail`);
    }
    const warning = warnings.length > 0 ? warnings.join('; ') : undefined;
    const error = nameError
        ?? (description ? undefined : 'description is missing')
        ?? (description.length > MAX_DESCRIPTION_CHARS
            ? `description exceeds ${MAX_DESCRIPTION_CHARS} characters`
            : undefined)
        ?? (parsed.prompt ? undefined : 'prompt body is missing')
        ?? toolsError;
    return {
        name: baseName,
        description: description.slice(0, MAX_DESCRIPTION_CHARS),
        prompt: parsed.prompt.slice(0, MAX_PROMPT_CHARS),
        ...(tools ? { tools } : {}),
        ...(parsed.maxRounds ? { maxRounds: parsed.maxRounds } : {}),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}),
        source,
        filePath,
        ...(error ? { error } : {}),
        ...(warning ? { warning } : {}),
    };
}

/** Scan one agents/ directory of flat `*.md` files. First VALID winner per
 *  name across the whole discovery wins; an invalid/unreadable entry never
 *  shadows a valid lower-priority copy (same rule as skills.ts) and both
 *  invalid keeps the higher-priority error. Invalid files are kept with
 *  `error` set. */
function scanAgentDir(baseDir: string, source: SubagentSource, out: Map<string, SubagentDefinition>, validation?: SubagentValidationContext): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (e) {
        // A missing directory is the normal case (most users have none);
        // anything else (EACCES, ENOTDIR, …) must not silently drop the
        // user's custom agents.
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            console.error(`xratu: agents dir unreadable: ${baseDir}`, e);
        }
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const baseName = entry.name.slice(0, -3);
        const existing = out.get(baseName);
        if (existing && !existing.error) continue;
        const def = buildFileDefinition(path.join(baseDir, entry.name), baseName, source, validation);
        if (existing && existing.error && def.error) continue;
        out.set(baseName, def);
    }
}

/** Discover subagent definitions: builtins (always) plus project/global
 *  agent files. A custom file whose name matches a builtin REPLACES it
 *  (project-specific `general` beats the stock one). Invalid file entries
 *  are returned with `error` set but never offered to the model; the caller
 *  is expected to SURFACE those (an agent file that silently fails to load is
 *  indistinguishable from one that does not exist). */
export function discoverSubagents(opts?: {
    workspaceRoot?: string;
    homedir?: string;
    /** Validates each file's `tools:` / `model:` against the live host. */
    validation?: SubagentValidationContext;
}): SubagentDefinition[] {
    const workspaceRoot = opts?.workspaceRoot;
    const home = opts?.homedir ?? os.homedir();
    const validation = opts?.validation;
    const found = new Map<string, SubagentDefinition>();
    // Priority: project (xratu-specific first, then cross-agent layouts),
    // then global. Mirrors the skills discovery order.
    if (workspaceRoot) {
        scanAgentDir(path.join(workspaceRoot, '.xratu', 'agents'), 'project-xratu', found, validation);
        scanAgentDir(path.join(workspaceRoot, '.agents', 'agents'), 'project-agents', found, validation);
        scanAgentDir(path.join(workspaceRoot, '.claude', 'agents'), 'project-claude', found, validation);
    }
    scanAgentDir(path.join(home, '.agents', 'agents'), 'global-agents', found, validation);
    scanAgentDir(path.join(home, '.claude', 'agents'), 'global-claude', found, validation);

    const custom = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const customByName = new Map(custom.map((d) => [d.name, d]));
    const merged: SubagentDefinition[] = [];
    const deferredErrors: SubagentDefinition[] = [];
    for (const builtin of builtinSubagents()) {
        const override = customByName.get(builtin.name);
        if (!override) {
            merged.push(builtin);
            continue;
        }
        customByName.delete(builtin.name);
        if (override.error) {
            // A broken file must not shadow the working builtin; keep the
            // error entry at the tail for diagnostics only.
            merged.push(builtin);
            deferredErrors.push(override);
        } else {
            merged.push(override);
        }
    }
    for (const def of custom) {
        if (customByName.has(def.name)) merged.push(def);
    }
    merged.push(...deferredErrors);
    return merged.slice(0, MAX_SUBAGENT_DEFINITIONS);
}

/** Valid (error-free) definitions - the only ones the model may launch. */
export function listableSubagents(defs: readonly SubagentDefinition[]): SubagentDefinition[] {
    return defs.filter((d) => !d.error);
}

/** Every definition a user should HEAR about: ones that failed to load
 *  (`error`) and ones that load with something ignored (`warning`). Builtins
 *  carry neither, so a clean setup yields an empty list. Diagnostics surfaces
 *  (the output channel, the manage-agent picker) render exactly this - an
 *  agent file that silently fails to load is otherwise indistinguishable from
 *  one that does not exist. */
export function subagentIssues(
    defs: readonly SubagentDefinition[],
): Array<{ def: SubagentDefinition; message: string; fatal: boolean }> {
    return defs
        .filter((d) => d.error || d.warning)
        .map((d) => ({
            def: d,
            message: d.error ?? d.warning!,
            fatal: !!d.error,
        }));
}

export function resolveSubagent(
    defs: readonly SubagentDefinition[],
    name: string,
): SubagentDefinition | null {
    return listableSubagents(defs).find((d) => d.name === name) ?? null;
}

/** Filter a tool list down to one subagent's capability surface. The `task`
 *  tool is ALWAYS removed: recursion is denied structurally (in the toolset
 *  AND again at child-executor level), never as a prompt hint. The parent's
 *  session-control tools are removed for the same reason - they write state
 *  one level up. `ask_user_question` is stripped too: interactive decision
 *  cards belong to the root thread (a delegated child has no user to ask).
 *  All strips hold even when a profile's allow-list names them. */
export function filterToolsForSubagent<T extends { name: string }>(
    tools: readonly T[],
    def: Pick<SubagentDefinition, 'tools'> | null | undefined,
): T[] {
    const allow = def?.tools ? new Set(def.tools) : null;
    return tools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME
        && !SESSION_CONTROL_TOOLS.has(tool.name)
        && tool.name !== USER_QUESTION_TOOL_NAME
        && (allow === null || allow.has(tool.name)));
}

/** Starter file for "Xratu: Agent Files → Create". Written with the HOST's
 *  real tool names inlined, because the one way to author a broken agent file
 *  is to guess a tool name - and the wrong guess produces a profile that looks
 *  valid and can do nothing. Frontmatter values stay empty where optional: the
 *  parser treats an empty value as absent, and a full-line `#` comment is
 *  skipped (a trailing one would be read as the value). */
export function agentFileTemplate(name: string, toolNames: readonly string[]): string {
    const preferred = [
        'read_file', 'grep_search', 'glob_search', 'list_files',
        'run_terminal_command', 'web_search', 'fetch_url', 'skill',
    ].filter((tool) => toolNames.includes(tool));
    const shown = (preferred.length > 0 ? preferred : toolNames.slice(0, 8)).slice(0, 8);
    return [
        '---',
        `name: ${name}`,
        'description: One line, shown to the model - when should work be delegated to this agent?',
        '# Optional. Delete the next line to give this agent every tool except',
        '# task (no recursion) and ask_user_question.',
        ...(shown.length > 0 ? [`tools: ${shown.join(', ')}`] : []),
        '# model:            # optional: run this agent on one specific model',
        '# reasoning_effort: # optional: none | minimal | low | medium | high | xhigh | max',
        '# max_rounds: 30    # optional: this agent\'s loop budget (default 50)',
        '---',
        '',
        `You are the ${name} agent.`,
        '',
        'Describe what you do, how you work, and what your final report must',
        'contain. Only that final report reaches the parent agent - your',
        'intermediate tool calls stay private - so make it self-contained, with',
        'file paths and line numbers for every claim.',
        '',
    ].join('\n');
}

export interface TaskToolArgs {
    subagentType: string;
    description: string;
    prompt: string;
    taskId: string;
}

export function parseTaskToolArgs(
    args: Record<string, unknown>,
): { ok: true; value: TaskToolArgs } | { ok: false; error: string } {
    const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!prompt) {
        return { ok: false, error: 'Missing required argument: prompt' };
    }
    if (!subagentType && !taskId) {
        return {
            ok: false,
            error: 'Missing required argument: subagent_type (or task_id to continue a previous subagent run)',
        };
    }
    return { ok: true, value: { subagentType, description, prompt, taskId } };
}

function typeLines(defs: readonly SubagentDefinition[]): string[] {
    return listableSubagents(defs).map((d) => `- ${d.name}: ${d.description}`);
}

/** Task tool description. Lists the launchable subagent types so the model
 *  can pick one; the prompt contract (self-contained, no mid-run questions)
 *  is stated here because a delegated task that leans on parent context
 *  silently fails. */
export function buildTaskToolDescription(defs: readonly SubagentDefinition[]): string {
    return [
        'Delegates a self-contained task to a specialized subagent. The subagent runs in a FRESH context - it cannot see this conversation - and returns only its final report (its intermediate tool calls stay private).',
        'The prompt must contain everything the subagent needs: the goal, relevant file paths, and constraints. The subagent cannot ask questions mid-run. Do not delegate what needs the user\'s decision.',
        'When to delegate: open-ended codebase research (project tours, "how does X work", finding something whose location you do not know), searches that may span many files, and independent subtasks you can hand over whole. Delegation keeps this conversation clean - the subagent\'s long search and file output never lands here.',
        'When NOT to delegate: a lookup you can finish in one or two tool calls, work that leans on this conversation\'s context, and anything where the user must choose.',
        'Every run reports a task_id. If a run was interrupted, failed, or needs follow-up work, pass that task_id to CONTINUE the same subagent with its context restored - never relaunch the same work from scratch.',
        'A task_id lives only as long as this chat does in this VS Code window: reloading the window or clearing the history drops it, and the run must then be started again with subagent_type.',
        'Several task calls in ONE message run CONCURRENTLY as independent subagents - use that for parallelizable subtasks (a few at a time; the rest start as slots free up). They cannot coordinate with each other; one task = one coherent piece of work.',
        'Subagent types (for subagent_type):',
        ...typeLines(defs),
    ].join('\n');
}

export function buildTaskToolSchema(defs: readonly SubagentDefinition[]): Record<string, unknown> {
    const names = listableSubagents(defs).map((d) => d.name).join(', ');
    return {
        type: 'object',
        properties: {
            description: { type: 'string', description: 'A short (3-5 words) description of the task' },
            prompt: {
                type: 'string',
                description: 'The complete, self-contained task for the subagent: goal, relevant paths, constraints. It does not share this conversation, so include everything it needs. When continuing via task_id, describe only the NEXT step - the subagent remembers its earlier work.',
            },
            subagent_type: {
                type: 'string',
                description: `The kind of subagent to launch for a NEW run. Must be one of: ${names}. Omit when continuing a previous run via task_id.`,
            },
            task_id: {
                type: 'string',
                description: 'Continue a previous subagent run of this chat by its task_id (reported in every result) instead of starting over: its context is restored, so interrupted runs resume where they stopped and follow-up work builds on what it already did. Valid only while the same chat stays open in the same window.',
            },
        },
        required: ['prompt'],
    };
}

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
 *   max_rounds: 30               # optional child loop budget
 *   ---
 *   System prompt body…
 *
 * Windows-first: BOM and CRLF are tolerated like every other user-editable
 * file parser in this repo.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Model-facing name of the delegation tool. */
export const SUBAGENT_TOOL_NAME = 'task';

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
    source: SubagentSource;
    /** Parse/validation failure (kept so surfaces can show why an agent
     *  file is not loading; never offered to the model). */
    error?: string;
}

/** Model-facing launch request as validated from tool arguments. */
export interface SubagentRunRequest {
    subagentType: string;
    description: string;
    prompt: string;
    onOutput?: (chunk: string) => void;
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
            description: 'Fast read-only codebase research. Reads and searches the workspace and reports findings with file references; never changes anything.',
            prompt: [
                'You are a codebase research subagent. Investigate the workspace and answer the task you were given with evidence: file paths and line numbers for every claim.',
                'You are read-only by design: gather facts from files, searches and (if needed) the web, then report.',
                'Prefer targeted searches over reading whole files.',
            ].join(' '),
            tools: [
                'read_file', 'grep_search', 'glob_search', 'list_files',
                'list_code_definition_names', 'web_search', 'fetch_url', 'skill',
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
        if (key === 'name' || key === 'description') {
            parsed[key] = value;
        } else if (key === 'tools') {
            const names = value.split(',').map((s) => s.trim()).filter(Boolean);
            if (names.length > 0) parsed.tools = names;
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

function buildFileDefinition(
    filePath: string,
    baseName: string,
    source: SubagentSource,
): SubagentDefinition {
    const raw = readCapped(filePath);
    if (raw === null) {
        return { name: baseName, description: '', prompt: '', source, error: `${baseName}.md is not readable` };
    }
    const parsed = parseSubagentDefinition(raw);
    const nameError = (parsed.name !== undefined && parsed.name !== baseName)
        ? `name "${parsed.name}" does not match the file name "${baseName}"`
        : (!NAME_RE.test(baseName)
            ? `file name "${baseName}" is invalid (lowercase alphanumeric with single hyphens)`
            : (baseName.length > MAX_NAME_CHARS ? `name exceeds ${MAX_NAME_CHARS} characters` : undefined));
    const description = (parsed.description ?? '').trim();
    const error = nameError
        ?? (description ? undefined : 'description is missing')
        ?? (description.length > MAX_DESCRIPTION_CHARS
            ? `description exceeds ${MAX_DESCRIPTION_CHARS} characters`
            : undefined)
        ?? (parsed.prompt ? undefined : 'prompt body is missing');
    return {
        name: baseName,
        description: description.slice(0, MAX_DESCRIPTION_CHARS),
        prompt: parsed.prompt.slice(0, MAX_PROMPT_CHARS),
        ...(parsed.tools ? { tools: parsed.tools } : {}),
        ...(parsed.maxRounds ? { maxRounds: parsed.maxRounds } : {}),
        source,
        ...(error ? { error } : {}),
    };
}

/** Scan one agents/ directory of flat `*.md` files. First valid winner per
 *  name across the whole discovery wins; lower-priority duplicates are
 *  dropped. Invalid files are kept with `error` set. */
function scanAgentDir(baseDir: string, source: SubagentSource, out: Map<string, SubagentDefinition>): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith('.md')) continue;
        const baseName = entry.name.slice(0, -3);
        if (out.has(baseName)) continue;
        out.set(baseName, buildFileDefinition(path.join(baseDir, entry.name), baseName, source));
    }
}

/** Discover subagent definitions: builtins (always) plus project/global
 *  agent files. A custom file whose name matches a builtin REPLACES it
 *  (project-specific `general` beats the stock one). Invalid file entries
 *  are returned with `error` set but never offered to the model. */
export function discoverSubagents(opts?: {
    workspaceRoot?: string;
    homedir?: string;
}): SubagentDefinition[] {
    const workspaceRoot = opts?.workspaceRoot;
    const home = opts?.homedir ?? os.homedir();
    const found = new Map<string, SubagentDefinition>();
    // Priority: project (xratu-specific first, then cross-agent layouts),
    // then global. Mirrors the skills discovery order.
    if (workspaceRoot) {
        scanAgentDir(path.join(workspaceRoot, '.xratu', 'agents'), 'project-xratu', found);
        scanAgentDir(path.join(workspaceRoot, '.agents', 'agents'), 'project-agents', found);
        scanAgentDir(path.join(workspaceRoot, '.claude', 'agents'), 'project-claude', found);
    }
    scanAgentDir(path.join(home, '.agents', 'agents'), 'global-agents', found);
    scanAgentDir(path.join(home, '.claude', 'agents'), 'global-claude', found);

    const custom = Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const customByName = new Map(custom.map((d) => [d.name, d]));
    const merged: SubagentDefinition[] = [];
    for (const builtin of builtinSubagents()) {
        const override = customByName.get(builtin.name);
        if (override) {
            customByName.delete(builtin.name);
            merged.push(override);
        } else {
            merged.push(builtin);
        }
    }
    for (const def of custom) {
        if (customByName.has(def.name)) merged.push(def);
    }
    return merged.slice(0, MAX_SUBAGENT_DEFINITIONS);
}

/** Valid (error-free) definitions - the only ones the model may launch. */
export function listableSubagents(defs: readonly SubagentDefinition[]): SubagentDefinition[] {
    return defs.filter((d) => !d.error);
}

export function resolveSubagent(
    defs: readonly SubagentDefinition[],
    name: string,
): SubagentDefinition | null {
    return listableSubagents(defs).find((d) => d.name === name) ?? null;
}

/** Filter a tool list down to one subagent's capability surface. The `task`
 *  tool is ALWAYS removed: recursion is denied structurally (in the toolset
 *  AND again at child-executor level), never as a prompt hint. */
export function filterToolsForSubagent<T extends { name: string }>(
    tools: readonly T[],
    def: Pick<SubagentDefinition, 'tools'> | null | undefined,
): T[] {
    const allow = def?.tools ? new Set(def.tools) : null;
    return tools.filter((tool) => tool.name !== SUBAGENT_TOOL_NAME
        && (allow === null || allow.has(tool.name)));
}

export interface TaskToolArgs {
    subagentType: string;
    description: string;
    prompt: string;
}

export function parseTaskToolArgs(
    args: Record<string, unknown>,
): { ok: true; value: TaskToolArgs } | { ok: false; error: string } {
    const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    if (!subagentType) {
        return { ok: false, error: 'Missing required argument: subagent_type' };
    }
    if (!prompt) {
        return { ok: false, error: 'Missing required argument: prompt' };
    }
    return { ok: true, value: { subagentType, description, prompt } };
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
        'The prompt must contain everything the subagent needs: the goal, relevant file paths, and constraints. The subagent cannot ask questions mid-run. Do not delegate what needs the user\'s decision, and do not delegate a task you can finish in one or two tool calls yourself.',
        'Several task calls in ONE message are executed in order, one subagent at a time - use that for independent subtasks, not for a single task.',
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
                description: 'The complete, self-contained task for the subagent: goal, relevant paths, constraints. It does not share this conversation, so include everything it needs.',
            },
            subagent_type: {
                type: 'string',
                description: `The kind of subagent to launch. Must be one of: ${names}`,
            },
        },
        required: ['prompt', 'subagent_type'],
    };
}

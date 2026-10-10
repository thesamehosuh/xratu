import * as vscode from 'vscode';
import { isOfflineMode } from './networkPolicy';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { decodeUnicodeEscapes, looksBinary, parsePatchBlocks, repairPatchMarkers, sanitizePath, withPathAlias } from './paths';
import { UNPARSED_ARGS_KEY, resolveEditContentFrom, resolveEditMode } from './tooling/editFileArgs';
import { resolveToolName } from './tooling/toolNames';
import {
    terminalToolDescription,
    terminalCommandParamDescription,
} from './tooling/shellPlatform';
import { ExternalMcpManager, EXTERNAL_PREFIX } from './externalMcp';
import { executeWebTool } from './webTools';
import {
    XRATU_EXPANSION_TOOLS,
    handleExpansionTool,
    EXPANSION_MUTATING_TOOL_NAMES,
    type ExpansionToolRuntime,
} from './xratu_mcp_tools';
import {
    DEFAULT_LOG_LINES,
    DEFAULT_WAIT_MS,
    MAX_WAIT_MS,
    awaitTerminalJob,
    describeBackgroundHandoff,
    describeTerminalJob,
    formatTerminalResult,
    getTerminalJob,
    listTerminalJobs,
    markCompletionConsumed,
    readJobOutput,
    spawnTerminalJob,
    waitForTerminalJob,
} from './tooling/backgroundJobs';
import {
    USER_QUESTION_TOOL_NAME,
    formatUserQuestionResult,
    parseUserQuestionArgs,
    type UserQuestionGate,
} from './tooling/userQuestion';
import type { LocalToolDefinition, LocalToolResult } from './local/localAgent';
import {
    SUBAGENT_TOOL_NAME,
    buildTaskToolDescription,
    buildTaskToolSchema,
    listableSubagents,
    parseTaskToolArgs,
    type SubagentDefinition,
    type SubagentRunner,
} from './subagents';
import {
    buildSkillToolDescription,
    buildSkillToolSchema,
    findSkillDir,
    listableSkills,
    readSkillBody,
    readSkillResource,
    skillDirectoryDisplayPath,
    type DiscoveredSkill,
    type SkillResolution,
} from './skills';

/** Tools that change workspace state - each execution is preceded by an
 *  automatic shadow-checkpoint snapshot (once per turn). */
const MUTATING_TOOLS = new Set([
    'edit_file', 'replace_in_file', 'apply_patch',
    'run_terminal_command',
    ...EXPANSION_MUTATING_TOOL_NAMES,
]);

/**
 * Dropped in PLAN MODE without being approval-gated. A plan is a read-only
 * reconnaissance pass: it must not stop processes, and there can be no
 * background job to inspect anyway because the only tool that starts one is
 * itself dropped. Kept separate from MUTATING_TOOLS because `poll`/`log` on
 * `process` are reads and must not cost an approval prompt.
 */
const PLAN_MODE_DENIED_TOOLS = new Set(['process']);

/**
 * Target-triple directories VS Code uses inside `@vscode/ripgrep-universal/bin`.
 * Purely advisory: every candidate is filtered by `existsSync`, so listing the
 * host's plausible triples costs nothing and survives upstream additions.
 */
function ripgrepTargets(platform: NodeJS.Platform, arch: string): string[] {
    // Node reports armv7l as 'arm'; the npm triple spells it 'armhf'.
    const a = arch === 'arm' ? 'armhf' : arch;
    if (platform === 'win32') return [`win32-${a}`];
    if (platform === 'darwin') return [`darwin-${a}`];
    // Linux ships BOTH a glibc and a musl build; which one is on disk
    // depends on the host, so offer both rather than guessing.
    if (platform === 'linux') return [`linux-${a}`, `alpine-${a}`];
    return [`${platform}-${a}`];
}

/**
 * Locate a ripgrep binary: PATH first (`rg`/`rg.exe`), then VS Code's own
 * bundled copy - either the VSCODE_RIPGREP_PATH hint or the well-known
 * location under the app root. Windows machines usually have NO `rg` on PATH
 * and no env hint either, so the app-root candidate is what makes search work
 * there at all. The probe is ASYNC and cached as a promise: the old
 * spawnSync blocked the extension host for up to 1.5s on the first search of a
 * session. `ripgrepCandidates` is pure (unit-tested).
 *
 * The app-root layout matters and has changed twice:
 *   - current VS Code unpacks native modules out of the asar, and ships
 *     ripgrep as `@vscode/ripgrep-universal` under a platform-ARCH
 *     directory: `node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/
 *     win32-x64/rg.exe`;
 *   - older VS Code used `node_modules/@vscode/ripgrep/bin/rg.exe`.
 * Probing only the old layout is what made Windows search hard-error with
 * "rg is not installed" on a VS Code that had it bundled all along.
 */
export function ripgrepCandidates(opts: {
    env: Record<string, string | undefined>;
    appRoot: string | null;
    platform: NodeJS.Platform;
    arch?: string;
}): string[] {
    const out: string[] = [];
    const bundled = opts.env.VSCODE_RIPGREP_PATH;
    if (bundled) out.push(bundled);
    if (opts.appRoot) {
        const exe = opts.platform === 'win32' ? 'rg.exe' : 'rg';
        for (const target of ripgrepTargets(opts.platform, opts.arch ?? 'x64')) {
            out.push(path.join(
                opts.appRoot,
                'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin',
                target, exe,
            ));
        }
        // Pre-universal VS Code layout, kept as a fallback.
        out.push(path.join(
            opts.appRoot,
            'node_modules', '@vscode', 'ripgrep', 'bin', exe,
        ));
    }
    return out;
}

let _rgPath: Promise<string | null> | null = null;
function findRipgrep(): Promise<string | null> {
    if (!_rgPath) _rgPath = probeRipgrep();
    return _rgPath;
}
function probeRipgrep(): Promise<string | null> {
    // Windows Defender/AV can stretch an exe launch well past 1.5s.
    const timeout = process.platform === 'win32' ? 4000 : 1500;
    return new Promise((resolve) => {
        cp.execFile('rg', ['--version'], { timeout, windowsHide: true }, (err) => {
            if (!err) {
                resolve('rg');
                return;
            }
            // A TIMED-OUT or AV-blocked probe is transient and must NOT be
            // cached as "no ripgrep" - that would permanently disable
            // rg-backed search for the session. Only a definite absence
            // (ENOENT) sticks.
            const code = (err as NodeJS.ErrnoException).code;
            const transient = code === 'ETIMEDOUT'
                || code === 'EACCES'
                || code === 'EPERM'
                || (err as { killed?: boolean }).killed === true;
            if (transient) _rgPath = null;
            for (const candidate of ripgrepCandidates({
                env: process.env,
                appRoot: vscode.env.appRoot || null,
                platform: process.platform,
                arch: process.arch,
            })) {
                if (fs.existsSync(candidate)) {
                    resolve(candidate);
                    return;
                }
            }
            resolve(null);
        });
    });
}

/** Collect current problems (errors/warnings) for one file so the model gets
 *  immediate lint feedback after its edits - Aider-style verify loop.
 *  Language servers publish asynchronously: read synchronously right after
 *  the write and every FRESH error is invisible (a live dogfood run shipped
 *  undefined-name errors that this check silently missed). Wait for the
 *  language server's change event instead of fixed sleeps - a fast publisher
 *  is picked up in tens of ms, and a file with no server is still bounded by
 *  the budget. A clear-then-set sequence fires two events; the short settle
 *  after each catches the second state. */
const DIAGNOSTICS_BUDGET_MS = 450;
const DIAGNOSTICS_SETTLE_MS = 60;

function waitForDiagnosticsChange(uri: vscode.Uri, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (fired: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sub.dispose();
            resolve(fired);
        };
        const sub = vscode.languages.onDidChangeDiagnostics((e) => {
            if (e.uris.some((u) => u.toString() === uri.toString())) finish(true);
        });
        const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    });
}

async function diagnosticsSummary(uri: vscode.Uri): Promise<string> {
    try {
        const interesting = (d: readonly vscode.Diagnostic[]) =>
            d.some((x) => x.severity <= vscode.DiagnosticSeverity.Warning);
        let diags: readonly vscode.Diagnostic[] = vscode.languages.getDiagnostics(uri);
        const deadline = Date.now() + DIAGNOSTICS_BUDGET_MS;
        while (!interesting(diags) && Date.now() < deadline) {
            const fired = await waitForDiagnosticsChange(uri, deadline - Date.now());
            if (!fired) break;
            // Settle briefly so a clear-then-set pair lands together, but never
            // past the budget: an event landing at the deadline must not push
            // the wait beyond the ceiling the comment above advertises.
            const settle = Math.min(DIAGNOSTICS_SETTLE_MS, Math.max(0, deadline - Date.now()));
            if (settle > 0) await new Promise((r) => setTimeout(r, settle));
            diags = vscode.languages.getDiagnostics(uri);
        }
        const picked = diags.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
        if (picked.length === 0) return '';
        const errors = picked.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
        const lines = picked.slice(0, 10).map((d) => {
            const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
            const kind = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
            return `  [${kind}] ${pos} ${d.message.split('\n')[0]}`;
        });
        const head = `[Diagnostics] ${errors.length} error(s), ${picked.length - errors.length} warning(s) after this edit:`;
        return '\n' + head + '\n' + lines.join('\n');
    } catch {
        return '';
    }
}

/**
 * Windows files are commonly CRLF; models emit LF. Every write path funnels
 * through this: when the ORIGINAL content used CRLF, the updated text is
 * re-encoded to CRLF (otherwise normalized to LF) - so edits never flip a
 * file's line endings or leave them mixed. Idempotent on either style.
 */
function preserveEol(original: string, updated: string): string {
    const crlf = original.includes('\r\n');
    return crlf ? updated.replace(/\r?\n/g, '\r\n') : updated.replace(/\r\n/g, '\n');
}

/** Read a file and strip per-line trailing \r so CRLF content looks the same
 *  to the model as LF content (it cannot see or emit \r reliably). */
function readLines(fullPath: string): string[] {
    return fs.readFileSync(fullPath, 'utf-8').split('\n').map((l) => l.replace(/\r$/, ''));
}

// ---------------------------------------------------------------------------
// Local runtime adapter - exported for reuse by the local agent runtime.
//
// The local agent (src/local/localAgent.ts) must NOT duplicate tool schemas or
// execution logic. These exports let it call the same code paths the MCP
// bridge uses. External MCP tools (mcp__*) ARE exposed to the local runtime
// via the manager (fetched by the host before the run); in plan mode they are
// dropped entirely: plan mode denies mutating tools unconditionally.
// ---------------------------------------------------------------------------

const BUILTIN_TOOL_DEFINITIONS: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}> = [
    {
        name: 'edit_file',
        description: [
            'Whole-file writer: mode="overwrite" (default) REPLACES ITS ENTIRE CONTENT with new_content; mode="create" fails if the file already exists; mode="append" adds new_content to the end. Practical per-call ceiling is roughly 8KB of new_content - model output limits truncate larger calls mid-JSON, so build big files in chunks: mode "create" with a skeleton, then mode "append" pieces.',
            'To change PART of an existing file, do NOT use this tool - apply_patch (one or more SEARCH/REPLACE blocks) preserves the rest of the file.',
            'Overwriting far less content than the file has requires confirm_overwrite: true (200+ lines shrunk to under half, or 20+ lines shrunk to under a quarter) - a guard against accidental whole-file replacement.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root' },
                new_content: { type: 'string', description: 'The new file content (complete content for overwrite/create, text to add for append)' },
                mode: { type: 'string', enum: ['overwrite', 'create', 'append'], description: 'overwrite (default) replaces the whole file; create fails if the file exists; append adds to the end' },
                confirm_overwrite: { type: 'boolean', description: 'Required when overwriting would destroy most of the file: 200+ lines shrunk to under half, or 20+ lines shrunk to under a quarter' }
            },
            required: ['path', 'new_content']
        }
    },
    {
        name: 'read_file',
        description: 'Reads a file from the workspace. Returns up to 2000 lines per call and 80KB of text; use start_line to page through very large files.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                start_line: { type: 'number', description: '1-based line to start from (default 1)' },
                max_lines: { type: 'number', description: 'Max lines to return (default 1200, hard cap 2000)' }
            },
            required: ['path']
        }
    },
    {
        name: 'run_terminal_command',
        // States the shell THIS host actually uses (cmd.exe vs bash). The old
        // generic "bash, or cmd on Windows" line, paired with a POSIX-only
        // example, is what made the model open with grep/ls on Windows.
        description: terminalToolDescription(process.platform),
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: terminalCommandParamDescription(process.platform) },
                background: {
                    type: 'boolean',
                    description: 'Return immediately and let the command keep running (dev servers, file watchers, GUI apps like xdg-open). Skips both timeouts, so nothing will stop it later - not a cancel, not a turn ending - and it is your job to `process`-kill it when you are done. You get a job id back to poll, log or kill.'
                },
                // Deprecated alias, still accepted so an older session that
                // learned `detach` keeps working instead of silently blocking.
                detach: { type: 'boolean', description: 'Deprecated alias for background.' }
            },
            required: ['command']
        }
    },
    {
        name: 'process',
        // NOT approval-gated, and that is deliberate: every job id it accepts
        // was minted by this extension for this session, `kill` acts only on
        // such an id, and there is no way to name an arbitrary OS pid - so
        // `kill` terminates a process WE started, not one the user owns.
        // Gating the read actions would mean an approval prompt per poll.
        description: [
            'Manages commands started with run_terminal_command(background=true).',
            'Actions:',
            '- list: every job this session still knows about, running or recently finished.',
            '- poll: is it still running, and what is the newest output.',
            '- log: page through its output with offset/limit when the tail is not enough.',
            '- wait: block until it finishes or the timeout elapses; reports "still running" rather than pretending it ended.',
            '- kill: stop it and its child processes.',
            'Finished jobs stay readable for a while after they exit, so a poll after a long turn still finds them.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'poll', 'log', 'wait', 'kill'], description: 'What to do.' },
                jobId: { type: 'string', description: 'Job id from run_terminal_command or list. Not needed for list.' },
                offset: { type: 'number', description: 'First line to return for log (default: the newest 200 lines).' },
                limit: { type: 'number', description: 'Max lines for log (default 200).' },
                timeout: { type: 'number', description: `Seconds wait may block, default ${DEFAULT_WAIT_MS / 1000}, max ${MAX_WAIT_MS / 1000}.` }
            },
            required: ['action']
        }
    },
    {
        name: 'grep_search',
        description: 'Searches for a text pattern in files using ripgrep. Returns matching lines with file paths and line numbers.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Search pattern (supports regex)' },
                path: { type: 'string', description: 'Directory or file to search in (relative to workspace root)' },
                include: { type: 'string', description: 'File glob to filter (e.g. "*.py")' }
            },
            required: ['pattern']
        }
    },
    // replace_in_file was MERGED into apply_patch: a single SEARCH/REPLACE
    // block is exactly one replace, and apply_patch's matcher (exact →
    // trimEnd → whitespace-normalized) already covered replace_in_file's
    // fuzzy fallbacks. The dispatcher below still executes the legacy name
    // so replayed history from older sessions never breaks.

    {
        name: 'list_files',
        description: 'Lists files and directories at a given path. Returns directory names, file names, and sizes.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory path relative to workspace root. Defaults to workspace root.' }
            },
            required: []
        }
    },
    {
        name: 'glob_search',
        description: 'Finds files by name pattern using glob matching. Returns matching file paths.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern (e.g. "*.py", "src/**/*.ts", "**/*.test.*")' },
                path: { type: 'string', description: 'Directory to search in (relative to workspace root). Defaults to workspace root.' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'apply_patch',
        description: [
            'Edits ONE OR MORE places in an existing file using SEARCH/REPLACE blocks - the tool for ALL targeted edits (a single block replaces exactly one string; repeat blocks for multiple edits).',
            'Format each block EXACTLY like this, repeating for every edit. Every marker goes ALONE on its own line:',
            // Rendered with REAL newlines. This example used to be joined with
            // spaces, so all five markers appeared INLINE on a single line while
            // the parser requires a newline after each. A model imitating the
            // description then emitted a one-line patch that could never parse,
            // and the error blamed a missing separator it could not see. The
            // example must match the grammar it documents.
            ['<<<<<<< SEARCH', '<exact lines currently in the file>', '=======', '<replacement lines>', '>>>>>>> REPLACE'].join('\n'),
            'SEARCH must match the current file (copy byte-exact from read_file output); leading indentation is auto-corrected and whitespace-normalized fallback matching applies.',
            'To CREATE a new file, use one block with an EMPTY SEARCH section and the full file content as REPLACE.',
            'Never include lines starting with <<<<<<<, =======, or >>>>>>> inside block content - the parser refuses such patches; edit those hunks with edit_file instead.',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root' },
                patch: { type: 'string', description: 'One or more SEARCH/REPLACE blocks' }
            },
            required: ['path', 'patch']
        }
    },
    {
        name: 'list_code_definition_names',
        description: 'Lists function, class, and method definitions in a file. Returns signatures without full bodies.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root' }
            },
            required: ['path']
        }
    },
    {
        // NOT in MUTATING_TOOLS: the card is read-only and is itself the
        // user-interaction surface - gating it behind an approval card would
        // be circular. Available in plan mode like read_file.
        name: USER_QUESTION_TOOL_NAME,
        description: [
            'Present a decision card and wait for the user\'s pick.',
            'Use this INSTEAD of writing a multiple-choice question in prose when the answer is genuinely the user\'s call: preferences, tradeoffs, ambiguous direction, or choices with several defensible answers.',
            'One question per call, with 2-4 mutually exclusive options that are complete, actionable answers (no placeholders). Mark at most one option recommended: true - the one you would choose.',
            'Do NOT add an "Other"/catch-all option: the card always offers a free-text answer automatically.',
            'In plan mode, resolve approach/scope choices with this tool BEFORE finalizing the plan - the user\'s pick shapes the task list.',
            'Never use it for permission requests or to ask whether to proceed - never ask what you can decide or verify yourself.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                header: { type: 'string', description: 'Very short label shown as the card header (max 30 chars), e.g. "Approach"' },
                question: { type: 'string', description: 'The single decision to make, phrased as one clear question' },
                options: {
                    type: 'array',
                    description: '2-4 mutually exclusive choices for this question',
                    minItems: 2,
                    maxItems: 4,
                    items: {
                        type: 'object',
                        properties: {
                            label: { type: 'string', description: 'Display text (1-5 words, concise)' },
                            description: { type: 'string', description: 'One short sentence: what choosing this option means' },
                            recommended: { type: 'boolean', description: 'true for the single option you recommend' }
                        },
                        required: ['label', 'description']
                    }
                }
            },
            required: ['question', 'options']
        }
    },
    ...XRATU_EXPANSION_TOOLS,
];

/**
 * Web tools for the LOCAL agent runtime only. They must NOT ride the MCP
 * bridge or the names would collide with user-configured MCP tools.
 * Execution lives in webTools.ts (extension host, Node fetch).
 */
const WEB_TOOL_DEFINITIONS: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}> = [
    {
        name: 'web_search',
        description: 'Search the public web. If this fails for any reason, do NOT retry - move on to fetch_url to retrieve specific pages directly, and do not mention the search failure to the user.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                max_results: { type: 'number', description: 'Max results to return (default 8, cap 20)' },
                domains: { type: 'array', items: { type: 'string' }, description: 'Restrict results to these domains' }
            },
            required: ['query']
        }
    },
    {
        name: 'fetch_url',
        description: 'Fetch a public HTTP(S) URL for documentation/research. Returns the page text (HTML stripped), truncated to max_chars.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                max_chars: { type: 'number', description: 'Max characters to return (default 30000, range 1000-120000)' }
            },
            required: ['url']
        }
    },
];

/** Tool definitions with approval flags - feeds the local agent's tool list.
 *  Includes the local-only web tools (cloud mode never sees those).
 *  yolo: skip approval gates on mutating tools. plan: drop mutating tools
 *  AND external MCP tools entirely (server-side plan mode is the source
 *  of truth; this is the local-runtime mirror). `external` carries the
 *  external MCP tool aggregation fetched by the host (async, so the host
 *  supplies it rather than this pure function). `skills` carries the
 *  discovered Agent Skills - the `skill` tool is read-only, so it is
 *  available in plan mode like read_file. `subagents` carries the
 *  discovered subagent definitions - when present the `task` delegation
 *  tool is advertised (absent in a CHILD toolset, which is the structural
 *  recursion deny; see local/subagentRunner.ts). `task` needs no approval
 *  of its own: every mutation a child might make still passes through the
 *  child's own per-tool approval flags. */
export function getLocalToolDefinitions(opts?: {
    yolo?: boolean;
    plan?: boolean;
    external?: import('./externalMcp').AggregatedTool[];
    skills?: DiscoveredSkill[];
    subagents?: SubagentDefinition[];
}): LocalToolDefinition[] {
    const yolo = !!opts?.yolo;
    const plan = !!opts?.plan;
    const builtin = BUILTIN_TOOL_DEFINITIONS
        .filter((tool) => !plan || (!MUTATING_TOOLS.has(tool.name) && !PLAN_MODE_DENIED_TOOLS.has(tool.name)))
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            requiresApproval: yolo ? false : MUTATING_TOOLS.has(tool.name),
        }));
    const web = (isOfflineMode() ? [] : WEB_TOOL_DEFINITIONS).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresApproval: false,
    }));
    const external = (opts?.external ?? [])
        .filter((_tool) => !plan && !isOfflineMode())
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            requiresApproval: yolo ? false : !tool.autoApprove,
        }))
        // Stable order for prompt caching: tool definitions are the FIRST
        // cacheable segment of the request, and a reconnecting MCP server can
        // hand back its tools in a different order, which would rewrite the
        // cached prefix. Builtin/web/skill order is curated and left as-is.
        // `localeCompare` can return 0 for DISTINCT names (canonically
        // equivalent Unicode), which would fall back to server order; the raw
        // code-point tie-break keeps the sort total and deterministic.
        .sort((a, b) => a.name.localeCompare(b.name)
            || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const skillDefs: LocalToolDefinition[] = [];
    const skills = listableSkills(opts?.skills ?? []);
    if (skills.length > 0) {
        skillDefs.push({
            name: 'skill',
            description: buildSkillToolDescription(skills),
            inputSchema: buildSkillToolSchema(skills),
            requiresApproval: false,
        });
    }
    // `task` (subagent delegation): NEVER advertised in plan mode - a planning
    // run must finish the plan and call exit_plan_mode, not farm the work out
    // to a subagent ("implement this" delegation during planning is the bug
    // this prevents; the child's tools are plan-filtered as defense in depth).
    // Implementation happens on a LATER turn, in the main thread.
    // Advertised only when at least one VALID profile can be launched.
    const taskDefs: LocalToolDefinition[] = [];
    const subagents = opts?.subagents;
    if (!plan && subagents && listableSubagents(subagents).length > 0) {
        taskDefs.push({
            name: SUBAGENT_TOOL_NAME,
            description: buildTaskToolDescription(subagents),
            inputSchema: buildTaskToolSchema(subagents),
            requiresApproval: false,
        });
    }
    return [...builtin, ...web, ...taskDefs, ...skillDefs, ...external];
}

/**
 * The `process` tool: inspect and stop jobs this session started.
 *
 * `kill` takes a job id and nothing else. There is deliberately no pid
 * parameter, so this tool cannot reach a process the extension did not start -
 * which is why it is not approval-gated (see its definition above).
 *
 * Note the deliberate ASYMMETRY with the `nested` guard on spawning: a child
 * cannot start a background job, but it CAN kill one, because the jobs are
 * session-wide and not owned by whoever started them. That is the useful
 * direction - a child handed a job id to shut down is the common case - and the
 * risky direction is bounded, since it can only name jobs this session minted.
 */
async function dispatchProcessTool(args: any): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}> {
    const text = (body: string, isError?: boolean): {
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    } => ({ content: [{ type: 'text', text: body }], isError });
    const action = String(args?.action ?? '').trim();
    const known = ['list', 'poll', 'log', 'wait', 'kill'];
    if (!known.includes(action)) {
        return text(`Error: unknown action '${action || '(missing)'}'. Use one of: ${known.join(', ')}.`, true);
    }

    if (action === 'list') {
        const all = listTerminalJobs();
        if (!all.length) {
            return text('No background jobs. Start one with run_terminal_command and background=true.');
        }
        const running = all.filter((job) => job.status === 'running').length;
        return text([
            `${all.length} job(s), ${running} still running:`,
            '',
            ...all.map(describeTerminalJob),
        ].join('\n'));
    }

    const jobId = String(args?.jobId ?? '').trim();
    const job = getTerminalJob(jobId);
    if (!job) {
        // Never echo a caller-supplied string into a "did you mean" without
        // bounding it, and never pretend a job exists that the registry does
        // not have - a wrong id must read as wrong, not as "no output".
        const hint = jobId ? ` (got '${jobId.slice(0, 64)}')` : '';
        return text(`Error: no such job${hint}. Use action 'list' to see the jobs this session knows about.`, true);
    }

    const numberArg = (value: unknown, fallback: number) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    };

    if (action === 'poll') {
        return text(`${describeTerminalJob(job)}\n\n${readJobOutput(job)}`);
    }
    if (action === 'log') {
        // The model now holds the transcript, so a later completion notice
        // would only repeat it.
        markCompletionConsumed(job.id);
        return text(readJobOutput(job, {
            // `undefined`, not 0: an absent offset means "the newest lines",
            // while an explicit 0 means "from the beginning". Coercing the
            // absent case to 0 silently disabled the tail window and made `log`
            // return a 50k-line log's oldest 200 lines.
            ...(args?.offset === undefined ? {} : { offset: numberArg(args?.offset, 0) }),
            limit: numberArg(args?.limit, DEFAULT_LOG_LINES),
        }));
    }
    if (action === 'wait') {
        const seconds = numberArg(args?.timeout, DEFAULT_WAIT_MS / 1000);
        const capped = Math.min(Math.max(seconds, 0), MAX_WAIT_MS / 1000);
        const ended = await waitForTerminalJob(job, capped * 1000);
        if (!ended) {
            return text(`${describeTerminalJob(job)}\n\nStill running after ${capped}s - it did NOT finish. Its output so far:\n\n${readJobOutput(job)}`);
        }
        markCompletionConsumed(job.id);
        return text(finishedJobReport(job));
    }
    // kill
    if (job.status !== 'running') {
        return text(`${job.id} already ${job.status === 'killed' ? 'killed' : `finished (${describeTerminalJob(job)})`}. Nothing to stop.`);
    }
    job.kill('killed by the agent');
    await job.finished;
    // The kill path hands back the full finished report, so the notice would
    // be a duplicate.
    markCompletionConsumed(job.id);
    return text(finishedJobReport(job));
}

/** The finished-job report the `process` tool returns for wait/kill. */
function finishedJobReport(job: import('./tooling/backgroundJobs').TerminalJob): string {
    return formatTerminalResult(job, process.platform);
}

/** Shared dispatch: executes a single built-in or expansion tool.
 *  `skillResolver` (when provided) performs the single discovery+authorization
 *  pass for the `skill` tool - the model cannot load a user-disabled skill
 *  via a direct call, and the resolved dirPath is reused for the body load
 *  (no second scan). Without it, skills resolve unauthenticated. */
async function dispatchTool(
    workspaceRoot: string,
    name: string,
    args: any,
    ensureTurnSnapshot: (workspaceRoot: string, reason: string) => Promise<void>,
    skillResolver?: (name: string) => SkillResolution,
    /** Incremental output sink for long-running tools (terminal commands). */
    onOutput?: (chunk: string) => void,
    /** Nested-run capability for the `task` tool. Present only on the parent
     *  run's executor - child executors omit it, which is part of the
     *  structural recursion deny. */
    subagentRunner?: SubagentRunner,
    /** User decision card for `ask_user_question`. Present only on the
     *  parent run's executor: interactive questions stay at the root thread
     *  (a delegated child has no user of its own to ask). */
    decisionGate?: UserQuestionGate,
    /** Server-side tool_call_id of the call being executed. The webview's
     *  "run in background" button can only name the row it is drawn on, so
     *  this is how a running command is found again from the UI. */
    callId?: string,
    /** True inside a delegated subagent. A child gets its own tools but not
     *  the parent's ability to leave work running behind it. */
    nested = false,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    if (name === 'edit_file') {
        // Resolve `mode` FIRST: an unknown value must fail loudly, before any
        // fs work and before a checkpoint is taken. This used to silently
        // become "overwrite", so a botched partial-edit call (mode:
        // "replace") destroyed the whole file instead of erroring.
        const resolvedMode = resolveEditMode(args.mode);
        if ('error' in resolvedMode) {
            return { content: [{ type: 'text', text: resolvedMode.error }], isError: true };
        }
        // Arguments that never arrived intact say so honestly: the model sent
        // SOMETHING, we could not parse it, and blaming `new_content` sent it
        // into a resend loop on every large write.
        if (args && args[UNPARSED_ARGS_KEY]) {
            return {
                content: [{ type: 'text', text: `Error: tool-call arguments arrived malformed or truncated and could not be parsed (received head: ${String(args[UNPARSED_ARGS_KEY])}). If the call was large, it was most likely cut off at the model's output token limit mid-JSON - do NOT resend it whole: write the file in chunks (create a skeleton with edit_file mode "create", then append or apply_patch the rest in smaller pieces). If it was small, resend it as a single plain-JSON arguments object.` }],
                isError: true,
            };
        }
        // Resolve the CONTENT for the same reason: an omitted key used to reach
        // preserveEol() unvalidated and crash with a raw TypeError instead of
        // naming the missing argument. Known alias keys count as present.
        const resolvedContent = resolveEditContentFrom(args);
        if ('error' in resolvedContent) {
            return { content: [{ type: 'text', text: resolvedContent.error }], isError: true };
        }
        await ensureTurnSnapshot(workspaceRoot, 'before edit');
        const fullPath = sanitizePath(args.path, workspaceRoot);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const existed = fs.existsSync(fullPath);
        const previous = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
        const mode = resolvedMode.mode;
        if (mode === 'create' && existed) {
            return { content: [{ type: 'text', text: `Error: ${args.path} already exists - use mode "overwrite" to replace it or "append" to add to it.` }], isError: true };
        }
        let next: string;
        if (mode === 'append' && existed) {
            const eol = previous.includes('\r\n') ? '\r\n' : '\n';
            next = previous + (previous && !previous.endsWith('\n') ? eol : '') + preserveEol(previous, resolvedContent.content);
        } else {
            next = preserveEol(previous, resolvedContent.content);
        }
        // Cliff guard: refuse the accidental destruction of a file via
        // whole-file overwrite unless explicitly confirmed. Two cliffs: the
        // absolute one (200+ lines shrunk below half) and a relative one
        // (20+ lines shrunk below a quarter) - the absolute cliff alone let a
        // 130-line file be clobbered down to 1 line in real dogfood use.
        // replace_in_file / apply_patch remain the right tools for targeted edits.
        const prevLines = previous ? previous.split('\n').length : 0;
        const nextLines = next ? next.split('\n').length : 0;
        if (existed && mode === 'overwrite' && !args.confirm_overwrite
            && ((prevLines >= 200 && nextLines < prevLines / 2)
                || (prevLines >= 20 && nextLines < prevLines / 4))) {
            return {
                content: [{ type: 'text', text: `Error: refusing to overwrite ${args.path}: it has ${prevLines} lines and new_content would reduce it to ${nextLines}. If this is intentional, resend with confirm_overwrite: true (or use apply_patch for targeted edits).` }],
                isError: true
            };
        }
        fs.writeFileSync(fullPath, next, 'utf-8');
        const delta = nextLines - prevLines;
        const verb = existed ? 'updated' : 'created';
        const stats = existed
            ? ` - ${prevLines} → ${nextLines} lines (${delta >= 0 ? '+' : ''}${delta})`
            : ` (${nextLines} lines)`;
        // Append saves are mid-build by definition - the linter would only
        // report the expected "unterminated" noise of an intentionally
        // incomplete file (live: every chunked write lit up).
        const diag = mode === 'append' ? '' : await diagnosticsSummary(vscode.Uri.file(fullPath));
        return { content: [{ type: 'text', text: `Successfully ${verb} ${args.path}${stats}` + diag }] };
    } else if (name === 'read_file') {
        const fullPath = sanitizePath(args.path, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: file not found: ${args.path}` }], isError: true };
        }
        {
            // Binary payloads (PNG, zips, executables) used to come back as
            // walls of mojibake that ate the context window (live: an 80KB
            // PNG "read" as text). Refuse with a next step instead.
            const head = fs.readFileSync(fullPath).subarray(0, 8192);
            if (looksBinary(Buffer.from(head))) {
                const kb = Math.round(fs.statSync(fullPath).size / 1024);
                return {
                    content: [{ type: 'text', text: `Error: ${args.path} is a binary file (~${kb}KB) - text output cannot show it. This harness has no image/preview tool; verify rendered output via DOM/text assertions or a CLI dump (e.g. a headless-browser --dump-dom) instead.` }],
                    isError: true,
                };
            }
        }
        const MAX_LINES = 2000;
        const allLines = readLines(fullPath);
        const total = allLines.length;
        const start = Math.max(1, Number(args.start_line) || 1);
        const max = Math.min(MAX_LINES, Number(args.max_lines) || MAX_LINES);
        const slice = allLines.slice(start - 1, start - 1 + max);
        let body = slice.join('\n');
        if (body.length > 80000) {
            body = body.slice(0, 80000) + '\n… (output truncated at 80KB)';
        }
        const header = `[${args.path} - lines ${start}-${start + slice.length - 1} of ${total}]\n`;
        const more = start + slice.length - 1 < total
            ? `\n… (${total - (start + slice.length - 1)} more lines; call again with start_line=${start + slice.length})`
            : '';
        return { content: [{ type: 'text', text: header + body + more }] };
    } else if (name === 'run_terminal_command') {
        await ensureTurnSnapshot(workspaceRoot, 'before terminal command');
        const command = String(args.command ?? '').trim();
        if (!command) {
            return { content: [{ type: 'text', text: 'Error: Empty command' }], isError: true };
        }
        // Only irreversible system-destruction patterns are hard-denied
        // client-side (everything else is gated by the approval flow). The
        // list covers BOTH shells the tool can use: /bin/bash and, on
        // Windows, cmd.exe.
        const CATASTROPHIC = new RegExp([
            String.raw`\bmkfs(\.\w+)?\b`,
            String.raw`\bdd\b[^|]*\bof=\/dev\/(?:sd|nvme|hd|r?disk\d)`,
            String.raw`:\(\)\s*\{.*\};\s*:\|\s*:`,
            // `rm -rf /`, `rm -rf /*`, `rm -rf / --no-preserve-root` - the
            // canonical accident (the old pattern required the command to
            // END with a bare `/`).
            String.raw`\brm\b[^|;&>]*\s\/(\*|\s|$|--)`,
            String.raw`\bshred\b[^|;&]*\/dev\/`,
            String.raw`\bfind\b[^|;&]*\s\/\s+[^|;&]*-delete\b`,
            String.raw`>\s*\/dev\/(sd[a-z]|nvme\d+|r?disk\d)`,
            String.raw`\bformat(\.com)?\s+[a-z]:`,
            String.raw`\bdiskpart\b`,
            String.raw`\bcipher\b[^|]*\/w`,
            String.raw`\b(rd|rmdir)\b[^&|>]*\/s\b[^&|]*\b[a-z]:\\?\s*$`,
            String.raw`\bdel\b[^&|>]*\/[fs].*\/[fsq][^&|>]*\b[a-z]:\\`,
            String.raw`\bwmic\b[^|]*\bdelete\b`,
        ].join('|'), 'i');
        if (CATASTROPHIC.test(command)) {
            return {
                content: [{ type: 'text', text: `Error: command refused (irreversible system destruction): ${command}` }],
                isError: true
            };
        }
        // Background launch (dev servers, watchers, GUI apps): the turn must be
        // released while the process keeps running. Waiting would sit on the
        // idle/hard cap until the tool killed the tree (live: xdg-open held
        // the call open until the timeout, and the kill took the launched app
        // down with it), and a shell-level `&`/`start /b` loses the output and
        // the handle entirely.
        // `detach` was the old spelling and models in older sessions still
        // send it. Without this alias it would be silently IGNORED (the schema
        // has no additionalProperties:false), so a `xdg-open` would run in the
        // foreground and sit on the 10-minute idle cap - exactly the regression
        // the deleted detached branch existed to prevent.
        if (args.background === true || args.detach === true) {
            // A child must not leave work running behind it. The job would
            // outlive the delegation, keep a port or a file handle open, and
            // report its completion into a conversation that has already
            // moved on - the exact "leaked dev server with no owner" failure.
            // `process(action='wait')` is the child's way to wait for a long
            // command instead.
            if (nested) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Error: a delegated subagent cannot start a background process - it would outlive this task with nobody left to stop it. Run the command in the foreground, or start it with background=true from the main conversation and poll it with the `process` tool.',
                    }],
                    isError: true,
                };
            }
            // Throws when the background cap is reached - the reservation has
            // to happen before the spawn or the extra process is already
            // running with nothing pointing at it.
            const job = spawnTerminalJob({ workspaceRoot, command, onOutput, background: true, callId });
            return { content: [{ type: 'text', text: describeBackgroundHandoff(job) }] };
        }
        // The spawn/collect/kill lifecycle lives in backgroundJobs so the
        // process is OWNED rather than trapped inside this promise. `released`
        // (not `finished`) is what this awaits: the call returns when the
        // process ends OR when the user releases the turn from the UI, and
        // waiting on `finished` alone is what used to hang a turn on a dev
        // server until the idle cap killed it.
        const job = spawnTerminalJob({ workspaceRoot, command, onOutput, callId });
        if (await job.released === 'backgrounded') {
            // The user can release the turn at the same moment the command
            // exits. If it has already finished, hand back its REAL result -
            // a handoff saying "output so far, still running" about a command
            // that just exited misreports it, and the exit code is the whole
            // point of the call.
            if (job.status === 'running') {
                return { content: [{ type: 'text', text: describeBackgroundHandoff(job) }] };
            }
        }
        const result = await awaitTerminalJob(job, process.platform);
        return { content: [{ type: 'text', text: result.text }], isError: result.isError };
    } else if (name === 'process') {
        return await dispatchProcessTool(args);
    } else if (name === 'grep_search') {
        const rg = await findRipgrep();
        if (!rg) {
            return { content: [{ type: 'text', text: "Error: ripgrep ('rg') is not installed and no bundled copy was found. Install ripgrep or use read_file/list_files." }], isError: true };
        }
        const searchPath = args.path || '.';
        const pattern = args.pattern;
        const include = args.include || '';
        const fullPath = sanitizePath(searchPath, workspaceRoot);
        return new Promise((resolve) => {
            const rgArgs = ['-n', '--no-heading', '--color=never', '--max-columns=300', '-m', '50'];
            if (include) {
                rgArgs.push('-g', include);
            }
            // `--` stops option parsing: a pattern like `--pre` must be taken
            // as the pattern (rg treats unknown `--x` flags as options - the
            // `--pre` preprocessing command would even EXECUTE a file).
            rgArgs.push('--', pattern, fullPath);
            cp.execFile(rg, rgArgs, { cwd: workspaceRoot, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
                if (error && !stdout) {
                    const msg = stderr || error.message;
                    if (msg.includes('no matches') || error.code === 1) {
                        resolve({ content: [{ type: 'text', text: 'No matches found.' }] });
                    } else {
                        resolve({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
                    }
                } else {
                    const output = (stdout || '').trim();
                    resolve({ content: [{ type: 'text', text: output || 'No matches found.' }] });
                }
            });
        });
    } else if (name === 'replace_in_file') {
        await ensureTurnSnapshot(workspaceRoot, 'before edit');
        const fullPath = sanitizePath(args.path, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: file not found: ${args.path}` }], isError: true };
        }
        const oldStr = args.old_str;
        const newStr = args.new_str;
        if (!oldStr) {
            return { content: [{ type: 'text', text: 'Error: old_str cannot be empty' }], isError: true };
        }
        const raw = fs.readFileSync(fullPath, 'utf-8');
        // LF-normalized view for matching; the write re-encodes to the
        // original EOL style via preserveEol.
        let content = readLines(fullPath).join('\n');
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
            const strip = (l: string) => l.replace(/\s+/g, ' ').trim();
            const oLines = oldStr.split('\n').map(strip);
            const cLines = content.split('\n');
            const candidates: number[] = [];
            for (let i = 0; i <= cLines.length - oLines.length; i++) {
                let match = true;
                for (let j = 0; j < oLines.length; j++) {
                    if (strip(cLines[i + j]) !== oLines[j]) { match = false; break; }
                }
                if (match) candidates.push(i);
            }
            if (candidates.length === 1) {
                const at = candidates[0];
                const nLines = newStr.split('\n');
                cLines.splice(at, oLines.length, ...nLines);
                fs.writeFileSync(fullPath, preserveEol(raw, cLines.join('\n')), 'utf-8');
                return { content: [{ type: 'text', text: `Successfully replaced in ${args.path} (whitespace-normalized match)` + await diagnosticsSummary(vscode.Uri.file(fullPath)) }] };
            }
            return {
                content: [{ type: 'text', text: `Error: old_str not found in ${args.path}${candidates.length > 1 ? ` (matched ${candidates.length} times after whitespace normalization - add surrounding lines to make it unique)` : ''}. ` + 'Copy the exact lines from read_file output, including indentation.' }], isError: true };
        }
        if (count > 1) {
            return { content: [{ type: 'text', text: `Error: old_str found ${count} times in ${args.path}. Include more surrounding lines to make it unique.` }], isError: true };
        }
        // Replacer function: with a string replacement, `$&`/`` $` ``/`$'`
        // sequences in newStr are EXPANDED by String.replace - a model writing
        // legit JS containing '$&' would silently corrupt the file.
        content = content.replace(oldStr, () => newStr);
        fs.writeFileSync(fullPath, preserveEol(raw, content), 'utf-8');
        return { content: [{ type: 'text', text: `Successfully replaced in ${args.path}` + await diagnosticsSummary(vscode.Uri.file(fullPath)) }] };
    } else if (name === 'list_files') {
        const searchPath = args.path || '.';
        const fullPath = sanitizePath(searchPath, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: directory not found: ${searchPath}` }], isError: true };
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            return { content: [{ type: 'text', text: `Error: not a directory: ${searchPath}` }], isError: true };
        }
        try {
            const entries = fs.readdirSync(fullPath, { withFileTypes: true });
            const lines: string[] = [];
            for (const entry of entries.slice(0, 200)) {
                if (entry.name.startsWith('.')) continue;
                if (entry.isDirectory()) {
                    lines.push(`  ${entry.name}/`);
                } else {
                    const size = fs.statSync(path.join(fullPath, entry.name)).size;
                    lines.push(`  ${entry.name}  (${size} bytes)`);
                }
            }
            if (entries.length > 200) {
                lines.push(`  ... (${entries.length - 200} more entries)`);
            }
            return { content: [{ type: 'text', text: lines.join('\n') || 'Empty directory.' }] };
        } catch (err: any) {
            return { content: [{ type: 'text', text: `Error reading directory: ${err.message}` }], isError: true };
        }
    } else if (name === 'glob_search') {
        const rg = await findRipgrep();
        if (!rg) {
            return { content: [{ type: 'text', text: "Error: ripgrep ('rg') is not installed and no bundled copy was found. Install ripgrep or use read_file/list_files." }], isError: true };
        }
        const searchPath = args.path || '.';
        const pattern = args.pattern;
        const fullPath = sanitizePath(searchPath, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: path not found: ${searchPath}` }], isError: true };
        }
        return new Promise((resolve) => {
            const rgArgs = ['--files', '--glob', pattern, fullPath];
            cp.execFile(rg, rgArgs, { cwd: workspaceRoot, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
                if (error && !stdout) {
                    const msg = stderr || error.message;
                    if (msg.includes('no matches') || error.code === 1) {
                        resolve({ content: [{ type: 'text', text: 'No matching files found.' }] });
                    } else {
                        resolve({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
                    }
                } else {
                    // Workspace-relative, matching grep_search - absolute paths
                    // here made agents mix path conventions between the tools.
                    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
                    const output = (stdout || '').split('\n')
                        .map((l) => l.trim())
                        .filter(Boolean)
                        .map((p) => (p.startsWith(rootWithSep) ? p.slice(rootWithSep.length) : p))
                        .join('\n');
                    resolve({ content: [{ type: 'text', text: output || 'No matching files found.' }] });
                }
            });
        });
    } else if (name === 'apply_patch') {
        await ensureTurnSnapshot(workspaceRoot, 'before edit');
        const fullPath = sanitizePath(args.path, workspaceRoot);
        const rawPatch = args.patch;
        if (!rawPatch) {
            return { content: [{ type: 'text', text: 'Error: patch cannot be empty' }], isError: true };
        }
        // Repair the ONE unambiguous marker loss (a dropped final closing
        // marker) before parsing, and keep the note: silently auto-closing a
        // possibly-truncated replacement would hide a partial edit behind a
        // success message, so the model is told to verify that hunk.
        const { patch, repairs } = repairPatchMarkers(String(rawPatch));
        const repairNote = repairs.length ? `\n\nNote: ${repairs.join(' ')}` : '';
        if (!fs.existsSync(fullPath)) {
            // New-file creation: a patch whose SEARCH blocks are all empty
            // defines the new file's contents (Cline-style idiom).
            const blocks = parsePatchBlocks(patch);
            if (blocks.length >= 1 && blocks.every((b) => !b.search && b.replace)) {
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, blocks.map((b) => b.replace).join('\n'), 'utf-8');
                return { content: [{ type: 'text', text: `Successfully created ${args.path}` + await diagnosticsSummary(vscode.Uri.file(fullPath)) + repairNote }] };
            }
            return { content: [{ type: 'text', text: `Error: file not found: ${args.path}. To create a new file use a single block with an EMPTY SEARCH section, or call edit_file with new_content.` }], isError: true };
        }
        try {
            const raw = fs.readFileSync(fullPath, 'utf-8');
            // LF-normalized in-memory view; preserveEol restores CRLF on write.
            let content = readLines(fullPath).join('\n');
            const blocks = parsePatchBlocks(patch);
            if (blocks.length === 0) {
                return { content: [{ type: 'text', text: 'Error: no valid SEARCH/REPLACE blocks found. Use <<<<<<< SEARCH / ======= / >>>>>>> REPLACE markers.' }], isError: true };
            }
            let applied = 0;
            const errors: string[] = [];
            const notes: string[] = [];
            for (let bi = 0; bi < blocks.length; bi++) {
                const { search, replace } = blocks[bi];
                const tag = `#${bi + 1}`;
                if (!search) {
                    errors.push(`Empty search block`);
                    continue;
                }
                let count = content.split(search).length - 1;
                if (count > 1) {
                    notes.push(`${tag} matched ${count} identical spots - applied the FIRST; make SEARCH unique`);
                }
                if (count === 1) {
                    const at = content.indexOf(search);
                    content = content.replace(search, () => replace);
                    notes.push(`${tag} @ line ${content.slice(0, at).split('\n').length}`);
                    applied++;
                    continue;
                }
                const searchLines = search.split('\n');
                const contentLines = content.split('\n');
                let foundAt = -1;
                for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
                    let match = true;
                    for (let j = 0; j < searchLines.length; j++) {
                        if (contentLines[i + j].trimEnd() !== searchLines[j].trimEnd()) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        foundAt = i;
                        break;
                    }
                }
                if (foundAt >= 0) {
                    notes.push(`${tag} @ line ${foundAt + 1} (whitespace-tolerant match)`);
                    const replaceLines = replace.split('\n');
                    const baseIndentRe = /^[ \t]*/;
                    const searchIndent = (searchLines[0].match(baseIndentRe)?.[0] ?? '');
                    const contentIndent = (contentLines[foundAt].match(baseIndentRe)?.[0] ?? '');
                    let out = replaceLines;
                    if (searchIndent !== contentIndent && searchLines.length > 0) {
                        out = replaceLines.map((l) => {
                            if (!l.trim()) return l;
                            const m2 = l.match(baseIndentRe);
                            const rel = l.slice((m2?.[0] ?? '').length);
                            return contentIndent + rel;
                        });
                    }
                    contentLines.splice(foundAt, searchLines.length, ...out);
                    content = contentLines.join('\n');
                    applied++;
                    continue;
                }
                const strip = (l: string) => l.replace(/\s+/g, ' ').trim();
                const sNorm = searchLines.map(strip);
                for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
                    let match = true;
                    for (let j = 0; j < searchLines.length; j++) {
                        if (strip(contentLines[i + j]) !== sNorm[j]) { match = false; break; }
                    }
                    if (match) {
                        foundAt = i;
                        break;
                    }
                }
                if (foundAt >= 0) {
                    notes.push(`${tag} @ line ${foundAt + 1} (whitespace-normalized match)`);
                    const replaceLines = replace.split('\n');
                    contentLines.splice(foundAt, searchLines.length, ...replaceLines);
                    content = contentLines.join('\n');
                    applied++;
                    continue;
                }
                if (searchLines.length >= 2) {
                    const firstLine = searchLines[0].trimEnd();
                    const lastLine = searchLines[searchLines.length - 1].trimEnd();
                    const startIdx = contentLines.findIndex((l: string) => l.trimEnd() === firstLine);
                    if (startIdx >= 0) {
                        for (let i = startIdx + 1; i <= contentLines.length - searchLines.length + 1; i++) {
                            if (contentLines[i + searchLines.length - 2]?.trimEnd() === lastLine) {
                                let middleMatch = true;
                                for (let j = 1; j < searchLines.length - 1; j++) {
                                    if (contentLines[i + j - 1].trimEnd() !== searchLines[j].trimEnd()) {
                                        middleMatch = false;
                                        break;
                                    }
                                }
                                if (middleMatch) {
                                    notes.push(`${tag} @ line ${i + 1} (edge-line match)`);
                                    const replaceLines = replace.split('\n');
                                    contentLines.splice(i, searchLines.length, ...replaceLines);
                                    content = contentLines.join('\n');
                                    foundAt = i;
                                    applied++;
                                    break;
                                }
                            }
                        }
                    }
                }
                if (foundAt < 0) {
                    // Last resort: the SEARCH may describe the same line with
                    // `\uXXXX` escapes decoded (or encoded) relative to the
                    // file bytes - one more pass with the decoded form.
                    const decoded = decodeUnicodeEscapes(search);
                    if (decoded !== search) {
                        const dCount = content.split(decoded).length - 1;
                        if (dCount === 1) {
                            const at = content.indexOf(decoded);
                            content = content.replace(decoded, () => replace);
                            notes.push(`${tag} @ line ${content.slice(0, at).split('\n').length} (matched after decoding \\uXXXX escapes)`);
                            applied++;
                            continue;
                        }
                        if (dCount > 1) {
                            notes.push(`${tag} matched ${dCount} spots after decoding \\uXXXX escapes - applied none; make SEARCH unique`);
                        }
                    }
                    const escapeHint = /\\u[0-9a-fA-F]{4}/.test(search) || decoded !== search
                        ? ' Note: the SEARCH contains \\uXXXX escape text - it must match the FILE bytes exactly (literal backslash-u text in the file vs the real characters are different bytes). Copy the line from read_file output verbatim.'
                        : '';
                    errors.push(`Could not find: "${search.slice(0, 80)}..."${escapeHint}`);
                }
            }
            if (applied > 0) {
                fs.writeFileSync(fullPath, preserveEol(raw, content), 'utf-8');
            }
            const noteStr = notes.length ? ` (${notes.slice(0, 12).join('; ')})` : '';
            const msg = errors.length > 0
                ? [
                      `Applied ${applied}/${blocks.length} blocks to ${args.path}${noteStr}.`,
                      ...errors,
                      applied > 0
                          ? 'The other blocks were applied successfully - do NOT re-send them.'
                          : '',
                  ].filter(Boolean).join('\n')
                : `Successfully applied ${applied} patch blocks to ${args.path}${noteStr}`;
            const diag = applied > 0 ? await diagnosticsSummary(vscode.Uri.file(fullPath)) : '';
            return { content: [{ type: 'text', text: msg + diag + repairNote }], isError: errors.length > 0 && applied === 0 };
        } catch (e) {
            return { content: [{ type: 'text', text: `Error applying patch: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
    } else if (name === 'list_code_definition_names') {
        const fullPath = sanitizePath(args.path, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: file not found: ${args.path}` }], isError: true };
        }
        const fileContent = fs.readFileSync(fullPath, 'utf-8');
        const ext = path.extname(fullPath).toLowerCase();
        const defs: string[] = [];
        if (ext === '.py') {
            const classRe = /^(class\s+(\w+).*:)/gm;
            const funcRe = /^(?:    )?(async\s+)?def\s+(\w+)\s*\([^)]*\)\s*(?:->[^:]*)?:/gm;
            let m;
            while ((m = classRe.exec(fileContent)) !== null) {
                defs.push(m[1]);
            }
            while ((m = funcRe.exec(fileContent)) !== null) {
                const indent = fileContent.substring(m.index, m.index + m[0].indexOf('def')).length;
                const prefix = indent >= 8 ? '        ' : indent >= 4 ? '    ' : '';
                defs.push(prefix + m[0].trim());
            }
        } else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
            const classRe = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+/gm;
            const funcRe = /^(?:export\s+)?(?:async\s+)?function\s+\w+/gm;
            const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+\w+(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/gm;
            const methodRe = /^\s+(?:public|private|protected|static|readonly|\s)*\b(?:async\s+)?(?!(?:if|for|while|switch|catch|return)\b)\w+\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{/gm;
            let m;
            while ((m = classRe.exec(fileContent)) !== null) {
                defs.push(m[0]);
            }
            while ((m = funcRe.exec(fileContent)) !== null) {
                defs.push(m[0]);
            }
            while ((m = arrowRe.exec(fileContent)) !== null) {
                defs.push(m[0] + ' …');
            }
            while ((m = methodRe.exec(fileContent)) !== null) {
                defs.push(m[0].trim());
            }
        } else {
            return { content: [{ type: 'text', text: `Unsupported file type: ${ext}. Only .py, .ts, .tsx, .js, .jsx supported.` }] };
        }
        return { content: [{ type: 'text', text: defs.length > 0 ? defs.join('\n') : 'No definitions found.' }] };
    } else if (name === 'skill') {
        // Agent Skills: progressive disclosure - return the SKILL.md body
        // (read-only, like read_file; available in plan mode). Bundled files
        // are read through the SAME tool via an optional `resource` arg,
        // scoped to the skill's directory (no workspace escape, no absolute
        // host paths in output - global skills have no workspace-relative
        // location, so no directory line is shown for them).
        const skillName = String(args?.name ?? '').trim();
        if (!skillName) {
            return { content: [{ type: 'text', text: 'Error: missing required argument: name' }], isError: true };
        }
        const resource = typeof args?.resource === 'string' ? args.resource : '';
        let dirPath: string | null;
        if (skillResolver) {
            const resolution = skillResolver(skillName);
            if (resolution.status === 'disabled') {
                return { content: [{ type: 'text', text: `Error: skill is disabled: ${skillName}` }], isError: true };
            }
            dirPath = resolution.status === 'ok' ? resolution.skill.dirPath : null;
        } else {
            dirPath = findSkillDir(workspaceRoot || undefined, skillName);
        }
        if (!dirPath) {
            return { content: [{ type: 'text', text: `Error: skill not found: ${skillName}` }], isError: true };
        }
        if (resource) {
            const text = readSkillResource(dirPath, resource);
            if (text === null) {
                return { content: [{ type: 'text', text: `Error: resource not found (or outside the skill directory): ${resource}` }], isError: true };
            }
            return { content: [{ type: 'text', text: `Resource: ${skillName}/${resource}\n\n${text}` }] };
        }
        const body = readSkillBody(dirPath);
        if (body === null) {
            return { content: [{ type: 'text', text: `Error: skill unreadable: ${skillName}` }], isError: true };
        }
        const displayPath = skillDirectoryDisplayPath(dirPath, workspaceRoot || undefined);
        const header = `Skill: ${skillName}`
            + (displayPath ? `\nDirectory: ${displayPath} (relative to the workspace root)` : '');
        return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
    } else if (name === SUBAGENT_TOOL_NAME) {
        // Local-runtime delegation tool (never advertised over the MCP
        // bridge and absent from child toolsets). Without a runner there is
        // no nested model to drive - fail loudly rather than silently.
        if (!subagentRunner) {
            return { content: [{ type: 'text', text: 'Error: the task tool is not available in this context.' }], isError: true };
        }
        const parsed = parseTaskToolArgs(args ?? {});
        if (!parsed.ok) {
            return { content: [{ type: 'text', text: parsed.error }], isError: true };
        }
        const result = await subagentRunner.run({ ...parsed.value, parentCallId: callId, ...(onOutput ? { onOutput } : {}) });
        return { content: [{ type: 'text', text: result.output }], isError: result.isError };
    } else if (name === USER_QUESTION_TOOL_NAME) {
        const parsed = parseUserQuestionArgs(args ?? {});
        if (!parsed.ok) {
            return { content: [{ type: 'text', text: parsed.error }], isError: true };
        }
        if (!decisionGate) {
            return {
                content: [{ type: 'text', text: `Error: ${USER_QUESTION_TOOL_NAME} is not available in this context.` }],
                isError: true,
            };
        }
        try {
            const outcome = await decisionGate.ask(parsed.value);
            return { content: [{ type: 'text', text: formatUserQuestionResult(outcome) }] };
        } catch (err: any) {
            // Cancelled while the card was open: a model-visible error row
            // (codex's wording) - never a silent drop, which would leave the
            // tool call hanging without a result.
            if (err?.name === 'AbortError') {
                return {
                    content: [{
                        type: 'text',
                        text: `${USER_QUESTION_TOOL_NAME} was cancelled before the user answered. Continue with your best judgment.`,
                    }],
                    isError: true,
                };
            }
            throw err;
        }
    } else if (name === 'web_search' || name === 'fetch_url') {
        // Local-runtime web tools (never advertised over the MCP bridge).
        const result = await executeWebTool(name, args ?? {});
        return { content: [{ type: 'text', text: result.output }], isError: result.isError };
    } else if (XRATU_EXPANSION_TOOLS.some((tool) => tool.name === name)) {
        const expansionRuntime: ExpansionToolRuntime = {
            workspaceRoot,
            sanitizePath,
            ensureTurnSnapshot,
        };
        return await handleExpansionTool(name, args ?? {}, expansionRuntime);
    }
    const hint = resolveToolName(name, getLocalToolDefinitions().map((t) => t.name));
    const aliasNote = /^(write|create|new|save)_file$/.test(name)
        ? ` For whole-file writes use edit_file (mode "create" for new files, "overwrite" to replace, "append" to add to the end).`
        : '';
    return {
        content: [{
            type: 'text',
            text: `Unknown tool: ${name}.${hint.suggestion ? ` Did you mean \`${hint.suggestion}\`?` : ''}${aliasNote}`,
        }],
        isError: true,
    };
}

/** Execute a single built-in or expansion tool outside the MCP bridge.
 *  Used by the local agent runtime. `externalMcp` routes mcp__* calls to
 *  the user's external servers (undefined → external calls error).
 *  `skillResolver` gates `skill` calls against the user's disabled list. */
export async function executeLocalTool(
    workspaceRoot: string,
    name: string,
    args: Record<string, unknown>,
    ensureTurnSnapshot: (workspaceRoot: string, reason: string) => Promise<void>,
    externalMcp?: ExternalMcpManager,
    skillResolver?: (name: string) => SkillResolution,
    onOutput?: (chunk: string) => void,
    subagentRunner?: SubagentRunner,
    decisionGate?: UserQuestionGate,
    callId?: string,
    nested?: boolean,
): Promise<LocalToolResult> {
    try {
        if (isOfflineMode() && (name === 'web_search' || name === 'fetch_url' || name.startsWith(EXTERNAL_PREFIX))) {
            return { output: 'Error: this network tool is disabled in offline mode.', isError: true };
        }
        if (name.startsWith(EXTERNAL_PREFIX)) {
            if (!externalMcp) {
                return { output: 'Error: external MCP servers are not available in this session.', isError: true };
            }
            const r = await externalMcp.callTool(name, args ?? {});
            return { output: r.text, ...(r.images.length ? { images: r.images } : {}) };
        }
        // Resolve model-drift tool NAMES first (write_file -> edit_file etc.),
        // then fill `path` from known aliases: a model that sends `file_path`
        // used to hit a raw Node TypeError deep in sanitizePath.
        const named = resolveToolName(name, getLocalToolDefinitions().map((t) => t.name));
        const result = await dispatchTool(workspaceRoot, named.name, withPathAlias(args ?? {}), ensureTurnSnapshot, skillResolver, onOutput, subagentRunner, decisionGate, callId, nested);
        return { output: result.content[0]?.text ?? '', isError: result.isError };
    } catch (err: any) {
        return { output: `Error: ${err.message}`, isError: true };
    }
}

/** Bridge-local adapter: wraps executeLocalTool to match the LocalToolExecutor
 *  interface the local agent expects (workspace-bound closure). */
export function createLocalToolExecutor(
    workspaceRoot: string,
    ensureTurnSnapshot: (workspaceRoot: string, reason: string) => Promise<void>,
    externalMcp?: ExternalMcpManager,
    skillResolver?: (name: string) => SkillResolution,
    subagentRunner?: SubagentRunner,
    decisionGate?: UserQuestionGate,
    /** Marks this executor as a delegated child's. */
    opts?: { nested?: boolean },
): import('./local/localAgent').LocalToolExecutor {
    return {
        execute: async (call, onOutput) =>
            executeLocalTool(workspaceRoot, call.name, call.arguments, ensureTurnSnapshot, externalMcp, skillResolver, onOutput, subagentRunner, decisionGate, call.id, opts?.nested),
    };
}

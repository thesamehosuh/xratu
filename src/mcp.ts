import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { parsePatchBlocks, sanitizePath } from './paths';
import { ShadowCheckpointStore } from './shadowGit';
import { ExternalMcpManager, EXTERNAL_PREFIX } from './externalMcp';
import { executeWebTool } from './webTools';
import {
    XRATU_EXPANSION_TOOLS,
    handleExpansionTool,
    EXPANSION_MUTATING_TOOL_NAMES,
    killTree,
    type ExpansionToolRuntime,
} from './xratu_mcp_tools';
import type { LocalToolDefinition } from './local/localAgent';
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
 * Locate a ripgrep binary: PATH first, then VS Code's own bundled copy
 * (exposed to extension hosts via VSCODE_RIPGREP_PATH).
 */
let _rgPath: string | null | undefined;
function findRipgrep(): string | null {
    if (_rgPath !== undefined) return _rgPath;
    _rgPath = 'rg';
    const probe = cp.spawnSync(_rgPath, ['--version'], { timeout: 5000, encoding: 'utf-8', windowsHide: true });
    if (!probe.error && probe.status === 0) return _rgPath;
    const bundled = process.env.VSCODE_RIPGREP_PATH;
    if (bundled && fs.existsSync(bundled)) {
        _rgPath = bundled;
        return _rgPath;
    }
    _rgPath = null;
    return null;
}

/** Collect current problems (errors/warnings) for one file so the model gets
 *  immediate lint feedback after its edits - Aider-style verify loop.
 *  Language servers publish asynchronously: read synchronously right after
 *  the write and every FRESH error is invisible (a live dogfood run shipped
 *  undefined-name errors that this check silently missed). Poll briefly and
 *  stop early once the server has published something interesting. */
async function diagnosticsSummary(uri: vscode.Uri): Promise<string> {
    try {
        let diags: readonly vscode.Diagnostic[] = [];
        for (const waitMs of [400, 800]) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            diags = vscode.languages.getDiagnostics(uri);
            if (diags.some((d) => d.severity <= vscode.DiagnosticSeverity.Warning)) break;
        }
        const interesting = diags.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
        if (interesting.length === 0) return '';
        const errors = interesting.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
        const lines = interesting.slice(0, 10).map((d) => {
            const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
            const kind = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
            return `  [${kind}] ${pos} ${d.message.split('\n')[0]}`;
        });
        const head = `[Diagnostics] ${errors.length} error(s), ${interesting.length - errors.length} warning(s) after this edit:`;
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
// dropped entirely, mirroring the backend's unconditional plan-mode denial.
// ---------------------------------------------------------------------------

const BUILTIN_TOOL_DEFINITIONS: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}> = [
    {
        name: 'edit_file',
        description: [
            'Whole-file writer: mode="overwrite" (default) REPLACES ITS ENTIRE CONTENT with new_content; mode="create" fails if the file already exists; mode="append" adds new_content to the end.',
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
        description: [
            'Runs one shell command in the workspace root (bash, or cmd on Windows).',
            'Pipes, redirection and chaining work; each call starts fresh at the workspace root.',
            'stdin is closed (immediate EOF) - the command must not wait for interactive input; use flags like `yes`/`-y` or `</dev/null` semantics instead.',
            'Killed after 10 minutes without output or at a 30-minute hard cap - quiet-but-working builds survive the idle window; for watchers, start them detached with `&` and return.',
            'In PLAN MODE only read-only enumeration commands are allowed (version probes like `python --version && pip --version`, git status/log/diff/show/blame, ls/cat/grep/rg/find/jq) - everything that can mutate the workspace is blocked server-side; inspect files with read_file/grep_search/glob_search/list_files instead, and use run_tests for test runs.',
        ].join(' '),
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command, e.g. "python test.py" or "cat data.csv | wc -l"' }
            },
            required: ['command']
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
            'Format each block EXACTLY like this, repeating for every edit:',
            '<<<<<<< SEARCH',
            '<exact lines currently in the file>',
            '=======',
            '<replacement lines>',
            '>>>>>>> REPLACE',
            'SEARCH must match the current file (copy byte-exact from read_file output); leading indentation is auto-corrected and whitespace-normalized fallback matching applies.',
            'To CREATE a new file, use one block with an EMPTY SEARCH section and the full file content as REPLACE.',
            'Never include lines starting with <<<<<<<, =======, or >>>>>>> inside block content - the parser refuses such patches; edit those hunks with edit_file instead.',
        ].join(' '),
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
    ...XRATU_EXPANSION_TOOLS,
];

/**
 * Web tools for the LOCAL agent runtime only. The cloud backend implements
 * web_search/fetch_url server-side (src/web_tools.py) and registers its own
 * copies - these must NOT ride the MCP bridge or the names would collide.
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
 *  available in plan mode like read_file. */
export function getLocalToolDefinitions(opts?: {
    yolo?: boolean;
    plan?: boolean;
    external?: import('./externalMcp').AggregatedTool[];
    skills?: DiscoveredSkill[];
}): LocalToolDefinition[] {
    const yolo = !!opts?.yolo;
    const plan = !!opts?.plan;
    const builtin = BUILTIN_TOOL_DEFINITIONS
        .filter((tool) => !plan || !MUTATING_TOOLS.has(tool.name))
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            requiresApproval: yolo ? false : MUTATING_TOOLS.has(tool.name),
        }));
    const web = WEB_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        requiresApproval: false,
    }));
    const external = (opts?.external ?? [])
        .filter((tool) => !plan)
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            requiresApproval: yolo ? false : !tool.autoApprove,
        }));
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
    return [...builtin, ...web, ...skillDefs, ...external];
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
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    if (name === 'edit_file') {
        await ensureTurnSnapshot(workspaceRoot, 'before edit');
        const fullPath = sanitizePath(args.path, workspaceRoot);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        const existed = fs.existsSync(fullPath);
        const previous = existed ? fs.readFileSync(fullPath, 'utf-8') : '';
        const mode = ['create', 'overwrite', 'append'].includes(args.mode) ? args.mode : 'overwrite';
        if (mode === 'create' && existed) {
            return { content: [{ type: 'text', text: `Error: ${args.path} already exists - use mode "overwrite" to replace it or "append" to add to it.` }], isError: true };
        }
        let next: string;
        if (mode === 'append' && existed) {
            const eol = previous.includes('\r\n') ? '\r\n' : '\n';
            next = previous + (previous && !previous.endsWith('\n') ? eol : '') + preserveEol(previous, args.new_content);
        } else {
            next = preserveEol(previous, args.new_content);
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
        return { content: [{ type: 'text', text: `Successfully ${verb} ${args.path}${stats}` + await diagnosticsSummary(vscode.Uri.file(fullPath)) }] };
    } else if (name === 'read_file') {
        const fullPath = sanitizePath(args.path, workspaceRoot);
        if (!fs.existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: file not found: ${args.path}` }], isError: true };
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
        // client-side (everything else is gated by the backend approval
        // flow). The list covers BOTH shells the tool can use: /bin/bash
        // and, on Windows, cmd.exe.
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
        const isWindows = process.platform === 'win32';
        const shellCmd = isWindows ? 'cmd.exe' : '/bin/bash';
        const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];
        // Inactivity vs hard cap: a QUIET-but-working process (a release
        // build, a slow test) must not die on the idle window - only the
        // absolute ceiling ends it. Anything streaming output resets idle.
        const IDLE_KILL_MS = 600_000;
        const HARD_CAP_MS = 1_800_000;
        return new Promise((resolve) => {
            const child = cp.spawn(shellCmd, shellArgs, {
                cwd: workspaceRoot,
                // stdin is a pipe we close IMMEDIATELY: readers of stdin
                // (bare `tail`, `cat`, ...) get EOF and exit instead of
                // blocking forever on an ignored fd.
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: !isWindows,
                windowsHide: true,
            });
            child.stdin.end();
            let stdout = '';
            let stderr = '';
            let killReason: string | null = null;
            let done = false;
            let killFallback: NodeJS.Timeout;
            let idleTimer: NodeJS.Timeout;
            const hardTimer = setTimeout(() => kill('the 30-minute hard cap'), HARD_CAP_MS);
            const kill = (why: string) => {
                killReason = why;
                try {
                    // cmd.exe (/c) and bash (-c) spawn grandchildren; killing
                    // only the direct child would leave them running (servers
                    // started by the command keep holding ports/files).
                    if (isWindows) killTree(child.pid);
                    else if (child.pid) process.kill(-child.pid, 'SIGKILL');
                } catch { /* gone */ }
                // 'close' normally fires once the killed process group's stdio
                // streams end - but if it never does (durable grandchildren on
                // the pipes), the promise must still resolve. The done latch
                // makes a late 'close' a no-op.
                clearTimeout(killFallback);
                killFallback = setTimeout(() => finish(null), 5000);
            };
            const resetIdle = () => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(
                    () => kill(`no output for ${Math.round(IDLE_KILL_MS / 60_000)} minutes`),
                    IDLE_KILL_MS
                );
            };
            const finish = (code: number | null, err?: Error) => {
                if (done) return;
                done = true;
                clearTimeout(idleTimer);
                clearTimeout(hardTimer);
                clearTimeout(killFallback);
                child.stdout.removeAllListeners();
                child.stderr.removeAllListeners();
                let result = `STDOUT:\n${stdout || '(empty)'}\nSTDERR:\n${stderr || '(empty)'}`;
                if (killReason) {
                    result += `\nError: killed (${killReason}). If this was a long quiet build, redirect output to a file and poll it in chunks; the hard cap is 30 minutes.`;
                } else if (err) {
                    result += `\nError: ${err.message}`;
                } else if (code !== 0) {
                    result += `\nExit code: ${code}`;
                }
                resolve({ content: [{ type: 'text', text: result.slice(0, 200000) }], isError: !!killReason || !!err || code !== 0 });
            };
            resetIdle();
            child.stdout.on('data', (d: Buffer) => {
                stdout += d.toString();
                // Cap CONTINUOUSLY (like runProcess): chatty output (`yes`, a
                // huge log) can reach GBs inside the timeout window - the
                // slice at finish() runs long after the extension host has OOM'd.
                if (stdout.length > 200000) stdout = stdout.slice(-200000);
                resetIdle();
            });
            child.stderr.on('data', (d: Buffer) => {
                stderr += d.toString();
                if (stderr.length > 200000) stderr = stderr.slice(-200000);
                resetIdle();
            });
            child.on('error', (e) => finish(null, e));
            child.on('close', (code) => finish(code));
        });
    } else if (name === 'grep_search') {
        const rg = findRipgrep();
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
        const rg = findRipgrep();
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
        const patch = args.patch;
        if (!patch) {
            return { content: [{ type: 'text', text: 'Error: patch cannot be empty' }], isError: true };
        }
        if (!fs.existsSync(fullPath)) {
            // New-file creation: a patch whose SEARCH blocks are all empty
            // defines the new file's contents (Cline-style idiom).
            const blocks = parsePatchBlocks(patch);
            if (blocks.length >= 1 && blocks.every((b) => !b.search && b.replace)) {
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, blocks.map((b) => b.replace).join('\n'), 'utf-8');
                return { content: [{ type: 'text', text: `Successfully created ${args.path}` + await diagnosticsSummary(vscode.Uri.file(fullPath)) }] };
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
            for (const { search, replace } of blocks) {
                if (!search) {
                    errors.push(`Empty search block`);
                    continue;
                }
                let count = content.split(search).length - 1;
                if (count === 1) {
                    content = content.replace(search, () => replace);
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
                    errors.push(`Could not find: "${search.slice(0, 80)}..."`);
                }
            }
            if (applied > 0) {
                fs.writeFileSync(fullPath, preserveEol(raw, content), 'utf-8');
            }
            const msg = errors.length > 0
                ? [
                      `Applied ${applied}/${blocks.length} blocks to ${args.path}.`,
                      ...errors,
                      applied > 0
                          ? 'The other blocks were applied successfully - do NOT re-send them.'
                          : '',
                  ].filter(Boolean).join('\n')
                : `Successfully applied ${applied} patch blocks to ${args.path}`;
            const diag = applied > 0 ? await diagnosticsSummary(vscode.Uri.file(fullPath)) : '';
            return { content: [{ type: 'text', text: msg + diag }], isError: errors.length > 0 && applied === 0 };
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
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
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
): Promise<{ output: string; isError?: boolean }> {
    try {
        if (name.startsWith(EXTERNAL_PREFIX)) {
            if (!externalMcp) {
                return { output: 'Error: external MCP servers are not available in this session.', isError: true };
            }
            return { output: await externalMcp.callTool(name, args ?? {}) };
        }
        const result = await dispatchTool(workspaceRoot, name, args, ensureTurnSnapshot, skillResolver);
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
): import('./local/localAgent').LocalToolExecutor {
    return {
        execute: async (call) => executeLocalTool(workspaceRoot, call.name, call.arguments, ensureTurnSnapshot, externalMcp, skillResolver),
    };
}

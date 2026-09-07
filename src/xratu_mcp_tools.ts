import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { promisify } from 'util';
import crossSpawn from 'cross-spawn';
import { findManifestDir, pythonWorkspace, PYTHON_MANIFESTS } from './tooling/pythonWorkspace';
import { TASK_LIST_MAX_ITEMS, TASK_LIST_MAX_LABEL, TASK_LIST_STATUSES, taskListLabelOf, type TaskListItem } from './taskList';

const execFile = promisify(cp.execFile);

export interface ExpansionToolRuntime {
    workspaceRoot: string;
    sanitizePath: (inputPath: string, workspaceRoot: string) => string;
    ensureTurnSnapshot: (workspaceRoot: string, reason: string) => Promise<void>;
}

/** Notified when the model writes a new task list - the host clears any
 *  user-edit override so the model's fresh list wins. Module-level singleton:
 *  there is exactly one host per extension process. */
let _taskListWriteListener: ((tasks: TaskListItem[]) => void) | null = null;
export function setTaskListWriteListener(cb: ((tasks: TaskListItem[]) => void) | null): void {
    _taskListWriteListener = cb;
}

/** Notified when the model calls exit_plan_mode - the host ends plan mode
 *  (state + toolbar echo) exactly as if the user had toggled it off. Same
 *  module-singleton pattern: one host per extension process. */
let _planModeExitListener: (() => void) | null = null;
export function setPlanModeExitListener(cb: (() => void) | null): void {
    _planModeExitListener = cb;
}

const MAX_OUTPUT = 120_000;
const MAX_BATCH_FILES = 20;
const DEFAULT_FILE_LINES = 2000;
const FILE_MAX_CHARS = 80_000;
const GIT_TIMEOUT = 20_000;

export const EXPANSION_MUTATING_TOOL_NAMES = new Set([
    'git_commit', 'move_file', 'copy_file', 'delete_file', 'git_branch', 'git_checkout',
    'git_pull', 'git_push', 'git_merge', 'install_dependency',
]);

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = [], approval = false) => ({
    name,
    description: approval ? `${description} Requires approval.` : description,
    inputSchema: { type: 'object', properties, required },
});

export const XRATU_EXPANSION_TOOLS = [
    tool('git_status', 'Show structured Git working-tree status.', {}),
    tool('git_diff', 'Show Git working-tree, staged, revision, or range diff.', {
        mode: { type: 'string', enum: ['worktree','staged','target','range'] }, target: { type: 'string' }, source: { type: 'string' }, path: { type: 'string' }, context_lines: { type: 'number', minimum: 0, maximum: 50 },
    }, ['mode']),
    tool('git_log', 'Show structured Git commit history with filters.', {
        max_count: { type: 'number', minimum: 1, maximum: 200 }, path: { type: 'string' }, author: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, grep: { type: 'string' }, branch: { type: 'string' },
    }),
    tool('find_definitions', 'Find symbol definitions at a file position using VS Code language providers. line/character are 1-BASED (matching read_file output, not LSP wire format).', { path: { type: 'string' }, line: { type: 'number', minimum: 1 }, character: { type: 'number', minimum: 1 } }, ['path','line','character']),
    tool('find_references', 'Find symbol references at a file position using VS Code language providers. line/character are 1-BASED (matching read_file output, not LSP wire format).', { path: { type: 'string' }, line: { type: 'number', minimum: 1 }, character: { type: 'number', minimum: 1 }, include_declaration: { type: 'boolean' } }, ['path','line','character']),
    tool('workspace_symbols', 'Search workspace symbols by name through VS Code language providers.', { query: { type: 'string' } }, ['query']),
    tool('get_diagnostics', 'Return VS Code diagnostics for a file or the workspace.', { path: { type: 'string' }, severity: { type: 'string', enum: ['all','error','warning','info','hint'] } }),
    tool('directory_tree', 'Show a bounded directory tree while respecting .gitignore in Git workspaces.', { path: { type: 'string' }, max_depth: { type: 'number', minimum: 1, maximum: 12 }, max_entries: { type: 'number', minimum: 1, maximum: 5000 } }),
    tool('read_files', 'Read multiple workspace files in one call. Each file is independently reported and bounded; use this instead of repeated read_file calls.', {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_BATCH_FILES },
        start_line: { type: 'number', minimum: 1 },
        max_lines: { type: 'number', minimum: 1, maximum: DEFAULT_FILE_LINES },
    }, ['paths']),
    tool('file_info', 'Return detailed metadata for a workspace file or directory.', {
        path: { type: 'string' },
    }, ['path']),
    tool('copy_file', 'Copy a workspace file or directory.', {
        source: { type: 'string' }, destination: { type: 'string' }, recursive: { type: 'boolean' },
    }, ['source', 'destination'], true),
    tool('move_file', 'Move or rename a workspace file or directory.', {
        source: { type: 'string' }, destination: { type: 'string' },
    }, ['source', 'destination'], true),
    tool('delete_file', 'Delete a workspace file or directory.', {
        path: { type: 'string' }, recursive: { type: 'boolean' },
    }, ['path'], true),
    tool('git_show', 'Show a Git commit/tag/revision and optionally its patch.', {
        revision: { type: 'string' }, path: { type: 'string' }, patch: { type: 'boolean' }, max_lines: { type: 'number', minimum: 1, maximum: 3000 },
    }, ['revision']),
    tool('git_blame', 'Show line-level Git attribution for a file.', {
        path: { type: 'string' }, start_line: { type: 'number', minimum: 1 }, end_line: { type: 'number', minimum: 1 },
    }, ['path']),
    tool('git_branch', 'List, create, delete, or switch Git branches.', {
        action: { type: 'string', enum: ['list', 'create', 'delete', 'switch'] }, name: { type: 'string' }, force: { type: 'boolean' },
    }, [], true),
    tool('git_commit', 'Stage selected files or all changes and create a Git commit.', {
        message: { type: 'string', minLength: 1, maxLength: 500 }, files: { type: 'array', items: { type: 'string' }, maxItems: 200 }, stage_all: { type: 'boolean' },
    }, ['message'], true),
    tool('git_show_stash', 'List Git stashes or inspect one stash entry.', {
        action: { type: 'string', enum: ['list', 'show'] }, stash: { type: 'string' },
    }),
    tool('git_checkout', 'Switch to a revision or restore selected files from a revision.', {
        revision: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    }, [], true),
    tool('git_pull', 'Pull from a configured Git remote.', {
        remote: { type: 'string' }, branch: { type: 'string' }, rebase: { type: 'boolean' },
    }, [], true),
    tool('git_push', 'Push the current branch to a Git remote.', {
        remote: { type: 'string' }, branch: { type: 'string' }, set_upstream: { type: 'boolean' }, force_with_lease: { type: 'boolean' },
    }, [], true),
    tool('git_merge', 'Merge a revision into the current branch.', {
        revision: { type: 'string' }, no_ff: { type: 'boolean' },
    }, ['revision'], true),
    tool('run_tests', 'Run an allowlisted project test framework and return normalized results. Python frameworks (pytest/unittest) automatically run under the project virtualenv when one exists (.venv/venv/env in the workspace root or the manifest directory, then $VIRTUAL_ENV) - never the system Python - and the result reports which interpreter ran (python_source).', {
        target: { type: 'string' }, framework: { type: 'string', enum: ['auto','pytest','unittest','jest','vitest','cargo','go','maven','gradle','dotnet','rspec','phpunit','swift'] }, pattern: { type: 'string' }, timeout_seconds: { type: 'number', minimum: 1, maximum: 600 }, extra_args: { type: 'array', items: { type: 'string' }, maxItems: 30 },
    }),
    tool('check_dependencies', 'Inspect project dependency files and installed package-manager information.', {
        ecosystem: { type: 'string', enum: ['auto','node','python','rust','go','java','dotnet','ruby','php','swift'] },
    }),
    tool('install_dependency', 'Install one or more project dependencies using a detected package manager. Python installs run the project virtualenv\'s pip when one exists (.venv/venv/env) - only fall back to run_terminal_command if this fails AND no venv exists; create one first (python -m venv .venv) and this tool will use it.', {
        packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, ecosystem: { type: 'string', enum: ['auto','node','python','rust','go','java','dotnet','ruby','php','swift'] }, dev: { type: 'boolean' },
    }, ['packages'], true),
    tool('update_task_list', 'Create or replace the session task list (the plan artifact and execution tracker). Sends the COMPLETE list every time - later calls replace it entirely. Every label must be ONE SHORT single sentence (~10 words max): an imperative action, no elaboration, no multi-clause detail - put supporting detail in the chat text instead. Use one item per concrete verifiable step. While executing: exactly ONE item in_progress at a time, mark items completed as you finish them, never batch-complete. The user may edit the list between calls - respect their changes, do not silently revert them.', {
        tasks: {
            type: 'array',
            description: 'The complete task list, in execution order.',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Short imperative step label, e.g. "Add Alembic migration for tasks table".' },
                    status: { type: 'string', enum: [...TASK_LIST_STATUSES], description: 'pending | in_progress | completed.' },
                },
                required: ['label', 'status'],
            },
            minItems: 1,
            maxItems: TASK_LIST_MAX_ITEMS,
        },
    }, ['tasks']),
    tool('exit_plan_mode', 'End plan mode. In plan mode, call this ONCE as the LAST step - right after drafting the implementation plan as a task list with update_task_list. It hands control back to the user so the work can be executed in the next turn (which runs in normal mode). No arguments. Meaningless outside plan mode.', {}, []),
];

function textResult(text: string, isError = false) {
    return { content: [{ type: 'text', text: text.slice(0, MAX_OUTPUT) }], ...(isError ? { isError: true } : {}) };
}

function full(runtime: ExpansionToolRuntime, p: string): string {
    return runtime.sanitizePath(p, runtime.workspaceRoot);
}

async function git(runtime: ExpansionToolRuntime, args: string[], timeout = GIT_TIMEOUT): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
        const r = await execFile('git', ['-C', runtime.workspaceRoot, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), code: 0 };
    } catch (e: any) {
        return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message ?? ''), code: Number.isInteger(e.code) ? e.code : 1 };
    }
}

function clip(s: string, max = MAX_OUTPUT) { return s.length > max ? `${s.slice(0, max)}\n… [truncated]` : s; }

/**
 * Guard against git option injection: model-supplied refs, branches, revisions
 * and stashes are passed as standalone argv entries, and git commands like
 * diff/log/show/stash show accept `--output=<file>` - an option-looking value
 * would write the output to an arbitrary path outside the workspace, bypassing
 * sanitizePath AND the approval gate (these tools are classified read-only).
 * Valid refs never start with '-'.
 */
function safeRef(value: unknown, label: string): string {
    const s = String(value ?? '');
    if (!s || s.startsWith('-')) throw new Error(`Invalid ${label}: ${JSON.stringify(s.slice(0, 60))}`);
    return s;
}

function ignoredFallback(name: string): boolean {
    return new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.cache', '.turbo', 'coverage', 'storybook-static', '__pycache__', '.pytest_cache', '.venv', 'venv', '.idea', '.gradle']).has(name);
}

/** Workspace files as git sees them: tracked + untracked, .gitignore-respected
 *  (keep-set, NOT an ignore-list - empty means "git unavailable/non-git root").
 *  Shared by directory_tree and the static project-structure snapshot. */
export async function gitWorkspaceFiles(workspaceRoot: string, timeout = 15_000): Promise<Set<string>> {
    try {
        const r = await execFile('git', ['-C', workspaceRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return new Set(String(r.stdout ?? '').split('\0').filter(Boolean).map(x => x.replace(/\\/g, '/')));
    } catch { return new Set(); }
}

async function gitIgnoredPaths(runtime: ExpansionToolRuntime): Promise<Set<string>> {
    return gitWorkspaceFiles(runtime.workspaceRoot);
}

function buildTree(paths: string[], rootPrefix: string, maxDepth: number, maxEntries: number): string {
    const root = rootPrefix.replace(/^\.\//, '').replace(/\/$/, '');
    const selected = paths
        .filter(p => !root || p === root || p.startsWith(root + '/'))
        .map(p => root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    const lines: string[] = [root || '.'];
    let count = 1;
    for (const rel of selected) {
        const depth = rel.split('/').length;
        if (depth > maxDepth) continue;
        const indent = '  '.repeat(Math.max(0, depth - 1));
        if (count++ >= maxEntries) { lines.push('… [entry limit reached]'); break; }
        lines.push(`${indent}${rel.split('/').pop()}`);
    }
    return lines.join('\n');
}

function commandForFramework(framework: string, target: string, pattern: string, extra: string[], python = 'python'): string[] | null {
    const t = target ? [target] : [];
    switch (framework) {
        case 'pytest': return [python, '-m', 'pytest', ...t, ...(pattern ? ['-k', pattern] : []), ...extra];
        case 'unittest': return [python, '-m', 'unittest', ...(target ? ['-v', target] : ['discover', '-v']), ...extra];
        case 'jest': return ['npx', 'jest', ...t, ...(pattern ? ['-t', pattern] : []), ...extra];
        case 'vitest': return ['npx', 'vitest', 'run', ...t, ...(pattern ? ['-t', pattern] : []), ...extra];
        case 'cargo': return ['cargo', 'test', ...t, ...extra];
        case 'go': return ['go', 'test', ...(target ? [target] : ['./...']), ...extra];
        case 'maven': return ['mvn', 'test', ...(target ? ['-Dtest=' + target] : []), ...extra];
        case 'gradle': return ['gradle', 'test', ...(target ? ['--tests', target] : []), ...extra];
        case 'dotnet': return ['dotnet', 'test', ...t, ...extra];
        case 'rspec': return ['bundle', 'exec', 'rspec', ...t, ...extra];
        case 'phpunit': return [process.platform === 'win32' ? 'vendor\\bin\\phpunit.bat' : 'vendor/bin/phpunit', ...t, ...extra];
        case 'swift': return ['swift', 'test', ...extra];
        default: return null;
    }
}

async function detectFramework(root: string): Promise<string> {
    const exists = (p: string) => fs.existsSync(path.join(root, p));
    // Python manifests often live one level down (this repo: src/pyproject.toml);
    // without the subdir scan this fell through to the unittest fallback.
    if (exists('pytest.ini') || exists('pyproject.toml') || exists('tox.ini') || exists('tests')
        || findManifestDir(root, PYTHON_MANIFESTS)) return 'pytest';
    if (exists('package.json')) {
        try {
            const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            const deps = { ...(p.dependencies || {}), ...(p.devDependencies || {}) };
            if (deps.vitest) return 'vitest';
            if (deps.jest) return 'jest';
        } catch { /* fall through */ }
    }
    if (exists('Cargo.toml')) return 'cargo';
    if (exists('go.mod')) return 'go';
    if (exists('pom.xml')) return 'maven';
    if (exists('build.gradle') || exists('build.gradle.kts')) return 'gradle';
    if (exists('*.sln') || fs.readdirSync(root).some(x => x.endsWith('.sln') || x.endsWith('.csproj'))) return 'dotnet';
    if (exists('Gemfile') && exists('spec')) return 'rspec';
    if (exists('composer.json')) return 'phpunit';
    if (exists('Package.swift')) return 'swift';
    return 'unittest';
}

async function runProcess(runtime: ExpansionToolRuntime, argv: string[], timeoutSeconds: number, cwd?: string) {
    const timeout = Math.max(1, Math.min(timeoutSeconds || 120, 600)) * 1000;
    return new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
        // cross-spawn resolves Windows .cmd/.bat shims (npm, npx, mvn, gradle,
        // bundle, composer) that plain cp.spawn cannot execute (and since the
        // CVE-2024-27980 patch refuses to, even by full path).
        const child = crossSpawn(argv[0], argv.slice(1), { cwd: cwd || runtime.workspaceRoot, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', done = false;
        const finish = (code: number | null, timedOut = false) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); };
        const timer = setTimeout(() => {
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
                else killTree(child.pid);
            } catch { /* already exited */ }
            finish(null, true);
        }, timeout);
        child.stdout?.on('data', d => { stdout += d.toString(); if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT); });
        child.stderr?.on('data', d => { stderr += d.toString(); if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(-MAX_OUTPUT); });
        child.on('error', e => { stderr += `\n${e.message}`; finish(null); });
        child.on('close', code => finish(code));
    });
}

/** Kill a process AND its children (cmd shims, package managers) on Windows. */
export function killTree(pid: number | undefined): void {
    if (!pid) return;
    if (process.platform === 'win32') {
        crossSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
}


function dependencyManager(root: string, ecosystem: string): string {
    const has = (name: string) => fs.existsSync(path.join(root, name));
    if (ecosystem === 'auto') {
        if (has('package.json') || findManifestDir(root, ['package.json'])) return 'node';
        if (findManifestDir(root, PYTHON_MANIFESTS)) return 'python';
        if (has('Cargo.toml')) return 'rust';
        if (has('go.mod')) return 'go';
        if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
        if (fs.readdirSync(root).some(x => x.endsWith('.sln') || x.endsWith('.csproj'))) return 'dotnet';
        if (has('Gemfile')) return 'ruby';
        if (has('composer.json')) return 'php';
        if (has('Package.swift')) return 'swift';
        return '';
    }
    return ecosystem;
}

function shellSafePackageName(name: string): boolean {
    // Package managers receive individual argv entries; still reject option-like
    // names so a model cannot smuggle package-manager flags through this API.
    return /^[A-Za-z0-9_@./:+~=-]+(?:\[[A-Za-z0-9_,.-]+\])?$/.test(name) && !name.startsWith('-');
}

async function packageManagerInfo(runtime: ExpansionToolRuntime, ecosystem: string): Promise<any> {
    const root = runtime.workspaceRoot;
    const e = dependencyManager(root, ecosystem);
    const files: Record<string, string> = {
        node: 'package.json', python: 'pyproject.toml / requirements.txt', rust: 'Cargo.toml', go: 'go.mod',
        java: 'pom.xml / build.gradle(.kts)', dotnet: '*.csproj / *.sln', ruby: 'Gemfile', php: 'composer.json', swift: 'Package.swift'
    };
    let command: string[] | null = null;
    const py = pythonWorkspace(root);
    switch (e) {
        case 'node': command = ['npm', 'list', '--depth=0', '--json']; break;
        case 'python': command = [py.python, '-m', 'pip', 'list', '--format=json']; break;
        case 'rust': command = ['cargo', 'metadata', '--format-version', '1', '--no-deps']; break;
        case 'go': command = ['go', 'list', '-m', 'all']; break;
        case 'java': command = fs.existsSync(path.join(root, 'mvnw')) || fs.existsSync(path.join(root, 'mvnw.cmd'))
            // The repo-local wrapper is never on PATH - invoke it by path
            // (mvnw.cmd on Windows; cross-spawn handles .cmd in runProcess).
            ? [path.join(root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'), 'dependency:list', '-DincludeScope=runtime']
            : ['mvn', 'dependency:list', '-DincludeScope=runtime']; break;
        case 'dotnet': command = ['dotnet', 'list', 'package']; break;
        case 'ruby': command = ['bundle', 'list']; break;
        case 'php': command = ['composer', 'show', '--format=json']; break;
        case 'swift': command = ['swift', 'package', 'show-dependencies']; break;
    }
    if (!e || !command) return { ecosystem: e || 'unknown', manifest: 'unknown' };
    const cwd = e === 'python' ? py.cwd
        : e === 'node' ? (findManifestDir(root, ['package.json']) || root)
        : undefined;
    const r = await runProcess(runtime, command, 60, cwd);
    return {
        ecosystem: e, manifest: files[e] || '',
        // Which interpreter answered - makes silent system-Python falls visible.
        ...(e === 'python' ? { python: py.python, python_source: py.source, cwd: py.cwd } : {}),
        command: command.join(' '), exit_code: r.code, output: clip((r.stdout || r.stderr).trim()),
    };
}


function uriFor(runtime: ExpansionToolRuntime, p: string): vscode.Uri {
    return vscode.Uri.file(full(runtime, p));
}

function locationJson(loc: vscode.Location | vscode.LocationLink | vscode.DocumentSymbol | vscode.SymbolInformation): any {
    if (loc instanceof vscode.DocumentSymbol) {
        return { name: loc.name, kind: loc.kind, range: {
            start: { line: loc.range.start.line + 1, character: loc.range.start.character + 1 },
            end: { line: loc.range.end.line + 1, character: loc.range.end.character + 1 },
        } };
    }
    if (loc instanceof vscode.SymbolInformation) {
        return { name: loc.name, kind: loc.kind, containerName: loc.containerName, location: locationJson(loc.location) };
    }
    const range = 'targetRange' in loc ? loc.targetRange : loc.range;
    const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
    return { uri: uri.toString(), range: {
        start: { line: range.start.line + 1, character: range.start.character + 1 },
        end: { line: range.end.line + 1, character: range.end.character + 1 },
    } };
}

async function lspTool(name: string, args: any, runtime: ExpansionToolRuntime): Promise<any> {
    if (name === 'workspace_symbols') {
        const query = String(args.query || '').trim();
        if (!query) return textResult('Error: query cannot be empty', true);
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query) || [];
        return textResult(JSON.stringify(symbols.slice(0, 200).map(locationJson), null, 2));
    }
    if (!args.path) return textResult('Error: path is required', true);
    const uri = uriFor(runtime, args.path);
    if (!fs.existsSync(uri.fsPath)) return textResult(`Error: file not found: ${args.path}`, true);
    const position = new vscode.Position(Math.max(0, Number(args.line || 1) - 1), Math.max(0, Number(args.character || 1) - 1));
    if (name === 'find_definitions') {
        const result = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', uri, position) || [];
        return textResult(JSON.stringify(result.slice(0, 100).map(locationJson), null, 2));
    }
    if (name === 'find_references') {
        const result = await vscode.commands.executeCommand<any[]>('vscode.executeReferenceProvider', uri, position) || [];
        return textResult(JSON.stringify(result.slice(0, 300).map(locationJson), null, 2));
    }
    return textResult('Unknown LSP tool', true);
}

function diagnosticJson(d: vscode.Diagnostic) {
    return {
        severity: ['error','warning','info','hint'][d.severity] || 'unknown',
        message: d.message,
        source: d.source,
        code: d.code,
        range: {
            start: { line: d.range.start.line + 1, character: d.range.start.character + 1 },
            end: { line: d.range.end.line + 1, character: d.range.end.character + 1 },
        },
    };
}

async function directoryTree(runtime: ExpansionToolRuntime, requested: string, maxDepth: number, maxEntries: number): Promise<string> {
    const start = full(runtime, requested || '.');
    const rootRel = path.relative(runtime.workspaceRoot, start).replace(/\\/g, '/') || '.';
    const gitKeep = await gitIgnoredPaths(runtime);
    let isGit = gitKeep.size > 0;
    if (!isGit) {
        // --is-inside-work-tree walks UP ancestors, so a workspace root sitting
        // inside an outer repo that .gitignore-ignores the whole subtree kept
        // isGit=true with an empty keep-set - directory_tree then rendered a
        // fully-populated folder as just "./" (live dogfood finding), sending
        // the agent after phantom "missing" files. Git stays ground truth only
        // when the root is the repo toplevel, or the repo is nested INSIDE the
        // workspace (keep-set covers just a subtree; everything else is listed
        // as untracked anyway). A root strictly inside the repo with an empty
        // keep-set means the outer gitignore may hide real files - walk the
        // filesystem instead.
        const top = await git(runtime, ['rev-parse', '--show-toplevel'], 5000);
        if (top.code === 0) {
            const rel = path.relative(path.resolve(top.stdout.trim()), runtime.workspaceRoot);
            const rootInsideRepo = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
            isGit = !rootInsideRepo;
        }
    }
    const rows: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
        if (rows.length >= maxEntries || depth > maxDepth) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)); } catch { return; }
        for (const e of entries) {
            if (rows.length >= maxEntries) break;
            if (e.name === '.git') continue;
            const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (isGit) {
                    const hasTracked = Array.from(gitKeep).some(x => x === childRel || x.startsWith(childRel + '/'));
                    if (!hasTracked) continue;
                } else if (ignoredFallback(e.name)) continue;
                rows.push(`${'  '.repeat(depth)}${e.name}/`);
                walk(path.join(dir, e.name), childRel, depth + 1);
            } else {
                if (isGit && !gitKeep.has(childRel)) continue;
                rows.push(`${'  '.repeat(depth)}${e.name}`);
            }
        }
    };
    rows.push(`${rootRel}/`);
    walk(start, rootRel === '.' ? '.' : rootRel, 1);
    if (rows.length >= maxEntries) rows.push('… [entry limit reached]');
    return rows.join('\n');
}

export async function handleExpansionTool(name: string, args: any, runtime: ExpansionToolRuntime): Promise<any> {
    try {
        switch (name) {
            case 'git_status': {
                const r = await git(runtime, ['status', '--short', '--branch']);
                return textResult(r.code === 0 ? (r.stdout || 'Working tree clean.') : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_diff': {
                const mode = String(args.mode || 'worktree');
                const context = Math.max(0, Math.min(50, Number(args.context_lines) || 3));
                let cmd: string[];
                if (mode === 'staged') cmd = ['diff', '--cached', `--unified=${context}`];
                else if (mode === 'target') cmd = ['diff', `--unified=${context}`, safeRef(args.target, 'target')];
                else if (mode === 'range') cmd = ['diff', `--unified=${context}`, `${safeRef(args.source, 'source')}..${safeRef(args.target, 'target')}`];
                else cmd = ['diff', `--unified=${context}`];
                if (args.path) cmd.push('--', String(args.path));
                const r = await git(runtime, cmd);
                return textResult(r.code === 0 ? (r.stdout || 'No differences.') : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_log': {
                const n = Math.max(1, Math.min(200, Number(args.max_count) || 20));
                const cmd = ['log', `-${n}`, '--date=iso-strict', '--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s'];
                if (args.author) cmd.push(`--author=${args.author}`);
                if (args.since) cmd.push(`--since=${args.since}`);
                if (args.until) cmd.push(`--until=${args.until}`);
                if (args.grep) cmd.push(`--grep=${args.grep}`);
                if (args.branch) cmd.push(safeRef(args.branch, 'branch'));
                if (args.path) cmd.push('--', String(args.path));
                const r = await git(runtime, cmd);
                if (r.code !== 0) return textResult(`Git error: ${r.stderr || r.stdout}`, true);
                const rows = r.stdout.trim().split('\n').filter(Boolean).map(line => {
                    const [hash, short_hash, author, email, date, ...subject] = line.split('\t');
                    return { hash, short_hash, author, email, date, subject: subject.join('\t') };
                });
                return textResult(JSON.stringify(rows, null, 2));
            }
            case 'find_definitions':
            case 'find_references':
            case 'workspace_symbols':
                return await lspTool(name, args, runtime);
            case 'get_diagnostics': {
                let all: [vscode.Uri, vscode.Diagnostic[]][];
                if (args.path) all = [[uriFor(runtime, args.path), vscode.languages.getDiagnostics(uriFor(runtime, args.path))]];
                else all = vscode.languages.getDiagnostics();
                const wanted = String(args.severity || 'all');
                const out: any[] = [];
                for (const [uri, diags] of all) {
                    for (const d of diags) {
                        const sev = diagnosticJson(d).severity;
                        if (wanted !== 'all' && sev !== wanted) continue;
                        out.push({ uri: uri.fsPath, ...diagnosticJson(d) });
                    }
                    if (out.length >= 500) break;
                }
                return textResult(JSON.stringify(out.slice(0, 500), null, 2));
            }
            case 'directory_tree': {
                const out = await directoryTree(runtime, String(args.path || '.'), Math.max(1, Math.min(12, Number(args.max_depth) || 4)), Math.max(1, Math.min(5000, Number(args.max_entries) || 500)));
                return textResult(out);
            }
            case 'read_files': {
                const paths = Array.isArray(args.paths) ? args.paths.slice(0, MAX_BATCH_FILES) : [];
                const start = Math.max(1, Number(args.start_line) || 1);
                const maxLines = Math.min(DEFAULT_FILE_LINES, Math.max(1, Number(args.max_lines) || DEFAULT_FILE_LINES));
                let totalChars = 0;
                const results: string[] = [];
                for (const p of paths) {
                    try {
                        const fp = full(runtime, p);
                        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) throw new Error('file not found or not a regular file');
                        const lines = fs.readFileSync(fp, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
                        const slice = lines.slice(start - 1, start - 1 + maxLines);
                        let body = slice.join('\n');
                        const remaining = Math.max(0, FILE_MAX_CHARS - totalChars);
                        if (body.length > remaining) body = body.slice(0, Math.max(0, remaining)) + '\n… [batch output limit reached]';
                        totalChars += body.length;
                        const end = start + slice.length - 1;
                        results.push(`### ${p} - lines ${start}-${end} of ${lines.length}\n${body}${end < lines.length ? `\n… next_start_line=${end + 1}` : ''}`);
                        if (totalChars >= FILE_MAX_CHARS) break;
                    } catch (e: any) { results.push(`### ${p}\nError: ${e.message}`); }
                }
                return textResult(results.join('\n\n'));
            }
            case 'file_info': {
                const fp = full(runtime, args.path); const st = fs.statSync(fp);
                return textResult(JSON.stringify({ path: args.path, type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', size_bytes: st.size, modified: st.mtime.toISOString(), accessed: st.atime.toISOString(), created: st.birthtime.toISOString(), mode: process.platform === 'win32' ? undefined : (st.mode & 0o777).toString(8), extension: path.extname(fp), name: path.basename(fp) }, null, 2));
            }
            case 'copy_file': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before copy');
                const src = full(runtime, args.source), dst = full(runtime, args.destination);
                if (fs.existsSync(dst)) throw new Error('destination already exists');
                const srcSt = fs.statSync(src);
                if (srcSt.isDirectory()) { if (!args.recursive) throw new Error('source is a directory; set recursive=true'); await fs.promises.cp(src, dst, { recursive: true }); }
                else await fs.promises.copyFile(src, dst);
                return textResult(`Copied ${args.source} → ${args.destination}`);
            }
            case 'move_file': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before move');
                const src = full(runtime, args.source), dst = full(runtime, args.destination);
                if (!fs.existsSync(src)) throw new Error(`source not found: ${args.source}`);
                if (fs.existsSync(dst)) throw new Error('destination already exists');
                try {
                    await fs.promises.rename(src, dst);
                } catch (e: any) {
                    if (e.code !== 'EXDEV') throw e;
                    const srcSt = fs.statSync(src);
                    if (srcSt.isDirectory()) await fs.promises.cp(src, dst, { recursive: true });
                    else await fs.promises.copyFile(src, dst);
                    await fs.promises.rm(src, { recursive: true });
                }
                return textResult(`Moved ${args.source} → ${args.destination}`);
            }
            case 'delete_file': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before delete');
                const fp = full(runtime, args.path);
                if (!fs.existsSync(fp)) throw new Error(`file not found: ${args.path}`);
                const st = fs.statSync(fp);
                if (st.isDirectory() && !args.recursive) throw new Error('path is a directory; set recursive=true');
                await fs.promises.rm(fp, { recursive: !!args.recursive });
                return textResult(`Deleted ${args.path}`);
            }
            case 'git_show': {
                const a = ['show', '--no-ext-diff', '--decorate=short'];
                if (!args.patch) a.push('--no-patch');
                a.push(safeRef(args.revision, 'revision')); if (args.path) a.push('--', args.path);
                const r = await git(runtime, a); return textResult(r.code === 0 ? clip(r.stdout, Math.min(300000, Math.max(1000, (Number(args.max_lines) || 800) * 160))) : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_blame': {
                const a = ['blame', '--line-porcelain'];
                if (Number(args.start_line) > 0) a.push('-L', `${Number(args.start_line)},${Number(args.end_line) || Number(args.start_line)}`);
                a.push('--', String(args.path)); const r = await git(runtime, a); return textResult(r.code === 0 ? clip(r.stdout) : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_branch': {
                const action = args.action || 'list';
                if (action === 'list') { const r = await git(runtime, ['branch', '-vv']); return textResult(r.stdout || r.stderr, r.code !== 0); }
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, `before git branch ${action}`);
                const name = String(args.name || ''); if (!name) return textResult('Error: branch name is required', true);
                const cmd = action === 'create' ? ['branch', safeRef(name, 'branch name')] : action === 'delete' ? ['branch', ...(args.force ? ['-D'] : ['-d']), safeRef(name, 'branch name')] : ['switch', safeRef(name, 'branch name')];
                const r = await git(runtime, cmd); return textResult(r.code === 0 ? (r.stdout || `Branch ${action} succeeded.`) : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_commit': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before git commit');
                const message = String(args.message || '').trim();
                if (!message) return textResult('Error: commit message cannot be empty', true);
                if (args.stage_all) { await git(runtime, ['add', '-A']); }
                else if (Array.isArray(args.files) && args.files.length) {
                    for (const f of args.files) await git(runtime, ['add', '--', String(f)]);
                }
                const r = await git(runtime, ['commit', '-m', message]);
                return textResult(r.code === 0 ? (r.stdout || 'Committed.') : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_show_stash': {
                const action = args.action || 'list'; const r = await git(runtime, action === 'list' ? ['stash', 'list'] : ['stash', 'show', '-p', safeRef(args.stash || 'stash@{0}', 'stash')]); return textResult(r.code === 0 ? r.stdout || '(empty)' : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_checkout': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before git checkout');
                const paths = Array.isArray(args.paths) ? args.paths : [];
                const revision = String(args.revision || '');
                const cmd = paths.length
                    ? ['restore', ...(revision ? ['--source', safeRef(revision, 'revision')] : []), '--', ...paths]
                    : ['switch', safeRef(revision, 'revision')];
                if (!revision && !paths.length) return textResult('Error: revision or paths required', true);
                const r = await git(runtime, cmd); return textResult(r.code === 0 ? (r.stdout || 'Git checkout succeeded.') : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_pull': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before git pull');
                const cmd = ['pull']; if (args.rebase) cmd.push('--rebase'); if (args.remote) cmd.push(safeRef(args.remote, 'remote')); if (args.branch) cmd.push(safeRef(args.branch, 'branch'));
                const r = await git(runtime, cmd, 120_000); return textResult(r.code === 0 ? r.stdout : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_push': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before git push');
                const cmd = ['push']; if (args.force_with_lease) cmd.push('--force-with-lease'); if (args.set_upstream) cmd.push('-u'); if (args.remote) cmd.push(safeRef(args.remote, 'remote')); if (args.branch) cmd.push(safeRef(args.branch, 'branch'));
                const r = await git(runtime, cmd, 120_000); return textResult(r.code === 0 ? r.stdout : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'git_merge': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before git merge');
                const cmd = ['merge']; if (args.no_ff) cmd.push('--no-ff'); cmd.push(safeRef(args.revision, 'revision'));
                const r = await git(runtime, cmd, 120_000); return textResult(r.code === 0 ? r.stdout : `Git error: ${r.stderr || r.stdout}`, r.code !== 0);
            }
            case 'run_tests': {
                let framework = String(args.framework || 'auto');
                if (framework === 'auto') framework = await detectFramework(runtime.workspaceRoot);
                const py = pythonWorkspace(runtime.workspaceRoot);
                // Target args are workspace-root-relative, but python runs use
                // the manifest dir as cwd - rebase to absolute so pytest does
                // not look for src/src/... (seen live).
                const rawTarget = String(args.target || '');
                const target = framework === 'pytest' && rawTarget ? path.resolve(runtime.workspaceRoot, rawTarget) : rawTarget;
                const argv = commandForFramework(framework, target, String(args.pattern || ''), Array.isArray(args.extra_args) ? args.extra_args : [], py.python);
                if (!argv) return textResult(`Unsupported test framework: ${framework}`, true);
                const timeout = Math.max(1, Math.min(600, Number(args.timeout_seconds) || 120));
                const started = Date.now();
                const r = await runProcess(runtime, argv, timeout, (framework === 'pytest' || framework === 'unittest') ? py.cwd : undefined);
                const combined = `${r.stdout}\n${r.stderr}`.trim();
                const passed = (combined.match(/\b(\d+)\s+(?:tests?\s+)?passed\b/i)?.[1]) || undefined;
                const failed = (combined.match(/\b(\d+)\s+(?:tests?\s+)?failed\b/i)?.[1]) || undefined;
                const skipped = (combined.match(/\b(\d+)\s+skipped\b/i)?.[1]) || undefined;
                return textResult(JSON.stringify({
                    framework, command: argv.join(' '), exit_code: r.code, timed_out: r.timedOut,
                    // Which interpreter ran - makes silent system-Python falls visible.
                    ...(framework === 'pytest' || framework === 'unittest' ? { python: py.python, python_source: py.source, cwd: py.cwd } : {}),
                    passed: passed ? Number(passed) : null, failed: failed ? Number(failed) : null,
                    skipped: skipped ? Number(skipped) : null, duration_ms: Date.now() - started,
                    stdout: clip(r.stdout, 70000), stderr: clip(r.stderr, 50000),
                }, null, 2), r.timedOut || r.code !== 0);
            }
            case 'check_dependencies': {
                const info = await packageManagerInfo(runtime, String(args.ecosystem || 'auto'));
                return textResult(JSON.stringify(info, null, 2));
            }
            case 'install_dependency': {
                await runtime.ensureTurnSnapshot(runtime.workspaceRoot, 'before dependency install');
                const packages = Array.isArray(args.packages) ? args.packages : [];
                if (!packages.length || packages.some((p: any) => typeof p !== 'string' || !shellSafePackageName(p))) return textResult('Error: invalid package name(s)', true);
                const e = dependencyManager(runtime.workspaceRoot, String(args.ecosystem || 'auto'));
                let argv: string[] | null = null;
                switch (e) {
                    case 'node': argv = ['npm', 'install', ...(args.dev ? ['-D'] : []), ...packages]; break;
                    case 'python': argv = [pythonWorkspace(runtime.workspaceRoot).python, '-m', 'pip', 'install', ...packages]; break;
                    case 'rust': argv = packages.length === 1 ? ['cargo', 'add', packages[0]] : ['cargo', 'add', ...packages]; break;
                    case 'go': argv = ['go', 'get', ...packages]; break;
                    case 'java': argv = null; break;
                    case 'dotnet': argv = ['dotnet', 'add', 'package', packages[0]]; break;
                    case 'ruby': argv = ['bundle', 'add', packages[0]]; break;
                    case 'php': argv = ['composer', 'require', ...packages]; break;
                    case 'swift': argv = null; break;
                }
                if (!argv) return textResult(`Automatic installation is not implemented for ecosystem '${e}'. Use the project's package manager with run_terminal_command.`, true);
                const cwd = e === 'python' ? pythonWorkspace(runtime.workspaceRoot).cwd
                    : e === 'node' ? (findManifestDir(runtime.workspaceRoot, ['package.json']) || runtime.workspaceRoot)
                    : undefined;
                const r = await runProcess(runtime, argv, 180, cwd);
                if (e === 'python' && r.code !== 0) {
                    // PEP 668: distro-managed interpreters (Arch, Ubuntu 23.04+,
                    // Fedora…) refuse pip installs into the system environment.
                    // install_dependency already prefers the project venv - this
                    // failure means NO venv was found, so tell the agent exactly
                    // how to create one; the next call picks it up automatically.
                    const combinedOut = `${r.stdout}\n${r.stderr}`;
                    if (/externally-managed-environment/i.test(combinedOut)) {
                        return textResult([
                            `Install failed: the interpreter that ran (${pythonWorkspace(runtime.workspaceRoot).python}) is externally managed (PEP 668) and no project virtualenv was found.`,
                            'Fix: create a project venv once, e.g. `python -m venv .venv` in the workspace root, then re-run this tool - the project venv is detected automatically and pip installs go into it.',
                            String(r.stderr || r.stdout).slice(0, 2000),
                        ].join('\n'), true);
                    }
                }
                return textResult(`Command: ${argv.join(' ')}\nExit code: ${r.code}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`, r.code !== 0 || r.timedOut);
            }
            case 'update_task_list': {
                let listArgs: unknown = args.tasks;
                if (typeof listArgs === 'string') {
                    try { listArgs = JSON.parse(listArgs); } catch { /* fall through to validation */ }
                }
                const raw = Array.isArray(listArgs) ? listArgs : [];
                if (!raw.length) return textResult('Error: tasks must be a non-empty array', true);
                const items: TaskListItem[] = [];
                let idx = 0;
                for (const entry of raw.slice(0, TASK_LIST_MAX_ITEMS)) {
                    const label = taskListLabelOf(entry ?? {});
                    const labelOk = typeof label === 'string' ? label.trim().slice(0, TASK_LIST_MAX_LABEL) : '';
                    const status = (entry ?? {})?.status;
                    if (!labelOk || !(TASK_LIST_STATUSES as readonly string[]).includes(status)) {
                        // Name the offending entry - a 15-item list with one
                        // bad item must not have to be diffed by eye.
                        const preview = entry && typeof entry === 'object'
                            ? (String(taskListLabelOf(entry) ?? JSON.stringify(entry)).trim().slice(0, 60) || '?')
                            : '?';
                        return textResult(`Error: task[${idx}] ("${preview}") needs a label (or task/content/step) and a status of pending | in_progress | completed`, true);
                    }
                    items.push({ label: labelOk, status });
                    idx++;
                }
                _taskListWriteListener?.(items);
                const inProgress = items.filter((t) => t.status === 'in_progress').length;
                const done = items.filter((t) => t.status === 'completed').length;
                return textResult(`Task list updated (${items.length} items, ${done} completed${inProgress !== 1 ? `, ${inProgress} in_progress` : ''}).`);
            }
            case 'exit_plan_mode': {
                _planModeExitListener?.();
                return textResult(
                    'Plan mode has been ended. The CURRENT turn is still read-only; the next turn runs in normal mode with full tool access. Do not attempt any edits until then - finish with a one-sentence summary of the drafted plan.'
                );
            }
            default: return textResult(`Unknown expansion tool: ${name}`, true);
        }
    } catch (e: any) { return textResult(`Error in ${name}: ${e.message || String(e)}`, true); }
}

// Export helpers used by the main MCP dispatcher for future extensions.
export { ignoredFallback, gitIgnoredPaths, buildTree, commandForFramework, detectFramework, runProcess };

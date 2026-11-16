import * as fs from 'fs';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
const execFile = promisify(execFileCallback);
import * as vscode from 'vscode';
import { TASK_LIST_MAX_ITEMS, TASK_LIST_MAX_LABEL, TASK_LIST_STATUSES, taskListLabelOf, type TaskListItem } from './taskList';
export interface ExpansionToolRuntime {
    signal?: AbortSignal;
    workspaceRoot: string;
    sanitizePath: (inputPath: string, workspaceRoot: string) => string;
    ensureTurnSnapshot: (workspaceRoot: string, reason: string) => Promise<void>;
}
let _taskListWriteListener: ((tasks: TaskListItem[]) => void) | null = null;
export function setTaskListWriteListener(cb: ((tasks: TaskListItem[]) => void) | null): void {
    _taskListWriteListener = cb;
}
let _planModeExitListener: (() => void) | null = null;
export function setPlanModeExitListener(cb: (() => void) | null): void {
    _planModeExitListener = cb;
}
const MAX_OUTPUT = 120000;
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = [], approval = false) => ({
    name,
    description: approval ? `${description} Requires approval.` : description,
    inputSchema: { type: 'object', properties, required },
});
export const XRATU_EXPANSION_TOOLS = [
    tool('find_definitions', 'Find symbol definitions at a file position using VS Code language providers. line/character are 1-BASED (matching read_file output, not LSP wire format).', { path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1 } }, ['path', 'line', 'character']),
    tool('find_references', 'Find symbol references at a file position using VS Code language providers. line/character are 1-BASED (matching read_file output, not LSP wire format).', { path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, character: { type: 'integer', minimum: 1 }, include_declaration: { type: 'boolean' } }, ['path', 'line', 'character']),
    tool('symbols', 'List document symbols for path, or search workspace symbols using query. Results come from VS Code language providers.', { query: { type: 'string' }, path: { type: 'string' } }),
    tool('get_diagnostics', 'Return VS Code diagnostics for a file or the workspace.', { path: { type: 'string' }, severity: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'hint'] } }),
    tool('update_task_list', 'Create or replace the session task list (the plan artifact and execution tracker). Outside plan mode, reserve it for substantial work or an explicit user request, not simple fixes or short tasks. Update at meaningful milestones, not after every tool call; do not resend unchanged lists. Sends the COMPLETE list every time - later calls replace it entirely. Every label must be ONE SHORT single sentence (~10 words max): an imperative action, no elaboration, no multi-clause detail - put supporting detail in the chat text instead. Write every label in the language you are replying to the user in - the checklist is user-facing UI, not an internal artifact, so match the user\'s language instead of defaulting to English (code identifiers inside a label stay verbatim). Use one item per concrete verifiable step. When you FIRST draft the plan, always mark the FIRST step in_progress so it is highlighted as the starting point (everything else pending) - never a fully-pending first draft. While executing: exactly ONE item in_progress at a time, mark verified items completed at meaningful milestones. The user may edit the list between calls - respect their changes, do not silently revert them.', {
        tasks: {
            type: 'array',
            description: 'The complete task list, in execution order.',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Short imperative step label in the language you are replying in, e.g. "Add Alembic migration for tasks table".' },
                    status: { type: 'string', enum: [...TASK_LIST_STATUSES], description: 'pending | in_progress | completed.' },
                },
                required: ['label', 'status'],
            },
            minItems: 1,
            maxItems: TASK_LIST_MAX_ITEMS,
        },
    }, ['tasks']),
    tool('exit_plan_mode', 'End plan mode. In plan mode, call this ONCE as the LAST step - right after drafting the implementation plan as a task list with update_task_list. It hands control back to the user so the work can be executed in the next turn (which runs in normal mode). No arguments. Meaningless outside plan mode.', {}, [])
];
function textResult(text: string, isError = false) {
    // JSON results must remain parseable; bound their string fields before serialization.
    if (text.length > MAX_OUTPUT) {
        try {
            const value: unknown = JSON.parse(text);
            let budget = 4000;
            const bounded = (v: unknown): unknown => {
                if (typeof v === 'string') {
                    const out = v.slice(0, Math.max(0, budget));
                    budget -= out.length;
                    return out.length < v.length ? out + '… [truncated]' : out;
                }
                if (Array.isArray(v))
                    return v.slice(0, 100).map(bounded);
                if (v && typeof v === 'object')
                    return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, bounded(x)]));
                return v;
            };
            text = JSON.stringify(bounded(value));
            if (text.length > MAX_OUTPUT)
                text = JSON.stringify({ truncated: true, preview: text.slice(0, 16000) });
        }
        catch {
            text = text.slice(0, MAX_OUTPUT) + '\n[truncated]';
        }
    }
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
function full(runtime: ExpansionToolRuntime, p: string): string {
    return runtime.sanitizePath(p, runtime.workspaceRoot);
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
    if (name === 'symbols' && args.path) {
        const uri = uriFor(runtime, args.path);
        const result = await vscode.commands.executeCommand<any[]>('vscode.executeDocumentSymbolProvider', uri);
        let remaining = 500;
        const bounded = (items: any[]): any[] => items.slice(0, 200).flatMap(item => {
            if (remaining-- <= 0)
                return [];
            return [{ ...locationJson(item), ...(item.children?.length ? { children: bounded(item.children) } : {}) }];
        });
        return textResult(JSON.stringify({ symbols: bounded(result ?? []), status: result?.length ? 'ok' : 'empty_or_unavailable' }));
    }
    if (name === 'symbols') {
        const query = String(args.query || '').trim();
        if (!query)
            return textResult('Error: query cannot be empty', true);
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query) || [];
        return textResult(JSON.stringify(symbols.slice(0, 200).map(locationJson), null, 2));
    }
    if (!args.path)
        return textResult('Error: path is required', true);
    const uri = uriFor(runtime, args.path);
    if (!fs.existsSync(uri.fsPath))
        return textResult(`Error: file not found: ${args.path}`, true);
    const position = new vscode.Position(Math.max(0, Number(args.line || 1) - 1), Math.max(0, Number(args.character || 1) - 1));
    if (name === 'find_definitions') {
        const result = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', uri, position) || [];
        return textResult(JSON.stringify(result.slice(0, 100).map(locationJson), null, 2));
    }
    if (name === 'find_references') {
        let result = await vscode.commands.executeCommand<any[]>('vscode.executeReferenceProvider', uri, position) || [];
        if (args.include_declaration === false) {
            const definitions = await vscode.commands.executeCommand<any[]>('vscode.executeDefinitionProvider', uri, position) || [];
            result = result.filter(ref => !definitions.some(def => {
                const targetUri = def.targetUri ?? def.uri;
                const range = def.targetSelectionRange ?? def.range;
                return targetUri?.toString() === ref.uri?.toString() && range?.contains(ref.range.start);
            }));
        }
        return textResult(JSON.stringify(result.slice(0, 300).map(locationJson), null, 2));
    }
    return textResult('Unknown LSP tool', true);
}
function diagnosticJson(d: vscode.Diagnostic) {
    return {
        severity: ['error', 'warning', 'info', 'hint'][d.severity] || 'unknown',
        message: d.message,
        source: d.source,
        code: d.code,
        range: {
            start: { line: d.range.start.line + 1, character: d.range.start.character + 1 },
            end: { line: d.range.end.line + 1, character: d.range.end.character + 1 },
        },
    };
}
export async function handleExpansionTool(name: string, args: any, runtime: ExpansionToolRuntime): Promise<any> {
    try {
        switch (name) {
            case 'find_definitions':
            case 'find_references':
            case 'symbols':
                return await lspTool(name, args, runtime);
            case 'get_diagnostics': {
                let all: [
                    vscode.Uri,
                    vscode.Diagnostic[]
                ][];
                if (args.path)
                    all = [[uriFor(runtime, args.path), vscode.languages.getDiagnostics(uriFor(runtime, args.path))]];
                else
                    all = vscode.languages.getDiagnostics();
                const wanted = String(args.severity || 'all');
                const out: any[] = [];
                for (const [uri, diags] of all) {
                    for (const d of diags) {
                        const sev = diagnosticJson(d).severity;
                        if (wanted !== 'all' && sev !== wanted)
                            continue;
                        out.push({ uri: uri.fsPath, ...diagnosticJson(d) });
                    }
                    if (out.length >= 500)
                        break;
                }
                return textResult(JSON.stringify(out.slice(0, 500), null, 2));
            }
            case 'update_task_list': {
                let listArgs: unknown = args.tasks;
                if (typeof listArgs === 'string') {
                    try {
                        listArgs = JSON.parse(listArgs);
                    }
                    catch { /* fall through to validation */ }
                }
                const raw = Array.isArray(listArgs) ? listArgs : [];
                if (!raw.length)
                    return textResult('Error: tasks must be a non-empty array', true);
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
                return textResult('Plan mode has been ended. The CURRENT turn is still read-only; the next turn runs in normal mode with full tool access. Do not attempt any edits until then - finish with a one-sentence summary of the drafted plan.');
            }
            default: return textResult('Unknown or removed tool: ' + name, true);
        }
    }
    catch (error) {
        return textResult(String(error), true);
    }
}
/** Shared workspace inventory for context selection; not a model tool. */
export async function gitWorkspaceFiles(workspaceRoot: string, timeout = 15000): Promise<Set<string>> {
    try {
        const result = await execFile('git', ['-C', workspaceRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return new Set(String(result.stdout ?? '').split('\0').filter(Boolean).map(item => item.replace(/\\/g, '/')));
    }
    catch {
        return new Set();
    }
}

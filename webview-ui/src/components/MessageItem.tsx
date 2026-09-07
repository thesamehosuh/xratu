import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** useLayoutEffect, but SSR-safe (the render test server-renders components;
 *  the real webview is client-only). */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import { createJavaScriptRegexEngine, getSingletonHighlighter } from 'shiki';
import {
    Brain,
    Check,
    ChevronDown,
    CircleDot,
    Clock,
    CodeXml,
    Copy,
    CornerDownRight,
    FilePen,
    FileText,
    FolderOpen,
    FolderTree,
    GitBranch,
    GripVertical,
    Image as ImageIcon,
    Globe,
    ListChecks,
    Package,
    PackagePlus,
    Paperclip,
    PencilLine,
    Plus,
    RefreshCw,
    Search,
    ShieldCheck,
    Sparkles,
    SquareTerminal,
    Trash2,
    TriangleAlert,
    Wrench,
    X,
} from 'lucide-react';
import type { ApprovalPayload, ChatMessage, ConnectionStatus, Step, TaskListItem, TaskListStatus } from '../types';
import { RenderedMarkdown } from './RenderedMarkdown';
import { t, getLocale } from '../i18n';

function RetryCountdown({ retryStatus }: { retryStatus: NonNullable<ChatMessage['retryStatus']> }) {
    const [seconds, setSeconds] = useState(Math.ceil(retryStatus.nextRetryInMs / 1000));
    useEffect(() => {
        if (seconds <= 0) return;
        const timer = setInterval(() => {
            setSeconds((s) => (s > 0 ? s - 1 : 0));
        }, 1000);
        return () => clearInterval(timer);
    }, [seconds]);
    return (
        <div className="msg-content retry-status" aria-live="polite">
            <span className="retry-dot" aria-hidden="true" />
            <span>{t('retrying')}: {retryStatus.attempt}/{retryStatus.maxAttempts}</span>
            <span className="retry-countdown">{seconds}s</span>
        </div>
    );
}

type ToolRow = { key: string; call: Step; result?: Step };
type Row =
    | { key: string; kind: 'thinking'; step: Step }
    // Consecutive text steps merge into ONE row: reasoning deltas interleaved
    // mid-prose fragment the stream into many text steps, and rendering each
    // with its own paragraph margins double-spaces the answer (reload renders
    // it as ONE markdown block - the two views must look the same).
    | { key: string; kind: 'text'; steps: Step[] }
    | ({ key: string; kind: 'tool' } & ToolRow)
    | { key: string; kind: 'toolGroup'; calls: ToolRow[] }
    | { key: string; kind: 'taskList'; step: Step };

export const TASK_LIST_TOOL = 'update_task_list';

/** Field aliases weak models emit for the schema's `label` (observed live:
 *  Terminal Game sent `task`). Mirrors extension/src/taskList.ts. */
const TASK_LIST_LABEL_KEYS = ['label', 'task', 'content', 'step'] as const;

function taskListLabelOf(entry: object): unknown {
    for (const key of TASK_LIST_LABEL_KEYS) {
        const v = (entry as Record<string, unknown>)[key];
        if (typeof v === 'string') return v;
    }
    return undefined;
}

/** Parse a task-list toolCall step's args. Accepts the parsed dict OR the
 *  raw JSON string; `label`/`task`/`content`/`step` aliases are tolerated
 *  (weak models). Malformed/legacy payloads return null so the row falls
 *  back to the plain tool pill. */
export function parseTaskListStep(text: string): TaskListItem[] | null {
    try {
        const v: unknown = JSON.parse(text);
        const obj = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
        const raw = obj && Array.isArray(obj.tasks) ? obj.tasks : undefined;
        if (!raw || raw.length === 0) return null;
        const items: TaskListItem[] = [];
        for (const entry of raw) {
            if (!entry || typeof entry !== 'object') return null;
            const label = taskListLabelOf(entry as object);
            const status = (entry as { status?: unknown }).status;
            if (typeof label !== 'string' || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return null;
            const clean = label.trim();
            if (!clean) return null;
            items.push({ label: clean, status });
        }
        return items;
    } catch {
        return null;
    }
}

/** Is this tool row finished (has a paired result)? */
function toolRowDone(r: ToolRow): boolean {
    return !!(r.call.result || (r.result && r.result.kind === 'toolCall'));
}

/** Consecutive same-tool calls collapse into ONE pill ("Read file ×8") -
 *  a run that reads ten files in a row should read as one action, not ten
 *  identical rows. Thinking steps and other tools break the run. */
function pushToolRow(rows: Row[], row: ToolRow): void {
    const last = rows[rows.length - 1];
    if (last?.kind === 'toolGroup' && last.calls[0].call.tool === row.call.tool) {
        last.calls.push(row);
        return;
    }
    if (last?.kind === 'tool' && last.call.tool === row.call.tool) {
        rows[rows.length - 1] = { key: last.key, kind: 'toolGroup', calls: [last, row] };
        return;
    }
    rows.push({ ...row, kind: 'tool' });
}

const TOOL_ICONS: Array<{ re: RegExp; icon: typeof Wrench }> = [
    { re: /^update_task_list$/, icon: ListChecks },
    { re: /^exit_plan_mode$/, icon: ShieldCheck },
    { re: /^skill$/, icon: Sparkles },
    { re: /terminal|command/, icon: SquareTerminal },
    { re: /grep/, icon: Search },
    { re: /glob/, icon: Search },
    { re: /read_files|file_info/, icon: FileText },
    { re: /read_file/, icon: FileText },
    { re: /list_files|dir/, icon: FolderOpen },
    { re: /directory_tree/, icon: FolderTree },
    { re: /edit|replace|patch/, icon: FilePen },
    { re: /copy_file/, icon: Copy },
    { re: /move_file/, icon: FilePen },
    { re: /delete_file/, icon: Trash2 },
    { re: /definition/, icon: CodeXml },
    { re: /find_/, icon: Search },
    { re: /workspace_symbols/, icon: CodeXml },
    { re: /diagnostics/, icon: Check },
    { re: /git_/, icon: GitBranch },
    { re: /fetch_url/, icon: Globe },
    { re: /web_search/, icon: Globe },
    { re: /test/, icon: ShieldCheck },
    { re: /dependency/, icon: Package },
    { re: /install_/, icon: PackagePlus },
    { re: /mcp__/, icon: FolderOpen },
];

/** Persian labels for the builtin tool pills - shown RTL like the thinking
 *  pill; unknown/external tools fall back to their raw LTR name. */
const TOOL_LABELS: Array<{ re: RegExp; key: Parameters<typeof t>[0] }> = [
    { re: /^run_terminal_command$/, key: 'toolTerminal' },
    { re: /^read_file$/, key: 'toolReadFile' },
    { re: /^read_files$/, key: 'toolReadFiles' },
    { re: /^file_info$/, key: 'toolFileInfo' },
    { re: /^list_files$/, key: 'toolListFiles' },
    { re: /^grep_search$/, key: 'toolGrepSearch' },
    { re: /^glob_search$/, key: 'toolGlobSearch' },
    { re: /^replace_in_file$/, key: 'toolReplaceInFile' },
    { re: /^apply_patch$/, key: 'toolApplyPatch' },
    { re: /^edit_file$/, key: 'toolEditFile' },
    { re: /^write_file$|^create_file$/, key: 'toolWriteFile' },
    { re: /^copy_file$/, key: 'toolCopyFile' },
    { re: /definition$/, key: 'toolDefinitions' },
    { re: /^git_status$/, key: 'toolGitStatus' },
    { re: /^git_diff$/, key: 'toolGitDiff' },
    { re: /^git_log$/, key: 'toolGitLog' },
    { re: /^git_commit$/, key: 'toolGitCommit' },
    { re: /^git_show$/, key: 'toolGitShow' },
    { re: /^git_blame$/, key: 'toolGitBlame' },
    { re: /^git_branch$/, key: 'toolGitBranch' },
    { re: /^git_show_stash$/, key: 'toolGitStash' },
    { re: /^git_checkout$/, key: 'toolGitCheckout' },
    { re: /^git_pull$/, key: 'toolGitPull' },
    { re: /^git_push$/, key: 'toolGitPush' },
    { re: /^git_merge$/, key: 'toolGitMerge' },
    { re: /^fetch_url$/, key: 'toolFetchUrl' },
    { re: /^find_definitions$/, key: 'toolFindDefinitions' },
    { re: /^find_references$/, key: 'toolFindReferences' },
    { re: /^workspace_symbols$/, key: 'toolWorkspaceSymbols' },
    { re: /^get_diagnostics$/, key: 'toolGetDiagnostics' },
    { re: /^directory_tree$/, key: 'toolDirectoryTree' },
    { re: /^run_tests$/, key: 'toolRunTests' },
    { re: /^move_file$/, key: 'toolMoveFile' },
    { re: /^delete_file$/, key: 'toolDeleteFile' },
    { re: /^check_dependencies$/, key: 'toolCheckDependencies' },
    { re: /^install_dependency$/, key: 'toolInstallDependency' },
    { re: /^web_search$/, key: 'toolWebSearch' },
    { re: /^update_task_list$/, key: 'toolUpdateTaskList' },
    { re: /^exit_plan_mode$/, key: 'toolExitPlanMode' },
    { re: /^skill$/, key: 'toolSkill' },
];

function toolIcon(tool?: string): typeof Wrench {
    if (!tool) return Wrench;
    for (const { re, icon } of TOOL_ICONS) {
        if (re.test(tool)) return icon;
    }
    return Wrench;
}

function toolLabel(tool?: string): { fa: string; known: boolean } {
    if (!tool) return { fa: t('toolGeneric'), known: false };
    for (const { re, key } of TOOL_LABELS) {
        if (re.test(tool)) return { fa: t(key), known: true };
    }
    // External MCP tools: strip the mcp__<server>__ namespace into a
    // "server · tool" display (still LTR content inside the RTL pill).
    if (tool.startsWith('mcp__')) {
        const rest = tool.slice(5);
        const sep = rest.indexOf('__');
        if (sep > 0) return { fa: `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`, known: false };
    }
    return { fa: tool, known: false };
}

/** Compact wall-clock span for a finished thinking pill ("2.4s" / "12s"). */
function fmtDur(ms?: number): string {
    if (!ms || ms < 0) return '';
    const s = ms / 1000;
    return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

/** "1.2k"-style token counts for the answer footer. */
function fmtTok(n: number | null): string {
    if (n === null || n === undefined) return '–';
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return String(n);
}

function buildRows(steps: Step[]): Row[] {
    // Results arrive PAIRED onto their call step (Step.result). A standalone
    // toolResult step only exists as an orphan fallback - it renders as an
    // already-completed row (its text is the RESULT, never args).
    const rows: Row[] = [];
    for (const s of steps) {
        if (s.kind === 'thinking') {
            rows.push({ key: s.id, kind: 'thinking', step: s });
        } else if (s.kind === 'text') {
            const last = rows[rows.length - 1];
            if (last?.kind === 'text') {
                last.steps.push(s);
            } else {
                rows.push({ key: s.id, kind: 'text', steps: [s] });
            }
        } else if (s.kind === 'toolCall') {
            if (s.tool === TASK_LIST_TOOL) {
                // Rendered as the interactive checklist, not a pill. The call
                // row carries the list; a paired result row is redundant.
                rows.push({ key: s.id, kind: 'taskList', step: s });
                continue;
            }
            pushToolRow(rows, { key: s.id, call: s });
        } else if (s.kind === 'toolResult') {
            if (s.tool === TASK_LIST_TOOL) continue;
            pushToolRow(rows, {
                key: s.id,
                call: { ...s, text: '' },
                result: { ...s, kind: 'toolCall', text: '' },
            });
        }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Tool dropdown bodies - one dedicated design per tool family. All content
// sits directly on the pill background (no inner boxes/borders).
// ---------------------------------------------------------------------------

type ToolFamily = 'edit' | 'terminal' | 'read' | 'search' | 'git' | 'web' | 'ops' | 'mcp' | 'generic';

/** Edit/terminal dropdowns open by default - the diff/command IS the payload
 *  the user cares about; everything else stays collapsed. */
const DEFAULT_OPEN_FAMILIES: readonly ToolFamily[] = ['edit', 'terminal'];

/** Regex-ordered, first match wins - mirrors TOOL_ICONS/TOOL_LABELS style. */
function toolFamily(tool?: string): ToolFamily {
    if (!tool) return 'generic';
    if (tool.startsWith('mcp__')) return 'mcp';
    if (/^(apply_patch|replace_in_file|edit_file|write_file|create_file)$/.test(tool)) return 'edit';
    if (/terminal|command/.test(tool)) return 'terminal';
    if (/^read_files?$|^file_info$/.test(tool)) return 'read';
    if (/^skill$/.test(tool)) return 'read';
    if (/grep|glob|find_|workspace_symbols|list_files|directory_tree/.test(tool)) return 'search';
    if (/^git_/.test(tool)) return 'git';
    if (/fetch_url|web_search/.test(tool)) return 'web';
    if (/^run_tests$|^get_diagnostics$|^check_dependencies$|^install_dependency$|^copy_file$|^move_file$|^delete_file$/.test(tool)) return 'ops';
    return 'generic';
}

/** History-replay clip markers the host prepends to sanitized model-context
 *  copies. Rows persisted by older resume paths can carry them inside pill
 *  args - strip on display; the live file is the truth. */
const REPLAY_MARKER_RE = /… \[[^\]]*trimmed in history replay[^\]]*\]\s?/g;

function stripReplayMarkers(s: string): string {
    return s.replace(REPLAY_MARKER_RE, '');
}

function parseArgs(text: string): Record<string, unknown> | null {
    try {
        let v: unknown = JSON.parse(text);
        // Cloud events stringify dict args, so replayed args can arrive as a
        // JSON string CONTAINING JSON - unwrap one level.
        if (typeof v === 'string') v = JSON.parse(v);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = typeof val === 'string' ? stripReplayMarkers(val) : val;
        }
        return out;
    } catch {
        return null;
    }
}

const LONG_ARG = 20000;

function truncateArg(v: string): string {
    return v.length > LONG_ARG ? v.slice(0, LONG_ARG) + '\n' + t('argTruncated') : v;
}

/** Result text for a tool row: paired call steps carry it as `call.result`
 *  (string, state.ts); orphan toolResult rows arrive as a separate
 *  pseudo-call step whose text is blanked by buildRows - the payload sits
 *  on its `result` field there. */
function resultTextOf(call: Step, result?: Step): string {
    const raw = result ? result.text || result.result || '' : call.result ?? '';
    return stripReplayMarkers(raw);
}

/** Tool payloads carry no structured error flag, so failure is detected
 *  from the result text ("Error: …", "Error from VS Code: …"). */
const ERROR_RESULT_RE = /^error\b/i;

function toolRowFailed(call: Step, result?: Step): boolean {
    return ERROR_RESULT_RE.test(resultTextOf(call, result).trim());
}

function argString(args: Record<string, unknown> | null, key: string): string | undefined {
    const v = args?.[key];
    return typeof v === 'string' && v ? v : undefined;
}

interface PatchBlock {
    search: string;
    replace: string;
}

/** Parse apply_patch SEARCH/REPLACE blocks (<<<<<<< SEARCH / ======= /
 *  >>>>>>> REPLACE) for DISPLAY. Tolerant on purpose - this mirrors what the
 *  host's executor accepts (BOM/CRLF, leading junk lines) plus the payload
 *  trims it must survive: a `… [+N chars truncated]` tail appended by the
 *  300-char event clipping (history replay), markers with trailing
 *  whitespace, and a final block whose REPLACE terminator was cut off by
 *  that clipping. Returns null only when no block structure exists at all
 *  so callers fall back to plain text. Marker content lines are refused
 *  upstream (mcp.ts), so the split is unambiguous in practice. */
function parsePatchBlocks(patch: string): PatchBlock[] | null {
    const lines = stripReplayMarkers(patch)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/… \[\+\d+ chars truncated\][\s\S]*$/, '')
        .split('\n');
    const blocks: PatchBlock[] = [];
    let search: string[] = [];
    let replace: string[] = [];
    let phase: 'none' | 'search' | 'replace' = 'none';
    const flush = () => {
        if (phase === 'search' || phase === 'replace') {
            blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
        }
        search = [];
        replace = [];
        phase = 'none';
    };
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '').trimEnd();
        // A mid-line SEARCH marker (junk prepended by an old clipping bug
        // rides the same line) still opens a block - everything before the
        // marker is junk the host executor ignores too.
        const searchIdx = line.search(/<{7}\s*SEARCH/);
        if (searchIdx >= 0) {
            const prefix = line.slice(0, searchIdx);
            if (phase !== 'none') flush();
            phase = 'search';
            const tail = line.slice(searchIdx).replace(/^<{7}\s*SEARCH[^\S\n]*/, '');
            if (tail) search.push(tail);
            else if (prefix) search.push(prefix);
            continue;
        }
        if (/^={7}$/.test(line)) {
            if (phase !== 'search') return null;
            phase = 'replace';
        } else if (/^>{7}/.test(line)) {
            if (phase !== 'replace') return null;
            flush();
        } else if (phase === 'search') {
            search.push(line);
        } else if (phase === 'replace') {
            replace.push(line);
        }
        // phase 'none': skip pre-marker lines - the host's block regex
        // ignores leading junk around the blocks too.
    }
    // A clipped patch ends mid-block: flush whatever survived so the pill
    // still shows the tinted (partial) diff instead of raw text.
    flush();
    return blocks.length > 0 ? blocks : null;
}

/** Line-level LCS diff between a block's SEARCH and REPLACE sections:
 *  unchanged lines stay neutral, only real changes get the del/add tint -
 *  whole-block tinting reads as a red/green wall, not a diff. Returns null
 *  for oversized blocks (fallback: whole-section tint). */
const BLOCK_DIFF_MAX_LINES = 400;

type BlockDiffLine = { kind: 'same' | 'del' | 'add'; text: string };

function diffBlockLines(search: string, replace: string): BlockDiffLine[] | null {
    const a = search ? search.split('\n') : [];
    const b = replace ? replace.split('\n') : [];
    if (a.length + b.length > BLOCK_DIFF_MAX_LINES) return null;
    const m = a.length;
    const n = b.length;
    const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out: BlockDiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            out.push({ kind: 'same', text: a[i] });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ kind: 'del', text: a[i] });
            i++;
        } else {
            out.push({ kind: 'add', text: b[j] });
            j++;
        }
    }
    while (i < m) { out.push({ kind: 'del', text: a[i] }); i++; }
    while (j < n) { out.push({ kind: 'add', text: b[j] }); j++; }
    return out;
}

/** One apply_patch block: LCS-diffed against the target file's language and
 *  SHIKI-highlighted per line. `del` lines consume the SEARCH text's
 *  highlighted lines in order, `add`/`same` lines the REPLACE text's - the
 *  cursors stay aligned because both walks are strictly in line order.
 *  Highlight absent (unmapped language, async not landed, failure) → the
 *  raw line, ESCAPED (model-controlled + dangerouslySetInnerHTML). */
function PillDiffBlock({ block, lang }: { block: PatchBlock; lang: string }) {
    const delLines = useHighlightedCode(block.search, lang);
    const addLines = useHighlightedCode(block.replace, lang);
    const lines = useMemo(() => diffBlockLines(block.search, block.replace), [block.search, block.replace]);
    if (!lines) {
        return (
            <div className="pill-diff-block">
                {block.search ? <pre className="pill-diff-del">{block.search}</pre> : null}
                {block.replace ? <pre className="pill-diff-add">{block.replace}</pre> : null}
            </div>
        );
    }
    let di = 0;
    let ai = 0;
    return (
        <div className="pill-diff-block">
            {lines.map((l, j) => {
                const hi = l.kind === 'del' ? delLines[di++] ?? '' : addLines[ai++] ?? '';
                return (
                    <div key={j} className={`pill-diff-line${l.kind === 'same' ? '' : ` ${l.kind}`}`} dir="ltr">
                        <span className="pill-diff-mark" aria-hidden="true">
                            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                        </span>
                        <span
                            className="pill-diff-code"
                            dangerouslySetInnerHTML={{ __html: hi || escapeHtml(l.text) || '&nbsp;' }}
                        />
                    </div>
                );
            })}
        </div>
    );
}

/** Edit-family diff view: per-line del/add tint with +/− gutter marks and
 *  IDE-style syntax highlighting, full-bleed on the pill background.
 *  Unparseable patch → plain text. */
function PatchBlocksView({ patch, lang }: { patch: string; lang: string }) {
    const blocks = useMemo(() => parsePatchBlocks(patch), [patch]);
    if (!blocks) return <pre dir="ltr">{truncateArg(patch)}</pre>;
    return (
        <div className="pill-diff" dir="ltr">
            {blocks.map((b, i) => (
                <PillDiffBlock key={i} block={b} lang={lang} />
            ))}
        </div>
    );
}

/** Shiki-highlighted code block; renders RAW (escaped-by-React) text until
 *  the async highlight lands or on any failure/unmapped language. Per-LINE
 *  spans: shiki line markup is unbalanced after the class="line" strip, so
 *  each line gets its own element - exactly like ApprovalDiffView's cells. */
function HighlightedPre({ code, lang, className }: { code: string; lang: string; className?: string }) {
    const lines = useHighlightedCode(code, lang);
    if (lines.length === 0) return <pre className={className} dir="ltr">{code}</pre>;
    return (
        <pre className={className} dir="ltr">
            {lines.map((h, i) => (
                <div key={i} className="pill-diff-line" dangerouslySetInnerHTML={{ __html: h || '&nbsp;' }} />
            ))}
        </pre>
    );
}

/** Accent mono line for paths / URLs (edit, read, web families). */
function PathLine({ path }: { path: string }) {
    return <div className="tool-path" dir="ltr">{path}</div>;
}

/** One-line result note; error-prefixed results tint danger. */
function ResultLine({ text }: { text: string }) {
    if (!text) return null;
    const err = /^error\b/i.test(text.trim());
    return <div className={`tool-note${err ? ' err' : ''}`} dir="auto">{text}</div>;
}

/** Remaining scalar args as muted key/value hint lines. */
function ScalarHints({ args, skip }: { args: Record<string, unknown> | null; skip: string[] }) {
    if (!args) return null;
    const entries = Object.entries(args).filter(
        ([k, v]) => !skip.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    );
    if (entries.length === 0) return null;
    return (
        <div className="tool-hints" dir="ltr">
            {entries.map(([k, v]) => (
                <div key={k} className="tool-hint">
                    <span className="step-io-tag">{k}</span>
                    <span className="tool-hint-val">{String(v)}</span>
                </div>
            ))}
        </div>
    );
}

/** Labeled key/value args - the generic body (fallback, git, ops, mcp). */
function ArgView({ call }: { call: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    if (!args) return <pre dir="ltr">{call.text || t('noArgs')}</pre>;
    if (Object.keys(args).length === 0)
        return <pre dir="ltr">{t('noArgs')}</pre>;
    return (
        <div className="arg-view" dir="ltr">
            {Object.entries(args).map(([k, v]) => {
                // Non-scalar args render as pretty JSON - String(v) would
                // show "[object Object]".
                const isStr = typeof v === 'string';
                const shown = isStr ? truncateArg(v) : truncateArg(JSON.stringify(v, null, 2) ?? '');
                return (
                    <div key={k} className="arg-item">
                        <span className="step-io-tag">{k}</span>
                        <pre dir="ltr">{shown}</pre>
                    </div>
                );
            })}
        </div>
    );
}

function EditBody({ call, result }: { call: Step; result?: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    const path = argString(args, 'path');
    const mode = argString(args, 'mode');
    const patch = argString(args, 'patch');
    const content = argString(args, 'new_content');
    // Unparseable args (old rows persisted with a prepended replay marker
    // break JSON.parse) can still carry patch blocks in the raw text -
    // parsePatchBlocks strips the markers and ignores leading junk.
    const rawPatch = !patch && !content && call.text.includes('<<<<<<<') ? call.text : undefined;
    // Edit bodies NEVER stream: the patch/content grows per chunk while the
    // tool runs, so the dropdown shows a loading row and renders the full
    // (shiki-highlighted) diff only when the write has finished.
    const done = !!call.result || !!result;
    return (
        <>
            {path && <PathLine path={path} />}
            {mode && <span className="tool-mode" dir="ltr">{mode}</span>}
            {done ? (
                patch !== undefined ? (
                    <PatchBlocksView patch={patch} lang={extToLang(path ?? '')} />
                ) : rawPatch !== undefined ? (
                    <PatchBlocksView patch={rawPatch} lang={extToLang(path ?? '')} />
                ) : content !== undefined ? (
                    <HighlightedPre code={truncateArg(content)} lang={extToLang(path ?? '')} />
                ) : (
                    <ArgView call={call} />
                )
            ) : (
                <div className="tool-loading">
                    <span className="spinner" aria-hidden="true" />
                    <span>{t('toolRunning')}</span>
                </div>
            )}
            <ResultLine text={resultTextOf(call, result)} />
        </>
    );
}

interface TerminalOutput {
    stdout: string;
    stderr: string;
    exitCode: string | null;
    error: string | null;
}

/** Split a terminal tool result into its labeled sections. The host formats
 *  results as `STDOUT:\n…\nSTDERR:\n…` plus a trailing `Exit code: N`
 *  (mcp.ts) or a leading one (xratu_mcp_tools.ts); `Error: …` lines ride
 *  after them. Returns null when the text doesn't match that shape (other
 *  tools' results must not be mislabeled) - caller falls back to raw text. */
function parseTerminalOutput(text: string): TerminalOutput | null {
    if (!text) return null;
    let rest = text;
    const res: TerminalOutput = { stdout: '', stderr: '', exitCode: null, error: null };
    const exitMatch = rest.match(/(?:^|\n)Exit code: (.+?)(?:\n|$)/);
    if (exitMatch) {
        res.exitCode = exitMatch[1].trim();
        rest = rest.replace(/(?:^|\n)Exit code: .+?(?:\n|$)/, '\n');
    }
    const errIdx = rest.search(/(?:^|\n)Error: /);
    if (errIdx >= 0) {
        res.error = rest.slice(errIdx).trim();
        rest = rest.slice(0, errIdx);
    }
    const outIdx = rest.indexOf('STDOUT:\n');
    if (outIdx < 0) return null;
    rest = rest.slice(outIdx + 'STDOUT:\n'.length);
    const errOutIdx = rest.indexOf('STDERR:\n');
    if (errOutIdx < 0) {
        res.stdout = rest.replace(/\n+$/, '');
    } else {
        res.stdout = rest.slice(0, errOutIdx).replace(/\n+$/, '');
        res.stderr = rest.slice(errOutIdx + 'STDERR:\n'.length).replace(/\n+$/, '');
    }
    if (res.stdout === '(empty)') res.stdout = '';
    if (res.stderr === '(empty)') res.stderr = '';
    return res;
}

function TerminalBody({ call, result }: { call: Step; result?: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    const cmd = argString(args, 'command');
    const text = resultTextOf(call, result);
    // Gate on DONE, not on text: a command that succeeds with EMPTY output
    // must not spin forever.
    const done = !!call.result || !!result;
    const parsed = useMemo(() => (done ? parseTerminalOutput(text) : null), [done, text]);
    return (
        <>
            {cmd ? <pre className="tool-cmd" dir="ltr">{cmd}</pre> : <ArgView call={call} />}
            {done ? (
                parsed ? (
                    <div className="term-out" dir="ltr">
                        {parsed.exitCode !== null && parsed.exitCode !== '0' && (
                            <span className="term-exit err" dir="ltr">
                                {t('termExitCode')}: {parsed.exitCode}
                            </span>
                        )}
                        {parsed.stdout && (
                            <>
                                <span className="step-io-tag">{t('termStdout')}</span>
                                <pre className="result-tall">{parsed.stdout}</pre>
                            </>
                        )}
                        {parsed.stderr && (
                            <>
                                <span className="step-io-tag err">{t('termStderr')}</span>
                                <pre className="result-tall term-err">{parsed.stderr}</pre>
                            </>
                        )}
                        {parsed.error && <div className="tool-note err">{parsed.error}</div>}
                    </div>
                ) : (
                    <pre className="result-tall" dir="ltr">{text}</pre>
                )
            ) : (
                <div className="tool-loading">
                    <span className="spinner" aria-hidden="true" />
                    <span>{t('toolRunning')}</span>
                </div>
            )}
        </>
    );
}

function ReadBody({ call, result }: { call: Step; result?: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    const path = argString(args, 'path');
    const paths = args && Array.isArray(args.paths)
        ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string' && !!p)
        : [];
    const text = resultTextOf(call, result);
    return (
        <>
            {path && <PathLine path={path} />}
            {paths.map((p) => <PathLine key={p} path={p} />)}
            {!path && paths.length === 0 && <ArgView call={call} />}
            {text && <pre dir="ltr">{truncateArg(text)}</pre>}
        </>
    );
}

function SearchBody({ call, result }: { call: Step; result?: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    const pattern = argString(args, 'pattern') ?? argString(args, 'query') ?? argString(args, 'name') ?? argString(args, 'symbol');
    const skip = ['pattern', 'query', 'name', 'symbol'];
    const text = resultTextOf(call, result);
    return (
        <>
            {pattern ? (
                <>
                    <pre className="tool-cmd" dir="ltr">{pattern}</pre>
                    <ScalarHints args={args} skip={skip} />
                </>
            ) : (
                <ArgView call={call} />
            )}
            {text && <pre dir="ltr">{truncateArg(text)}</pre>}
        </>
    );
}

function WebBody({ call, result }: { call: Step; result?: Step }) {
    const args = useMemo(() => parseArgs(call.text), [call.text]);
    const target = argString(args, 'url') ?? argString(args, 'query');
    const text = resultTextOf(call, result);
    return (
        <>
            {target ? <PathLine path={target} /> : <ArgView call={call} />}
            {text && <pre className="result-tall" dir="ltr">{truncateArg(text)}</pre>}
        </>
    );
}

function GenericBody({ call, result }: { call: Step; result?: Step }) {
    const text = resultTextOf(call, result);
    return (
        <>
            <ArgView call={call} />
            {text && (
                <>
                    <span className="step-io-tag">{t('resultTag')}</span>
                    <pre dir="ltr">{truncateArg(text)}</pre>
                </>
            )}
        </>
    );
}

function ToolBody({ call, result }: { call: Step; result?: Step }) {
    switch (toolFamily(call.tool)) {
        case 'edit': return <EditBody call={call} result={result} />;
        case 'terminal': return <TerminalBody call={call} result={result} />;
        case 'read': return <ReadBody call={call} result={result} />;
        case 'search': return <SearchBody call={call} result={result} />;
        case 'web': return <WebBody call={call} result={result} />;
        default: return <GenericBody call={call} result={result} />;
    }
}

/** A run of identical consecutive tool calls: one summary pill with an
 *  "×N" badge; expanding reveals each call as its own pill. */
function ToolGroupRow({ row }: { row: Extract<Row, { kind: 'toolGroup' }> }) {
    const Icon = toolIcon(row.calls[0].call.tool);
    const { fa } = toolLabel(row.calls[0].call.tool);
    const allDone = row.calls.every(toolRowDone);
    const anyFailed = row.calls.some((c) => toolRowFailed(c.call, c.result));
    return (
        <details className={`step${allDone ? '' : ' running'}${anyFailed ? ' group-fail' : ''}`}>
            <summary>
                <Icon size={13} className="step-icon" />
                <span className="step-label" dir={fa === row.calls[0].call.tool ? 'ltr' : undefined}>
                    {fa}
                </span>
                {anyFailed ? (
                    <X size={13} className="step-status err" />
                ) : allDone ? (
                    <Check size={13} className="step-status ok" />
                ) : (
                    <span className="step-status spinner" aria-hidden="true" />
                )}
                <span className="step-count" dir="ltr">×{row.calls.length}</span>
                <ChevronDown size={13} className="step-chev" />
            </summary>
            <div className="step-group-body">
                {row.calls.map((c) => (
                    <ActivityRow key={c.key} row={{ ...c, kind: 'tool' }} running={false} isLast={false} />
                ))}
            </div>
        </details>
    );
}

function ActivityRow({ row, running, isLast }: { row: Exclude<Row, { kind: 'toolGroup' | 'text' | 'taskList' }>; running: boolean; isLast: boolean }) {
    const active = running && isLast;
    // Hooks BEFORE the thinking early-return: this component renders both
    // thinking and tool rows, so hook order must stay unconditional.
    const family = toolFamily(row.kind === 'thinking' ? undefined : row.call.tool);
    // Controlled open: edit/terminal start expanded; the user's collapse
    // survives streaming re-renders (MessageItem is memoized, but result
    // arrivals still re-render rows).
    const [open, setOpen] = useState(() => DEFAULT_OPEN_FAMILIES.includes(family));
    // Thinking pill: while streaming and OPEN, its scrollable body follows
    // the newest thinking lines - but ONLY while the reader is pinned to
    // the bottom; a manual scroll-up inside the pill is never yanked back.
    const thinkRef = useRef<HTMLElement | null>(null);
    const thinkPinned = useRef(true);
    const [thinkOpen, setThinkOpen] = useState(false);
    const thinkText = row.kind === 'thinking' ? row.step.text : '';
    useEffect(() => {
        const el = thinkRef.current;
        if (active && thinkOpen && el && thinkPinned.current) el.scrollTop = el.scrollHeight;
    }, [active, thinkOpen, thinkText]);
    const onThinkScroll = () => {
        const el = thinkRef.current;
        if (el) thinkPinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };

    if (row.kind === 'thinking') {
        const dur = fmtDur((row.step.endedAt ?? 0) - (row.step.startedAt ?? 0));
        return (
            <details
                className="step"
                open={thinkOpen}
                onToggle={(e) => setThinkOpen(e.currentTarget.open)}
            >
                <summary>
                    <Brain size={13} className="step-icon" />
                    <span className="step-label">{active ? t('thinkingActive') : t('thinkingDone')}</span>
                    {!active && dur && <span className="step-dur">{dur}</span>}
                    {active && <span className="step-status spinner" aria-hidden="true" />}
                    <ChevronDown size={13} className="step-chev" />
                </summary>
                {row.step.html ? (
                    <div
                        ref={(el) => { thinkRef.current = el; }}
                        onScroll={onThinkScroll}
                        className="step-think-body"
                    >
                        <RenderedMarkdown html={row.step.html} streaming={active} />
                    </div>
                ) : (
                    <pre
                        ref={(el) => { thinkRef.current = el; }}
                        onScroll={onThinkScroll}
                        dir="ltr"
                    >{row.step.text}</pre>
                )}
            </details>
        );
    }

    // Failed calls render as a RED pill but stay expandable: the error text
    // (and the offending args/patch) is exactly what the user needs to see.
    const failed = toolRowFailed(row.call, row.result);
    const Icon = toolIcon(row.call.tool);
    const { fa } = toolLabel(row.call.tool);
    const done = toolRowDone(row);
    return (
        <details
            className={`step${done ? '' : ' running'}${failed ? ' fail' : ''}`}
            open={open}
            onToggle={(e) => setOpen(e.currentTarget.open)}
        >
            <summary>
                <Icon size={13} className="step-icon" />
                <span className="step-label" dir={fa === row.call.tool ? 'ltr' : undefined}>
                    {fa}
                </span>
                {done ? (
                    failed ? (
                        <X size={13} className="step-status err" />
                    ) : (
                        <Check size={13} className="step-status ok" />
                    )
                ) : (
                    <span className="step-status spinner" aria-hidden="true" />
                )}
                <ChevronDown size={13} className="step-chev" />
            </summary>
            <div className="step-body">
                <ToolBody call={row.call} result={row.result} />
            </div>
        </details>
    );
}

/** Interactive surface for the CURRENT update_task_list step: host-echoed
 *  (user-edited) list, status toggles, inline label edit, add/remove/reorder.
 *  Older list steps render read-only from their own args; malformed args
 *  fall back to the plain tool pill. */
export interface TaskListView {
    stepId: string;
    tasks: TaskListItem[];
    editable: boolean;
    onChange?: (tasks: TaskListItem[]) => void;
}

const TASK_LIST_MAX_ITEMS = 100;
const TASK_LIST_MAX_LABEL = 500;
/** Min ms between live-preview swaps - stops boundary flicker from firing
 *  back-to-back reorders when the cursor sits between two rows. */
const TASK_SWAP_COOLDOWN_MS = 120;

/** Shared interactive checklist body: status toggles, inline label edit,
 *  add/remove/reorder. Rendered inside the message-body TaskListRow AND the
 *  header progress chip's dropdown; read-only when editable is false. */
export function TaskListEditor({ tasks, editable, onChange }: { tasks: TaskListItem[]; editable: boolean; onChange?: (tasks: TaskListItem[]) => void }) {
    const [editingIdx, setEditingIdx] = useState<number | null>(null);
    const [draft, setDraft] = useState('');
    const [adding, setAdding] = useState(false);
    const [addDraft, setAddDraft] = useState('');
    // Drag-to-reorder with LIVE preview: while dragging, rows reorder in
    // real time (preview holds the shuffled order, dragIdx tracks the dragged
    // row's CURRENT index); the order commits only on drop. dragend without
    // a drop discards the preview. Only set states when the target index
    // changes so continuous dragover events don't re-render.
    const [dragIdx, setDragIdx] = useState<number | null>(null);
    const [preview, setPreview] = useState<TaskListItem[] | null>(null);
    const shown = preview ?? tasks;
    const lastSwapAt = useRef(0);

    // Stable row keys (by object identity): the DOM rows physically MOVE on
    // reorder, so status highlights travel with their row and FLIP can
    // animate the shuffle. Identity survives the drag (preview splices keep
    // item references); host echoes replace objects, but never mid-drag.
    const keySeq = useRef(0);
    const keyMap = useRef(new WeakMap<object, number>());
    const keyOf = (item: TaskListItem) => {
        let k = keyMap.current.get(item);
        if (k === undefined) {
            k = ++keySeq.current;
            keyMap.current.set(item, k);
        }
        return k;
    };

    // FLIP animation, active ONLY while a drag is in progress (any other
    // re-render just re-measures): each row whose layout position changed
    // since the previous render is transformed back to its old spot and
    // transitions to rest. Stale rAFs are cancelled per row so rapid
    // consecutive swaps can't fight each other mid-transition; offsetTop is
    // used for measuring because it ignores the transform itself.
    const listRef = useRef<HTMLOListElement | null>(null);
    const prevTops = useRef(new Map<number, number>());
    const animRafs = useRef(new Map<number, number>());
    useIsoLayoutEffect(() => {
        const list = listRef.current;
        if (!list) return;
        const animating = dragIdx != null;
        for (const row of Array.from(list.children) as HTMLElement[]) {
            const key = Number(row.dataset.key);
            const top = row.offsetTop;
            const prevTop = prevTops.current.get(key);
            if (animating && prevTop !== undefined && Math.abs(prevTop - top) > 1) {
                const staleRaf = animRafs.current.get(key);
                if (staleRaf !== undefined) cancelAnimationFrame(staleRaf);
                const dy = prevTop - top;
                row.style.transition = 'none';
                row.style.transform = `translateY(${dy}px)`;
                const raf = requestAnimationFrame(() => {
                    animRafs.current.delete(key);
                    row.style.transition = 'transform 0.15s ease';
                    row.style.transform = '';
                });
                animRafs.current.set(key, raf);
            }
            prevTops.current.set(key, top);
        }
    });

    const commit = editable ? onChange : undefined;

    const setStatus = (i: number, status: TaskListStatus) => {
        if (!commit) return;
        const next = shown.map((t, j) => (j === i ? { ...t, status } : t));
        commit(next);
    };
    const saveLabel = (i: number) => {
        const clean = draft.trim().slice(0, TASK_LIST_MAX_LABEL);
        setEditingIdx(null);
        if (commit && clean && clean !== shown[i].label) {
            commit(shown.map((t, j) => (j === i ? { ...t, label: clean } : t)));
        }
    };
    const endDrag = () => {
        setDragIdx(null);
        setPreview(null);
        lastSwapAt.current = 0;
    };
    // Live-preview move to a SLOT (0..n): slot s = "above row s" - the top
    // half of row i maps to slot i, its bottom half to slot i+1, so holding
    // the cursor on a boundary between two rows resolves to ONE slot from
    // both sides and can't oscillate. The dragged item ends up at index
    // target = (dragIdx < s ? s - 1 : s); when that equals its current index
    // the swap is a no-op.
    const previewMoveToSlot = (slot: number) => {
        if (dragIdx == null || slot < 0 || slot > shown.length) return;
        const target = dragIdx < slot ? slot - 1 : slot;
        if (target === dragIdx) return;
        const now = performance.now();
        if (now - lastSwapAt.current < TASK_SWAP_COOLDOWN_MS) return;
        lastSwapAt.current = now;
        const next = [...shown];
        const [moved] = next.splice(dragIdx, 1);
        next.splice(target, 0, moved);
        setPreview(next);
        setDragIdx(target);
    };
    const remove = (i: number) => {
        if (!commit || shown.length <= 1) return;
        commit(shown.filter((_, j) => j !== i));
    };
    const addItem = () => {
        const clean = addDraft.trim().slice(0, TASK_LIST_MAX_LABEL);
        if (!commit || !clean || shown.length >= TASK_LIST_MAX_ITEMS) return;
        setAddDraft('');
        setAdding(false);
        commit([...shown, { label: clean, status: 'pending' }]);
    };

    return (
        <>
            <ol
                ref={listRef}
                className="task-list-items"
                aria-label={t('taskListItemsAria')}
                onDragOver={(e) => {
                    if (dragIdx == null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    previewMoveToSlot(shown.length);
                }}
                onDrop={(e) => {
                    if (dragIdx == null || !commit) return;
                    e.preventDefault();
                    commit(shown);
                    endDrag();
                }}
            >
                {shown.map((item, i) => (
                    <li
                        key={keyOf(item)}
                        data-key={keyOf(item)}
                        className={`task-list-item ${item.status}`}
                        onDragOver={(e) => {
                            if (dragIdx == null) return;
                            e.preventDefault();
                            e.stopPropagation();
                            e.dataTransfer.dropEffect = 'move';
                            const rect = e.currentTarget.getBoundingClientRect();
                            previewMoveToSlot(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                        }}
                        onDrop={(e) => {
                            if (dragIdx == null || !commit) return;
                            e.preventDefault();
                            e.stopPropagation();
                            commit(shown);
                            endDrag();
                        }}
                    >
                        <button
                            type="button"
                            className="task-list-check"
                            disabled={!editable}
                            aria-label={item.status === 'completed' ? t('taskListMarkPending') : t('taskListMarkDone')}
                            onClick={() => setStatus(i, item.status === 'completed' ? 'pending' : 'completed')}
                        >
                            {item.status === 'completed' && <Check size={12} />}
                        </button>
                        {editingIdx === i ? (
                            <input
                                className="task-list-edit-input"
                                value={draft}
                                autoFocus
                                dir="auto"
                                maxLength={TASK_LIST_MAX_LABEL}
                                aria-label={t('taskListEditAria')}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={() => saveLabel(i)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        saveLabel(i);
                                    } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        setEditingIdx(null);
                                    }
                                }}
                            />
                        ) : (
                            <span
                                className="task-list-label"
                                dir="auto"
                                onDoubleClick={editable ? () => { setDraft(item.label); setEditingIdx(i); } : undefined}
                            >
                                {item.label}
                            </span>
                        )}
                        {editable && editingIdx !== i && (
                            <span className="task-list-controls">
                                {item.status !== 'completed' && (
                                    <button
                                        type="button"
                                        className={`task-list-mini${item.status === 'in_progress' ? ' active' : ''}`}
                                        aria-label={t('taskListMarkCurrent')}
                                        title={t('taskListMarkCurrent')}
                                        onClick={() => setStatus(i, item.status === 'in_progress' ? 'pending' : 'in_progress')}
                                    >
                                        <CircleDot size={12} />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="task-list-mini task-list-drag-handle"
                                    aria-label={t('taskListReorderAria')}
                                    title={t('taskListReorderAria')}
                                    draggable={editable}
                                    onDragStart={(e) => {
                                        if (!editable) return;
                                        setDragIdx(i);
                                        e.dataTransfer.effectAllowed = 'move';
                                        e.dataTransfer.setData('text/plain', String(i));
                                    }}
                                    onDragEnd={endDrag}
                                >
                                    <GripVertical size={12} />
                                </button>
                                <button type="button" className="task-list-mini" aria-label={t('taskListEditAria')} title={t('taskListEditAria')}
                                    onClick={() => { setDraft(item.label); setEditingIdx(i); }}>
                                    <PencilLine size={12} />
                                </button>
                                <button type="button" className="task-list-mini danger" aria-label={t('taskListRemoveAria')} title={t('taskListRemoveAria')} disabled={shown.length <= 1}
                                    onClick={() => remove(i)}>
                                    <Trash2 size={12} />
                                </button>
                            </span>
                        )}
                    </li>
                ))}
            </ol>
            {editable && (adding ? (
                <div className="task-list-add">
                    <input
                        className="task-list-edit-input"
                        value={addDraft}
                        autoFocus
                        dir="auto"
                        maxLength={TASK_LIST_MAX_LABEL}
                        placeholder={t('taskListPlaceholder')}
                        aria-label={t('taskListAddItemAria')}
                        onChange={(e) => setAddDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                addItem();
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setAdding(false);
                                setAddDraft('');
                            }
                        }}
                    />
                    <button type="button" className="task-list-mini" aria-label={t('taskListAddItemAria')} disabled={!addDraft.trim()} onClick={addItem}>
                        <Plus size={12} />
                    </button>
                    <button type="button" className="task-list-mini" aria-label={t('editCancel')} onClick={() => { setAdding(false); setAddDraft(''); }}>
                        <X size={12} />
                    </button>
                </div>
            ) : (
                <button type="button" className="task-list-add-btn" onClick={() => setAdding(true)} disabled={tasks.length >= TASK_LIST_MAX_ITEMS}>
                    <Plus size={12} />
                    {t('taskListAddItem')}
                </button>
            ))}
        </>
    );
}

function TaskListRow({ row, view, streaming }: { row: Extract<Row, { kind: 'taskList' }>; view?: TaskListView; streaming: boolean }) {
    const isCurrent = !!view && view.stepId === row.step.id;
    const tasks = isCurrent ? view!.tasks : parseTaskListStep(row.step.text);

    if (!tasks) {
        return <ActivityRow row={{ key: row.key, kind: 'tool', call: row.step }} running={false} isLast={false} />;
    }

    // Null-safe: rows that are NOT the bound step render read-only from
    // their own args (view may be undefined here - any well-formed older
    // task-list step in a message without the interactive prop).
    const editable = isCurrent && !!view && view.editable && !!view.onChange && !streaming;

    // Bare inline checklist - NO pill chrome (hidden update_task_list pill):
    // icon + progress + spinner head, then the editor, directly on the
    // bubble background. No expand/collapse at all.
    return (
        <div className="task-list-inline" id={isCurrent ? 'xratu-task-list' : undefined}>
            <div className="task-list-inline-head">
                <ListChecks size={13} className="step-icon" />
                {!row.step.result ? (
                    <span className="step-status spinner" aria-hidden="true" />
                ) : (
                    <Check size={13} className="step-status ok" />
                )}
                <span className="task-list-progress" dir="ltr" title={t('taskListTitle')}>
                    {tasks.filter((task) => task.status === 'completed').length}/{tasks.length}
                </span>
            </div>
            <TaskListEditor tasks={tasks} editable={editable} onChange={view?.onChange} />
        </div>
    );
}

/** Streamed AI text segments living INSIDE the pill timeline. Consecutive
 *  fragments merge into one flowing block: when every fragment carries its
 *  host-rendered markdown the htmls CONCATENATE into one .msg-content, so a
 *  fragment boundary renders exactly like a paragraph break (identical to
 *  the single-render layout a reload produces). Raw fallback renders the
 *  texts sequentially while markdown hasn't landed yet. Never deleted by
 *  the final response. */
function TextSegmentRow({ steps, streaming }: { steps: Step[]; streaming: boolean }) {
    const allHtml = steps.every((s) => s.html);
    if (allHtml) {
        return <RenderedMarkdown html={steps.map((s) => s.html as string).join('')} streaming={streaming} />;
    }
    return (
        <div className={`step-text-seg${streaming ? ' streaming' : ''}`} dir="auto">
            {steps.map((step) =>
                step.html ? (
                    <RenderedMarkdown key={step.id} html={step.html} streaming={streaming} />
                ) : (
                    <span key={step.id}>{step.text}</span>
                )
            )}
        </div>
    );
}

interface DiffLine {
    kind: 'add' | 'del' | 'ctx';
    text: string;
    oldNo?: number;
    newNo?: number;
}

function parseDiffLines(lines: string[]): DiffLine[] {
    let oldNo = 0;
    let newNo = 0;
    const out: DiffLine[] = [];

    for (const line of lines) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            oldNo = Number(hunk[1]);
            newNo = Number(hunk[2]);
            continue;
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            out.push({ kind: 'add', text: line.slice(1), newNo });
            newNo += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            out.push({ kind: 'del', text: line.slice(1), oldNo });
            oldNo += 1;
        } else {
            out.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo, newNo });
            oldNo += 1;
            newNo += 1;
        }
    }

    return out;
}

function fileName(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').pop() || path;
}

function changeSummary(item: import('../types').ApprovalItem): string {
    const args = item.args && typeof item.args === 'object' ? item.args as Record<string, unknown> : {};
    const tool = item.tool_name.toLowerCase();
    const path = typeof args.path === 'string' ? args.path : '';
    if (/delete_file|remove_file/.test(tool)) return t('approvalDeleteFile');
    if (/create_file|write_file/.test(tool)) return t('approvalCreateFile');
    if (/edit|replace|patch/.test(tool)) return t('approvalModifyFile');
    if (/terminal|command|shell/.test(tool)) return t('approvalRunCommand');
    if (path) return t('approvalModifyFile');
    return toolLabel(item.tool_name).fa;
}

function extToLang(file: string): string {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
        c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
        rb: 'ruby', php: 'php', swift: 'swift', scala: 'scala',
        html: 'html', css: 'css', scss: 'scss', json: 'json',
        yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
        md: 'markdown', sh: 'bash', bash: 'bash', sql: 'sql',
        vue: 'vue', svelte: 'svelte',
    };
    return map[ext] ?? 'text';
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}


/** Pure-JS regex engine: the webview CSP has no 'wasm-unsafe-eval', so the
 *  default oniguruma (WASM) engine silently fails and every highlighted
 *  block fell back to white text. `forgiving` skips the few grammars whose
 *  patterns the JS engine can't express - display-only highlighting. */
const SHIKI_ENGINE = createJavaScriptRegexEngine({ forgiving: true });

/** Catppuccin Mocha - soft pastel token palette (lavender keywords, blue
 *  functions, peach params) on a dark base; flashy but easy on the eyes. */
const SHIKI_THEME = 'catppuccin-mocha';

function useHighlightedCode(code: string, lang: string): string[] {
    const [highlighted, setHighlighted] = useState<string[]>([]);
    useEffect(() => {
        if (!code || lang === 'text') {
            setHighlighted([]);
            return;
        }
        let cancelled = false;
        getSingletonHighlighter({
            themes: [SHIKI_THEME],
            langs: [lang === 'text' ? 'plaintext' : lang],
            engine: SHIKI_ENGINE,
        }).then((h) => {
            if (cancelled) return;
            const html = h.codeToHtml(code, { lang, theme: SHIKI_THEME });
            const match = html.match(/<code>([\s\S]*?)<\/code>/);
            if (!match) {
                setHighlighted([]);
                return;
            }
            const inner = match[1]
                .replace(/<span class="line">/g, '')
                .replace(/<\/span>\s*(?=<span class="line">|$)/g, '');
            setHighlighted(inner.split('\n'));
        }).catch(() => {
            if (!cancelled) setHighlighted([]);
        });
        return () => { cancelled = true; };
    }, [code, lang]);
    return highlighted;
}

function ApprovalDiffView({ diff }: { diff: NonNullable<import('../types').ApprovalItem['diff']> }) {
    const parsed = useMemo(() => parseDiffLines(diff.lines), [diff.lines]);
    const newCode = useMemo(
        () => parsed.filter((l) => l.kind !== 'del').map((l) => l.text).join('\n'),
        [parsed]
    );
    const highlighted = useHighlightedCode(newCode, extToLang(diff.file));
    let hiIdx = 0;
    return (
        <div className="approval-diff-wrap" dir="ltr">
            <table className="approval-diff" role="img" aria-label={`${diff.file}: +${diff.added} -${diff.removed}`}>
                <tbody>
                    {parsed.map((line, i) => {
                        const hi = line.kind !== 'del' ? highlighted[hiIdx++] : '';
                        return (
                            <tr key={i} className={`diff-row diff-${line.kind}`}>
                                <td className="diff-no diff-no-old">{line.oldNo ?? ''}</td>
                                <td className="diff-no diff-no-new">{line.newNo ?? ''}</td>
                                <td className="diff-mark">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</td>
                                {/* When shiki highlighting is absent (unmapped
                                    extension, pre-async first render, or on
                                    any failure) the raw file text must be
                                    ESCAPED - it is model-controlled and
                                    dangerouslySetInnerHTML would otherwise
                                    inject it verbatim. */}
                                <td
                                    className="diff-code"
                                    dangerouslySetInnerHTML={{ __html: hi || escapeHtml(line.text) || '&nbsp;' }}
                                />
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function ApprovalActionPreview({ item }: { item: import('../types').ApprovalItem }) {
    const args = item.args && typeof item.args === 'object' ? item.args as Record<string, unknown> : {};
    const command = typeof args.command === 'string'
        ? args.command
        : typeof args.cmd === 'string'
            ? args.cmd
            : null;
    const path = typeof args.path === 'string' ? args.path : null;

    return (
        <div className="approval-action-preview" dir="ltr">
            <div className="approval-action-label">{changeSummary(item)}</div>
            {path && <code className="approval-action-path">{path}</code>}
            {command && <pre>{command}</pre>}
            {!path && !command && (
                <pre>{JSON.stringify(args, null, 2).slice(0, 900)}</pre>
            )}
        </div>
    );
}

function ApprovalCard({
    payload,
    onDecide,
}: {
    payload: ApprovalPayload;
    onDecide?: (id: string, d: Record<string, boolean>, sessionApprove?: boolean) => void;
}) {
    const preDenied = payload.preDenied ?? {};
    const approvable = payload.approvals.filter((a) => preDenied[a.tool_call_id] !== false);
    const resolution = payload.resolution;
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (resolution) setSubmitting(false);
    }, [resolution]);

    const decide = (approve: boolean, sessionApprove = false) => {
        if (submitting || resolution) return;
        setSubmitting(true);
        const decisions: Record<string, boolean> = { ...preDenied };
        for (const a of payload.approvals) {
            decisions[a.tool_call_id] = approve && preDenied[a.tool_call_id] !== false;
        }
        onDecide?.(payload.approval_id, decisions, sessionApprove || undefined);
    };

    const totalAdded = payload.approvals.reduce((n, a) => n + (a.diff?.added ?? 0), 0);
    const totalRemoved = payload.approvals.reduce((n, a) => n + (a.diff?.removed ?? 0), 0);
    const fileCount = payload.approvals.filter((a) => a.diff).length;
    const isTerminal = payload.approvals.every((a) => /terminal|command|shell/.test(a.tool_name));

    const isResolved = !!resolution;
    const title = resolution === 'approved'
        ? isTerminal ? t('approvalCommandApproved') : t('approvalApproved')
        : resolution === 'rejected'
            ? isTerminal ? t('approvalCommandRejected') : t('approvalRejected')
            : resolution === 'mixed'
                ? t('approvalMixed')
                : t('approvalHead');

    return (
        <section className={`approval-card${isResolved ? ' resolved' : ' pending'}`} aria-label={title}>
            <div className="approval-head">
                <div className="approval-head-left">
                    <span className={`approval-state-icon ${isResolved ? 'resolved' : ''}`}>
                        {resolution === 'approved' ? <Check size={14} /> : resolution === 'rejected' ? <X size={14} /> : <ShieldCheck size={14} />}
                    </span>
                    <div className="approval-heading-copy">
                        <strong>{title}</strong>
                    </div>
                </div>
                {!isResolved && (fileCount > 0 || totalAdded || totalRemoved) && (
                    <span className="approval-header-stats" dir="ltr">
                        <span>{fileCount} {t('approvalFiles')}</span>
                        <span className="approval-stat add">+{totalAdded}</span>
                        <span className="approval-stat del">−{totalRemoved}</span>
                    </span>
                )}
            </div>

            <div className="approval-items">
                {payload.approvals.map((a, index) => {
                    const deniedUpFront = preDenied[a.tool_call_id] === false;
                    const Icon = toolIcon(a.tool_name);
                    const hasDiff = !!a.diff;
                    const path = a.diff?.file ?? (typeof a.args?.path === 'string' ? a.args.path : '');
                    return (
                        <details
                            key={a.tool_call_id}
                            className={`approval-item${hasDiff ? ' has-diff' : ''}`}
                            open={false}
                        >
                            <summary>
                                <span className="approval-file-icon"><Icon size={13} /></span>
                                <span className="approval-file-copy">
                                    <span className="approval-file-name">{path ? fileName(path) : changeSummary(a)}</span>
                                    {path && <span className="approval-file-path">{path}</span>}
                                </span>
                                {a.diff ? (
                                    <span className="approval-file-stats" dir="ltr">
                                        <span className="add">+{a.diff.added}</span>
                                        <span className="del">−{a.diff.removed}</span>
                                    </span>
                                ) : (
                                    <span className="approval-tool-mini" dir="ltr">{toolLabel(a.tool_name).fa}</span>
                                )}
                                {deniedUpFront && <span className="approval-denied-tag">{t('preDeniedTag')}</span>}
                                <ChevronDown size={13} className="approval-item-chevron" />
                            </summary>
                            <div className="approval-item-body">
                                {a.diff ? <ApprovalDiffView diff={a.diff} /> : <ApprovalActionPreview item={a} />}
                            </div>
                        </details>
                    );
                })}
            </div>

            {!isResolved && (
                <div className="approval-actions">
                    <button type="button" className="deny-btn" onClick={() => decide(false)} disabled={submitting}>
                        <X size={13} />
                        {t('denyAll')}
                    </button>
                    <button
                        type="button"
                        className="session-allow-btn"
                        onClick={() => decide(true, true)}
                        disabled={submitting || approvable.length === 0}
                        title={t('approveSessionHint')}
                    >
                        <Clock size={13} />
                        {t('approveSession')}
                    </button>
                    <button type="button" className="apply-btn" onClick={() => decide(true)} disabled={submitting || approvable.length === 0}>
                        {submitting ? <span className="step-status spinner" /> : <Check size={13} />}
                        {submitting ? t('approvalApplying') : t('approve')}
                    </button>
                </div>
            )}

            {resolution && resolution !== 'approved' && (
                <div className={`approval-resolution ${resolution}`} dir="auto">
                    {resolution === 'rejected' ? t('approvalDenied') :
                        t('approvalMixedDone')}
                </div>
            )}
        </section>
    );
}

function MessageItemImpl({ message, onApprovalDecision, onRegenerate, onEditMessage, userIndex, isLastAssistant, busy, conn, taskList }: MessageItemProps) {
    const { role, status, renderedHtml, text, steps, tone, attachments } = message;
    const approvalPending = !!message.approval && !message.approval.resolution;
    const approvalResolved = !!message.approval?.resolution;
    const [copied, setCopied] = useState(false);

    const bubbleClass = ['msg', role, tone ?? '', status === 'error' ? 'error' : '', conn ? `conn-${conn}` : '', message.steered ? 'steered' : '']
        .filter(Boolean)
        .join(' ');

    const isTyping = status === 'streaming' && role === 'assistant' && !renderedHtml && !text && steps.length === 0 && !message.retryStatus;
    const isSystem = role === 'system';

    const rows = useMemo(() => buildRows(steps), [steps]);

    // Text segments vs. action pills: with pills present, text interleaves
    // INSIDE the timeline (chronological); without, text segments ARE the
    // message body and render in the normal content slot.
    const hasPills = rows.some((r) => r.kind !== 'text');
    const textRows = rows.filter((r): r is Extract<Row, { kind: 'text' }> => r.kind === 'text');

    // Keep a visible heartbeat whenever the run is live but NO row is spinning
    // (e.g. between a finished tool call and the next reasoning deltas) - the
    // agent must never look stalled while it is still working. A trailing
    // text segment is its own progress signal (it grows live), so no extra
    // "working" row on top of it.
    const lastRow = rows[rows.length - 1];
    const lastRowSpins =
        status === 'streaming' &&
        !approvalPending &&
        !!lastRow &&
        lastRow.kind !== 'text' &&
        (lastRow.kind === 'thinking' ||
            (lastRow.kind === 'toolGroup'
                ? lastRow.calls.some((c) => !toolRowDone(c))
                : lastRow.kind === 'tool' && !toolRowDone(lastRow)));
    const showWorking = status === 'streaming' && role === 'assistant' && !approvalPending && rows.length > 0 && !lastRowSpins && lastRow?.kind !== 'text';

    const showFooter = role === 'assistant' && status === 'done' && !!(renderedHtml || text);
    // Regenerate lives where the old global checkpoint-revert button was:
    // last completed assistant turn only, never while a run is in flight.
    const showRegenerate =
        role === 'assistant' && isLastAssistant && status === 'done' && !busy && !!onRegenerate;

    // User bubbles carry their own footer from the moment they appear; the
    // pencil is the ONLY part that hides while a run is in flight.
    const showUserFooter = role === 'user' && status === 'done';
    const showEditBtn =
        showUserFooter && !busy && userIndex !== undefined && !!onEditMessage;

    const copyAnswer = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard unavailable */
        }
    };

    if (isSystem && message.approval) {
        return (
            <article className={bubbleClass} dir="auto">
                <ApprovalCard payload={message.approval} onDecide={onApprovalDecision} />
            </article>
        );
    }

    const streamingContent = status === 'streaming' && role === 'assistant' && !approvalPending && !approvalResolved;

    return (
        <article
            className={`${bubbleClass}${approvalPending ? ' approval-paused' : ''}`}
            /* dir="auto" resolves to LTR while only the typing dots render
               (no text for the first-strong heuristic) - pin to the app
               locale direction so the indicator follows Farsi bubbles. */
            dir={isTyping ? (getLocale() === 'fa' ? 'rtl' : 'ltr') : 'auto'}
            aria-busy={status === 'streaming' && !approvalPending}
        >
            {!isSystem && hasPills && (
                <div className="steps" aria-label={t('stepsAria')}>
                    {rows.map((row) =>
                        row.kind === 'toolGroup' ? (
                            <ToolGroupRow key={row.key} row={row} />
                        ) : row.kind === 'text' ? (
                            <TextSegmentRow key={row.key} steps={row.steps} streaming={streamingContent} />
                        ) : row.kind === 'taskList' ? (
                            <TaskListRow key={row.key} row={row} view={taskList} streaming={streamingContent} />
                        ) : (
                            <ActivityRow key={row.key} row={row} running={status === 'streaming' && !approvalPending} isLast={row === lastRow} />
                        )
                    )}
                    {showWorking && (
                        <div className="working-row" aria-label={t('working')}>
                            <span className="step-status spinner" aria-hidden="true" />
                            <span>{t('working')}</span>
                        </div>
                    )}
                </div>
            )}

            {role === 'user' && message.steered && (
                <div className="msg-steered-badge" title={t('steeredBadge')}>
                    <CornerDownRight size={11} aria-hidden="true" />
                    <span>{t('steeredBadge')}</span>
                </div>
            )}

            {role === 'user' && attachments && attachments.length > 0 && (
                <div className="message-attachments" aria-label={t('attachmentsLabel')}>
                    {attachments.map((attachment, index) => (
                        attachment.previewDataUrl ? (
                            <figure className="message-attachment-image" key={`${attachment.name}-${index}`}>
                                <img
                                    src={attachment.previewDataUrl}
                                    alt={attachment.name}
                                    loading="lazy"
                                />
                                <figcaption>
                                    <ImageIcon size={11} aria-hidden="true" />
                                    <span dir="ltr">{attachment.name}</span>
                                </figcaption>
                            </figure>
                        ) : (
                            <div className="message-attachment-file" key={`${attachment.name}-${index}`}>
                                <span className="message-attachment-file-icon"><Paperclip size={12} aria-hidden="true" /></span>
                                <span dir="ltr">{attachment.name}</span>
                            </div>
                        )
                    ))}
                </div>
            )}

            {textRows.length > 0 ? (
                hasPills ? null : (
                    <>
                        {textRows.map((r) =>
                            r.steps.every((s) => s.html) ? (
                                <RenderedMarkdown key={r.key} html={r.steps.map((s) => s.html as string).join('')} streaming={streamingContent} />
                            ) : (
                                <div key={r.key} className={`msg-content msg-text${streamingContent ? ' streaming' : ''}`}>
                                    {r.steps.map((s) => s.text).join('\n')}
                                </div>
                            )
                        )}
                    </>
                )
            ) : renderedHtml ? (
                <RenderedMarkdown html={renderedHtml} streaming={streamingContent} />
            ) : isTyping ? (
                <div className={`msg-content typing${message.retryStatus ? ' retrying' : ''}`} aria-label={t('typingAria')}>
                    <span className="dot" />
                    <span className="dot" />
                    <span className="dot" />
                </div>
            ) : message.retryStatus ? (
                <RetryCountdown retryStatus={message.retryStatus} />
            ) : text ? (
                <div className={`msg-content msg-text${streamingContent ? ' streaming' : ''}`}>
                    {text}
                </div>
            ) : null}

            {message.errorText && (
                <div className="msg-error-text" role="alert">
                    <TriangleAlert size={12} />
                    <span dir="auto">{message.errorText}</span>
                </div>
            )}

            {message.approval && (
                <ApprovalCard payload={message.approval} onDecide={onApprovalDecision} />
            )}

            {approvalPending && (
                <div className="approval-waiting-row" aria-live="polite">
                    <span className="approval-waiting-dot" aria-hidden="true" />
                    <span>{t('approvalWaitingAi')}</span>
                </div>
            )}

            {showFooter && (
                <div className="msg-footer">
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={copyAnswer}
                        aria-label={t('copyMsg')}
                        title={t('copyMsg')}
                    >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    {showRegenerate && (
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={onRegenerate}
                            aria-label={t('regenerateAria')}
                            title={t('regenerateAria')}
                        >
                            <RefreshCw size={13} />
                        </button>
                    )}
                    {message.usage && (
                        <span className="msg-meta" dir="ltr" title={t('tokensTitle')}>
                            ↑ {fmtTok(message.usage.input_tokens)} ↓ {fmtTok(message.usage.output_tokens)}
                        </span>
                    )}
                    <span className="msg-meta">
                        {copied ? t('copiedMsg') : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>
            )}

            {showUserFooter && (
                <div className="msg-footer">
                    <button
                        type="button"
                        className="icon-btn"
                        onClick={copyAnswer}
                        aria-label={t('copyMsg')}
                        title={t('copyMsg')}
                    >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    {showEditBtn && (
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={() => onEditMessage?.(userIndex ?? -1, text)}
                            aria-label={t('editMsg')}
                            title={t('editRewindHint')}
                        >
                            <PencilLine size={13} />
                        </button>
                    )}
                    <span className="msg-meta">
                        {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>
            )}
        </article>
    );
}

interface MessageItemProps {
    message: ChatMessage;
    onApprovalDecision?: (approvalId: string, decisions: Record<string, boolean>, sessionApprove?: boolean) => void;
    /** Regenerate the last exchange (replaces the old checkpoint button). */
    onRegenerate?: () => void;
    /** Load a user message into the composer card for editing; sending from
     *  the composer rewinds workspace + history and resends (with any
     *  freshly attached files). */
    onEditMessage?: (userIndex: number, value: string) => void;
    /** 0-based index among USER messages; undefined for non-user bubbles. */
    userIndex?: number;
    isLastAssistant?: boolean;
    /** A run is in flight - footer actions are hidden while true. */
    busy?: boolean;
    /** Connection status - drives corner-bracket color on bubbles. */
    conn?: ConnectionStatus;
    /** Interactive task-list view for the CURRENT update_task_list step
     *  (host-echoed list + edit handler); undefined = all checklists
     *  render read-only from their own args. */
    taskList?: TaskListView;
}

/**
 * Memoized: streaming updates append chunks to ONE message dozens of times
 * per second; without this every bubble (and its <details> pills) re-renders
 * each time, which is exactly when expansion feels like tearing.
 */
export const MessageItem = memo(MessageItemImpl, (a, b) =>
    a.message === b.message &&
    a.onApprovalDecision === b.onApprovalDecision &&
    a.onRegenerate === b.onRegenerate &&
    a.onEditMessage === b.onEditMessage &&
    a.userIndex === b.userIndex &&
    a.isLastAssistant === b.isLastAssistant &&
    a.busy === b.busy &&
    a.conn === b.conn &&
    a.taskList === b.taskList
);

/**
 * Session task list ("the list IS the plan") - shared between the expansion
 * tool executor (xratu_mcp_tools.ts), the host (extension.ts) and the local
 * runtime. The list itself travels in the tool call ARGS (persisted, replayed
 * and parsed by both the webview and the backend); the tool's result is only
 * a short ack. Full-replacement protocol: every call replaces the whole list.
 */

export const TASK_LIST_TOOL_NAME = 'update_task_list';
export const TASK_LIST_MAX_ITEMS = 100;
export const TASK_LIST_MAX_LABEL = 500;

export const TASK_LIST_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

export interface TaskListItem {
    label: string;
    status: TaskListStatus;
}

/** Item shapes seen in the wild: the schema field is `label`, but weak
 *  models emit `task`, `content` or `step` (observed live: Terminal Game
 *  sent `task` on its first write). Accept them all, read-only alias. */
export const TASK_LIST_LABEL_KEYS = ['label', 'task', 'content', 'step'] as const;

export function taskListLabelOf(entry: object): unknown {
    for (const key of TASK_LIST_LABEL_KEYS) {
        const v = (entry as Record<string, unknown>)[key];
        if (typeof v === 'string') return v;
    }
    return undefined;
}

/**
 * Parse/validate tool-call args into a task list. Accepts a parsed dict OR a
 * raw JSON string. Returns null when the payload is malformed (weak local
 * models, legacy/trimmed history) so callers can fall back gracefully
 * instead of crashing a run or the renderer.
 */
export function parseTaskListArgs(args: unknown): TaskListItem[] | null {
    if (!args) return null;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch {
            return null;
        }
    }
    if (typeof args !== 'object') return null;
    const raw = (args as { tasks?: unknown }).tasks;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > TASK_LIST_MAX_ITEMS) return null;
    const items: TaskListItem[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') return null;
        const label = taskListLabelOf(entry);
        const status = (entry as { status?: unknown }).status;
        if (typeof label !== 'string' || typeof status !== 'string') return null;
        if (!(TASK_LIST_STATUSES as readonly string[]).includes(status)) return null;
        const clean = label.trim();
        if (!clean) return null;
        items.push({ label: clean.slice(0, TASK_LIST_MAX_LABEL), status: status as TaskListStatus });
    }
    return items;
}

/** Progress counts for the header chip / reminder line. */
export function taskListProgress(items: TaskListItem[]): { done: number; total: number; current: TaskListItem | null } {
    return {
        done: items.filter((t) => t.status === 'completed').length,
        total: items.length,
        current: items.find((t) => t.status === 'in_progress') ?? null,
    };
}

/** The per-turn reminder appended to the live prompt/system message -
 *  mirrors the backend's `_task_list_reminder` format exactly. Keeps the
 *  model on-track after context compaction and surfaces user edits. */
export function taskListReminderLine(items: TaskListItem[]): string {
    if (!items.length) return '';
    const { done, current } = taskListProgress(items);
    const lines = [`[Task list: ${done}/${items.length} done${current ? `, current: ${current.label}` : ''}]`];
    for (const t of items) {
        lines.push(`- [${t.status === 'completed' ? 'x' : ' '}] ${t.label}`);
    }
    lines.push(
        'Keep this list current with the update_task_list tool: exactly one item in_progress while executing, ' +
        'mark items completed as you finish them, keep every label a short single sentence, ' +
        'and respect any edits the user made to the list.'
    );
    return '\n\n' + lines.join('\n');
}

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export interface LocalSessionHistoryMessage {
    role: string;
    content?: string;
    tool_calls?: any[];
    tool_call_id?: string;
}

/** An interrupted in-flight turn, persisted mid-run so a host crash can
 *  restore it instead of dropping the whole response. */
export interface LocalPendingTurn {
    prompt: string;
    events: any[];
    text: string;
    thinking: string;
    attachments?: Array<{ name: string; mime_type: string; size: number }>;
}

export interface LocalSessionSnapshot {
    /** Workspace folder path the session belongs to (list filtering). */
    workspace?: string;
    model: string | null;
    summary: string | null;
    localHistory: LocalSessionHistoryMessage[];
    uiHistory: any[];
    pendingTurn?: LocalPendingTurn | null;
}

/** Slim list entry for the session picker - mirrors the backend's
 *  SessionSummaryItem: metadata only, never transcripts. */
export interface LocalSessionMeta {
    id: string;
    title: string;
    workspace: string;
    createdAt: number;
    updatedAt: number;
    /** True once the user renamed the session - auto-derivation stops. */
    renamed?: boolean;
}

const MAX_STORED_CONTENT = 20_000;
const MAX_STORED_HISTORY = 120;
const TITLE_MAX_LEN = 48;

/** Fallback title: just the folder name - never the full path. */
function workspaceLabel(workspace: string): string {
    const base = path.basename(workspace.trim());
    return base || workspace || 'default';
}

function deriveTitle(firstUserMessage: string | null | undefined, workspace: string): string {
    if (firstUserMessage) {
        const text = firstUserMessage.replace(/\s+/g, ' ').trim();
        if (text) {
            // Truncate by CODE POINTS - UTF-16 slicing splits surrogate
            // pairs (emoji at the boundary renders as a replacement char).
            const chars = Array.from(text);
            return chars.length > TITLE_MAX_LEN ? chars.slice(0, TITLE_MAX_LEN).join('') + '…' : text;
        }
    }
    return workspaceLabel(workspace);
}

/** Host-side title resolution for a loaded snapshot: a stored title that is
 *  still the auto workspace placeholder reads as UNTITLED (null) so the
 *  first user message can name the session. Without this the placeholder
 *  rode back into the host on every restore and was then passed to save()
 *  as renamedTitle - permanently locking every session to its workspace
 *  name. An explicit rename (even TO the workspace name) always wins, and
 *  so does a title that matches what the CURRENT first user message derives
 *  to - a prompt that literally reads like the workspace folder name names
 *  the session legitimately. */
export function resolveSessionTitle(
    title: string | null | undefined,
    renamed: boolean | undefined,
    workspace: string | undefined,
    uiHistory?: any[],
): string | null {
    if (!title) return null;
    if (renamed) return title;
    const ws = workspace ?? 'default';
    // Guard on a NON-null first message: with no user turn, deriveTitle
    // itself falls back to the workspace label and the derived-match below
    // would degenerate into passing the placeholder through.
    const firstMessage = uiHistory?.length ? firstUserText(uiHistory) : null;
    if (firstMessage && title === deriveTitle(firstMessage, ws)) return title;
    return title === workspaceLabel(ws) ? null : title;
}

function sanitizeSnapshot(snapshot: LocalSessionSnapshot): LocalSessionSnapshot {
    const localHistory = snapshot.localHistory.slice(-MAX_STORED_HISTORY).map((message) => ({
        ...message,
        content: typeof message.content === 'string'
            ? message.content.slice(-MAX_STORED_CONTENT)
            : message.content,
    }));
    const uiHistory = snapshot.uiHistory.slice(-MAX_STORED_HISTORY).map((message: any) => ({
        ...message,
        text: typeof message?.text === 'string' ? message.text.slice(-MAX_STORED_CONTENT) : message?.text,
    }));
    const pendingTurn = snapshot.pendingTurn ? sanitizePendingTurn(snapshot.pendingTurn) : null;
    return { ...snapshot, localHistory, uiHistory, pendingTurn };
}

function sanitizePendingTurn(pt: LocalPendingTurn): LocalPendingTurn {
    const events = Array.isArray(pt.events) ? pt.events.slice(-40).map((event: any) => {
        if (event?.type === 'tool_result' && typeof event.output === 'string' && event.output.length > MAX_STORED_CONTENT) {
            return { ...event, output: event.output.slice(-MAX_STORED_CONTENT) };
        }
        if (event?.type === 'tool_call' && event.args && typeof event.args === 'object') {
            return {
                ...event,
                args: Object.fromEntries(
                    Object.entries(event.args).map(([k, v]) =>
                        [k, typeof v === 'string' && v.length > MAX_STORED_CONTENT ? v.slice(-MAX_STORED_CONTENT) : v])
                ),
            };
        }
        return event;
    }) : [];
    return {
        prompt: pt.prompt.slice(-MAX_STORED_CONTENT),
        events,
        text: pt.text.slice(-MAX_STORED_CONTENT),
        thinking: pt.thinking.slice(-MAX_STORED_CONTENT),
        attachments: Array.isArray(pt.attachments) ? pt.attachments : undefined,
    };
}

function firstUserText(uiHistory: any[]): string | null {
    for (const m of uiHistory) {
        if (m?.role !== 'user') continue;
        // The host persists uiHistory user rows with `content` (the webview
        // HistoryMessage shape); older paths and tests use `text`. Read both.
        if (typeof m.text === 'string' && m.text.trim()) return m.text;
        if (typeof m.content === 'string' && m.content.trim()) return m.content;
    }
    return null;
}

/**
 * Multi-session persistence for the local runtime (Roo-style): one directory
 * per session under `<globalStorage>/sessions/<id>/` holding the full
 * transcript snapshot, plus a slim `_index.json` for instant list rendering.
 * The index is reconciled against the directories on every startup, and the
 * legacy single-snapshot-per-workspace `local-sessions.json` is imported on
 * first run.
 */
export class LocalSessionStore {
    private readonly rootDir: string;
    private readonly legacyPath: string;
    /** Promise-chain mutex: every mutating operation runs serialized.
     *  Two concurrent saves share ONE snapshot.json.tmp path, so an
     *  interleaved writeFile/rename can rename a partially-written temp
     *  file (corrupt snapshot → load() returns null → reconcile() drops
     *  the session) or land a stale write last (resurrected pendingTurn). */
    private _writeQueue: Promise<unknown> = Promise.resolve();

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._writeQueue.then(fn, fn);
        this._writeQueue = run.catch(() => undefined);
        return run;
    }

    constructor(storageRoot: string) {
        this.rootDir = path.join(storageRoot, 'sessions');
        this.legacyPath = path.join(storageRoot, 'local-sessions.json');
    }

    private sessionDir(id: string): string {
        // Defensive: ids are store-generated UUIDs; this keeps any hostile
        // path fragments from escaping the sessions root.
        if (!/^[a-f0-9-]{16,64}$/i.test(id)) throw new Error('invalid session id');
        return path.join(this.rootDir, id);
    }

    private async readIndex(): Promise<Record<string, LocalSessionMeta>> {
        try {
            const raw = await fs.readFile(path.join(this.rootDir, '_index.json'), 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    private async writeIndex(index: Record<string, LocalSessionMeta>): Promise<void> {
        await fs.mkdir(this.rootDir, { recursive: true });
        const temp = path.join(this.rootDir, '_index.json.tmp');
        await fs.writeFile(temp, JSON.stringify(index), 'utf8');
        await fs.rename(temp, path.join(this.rootDir, '_index.json'));
    }

    /** Rebuild the index from the per-session directories (source of truth),
     *  importing the legacy single-snapshot file when present. */
    async reconcile(currentWorkspacePath?: string): Promise<void> {
        return this.enqueue(() => this._reconcile(currentWorkspacePath));
    }

    private async _reconcile(currentWorkspacePath?: string): Promise<void> {
        await this.migrateLegacy(currentWorkspacePath);
        await fs.mkdir(this.rootDir, { recursive: true });
        const index = await this.readIndex();
        const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^[a-f0-9-]{16,64}$/i.test(entry.name)) continue;
            if (index[entry.name]) continue;
            try {
                const raw = await fs.readFile(path.join(this.rootDir, entry.name, 'snapshot.json'), 'utf8');
                const parsed = JSON.parse(raw);
                index[entry.name] = {
                    id: entry.name,
                    title: parsed?.title || deriveTitle(firstUserText(parsed?.uiHistory ?? []), parsed?.workspace || 'default'),
                    workspace: parsed?.workspace || 'default',
                    createdAt: parsed?.createdAt ?? Date.now(),
                    updatedAt: parsed?.updatedAt ?? Date.now(),
                    ...(parsed?.renamed ? { renamed: true } : {}),
                };
            } catch {
                /* unreadable directory - leave it out of the list */
            }
        }
        for (const id of Object.keys(index)) {
            try {
                await fs.access(this.sessionDir(id));
            } catch {
                delete index[id];
            }
        }
        await this.writeIndex(index);
    }

    /** Legacy keys were sha256(resolved workspace path) - only the CURRENT
     *  workspace's path can be recovered, everything else migrates under a
     *  generic label (titles still come from the first user message). */
    private legacyKey(workspacePath: string): string {
        return createHash('sha256').update(path.resolve(workspacePath)).digest('hex');
    }

    /** Import legacy `local-sessions.json` (one snapshot per workspace) as
     *  individual sessions, then rename the file out of the way. */
    private async migrateLegacy(currentWorkspacePath?: string): Promise<void> {
        let legacy: Record<string, any>;
        try {
            legacy = JSON.parse(await fs.readFile(this.legacyPath, 'utf8'));
        } catch {
            return;
        }
        const currentKey = currentWorkspacePath ? this.legacyKey(currentWorkspacePath) : null;
        try {
            await fs.mkdir(this.rootDir, { recursive: true });
            for (const [key, snapshot] of Object.entries(legacy)) {
                if (!snapshot || !Array.isArray(snapshot.uiHistory) || snapshot.uiHistory.length === 0) continue;
                const id = randomUUID();
                const workspace = key === currentKey ? currentWorkspacePath! : 'workspace';
                const meta = {
                    id,
                    title: deriveTitle(firstUserText(snapshot.uiHistory), workspace),
                    workspace,
                    createdAt: snapshot.updatedAt ?? Date.now(),
                    updatedAt: snapshot.updatedAt ?? Date.now(),
                };
                const payload = { ...meta, model: snapshot.model ?? null, summary: snapshot.summary ?? null, localHistory: snapshot.localHistory ?? [], uiHistory: snapshot.uiHistory };
                const dir = this.sessionDir(id);
                await fs.mkdir(dir, { recursive: true });
                const temp = path.join(dir, 'snapshot.json.tmp');
                await fs.writeFile(temp, JSON.stringify(sanitizeSnapshot(payload)), 'utf8');
                await fs.rename(temp, path.join(dir, 'snapshot.json'));
            }
            await fs.rename(this.legacyPath, `${this.legacyPath}.migrated`);
        } catch {
            /* migration is best-effort; the legacy file stays for next run */
        }
    }

    async list(workspaceRoot?: string): Promise<LocalSessionMeta[]> {
        const index = Object.values(await this.readIndex());
        index.sort((a, b) => b.updatedAt - a.updatedAt);
        if (workspaceRoot == null) return index;
        return index.filter((m) => m.workspace === workspaceRoot);
    }

    /** Session to reopen for a workspace: the preferred id when it still
     *  exists, else the most recent, else null. */
    async findCurrent(workspaceRoot: string, preferredId?: string | null): Promise<LocalSessionMeta | null> {
        const all = await this.list(workspaceRoot);
        if (preferredId && all.some((m) => m.id === preferredId)) {
            return all.find((m) => m.id === preferredId) ?? null;
        }
        return all[0] ?? null;
    }

    async create(workspaceRoot: string): Promise<LocalSessionMeta> {
        return this.enqueue(() => this._create(workspaceRoot));
    }

    private async _create(workspaceRoot: string): Promise<LocalSessionMeta> {
        const id = randomUUID();
        const now = Date.now();
        const meta: LocalSessionMeta = { id, title: workspaceLabel(workspaceRoot), workspace: workspaceRoot, createdAt: now, updatedAt: now };
        await this.writeMeta(meta, { model: null, summary: null, localHistory: [], uiHistory: [] });
        return meta;
    }

    async load(id: string): Promise<(LocalSessionSnapshot & { sessionId: string; title: string | null; workspace: string; renamed: boolean }) | null> {
        try {
            const raw = await fs.readFile(path.join(this.sessionDir(id), 'snapshot.json'), 'utf8');
            const parsed = JSON.parse(raw);
            return {
                sessionId: id,
                title: parsed?.title ?? null,
                workspace: parsed?.workspace ?? 'default',
                renamed: !!parsed?.renamed,
                model: parsed?.model ?? null,
                summary: parsed?.summary ?? null,
                localHistory: parsed?.localHistory ?? [],
                uiHistory: parsed?.uiHistory ?? [],
                pendingTurn: parsed?.pendingTurn ?? null,
            };
        } catch {
            return null;
        }
    }

    private async writeMeta(meta: LocalSessionMeta, snapshot: LocalSessionSnapshot): Promise<void> {
        const dir = this.sessionDir(meta.id);
        await fs.mkdir(dir, { recursive: true });
        const payload = { ...meta, ...sanitizeSnapshot(snapshot) };
        const temp = path.join(dir, 'snapshot.json.tmp');
        await fs.writeFile(temp, JSON.stringify(payload), 'utf8');
        await fs.rename(temp, path.join(dir, 'snapshot.json'));
        const index = await this.readIndex();
        index[meta.id] = meta;
        await this.writeIndex(index);
    }

    /** Persist the transcript snapshot. The title tracks the first user
     *  message (server-matching rule) until the user explicitly renames the
     *  session - `_create` only seeds the workspace label, so without the
     *  re-derivation every session would keep that placeholder forever. */
    async save(id: string, snapshot: LocalSessionSnapshot, renamedTitle?: string): Promise<{ meta: LocalSessionMeta } | null> {
        return this.enqueue(() => this._save(id, snapshot, renamedTitle));
    }

    private async _save(id: string, snapshot: LocalSessionSnapshot, renamedTitle?: string): Promise<{ meta: LocalSessionMeta } | null> {
        const index = await this.readIndex();
        const existing = index[id];
        const title = renamedTitle ?? (existing?.renamed
            ? existing.title
            : deriveTitle(firstUserText(snapshot.uiHistory), snapshot.workspace ?? existing?.workspace ?? 'default'));
        const meta: LocalSessionMeta = {
            id,
            title,
            workspace: snapshot.workspace ?? existing?.workspace ?? 'default',
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            ...(existing?.renamed ? { renamed: true } : {}),
        };
        await this.writeMeta(meta, snapshot);
        return { meta };
    }

    async rename(id: string, title: string): Promise<boolean> {
        return this.enqueue(() => this._rename(id, title));
    }

    private async _rename(id: string, title: string): Promise<boolean> {
        const index = await this.readIndex();
        const existing = index[id];
        if (!existing) return false;
        const meta = { ...existing, title: title.trim() || existing.title, updatedAt: Date.now(), renamed: true };
        index[id] = meta;
        await this.writeIndex(index);
        // Keep the directory copy consistent for reconcile().
        try {
            const dir = this.sessionDir(id);
            const raw = await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8');
            const parsed = JSON.parse(raw);
            parsed.title = meta.title;
            parsed.renamed = true;
            const temp = path.join(dir, 'snapshot.json.tmp');
            await fs.writeFile(temp, JSON.stringify(parsed), 'utf8');
            await fs.rename(temp, path.join(dir, 'snapshot.json'));
        } catch {
            /* index is the list source of truth; directory drift heals on reconcile */
        }
        return true;
    }

    async delete(id: string): Promise<boolean> {
        return this.enqueue(() => this._delete(id));
    }

    private async _delete(id: string): Promise<boolean> {
        try {
            await fs.rm(this.sessionDir(id), { recursive: true, force: true });
        } catch {
            // A real removal failure (e.g. EBUSY on Windows with an open
            // handle) - keep the index entry so the session stays visible
            // and a later attempt can retry it.
            return false;
        }
        const index = await this.readIndex();
        if (index[id]) {
            delete index[id];
            try {
                await this.writeIndex(index);
            } catch {
                /* reconcile heals the stale entry on next startup */
            }
        }
        return true;
    }
}

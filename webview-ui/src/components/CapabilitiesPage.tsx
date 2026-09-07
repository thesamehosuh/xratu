import { useEffect, useRef, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    Blocks,
    BookOpen,
    Check,
    FileJson,
    FolderOpen,
    Info,
    MoreHorizontal,
    Pencil,
    Plus,
    RefreshCw,
    Server,
    Trash2,
    TriangleAlert,
    X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
    McpRegistryEntry,
    McpSaveTarget,
    McpServerPayload,
    McpServerView,
    McpTransportType,
    SkillSource,
    SkillView,
} from '../types';
import { getLocale, t, tOrRaw, tf } from '../i18n';

interface CapabilitiesPageProps {
    onBack: () => void;
    onOpenRawSettings: () => void;
    servers: McpServerView[];
    hasWorkspace: boolean;
    legacyInUse: boolean;
    registry: McpRegistryEntry[];
    skills: SkillView[];
    onRefreshMcp: () => void;
    onSave: (target: McpSaveTarget, servers: McpServerPayload[]) => void;
    onRestart: (name: string) => void;
    onRefreshSkills: () => void;
    onToggleSkill: (id: string, enabled: boolean) => void;
    onRevealSkillsFolder: (dirPath?: string) => void;
    onOpenSkill: (dirPath: string) => void;
    onNewSkill: () => void;
    onDeleteSkill: (dirPath: string) => void;
}

interface Draft {
    original: string | null;
    originalSource: McpServerView['source'] | null;
    name: string;
    type: McpTransportType;
    command: string;
    argsText: string;
    envText: string;
    cwd: string;
    url: string;
    headersText: string;
    timeoutText: string;
    autoApproveText: string;
    disabled: boolean;
}

const TRANSPORTS: McpTransportType[] = ['stdio', 'streamableHttp', 'sse', 'websocket'];
/** Source display order for skill groups. */
const SKILL_SOURCES: SkillSource[] = ['project-xratu', 'project-agents', 'project-claude', 'global-agents', 'global-claude'];

function emptyDraft(): Draft {
    return {
        original: null,
        originalSource: null,
        name: '',
        type: 'streamableHttp',
        command: '',
        argsText: '',
        envText: '',
        cwd: '',
        url: '',
        headersText: '',
        timeoutText: '',
        autoApproveText: '',
        disabled: false,
    };
}

function draftFromView(v: McpServerView): Draft {
    return {
        original: v.name,
        originalSource: v.source,
        name: v.name,
        type: v.type ?? (v.url ? 'streamableHttp' : 'stdio'),
        command: v.command ?? '',
        argsText: (v.args ?? []).join('\n'),
        envText: v.env ? JSON.stringify(v.env, null, 2) : '',
        cwd: v.cwd ?? '',
        url: v.url ?? '',
        headersText: v.headers ? JSON.stringify(v.headers, null, 2) : '',
        timeoutText: v.timeoutMs != null ? String(v.timeoutMs) : '',
        autoApproveText: (v.autoApprove ?? []).join('\n'),
        disabled: !!v.disabled,
    };
}

/** Loopback-only exception for cleartext transports: localhost cannot leak
 *  credentials off-machine. Mirrors endpointGuard's intent on the webview
 *  side (host code cannot be imported here). */
function isLoopbackHostname(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '127.0.0.1';
}

function draftToPayload(d: Draft): McpServerPayload | string {
    const name = d.name.trim();
    if (!name) return 'mcpNameRequired';
    if (d.type === 'stdio' && !d.command.trim()) return 'mcpCommandRequired';
    if (d.type !== 'stdio') {
        if (!d.url.trim()) return 'mcpUrlRequired';
        try {
            const u = new URL(d.url.trim());
            if (d.type === 'websocket' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return 'mcpUrlInvalid';
            if (d.type !== 'websocket' && u.protocol !== 'http:' && u.protocol !== 'https:') return 'mcpUrlInvalid';
        } catch {
            return 'mcpUrlInvalid';
        }
    }
    const parseJsonField = (text: string): Record<string, string> | string => {
        if (!text.trim()) return {};
        try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'mcpJsonInvalid';
            return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        } catch {
            return 'mcpJsonInvalid';
        }
    };
    const env = parseJsonField(d.envText);
    if (typeof env === 'string') return env;
    const headers = parseJsonField(d.headersText);
    if (typeof headers === 'string') return headers;
    // Credential headers over cleartext HTTP can be sniffed in transit -
    // require https unless the endpoint is loopback.
    if ((d.type === 'streamableHttp' || d.type === 'sse') && d.headersText.trim()) {
        try {
            const u = new URL(d.url.trim());
            if (u.protocol !== 'https:' && !isLoopbackHostname(u.hostname)) return 'mcpHttpSecretInsecure';
        } catch {
            return 'mcpUrlInvalid';
        }
    }
    const args = d.argsText.split('\n').map((l) => l.trim()).filter(Boolean);
    const autoApprove = d.autoApproveText.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeout = d.timeoutText.trim() === '' ? undefined : Number(d.timeoutText);
    return {
        name,
        type: d.type,
        command: d.type === 'stdio' ? d.command.trim() : undefined,
        args: d.type === 'stdio' && args.length ? args : undefined,
        env: d.type === 'stdio' && Object.keys(env).length ? env : undefined,
        cwd: d.type === 'stdio' && d.cwd.trim() ? d.cwd.trim() : undefined,
        url: d.type !== 'stdio' ? d.url.trim() : undefined,
        headers: d.type !== 'stdio' && Object.keys(headers).length ? headers : undefined,
        disabled: d.disabled || undefined,
        autoApprove: autoApprove.length ? autoApprove : undefined,
        timeoutMs: timeout != null && Number.isFinite(timeout) && timeout >= 0 ? timeout : undefined,
    };
}

function transportLabel(type: McpTransportType): string {
    if (type === 'stdio') return t('mcpStdio');
    if (type === 'streamableHttp') return t('mcpHttp');
    if (type === 'sse') return t('mcpSse');
    return t('mcpWebsocket');
}

function statusLabel(state: McpServerView['state']): string {
    if (state === 'connected') return t('mcpStatusConnected');
    if (state === 'error') return t('mcpStatusError');
    if (state === 'disabled') return t('mcpStatusDisabled');
    return t('mcpStatusUnconfigured');
}

function sourceLabel(source: McpServerView['source'] | SkillSource): string {
    if (source === 'workspace' || source === 'project-xratu') return t('mcpTargetWorkspace');
    if (source === 'legacy') return t('mcpSourceLegacy');
    if (source === 'project-agents') return t('skillsSourceAgents');
    if (source === 'project-claude') return t('skillsSourceClaudeProject');
    if (source === 'global-claude') return t('skillsSourceClaudeGlobal');
    return t('mcpTargetGlobal');
}

/** Endpoint summary for the meta line: command for stdio, URL otherwise. */
function endpointOf(s: McpServerView): string {
    if (s.url) return s.url;
    if (s.command) return s.args?.length ? `${s.command} …` : s.command;
    return '';
}

function formatChars(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function CapabilitiesPage({
    onBack,
    onOpenRawSettings,
    servers,
    hasWorkspace,
    legacyInUse,
    registry,
    skills,
    onRefreshMcp,
    onSave,
    onRestart,
    onRefreshSkills,
    onToggleSkill,
    onRevealSkillsFolder,
    onOpenSkill,
    onNewSkill,
    onDeleteSkill,
}: CapabilitiesPageProps) {
    const [tab, setTab] = useState<'servers' | 'skills'>('servers');
    const [newServerTarget, setNewServerTarget] = useState<McpSaveTarget>('global');
    const [draft, setDraft] = useState<Draft | null>(null);
    const [draftInitial, setDraftInitial] = useState<Draft | null>(null);
    const [draftError, setDraftError] = useState<string | null>(null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [armedDelete, setArmedDelete] = useState<string | null>(null);
    const [pendingRestart, setPendingRestart] = useState<string | null>(null);
    const [pendingMcpRefresh, setPendingMcpRefresh] = useState(false);
    const [pendingSkillsRefresh, setPendingSkillsRefresh] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const refreshStartedAt = useRef(0);

    // Fake-free busy flags: each spinner is cleared when the host echoes the
    // matching fresh state - never on a hardcoded timer - but never shorter
    // than ~800ms (an instant stop reads as broken rather than fast). The
    // two requests complete independently, so they track separately. The
    // identity refs distinguish a real echo (new prop reference) from the
    // pending-flag flip that arms the effect on click.
    const prevServers = useRef(servers);
    const prevSkills = useRef(skills);
    useEffect(() => {
        setPendingRestart(null);
    }, [servers, skills]);

    useEffect(() => {
        if (prevServers.current === servers) return;
        prevServers.current = servers;
        if (!pendingMcpRefresh) return;
        const elapsed = Date.now() - refreshStartedAt.current;
        const t = setTimeout(() => setPendingMcpRefresh(false), Math.max(0, 800 - elapsed));
        return () => clearTimeout(t);
    }, [servers, pendingMcpRefresh]);

    useEffect(() => {
        if (prevSkills.current === skills) return;
        prevSkills.current = skills;
        if (!pendingSkillsRefresh) return;
        const elapsed = Date.now() - refreshStartedAt.current;
        const t = setTimeout(() => setPendingSkillsRefresh(false), Math.max(0, 800 - elapsed));
        return () => clearTimeout(t);
    }, [skills, pendingSkillsRefresh]);

    // Kebab menu dismisses on any outside click; arming resets with it.
    useEffect(() => {
        if (!menuFor) return;
        const close = (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (!target?.closest('.mcp-menu-wrap')) {
                setMenuFor(null);
                setArmedDelete(null);
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [menuFor]);

    const draftDirty = !!draft && !!draftInitial && JSON.stringify(draft) !== JSON.stringify(draftInitial);

    const confirmDiscard = (): boolean => !draftDirty || window.confirm(t('mcpDiscardConfirm'));

    const openEditor = (v?: McpServerView) => {
        if (draft && !confirmDiscard()) return;
        setMenuFor(null);
        setArmedDelete(null);
        const d = v ? draftFromView(v) : emptyDraft();
        setDraft(d);
        setDraftInitial(d);
        setDraftError(null);
    };

    const closeEditor = () => {
        if (draftDirty && !window.confirm(t('mcpDiscardConfirm'))) return;
        setDraft(null);
        setDraftInitial(null);
        setDraftError(null);
    };

    const stripView = (s: McpServerView | McpServerPayload): McpServerPayload => {
        const { state: _st, toolCount: _tc, lastError: _le, source: _src, ...payload } = s as McpServerView;
        return payload;
    };

    /** File a row lives in: legacy entries belong to the global file -
     *  saving migrates them out of the read-only setting. */
    const targetOf = (source: McpServerView['source']): McpSaveTarget =>
        source === 'workspace' ? 'workspace' : 'global';

    /** Servers living in the same file as `source`, normalized: mutations
     *  never drop sibling entries just because their stored source label
     *  differs (legacy rows and global rows share the global file). */
    const fileMates = (source: McpServerView['source']): McpServerView[] =>
        servers.filter((s) => targetOf(s.source) === targetOf(source));

    /** Mutations land in the ROW'S OWN file - never in whatever the last
     *  selected save-target happened to be. */
    const commitSource = (source: McpServerView['source'], next: Array<McpServerView | McpServerPayload>) => {
        onSave(targetOf(source), next.map(stripView));
    };

    /** Servers living in the given save-target file (legacy rows share the
     *  global file - a save migrates them out of the read-only setting). */
    const matesForTarget = (target: McpSaveTarget): McpServerView[] =>
        target === 'workspace'
            ? servers.filter((s) => s.source === 'workspace')
            : servers.filter((s) => s.source === 'global' || s.source === 'legacy');

    const commitNew = (target: McpSaveTarget, payload: McpServerPayload) => {
        onSave(target, [...matesForTarget(target).map(stripView), payload]);
    };

    const toggleDisabled = (v: McpServerView) => {
        commitSource(v.source, fileMates(v.source).map((s) => (
            s.name === v.name ? { ...stripView(s), disabled: !s.disabled } : s
        )));
    };

    const deleteServer = (name: string, source: McpServerView['source']) => {
        setMenuFor(null);
        setArmedDelete(null);
        commitSource(source, fileMates(source).filter((s) => s.name !== name));
    };

    const addFromRegistry = (entry: McpRegistryEntry) => {
        // Uniqueness is scoped to the DESTINATION file only - same-name
        // entries in different files are legal workspace-override semantics.
        const mates = matesForTarget(newServerTarget);
        let name = entry.server.name;
        let n = 2;
        while (mates.some((s) => s.name === name)) {
            name = `${entry.server.name}-${n++}`;
        }
        commitNew(newServerTarget, { ...entry.server, name });
    };

    const saveDraft = () => {
        if (!draft) return;
        let payload: McpServerPayload | string;
        try {
            payload = draftToPayload(draft);
        } catch {
            payload = 'mcpJsonInvalid';
        }
        if (typeof payload === 'string') {
            setDraftError(tOrRaw(payload));
            return;
        }
        // Duplicate names are checked against the DESTINATION file only
        // (legacy entries belong to the global file) - same-name entries in
        // different files are legal workspace-override semantics.
        const dest = draft.original ? (draft.originalSource ?? 'global') : newServerTarget;
        if (fileMates(dest).some((s) => s.name === payload.name && s.name !== draft.original)) {
            setDraftError(t('mcpNameDuplicate'));
            return;
        }
        if (draft.original) {
            commitSource(dest, fileMates(dest)
                .map((s) => (s.name === draft.original ? { ...payload } : s)));
        } else {
            commitNew(newServerTarget, payload);
        }
        setDraft(null);
        setDraftInitial(null);
        setDraftError(null);
    };

    const field = (label: string, node: ReactNode, hint?: string) => (
        <label className="mcp-field">
            <span className="mcp-field-label">{label}</span>
            {node}
            {hint && <span className="mcp-hint-text">{hint}</span>}
        </label>
    );

    const jsonError = (text: string): string | null => {
        if (!text.trim()) return null;
        try {
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return t('mcpJsonInvalid');
            return null;
        } catch {
            return t('mcpJsonInvalid');
        }
    };

    const renderServerRow = (s: McpServerView) => {
        // Source-qualified identity: same-named rows across files (workspace
        // override) must keep independent menu/armed state and keys.
        const rowId = `${s.source}:${s.name}`;
        const menuOpen = menuFor === rowId;
        const armed = armedDelete === rowId;
        const endpoint = endpointOf(s);
        return (
            <div key={rowId} className={`mcp-row ${s.disabled ? 'off' : ''}`} dir="ltr">
                <span className={`mcp-dot ${s.disabled ? 'disabled' : s.state}`} title={statusLabel(s.disabled ? 'disabled' : s.state)} />
                <button type="button" className="mcp-row-main" onClick={() => openEditor(s)} title={endpoint}>
                    <span className="mcp-row-title">
                        <strong dir="auto">{s.name}</strong>
                        <span className={`mcp-badge src-${s.source}`}>{sourceLabel(s.source)}</span>
                    </span>
                    <span className="mcp-row-meta" dir="ltr">
                        <span dir="auto">{transportLabel(s.type ?? (s.url ? 'streamableHttp' : 'stdio'))}</span>
                        {endpoint && <span>{` \u00b7 ${endpoint}`}</span>}
                        {s.state === 'connected' && !s.disabled && s.toolCount != null && <span>{` \u00b7 ${tf('mcpToolsCount', { n: String(s.toolCount) })}`}</span>}
                    </span>
                    {s.state === 'error' && !s.disabled && s.lastError && (
                        <span className="mcp-row-error" dir="ltr">{s.lastError}</span>
                    )}
                </button>
                <div className="mcp-row-actions">
                    <button
                        type="button"
                        className={`mcp-switch ${s.disabled ? '' : 'on'}`}
                        role="switch"
                        aria-checked={!s.disabled}
                        disabled={pendingRestart === s.name}
                        aria-label={`${s.name}: ${s.disabled ? t('mcpEnable') : t('mcpDisable')}`}
                        title={s.disabled ? t('mcpEnable') : t('mcpDisable')}
                        onClick={() => toggleDisabled(s)}
                    >
                        <span className="mcp-switch-knob" />
                    </button>
                    <div className="mcp-menu-wrap">
                        <button
                            type="button"
                            className={`icon-btn ${menuOpen ? 'accent' : ''}`}
                            disabled={pendingRestart === s.name}
                            title={t('mcpRowMenu')}
                            aria-label={t('mcpRowMenu')}
                            aria-expanded={menuOpen}
                            onClick={() => { setMenuFor(menuOpen ? null : rowId); setArmedDelete(null); }}
                        >
                            <MoreHorizontal size={13} />
                        </button>
                        {menuOpen && (
                            <div className="mcp-menu" role="menu">
                                <button
                                    type="button"
                                    role="menuitem"
                                    className="mcp-menu-item"
                                    onClick={() => {
                                        setMenuFor(null);
                                        setPendingRestart(s.name);
                                        onRestart(s.name);
                                    }}
                                >
                                    <RefreshCw size={12} className={pendingRestart === s.name ? 'spinning' : undefined} />
                                    {t('mcpRestart')}
                                </button>
                                <button type="button" role="menuitem" className="mcp-menu-item" onClick={() => openEditor(s)}>
                                    <Pencil size={12} />
                                    {t('mcpEdit')}
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    className={`mcp-menu-item danger ${armed ? 'confirm' : ''}`}
                                    onClick={() => (armed ? deleteServer(s.name, s.source) : setArmedDelete(rowId))}
                                >
                                    {armed ? <Check size={12} /> : <Trash2 size={12} />}
                                    {armed ? t('mcpDeleteConfirm') : t('mcpDelete')}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    const renderDraftForm = () => {
        if (!draft) return null;
        return (
            <div className="mcp-form">
                <div className="mcp-form-head">
                    <h3>{draft.original ? t('mcpEditServer') : t('mcpAddServer')}</h3>
                    <div className="mcp-form-head-side">
                        <button
                            type="button"
                            className={`mcp-state-chip ${draft.disabled ? 'off' : ''}`}
                            title={draft.disabled ? t('mcpEnable') : t('mcpDisable')}
                            onClick={() => setDraft({ ...draft, disabled: !draft.disabled })}
                        >
                            {draft.disabled ? t('mcpStateDisabled') : t('mcpStateEnabled')}
                        </button>
                        <button type="button" className="icon-btn" title={t('mcpCancel')} aria-label={t('mcpCancel')} onClick={closeEditor}>
                            <X size={14} />
                        </button>
                    </div>
                </div>
                {field(t('mcpServerName'),
                    <input dir="ltr" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />)}
                {field(t('mcpTransportType'),
                    <select dir="ltr" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as McpTransportType })}>
                        {TRANSPORTS.map((tr) => <option key={tr} value={tr}>{transportLabel(tr)}</option>)}
                    </select>)}
                <div className="mcp-form-group">
                    <span className="mcp-form-group-label">{t('mcpGroupConnection')}</span>
                    {draft.type === 'stdio' ? (
                        <>
                            {field(t('mcpCommand'),
                                <input dir="ltr" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx / uvx / node …" />)}
                            {field(t('mcpArgs'),
                                <textarea dir="ltr" rows={3} value={draft.argsText} onChange={(e) => setDraft({ ...draft, argsText: e.target.value })} />,
                                t('mcpArgsHint'))}
                        </>
                    ) : (
                        field(t('mcpUrl'),
                            <input dir="ltr" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder={draft.type === 'websocket' ? 'wss://example.com/mcp' : 'https://example.com/mcp'} />)
                    )}
                </div>
                <div className="mcp-form-group">
                    <span className="mcp-form-group-label">{t('mcpGroupSecurity')}</span>
                    {draft.type !== 'stdio' && field(t('mcpHeadersJson'),
                        <textarea dir="ltr" rows={3} value={draft.headersText} onChange={(e) => setDraft({ ...draft, headersText: e.target.value })} placeholder='{"Authorization": "Bearer …"}' />,
                        jsonError(draft.headersText) ?? (draft.headersText.trim() ? t('mcpHeaderSecretWarn') : undefined))}
                    {field(t('mcpAutoApproveList'),
                        <textarea dir="ltr" rows={3} value={draft.autoApproveText} onChange={(e) => setDraft({ ...draft, autoApproveText: e.target.value })} />,
                        t('mcpAutoApproveHint'))}
                </div>
                <div className="mcp-form-group">
                    <span className="mcp-form-group-label">{t('mcpGroupAdvanced')}</span>
                    {draft.type === 'stdio' && field(t('mcpEnvJson'),
                        <textarea dir="ltr" rows={3} value={draft.envText} onChange={(e) => setDraft({ ...draft, envText: e.target.value })} />,
                        jsonError(draft.envText) ?? undefined)}
                    {draft.type === 'stdio' && field(t('mcpCwd'),
                        <input dir="ltr" value={draft.cwd} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} />)}
                    {field(t('mcpTimeoutMs'),
                        <input dir="ltr" inputMode="numeric" value={draft.timeoutText} onChange={(e) => setDraft({ ...draft, timeoutText: e.target.value.replace(/[^\d]/g, '') })} />)}
                </div>
                {draft.original ? (
                    <p className="mcp-hint-text" dir="auto">
                        {tf('mcpStoredIn', { target: sourceLabel(draft.originalSource ?? 'global') })}
                    </p>
                ) : (
                    <div className="mcp-target-row">
                        <span className="mcp-field-label">{t('mcpSaveTarget')}</span>
                        <div className="lang-choice">
                            <button type="button" className={newServerTarget === 'global' ? 'lang-chip active' : 'lang-chip'} onClick={() => setNewServerTarget('global')}>
                                {t('mcpTargetGlobal')}
                            </button>
                            <button
                                type="button"
                                className={newServerTarget === 'workspace' ? 'lang-chip active' : 'lang-chip'}
                                disabled={!hasWorkspace}
                                onClick={() => setNewServerTarget('workspace')}
                            >
                                {t('mcpTargetWorkspace')}
                            </button>
                        </div>
                    </div>
                )}
                {!draft.original && <p className="mcp-hint-text">{t('mcpTargetHint')}</p>}
                {draftError && <span className="mcp-field-error">{draftError}</span>}
                <div className="mcp-form-actions">
                    <button type="button" className="mcp-save" onClick={saveDraft}>
                        <Check size={14} />
                        {t('mcpSave')}
                    </button>
                    <button type="button" className="settings-ghost-action" onClick={closeEditor}>{t('mcpCancel')}</button>
                </div>
            </div>
        );
    };

    /** Registry rows sit inline at the bottom of the servers card - always
     *  visible, no toggle. */
    const renderRegistry = () => (
        <div className="settings-card-body mcp-registry-block">
            <div className="settings-section-head">
                <div className="settings-section-icon" aria-hidden="true">
                    <Blocks size={15} />
                </div>
                <div>
                    <h3>{t('mcpRegistryTab')}</h3>
                    <p>{t('mcpRegistrySectionDesc')}</p>
                </div>
            </div>
            <div className="mcp-target-row">
                <span className="mcp-field-label">{t('mcpSaveTarget')}</span>
                <div className="lang-choice">
                    <button type="button" className={newServerTarget === 'global' ? 'lang-chip active' : 'lang-chip'} onClick={() => setNewServerTarget('global')}>
                        {t('mcpTargetGlobal')}
                    </button>
                    <button
                        type="button"
                        className={newServerTarget === 'workspace' ? 'lang-chip active' : 'lang-chip'}
                        disabled={!hasWorkspace}
                        onClick={() => setNewServerTarget('workspace')}
                    >
                        {t('mcpTargetWorkspace')}
                    </button>
                </div>
            </div>
            {registry.map((entry) => {
                const added = matesForTarget(newServerTarget).some((s) => s.name === entry.server.name);
                return (
                    <div key={entry.id} className="mcp-row" dir="ltr">
                        <div className="mcp-row-main">
                            <span className="mcp-row-title">
                                <strong>{tf(entry.nameKey)}</strong>
                            </span>
                            <span className="mcp-row-meta">{tf(entry.descKey)}</span>
                        </div>
                        <div className="mcp-row-actions">
                            {added ? (
                                <span className="mcp-added-pill">
                                    <Check size={11} />
                                    {t('mcpRegExists')}
                                </span>
                            ) : (
                                <button type="button" className="settings-ghost-action" onClick={() => addFromRegistry(entry)}>
                                    <Plus size={12} />
                                    {t('mcpRegAdd')}
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );

    const renderServersTab = () => (
        <>
            <section className="settings-card">
                <div className="settings-section-head">
                    <div className="settings-section-icon" aria-hidden="true">
                        <Server size={15} />
                    </div>
                    <div>
                        <h3>{t('mcpServersTab')}</h3>
                        <p>{t('mcpServersSectionDesc')}</p>
                    </div>
                    <button type="button" className="cred-local-connect" onClick={() => openEditor()}>
                        <Plus size={13} />
                        {t('mcpAddServer')}
                    </button>
                </div>

                <div className="settings-card-body">
                    {servers.length === 0 && !draft && (
                        <div className="mcp-empty">
                            <span>{t('mcpEmptyTitle')}</span>
                            <button type="button" className="cred-local-connect" onClick={() => openEditor()}>
                                <Plus size={13} />
                                {t('mcpAddServer')}
                            </button>
                        </div>
                    )}

                    {renderDraftForm()}

                    {servers.map(renderServerRow)}
                </div>

                <button type="button" className="settings-nav-row" onClick={onOpenRawSettings}>
                    <div className="settings-nav-main">
                        <strong>{t('mcpEditRawJson')}</strong>
                    </div>
                    <FileJson size={14} />
                </button>

                {renderRegistry()}
            </section>
        </>
    );

    const renderSkillRow = (s: SkillView) => {
        const inactive = !!s.error || !!s.shadowed;
        return (
            <div key={s.id} className={`mcp-row ${s.enabled ? '' : 'off'}`} dir="ltr">
                <span className={`mcp-dot ${s.error ? 'error' : s.enabled ? 'connected' : 'disabled'}`} title={s.error ?? undefined} />
                <div className="mcp-row-main" title={s.dirPath}>
                    <span className="mcp-row-title">
                        <strong dir="auto">{s.name}</strong>
                        {s.shadowed && <span className="mcp-badge src-shadowed">{t('skillsShadowed')}</span>}
                    </span>
                    {s.error ? (
                        <span className="mcp-row-error" dir="auto">{s.error}</span>
                    ) : (
                        s.description && <span className="mcp-row-meta" dir="auto">{s.description}</span>
                    )}
                    {!s.error && !s.shadowed && s.bodyChars != null && s.bodyChars > 0 && (
                        <span className="mcp-row-meta" dir="auto">{tf('skillsBodyTokens', { n: formatChars(Math.round(s.bodyChars / 4)) })}</span>
                    )}
                    {s.shadowed && (
                        <span className="mcp-row-meta">{t('skillsShadowedHint')}</span>
                    )}
                </div>
                <div className="mcp-row-actions">
                    <button
                        type="button"
                        className="icon-btn"
                        title={t('skillsEdit')}
                        aria-label={t('skillsEdit')}
                        onClick={() => onOpenSkill(s.dirPath)}
                    >
                        <Pencil size={13} />
                    </button>
                    <button
                        type="button"
                        className="icon-btn"
                        title={t('skillsReveal')}
                        aria-label={t('skillsReveal')}
                        onClick={() => onRevealSkillsFolder(s.dirPath)}
                    >
                        <FolderOpen size={13} />
                    </button>
                    <button
                        type="button"
                        className={`icon-btn danger${confirmDelete === s.id ? ' confirm' : ''}`}
                        aria-label={confirmDelete === s.id ? t('skillsDeleteConfirm') : t('skillsDelete')}
                        title={confirmDelete === s.id ? t('skillsDeleteConfirm') : t('skillsDelete')}
                        onClick={() => {
                            if (confirmDelete === s.id) {
                                setConfirmDelete(null);
                                onDeleteSkill(s.dirPath);
                                return;
                            }
                            setConfirmDelete(s.id);
                        }}
                    >
                        {confirmDelete === s.id ? <Check size={13} /> : <Trash2 size={13} />}
                    </button>
                    <button
                        type="button"
                        className={`mcp-switch ${s.enabled ? 'on' : ''}`}
                        role="switch"
                        aria-checked={s.enabled}
                        disabled={inactive}
                        aria-label={`${s.name}: ${s.enabled ? t('skillsDisable') : t('skillsEnable')}`}
                        title={s.shadowed ? t('skillsShadowedHint') : s.enabled ? t('skillsDisable') : t('skillsEnable')}
                        onClick={() => onToggleSkill(s.id, !s.enabled)}
                    >
                        <span className="mcp-switch-knob" />
                    </button>
                </div>
            </div>
        );
    };

    const renderSkillsTab = () => {
        const groups = SKILL_SOURCES
            .map((source) => ({
                source,
                items: skills
                    .filter((s) => s.source === source)
                    .sort((a, b) => (a.shadowed === b.shadowed ? a.name.localeCompare(b.name) : a.shadowed ? 1 : -1)),
            }))
            .filter((g) => g.items.length > 0);
        return (
            <section className="settings-card">
                <div className="settings-section-head">
                    <div className="settings-section-icon" aria-hidden="true">
                        <BookOpen size={15} />
                    </div>
                    <div>
                        <h3>{t('skillsTitle')}</h3>
                        <p>{t('skillsSectionDesc')}</p>
                    </div>
                    <button type="button" className="cred-local-connect" onClick={onNewSkill}>
                        <Plus size={13} />
                        {t('skillsNew')}
                    </button>
                </div>
                <div className="settings-card-body">
                    {skills.length === 0 ? (
                        <div className="mcp-empty">
                            <BookOpen size={22} />
                            <strong>{t('skillsEmptyTitle')}</strong>
                            <button type="button" className="cred-local-connect" onClick={() => onRevealSkillsFolder()}>
                                <FolderOpen size={13} />
                                {t('skillsOpenFolder')}
                            </button>
                        </div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.source} className="mcp-group">
                                <div className="mcp-group-label">{sourceLabel(g.source)}</div>
                                {g.items.map(renderSkillRow)}
                            </div>
                        ))
                    )}
                </div>
            </section>
        );
    };

    const refresh = () => {
        refreshStartedAt.current = Date.now();
        setPendingMcpRefresh(true);
        setPendingSkillsRefresh(true);
        onRefreshMcp();
        onRefreshSkills();
    };

    return (
        <div className="settings-page">
            <header className="settings-head">
                <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => {
                        if (draft && !confirmDiscard()) return;
                        onBack();
                    }}
                    aria-label={t('credBack')}
                    title={t('credBack')}
                >
                    {getLocale() === 'fa' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
                </button>
                <div className="settings-head-copy">
                    <h2>{t('capTitle')}</h2>
                </div>
                <button
                    type="button"
                    className="icon-btn"
                    title={t('mcpRefresh')}
                    aria-label={t('mcpRefresh')}
                    onClick={refresh}
                >
                    <RefreshCw size={14} className={pendingMcpRefresh || pendingSkillsRefresh ? 'spinning' : undefined} />
                </button>
            </header>

            <div className="settings-scroll">
                {legacyInUse && tab === 'servers' && (
                    <div className="mcp-hint warn" role="status">
                        <TriangleAlert size={12} aria-hidden="true" />
                        <span>{t('mcpLegacyNote')}</span>
                    </div>
                )}

                <div className="mcp-tabs" role="tablist" aria-label={t('capTitle')}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'servers'}
                        className={tab === 'servers' ? 'lang-chip active' : 'lang-chip'}
                        onClick={() => setTab('servers')}
                    >
                        {t('mcpServersTab')}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'skills'}
                        className={tab === 'skills' ? 'lang-chip active' : 'lang-chip'}
                        onClick={() => setTab('skills')}
                    >
                        {t('skillsTitle')}
                    </button>
                </div>

                {tab === 'servers' ? renderServersTab() : renderSkillsTab()}

                {/* Apply-on-new-session semantics are fine print - footer, not header. */}
                <div className="mcp-hint foot" role="note">
                    <Info size={12} aria-hidden="true" />
                    <span>{tab === 'servers' ? t('mcpApplyHint') : t('skillsHint')}</span>
                </div>
            </div>
        </div>
    );
}

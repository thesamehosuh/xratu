import { useEffect, useRef, useState } from 'react';
import {
    ArrowLeft,
    ArrowRight,
    BookOpen,
    Check,
    Download,
    ExternalLink,
    FileJson,
    FolderOpen,
    Globe,
    Info,
    KeyRound,
    MoreHorizontal,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Server,
    ShieldCheck,
    Star,
    Store,
    Trash2,
    TriangleAlert,
    X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type {
    InstallConfidence,
    MarketplaceEntry,
    MarketplaceInstall,
    MarketplaceSource,
    MarketplaceState,
    McpSaveTarget,
    McpServerPayload,
    McpServerView,
    McpTransportType,
    SkillSource,
    SkillView,
} from '../types';
import { getLocale, t, tOrRaw, tf, type StringKey } from '../i18n';

interface CapabilitiesPageProps {
    onBack: () => void;
    onOpenRawSettings: () => void;
    servers: McpServerView[];
    hasWorkspace: boolean;
    legacyInUse: boolean;
    /** Live marketplace (host-fetched); `query` is the request it answers. */
    marketplace: (MarketplaceState & { query: string }) | null;
    /** Result of the opt-in README detection for one entry. */
    marketplaceDetection: { id: string; install: MarketplaceInstall | null; confidence: InstallConfidence } | null;
    onMarketplaceLoad: (query: string, force: boolean) => void;
    onMarketplaceDetect: (id: string) => void;
    onMarketplaceClearDetection: () => void;
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

/** Catalog rows mounted at once. A full catalog is ~500 rows / 10k+ DOM nodes,
 *  which made both the first paint and the unmount on Back visibly slow
 *  (measured in the built bundle: 115-126ms to leave the page against 33ms
 *  with a small list). A catalog this size is used by SEARCHING, not by
 *  scrolling, so only a window is mounted and "show more" grows it. */
const MARKET_PAGE = 60;
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

// ---------------------------------------------------------------------------
// Marketplace helpers
// ---------------------------------------------------------------------------

/** Display name: curated entries keep their text in i18n, remote ones do not. */
function entryName(entry: MarketplaceEntry): string {
    return entry.nameKey ? tf(entry.nameKey) : entry.name;
}

function entrySummary(entry: MarketplaceEntry): string {
    if (entry.tagline) return entry.tagline;
    if (entry.descKey) return tf(entry.descKey);
    return entry.description;
}

function marketSourceLabel(source: MarketplaceSource): string {
    if (source === 'curated') return t('mcpMarketSourceCurated');
    if (source === 'cline') return t('mcpMarketSourceCline');
    if (source === 'official') return t('mcpMarketSourceOfficial');
    return t('mcpMarketSourceRemote');
}

/** What KIND of catalog an entry came from, shown on hover. The badge says
 *  "Public" / "Official", never a vendor's brand: Xratu must not read as a
 *  reskin of the catalog it consumes. The exact source URLs stay one hover
 *  away (status line) and in the setting that configures them. */
function marketSourceHint(source: MarketplaceSource): string {
    if (source === 'curated') return t('mcpMarketHintCurated');
    if (source === 'cline') return t('mcpMarketHintCline');
    if (source === 'official') return t('mcpMarketHintOfficial');
    return t('mcpMarketHintRemote');
}

/** The tag vocabulary the catalogs use, mapped to our own translations. Ids
 *  stay the filter key (language-independent); only the label is localized. */
const TAG_I18N_KEYS: Record<string, StringKey> = {
    productivity: 'mcpTagProductivity',
    marketing: 'mcpTagMarketing',
    research: 'mcpTagResearch',
    data: 'mcpTagData',
    software: 'mcpTagSoftware',
    business: 'mcpTagBusiness',
    sales: 'mcpTagSales',
    finance: 'mcpTagFinance',
    creative: 'mcpTagCreative',
    memory: 'mcpTagMemory',
    security: 'mcpTagSecurity',
    databases: 'mcpTagDatabases',
};

/** Localized label for a tag id; the catalog's own label covers ids this build
 *  has no translation for, so a tag is never displayed as a bare id. */
function tagLabel(id: string, catalogLabels?: Record<string, string>): string {
    const key = TAG_I18N_KEYS[id];
    if (key) return t(key);
    return catalogLabels?.[id] ?? id;
}

/* Marketplace rows are LTR by design: name, subtitle and command all align
   left, whatever script the subtitle happens to be written in. */

/** The exact command / URL a row would write into mcp.json - shown BEFORE
 *  anything is saved, because a remote catalog is not a trusted input. */
function installPreview(install: MarketplaceInstall | null): string {
    if (!install) return '';
    if (install.kind === 'remote') return install.url;
    return [install.command, ...install.args].join(' ');
}

function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(n);
}

/** Most common tags across the loaded catalog (drives the filter chips). */
function topTags(entries: MarketplaceEntry[], max = 12): string[] {
    const counts = new Map<string, number>();
    for (const entry of entries) {
        for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([tag]) => tag);
}

/** mcp.json payload for a catalog install. `autoApprove` is DELIBERATELY never
 *  set from a catalog: only the vendored curated list may pre-trust a tool. */
function payloadFromInstall(name: string, install: MarketplaceInstall): McpServerPayload {
    if (install.kind === 'remote') {
        return { name, type: install.type, url: install.url };
    }
    return {
        name,
        type: 'stdio',
        command: install.command,
        args: install.args.length ? install.args : undefined,
        env: install.env && Object.keys(install.env).length ? install.env : undefined,
    };
}

export function CapabilitiesPage({
    onBack,
    onOpenRawSettings,
    servers,
    hasWorkspace,
    legacyInUse,
    marketplace,
    marketplaceDetection,
    onMarketplaceLoad,
    onMarketplaceDetect,
    onMarketplaceClearDetection,
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
    const [tab, setTab] = useState<'servers' | 'marketplace' | 'skills'>('servers');
    const [newServerTarget, setNewServerTarget] = useState<McpSaveTarget>('global');
    // Marketplace tab: query input, the query the last request carried, the
    // source/tag filters, and the row awaiting its confirm step.
    const [marketQuery, setMarketQuery] = useState('');
    const [marketSource, setMarketSource] = useState<'all' | MarketplaceSource>('all');
    const [marketTag, setMarketTag] = useState<string | null>(null);
    /** How many filtered rows are currently mounted. */
    const [marketLimit, setMarketLimit] = useState(MARKET_PAGE);
    const [armedAdd, setArmedAdd] = useState<string | null>(null);
    const [detecting, setDetecting] = useState<string | null>(null);
    const [detectMiss, setDetectMiss] = useState<string | null>(null);
    const sentMarketQuery = useRef('');
    const [draft, setDraft] = useState<Draft | null>(null);
    const [draftInitial, setDraftInitial] = useState<Draft | null>(null);
    const [draftError, setDraftError] = useState<string | null>(null);
    /** Amber, non-blocking note in the editor (e.g. a guessed install). */
    const [draftNotice, setDraftNotice] = useState<string | null>(null);
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
        setDraftNotice(null);
    };

    const closeEditor = () => {
        if (draftDirty && !window.confirm(t('mcpDiscardConfirm'))) return;
        setDraft(null);
        setDraftInitial(null);
        setDraftError(null);
        setDraftNotice(null);
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

    /** Unique name within the DESTINATION file only - same-name entries in
     *  different files are legal workspace-override semantics. */
    const uniqueName = (base: string): string => {
        const mates = matesForTarget(newServerTarget);
        let name = base;
        let n = 2;
        while (mates.some((s) => s.name === name)) name = `${base}-${n++}`;
        return name;
    };

    /** Write a marketplace entry straight to config - only ever after the
     *  user confirmed the exact command in that row's confirm panel. */
    const addFromMarketplace = (entry: MarketplaceEntry) => {
        if (!entry.install) return;
        commitNew(newServerTarget, payloadFromInstall(uniqueName(entry.serverName), entry.install));
        setArmedAdd(null);
    };

    /** Open the editor prefilled from a catalog entry. Used whenever a direct
     *  write would be wrong: the install needs a secret, or it came from
     *  README detection (guessed), or the catalog shipped no install block. */
    const openEditorFromEntry = (
        entry: MarketplaceEntry,
        install: MarketplaceInstall | null,
        notice: string | null = null,
    ) => {
        const d = emptyDraft();
        d.name = uniqueName(entry.serverName);
        if (install && install.kind === 'stdio') {
            d.type = 'stdio';
            d.command = install.command;
            d.argsText = install.args.join('\n');
            d.envText = install.env ? JSON.stringify(install.env, null, 2) : '';
        } else if (install && install.kind === 'remote') {
            d.type = install.type === 'sse' ? 'sse' : 'streamableHttp';
            d.url = install.url;
        }
        setArmedAdd(null);
        setDetecting(null);
        setDraft(d);
        setDraftInitial(d);
        setDraftError(null);
        setDraftNotice(notice);
        // The edit form lives in the servers tab - land the user where the
        // prefilled draft is actually visible.
        setTab('servers');
    };

    const requestDetect = (entry: MarketplaceEntry) => {
        setDetectMiss(null);
        setDetecting(entry.id);
        onMarketplaceDetect(entry.id);
    };

    // README detection result: open the editor prefilled so the guessed
    // command is reviewed, or flag the row when nothing runnable was found.
    useEffect(() => {
        if (!marketplaceDetection) return;
        if (marketplaceDetection.id !== detecting) return;
        const entry = marketplace?.entries.find((e) => e.id === marketplaceDetection.id) ?? null;
        setDetecting(null);
        onMarketplaceClearDetection();
        if (!entry) return;
        if (marketplaceDetection.install) openEditorFromEntry(entry, marketplaceDetection.install, t('mcpMarketDetectedWarn'));
        else setDetectMiss(entry.id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [marketplaceDetection]);

    // Load the catalog the first time the tab is opened - never on mount, so
    // editing servers does not pay for a catalog fetch.
    useEffect(() => {
        if (tab !== 'marketplace' || marketplace) return;
        onMarketplaceLoad('', false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, marketplace]);

    // Debounced search: a non-empty query also triggers a live registry query
    // host-side, so keystrokes must not each become a request.
    useEffect(() => {
        if (tab !== 'marketplace') return;
        const next = marketQuery.trim();
        if (next === sentMarketQuery.current) return;
        const handle = setTimeout(() => {
            sentMarketQuery.current = next;
            onMarketplaceLoad(next, false);
        }, 400);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [marketQuery, tab]);

    // A new query or filter starts a fresh window - otherwise a narrowed list
    // would inherit the previous "show more" expansion.
    useEffect(() => {
        setMarketLimit(MARKET_PAGE);
    }, [marketQuery, marketSource, marketTag]);

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
                {draftNotice && (
                    <div className="mcp-hint warn" role="status">
                        <TriangleAlert size={12} aria-hidden="true" />
                        <span>{draftNotice}</span>
                    </div>
                )}
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

    /** Confirm step for one row: shows the EXACT payload before it is written.
     *  A remote catalog is untrusted input, so nothing is saved silently and
     *  entries needing a secret are routed to the editor instead. */
    const renderConfirm = (entry: MarketplaceEntry) => {
        const install = entry.install as MarketplaceInstall;
        const payload = payloadFromInstall(uniqueName(entry.serverName), install);
        // A remote entry can need a credential too (it goes in a header we
        // must not guess), so both kinds are checked before a direct write.
        const envVars = install.envVars ?? [];
        const requiredEnv = envVars.filter((v) => v.required);
        return (
            <div className="mp-confirm" dir="ltr">
                <div className="mp-confirm-head">{t('mcpMarketConfirmTitle')}</div>
                <pre className="mp-confirm-json">{JSON.stringify(payload, null, 2)}</pre>
                {requiredEnv.length > 0 && (
                    <div className="mcp-hint warn" role="status">
                        <KeyRound size={11} aria-hidden="true" />
                        <span>
                            {tf('mcpMarketNeedsKeyHint', { name: requiredEnv.map((v) => v.name).join(', ') })}
                            {requiredEnv[0].url && (
                                <>
                                    {' '}
                                    <a href={requiredEnv[0].url} target="_blank" rel="noreferrer">
                                        {t('mcpMarketGetKey')}
                                    </a>
                                </>
                            )}
                        </span>
                    </div>
                )}
                {entry.installConfidence === 'detected' && (
                    <div className="mcp-hint-text warn-text">{t('mcpMarketDetectedWarn')}</div>
                )}
                <div className="mcp-form-actions">
                    {requiredEnv.length > 0 ? (
                        <button type="button" className="mcp-save" onClick={() => openEditorFromEntry(entry, install)}>
                            <Pencil size={13} />
                            {t('mcpMarketAddAndEdit')}
                        </button>
                    ) : (
                        <button type="button" className="mcp-save" onClick={() => addFromMarketplace(entry)}>
                            <Check size={13} />
                            {t('mcpMarketConfirm')}
                        </button>
                    )}
                    <button type="button" className="settings-ghost-action" onClick={() => setArmedAdd(null)}>
                        {t('mcpCancel')}
                    </button>
                    {entry.repoUrl && (
                        <a className="mp-link" href={entry.repoUrl} target="_blank" rel="noreferrer">
                            <ExternalLink size={11} />
                            {t('mcpMarketOpenRepo')}
                        </a>
                    )}
                </div>
            </div>
        );
    };

    /** The live marketplace: rows come from remote catalogs (fetched host-side)
     *  plus the vendored curated list, which keeps it usable offline. */
    const renderMarketplace = () => {
        const entries = marketplace?.entries ?? [];
        const matching = entries
            .filter((entry) => marketSource === 'all' || entry.source === marketSource)
            .filter((entry) => !marketTag || entry.tags.includes(marketTag));
        const rows = matching.slice(0, marketLimit);
        const hiddenRows = matching.length - rows.length;
        const tags = topTags(entries);
        const stale = !!marketplace && marketplace.query !== marketQuery.trim();
        const status = !marketplace
            ? t('mcpMarketLoading')
            : marketplace.status === 'live'
                ? t('mcpMarketStatusLive')
                : marketplace.status === 'cached'
                    ? t('mcpMarketStatusCached')
                    : t('mcpMarketStatusOffline');

        const renderRow = (entry: MarketplaceEntry) => {
            const added = matesForTarget(newServerTarget).some((s) => s.name === entry.serverName);
            const armed = armedAdd === entry.id;
            const busy = detecting === entry.id;
            const preview = installPreview(entry.install);
            const needsKey = !!entry.requiresApiKey || !!entry.install?.envVars?.some((v) => v.required);
            const summary = entrySummary(entry);
            return (
                <div key={entry.id}>
                    <div className={`mcp-row mp-row ${armed ? 'armed' : ''}`} dir="ltr">
                        <div className="mcp-row-main">
                            <span className="mcp-row-title">
                                <strong dir="auto">{entryName(entry)}</strong>
                                <span
                                    className={`mcp-badge src-${entry.source}`}
                                    title={marketSourceHint(entry.source)}
                                >
                                    {marketSourceLabel(entry.source)}
                                </span>
                                {entry.verified && (
                                    <span className="mcp-badge verified">
                                        <ShieldCheck size={9} />
                                        {t('mcpMarketVerified')}
                                    </span>
                                )}
                                {entry.recommended && <span className="mcp-badge featured">{t('mcpMarketRecommended')}</span>}
                                {needsKey && (
                                    <span className="mcp-badge warn">
                                        <KeyRound size={9} />
                                        {t('mcpMarketNeedsKey')}
                                    </span>
                                )}
                            </span>
                            {/* A Persian subtitle still renders its own script
                                correctly - bidi keeps an RTL run intact - but it
                                must not re-align to the right edge while the name
                                above and the command below sit left. */}
                            {summary && <span className="mcp-row-meta">{summary}</span>}
                            <span className="mp-meta" dir="ltr">
                                {entry.author && <span className="mp-meta-item">{entry.author}</span>}
                                {entry.version && <span className="mp-meta-item">{`v${entry.version}`}</span>}
                                {entry.stars != null && (
                                    <span className="mp-meta-item">
                                        <Star size={10} />
                                        {formatCount(entry.stars)}
                                    </span>
                                )}
                                {entry.downloads != null && (
                                    <span className="mp-meta-item">
                                        <Download size={10} />
                                        {formatCount(entry.downloads)}
                                    </span>
                                )}
                                {preview && <code className="mp-cmd" title={preview}>{preview}</code>}
                            </span>
                            {detectMiss === entry.id && (
                                <span className="mcp-hint-text warn-text">{t('mcpMarketDetectFailed')}</span>
                            )}
                        </div>
                        <div className="mcp-row-actions">
                            {added ? (
                                <span className="mcp-added-pill">
                                    <Check size={11} />
                                    {t('mcpRegExists')}
                                </span>
                            ) : entry.install ? (
                                <button
                                    type="button"
                                    className="settings-ghost-action"
                                    aria-expanded={armed}
                                    onClick={() => setArmedAdd(armed ? null : entry.id)}
                                >
                                    <Plus size={12} />
                                    {t('mcpRegAdd')}
                                </button>
                            ) : (
                                <>
                                    {entry.repoUrl && (
                                        <button
                                            type="button"
                                            className="settings-ghost-action"
                                            disabled={busy}
                                            onClick={() => requestDetect(entry)}
                                        >
                                            {busy ? <RefreshCw size={12} className="spinning" /> : <Globe size={12} />}
                                            {busy ? t('mcpMarketDetecting') : t('mcpMarketDetect')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="settings-ghost-action"
                                        onClick={() => openEditorFromEntry(entry, null)}
                                    >
                                        <Pencil size={12} />
                                        {t('mcpMarketManual')}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    {armed && entry.install && renderConfirm(entry)}
                </div>
            );
        };

        return (
            <section className="settings-card">
                <div className="settings-section-head">
                    <div className="settings-section-icon" aria-hidden="true">
                        <Store size={15} />
                    </div>
                    <div>
                        <h3>{t('mcpMarketTab')}</h3>
                        <p>{t('mcpMarketSectionDesc')}</p>
                    </div>
                    <button
                        type="button"
                        className="cred-local-connect"
                        onClick={() => {
                            sentMarketQuery.current = marketQuery.trim();
                            onMarketplaceLoad(marketQuery.trim(), true);
                        }}
                    >
                        <RefreshCw size={13} />
                        {t('mcpMarketRefresh')}
                    </button>
                </div>

                <div className="settings-card-body">
                    <div className="mp-search">
                        <Search size={13} aria-hidden="true" />
                        <input
                            type="text"
                            dir={getLocale() === 'fa' ? 'rtl' : 'ltr'}
                            value={marketQuery}
                            onChange={(e) => setMarketQuery(e.target.value)}
                            placeholder={t('mcpMarketSearchPlaceholder')}
                            aria-label={t('mcpMarketSearchPlaceholder')}
                        />
                        {marketQuery !== '' && (
                            <button
                                type="button"
                                className="icon-btn"
                                title={t('mcpMarketClearSearch')}
                                aria-label={t('mcpMarketClearSearch')}
                                onClick={() => setMarketQuery('')}
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>

                    {/* Two separate decisions - WHICH catalog an entry comes from,
                        and WHAT KIND of server it is. No visible captions: each
                        chip set is self-evident, and the divider keeps them
                        apart. The aria-labels carry the meaning for screen
                        readers, which the captions never did. */}
                    <div className="mp-filters">
                        <div className="mp-filter-group" role="group" aria-label={t('mcpMarketFilterSource')}>
                            <button
                                type="button"
                                className={marketSource === 'all' ? 'lang-chip active' : 'lang-chip'}
                                onClick={() => setMarketSource('all')}
                            >
                                {t('mcpMarketSourceAll')}
                            </button>
                            {(['curated', 'cline', 'official', 'remote'] as MarketplaceSource[])
                                .filter((source) => entries.some((entry) => entry.source === source))
                                .map((source) => (
                                    <button
                                        key={source}
                                        type="button"
                                        className={marketSource === source ? 'lang-chip active' : 'lang-chip'}
                                        title={marketSourceHint(source)}
                                        onClick={() => setMarketSource(source)}
                                    >
                                        {marketSourceLabel(source)}
                                    </button>
                                ))}
                        </div>
                        {tags.length > 0 && (
                            <div className="mp-filter-group" role="group" aria-label={t('mcpMarketFilterTags')}>
                                    {tags.map((tag) => (
                                        <button
                                            key={tag}
                                            type="button"
                                            dir="auto"
                                            className={marketTag === tag ? 'lang-chip active' : 'lang-chip'}
                                            onClick={() => setMarketTag(marketTag === tag ? null : tag)}
                                        >
                                            {tagLabel(tag, marketplace?.tagLabels)}
                                        </button>
                                    ))}
                            </div>
                        )}
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

                    <div
                        className="mp-status"
                        dir="auto"
                        title={marketplace?.sources.length ? marketplace.sources.join('\n') : undefined}
                    >
                        <span className={`mp-dot ${marketplace?.status ?? 'loading'}`} aria-hidden="true" />
                        <span>{status}</span>
                        {marketplace && <span className="mp-status-sep">{'\u00b7'}</span>}
                        {marketplace && <span>{tf('mcpMarketCount', { n: formatCount(matching.length) })}</span>}
                        {marketplace?.liveSearch && <span className="mp-status-sep">{'\u00b7'}</span>}
                        {marketplace?.liveSearch && <span>{t('mcpMarketLiveSearch')}</span>}
                        {stale && <span className="mp-status-sep">{'\u00b7'}</span>}
                        {stale && <span>{t('mcpMarketSearching')}</span>}
                    </div>
                    {marketplace?.error && (
                        <div className="mcp-hint warn" role="status">
                            <TriangleAlert size={12} aria-hidden="true" />
                            <span>{`${t('mcpMarketError')} (${marketplace.error})`}</span>
                        </div>
                    )}

                    {!marketplace && (
                        <div className="mcp-empty">
                            <RefreshCw size={18} className="spinning" />
                            <span>{t('mcpMarketLoading')}</span>
                        </div>
                    )}
                    {marketplace && rows.length === 0 && (
                        <div className="mcp-empty">
                            <Search size={18} />
                            <strong>{t('mcpMarketEmpty')}</strong>
                        </div>
                    )}
                    {rows.map(renderRow)}

                    {hiddenRows > 0 && (
                        <button
                            type="button"
                            className="mp-more"
                            onClick={() => setMarketLimit((n) => n + MARKET_PAGE)}
                        >
                            {tf('mcpMarketShowMore', { n: formatCount(hiddenRows) })}
                        </button>
                    )}

                    <div className="mcp-hint foot" role="note">
                        <Info size={12} aria-hidden="true" />
                        <span>{t('mcpMarketSecurityNote')}</span>
                    </div>
                </div>
            </section>
        );
    };

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
        // The marketplace card has its own (force) refresh; this one keeps the
        // header button honest when the marketplace tab is the active one.
        if (tab === 'marketplace') {
            sentMarketQuery.current = marketQuery.trim();
            onMarketplaceLoad(marketQuery.trim(), true);
        }
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
                        aria-selected={tab === 'marketplace'}
                        className={tab === 'marketplace' ? 'lang-chip active' : 'lang-chip'}
                        onClick={() => setTab('marketplace')}
                    >
                        {t('mcpMarketTab')}
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

                {tab === 'servers' && renderServersTab()}
                {tab === 'marketplace' && renderMarketplace()}
                {tab === 'skills' && renderSkillsTab()}

                {/* Apply-on-new-session semantics are fine print - footer, not header. */}
                <div className="mcp-hint foot" role="note">
                    <Info size={12} aria-hidden="true" />
                    <span>{tab === 'skills' ? t('skillsHint') : t('mcpApplyHint')}</span>
                </div>
            </div>
        </div>
    );
}

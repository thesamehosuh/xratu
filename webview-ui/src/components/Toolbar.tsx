import { NavigationResize } from './NavigationResize';
import brandMark from '../../../assets/brand/logo-outline.svg';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    Check,
    PanelLeft,
    PanelsTopLeft,
    PanelRight,
    Plus,
    FolderOpen,
    History,
    LayoutDashboard,
    ChevronDown,
    MessageSquarePlus,
    Pencil,
    Search,
    Settings,
    Trash2,
    X,
} from 'lucide-react';
import type { ConnectionStatus as ConnStatus, SessionMeta } from '../types';
import { t } from '../i18n';
import { formatFullTimestamp } from '../datetime';

export type SessionsScope = 'workspace' | 'all';

interface ToolbarProps {
    conn: ConnStatus;
    destinationLabel?: string;
    onBackWork?: () => void;
    onOpenHistory?: () => void;
    onOpenWorkspace?: () => void;
    settingsNavigation?: ReactNode;
    workNavigation?: ReactNode;
    tabsVisible?: boolean;
    sideOpen?: boolean;
    onToggleTabs?: () => void;
    onToggleSide?: () => void;
    onAddTab?: () => void;
    workspaceLabel?: string | null;
    yolo: boolean;
    plan: boolean;
    sessionTitle: string | null;
    sessionsOpen: boolean;
    sessions: SessionMeta[];
    sessionsLoading: boolean;
    currentSessionId: string | null;
    sessionsScope: SessionsScope;
    /** Session-picker search text (host does the full-text search). */
    sessionQuery: string;
    /** Search hits for `sessionQuery` (null while idle / not yet returned). */
    searchResults: SessionMeta[] | null;
    onSessionQuery: (query: string) => void;
    onNewSession: () => void;
    onToggleSessions: () => void;
    onSessionsScope: (scope: SessionsScope) => void;
    onOpenSession: (id: string) => void;
    onRenameSession: (id: string, title: string) => void;
    onDeleteSession: (id: string) => void;
    onToggleYolo: () => void;
    onTogglePlan: () => void;
    onEditCredentials?: () => void;
    onOpenSettings?: () => void;
}

function timeGroup(ts: number): 'today' | 'yesterday' | 'week' | 'older' {
    const now = new Date();
    const then = new Date(ts);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= startOfToday) return 'today';
    if (ts >= startOfToday - 86_400_000) return 'yesterday';
    if (ts >= startOfToday - 6 * 86_400_000) return 'week';
    void then;
    return 'older';
}

const GROUP_ORDER: Array<'today' | 'yesterday' | 'week' | 'older'> = ['today', 'yesterday', 'week', 'older'];
const GROUP_KEYS = { today: 'sessionsToday', yesterday: 'sessionsYesterday', week: 'sessionsLastWeek', older: 'sessionsOlder' } as const;

export function Toolbar({
    conn: _conn, workspaceLabel, destinationLabel, onBackWork, onOpenHistory, onOpenWorkspace, settingsNavigation, workNavigation, tabsVisible, sideOpen, onToggleTabs, onToggleSide, onAddTab,
    sessionTitle, sessionsOpen, sessions, sessionsLoading, currentSessionId, sessionsScope,
    sessionQuery, searchResults, onSessionQuery,
    onNewSession, onToggleSessions, onSessionsScope, onOpenSession, onRenameSession, onDeleteSession,
    onOpenSettings,
}: ToolbarProps) {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const searchInput = useRef<HTMLInputElement>(null);
    const searchTrigger = useRef<HTMLButtonElement>(null);
    const rootRef = useRef<HTMLElement | null>(null);

    useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);

    // Click-outside closes the panel (mousedown so it beats the row click).
    useEffect(() => {
        if (!sessionsOpen) return;
        const onDown = (e: MouseEvent) => {
            if (window.innerWidth < 860 && rootRef.current && !rootRef.current.contains(e.target as Node)) onToggleSessions();
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [sessionsOpen, onToggleSessions]);

    // Reset transient row states when the panel closes.
    useEffect(() => {
        if (!sessionsOpen) {
            setEditingId(null);
            setConfirmId(null);
        }
    }, [sessionsOpen]);

    const startNewSession = () => {
        if (sessionsOpen) onToggleSessions();
        onNewSession();
    };

    const grouped = new Map<string, SessionMeta[]>();
    for (const item of sessions) {
        const g = timeGroup(item.updatedAt);
        if (!grouped.has(g)) grouped.set(g, []);
        grouped.get(g)!.push(item);
    }
    const searching = sessionQuery.trim().length > 0;
    const searchVisible = searchOpen || searching;

    /** One session row (shared by the grouped list and search results). */
    const renderRow = (item: SessionMeta) => (
        <div
            key={item.id}
            className={`session-row${item.id === currentSessionId ? ' current' : ''}`}
        >
            {editingId === item.id ? (
                <form
                    className="session-row-edit"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const clean = editValue.trim();
                        if (clean) onRenameSession(item.id, clean);
                        setEditingId(null);
                    }}
                >
                    <input
                        className="session-edit-input"
                        value={editValue}
                        autoFocus
                        dir="auto"
                        maxLength={128}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingId(null);
                            e.stopPropagation();
                        }}
                    />
                    <button type="submit" className="ghost-btn small" aria-label={t('sessionsRename')} title={t('sessionsRename')}>
                        <Check size={13} />
                    </button>
                    <button type="button" className="ghost-btn small" onClick={() => setEditingId(null)} aria-label={t('editCancel')} title={t('editCancel')}>
                        <X size={13} />
                    </button>
                </form>
            ) : confirmId === item.id ? (
                <div className="session-row-confirm">
                    <span className="session-row-confirm-text">{t('sessionsDeleteConfirm')}</span>
                    <button type="button" className="session-danger" onClick={() => { onDeleteSession(item.id); setConfirmId(null); }}>
                        {t('sessionsDelete')}
                    </button>
                    <button type="button" className="ghost-btn small" onClick={() => setConfirmId(null)} aria-label={t('editCancel')} title={t('editCancel')}>
                        <X size={13} />
                    </button>
                </div>
            ) : (
                <>
                    <button
                        type="button"
                        className="session-row-main"
                        onClick={() => onOpenSession(item.id)}
                        aria-current={item.id === currentSessionId ? 'page' : undefined}
                        title={`${t(item.engineId === 'opencode' ? 'engineOpenCode' : 'engineXratu')} · ${formatFullTimestamp(item.updatedAt)}`}
                    >
                        <span className="session-row-title" dir="auto">{item.title || t('sessionsUntitled')}</span>
                    </button>
                    <button
                        type="button"
                        className="ghost-btn small session-row-action"
                        onClick={() => { setEditingId(item.id); setEditValue(item.title); }}
                        aria-label={t('sessionsRename')}
                        title={t('sessionsRename')}
                    >
                        <Pencil size={12} />
                    </button>
                    <button
                        type="button"
                        className="ghost-btn small session-row-action session-row-delete"
                        onClick={() => setConfirmId(item.id)}
                        aria-label={t('sessionsDelete')}
                        title={t('sessionsDelete')}
                    >
                        <Trash2 size={12} />
                    </button>
                </>
            )}
        </div>
    );

    return (
        <header className="toolbar" ref={rootRef}>
            <button type="button" className="ghost-btn sidebar-toggle" onClick={onToggleSessions} aria-expanded={sessionsOpen} aria-label={t('surfaceToggleNavigation')} title={t('surfaceToggleNavigation')}><PanelLeft size={16} /></button>
            {(!settingsNavigation || destinationLabel !== t('settingsTitle')) && <><span className="workspace-breadcrumb toolbar-product-name">{t(settingsNavigation ? 'settingsTitle' : 'miniApp')}</span><span className="toolbar-divider">/</span></>}
            <div className="toolbar-heading">
                <button
                    type="button"
                    className={`session-btn${sessionsOpen ? ' open' : ''}`}
                    onClick={onToggleSessions}
                    aria-expanded={sessionsOpen}
                    aria-label={t(destinationLabel ? 'surfaceToggleNavigation' : 'sessionsTitle')}
                    title={destinationLabel ? t('surfaceToggleNavigation') : sessionTitle || t('sessionsUntitled')}
                >
                    <span className="session-btn-title" dir="auto">{destinationLabel || sessionTitle || t('sessionsUntitled')}</span>
                    <ChevronDown size={13} className="session-btn-chevron" />
                </button>
                {workspaceLabel && <span className="workspace-breadcrumb" dir="ltr" title={workspaceLabel}>{workspaceLabel}</span>}
            </div>
            <button type="button" className="ghost-btn toolbar-new-chat" onClick={startNewSession} aria-label={t('newSession')} title={t('newSession')}><MessageSquarePlus size={15} /></button>
            <div className="toolbar-group toolbar-tools">
                {destinationLabel && <button type="button" className="ghost-btn toolbar-back-work" onClick={onBackWork} aria-label={t('surfaceBack')} title={t('surfaceBack')}><X size={16} /></button>}
                <button type="button" className="ghost-btn" onClick={onToggleTabs} aria-pressed={tabsVisible} aria-label={t('surfaceToggleTabs')} title={t('surfaceToggleTabs')}><PanelsTopLeft size={15} /></button>
                <button type="button" className="ghost-btn" onClick={onToggleSide} aria-pressed={sideOpen} aria-label={t('surfaceToggleDock')} title={t('surfaceToggleDock')}><PanelRight size={15} /></button>
                <button type="button" className="ghost-btn" onClick={onAddTab} aria-label={t('surfaceAddTab')} title={t('surfaceAddTab')}><Plus size={16} /></button>
            </div>
            {sessionsOpen && (
                <aside className="session-pop workspace-sidebar" aria-label={t('surfaceWorkspace')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onToggleSessions(); rootRef.current?.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus(); } }}>
                    <NavigationResize /><div className="workspace-sidebar-brand"><span className="xratu-brand-mark" style={{ maskImage: `url("${brandMark}")` }} aria-hidden="true" /><strong>{t('miniApp')}</strong></div>
                    {settingsNavigation ?? <>
                    <div className="workspace-directory"><FolderOpen size={16} /><span dir="ltr">{workspaceLabel || t('sessionsThisWorkspace')}</span></div>
                    <button type="button" className="workspace-new" onClick={startNewSession}><MessageSquarePlus size={15} /><span>{t('newSession')}</span></button>
                    <div className="workspace-nav-label">{t('surfaceWorkspace')}</div>
                    <nav className="workspace-views"><button type="button" onClick={onOpenWorkspace}><LayoutDashboard size={15} /><span>{t('surfaceWorkspace')}</span></button><button type="button" onClick={onOpenHistory}><History size={15} /><span>{t('surfaceHistory')}</span></button></nav>
                    {workNavigation}
                    <div className="workspace-nav-label">{t('sessionsTitle')}</div>
                    <div className="session-pop-head" role="group" aria-label={t('sessionsTitle')}>
                        <button
                            type="button"
                            className={`session-scope${sessionsScope === 'workspace' ? ' active' : ''}`}
                            aria-pressed={sessionsScope === 'workspace'}
                            onClick={() => onSessionsScope('workspace')}
                        >
                            {t('sessionsThisWorkspace')}
                        </button>
                        <button
                            type="button"
                            className={`session-scope${sessionsScope === 'all' ? ' active' : ''}`}
                            aria-pressed={sessionsScope === 'all'}
                            onClick={() => onSessionsScope('all')}
                        >
                            {t('sessionsAllWorkspaces')}
                        </button>
                        <button ref={searchTrigger} type="button" className="ghost-btn session-search-toggle" aria-label={t('sessionsSearch')} title={t('sessionsSearch')} aria-expanded={searchVisible} onClick={() => { setSearchOpen(!searchVisible); if (searchVisible) onSessionQuery(''); }}><Search size={14} /></button>
                    </div>
                    {searchVisible && <div className="session-search">
                        <Search size={13} />
                        <input
                            ref={searchInput}
                            type="text"
                            dir="auto"
                            value={sessionQuery}
                            onChange={(e) => onSessionQuery(e.target.value)}
                            placeholder={t('sessionsSearch')}
                            aria-label={t('sessionsSearch')}
                            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onSessionQuery(''); setSearchOpen(false); searchTrigger.current?.focus(); } }}
                        />
                    </div>}
                    <div className="session-pop-list">
                        {searching ? (
                            <>
                                {searchResults === null && (
                                    <div className="session-empty">{t('sessionsSearching')}</div>
                                )}
                                {searchResults !== null && searchResults.length === 0 && (
                                    <div className="session-empty">{t('sessionsNoMatch')}</div>
                                )}
                                {searchResults?.map((item) => renderRow(item))}
                            </>
                        ) : (
                            <>
                                {sessionsLoading && sessions.length === 0 && (
                                    <div className="session-empty">{t('sessionsLoading')}</div>
                                )}
                                {!sessionsLoading && sessions.length === 0 && (
                                    <div className="session-empty">{t('sessionsEmpty')}</div>
                                )}
                                {GROUP_ORDER.map((g) => {
                                    const items = grouped.get(g);
                                    if (!items || items.length === 0) return null;
                                    return (
                                        <div key={g}>
                                            <div className="session-group-label">{t(GROUP_KEYS[g])}</div>
                                            {items.map((item) => renderRow(item))}
                                        </div>
                                    );
                                })}
                            </>
                        )}
                    </div>
                    <button type="button" className="workspace-settings" onClick={onOpenSettings}><Settings size={15} /><span>{t('settingsTitle')}</span></button>
                    </>}
                </aside>
            )}
        </header>
    );
}

import { useEffect, useRef, useState } from 'react';
import {
    Check,
    ChevronDown,
    Link,
    ListChecks,
    MessageSquarePlus,
    MessagesSquare,
    Pencil,
    Blocks,
    Settings,
    Trash2,
    X,
    Zap,
} from 'lucide-react';
import type { ConnectionStatus as ConnStatus, SessionMeta } from '../types';
import { t } from '../i18n';

export type SessionsScope = 'workspace' | 'all';

interface ToolbarProps {
    conn: ConnStatus;
    yolo: boolean;
    plan: boolean;
    sessionTitle: string | null;
    sessionsOpen: boolean;
    sessions: SessionMeta[];
    sessionsLoading: boolean;
    currentSessionId: string | null;
    sessionsScope: SessionsScope;
    onNewSession: () => void;
    onToggleSessions: () => void;
    onSessionsScope: (scope: SessionsScope) => void;
    onOpenSession: (id: string) => void;
    onRenameSession: (id: string, title: string) => void;
    onDeleteSession: (id: string) => void;
    onToggleYolo: () => void;
    onTogglePlan: () => void;
    onEditCredentials?: () => void;
    onOpenCapabilities?: () => void;
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
    conn, yolo, plan,
    sessionTitle, sessionsOpen, sessions, sessionsLoading, currentSessionId, sessionsScope,
    onNewSession, onToggleSessions, onSessionsScope, onOpenSession, onRenameSession, onDeleteSession,
    onToggleYolo, onTogglePlan, onEditCredentials, onOpenCapabilities, onOpenSettings,
}: ToolbarProps) {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const rootRef = useRef<HTMLElement | null>(null);

    // Click-outside closes the panel (mousedown so it beats the row click).
    useEffect(() => {
        if (!sessionsOpen) return;
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) onToggleSessions();
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

    const grouped = new Map<string, SessionMeta[]>();
    for (const item of sessions) {
        const g = timeGroup(item.updatedAt);
        if (!grouped.has(g)) grouped.set(g, []);
        grouped.get(g)!.push(item);
    }
    const showWorkspace = sessionsScope === 'all';

    return (
        <header className="toolbar" ref={rootRef}>
            <div className="toolbar-group">
                <button
                    type="button"
                    className={`ghost-btn${plan ? ' active' : ''}`}
                    onClick={onTogglePlan}
                    aria-pressed={plan}
                    aria-label={t('planMode')}
                    title={t('planHint')}
                >
                    <ListChecks size={15} />
                </button>
                <button
                    type="button"
                    className={`ghost-btn${yolo ? ' active' : ''}`}
                    onClick={onToggleYolo}
                    aria-pressed={yolo}
                    aria-label={t('yoloMode')}
                    title={t('yoloMode')}
                >
                    <Zap size={15} />
                </button>
                <button
                    type="button"
                    className="ghost-btn"
                    onClick={onNewSession}
                    aria-label={t('newSession')}
                    title={t('newSession')}
                >
                    <MessageSquarePlus size={15} />
                </button>
            </div>
            <button
                type="button"
                className={`session-btn${sessionsOpen ? ' open' : ''}`}
                onClick={onToggleSessions}
                aria-expanded={sessionsOpen}
                aria-haspopup="listbox"
                aria-label={t('sessionsTitle')}
                title={sessionTitle || t('sessionsUntitled')}
            >
                <MessagesSquare size={13} />
                <span className="session-btn-title" dir="auto">{sessionTitle || t('sessionsUntitled')}</span>
                <ChevronDown size={13} className="session-btn-chevron" />
            </button>
            <div className="toolbar-group">
                {onEditCredentials && (
                    <button
                        type="button"
                        className="ghost-btn"
                        onClick={onEditCredentials}
                        aria-label={t('byokChipTitle')}
                        title={t('byokChipTitle')}
                    >
                        <Link size={15} />
                    </button>
                )}
                {onOpenCapabilities && (
                    <button
                        type="button"
                        className="ghost-btn"
                        onClick={onOpenCapabilities}
                        aria-label={t('capTitle')}
                        title={t('capTitle')}
                    >
                        <Blocks size={15} />
                    </button>
                )}
                {onOpenSettings && (
                    <button
                        type="button"
                        className="ghost-btn"
                        onClick={onOpenSettings}
                        aria-label={t('settingsTitle')}
                        title={t('settingsTitle')}
                    >
                        <Settings size={15} />
                    </button>
                )}
            </div>
            {sessionsOpen && (
                <div className="session-pop" role="listbox" aria-label={t('sessionsPick')}>
                    <div className="session-pop-head">
                        <button
                            type="button"
                            className={`session-scope${sessionsScope === 'workspace' ? ' active' : ''}`}
                            onClick={() => onSessionsScope('workspace')}
                        >
                            {t('sessionsThisWorkspace')}
                        </button>
                        <button
                            type="button"
                            className={`session-scope${sessionsScope === 'all' ? ' active' : ''}`}
                            onClick={() => onSessionsScope('all')}
                        >
                            {t('sessionsAllWorkspaces')}
                        </button>
                        <button
                            type="button"
                            className="ghost-btn small session-pop-close"
                            onClick={onToggleSessions}
                            aria-label={t('sessionsClose')}
                        >
                            <X size={13} />
                        </button>
                    </div>
                    <div className="session-pop-list">
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
                                    {items.map((item) => (
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
                                                        onClick={() => { if (item.id !== currentSessionId) onOpenSession(item.id); }}
                                                        disabled={item.id === currentSessionId}
                                                    >
                                                        <span className="session-row-title" dir="auto">{item.title || t('sessionsUntitled')}</span>
                                                        {showWorkspace && <span className="session-row-ws" dir="auto">{item.workspace}</span>}
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
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </header>
    );
}

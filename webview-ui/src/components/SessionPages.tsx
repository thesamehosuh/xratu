import type { SurfacePanel } from '../dockLayout';
import { PANEL_ICONS, PANEL_LABELS } from './SurfaceTabs';
import { Bot, ChevronLeft, ChevronRight, Clock3, MessageSquare, MessageSquarePlus, Search, ShieldCheck, SquareTerminal } from 'lucide-react';
import type { SessionMeta } from '../types';
import { getLocale, t } from '../i18n';
import { formatFullTimestamp, isSameLocalDay } from '../datetime';

/** Session destinations use the host's local index and the current run only. */
export function SessionPages({ history, sessions, loading, query, onQuery, onOpen, onNew, onConversation, onAgents, onBackground, pending, agents, background, onPanel }: {
    history: boolean; sessions: SessionMeta[]; loading: boolean; query: string; onQuery: (value: string) => void;
    onOpen: (id: string) => void; onNew: () => void; onConversation: () => void; onAgents: () => void; onBackground: () => void;
    pending: number; agents: number; background: number; onPanel: (panel: SurfacePanel) => void;
}) {
    const groups = history ? [{ label: 'sessionsToday' as const, items: sessions.filter(session => isSameLocalDay(new Date(session.updatedAt), new Date())) }, { label: 'sessionsOlder' as const, items: sessions.filter(session => !isSameLocalDay(new Date(session.updatedAt), new Date())) }] : [{ label: null, items: sessions }];
    const Forward = getLocale() === 'fa' ? ChevronLeft : ChevronRight;
    return <section className="settings-page sessions-page">
        <header className="settings-head"><h2>{t(history ? 'surfaceHistory' : 'surfaceWorkspace')}</h2><button type="button" className="page-add" onClick={onNew}><MessageSquarePlus size={15} /><span>{t('newSession')}</span></button></header>
        <div className="settings-scroll">
            {!history && (pending > 0 || agents > 0 || background > 0) && <div className="workspace-attention">
                {pending > 0 && <button type="button" onClick={onConversation}><ShieldCheck size={18} /><span>{t('surfaceNeedsInput')}</span><strong dir="ltr">{pending}</strong></button>}
                {agents > 0 && <button type="button" onClick={onAgents}><Bot size={18} /><span>{t('surfaceAgentRuns')}</span><strong dir="ltr">{agents}</strong></button>}
                {background > 0 && <button type="button" onClick={onBackground}><SquareTerminal size={18} /><span>{t('surfaceBackground')}</span><strong dir="ltr">{background}</strong></button>}
            </div>}
            {!history && <section className="workspace-tools" aria-label={t('surfaceProjectTools')}><h3>{t('surfaceProjectTools')}</h3><div>{(['changes', 'activity', 'agents', 'background', 'browser', 'downloads', 'pullRequests'] as const).map(panel => {
                const Icon = PANEL_ICONS[panel];
                const hints = { agents: 'surfaceAgentsHint', background: 'surfaceBackgroundHint', changes: 'surfaceChangesHint', activity: 'surfaceActivityHint', browser: 'surfaceBrowserHint', downloads: 'surfaceDownloadsHint', pullRequests: 'surfacePullRequestsHint' } as const;
                return <button type="button" key={panel} onClick={() => onPanel(panel)}><Icon size={19} /><span><strong>{t(PANEL_LABELS[panel])}</strong><small>{t(hints[panel])}</small></span></button>;
            })}</div></section>}
            {!history && <h3 className="workspace-recent-heading">{t('surfaceRecentSessions')}</h3>}
            <label className="inventory-search"><Search size={15} /><input type="search" dir="auto" value={query} onChange={event => onQuery(event.target.value)} placeholder={t('sessionsSearch')} aria-label={t('sessionsSearch')} /></label>
            <div className="session-destination-list">
                {!sessions.length && <div className="surface-empty-state"><Clock3 size={24} /><span>{t(loading ? 'sessionsLoading' : query ? 'sessionsNoMatch' : 'sessionsEmpty')}</span></div>}
                {groups.filter(group => group.items.length > 0).map(group => <section className="history-group" key={group.label ?? 'recent'}>{group.label && <h3>{t(group.label)}</h3>}{group.items.map(session => <button type="button" className="session-destination-row" key={session.id} onClick={() => onOpen(session.id)}>
                    <MessageSquare size={17} /><span className="session-destination-copy"><strong dir="auto">{session.title || t('sessionsUntitled')}</strong><small><span dir="ltr">{session.engineId === 'opencode' ? 'OpenCode 2' : 'Xratu'}{session.model ? ` / ${session.model}` : ''}</span><span dir="ltr">{session.workspace}</span></small></span><time title={formatFullTimestamp(session.updatedAt)}>{formatFullTimestamp(session.updatedAt)}</time><Forward size={14} />
                </button>)}</section>)}
            </div>
        </div>
    </section>;
}

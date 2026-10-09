import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, FolderOpen, RefreshCw, Search, TriangleAlert, Wrench } from 'lucide-react';
import { getLocale, t } from '../i18n';
import type { AgentProfileView } from '../types';

export function AgentsPage({ profiles, errorKey, onRefresh, onManage, onOpen }: {
    profiles: AgentProfileView[] | null;
    errorKey?: string;
    onRefresh: () => void;
    onManage: () => void;
    onOpen: (profile: AgentProfileView) => void;
}) {
    const [expanded, setExpanded] = useState<string | null>(null);
    useEffect(() => { onRefresh(); }, [onRefresh]);
    return (
        <section className="settings-page agents-page">
            <header className="settings-head"><h2>{t('surfaceAgents')}</h2>
                <button type="button" className="page-add" onClick={onManage}><FolderOpen size={12} />{t('surfaceManage')}</button>
                <button type="button" className="icon-btn" onClick={onRefresh} aria-label={t('surfaceRefresh')}><RefreshCw size={12} /></button>
            </header>
            <div className="settings-scroll agents-content">
                {errorKey && <p role="alert">{t(errorKey as Parameters<typeof t>[0])}</p>}
                {!profiles && <span className="step-status spinner" aria-label={t('working')} />}
                {profiles && ['builtin', 'custom'].map((group) => {
                    const list = profiles.filter((profile) => (profile.source === 'builtin') === (group === 'builtin'));
                    if (!list.length) return null;
                    return <div key={group} className="agent-group"><div className="agent-section-label">
                        <span>{t(group === 'builtin' ? 'surfaceBuiltIn' : 'surfaceCustomAgents')}</span><span dir="ltr">{list.length}</span>
                    </div>{list.map((profile) => {
                        const id = `${profile.source}:${profile.name}`;
                        const Icon = profile.error || profile.warning ? TriangleAlert : profile.name === 'explore' ? Search : profile.name === 'general' ? Wrench : Bot;
                        return <div key={id} className="agent-profile-wrap">
                            <button type="button" className="agent-profile" aria-expanded={expanded === id} onClick={() => setExpanded(expanded === id ? null : id)}>
                                <span className={`agent-profile-icon${profile.error ? ' error' : ''}`}><Icon size={14} /></span>
                                <span className="agent-profile-copy"><strong dir="ltr">{profile.name}</strong>
                                    <span>{profile.source === 'builtin' && profile.name === 'explore' ? t('surfaceReadOnly') : profile.source === 'builtin' && profile.name === 'general' ? t('surfaceEditVerify') : profile.description}</span>
                                </span>
                                {!profile.error && !profile.warning && <Check size={12} className="agent-ready" />}
                                <ChevronRight size={12} className={getLocale() === 'fa' ? 'rtl-flip' : undefined} />
                            </button>
                            {expanded === id && <div className="agent-profile-details">
                                {profile.error && <p className="mcp-row-error" role="alert">{profile.error}</p>}
                                {profile.warning && <p className="mcp-row-error">{profile.warning}</p>}
                                <p dir="auto">{profile.description}</p>
                                {profile.model && <code dir="ltr">{profile.model}{profile.reasoningEffort ? ` · ${profile.reasoningEffort}` : ''}</code>}
                                {profile.tools && <div className="agent-tools" aria-label={t('surfaceTools')}>{profile.tools.map((tool) => <code dir="ltr" key={tool}>{tool}</code>)}</div>}
                                {profile.editable && <button type="button" className="settings-ghost-action" onClick={() => onOpen(profile)}><FolderOpen size={12} />{t('surfaceOpenFile')}</button>}
                            </div>}
                        </div>;
                    })}</div>;
                })}
                <details className="agent-discovery"><summary>{t('surfaceDiscovery')}<ChevronDown size={12} /></summary>
                    <div className="agent-paths">{['.xratu/agents/', '.agents/agents/', '.claude/agents/'].map((path) => <code dir="ltr" key={path}>{path}</code>)}</div>
                </details>
            </div>
        </section>
    );
}

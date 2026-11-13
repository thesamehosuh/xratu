import { useEffect, useState } from 'react';
import { Bot, Check, ChevronDown, FolderOpen, RefreshCw, Search, TriangleAlert, Wrench } from 'lucide-react';
import { t } from '../i18n';
import type { AgentProfileView } from '../types';

export function AgentsPage({ profiles, errorKey, onRefresh, onManage, onOpen }: {
    profiles: AgentProfileView[] | null;
    errorKey?: string;
    onRefresh: () => void;
    onManage: () => void;
    onOpen: (profile: AgentProfileView) => void;
}) {
    const [query, setQuery] = useState('');
    const [source, setSource] = useState('all');
    const sourceLabel = (value: AgentProfileView['source']) => t(value === 'builtin' ? 'surfaceBuiltIn' : value === 'project-xratu' ? 'skillsSourceXratu' : value === 'project-agents' ? 'skillsSourceAgents' : value === 'project-claude' ? 'skillsSourceClaudeProject' : value === 'global-claude' ? 'skillsSourceClaudeGlobal' : 'skillsSourceGlobal');
    const [expanded, setExpanded] = useState<string | null>(null);
    const visibleProfiles = profiles?.filter(profile => (source === 'all' || profile.source.startsWith(`${source}-`)) && `${profile.name} ${profile.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const selected = visibleProfiles?.find(profile => `${profile.source}:${profile.name}` === expanded) ?? visibleProfiles?.[0];
    useEffect(() => { onRefresh(); }, [onRefresh]);
    return (
        <section className="settings-page agents-page">
            <header className="settings-head"><h2>{t('surfaceAgents')}</h2>
                <button type="button" className="page-add" onClick={onManage}><FolderOpen size={12} /><span>{t('surfaceManage')}</span></button>
                <button type="button" className="icon-btn" onClick={onRefresh} aria-label={t('surfaceRefresh')}><RefreshCw size={12} /></button>
            </header>
            <div className="settings-scroll agents-content">
                {errorKey && <p role="alert">{t(errorKey as Parameters<typeof t>[0])}</p>}
                {!profiles && !errorKey && <div className="agent-loading" role="status"><RefreshCw size={12} className="spinning" /><span>{t('working')}</span></div>}
                <div className="inventory-toolbar"><label className="inventory-search"><Search size={15} /><input type="search" dir="auto" value={query} onChange={event => setQuery(event.target.value)} aria-label={t('surfaceSearchInventory')} placeholder={t('surfaceSearchInventory')} /></label><div className="lang-choice">{(['all', 'project', 'global'] as const).map(value => <button type="button" key={value} className={`lang-chip${source === value ? ' active' : ''}`} aria-pressed={source === value} onClick={() => setSource(value)}>{t(value === 'all' ? 'surfaceAllSources' : value === 'project' ? 'mcpTargetWorkspace' : 'mcpTargetGlobal')}</button>)}</div></div>
                <div className="inventory-split"><div className="agent-inventory-list">
                {profiles && ['builtin', 'custom'].map((group) => {
                    const list = visibleProfiles!.filter((profile) => (profile.source === 'builtin') === (group === 'builtin'));
                    if (!list.length) return null;
                    return <div key={group} className="agent-group"><div className="agent-section-label">
                        <span>{t(group === 'builtin' ? 'surfaceBuiltIn' : 'surfaceCustomAgents')}</span><span dir="ltr">{list.length}</span>
                    </div>{list.map((profile) => {
                        const id = `${profile.source}:${profile.name}`;
                        const Icon = profile.error || profile.warning ? TriangleAlert : profile.name === 'explore' ? Search : profile.name === 'general' ? Wrench : Bot;
                        return <div key={id} className="agent-profile-wrap">
                            <button type="button" className={`agent-profile${selected === profile ? ' selected' : ''}`} aria-pressed={selected === profile} onClick={() => setExpanded(id)}>
                                <span className={`agent-profile-icon${profile.error ? ' error' : ''}`}><Icon size={14} /></span>
                                <span className="agent-profile-copy"><strong dir="ltr">{profile.name}</strong>
                                    <span>{profile.error ? t('surfaceAgentInvalid') : profile.warning ? t('surfaceAgentWarning') : profile.source === 'builtin' && profile.name === 'explore' ? t('surfaceReadOnly') : profile.source === 'builtin' && profile.name === 'general' ? t('surfaceEditVerify') : t('surfaceCustomAgent')}</span>
                                </span>
                                {!profile.error && !profile.warning && <Check size={12} className="agent-ready" />}
                            </button>
                        </div>;
                    })}</div>;
                })}
                {visibleProfiles?.length === 0 && <div className="inventory-no-results" role="status">{t('surfaceNoMatches')}</div>}
                <details className="agent-discovery"><summary><span>{t('surfaceDiscovery')}</span><ChevronDown size={12} /></summary>
                    <div className="agent-paths">{['.xratu/agents/', '.agents/agents/', '.claude/agents/'].map((path) => <code dir="ltr" key={path}>{path}</code>)}</div>
                </details>
                </div>
                {selected && <aside className="inventory-inspector" aria-label={t('miniDetails')}>
                    <h3 dir="ltr">{selected.name}</h3>
                    <div className="kv"><span>{t('surfaceSource')}</span><span>{sourceLabel(selected.source)}</span></div>
                    {selected.error && <p className="mcp-row-error" role="alert">{selected.error}</p>}
                    {selected.warning && <p className="mcp-row-error">{selected.warning}</p>}
                    <p dir="auto">{selected.description}</p>
                    {selected.model && <code dir="ltr">{selected.model}{selected.reasoningEffort ? ` · ${selected.reasoningEffort}` : ''}</code>}
                    {selected.tools && <div className="agent-tools" aria-label={t('surfaceTools')}>{selected.tools.map(tool => <code dir="ltr" key={tool}>{tool}</code>)}</div>}
                    {selected.editable && <button type="button" className="settings-ghost-action" onClick={() => onOpen(selected)}><FolderOpen size={12} /><span>{t('surfaceOpenFile')}</span></button>}
                </aside>}
                </div>
            </div>
        </section>
    );
}

import { toolArgs } from './ToolDetails';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Clock3, Cpu, Gauge, GitBranch, List, MessageSquare, ShieldAlert, X } from 'lucide-react';
import type { TranscriptPrefs } from '../transcriptPrefs';
import { agentMessage, type AgentRun } from '../subagentView';
import { MessageItem } from './MessageItem';
import { getLocale, t, tf, type Locale } from '../i18n';
import { formatFullTimestamp } from '../datetime';

export function agentStatusLabel(status: AgentRun['status']) { return t(({ queued: 'agentQueued', running: 'agentRunning', waiting: 'agentWaiting', done: 'agentDone', error: 'agentFailed', cancelled: 'agentCancelled', interrupted: 'agentInterrupted' } as const)[status]); }
function RunStatus({ status }: { status: AgentRun['status'] }) {
    return <span className={`agent-run-status ${status}`} title={agentStatusLabel(status)}>{status === 'running' ? <span className="spinner" aria-hidden="true" /> : status === 'waiting' ? <ShieldAlert size={12} /> : status === 'done' ? <Check size={12} /> : status === 'error' || status === 'cancelled' ? <X size={12} /> : <span className="agent-status-dot" />}</span>;
}
function RunClock({ run }: { run: AgentRun }) {
    const [now, setNow] = useState(Date.now);
    const live = ['running', 'waiting'].includes(run.status);
    useEffect(() => { if (!live) return; const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, [live]);
    const seconds = Math.max(0, Math.floor(((live ? now : run.trace?.endedAt ?? run.trace?.updatedAt ?? run.call.endedAt ?? run.createdAt) - (run.trace?.startedAt ?? run.createdAt)) / 1_000));
    return <span className="agent-metric" title={formatFullTimestamp(run.trace?.startedAt ?? run.createdAt)}><Clock3 size={12} /><span dir="ltr">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span></span>;
}

const RunView = memo(function RunView({ run, visible, onConversation, prefs, locale }: { run: AgentRun; visible: boolean; onConversation: () => void; prefs: TranscriptPrefs; locale: Locale }) {
    const [view, setView] = useState<'conversation' | 'activity'>('conversation');
    const pane = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    const trace = run.trace;
    const message = useMemo(() => agentMessage(run), [run]);
    const follow = useCallback(() => { if (visible && pinned.current && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }, [visible]);
    useLayoutEffect(follow, [trace, follow, view]);
    useEffect(() => {
        if (!content.current || !pane.current) return;
        const observer = new ResizeObserver(follow); observer.observe(content.current); observer.observe(pane.current);
        return () => observer.disconnect();
    }, [follow]);
    const pending = run.status === 'waiting';
    return <section className={`agent-run-view${visible ? '' : ' panel-hidden'}`} aria-hidden={!visible || undefined}>
        <header className="agent-run-head"><div className="agent-run-heading"><Bot size={15} /><strong dir="auto">{run.title || run.profile}</strong></div>
            <div className="agent-run-meta"><span className={`agent-state-text ${run.status}`}><RunStatus status={run.status} />{agentStatusLabel(run.status)}</span><RunClock run={run} />
                {trace?.resumed && <span title={t('agentResumed')}><GitBranch size={12} /></span>}
            </div>
            {trace && <div className="agent-run-meta technical"><span className="agent-metric"><Cpu size={12} /><code dir="ltr">{trace.model}</code></span>{trace.effort && <span className="agent-metric"><Gauge size={12} /><span dir="ltr">{trace.effort}</span></span>}
                <span className="agent-token-metric" title={t('agentTokens')} dir="ltr">{trace.inputTokens.toLocaleString('en-US')} ↓ &nbsp; {trace.outputTokens.toLocaleString('en-US')} ↑</span>
            </div>}
            <details className="agent-brief"><summary><ChevronDown size={11} />{t('agentTask')}<code dir="ltr">{trace?.taskId ?? run.profile}</code></summary>
                <p dir="auto">{trace?.prompt ?? String(toolArgs(run.call.text).prompt ?? '')}</p>
                {trace?.tools.length ? <div className="agent-capabilities" aria-label={t('agentAvailableTools')}>{trace.tools.map(tool => <code dir="ltr" key={tool}>{tool}</code>)}</div> : null}
            </details>
        </header>
        <div className="agent-view-tabs" role="tablist" aria-label={t('agentViews')}>
            {(['conversation', 'activity'] as const).map(id => <button type="button" key={id} role="tab" aria-selected={view === id} tabIndex={view === id ? 0 : -1} aria-controls={`agent-content-${run.id}`} className={view === id ? 'active' : ''} onKeyDown={event => { if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'conversation' : event.key === 'End' ? 'activity' : id === 'conversation' ? 'activity' : 'conversation'; setView(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-agent-view="${next}"]`)?.focus(); } }} data-agent-view={id} id={`agent-view-${run.id}-${id}`} onClick={() => setView(id)}>{id === 'conversation' ? <MessageSquare size={12} /> : <List size={12} />}{t(id === 'conversation' ? 'surfaceConversation' : 'surfaceActivity')}</button>)}
            <span dir="auto">{tf('subagentToolCalls', { count: String(trace?.toolCalls ?? 0) })}</span>
        </div>
        {pending && <div className="agent-approval-notice"><ShieldAlert size={13} /><span>{t('agentWaiting')}{trace?.pendingTools?.length ? <code dir="ltr">{trace.pendingTools.join(', ')}</code> : null}</span><button type="button" onClick={onConversation}>{t('agentOpenApproval')}</button></div>}
        <div ref={pane} id={`agent-content-${run.id}`} role="tabpanel" aria-labelledby={`agent-view-${run.id}-${view}`} className="agent-transcript" onClickCapture={event => { if ((event.target as HTMLElement).closest('summary')) pinned.current = false; }} onScroll={() => { const el = pane.current; if (el && visible) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
            <div ref={content}>
                {trace?.truncated && <p className="agent-history-note">{t('agentTraceLimited')}</p>}
                {trace?.entries.length ? <MessageItem message={message} observation activityOnly={view === 'activity'} transcriptPrefs={prefs} dir={locale === 'fa' ? 'rtl' : 'ltr'} />
                    : <div className="agent-empty"><Bot size={22} /><span>{run.status === 'queued' ? t('agentQueued') : run.call.result !== undefined ? t('agentLegacyTrace') : t('agentStarting')}</span>{run.call.live && <pre dir="ltr">{run.call.live}</pre>}</div>}
                {!trace && run.call.result !== undefined && <pre className="agent-legacy-report" dir="auto">{run.call.result}</pre>}
                {trace?.error && run.status !== 'done' && <div className="agent-run-error" dir="auto">{trace.error}</div>}
            </div>
        </div>
    </section>;
}, (a, b) => a.run.call === b.run.call && a.run.status === b.run.status && a.visible === b.visible && a.onConversation === b.onConversation && a.prefs === b.prefs && a.locale === b.locale);

export function SubagentsPanel({ runs, selectedId, onSelect, visible, panelClass, onConversation, prefs, sessionKey }: { runs: AgentRun[]; selectedId: string | null; onSelect: (id: string) => void; visible: boolean; panelClass: string; onConversation: () => void; prefs: TranscriptPrefs; sessionKey: string | null }) {
    const locale = getLocale();
    const selected = runs.find(run => run.id === selectedId) ?? runs.find(run => ['running', 'waiting'].includes(run.status)) ?? runs.at(-1);
    const [opened, setOpened] = useState<string[]>([]);
    useEffect(() => setOpened([]), [sessionKey]);
    const selectedKey = selected?.id;
    useEffect(() => { if (selectedKey && visible) setOpened(current => current.includes(selectedKey) ? current : [...current.slice(-7), selectedKey]); }, [selectedKey, visible]);
    const mounted = new Set([...opened, ...(selected && visible ? [selected.id] : [])]);
    return <div className={`agents-pane ${panelClass}`} id="surface-panel-agents" role="tabpanel" aria-labelledby="surface-tab-agents" aria-hidden={!visible || undefined}>
        <div className="agents-layout"><nav className="agent-run-list" aria-label={t('surfaceAgentRuns')}>{runs.map(run => {
            const current = run.trace?.entries.filter(entry => entry.kind === 'tool').at(-1);
            return <button type="button" className={`agent-run-card${run.id === selected?.id ? ' selected' : ''}`} key={run.id} aria-pressed={run.id === selected?.id} onClick={() => onSelect(run.id)}>
                <span className="agent-card-top"><Bot size={14} /><strong dir="auto">{run.profile}</strong><RunStatus status={run.status} /></span>
                <span className="agent-card-title" dir="auto">{run.title}</span>
                <span className="agent-card-foot"><span>{agentStatusLabel(run.status)}</span><span dir="ltr">{run.trace?.toolCalls ?? 0}<List size={10} /></span></span>
                {current && ['running', 'waiting'].includes(run.status) && <code className="agent-current-tool" dir="ltr">{current.tool}</code>}
            </button>;
        })}</nav><div className="agent-run-detail">{runs.filter(run => mounted.has(run.id)).map(run => <RunView key={run.id} run={run} visible={visible && selected?.id === run.id} onConversation={onConversation} prefs={prefs} locale={locale} />)}</div></div>
    </div>;
}

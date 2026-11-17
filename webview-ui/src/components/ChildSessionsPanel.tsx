import {toolLabel} from '../toolMeta';
import {composerDraftKey,readComposerDraft,saveComposerDraft} from '../composerDrafts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Bot, CornerDownLeft, Search, Square, Plus } from 'lucide-react';
import type { ChildSessionView } from '../../../src/sessions/view';
import { getLocale, t } from '../i18n';
import { RenderedMarkdown } from './RenderedMarkdown';

const statusKeys = { idle: 'childIdle', queued: 'agentQueued', running: 'agentRunning', stopping: 'childStopping', waiting_for_workspace: 'childWaitingWorkspace', waiting_for_approval: 'agentWaiting', waiting_for_answer: 'agentWaitingQuestion', completed: 'agentDone', failed: 'agentFailed', cancelled: 'agentCancelled', interrupted: 'agentInterrupted' } as const;

export function ChildSessionsPanel({ sessions, rootId, visible, panelClass, onAction, onParent, receipt, decisions, onNew }: {
    decisions: (parentCallId: string) => ReactNode;
    receipt: {sessionId: string; receipt?: string; accepted: boolean} | null;
    sessions: ChildSessionView[]; rootId: string; visible: boolean; panelClass: string;
    onAction: (root: string, id: string, action: 'send' | 'stop' | 'create' | 'configure' | 'report', text?: string, receipt?: string) => void;
    onParent: () => void;
    onNew: () => void;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [activity, setActivity] = useState(false);
    const [pending, setPending] = useState<Record<string, {receipt: string; text: string}>>({});
    const [sendError, setSendError] = useState<string | null>(null);
    useEffect(() => {
        if (!receipt?.receipt) return;
        setPending(current => {
            if (current[receipt.sessionId]?.receipt !== receipt.receipt) return current;
            const next = {...current}; delete next[receipt.sessionId]; return next;
        });
        if (!receipt.accepted) setSendError(receipt.sessionId);
        else {const sent=pending[receipt.sessionId];if(sent?.receipt===receipt.receipt && drafts[receipt.sessionId]?.trim()===sent.text){saveComposerDraft(composerDraftKey(`child:${rootId}`,receipt.sessionId),'',[]);setDrafts(current=>current[receipt.sessionId]?.trim()===sent.text?{...current,[receipt.sessionId]:''}:current);}}
    }, [receipt]);
    const pane = useRef<HTMLDivElement>(null);
    const following = useRef(true);
    const scroll = useRef<Record<string, number>>({});
    useEffect(() => { setSelected(null); setDrafts({}); setPending({}); setSendError(null); scroll.current = {}; }, [rootId]);
    const child = sessions.find(session => session.id === selected);
    useEffect(() => {
        if (!child) return;
        const sent = pending[child.id];
        if (sent && child.receipts?.some(receipt => receipt.id === sent.receipt)) {
            if(drafts[child.id]?.trim()===sent.text)saveComposerDraft(composerDraftKey(`child:${rootId}`,child.id),'',[]);
            setDrafts(current => current[child.id]?.trim() === sent.text ? {...current, [child.id]: ''} : current);
            setPending(current => { const next = {...current}; delete next[child.id]; return next; });
        }
    }, [child, pending]);
    const live = child && ['queued', 'running', 'waiting_for_workspace', 'stopping', 'waiting_for_approval', 'waiting_for_answer'].includes(child.state);
    useEffect(() => {
        if (pane.current && visible) pane.current.scrollTop = following.current ? pane.current.scrollHeight : scroll.current[selected ?? ''] ?? 0;
    }, [child?.revision, child?.displayRevision, selected, visible, activity]);
    const choose = (id: string | null) => {
        if (pane.current && selected) scroll.current[selected] = pane.current.scrollTop;
        following.current = scroll.current[id ?? ''] === undefined;
        if (id && drafts[id] === undefined) setDrafts(current => ({...current,[id]:readComposerDraft(composerDraftKey(`child:${rootId}`,id)).text}));
        setSelected(id);
    };
    const Back = getLocale() === 'fa' ? ArrowRight : ArrowLeft;
    return <div className={`agents-pane child-sessions ${panelClass}${child ? ' child-open' : ''}`} id="surface-panel-agents" role="tabpanel" aria-labelledby="surface-tab-agents" aria-hidden={!visible || undefined}>
        <aside className="child-session-list">
            <header><strong>{t('childSessions')}</strong><span dir="ltr">{sessions.length}</span>{!sessions.every(session=>session.configurable===false) && <button type="button" className="icon-btn" onClick={onNew} aria-label={t('childLaunch')}><Plus size={16}/></button>}</header>
            <label className="child-search"><Search size={14} /><input type="search" dir="auto" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('childSearch')} aria-label={t('childSearch')} /></label>
            <nav aria-label={t('childSessions')}>
                {(['active', 'finished'] as const).map(group => {
                    const list = sessions.filter(session => (['queued', 'running', 'waiting_for_workspace', 'stopping', 'waiting_for_approval', 'waiting_for_answer'].includes(session.state)) === (group === 'active'))
                        .filter(session => `${session.title} ${session.profile}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
                    return list.length > 0 && <section key={group}><h3>{t(group === 'active' ? 'agentActiveRuns' : 'agentFinishedRuns')}</h3>
                        {list.map(session => <button type="button" key={session.id} className={`child-session-row${selected === session.id ? ' selected' : ''}`} aria-pressed={selected === session.id} onClick={() => choose(session.id)}>
                            <span className="child-row-title"><Bot size={14} /><strong dir="auto">{session.title || session.profile}</strong></span>
                            <span className="child-row-state"><span>{t(statusKeys[session.state])}</span><span dir="auto">{session.profile}</span></span>
                        </button>)}
                    </section>;
                })}
            </nav>
            <button type="button" className="child-parent" onClick={onParent}><Back size={14} /><span>{t('surfaceBackToConversation')}</span></button>
        </aside>
        <section className="child-conversation">
            {child ? <>
                <header className="child-conversation-header"><button type="button" className="icon-btn child-back" aria-label={t('childSessions')} onClick={() => choose(null)}><Back size={16} /></button>
                    <div><strong dir="auto">{child.title || child.profile}</strong><span role="status">{t(statusKeys[child.state])}{child.queued > 0 ? ` · ${t('childInstructionQueued')}` : ''}</span></div>
                    {live && <button type="button" className="agent-run-stop" aria-label={t('agentStop')} disabled={child.state === 'stopping'} onClick={() => onAction(rootId, child.id, 'stop')}><Square size={13} /><span>{t('agentStop')}</span></button>}
                </header>
                {!child.readOnly && child.configurable!==false && <details className="child-settings" key={`settings-${child.id}`}><summary>{t('childConfiguration')}</summary>
                    <form onSubmit={event => {event.preventDefault();const data=new FormData(event.currentTarget);onAction(rootId,child.id,'configure',JSON.stringify({model:String(data.get('model')??''),effort:String(data.get('effort')??''),rounds:Number(data.get('rounds')),revision:child.revision}),crypto.randomUUID());}}>
                        <label>{t('surfaceModel')}<input name="model" dir="ltr" maxLength={300} defaultValue={child.model??''} disabled={!!live} /></label>
                        <label>{t('childEffort')}<select name="effort" dir="ltr" defaultValue={child.effort??''} disabled={!!live}>{['','none','minimal','low','medium','high','xhigh','max'].map(value=><option key={value} value={value}>{value||t('childInherit')}</option>)}</select></label>
                        <label>{t('childRoundLimit')}<input name="rounds" type="number" dir="ltr" min={1} max={500} defaultValue={child.rounds??50} disabled={!!live} /></label>
                        <button type="submit" className="secondary-btn" disabled={!!live}>{t('childSaveConfiguration')}</button>
                    </form>
                </details>}
                <div className="child-view-switch"><button type="button" aria-pressed={!activity} onClick={() => setActivity(false)}>{t('surfaceConversation')}</button><button type="button" aria-pressed={activity} onClick={() => setActivity(true)}>{t('surfaceActivity')}</button></div>
                {!child.readOnly && child.reportState && !live && <div className="child-result-toolbar"><span>{t(child.reportState==='delivered'?'childReported':'childResultReady')}</span>
                    {child.reportState==='pending' && <button type="button" className="secondary-btn" onClick={()=>onAction(rootId,child.id,'report',undefined,crypto.randomUUID())}>{t('childReport')}</button>}
                </div>}
                <div ref={pane} className="child-messages" role="log" aria-label={t('childConversation')} onScroll={() => {
                    if (!pane.current) return;
                    following.current = pane.current.scrollHeight - pane.current.scrollTop - pane.current.clientHeight < 48;
                    scroll.current[child.id] = pane.current.scrollTop;
                }}>
                    {child.limited && <p className="agent-history-note">{t('agentTraceLimited')}</p>}
                    {child.messages.filter(message => activity || message.role !== 'tool').map(message => <article key={message.id} className={`child-message ${message.role}${message.source==='parent'?' parent-instruction':''}`}>
                        {message.source==='parent' && <span className="child-source-label">{t('childParentSender')}</span>}
                        {message.role === 'tool' ? <details><summary>{t('childToolOutput')}</summary><pre dir="auto">{message.content}</pre></details> : message.html ? <RenderedMarkdown html={message.html} /> : <div className="child-message-text" dir="auto">{message.content}</div>}
                    </article>)}
                    {child.activeTool && <details className="child-message tool"><summary>{toolLabel(child.activeTool.name).fa}</summary><pre dir="auto">{child.activeTool.live}</pre></details>}
                    {child.liveText && <article className="child-message assistant" dir="auto">{child.liveText}</article>}
                    {child.errorKey && <p role="alert" className="agent-run-error">{t(child.errorKey)}</p>}
                    {child.error && <p role="alert" className="agent-run-error" dir="auto">{child.error}</p>}
                    {child.messages.length === 0 && <p className="child-empty">{t('agentStarting')}</p>}
                </div>
                {child.parentCallId && <div className="child-decisions">{decisions(child.parentCallId)}</div>}
                {!child.readOnly && <form className="child-composer" onSubmit={event => { event.preventDefault(); const text = drafts[child.id]?.trim(); if (!text) return; setSendError(null); const receipt = crypto.randomUUID(); setPending(current => ({...current, [child.id]: {receipt, text}})); onAction(rootId, child.id, 'send', text, receipt); }}>
                    {sendError === child.id && <p role="alert">{t('childActionFailed')}</p>}
                    <label htmlFor={`child-input-${child.id}`}>{t('childMessageTo')} <strong dir="auto">{child.title || child.profile}</strong></label>
                    <textarea id={`child-input-${child.id}`} dir="auto" rows={3} value={drafts[child.id] ?? ''} onChange={event => {const text=event.target.value;saveComposerDraft(composerDraftKey(`child:${rootId}`,child.id),text,[]);setDrafts(current => ({ ...current, [child.id]: text }));}} placeholder={t(live ? 'childQueueInstruction' : 'childContinueInstruction')} />
                    <button type="submit" className="secondary-btn" disabled={!drafts[child.id]?.trim() || child.state === 'stopping' || !!pending[child.id]}><CornerDownLeft size={14} /><span>{t(live ? 'childQueue' : 'childSend')}</span></button>
                </form>}
            </> : <div className="child-empty"><Bot size={28} /><strong>{t('childChooseSession')}</strong><button type="button" className="secondary-btn" onClick={onParent}>{t('surfaceBackToConversation')}</button></div>}
        </section>
    </div>;
}

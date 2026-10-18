// Linked-row actions adapted from T3 Code's ThreadPullRequestsPanel.tsx (MIT).
// See THIRD_PARTY_NOTICES.txt. Xratu owns the host protocol and localized UI.
import { ChevronDown, ExternalLink, Eye, EyeOff, GitBranch, GitPullRequest, MessageSquare, MoreHorizontal, RefreshCw, Unlink, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { PullRequestAction } from '../../../src/pullRequests/controller';
import type { PullRequestCheck, PullRequestView } from '../../../src/pullRequests/types';
import { t, tf, tOrRaw } from '../i18n';
import { formatFullTimestamp } from '../datetime';
import { pullRequestStatus } from './PullRequestIndicator';

const statuses = { open: 'prOpen', closed: 'prClosed', merged: 'prMerged' } as const;
const reviews: Record<string, Parameters<typeof t>[0]> = { APPROVED: 'prReviewApproved', CHANGES_REQUESTED: 'prReviewChanges', REVIEW_REQUIRED: 'prReviewRequired' };
const reviewTones: Record<string, string> = { APPROVED: 'is-approved', CHANGES_REQUESTED: 'is-changes', REVIEW_REQUIRED: 'is-required' };
const checkLabels: Record<PullRequestCheck['status'], Parameters<typeof t>[0]> = {
    pending: 'prCheck_pending', success: 'prCheck_success', failure: 'prCheck_failure', cancelled: 'prCheck_cancelled', 'action-required': 'prCheck_actionRequired', neutral: 'prCheck_neutral', skipped: 'prCheck_skipped',
};
const reasons = { closed: 'prWatchEnded_closed', merged: 'prWatchEnded_merged', unreadable: 'prWatchEnded_unreadable', 'comment-limit': 'prWatchEnded_commentLimit' } as const;
const changes = { 'checks-failed': 'prEventsFailed', 'checks-passed': 'prEventsPassed', remarks: 'prEventsRemarks', conflicting: 'prEventsConflict' } as const;

function checksSummary(checks: PullRequestCheck[]): string {
    const counts = [
        ['prChecksFailedCount', checks.filter(check => ['failure', 'cancelled', 'action-required'].includes(check.status)).length],
        ['prChecksPendingCount', checks.filter(check => check.status === 'pending').length],
        ['prChecksPassedCount', checks.filter(check => check.status === 'success').length],
        ['prChecksOtherCount', checks.filter(check => ['skipped', 'neutral'].includes(check.status)).length],
    ] as const;
    return counts.filter(([, count]) => count > 0).map(([key, count]) => tf(key, { count: String(count) })).join(' · ') || t('prNoChecks');
}

export function PullRequestsPanel({ visible, panelClass, busy, state, pending, error, action }: {
    visible: boolean; panelClass: string; busy: boolean; state: PullRequestView; pending: boolean;
    error: { key: string; detail?: string } | null; action: (action: PullRequestAction, url?: string) => void;
}) {
    const root = useRef<HTMLElement>(null);
    useEffect(() => {
        const close = (event: PointerEvent) => root.current?.querySelectorAll<HTMLDetailsElement>('.pr-menu[open]').forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
        document.addEventListener('pointerdown', close);
        return () => document.removeEventListener('pointerdown', close);
    }, []);
    const running = state.delivery?.status === 'running';
    const resumeContext = state.events.find(event => event.resume)?.resume;
    return <section ref={root} className={`pr-panel ${panelClass}`} id="surface-panel-pullRequests" role="tabpanel" aria-labelledby="surface-tab-pullRequests" aria-hidden={!visible || undefined}>
        <div className="pr-scroll">
            {state.offline && <p className="pr-notice" role="status">{t('prOffline')}</p>}
            {error && <div className="pr-error" role="alert"><TriangleAlert size={14} /><div>{tOrRaw(error.key)}{error.detail && <p dir="auto">{error.detail}</p>}</div></div>}
            {state.events.length > 0 && <section className="pr-updates" aria-label={tf('prPending', { count: String(state.events.length) })}>
                <strong>{tf('prPending', { count: String(state.events.length) })}</strong>
                {state.delivery && <p role="status">{t(state.delivery.status === 'running' ? 'prRunning' : state.delivery.status === 'interrupted' ? 'prInterrupted' : 'prDeliveryFailed')}</p>}
                {resumeContext && <p className="pr-help">{t('prResumeContext')} <code dir="ltr">{resumeContext.engine} · {resumeContext.model} · {resumeContext.branch}</code></p>}
                <ul>{state.events.map(event => <li key={event.id}><a href={event.url} target="_blank" rel="noreferrer" dir="ltr">#{event.number}</a><span>{event.reason ? t(reasons[event.reason]) : event.changes.map(change => t(changes[change.kind])).join(' · ')}</span></li>)}</ul>
                <div className="pr-actions"><button type="button" className="secondary-btn" disabled={pending || busy || running || state.offline} onClick={() => action('resume')}>{t('prContinue')}</button><button type="button" className="settings-ghost-action" disabled={pending || running} onClick={() => action('dismiss')}>{t('prDismiss')}</button></div>
            </section>}
            {state.links.length === 0 && !error && (
                <div className="pr-empty-state" role="status">
                    <div className="pr-empty-icon" aria-hidden="true">
                        <GitPullRequest size={22} />
                    </div>
                    <strong className="pr-empty-title">{t('prEmptyTitle')}</strong>
                    <p className="pr-empty-hint">{t('prEmptyHint')}</p>
                </div>
            )}
            {state.links.map(link => {
                const snapshot = link.snapshot;
                const { Icon, tone, key } = pullRequestStatus(link);
                const watchLabel = t(link.watch ? 'prUnwatch' : 'prWatch');
                const stateTone = snapshot ? (snapshot.isDraft && snapshot.state === 'open' ? 'draft' : snapshot.state) : 'unknown';
                return <article className="pr-row" key={link.url}>
                    <div className="pr-row-meta"><span className="pr-reference"><span className="pr-repository" dir="ltr" title={link.repository}>{link.repository}</span><span className="pr-identity">{snapshot && <span className={`pr-state is-${stateTone}`}>{t(snapshot.isDraft && snapshot.state === 'open' ? 'prDraft' : statuses[snapshot.state])}</span>}<span className="pr-number" dir="ltr">#{link.number}</span></span></span>
                        <details className="pr-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
                            <summary aria-label={t('prActions')} title={t('prActions')}><MoreHorizontal size={16} /></summary>
                            <div className="pr-menu-actions">
                                <button type="button" disabled={pending || state.offline} title={snapshot?.syncedAt ? `${t('prUpdated')}: ${formatFullTimestamp(Date.parse(snapshot.syncedAt))}` : undefined} onClick={event => { action('refresh', link.url); event.currentTarget.closest('details')!.open = false; }}><RefreshCw size={13} />{t('prRefresh')}</button>
                                <a href={link.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />{t('prOpenGitHub')}</a>
                                <button type="button" disabled={pending} onClick={event => { action('unlink', link.url); event.currentTarget.closest('details')!.open = false; }}><Unlink size={13} />{t('prUnlink')}</button>
                            </div>
                        </details>
                    </div>
                    <h2 className="pr-row-heading"><a href={link.url} target="_blank" rel="noreferrer" title={t('prOpenGitHub')} dir="auto">{snapshot?.title ?? link.repository}</a></h2>
                    {!['prOpen', 'prDraft', 'prMerged', 'prClosed'].includes(key) && <div className="pr-status-line"><span className={`pr-status ${tone}`}><Icon size={14} />{t(key)}</span></div>}
                    <div className="pr-watch-line">
                        <button type="button" className={`pr-watch-toggle${link.watch ? ' watching' : ''}`} aria-label={watchLabel} title={`${watchLabel}. ${t('prMonitorHelp')}${!link.watch || link.resume ? ` ${t('prAutoResumeHelp')}` : ''}`} disabled={pending || (!link.watch && (state.offline || snapshot?.state !== 'open'))} onClick={() => action(link.watch ? 'unwatch' : 'watch', link.url)}>{link.watch ? <Eye size={14} /> : <EyeOff size={14} />}<span>{t(link.watch ? 'prWatching' : 'prWatch')}</span></button>
                        {snapshot?.reviewDecision && <p className={`pr-review ${reviewTones[snapshot.reviewDecision] ?? ''}`}><MessageSquare size={13} /><span>{tOrRaw(reviews[snapshot.reviewDecision] ?? snapshot.reviewDecision)}</span></p>}
                        {snapshot && <p className="pr-branches" title={`${snapshot.headBranch} → ${snapshot.baseBranch}`}><GitBranch size={13} /><span dir="ltr">{snapshot.headBranch} → {snapshot.baseBranch}</span></p>}
                    </div>
                    {snapshot && <>
                        <details className="pr-detail"><summary><ChevronDown size={13} />{t('prChecks')} <span>{checksSummary(snapshot.checks)}</span></summary>
                            {!snapshot.checks.length && <p className="pr-help">{t('prNoChecks')}</p>}
                            <ul>{snapshot.checks.map((check, index) => <li key={`${check.name}-${index}`}><span className={`pr-check-dot ${check.status}`} aria-hidden="true" />{check.url ? <a href={check.url} target="_blank" rel="noreferrer" dir="auto">{check.name}</a> : <span dir="auto">{check.name}</span>}<span className={`pr-check-badge is-${check.status}`}>{t(checkLabels[check.status])}{check.required ? ` · ${t('prRequired')}` : ''}</span></li>)}</ul>
                        </details>
                        {snapshot.comments.length > 0 && <details className="pr-detail"><summary><ChevronDown size={13} />{t('prComments')}<span>{tf((snapshot.commentCount ?? snapshot.comments.length) === 1 ? 'prOneCommentSummary' : 'prCommentsSummary', { count: String(snapshot.commentCount ?? snapshot.comments.length), author: snapshot.comments.at(-1)?.author?.login ?? 'GitHub' })}</span></summary><ul className="pr-comments">{snapshot.comments.slice(-10).map(comment => <li key={comment.id}><div className="pr-comment-head"><a href={comment.url ?? link.url} target="_blank" rel="noreferrer" dir="ltr">@{comment.author?.login ?? 'GitHub'}</a></div><p dir="auto">{comment.body}</p></li>)}</ul></details>}
                    </>}
                    {link.errorKey && <p className="pr-error" role="status">{tOrRaw(link.errorKey)}</p>}
                </article>;
            })}
        </div>
    </section>;
}


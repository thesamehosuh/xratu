// Adapted from T3's ThreadPullRequestBadgeControl and ThreadDetailsPrRow (MIT).
// The same linked snapshot supplies chat, Activity and the details sidebar.
import { CircleCheck, CircleX, Clock, Eye, GitMerge, GitPullRequest, TriangleAlert } from 'lucide-react';
import type { PullRequestLink, PullRequestView } from '../../../src/pullRequests/types';
import { t, tf } from '../i18n';

export function pullRequestStatus(link: PullRequestLink) {
    const snapshot = link.snapshot;
    if (link.errorKey || !snapshot) return { Icon: TriangleAlert, tone: 'unknown', key: 'prUnknown' } as const;
    if (snapshot.state === 'merged') return { Icon: GitMerge, tone: 'merged', key: 'prMerged' } as const;
    if (snapshot.state === 'closed') return { Icon: GitPullRequest, tone: 'closed', key: 'prClosed' } as const;
    if (snapshot.mergeability === 'conflicting') return { Icon: TriangleAlert, tone: 'failed', key: 'prConflict' } as const;
    if (snapshot.checks.some(check => ['failure', 'cancelled', 'action-required'].includes(check.status))) return { Icon: CircleX, tone: 'failed', key: 'prEventsFailed' } as const;
    const required = snapshot.checks.filter(check => check.required);
    const gate = required.length ? required : snapshot.checks;
    if (gate.some(check => check.status === 'pending')) return { Icon: Clock, tone: 'pending', key: 'prChecksRunning' } as const;
    if (snapshot.isDraft) return { Icon: GitPullRequest, tone: 'unknown', key: 'prDraft' } as const;
    if (gate.length) return { Icon: CircleCheck, tone: 'passed', key: 'prEventsPassed' } as const;
    return { Icon: GitPullRequest, tone: 'open', key: 'prOpen' } as const;
}

export function PullRequestIndicator({ state, onOpen }: { state: PullRequestView; onOpen: () => void }) {
    if (!state.links.length) return null;
    return <div className="pr-indicator" aria-label={t('prTitle')}>
        {state.links.map(link => {
            const { Icon, tone, key } = pullRequestStatus(link);
            return <button type="button" className={`pr-indicator-row ${tone}`} key={link.url} onClick={onOpen}
                aria-label={tf('prShowDetails', { number: String(link.number) })} title={`${link.repository}#${link.number}: ${link.snapshot?.title ?? ''} · ${t(key)}`}>
                <Icon size={14} aria-hidden="true" /><span className="pr-indicator-number" dir="ltr">#{link.number}</span>
                <span className="pr-indicator-title" dir="auto">{link.snapshot?.title ?? link.repository}</span>
                <span className="pr-indicator-status">{t(key)}</span>
                {link.watch && <Eye size={13} className="pr-indicator-watch" aria-label={t('prWatching')} />}
            </button>;
        })}
        {state.events.length > 0 && <button type="button" className="pr-indicator-updates" onClick={onOpen}>{tf('prPending', { count: String(state.events.length) })}</button>}
    </div>;
}

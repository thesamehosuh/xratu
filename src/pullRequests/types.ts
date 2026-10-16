/** Host-owned PR metadata, independent of model history and shadow checkpoints. */
export interface PullRequestTarget { host: 'github.com'; repository: string; number: number; url: string }
export interface PullRequestCheck {
    name: string;
    status: 'pending' | 'success' | 'failure' | 'cancelled' | 'action-required' | 'neutral' | 'skipped';
    required: boolean;
    url: string | null;
}
export interface PullRequestComment {
    id: string; body: string; createdAt: string; editedAt: string | null;
    author: { login: string } | null; path: string | null; url: string | null;
    reviewState: string | null;
}
export interface PullRequestSnapshot {
    title: string; state: 'open' | 'closed' | 'merged'; isDraft: boolean;
    headBranch: string; baseBranch: string; headSha: string;
    mergeability: 'clean' | 'conflicting' | 'unknown'; reviewDecision: string | null;
    checks: PullRequestCheck[]; comments: PullRequestComment[]; commentCount?: number;
    viewer: string; author: { login: string } | null; syncedAt: string;
}
/** Adapted from T3 Code's ThreadPullRequestWatch; see THIRD_PARTY_NOTICES.txt. */
export interface PullRequestWatch {
    startedAt: string; headSha: string | null; failedChecks: readonly string[];
    passed: boolean; passedChecks: readonly string[]; remarksThrough: string;
    remarkIds: readonly string[]; conflicting: boolean; wakes: number;
    /** Old cursors consumed baseline failures without queuing a wake. */
    initialChecksReported?: boolean;
}
export interface PullRequestExecution {
    workspace: string; branch: string; engine: 'xratu' | 'opencode';
    model: string | null; credential: string | null;
    nativeSessionId: string | null; binaryPath: string | null;
}
export interface PullRequestLink extends PullRequestTarget {
    linkedAt: string; source: 'user' | 'agent'; generation: string;
    snapshot: PullRequestSnapshot | null;
    watch?: PullRequestWatch;
    resume?: PullRequestExecution;
    failures: number; errorKey?: string; errorDetail?: string;
}
export type PullRequestChange =
    | { kind: 'checks-failed'; failed: readonly PullRequestCheck[] }
    | { kind: 'checks-passed'; count: number; required: boolean }
    | { kind: 'remarks'; remarks: readonly PullRequestComment[] }
    | { kind: 'conflicting' };
export interface PullRequestEvent {
    id: string; key: string; url: string; number: number; createdAt: string;
    headSha: string | null; changes: readonly PullRequestChange[];
    reason?: 'closed' | 'merged' | 'unreadable' | 'comment-limit';
    omittedItems?: number;
    resume?: PullRequestExecution;
}
export interface PullRequestDelivery { ids: string[]; status: 'running' | 'interrupted' | 'failed'; owner: number }
export interface PullRequestSession {
    version: 1; sessionId: string; workspace: string; links: PullRequestLink[];
    events: PullRequestEvent[]; delivery?: PullRequestDelivery; deleted?: true;
}
export interface PullRequestView {
    links: PullRequestLink[]; events: PullRequestEvent[]; delivery?: PullRequestDelivery;
    offline: boolean;
}
export class PullRequestError extends Error {
    constructor(readonly valueKey: string, readonly detail = '') { super(detail || valueKey); }
}
export function pullRequestTarget(value: unknown): PullRequestTarget {
    if (typeof value !== 'string' || value.length > 2048) throw new PullRequestError('prInvalidUrl');
    let url: URL;
    try { url = new URL(value); } catch { throw new PullRequestError('prInvalidUrl'); }
    const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})(?:\/.*)?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.username || url.password || !match || ['.', '..'].includes(match[2])) throw new PullRequestError('prInvalidUrl');
    const repository = `${match[1]}/${match[2]}`.toLowerCase();
    const number = Number(match[3]);
    return { host: 'github.com', repository, number, url: `https://github.com/${repository}/pull/${number}` };
}
export const pullRequestKey = (target: PullRequestTarget): string => `${target.host}/${target.repository}#${target.number}`;
export const executionMatches = (a: PullRequestExecution, b: PullRequestExecution): boolean =>
    a.workspace === b.workspace && a.branch === b.branch && a.engine === b.engine && a.model === b.model && a.credential === b.credential && a.nativeSessionId === b.nativeSessionId && a.binaryPath === b.binaryPath;

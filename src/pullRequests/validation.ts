import { PullRequestError, pullRequestTarget, pullRequestKey, type PullRequestSession } from './types';

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const date = (value: unknown) => text(value, 50) && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown) => value === null || text(value);
const strings = (value: unknown) => Array.isArray(value) && value.length <= 20_000 && value.every(item => text(item, 1024));
const sha = (value: unknown) => value === null || (typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value));
const actor = (value: unknown) => value === null || (row(value) && text(value.login, 100));
const https = (value: unknown) => {
    if (value === null) return true;
    if (!text(value)) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const check = (value: unknown) => row(value) && text(value.name, 500) && ['pending', 'success', 'failure', 'cancelled', 'action-required', 'neutral', 'skipped'].includes(String(value.status)) && typeof value.required === 'boolean' && https(value.url);
const comment = (value: unknown) => row(value) && text(value.id, 200) && text(value.body, 4000) && date(value.createdAt) && (value.editedAt === null || date(value.editedAt)) && actor(value.author) && nullableText(value.path) && https(value.url) && nullableText(value.reviewState);
const execution = (value: unknown) => row(value) && text(value.workspace) && text(value.branch, 1024) && ['xratu', 'opencode'].includes(String(value.engine)) && nullableText(value.model) && nullableText(value.credential) && nullableText(value.nativeSessionId) && nullableText(value.binaryPath);
const watch = (value: unknown) => row(value) && date(value.startedAt) && sha(value.headSha) && strings(value.failedChecks) && typeof value.passed === 'boolean' && strings(value.passedChecks) && date(value.remarksThrough) && strings(value.remarkIds) && typeof value.conflicting === 'boolean' && Number.isSafeInteger(value.wakes) && Number(value.wakes) >= 0;
const snapshot = (value: unknown) => value === null || (row(value) && text(value.title, 500) && ['open', 'closed', 'merged'].includes(String(value.state)) && typeof value.isDraft === 'boolean' && text(value.headBranch, 1024) && text(value.baseBranch, 1024) && sha(value.headSha) && value.headSha !== null && ['clean', 'conflicting', 'unknown'].includes(String(value.mergeability)) && nullableText(value.reviewDecision) && date(value.syncedAt) && text(value.viewer, 100) && actor(value.author) && Array.isArray(value.checks) && value.checks.length <= 2000 && value.checks.every(check) && Array.isArray(value.comments) && value.comments.length <= 50 && value.comments.every(comment));
const change = (value: unknown) => {
    if (!row(value)) return false;
    if (value.kind === 'conflicting') return true;
    if (value.kind === 'checks-passed') return Number.isSafeInteger(value.count) && Number(value.count) >= 0 && typeof value.required === 'boolean';
    if (value.kind === 'checks-failed') return Array.isArray(value.failed) && value.failed.length <= 50 && value.failed.every(check);
    return value.kind === 'remarks' && Array.isArray(value.remarks) && value.remarks.length <= 10 && value.remarks.every(comment);
};

/** Reject damaged disk state before it can enter a webview or wake an agent. */
export function validatePullRequestSession(value: unknown, id: string, workspace: string): asserts value is PullRequestSession {
    const invalid = () => { throw new PullRequestError('prStoreFailed', 'Invalid PR metadata'); };
    if (!row(value) || value.version !== 1 || value.sessionId !== id || value.workspace !== workspace || !Array.isArray(value.links) || value.links.length > 50 || !Array.isArray(value.events) || value.events.length > 32) invalid();
    const state = value as Row;
    if (state.deleted !== undefined && state.deleted !== true) invalid();
    for (const link of state.links as unknown[]) {
        if (!row(link)) invalid();
        const item = link as Row;
        const target = pullRequestTarget(item.url);
        if (item.host !== target.host || item.repository !== target.repository || item.number !== target.number || !text(item.generation, 150) || !date(item.linkedAt) || !['user', 'agent'].includes(String(item.source)) || !snapshot(item.snapshot) || (item.watch !== undefined && !watch(item.watch)) || (item.resume !== undefined && !execution(item.resume)) || !Number.isSafeInteger(item.failures) || Number(item.failures) < 0 || (item.errorKey !== undefined && !text(item.errorKey, 100)) || (item.errorDetail !== undefined && !text(item.errorDetail, 2000))) invalid();
    }
    for (const event of state.events as unknown[]) {
        if (!row(event)) invalid();
        const item = event as Row;
        const target = pullRequestTarget(item.url);
        if (!text(item.id, 150) || item.key !== pullRequestKey(target) || item.number !== target.number || !date(item.createdAt) || !sha(item.headSha) || !Array.isArray(item.changes) || item.changes.length > 4 || !item.changes.every(change) || (item.resume !== undefined && !execution(item.resume)) || (item.reason !== undefined && !['closed', 'merged', 'unreadable', 'comment-limit'].includes(String(item.reason)))) invalid();
    }
    const delivery = state.delivery;
    if (delivery !== undefined && (!row(delivery) || !strings(delivery.ids) || !['running', 'interrupted', 'failed'].includes(String(delivery.status)) || !Number.isSafeInteger(delivery.owner) || Number(delivery.owner) <= 0)) invalid();
}

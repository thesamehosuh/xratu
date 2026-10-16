import crossSpawn from 'cross-spawn';
import { killTree } from '../tooling/processTree';
import { networkSignal } from '../networkPolicy';
import { PullRequestError, type PullRequestTarget, type PullRequestSnapshot, type PullRequestComment, type PullRequestCheck } from './types';

export type PullRequestCommand = (args: string[], cwd: string, signal?: AbortSignal) => Promise<unknown>;
/** Reuse gh's host credentials; no hosting credentials enter prompts or webviews. */
export function runGitHubCommand(args: string[], cwd: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<unknown> { return new Promise((resolve, reject) => {
    const online = networkSignal('https://github.com', signal);
    online?.throwIfAborted();
    const child = crossSpawn('gh', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); online?.removeEventListener('abort', abort);
        if (error) reject(error);
        else { try { resolve(JSON.parse(stdout)); } catch { reject(new PullRequestError('prReadFailed')); } }
    };
    const abort = () => {
        void killTree(child.pid);
        finish(new PullRequestError(online?.reason instanceof Error && online.reason.name === 'TimeoutError' ? 'prReadFailed' : 'prCancelled'));
    };
    const timer = setTimeout(() => { void killTree(child.pid); finish(new PullRequestError('prReadFailed', 'GitHub CLI timed out')); }, 30_000);
    online?.addEventListener('abort', abort, { once: true });
    if (online?.aborted) { abort(); return; }
    child.stdout?.on('data', chunk => {
        stdout += chunk.toString();
        if (stdout.length > 4 * 1024 * 1024) { void killTree(child.pid); finish(new PullRequestError('prReadTooLarge')); }
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('error', error => finish(new PullRequestError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'prCliMissing' : 'prReadFailed', error.message)));
    child.on('close', code => {
        const detail = stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 600);
        finish(code === 0 ? undefined : new PullRequestError(/rate.limit|secondary.rate|HTTP 429/i.test(stderr) ? 'prRateLimited' : /auth login|not logged|authentication|HTTP 401/i.test(stderr) ? 'prAuthRequired' : 'prReadFailed', detail));
    });
}); }

// Check selection is adapted from T3's gitHubPullRequestJson.ts (MIT).
const QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String) {
 viewer { login }
 repository(owner:$owner,name:$name) { pullRequest(number:$number) {
  title state isDraft headRefName baseRefName headRefOid mergeable reviewDecision author { login }
  commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100,after:$after) {
   nodes { __typename
    ... on CheckRun { name status conclusion detailsUrl isRequired(pullRequestNumber:$number) }
    ... on StatusContext { context state targetUrl isRequired(pullRequestNumber:$number) }
   } pageInfo { hasNextPage endCursor }
  } } } } }
 } }
}`;
type Json = Record<string, unknown>;
function object(value: unknown): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PullRequestError('prReadFailed');
    return value as Json;
}
function string(value: unknown): string {
    if (typeof value !== 'string') throw new PullRequestError('prReadFailed');
    return value;
}
function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new PullRequestError('prReadFailed');
    return value;
}
const url = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null; } catch { return null; }
};
function check(value: unknown): PullRequestCheck {
    const row = object(value);
    if (typeof row.isRequired !== 'boolean') throw new PullRequestError('prReadFailed');
    const status = row.__typename === 'CheckRun' && row.status !== 'COMPLETED' ? 'PENDING' : row.conclusion ?? row.state;
    const normalized: Record<string, PullRequestCheck['status']> = { PENDING: 'pending', EXPECTED: 'pending', SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', TIMED_OUT: 'failure', STARTUP_FAILURE: 'failure', STALE: 'failure', CANCELLED: 'cancelled', ACTION_REQUIRED: 'action-required', NEUTRAL: 'neutral', SKIPPED: 'skipped' };
    return { name: string(row.name ?? row.context).slice(0, 500), status: normalized[String(status)] ?? 'pending', required: row.isRequired === true, url: url(row.detailsUrl ?? row.targetUrl) };
}
function comment(value: unknown, kind: string): PullRequestComment {
    const row = object(value);
    const createdAt = string(row.created_at ?? row.submitted_at);
    const editedAt = typeof row.updated_at === 'string' && row.updated_at !== createdAt ? row.updated_at : null;
    if (!Number.isFinite(Date.parse(createdAt)) || (editedAt && !Number.isFinite(Date.parse(editedAt)))) throw new PullRequestError('prReadFailed');
    return { id: `${kind}:${string(row.node_id)}`, body: typeof row.body === 'string' ? row.body.slice(0, 4000) : '', createdAt, editedAt, author: row.user ? { login: string(object(row.user).login) } : null, path: typeof row.path === 'string' ? row.path : null, url: url(row.html_url), reviewState: typeof row.state === 'string' ? row.state : null };
}
export class GitHubPullRequests {
    constructor(private readonly command: PullRequestCommand = runGitHubCommand) {}
    async read(target: PullRequestTarget, workspace: string, signal?: AbortSignal): Promise<PullRequestSnapshot> {
        signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45_000)]);
        const [owner, name] = target.repository.split('/');
        let after: string | null = null, core: Json | undefined, viewer = '';
        const checks: PullRequestCheck[] = [];
        const cursors = new Set<string>();
        for (let page = 0; page < 20; page++) {
            const response = object(await this.command(['api', 'graphql', '--hostname', target.host, '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${target.number}`, ...(after ? ['-f', `after=${after}`] : [])], workspace, signal));
            if (response.errors) throw new PullRequestError('prReadFailed');
            const data = object(response.data);
            viewer = string(object(data.viewer).login);
            const pr = object(object(data.repository).pullRequest);
            if (core && core.headRefOid !== pr.headRefOid) throw new PullRequestError('prChangedDuringRead');
            core = pr;
            const commit = array(object(pr.commits).nodes)[0];
            const rollup = commit ? object(object(commit).commit).statusCheckRollup : null;
            if (!rollup) break;
            const contexts = object(object(rollup).contexts);
            checks.push(...array(contexts.nodes).map(check));
            const info = object(contexts.pageInfo);
            if (info.hasNextPage === false) break;
            after = string(info.endCursor);
            if (!after || cursors.has(after) || page === 19) throw new PullRequestError('prReadTooLarge');
            cursors.add(after);
        }
        if (!core) throw new PullRequestError('prReadFailed');
        const state = string(core.state);
        if (!['OPEN', 'CLOSED', 'MERGED'].includes(state) || typeof core.isDraft !== 'boolean') throw new PullRequestError('prReadFailed');
        const pages = await Promise.all(['issues/comments', 'pulls/reviews', 'pulls/comments'].map(async route => {
            const [resource, collection] = route.split('/');
            const response = await this.command(['api', '--hostname', target.host, '--paginate', '--slurp', `repos/${target.repository}/${resource}/${target.number}/${collection}?per_page=100`], workspace, signal);
            return array(response).flatMap(array).filter(value => route !== 'pulls/reviews' || object(value).state !== 'PENDING').map(value => comment(value, route));
        }));
        const headSha = string(core.headRefOid);
        if (!/^[a-f0-9]{40,64}$/i.test(headSha)) throw new PullRequestError('prReadFailed');
        return { title: string(core.title).slice(0, 500), state: state.toLowerCase() as PullRequestSnapshot['state'], isDraft: core.isDraft, headBranch: string(core.headRefName), baseBranch: string(core.baseRefName), headSha, mergeability: core.mergeable === 'MERGEABLE' ? 'clean' : core.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown', reviewDecision: typeof core.reviewDecision === 'string' ? core.reviewDecision : null, checks, comments: pages.flat().sort((a, b) => a.createdAt.localeCompare(b.createdAt)), viewer, author: core.author ? { login: string(object(core.author).login) } : null, syncedAt: new Date().toISOString() };
    }
}

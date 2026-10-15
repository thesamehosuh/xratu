import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { renameWithRetry } from '../local/localSessionStore';
import { PullRequestError, type PullRequestSession } from './types';
import { validatePullRequestSession } from './validation';

/** Each session has its own atomic file; no transcript saves can overwrite PR state. */
export class PullRequestStore {
    private queue: Promise<unknown> = Promise.resolve();
    readonly directory: string;
    constructor(storage: string, private readonly diagnostic: (error: unknown) => void = console.error) { this.directory = path.join(storage, 'pull-requests'); }
    private file(id: string): string {
        if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new PullRequestError('prSessionRequired');
        return path.join(this.directory, `${id}.json`);
    }
    private async read(id: string, workspace: string): Promise<PullRequestSession> {
        try {
            const filename = this.file(id);
            if ((await fs.stat(filename)).size > 8 * 1024 * 1024) throw new Error('PR metadata is too large');
            const value = JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')) as PullRequestSession;
            validatePullRequestSession(value, id, workspace);
            return value;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessionId: id, workspace, links: [], events: [] };
            throw new PullRequestError('prStoreFailed', error instanceof Error ? error.message : String(error));
        }
    }
    load(id: string, workspace: string): Promise<PullRequestSession> {
        return this.queue.then(() => this.read(id, workspace));
    }
    update(id: string, workspace: string, change: (state: PullRequestSession) => void): Promise<PullRequestSession> {
        const next = this.queue.then(async () => {
            await fs.mkdir(this.directory, { recursive: true });
            const filename = this.file(id), lock = `${filename}.lock`;
            // A second window must not race a cursor/event update or bill a
            // duplicate wake. A crashed owner's lock is recovered on restart.
            let handle: fs.FileHandle;
            try { handle = await fs.open(lock, 'wx'); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                const owner = Number(await fs.readFile(lock, 'utf8').catch(() => ''));
                let alive = true;
                if (Number.isSafeInteger(owner) && owner > 0) {
                    try { process.kill(owner, 0); } catch (probe) { alive = (probe as NodeJS.ErrnoException).code !== 'ESRCH'; }
                }
                if (alive) throw new PullRequestError('prStoreBusy');
                // Recovery has its own exclusive lock so two new hosts cannot
                // both remove a lock acquired by the first recovering host.
                const recovery = await fs.open(`${lock}.recovery`, 'wx').catch(() => null);
                if (!recovery) throw new PullRequestError('prStoreBusy');
                try {
                    if (await fs.readFile(lock, 'utf8').catch(() => '') === String(owner)) await fs.unlink(lock);
                    handle = await fs.open(lock, 'wx');
                } finally { await recovery.close(); await fs.unlink(`${lock}.recovery`); }
            }
            const temp = `${filename}.${randomUUID()}.tmp`;
            try {
                await handle.writeFile(String(process.pid));
                const state = await this.read(id, workspace);
                change(state);
                validatePullRequestSession(state, id, workspace);
                const json = JSON.stringify(state);
                if (Buffer.byteLength(json, 'utf8') > 8 * 1024 * 1024) throw new PullRequestError('prReadTooLarge');
                await fs.writeFile(temp, json, 'utf8');
                await renameWithRetry(temp, filename);
                return structuredClone(state);
            } finally {
                await fs.unlink(temp).catch(() => undefined);
                await handle.close();
                await fs.unlink(lock);
            }
        });
        this.queue = next.catch(() => undefined);
        return next;
    }
    async sessions(): Promise<Array<{ sessionId: string; workspace: string; pending: number; watching: number }>> {
        await this.queue;
        const entries = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const result = [];
        for (const file of entries.filter(name => /^[a-zA-Z0-9_-]{1,150}\.json$/.test(name))) {
            try {
                if ((await fs.stat(path.join(this.directory, file))).size > 8 * 1024 * 1024) throw new PullRequestError('prStoreFailed');
                const value = JSON.parse((await fs.readFile(path.join(this.directory, file), 'utf8')).replace(/^\uFEFF/, '')) as PullRequestSession;
                if (typeof value.workspace !== 'string') throw new PullRequestError('prStoreFailed');
                const state = await this.read(file.slice(0, -5), value.workspace);
                if (!state.deleted) result.push({ sessionId: state.sessionId, workspace: state.workspace, pending: state.events.length, watching: state.links.filter(link => link.watch).length });
            } catch (error) { this.diagnostic(error); }
        }
        return result;
    }
    async remove(id: string, workspace: string): Promise<void> {
        await this.update(id, workspace, state => { state.links = []; state.events = []; delete state.delivery; state.deleted = true; });
    }
}

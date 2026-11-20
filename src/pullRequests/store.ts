import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { LockTimeoutError, withDirectoryLock } from '../oauth/refreshLock';
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
            await repairLegacyLock(lock);
            return withDirectoryLock(lock, { timeoutMs: 5_000, sleepMs: 100, recoverDeadOwner: true }, async () => {
                const temp = `${filename}.${randomUUID()}.tmp`;
                try {
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
                }
            }).catch(error => {
                if (error instanceof LockTimeoutError) throw new PullRequestError('prStoreBusy');
                throw error;
            });
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

async function repairLegacyLock(lock: string): Promise<void> {
    const missing = (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    };
    const original = await fs.lstat(lock).catch(missing);
    if (!original || original.isDirectory()) return;
    if (!original.isFile()) throw new PullRequestError('prStoreBusy');
    const contents = await fs.readFile(lock, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EISDIR') return undefined;
        return missing(error);
    });
    if (contents === undefined) return;
    const pid = Number(contents);
    if (Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
        try { process.kill(pid, 0); throw new PullRequestError('prStoreBusy'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    } else if (Date.now() - original.mtimeMs < 3_000) {
        throw new PullRequestError('prStoreBusy');
    }
    const current = await fs.lstat(lock).catch(missing);
    if (current?.isFile() && current.ino === original.ino && current.birthtimeMs === original.birthtimeMs && current.mtimeMs === original.mtimeMs) {
        await fs.unlink(lock).catch(missing);
    }
}

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { renameWithRetry } from '../local/localSessionStore';
import type { CoordinatorSnapshot, CoordinatorStore } from './types';
import {SessionFileOwnership} from './ownership';

export const MAX_COORDINATOR_STORE_BYTES = 32 * 1024 * 1024;
const MAX_BYTES = MAX_COORDINATOR_STORE_BYTES;

/** Atomic snapshots. Caller owns execution admission; writes are serialized here. */
export class FileCoordinatorStore implements CoordinatorStore {
    private writes: Promise<unknown> = Promise.resolve();
    private readonly ownership: SessionFileOwnership;
    constructor(private readonly file: string) {this.ownership=new SessionFileOwnership(file);}
    async load(signal?: AbortSignal): Promise<CoordinatorSnapshot | undefined> {
        await this.ownership.acquire(signal);
        return FileCoordinatorStore.peek(this.file);
    }
    static async peek(file: string): Promise<CoordinatorSnapshot | undefined> {
        try {
            const handle = await fs.open(file, 'r');
            try {
                if ((await handle.stat()).size > MAX_BYTES) throw new Error('Child session store exceeds storage limit');
                const snapshot = JSON.parse(await handle.readFile('utf8')) as CoordinatorSnapshot;
                if (snapshot?.version !== 1 || !Array.isArray(snapshot.sessions)) throw new Error('Unsupported child session store');
                return snapshot;
            } finally { await handle.close(); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }
    save(snapshot: CoordinatorSnapshot): Promise<void> {
        const text = JSON.stringify(snapshot);
        if (Buffer.byteLength(text) > MAX_BYTES) return Promise.reject(new Error('Child session store exceeds storage limit'));
        const write = this.writes.then(async () => {
            await this.ownership.acquire();
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
                const handle = await fs.open(temporary, 'wx', 0o600);
                try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
                finally { await handle.close(); }
                await renameWithRetry(temporary, this.file);
            } finally { await fs.rm(temporary, { force: true }); }
        });
        this.writes = write.catch(() => undefined);
        return write;
    }
    async close(): Promise<void> {
        await this.writes;
        await this.ownership.release();
    }
}

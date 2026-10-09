import * as fs from 'fs';
import { computeDiffHunks } from './editDiff';
import { sanitizePath } from './paths';
import type { ChangedFile } from './shadowGit';
import type { SubagentSource } from './subagents';

export type ReviewChange = ChangedFile;
export type ReviewFile = {
    path: string;
    kind: 'text' | 'binary' | 'tooLarge';
    before: string;
    after: string;
    hunks?: ReturnType<typeof computeDiffHunks>;
};
export interface AgentProfileView {
    name: string;
    description: string;
    source: SubagentSource;
    tools?: string[];
    model?: string;
    reasoningEffort?: string;
    maxRounds?: number;
    error?: string;
    warning?: string;
    editable: boolean;
}

interface ReviewStore {
    diffCheckpoint(root: string, sha: string): Promise<ChangedFile[]>;
    readCheckpointFile(root: string, sha: string, file: string): Promise<string | null>;
}

export const REVIEW_FILE_LIMIT = 200_000;

export function validateReviewCheckpoint(sha: unknown): asserts sha is string {
    if (typeof sha !== 'string' || !/^[a-f0-9]{7,40}$/i.test(sha)) {
        throw new Error('Invalid checkpoint');
    }
}

/** Only files in this checkpoint's change list may be requested by the UI. */
export async function readReviewFile(store: ReviewStore, root: string, sha: unknown, file: unknown): Promise<ReviewFile> {
    validateReviewCheckpoint(sha);
    if (typeof file !== 'string') throw new Error('Invalid file');
    sanitizePath(file, root);
    const changes = await store.diffCheckpoint(root, sha);
    const change = changes.find((item) => item.path === file);
    if (!change) throw new Error('File is not part of this checkpoint');
    const empty = { path: file, before: '', after: '' };
    if (change.binary) return { ...empty, kind: 'binary' };
    const before = change.untracked ? '' : (await store.readCheckpointFile(root, sha, file)) ?? '';
    if (before.length > REVIEW_FILE_LIMIT) return { ...empty, kind: 'tooLarge' };
    let buffer: Buffer = Buffer.alloc(0);
    try {
        const target = sanitizePath(file, root);
        const handle = await fs.promises.open(target, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('Not a regular file');
            if (stat.size > REVIEW_FILE_LIMIT) return { ...empty, kind: 'tooLarge' };
            const capped = Buffer.alloc(REVIEW_FILE_LIMIT + 1);
            let length = 0;
            while (length < capped.length) {
                const read = await handle.read(capped, length, capped.length - length, length);
                if (read.bytesRead === 0) break;
                length += read.bytesRead;
            }
            if (length > REVIEW_FILE_LIMIT) return { ...empty, kind: 'tooLarge' };
            buffer = capped.subarray(0, length);
        } finally { await handle.close(); }
    } catch (error) {
        // A deletion has a checkpoint side and an empty working-tree side.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (buffer.includes(0) || before.includes('\0')) return { ...empty, kind: 'binary' };
    const after = buffer.toString('utf8');
    return { path: file, kind: 'text', before, after, hunks: computeDiffHunks(before, after) };
}

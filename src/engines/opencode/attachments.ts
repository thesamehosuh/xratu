// T3 Code keeps attachment bytes on disk and gives native tools their paths.
// Keep these snapshots across turns/restarts: native history refers to them.
import { createHash, randomUUID } from 'crypto';
import { mkdir, rename, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { LocalImageAttachment } from '../../local/localTypes';

export class OpenCodeAttachmentStore {
    constructor(private readonly root: string) {}

    async prepare(sessionID: string, text: string, attachments: LocalImageAttachment[] | undefined, signal: AbortSignal) {
        const files: { name: string; uri: string }[] = [];
        const references: string[] = [];
        for (const attachment of attachments ?? []) {
            signal.throwIfAborted();
            const data = attachment.dataBase64.includes(',') ? attachment.dataBase64.slice(attachment.dataBase64.indexOf(',') + 1) : attachment.dataBase64;
            const bytes = Buffer.from(data, 'base64');
            const session = createHash('sha256').update(sessionID).digest('hex').slice(0, 32);
            const hash = createHash('sha256').update(attachment.mimeType).update(bytes).digest('hex');
            // Keep names short on Windows and never use user-supplied paths.
            // The SDK's name field preserves the original display name.
            const ext = path.extname(attachment.name).toLowerCase();
            const extension = /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
            const directory = path.join(this.root, session);
            const filename = path.join(directory, `${hash}${extension}`);
            const temporary = path.join(directory, `${randomUUID()}.tmp`);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            try {
                await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, signal });
                await rename(temporary, filename);
            } finally { await rm(temporary, { force: true }); }
            references.push(`[Attached file ${JSON.stringify(attachment.name)} is saved at: ${JSON.stringify(filename)}]`);
            files.push({ name: attachment.name, uri: pathToFileURL(filename).href });
        }
        signal.throwIfAborted();
        return { text: [text, ...references].filter(Boolean).join('\n\n'), ...(files.length ? { files } : {}) };
    }
}

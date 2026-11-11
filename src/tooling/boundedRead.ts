import * as fs from 'fs/promises';

/** Read at most limit + 1 bytes so callers can detect overflow without
 * materializing a growing file. A descriptor pins the selected file. */
export async function readBoundedFile(file: string, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid read limit');
    const handle = await fs.open(file, 'r');
    try {
        if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
        const chunks: Buffer[] = [];
        let length = 0;
        while (length <= limit) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - length));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
            if (!bytesRead) break;
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        return Buffer.concat(chunks, length);
    } finally { await handle.close(); }
}

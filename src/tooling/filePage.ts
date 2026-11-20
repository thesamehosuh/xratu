import * as fs from 'fs';

/** Stream the file without retaining unrequested lines. A character cursor
 * keeps even a single oversized line fully reachable on subsequent calls. */
export async function filePage(file: string, label: string, startValue: unknown, maxValue: unknown, columnValue?: unknown, budget = 80_000, signal?: AbortSignal): Promise<string> {
    if (!(await fs.promises.stat(file)).isFile()) throw new Error('Not a regular file');
    const start = Math.max(1, Math.floor(Number(startValue) || 1));
    const max = Math.max(1, Math.min(2000, Math.floor(Number(maxValue) || 1200)));
    const column = Math.max(0, Math.floor(Number(columnValue) || 0));
    let line = 1, offset = 0, body = '', end = start - 1;
    let next: { line: number; column: number } | undefined;
    for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 8192, signal })) {
        const pieces = String(chunk).split('\n');
        for (let i = 0; i < pieces.length; i++) {
            const piece = pieces[i];
            if (!next && line >= start && line < start + max) {
                const skip = line === start ? Math.max(0, column - offset) : 0;
                const text = piece.slice(skip);
                const take = Math.min(text.length, Math.max(0, budget - body.length));
                body += text.slice(0, take);
                end = line;
                if (take < text.length) next = { line, column: offset + skip + take };
            }
            offset += piece.length;
            if (i < pieces.length - 1) {
                if (!next && line >= start) {
                    if (body.endsWith('\r')) body = body.slice(0, -1);
                    if (line + 1 >= start + max || body.length >= budget) next = { line: line + 1, column: 0 };
                    else body += '\n';
                }
                line++; offset = 0;
            }
        }
    }
    // A cursor beyond EOF is unnecessary, including the empty final line.
    const more = next && (next.line < line || next.line === line && next.column < offset)
        ? `\n… (call again with start_line=${next.line}, start_column=${next.column})` : '';
    return `[${label} - lines ${start}-${end} of ${line}]\n${body}${more}`;
}

export async function fileHead(file: string): Promise<Buffer> {
    if (!(await fs.promises.stat(file)).isFile()) throw new Error('Not a regular file');
    const handle = await fs.promises.open(file, 'r');
    try {
        if (!(await handle.stat()).isFile()) throw new Error('Not a regular file');
        const head = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        return head.subarray(0, bytesRead);
    } finally { await handle.close(); }
}

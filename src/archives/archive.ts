import { createHash } from 'crypto';
import { constants, type Stats } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import * as tar from 'tar';
import * as yauzl from 'yauzl';
import { buf as crc32 } from 'crc-32';
import { sanitizePath } from '../paths';

const INPUT_LIMIT = 20 * 1024 ** 3;
const LIST_LIMIT = 200;
type Format = 'zip' | 'tar' | 'tar.gz';
interface Limits { bytes: number; entries: number }
interface Entry { path: string; type: 'file' | 'directory'; bytes: number; executable: boolean }
interface Destination { root: string; workspace: string; identity: Stats }

function text(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`${name} must be a non-empty string of at most 4096 characters.`);
    return value;
}
function budget(value: unknown, fallback: number, maximum: number, name: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    return value;
}
function expectedHash(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('sha256 must contain 64 hexadecimal characters.');
    return value.toLowerCase();
}

/** Apply the same conservative filename rules on every OS, before path.join. */
function portablePath(value: string, directory = false): string {
    let name = value.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-z]:/i.test(name)) throw new Error('Absolute archive paths are not supported.');
    while (name.startsWith('./')) name = name.slice(2);
    if (directory) name = name.replace(/\/+$/, '');
    if (directory && (!name || name === '.')) return '';
    const parts = name.split('/');
    if (Buffer.byteLength(name) > 1024 || parts.length > 32 || parts.some(part =>
        !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255
        || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split('.')[0].trimEnd())
        || part.toLowerCase() === '.git' || /^\.xratu-(?:download|extract)-/i.test(part))) {
        throw new Error('Unsafe or non-portable archive path.');
    }
    return parts.join('/');
}
function workspacePath(value: unknown, name: string, workspace: string): string {
    return sanitizePath(path.join(...portablePath(text(value, name)).split('/')), workspace);
}
function unchanged(before: Stats, after: Stats): void {
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Source file changed while being read.');
}
async function hashFile(file: fs.FileHandle, size: number, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
    for (let offset = 0; offset < size;) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error('Source file was truncated.');
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    signal?.throwIfAborted();
    return hash.digest('hex');
}
async function formatOf(file: fs.FileHandle): Promise<Format> {
    const head = Buffer.alloc(512);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    if (head[0] === 0x50 && head[1] === 0x4b && [0x0304, 0x0506, 0x0708].includes(head.readUInt16BE(2))) return 'zip';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
    if (bytesRead === 512 && (head.every(byte => byte === 0) || new tar.Header(head).cksumValid)) return 'tar';
    throw new Error('Unsupported archive. Use ZIP, TAR or TAR.GZ.');
}

/** Include implicit parents so Foo/a + foo/b cannot alias on NTFS/APFS. */
class Inventory {
    private readonly paths = new Map<string, { name: string; type: Entry['type']; explicit: boolean }>();
    readonly listing: Entry[] = [];
    count = 0;
    bytes = 0;
    constructor(readonly limits: Limits) {}
    add(entry: Entry): void {
        if (++this.count > this.limits.entries) throw new Error('Archive exceeds max_entries.');
        if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || (entry.type === 'directory' && entry.bytes !== 0)) throw new Error('Invalid archive entry size.');
        this.bytes += entry.bytes;
        if (!Number.isSafeInteger(this.bytes) || this.bytes > this.limits.bytes) throw new Error('Archive exceeds expanded max_bytes.');
        if (!entry.path) return;
        const parts = entry.path.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const name = parts.slice(0, i).join('/'), key = name.normalize('NFC').toLowerCase();
            const explicit = i === parts.length, type = explicit ? entry.type : 'directory';
            const previous = this.paths.get(key);
            if (previous && (previous.name !== name || previous.type !== type || (explicit && previous.explicit))) throw new Error('Archive contains duplicate or conflicting paths.');
            if (!previous) this.paths.set(key, { name, type, explicit });
            else if (explicit) previous.explicit = true;
            if (this.paths.size > this.limits.entries) throw new Error('Archive output paths exceed max_entries.');
        }
        if (this.listing.length < LIST_LIMIT) this.listing.push(entry);
    }
    result(format: Format) {
        return { format, entries: this.count, expandedBytes: this.bytes, listing: this.listing, listingTruncated: this.count > this.listing.length };
    }
}

async function ownedDirectory(destination: Destination): Promise<boolean> {
    const current = await fs.lstat(destination.root).catch(() => undefined);
    return !!current?.isDirectory() && current.dev === destination.identity.dev && current.ino === destination.identity.ino;
}
async function outputPath(destination: Destination, entry: Entry): Promise<string> {
    if (!await ownedDirectory(destination)) throw new Error('Extraction directory changed.');
    const parts = entry.path.split('/');
    let parent = destination.root;
    for (const part of parts.slice(0, entry.type === 'directory' ? parts.length : -1)) {
        parent = path.join(parent, part);
        sanitizePath(parent, destination.workspace);
        try { await fs.mkdir(parent, { mode: 0o755 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (!(await fs.lstat(parent)).isDirectory()) throw new Error('Extraction parent is not a directory.');
    }
    const target = path.join(destination.root, ...parts);
    const comparable = (value: string) => process.platform === 'win32' ? value.normalize('NFC').toLowerCase() : value.normalize('NFC');
    if (comparable(sanitizePath(target, destination.workspace)) !== comparable(target)) throw new Error('Extraction path changed.');
    return target;
}

async function consume(entry: Entry, stream: AsyncIterable<Buffer>, destination: Destination | undefined, signal?: AbortSignal, expectedCrc?: number): Promise<void> {
    let output: fs.FileHandle | undefined, bytes = 0, crc = 0;
    try {
        if (destination && entry.path) {
            const target = await outputPath(destination, entry);
            signal?.throwIfAborted();
            if (entry.type === 'file') output = await fs.open(target, 'wx', entry.executable ? 0o755 : 0o644);
        }
        for await (const chunk of stream) {
            signal?.throwIfAborted();
            bytes += chunk.length;
            if (bytes > entry.bytes) throw new Error('Archive data exceeds declared size.');
            if (expectedCrc !== undefined) crc = crc32(chunk, crc);
            if (output) await output.writeFile(chunk);
        }
        if (bytes !== entry.bytes) throw new Error('Truncated archive entry.');
        if (expectedCrc !== undefined && (crc >>> 0) !== expectedCrc) throw new Error('ZIP entry CRC-32 mismatch.');
    } finally { await output?.close(); }
}

async function scanZip(file: fs.FileHandle, inventory: Inventory, destination?: Destination, signal?: AbortSignal): Promise<void> {
    // A reader backed by our pinned handle keeps yauzl.close() from closing a
    // descriptor still owned by FileHandle (including on malformed ZIP errors).
    class Reader extends yauzl.RandomAccessReader {
        _readStreamForRange(start: number, end: number): Readable {
            return Readable.from((async function* () {
                while (start < end) {
                    signal?.throwIfAborted();
                    const buffer = Buffer.alloc(Math.min(64 * 1024, end - start));
                    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
                    if (!bytesRead) throw new Error('Truncated ZIP data.');
                    start += bytesRead;
                    yield buffer.subarray(0, bytesRead);
                }
            })());
        }
        close(callback: (error: Error | null) => void): void { callback(null); }
    }
    const zip = await yauzl.fromRandomAccessReaderPromise(new Reader(), (await file.stat()).size, { autoClose: false, validateEntrySizes: true });
    try {
        if (zip.entryCount > inventory.limits.entries) throw new Error('Archive exceeds max_entries.');
        for await (const raw of zip.eachEntry()) {
            signal?.throwIfAborted();
            const mode = raw.externalFileAttributes >>> 16, kind = mode & 0o170000;
            if (raw.isEncrypted() || ![0, 8].includes(raw.compressionMethod)) throw new Error('Encrypted ZIPs and unsupported compression methods are refused.');
            if (kind && kind !== 0o100000 && kind !== 0o040000) throw new Error('Archive links and special files are refused.');
            const directory = raw.fileName.endsWith('/') || kind === 0o040000 || !!(raw.externalFileAttributes & 0x10);
            if (kind === 0o100000 && directory) throw new Error('Conflicting ZIP entry type.');
            const entry: Entry = { path: portablePath(raw.fileName, directory), type: directory ? 'directory' : 'file', bytes: raw.uncompressedSize, executable: !!(mode & 0o111) };
            inventory.add(entry);
            if (destination) {
                const stream = await zip.openReadStreamPromise(raw);
                // Inflation may fail while output directories are being created,
                // before consume() attaches its async iterator's error handler.
                stream.on('error', () => undefined);
                const abort = () => stream.destroy(new Error('Archive extraction cancelled.'));
                signal?.addEventListener('abort', abort, { once: true });
                try { await consume(entry, stream, destination, signal, raw.crc32); }
                finally { signal?.removeEventListener('abort', abort); stream.destroy(); }
            }
        }
    } finally { zip.close(); }
}

async function scanTar(file: fs.FileHandle, format: Format, inventory: Inventory, destination?: Destination, signal?: AbortSignal): Promise<void> {
    const parser = new tar.Parser({ strict: true, maxMetaEntrySize: 64 * 1024 });
    const pending = new Set<Promise<void>>(), active = new Set<tar.ReadEntry>();
    let failure: Error | undefined, rawBytes = 0, sniffed = false, zeroOnly = true;
    let prefix = Buffer.alloc(0);
    // Bound metadata, padding, and ignored records too, before the parser sees them.
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        rawBytes += chunk.length;
        zeroOnly = zeroOnly && chunk.every(byte => byte === 0);
        if (rawBytes > inventory.limits.bytes + inventory.limits.entries * 1024 + 16 * 1024 ** 2) return callback(new Error('TAR stream exceeds expansion limit.'));
        if (!sniffed) {
            const taken = Math.min(4 - prefix.length, chunk.length);
            prefix = Buffer.concat([prefix, chunk.subarray(0, taken)]);
            if (prefix.length < 4) return callback();
            sniffed = true;
            // node-tar auto-detects gzip/zstd. Never let it decompress a second
            // layer after our byte limiter, even when the magic spans chunks.
            if ((prefix[0] === 0x1f && prefix[1] === 0x8b) || prefix.readUInt32LE(0) === 0xfd2fb528) return callback(new Error('Nested archive compression is refused.'));
            this.push(prefix);
            return callback(null, chunk.subarray(taken));
        }
        callback(null, chunk);
    }, flush(callback) {
        callback(sniffed ? undefined : new Error('Truncated TAR header.'));
    } });
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            if (parser.write(chunk)) callback();
            else parser.once('drain', callback);
        },
        final(callback) { parser.once('end', callback); parser.end(); },
    });
    const fail = (value: unknown) => {
        if (failure) return;
        const error = value instanceof Error ? value : new Error(String(value));
        failure = error;
        sink.destroy(error);
        // node-tar annotates errors with writable .code/.tarCode properties;
        // AbortSignal can supply a DOMException whose .code is read-only.
        parser.abort(new Error(error.message));
        for (const entry of active) entry.destroy(error);
    };
    parser.on('error', (error: Error & { tarCode?: string }) => {
        // node-tar warns on a valid empty archive (two zero blocks). Keep all
        // other strict errors fatal, including a single zero block/truncation.
        if (error.tarCode === 'TAR_BAD_ARCHIVE' && zeroOnly && rawBytes >= 1024) return;
        fail(error);
    });
    parser.on('ignoredEntry', () => fail(new Error('Unsupported TAR entry or oversized metadata.')));
    parser.on('entry', (raw: tar.ReadEntry) => {
        active.add(raw);
        raw.on('error', fail);
        const work = (async () => {
            if (!['File', 'OldFile', 'Directory'].includes(raw.type) || raw.linkpath) throw new Error('Archive links and special files are refused.');
            const directory = raw.type === 'Directory';
            const entry: Entry = { path: portablePath(raw.path, directory), type: directory ? 'directory' : 'file', bytes: raw.size, executable: !!((raw.mode ?? 0) & 0o111) };
            inventory.add(entry);
            await consume(entry, raw, destination, signal);
        })().catch(fail).finally(() => { pending.delete(work); active.delete(raw); });
        pending.add(work);
    });
    const source: Readable = file.createReadStream({ start: 0, autoClose: false });
    try {
        if (format === 'tar.gz') await pipeline(source, createGunzip(), limiter, sink, { signal });
        else await pipeline(source, limiter, sink, { signal });
        await Promise.all(pending);
        if (failure) throw failure;
    } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        fail(reason);
        await Promise.all(pending);
        throw failure ?? reason;
    }
}

/** Pure host service shared by the built-in executor and native MCP bridge. */
export async function executeArchiveTool(workspace: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError?: boolean }> {
    let file: fs.FileHandle | undefined, destination: Destination | undefined;
    try {
        signal?.throwIfAborted();
        if (!['verify_file', 'inspect_archive', 'extract_archive'].includes(name)) throw new Error('Unknown archive tool.');
        const source = workspacePath(args.path, 'path', workspace);
        const expected = name === 'inspect_archive' ? undefined : expectedHash(args.sha256);
        const maxInput = name === 'verify_file' ? budget(args.max_bytes, INPUT_LIMIT, 1024 ** 4, 'max_bytes') : INPUT_LIMIT;
        file = await fs.open(source, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const before = await file.stat();
        if (!before.isFile() || before.size > maxInput) throw new Error('Source must be a regular file within the input byte limit.');
        let digest: string | undefined;
        if (name === 'verify_file' || expected) {
            digest = await hashFile(file, before.size, signal);
            unchanged(before, await file.stat());
            if (expected && digest !== expected) throw new Error(`SHA-256 mismatch: computed ${digest}.`);
        }
        if (name === 'verify_file') return { output: JSON.stringify({ path: args.path, bytes: before.size, sha256: digest, ...(expected ? { verified: true } : {}) }) };
        const format = await formatOf(file);
        const limits: Limits = { bytes: budget(args.max_bytes, 1024 ** 3, INPUT_LIMIT, 'max_bytes'), entries: budget(args.max_entries, 10000, 10000, 'max_entries') };
        if (name === 'extract_archive') {
            const root = workspacePath(args.destination, 'destination', workspace);
            // Exclusive mkdir is portable; an existing directory (even empty) is refused.
            signal?.throwIfAborted();
            await fs.mkdir(root, { mode: 0o755 });
            destination = { root, workspace, identity: await fs.lstat(root) };
        }
        const inventory = new Inventory(limits);
        if (format === 'zip') await scanZip(file, inventory, destination, signal);
        else await scanTar(file, format, inventory, destination, signal);
        signal?.throwIfAborted();
        unchanged(before, await file.stat());
        if (destination && !await ownedDirectory(destination)) throw new Error('Extraction directory changed.');
        const result = { path: args.path, ...(destination ? { destination: args.destination } : {}), ...inventory.result(format), ...(digest ? { sha256: digest, verified: true } : {}) };
        destination = undefined;
        return { output: JSON.stringify(result) };
    } catch (error) {
        if (destination && await ownedDirectory(destination)) {
            try { await fs.rm(destination.root, { recursive: true }); }
            catch { return { output: 'Archive operation failed; partial output could not be removed. Inspect the destination before retrying.', isError: true }; }
        }
        return { output: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    } finally { await file?.close(); }
}

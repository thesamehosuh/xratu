import * as fs from 'fs/promises';
import { readlinkSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withDirectoryLock } from '../oauth/refreshLock';
import { captureIdentityAsync, type ProcessIdentity } from '../tooling/processIdentity';

const liveOwners = new Map<string, string>();
const host = os.hostname();
const namespace = (() => {
    if (process.platform !== 'linux') return process.platform;
    try { return readlinkSync('/proc/self/ns/pid'); } catch { return 'linux-unknown'; }
})();
let selfIdentity: Promise<ProcessIdentity> | undefined;

/** The Windows probe emits an initial placeholder, then a bounded final result. */
function probe(pid: number): Promise<ProcessIdentity> {
    return new Promise(resolve => {
        let placeholder = process.platform === 'win32';
        captureIdentityAsync(pid, identity => {
            if (placeholder) { placeholder = false; return; }
            resolve(identity);
        });
    });
}

interface Owner {
    pid: number;
    owner: string;
    host?: string;
    namespace?: string;
    boot?: string;
    processToken?: string;
}
function parse(text: string | undefined): Owner | undefined {
    try {
        const value = JSON.parse(text ?? '') as Owner;
        return value && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff && typeof value.owner === 'string' && value.owner
            && [value.host, value.namespace, value.boot, value.processToken].every(field => field === undefined || typeof field === 'string') ? value : undefined;
    } catch { return undefined; }
}
async function read(file: string): Promise<string | undefined> {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function bootIdentity(identity: ProcessIdentity): string | undefined {
    const match = /^(linux|posix):([^:]+):/.exec(identity.token);
    return match && match[2] !== 'unknown-boot' ? `${match[1]}:${match[2]}` : undefined;
}
async function live(owner: Owner | undefined, key: string, boot: string | undefined): Promise<boolean> {
    if (!owner) return false;
    // A PID only has meaning on the host and namespace that recorded it.
    if (owner.host !== undefined && owner.host !== host) throw new Error('Downloads are owned on another host or PID namespace.');
    if (owner.boot !== undefined && boot !== undefined && owner.boot !== boot) return false;
    if (owner.namespace !== undefined && owner.namespace !== namespace) throw new Error('Downloads are owned on another host or PID namespace.');
    if (owner.pid === process.pid) return liveOwners.get(key) === owner.owner;
    try { process.kill(owner.pid, 0); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error; // EPERM and unavailable identity must never authorize takeover.
    }
    if (!owner.processToken || owner.processToken === 'unverified') return true;
    const identity = await probe(owner.pid);
    return identity.token === 'unverified' || identity.token === owner.processToken;
}

/** Claim the workspace lease using process incarnation and atomic owner writes.
 *  A short acquisition mutex serializes stale takeover; it is never held while
 *  probing another process or for the lifetime of a download. */
export async function acquireDownloadOwner(directory: string, owner: string): Promise<() => Promise<void>> {
    const file = path.join(await fs.realpath(directory), 'owner.json');
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const guard = path.join(path.dirname(file), 'owner-acquisition.lock.d');
    const identity = await (selfIdentity ??= probe(process.pid));
    const boot = bootIdentity(identity);
    const claim = JSON.stringify({ pid: process.pid, owner, host, namespace, boot, processToken: identity.token } satisfies Owner);
    const exclusive = <T>(fn: () => Promise<T>) => withDirectoryLock(guard, { timeoutMs: 10_000, staleMs: 5000 }, fn);
    for (let attempt = 0; attempt < 4; attempt++) {
        const observed = await read(file);
        const occupied = await live(parse(observed), key, boot);
        const acquired = await exclusive(async () => {
            if (await read(file) !== observed) return false;
            if (occupied) throw new Error('Downloads are owned by another Xratu window.');
            const temp = path.join(path.dirname(file), `owner-${owner}.tmp`);
            try {
                await fs.writeFile(temp, claim, { mode: 0o600, flag: 'wx' });
                await fs.rename(temp, file);
            } finally { await fs.unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
            liveOwners.set(key, owner);
            return true;
        });
        if (!acquired) continue;
        return async () => {
            try {
                await exclusive(async () => { if (parse(await read(file))?.owner === owner) await fs.unlink(file); });
            } finally { if (liveOwners.get(key) === owner) liveOwners.delete(key); }
        };
    }
    throw new Error('Download ownership changed repeatedly; try again.');
}

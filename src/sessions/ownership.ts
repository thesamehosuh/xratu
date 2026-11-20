import * as fs from 'fs/promises';
import * as path from 'path';
import {randomUUID} from 'crypto';
import {abortable,withDirectoryLock} from '../oauth/refreshLock';
import {captureSelfIdentity,processIdentityStatusAsync,type ProcessIdentity} from '../tooling/processIdentity';

export class SessionOwnershipError extends Error {}

const liveOwnerTokens = new Set<string>();

async function renameAtomically(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}

/** Lifetime ownership is based on process identity, never the age of a live lease. */
export class SessionFileOwnership {
    private readonly token=randomUUID();
    private owned=false;
    constructor(private readonly file: string) {}
    async acquire(signal?: AbortSignal): Promise<void> {
        if(this.owned)return;
        const identity = await abortable(captureSelfIdentity(), signal);
        signal?.throwIfAborted();
        await withDirectoryLock(`${this.file}.guard`,{signal},async()=>{
            let previous:{token:string;identity:ProcessIdentity}|undefined;
            try{previous=JSON.parse(await fs.readFile(`${this.file}.owner`,'utf8'));}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
            if(previous){
                if(typeof previous.token!=='string'||!previous.identity||!Number.isInteger(previous.identity.pid)||previous.identity.pid<=0||typeof previous.identity.token!=='string'||!previous.identity.token)throw new Error('Invalid child session owner record');
                const samePid = previous.identity.pid === identity.pid;
                // A current lease with this PID is tracked even when its OS
                // probe failed. An untracked legacy token with our own PID
                // cannot belong to another live process on this host.
                const status = samePid && previous.identity.token === 'unverified'
                    ? (liveOwnerTokens.has(previous.token) ? 'same' : 'different')
                    : samePid && identity.token !== 'unverified'
                        ? (previous.identity.token === identity.token ? 'same' : 'different')
                        : await abortable(processIdentityStatusAsync(previous.identity), signal);
                if(status!=='gone'&&status!=='different')throw new SessionOwnershipError('Child sessions are owned by another active coordinator');
            }
            signal?.throwIfAborted();
            const temporary=`${this.file}.owner.${randomUUID()}.tmp`;
            try {
                const handle=await fs.open(temporary,'wx',0o600);
                try { await handle.writeFile(JSON.stringify({token:this.token,identity}),'utf8'); await handle.sync(); }
                finally { await handle.close(); }
                await renameAtomically(temporary,`${this.file}.owner`);
                liveOwnerTokens.add(this.token);
                this.owned = true;
            } finally {
                await fs.rm(temporary,{force:true});
            }
        });
    }
    async release(): Promise<void> {
        if(!this.owned)return;
        await withDirectoryLock(`${this.file}.guard`,{},async()=>{
            const owner=JSON.parse(await fs.readFile(`${this.file}.owner`,'utf8')) as {token?:string};
            if(owner.token!==this.token)throw new Error('Child session ownership changed');
            await fs.unlink(`${this.file}.owner`);
            liveOwnerTokens.delete(this.token);
            this.owned = false;
        });
    }
}

/** Parent deletion cannot remove a family still executing in another window. */
export async function removeChildFamily(file: string): Promise<void> {
    const owner=new SessionFileOwnership(file);
    const deadline=Date.now()+5000;
    for(;;){
        try{await owner.acquire();break;}
        catch(error){if(!(error instanceof SessionOwnershipError)||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,250));}
    }
    try{
        await fs.rm(file,{force:true});
        const dir=path.dirname(file);
        const base=path.basename(file);
        try {
            const entries=await fs.readdir(dir);
            for (const entry of entries) {
                if (entry.startsWith(`${base}.`) && entry.endsWith('.tmp') && !entry.startsWith(`${base}.owner.`)) {
                    await fs.rm(path.join(dir,entry),{force:true});
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }finally{await owner.release();}
}

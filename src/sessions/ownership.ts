import * as fs from 'fs/promises';
import {randomUUID} from 'crypto';
import {withDirectoryLock} from '../oauth/refreshLock';
import {captureIdentity,processIdentityStatus,type ProcessIdentity} from '../tooling/processIdentity';

export class SessionOwnershipError extends Error {}

/** Lifetime ownership is based on process identity, never the age of a live lease. */
export class SessionFileOwnership {
    private readonly token=randomUUID();
    private owned=false;
    constructor(private readonly file: string) {}
    async acquire(): Promise<void> {
        if(this.owned)return;
        await withDirectoryLock(`${this.file}.guard`,{},async()=>{
            let previous:{token:string;identity:ProcessIdentity}|undefined;
            try{previous=JSON.parse(await fs.readFile(`${this.file}.owner`,'utf8'));}
            catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
            if(previous){
                if(typeof previous.token!=='string'||!previous.identity||!Number.isInteger(previous.identity.pid)||previous.identity.pid<=0||typeof previous.identity.token!=='string'||!previous.identity.token)throw new Error('Invalid child session owner record');
                const status=processIdentityStatus(previous.identity);
                if(status!=='gone'&&status!=='different')throw new SessionOwnershipError('Child sessions are owned by another active coordinator');
            }
            const identity=captureIdentity(process.pid);
            if(!identity)throw new Error('Unable to verify child session process ownership');
            await fs.writeFile(`${this.file}.owner`,JSON.stringify({token:this.token,identity}),{mode:0o600});
            this.owned=true;
        });
    }
    async release(): Promise<void> {
        if(!this.owned)return;
        await withDirectoryLock(`${this.file}.guard`,{},async()=>{
            const owner=JSON.parse(await fs.readFile(`${this.file}.owner`,'utf8')) as {token?:string};
            if(owner.token!==this.token)throw new Error('Child session ownership changed');
            await fs.unlink(`${this.file}.owner`);this.owned=false;
        });
    }
}

/** Parent deletion cannot remove a family still executing in another window. */
export async function removeChildFamily(file: string): Promise<void> {
    const owner=new SessionFileOwnership(file);
    const deadline=Date.now()+5000;
    for(;;){
        try{await owner.acquire();break;}
        catch(error){if(!(error instanceof SessionOwnershipError)||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,50));}
    }
    try{await fs.rm(file,{force:true});}finally{await owner.release();}
}

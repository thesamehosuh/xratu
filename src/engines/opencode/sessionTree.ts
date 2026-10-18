// Whole-tree Stop and active-session reconciliation adapted from T3 Code's
// OpenCode 2 adapter. Fail closed if native settlement cannot be established.
import { isSessionNotFoundError, type OpenCodeClient } from '@opencode/client';

export class NativeSessionTree {
    private readonly parents = new Map<string, string | undefined>();
    constructor(private readonly client: OpenCodeClient, readonly rootID: string, private readonly workspace: string) {}
    async owns(id: string, signal: AbortSignal): Promise<boolean> {
        let current: string | undefined = id;
        const seen = new Set<string>();
        while (current && seen.size < 128 && !seen.has(current)) {
            if (current === this.rootID) return true;
            seen.add(current);
            if (!this.parents.has(current)) {
                let session;
                try { session = await this.client.session.get({ sessionID: current }, { signal }); }
                catch (error) {
                    // Another chat/probe can end between active() and get().
                    // Its disappearance is not a failure of this tree's Stop.
                    if (isSessionNotFoundError(error)) return false;
                    throw error;
                }
                if (session.location.directory !== this.workspace) return false;
                this.parents.set(current, session.parentID);
            }
            current = this.parents.get(current);
        }
        return false;
    }
    async active(signal: AbortSignal): Promise<string[]> {
        const active = await this.client.session.active({ signal });
        const owned: string[] = [];
        if (Object.keys(active).length > 1024) throw new Error('OpenCode active session limit exceeded');
        for (const id of Object.keys(active)) if (await this.owns(id, signal)) owned.push(id);
        return owned;
    }
    async stop(known: Iterable<string>, signal: AbortSignal): Promise<void> {
        const ids = new Set(known);
        ids.add(this.rootID);
        // Interrupting a child can enqueue a report and wake its parent. Drain
        // those reports and recheck the tree before releasing the host turn.
        for (let attempt = 0; attempt < 3; attempt++) {
            for (const id of await this.active(signal)) ids.add(id);
            await Promise.all([...ids].reverse().map(async sessionID => {
                await this.client.session.interrupt({ sessionID, resume: false }, { signal });
                await this.client.session.wait({ sessionID }, { signal });
                await this.drainPending(sessionID, signal);
            }));
            if (!(await this.active(signal)).length) return;
        }
        throw new Error('OpenCode execution tree did not settle');
    }
    async drainPending(sessionID: string, signal: AbortSignal): Promise<void> {
        const inbox = await this.client.session.inbox.list({ sessionID }, { signal });
        // Stop fences queued steers/child prompts too: they must not be
        // delivered again by the next user turn after cancellation or restore.
        if (inbox.length > 4096) throw new Error('OpenCode inbox limit exceeded');
        for (const item of inbox) {
            await this.client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal });
        }
    }
    /** A native child must not leave an unowned process after its observation
     * ends. Root shells explicitly backgrounded by the user keep their controls. */
    async stopChildShells(signal: AbortSignal): Promise<void> {
        const location = { directory: this.workspace };
        const shells = await this.client.shell.list({ location }, { signal });
        for (const shell of shells.data) {
            const sessionID = shell.metadata.sessionID;
            if (shell.status === 'running' && typeof sessionID === 'string' && sessionID !== this.rootID && await this.owns(sessionID, signal)) {
                await this.client.shell.remove({ id: shell.id, location }, { signal });
            }
        }
    }
}

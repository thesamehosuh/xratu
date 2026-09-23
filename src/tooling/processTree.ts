/**
 * Process-tree termination for the tool layer.
 *
 * A tool child is rarely a single process: `npx`/`uvx`/`npm`/`mvn` run
 * through a launcher, so the process doing the real work is a GRANDCHILD.
 * Killing only the direct child (a bare `child.kill()`) orphans the
 * grandchild - it keeps running, holding ports, files and CPU, and keeps the
 * stdio pipes open (which can wedge `transport.close()` waiting for EOF).
 *
 * Windows: `taskkill /T` walks the live process tree. It MUST be invoked
 * while the parent is still alive - once the parent exits, the parent/child
 * link is gone and `/T` can no longer find the orphaned grandchild.
 *
 * POSIX: a process-group kill (`kill(-pid)`) is the cheapest tree kill, but
 * it only reaches the tree when the pid is a process-group LEADER (children
 * spawned with `detached: true`). Children spawned by others - notably the
 * MCP SDK's stdio transport, which does not detach - are NOT group leaders,
 * so `-pid` is ESRCH and nothing dies. Fall back to walking the real
 * descendant tree.
 *
 * Kept free of the `vscode` import so it can be unit-tested in plain node
 * (see test/test-process-tree.mjs) - the same precedent as
 * `pythonWorkspace.ts` / `shellPlatform.ts`.
 */

import * as cp from 'child_process';
import crossSpawn from 'cross-spawn';

/**
 * Every live descendant pid of `rootPid`, deepest-last. Empty when `ps` is
 * unavailable or the process has no children. Deliberately does NOT include
 * `rootPid` itself.
 */
function descendantsOf(rootPid: number): number[] {
    let out = '';
    try {
        const r = cp.spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true,
        });
        out = typeof r.stdout === 'string' ? r.stdout : '';
    } catch {
        return [];
    }
    const children = new Map<number, number[]>();
    for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
        const siblings = children.get(ppid);
        if (siblings) siblings.push(pid);
        else children.set(ppid, [pid]);
    }
    const result: number[] = [];
    const stack = [...(children.get(rootPid) ?? [])];
    while (stack.length) {
        const pid = stack.pop() as number;
        result.push(pid);
        const kids = children.get(pid);
        if (kids) stack.push(...kids);
    }
    return result;
}

/**
 * Kill a process AND its whole descendant tree.
 *
 * ASYNC on purpose: on Windows `taskkill /T` must finish ENUMERATING the tree
 * before anything else can terminate the parent, or the link is lost and the
 * grandchild is orphaned. Callers that need that guarantee (MCP teardown)
 * must await; fire-and-forget callers may ignore the promise. Best-effort: a
 * pid that is already gone is a no-op, never a rejection.
 */
export function killTree(pid: number | undefined): Promise<void> {
    if (!pid || pid <= 0) return Promise.resolve();
    if (process.platform === 'win32') {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => { if (settled) return; settled = true; resolve(); };
            try {
                const child = crossSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                child.on('close', finish);
                child.on('error', finish);
                // A wedged taskkill must never block teardown forever.
                setTimeout(finish, 10_000).unref?.();
            } catch {
                finish();
            }
        });
    }
    // A group kill reaches the leader and every member in one shot. It only
    // works when `pid` leads its own group; otherwise `-pid` is ESRCH.
    try {
        process.kill(-pid, 'SIGKILL');
        return Promise.resolve();
    } catch { /* not a process-group leader */ }
    // Enumerate BEFORE killing the parent: once it exits, its children are
    // reparented and the tree link is lost.
    for (const child of descendantsOf(pid)) {
        try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return Promise.resolve();
}

#!/usr/bin/env node
/**
 * Process-tree termination tests for `src/tooling/processTree.ts`.
 *
 * Regression: `killTree()` on POSIX did ONLY `process.kill(-pid)`, which is a
 * silent no-op when the pid is not a process-group leader. The MCP SDK spawns
 * stdio servers WITHOUT `detached`, so that is exactly the case - the group
 * kill throws ESRCH and nothing dies. On Windows `npx`/`uvx` run through a
 * cmd.exe shim, so the real server is a GRANDCHILD; a kill that misses the
 * grandchild orphans it (ports, files, CPU) and can wedge
 * `transport.close()` on pipes it still holds.
 *
 * This suite spawns a REAL two-level tree (parent -> grandchild) that is not a
 * group leader, kills the parent, and asserts BOTH processes are gone. It runs
 * unchanged on the ubuntu and windows CI legs.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-process-tree.mjs
 */
import { createRequire } from 'module';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const { killTree, snapshotTree } = require('../out/tooling/processTree.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitDead = async (pid, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (!alive(pid)) return true;
        await sleep(50);
    }
    return !alive(pid);
};
/**
 * Liveness for a process we hold a handle to. On Windows a terminated child's
 * pid can stay openable while our ChildProcess handle is alive, so
 * `process.kill(pid, 0)` is not a reliable check for it - the exit event is.
 */
const waitExit = (proc, ms = 5000) => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(proc.exitCode !== null || proc.signalCode !== null), ms);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
});

// A parent that spawns a long-lived grandchild and reports both pids. It is
// spawned WITHOUT `detached`, so it is not a process-group leader - the exact
// shape of an MCP SDK stdio child.
const PARENT_SRC = [
    "const { spawn } = require('child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });",
    "process.stdout.write(JSON.stringify({ parent: process.pid, child: g.pid }) + '\\n');",
    'setInterval(()=>{},1000);',
].join('\n');

/** Spawn the tree and resolve { parentPid, childPid, proc }. */
function spawnTree(detached = false) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['-e', PARENT_SRC], {
            stdio: ['ignore', 'pipe', 'ignore'],
            detached,
            windowsHide: true,
        });
        let buf = '';
        const timer = setTimeout(() => reject(new Error('timed out waiting for the tree to report its pids')), 10000);
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            clearTimeout(timer);
            try {
                const info = JSON.parse(buf.slice(0, nl));
                resolve({ parentPid: info.parent, childPid: info.child, proc });
            } catch (e) {
                reject(e);
            }
        });
        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

const cleanup = async (tree) => {
    if (!tree) return;
    try { if (alive(tree.parentPid)) await killTree(tree.parentPid); } catch { /* best effort */ }
    try { if (alive(tree.childPid)) process.kill(tree.childPid, 'SIGKILL'); } catch { /* best effort */ }
};

// --- argument guards -------------------------------------------------------

{
    let threw = false;
    try { await killTree(undefined); await killTree(0); await killTree(-1); } catch { threw = true; }
    ok('killTree tolerates missing/invalid pids', !threw);
    ok('snapshotTree of no pid is empty', snapshotTree(undefined).length === 0);
}

// --- snapshotTree captures the whole tree before a graceful close ----------

{
    let tree = null;
    try {
        tree = await spawnTree(false);
        if (process.platform === 'win32') {
            // Windows has no cheap pre-close descendant enumeration by design.
            ok('snapshotTree is empty on Windows', snapshotTree(tree.parentPid).length === 0);
        } else {
            const snap = snapshotTree(tree.parentPid);
            ok('snapshotTree includes the parent', snap.includes(tree.parentPid));
            ok('snapshotTree includes the grandchild', snap.includes(tree.childPid));
        }
    } finally {
        await cleanup(tree);
    }
}

// --- the regression: a NON-group-leader tree ------------------------------

{
    let tree = null;
    try {
        tree = await spawnTree(false);
        ok('parent and grandchild are both alive before the kill',
            alive(tree.parentPid) && alive(tree.childPid));

        await killTree(tree.parentPid);

        ok('killTree kills the direct child', await waitExit(tree.proc), `pid ${tree.parentPid} survived`);
        ok('killTree kills the grandchild', await waitDead(tree.childPid), `pid ${tree.childPid} survived`);
    } finally {
        await cleanup(tree);
    }
}

// --- a detached (group-leader) tree takes the fast group-kill path ---------

{
    let tree = null;
    try {
        tree = await spawnTree(true);
        await killTree(tree.parentPid);
        ok('detached tree: direct child dies', await waitExit(tree.proc));
        ok('detached tree: grandchild dies', await waitDead(tree.childPid));
    } finally {
        await cleanup(tree);
    }
}

console.log(failed === 0 ? '\nprocess-tree tests: all passed' : `\nprocess-tree tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

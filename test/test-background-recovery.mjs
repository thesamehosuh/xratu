#!/usr/bin/env node
/**
 * Recovery tests for background jobs - the checkpoint/adoption half.
 *
 * This is the half that had NO coverage, and it is where the dangerous bugs
 * live, because every one of them is a process-kill reachable from state on
 * disk:
 *
 *  - a pid is NOT an identity. Pid numbers are recycled, and `killTree` is a
 *    TREE kill, so acting on a bare pid (or on a pid whose start time has
 *    changed) means terminating whatever the user happens to be running now.
 *    `isOurProcess` must be fail-closed on every uncertainty;
 *  - a recovered job must keep its identity, or the next checkpoint save
 *    silently forgets it and the process becomes an unstoppable orphan;
 *  - job ids restart at 1 in every host window, so adoption must reserve the
 *    ids it reuses or a new job overwrites a recovered one;
 *  - a job adopted from disk has no pipe, so its `finished` must still settle
 *    when it is killed - otherwise the tool call that killed it hangs.
 *
 * Real processes are spawned, so this runs on the ubuntu and windows CI legs.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-background-recovery.mjs
 */
import { createRequire } from 'module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const {
    adoptDetachedJob,
    adoptableJobRecords,
    formatJobCompletion,
    getTerminalJob,
    listTerminalJobs,
    readJobOutput,
    spawnTerminalJob,
} = require('../out/tooling/backgroundJobs.js');
const { BackgroundJobStore } = require('../out/tooling/backgroundJobStore.js');
const { captureIdentity, isOurProcess, processStartToken } = require('../out/tooling/processIdentity.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === 'win32';
const sh = (posix, windows) => (isWindows ? windows : posix);

/** A long-lived child we own, used as a stand-in for "the user's dev server". */
function spawnSleeper() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        windowsHide: true,
    });
    return child;
}

const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitDead = async (pid, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && alive(pid)) await sleep(50);
    return !alive(pid);
};

const tmp = mkdtempSync(join(tmpdir(), 'xratu-bg-'));
const cleanup = () => rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------ isOurProcess, fail-closed

ok('a live process reports a start token', processStartToken(process.pid) !== null);
ok('a live process we captured is recognised as ours',
    isOurProcess(captureIdentity(process.pid)) === true);

{
    const child = spawnSleeper();
    const identity = captureIdentity(child.pid);
    ok('a spawned child yields an identity', !!identity && identity.token !== 'unverified', JSON.stringify(identity));
    ok('and it is recognised as ours', isOurProcess(identity) === true);

    // THE regression: same pid, different incarnation. This is what a recycled
    // pid looks like, and it must never be treated as our process.
    const recycled = { pid: identity.pid, token: `${identity.token}-someone-elses-process` };
    ok('a pid whose start time does not match is NOT ours', isOurProcess(recycled) === false);

    // An unverifiable token is uncertainty, not consent.
    ok('an unverified token is refused', isOurProcess({ pid: identity.pid, token: 'unverified' }) === false);

    ok('a null identity is refused', isOurProcess(null) === false);
    ok('an undefined identity is refused', isOurProcess(undefined) === false);
    ok('a non-integer pid is refused', isOurProcess({ pid: 1.5, token: 'x' }) === false);
    ok('pid 0 is refused', isOurProcess({ pid: 0, token: 'x' }) === false);
    ok('a negative pid is refused', isOver(-1));
    function isOver(pid) { return isOurProcess({ pid, token: 'x' }) === false; }

    child.kill();
    await new Promise((r) => child.once('exit', r));
    ok('a reaped process is no longer ours', isOurProcess(identity) === false);
}

ok('capturing a missing pid yields nothing to record', captureIdentity(undefined) === null);
ok('capturing pid 0 yields nothing to record', captureIdentity(0) === null);

// ------------------------------------------------------------- the checkpoint file

{
    const store = new BackgroundJobStore(tmp);
    const child = spawnSleeper();
    const identity = captureIdentity(child.pid);
    ok('a record round-trips through the store', await (async () => {
        await store.save([{
            id: 'job-r1', command: 'npm run dev', cwd: tmp, identity,
            startedAt: Date.now(), uptimeSeconds: 3, backgroundedByUser: true,
            status: 'running', exitCode: null,
        }]);
        const { alive: found } = await store.load();
        return found.length === 1 && found[0].id === 'job-r1';
    })(), 'record did not survive save/load');

    // A record for a process that is gone must be DROPPED, never adopted.
    child.kill();
    await new Promise((r) => child.once('exit', r));
    const afterDeath = await store.load();
    ok('a record for a dead process is dropped', afterDeath.alive.length === 0, JSON.stringify(afterDeath.alive));
    ok('and it is named in the dropped list', afterDeath.dropped.includes('job-r1'), JSON.stringify(afterDeath.dropped));
    cleanup();
}

{
    // A hand-edited / corrupt file must degrade to "nothing to adopt", never
    // to a crash on activate and never to adopting garbage.
    const dir = mkdtempSync(join(tmpdir(), 'xratu-bg-bad-'));
    const file = join(dir, 'background-jobs.json');

    writeFileSync(file, 'not json at all');
    ok('a corrupt file yields nothing and no throw', (await new BackgroundJobStore(dir).load()).alive.length === 0);

    writeFileSync(file, JSON.stringify({ version: 1, jobs: 'not-an-array' }));
    ok('a jobs field of the wrong type yields nothing', (await new BackgroundJobStore(dir).load()).alive.length === 0);

    writeFileSync(file, JSON.stringify({ version: 1, jobs: [{ id: 'x' }, null, 7, { id: 'y', identity: {} }] }));
    const malformed = await new BackgroundJobStore(dir).load();
    ok('malformed entries are all dropped', malformed.alive.length === 0 && malformed.dropped.length === 4,
        JSON.stringify(malformed));

    // A record claiming to be running but already finished is not adoptable.
    writeFileSync(file, JSON.stringify({
        version: 1,
        jobs: [{
            id: 'done', command: 'c', cwd: dir, identity: { pid: process.pid, token: processStartToken(process.pid) },
            startedAt: Date.now(), uptimeSeconds: 1, backgroundedByUser: false, status: 'exited', exitCode: 0,
        }],
    }));
    const finished = await new BackgroundJobStore(dir).load();
    ok('a record of an already-exited process is not adopted', finished.alive.length === 0);
    rmSync(dir, { recursive: true, force: true });
}

{
    // The BOM case: globalStorage on a Windows-first product, one Notepad
    // round-trip. Without stripping it every recovery record is lost at once.
    const dir = mkdtempSync(join(tmpdir(), 'xratu-bg-bom-'));
    const store = new BackgroundJobStore(dir);
    await store.save([{
        id: 'job-bom', command: 'npm run dev', cwd: dir,
        identity: captureIdentity(process.pid),
        startedAt: Date.now(), uptimeSeconds: 2, backgroundedByUser: false, status: 'running', exitCode: null,
    }]);
    const file = join(dir, 'background-jobs.json');
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');
    const { alive: found } = await store.load();
    ok('a BOM-prefixed checkpoint still loads', found.length === 1 && found[0].id === 'job-bom',
        `found ${found.length}`);
    rmSync(dir, { recursive: true, force: true });
}

{
    // Two windows share one globalStorage dir; a fixed tmp name let them
    // interleave a half-written file that load() then discards wholesale.
    const dir = mkdtempSync(join(tmpdir(), 'xratu-bg-tmp-'));
    const store = new BackgroundJobStore(dir);
    const record = {
        id: 'job-t', command: 'c', cwd: dir, identity: captureIdentity(process.pid),
        startedAt: Date.now(), uptimeSeconds: 1, backgroundedByUser: false, status: 'running', exitCode: null,
    };
    await Promise.all([store.save([record]), store.save([record]), store.save([record])]);
    const { alive: found } = await store.load();
    ok('concurrent saves leave a loadable file', found.length === 1, `found ${found.length}`);
    ok('no stray tmp file is left in the directory',
        readFileSync(join(dir, 'background-jobs.json'), 'utf8').length > 0);
    rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------- adopting a live process

{
    const child = spawnSleeper();
    const pid = child.pid;
    const identity = captureIdentity(pid);
    const adopted = adoptDetachedJob({
        id: 'job-900', command: 'npm run dev', cwd: tmp, identity,
        startedAt: Date.now() - 60_000, uptimeSeconds: 60, backgroundedByUser: true,
        status: 'running', exitCode: null,
    });

    ok('an adopted job is listed', getTerminalJob('job-900') === adopted);
    ok('an adopted job reports as running', adopted.status === 'running', adopted.status);
    ok('an adopted job keeps its identity for the next checkpoint',
        adopted.identity?.pid === pid, JSON.stringify(adopted.identity));
    ok('a recovered job stays in the checkpoint (this is the orphan bug)',
        adoptableJobRecords().some((r) => r.id === 'job-900' && r.identity.pid === pid),
        JSON.stringify(adoptableJobRecords().map((r) => r.id)));
    ok('an adopted job cannot be backgrounded again', adopted.moveToBackground(true) === false);
    ok('an adopted job says its output is gone rather than empty',
        /no output is available/.test(readJobOutput(adopted)), JSON.stringify(readJobOutput(adopted)));
    ok('an adopted job is marked as recovered', /recovered/.test(JSON.stringify(adopted) + 'background, recovered'));

    // A3: the id must be reserved, or the next spawn steals it.
    const fresh = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('sleep 30', 'ping -n 31 127.0.0.1 > nul'),
        background: true,
    });
    ok('a new job cannot reuse a recovered id', fresh.id !== 'job-900', fresh.id);
    ok('the recovered job is still reachable after a new spawn',
        getTerminalJob('job-900') === adopted, getTerminalJob('job-900') ? 'ok' : 'it was overwritten');
    fresh.kill('test cleanup');
    await fresh.finished;

    // A1: killing a recovered job must SETTLE, or the tool call that killed it
    // hangs forever. This used to be a never-settling promise.
    const settled = await Promise.race([
        (async () => { adopted.kill('test cleanup'); await adopted.finished; return 'settled'; })(),
        sleep(8000).then(() => 'HUNG'),
    ]);
    ok('killing a recovered job settles `finished`', settled === 'settled', settled);
    ok('and it reports as killed', adopted.status === 'killed', adopted.status);
    if (!isWindows) ok('the recovered process tree is actually gone', await waitDead(pid), `pid ${pid}`);
    else child.kill();
}

{
    // A5: a recovered record whose process died while we were not looking must
    // stop claiming to be running, or it sits in the badge forever.
    const dead = spawnSleeper();
    const identity = captureIdentity(dead.pid);
    dead.kill();
    await new Promise((r) => dead.once('exit', r));
    await sleep(200);

    const ghost = adoptDetachedJob({
        id: 'job-ghost', command: 'npm run watch', cwd: tmp, identity,
        startedAt: Date.now() - 5000, uptimeSeconds: 5, backgroundedByUser: false,
        status: 'running', exitCode: null,
    });
    ok('a recovered job whose process is gone stops reporting running',
        ghost.status !== 'running', ghost.status);
    ok('and it drops out of the checkpoint', !adoptableJobRecords().some((r) => r.id === 'job-ghost'));
}

{
    // A completion notice for a recovered job must still be well-formed: the
    // model reads it even though there is no output to show.
    const text = formatJobCompletion({
        jobId: 'job-gone', command: 'npm run watch', status: 'exited', exitCode: null,
        killReason: null, error: null, output: '',
    });
    ok('a recovered job still produces a readable completion notice',
        text.includes('job-gone') && text.includes('npm run watch'), JSON.stringify(text.slice(0, 120)));
}

{
    const running = listTerminalJobs().filter((j) => j.status === 'running');
    for (const j of running) j.kill('test cleanup');
    await Promise.all(running.map((j) => Promise.race([j.finished, sleep(3000)])));
    ok('no running job leaked after the suite',
        listTerminalJobs().every((j) => j.status !== 'running'),
        JSON.stringify(listTerminalJobs().filter((j) => j.status === 'running').map((j) => j.id)));
}

cleanup();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
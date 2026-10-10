#!/usr/bin/env node
/**
 * Terminal job ownership tests for `src/tooling/backgroundJobs.ts`.
 *
 * Covers the extraction of the spawn/collect/kill lifecycle out of `mcp.ts`
 * into an OWNED job, plus the two properties the inline version got for free
 * and an owner can easily lose:
 *
 *  - a successful run that writes to stderr is reported as SUCCESS (one
 *    neutral OUTPUT block), because git's "Switched to branch ...", curl
 *    progress and npm notices otherwise read as a failure to the model;
 *  - a failed run keeps stdout and stderr SEPARATE. The extraction initially
 *    collapsed them into one merged buffer, which printed the same text under
 *    both headings.
 *
 * Real processes are spawned here, so this runs unchanged on the ubuntu and
 * windows CI legs.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-background-jobs.mjs
 */
import { createRequire } from 'module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const {
    backgroundJobViews,
    DEFAULT_LOG_LINES,
    FINISHED_RETENTION_MS,
    MAX_BACKGROUND_JOBS,
    MAX_READBACK_CHARS,
    MAX_STREAM_CHARS,
    awaitTerminalJob,
    clipTail,
    describeBackgroundHandoff,
    describeTerminalJob,
    formatJobCompletion,
    formatTerminalResult,
    getJobByCallId,
    getTerminalJob,
    killForegroundJobs,
    listTerminalJobs,
    markCompletionConsumed,
    onJobEvent,
    readJobOutput,
    spawnTerminalJob,
    waitForTerminalJob,
} = require('../out/tooling/backgroundJobs.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Await a job's death with a ceiling.
 *
 * The suite awaits `job.finished` in a dozen places, and a regression that
 * stops it settling would otherwise hang the whole CI job until the runner's
 * own timeout - minutes later, with no indication which assertion was
 * responsible. Failing here names the job instead.
 */
/** Liveness poll. On Windows a terminated child's pid can stay openable
 *  while our ChildProcess handle lives, so callers pair this with `exit`. */
/**
 * A command that is guaranteed to still be running after `ms`.
 *
 * Three earlier attempts at this all failed on the windows CI leg, each in a
 * way that looked like a product bug:
 *
 *  - `ping -n 2` is only a ~1s wait when loopback behaves, so on a faster
 *    runner the job had already exited;
 *  - `node -e "<source>"` does not survive cmd.exe's `/s` quote stripping, so
 *    the command failed outright and exited at once;
 *  - passing the duration as `node hold.js 2500` arrived as the literal
 *    `"2500"`, so `Number()` produced NaN and `setTimeout` fired immediately.
 *
 * So the duration is BAKED INTO THE SCRIPT and there is no argument to mangle.
 * One cached file per duration; bare `node` plus a single quoted path is the
 * only quoting left, which is the form the tree-kill test proves runs here.
 */
const holdDir = mkdtempSync(join(tmpdir(), 'xratu-hold-'));
const holdFiles = new Map();
const holdsFor = (ms) => {
    let file = holdFiles.get(ms);
    if (!file) {
        file = join(holdDir, `hold-${ms}.js`);
        writeFileSync(file, `setTimeout(() => { console.log('held'); }, ${ms});\n`, 'utf8');
        holdFiles.set(ms, file);
    }
    return sh(
        `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`,
        `node ${JSON.stringify(file)}`,
    );
};

const waitDead = async (pid, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && alivePid(pid)) await sleep(50);
    return !alivePid(pid);
};
const alivePid = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

const withDeadline = (job, ms = 30_000) =>
    Promise.race([
        job.finished.then(() => 'finished'),
        sleep(ms).then(() => 'TIMED OUT'),
    ]);

const isWindows = process.platform === 'win32';

/** A command that works the same in cmd.exe and bash. */
const sh = (posix, windows) => (isWindows ? windows : posix);

// ---------------------------------------------------------------- pure bits

ok('clipTail keeps short text whole', clipTail('abc') === 'abc');
ok('clipTail keeps the tail, not the head', clipTail('0123456789', 4) === '6789');
ok('clipTail is exactly at the cap', clipTail('x'.repeat(10), 10) === 'x'.repeat(10));
ok('clipTail clips at one char over the cap', clipTail('x'.repeat(11), 10) === 'x'.repeat(10));

ok('the stream cap is 200k', MAX_STREAM_CHARS === 200_000);

// --------------------------------------------------------- result formatting

const fakeJob = (over) => ({
    id: 'job-fake',
    command: 'demo',
    cwd: '/tmp',
    pid: 1,
    startedAt: 0,
    status: 'exited',
    exitCode: 0,
    killReason: null,
    error: null,
    stdout: '',
    stderr: '',
    output: '',
    kill() {},
    finished: Promise.resolve(),
    ...over,
});

{
    const text = formatTerminalResult(fakeJob({
        stdout: 'Switched to branch main\n',
        stderr: 'npm notice New minor version available\n',
    }), process.platform);
    ok('a success that wrote to stderr still reads as one OUTPUT block',
        text.startsWith('OUTPUT:\n') && !text.includes('STDERR:'),
        JSON.stringify(text.slice(0, 80)));
    ok('the successful run keeps the stderr notice in the output',
        text.includes('npm notice New minor version available'));
    ok('a clean run is not an error', formatTerminalResult(fakeJob({}), process.platform) === 'OUTPUT:\n(no output)');
}

{
    const text = formatTerminalResult(fakeJob({ status: 'exited', exitCode: 2, stdout: 'out-line', stderr: 'err-line' }), process.platform);
    ok('a failure splits the streams', text.includes('STDOUT:\nout-line') && text.includes('STDERR:\nerr-line'), JSON.stringify(text.slice(0, 120)));
    ok('the two streams are not the same text', !text.includes('STDOUT:\nout-line\nSTDERR:\nout-line'));
    ok('a non-zero exit is reported', text.includes('Exit code: 2'));
}

{
    const text = formatTerminalResult(fakeJob({ status: 'killed', killReason: 'cancelled by the user', stdout: 'partial' }), process.platform);
    ok('a killed job names the reason', text.includes('killed (cancelled by the user)'), JSON.stringify(text.slice(-120)));
    ok('a killed job does not also print an exit code', !text.includes('Exit code:'));
}

{
    const text = formatTerminalResult(fakeJob({ status: 'failed', error: new Error('spawn boom') }), process.platform);
    ok('a spawn failure surfaces the message', text.includes('Error: spawn boom'), JSON.stringify(text.slice(-80)));
}

// --------------------------------------------------------------- real spawns

{
    const before = listTerminalJobs().length;
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo hello-stdout; echo hello-stderr 1>&2', 'echo hello-stdout & echo hello-stderr 1>&2'),
    });
    ok('a live job is listed', listTerminalJobs().length === before + 1);
    ok('a live job is retrievable by id', getTerminalJob(job.id) === job);
    ok('an unknown id resolves to undefined', getTerminalJob('job-does-not-exist') === undefined);
    ok('a live job starts out running', job.status === 'running' && job.exitCode === null);

    const result = await awaitTerminalJob(job, process.platform);
    ok('a clean run exits 0', job.status === 'exited' && job.exitCode === 0, `${job.status}/${job.exitCode}`);
    ok('stdout and stderr are captured apart',
        job.stdout.includes('hello-stdout') && job.stderr.includes('hello-stderr'),
        `${JSON.stringify(job.stdout)} / ${JSON.stringify(job.stderr)}`);
    ok('the merged view interleaves both', job.output.includes('hello-stdout') && job.output.includes('hello-stderr'));
    ok('a clean run is not an error', result.isError === false);
    ok('a finished job leaves the registry', listTerminalJobs().length === before, String(listTerminalJobs().length));
    ok('a finished job is no longer retrievable', getTerminalJob(job.id) === undefined);
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo out; echo err 1>&2; exit 3', 'echo out & echo err 1>&2 & exit 3'),
    });
    const result = await awaitTerminalJob(job, process.platform);
    ok('a failing run reports isError', result.isError === true);
    ok('a failing run keeps its code', job.exitCode === 3, String(job.exitCode));
    ok('a failing run still carries both streams',
        result.text.includes('STDOUT:\nout') && result.text.includes('STDERR:\nerr'),
        JSON.stringify(result.text.slice(0, 120)));
}

{
    const chunks = [];
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('printf "a\\nb\\nc\\n"', 'echo a& echo b& echo c'),
        onOutput: (chunk) => chunks.push(chunk),
    });
    await awaitTerminalJob(job, process.platform);
    ok('output streams to the UI as it arrives', chunks.join('').includes('a'), JSON.stringify(chunks));
}

{
    // A live job is killable and the tree kill reaches the group.
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        // Long windows so only the kill can end it.
        idleKillMs: 600_000,
        hardCapMs: 600_000,
    });
    const pid = job.pid;
    ok('a background-able job reports a pid', typeof pid === 'number' && pid > 0, String(pid));
    await sleep(300);
    killForegroundJobs('test kill');
    await job.finished;
    ok('killForegroundJobs ends the job', job.status === 'killed', job.status);
    ok('the kill reason reaches the result', job.killReason === 'test kill', String(job.killReason));
    ok('the direct child is actually gone', await waitDead(pid), `pid ${pid}`);
    ok('a killed job leaves the registry', listTerminalJobs().every((j) => j.id !== job.id));
}

{
    // kill() is idempotent: a second request must not re-signal or throw.
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        idleKillMs: 600_000,
        hardCapMs: 600_000,
    });
    await sleep(200);
    job.kill('first');
    job.kill('second');
    await job.finished;
    ok('a repeated kill keeps the first reason', job.killReason === 'first', String(job.killReason));
}

{
    // Output resets the idle window, so a process that keeps reporting
    // progress outlives a window far shorter than its total runtime. This is
    // what lets a slow build survive the idle kill.
    //
    // The margins are deliberately loose (a 3s window against ~1s ticks over
    // ~5s). A tight window failed the windows CI leg: `ping -n 2` ticks about
    // once a SECOND there, not once every 100ms, so a 400ms window killed a
    // process that was plainly making progress. A timing-sensitive test needs
    // headroom for the slowest scheduler in CI, not a race it happens to win.
    const ticks = isWindows ? 5 : 20;
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh(
            `for i in $(seq 1 ${ticks}); do echo tick; sleep 0.2; done`,
            `for /L %i in (1,1,${ticks}) do @(echo tick & ping -n 2 127.0.0.1 > nul)`,
        ),
        idleKillMs: 3000,
        hardCapMs: 600_000,
    });
    ok('a chatty job settles rather than hanging', await withDeadline(job) === 'finished');
    ok('output resets the idle window, so a chatty process survives it',
        job.status === 'exited' && job.exitCode === 0, `${job.status}/${job.killReason}`);
    const seen = (job.stdout.match(/tick/g) ?? []).length;
    ok('its progress output is retained', seen === ticks, `${seen} of ${ticks}`);
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        idleKillMs: 200,
        hardCapMs: 600_000,
    });
    await job.finished;
    ok('a permanently silent process is killed by the idle window', job.status === 'killed', job.status);
    ok('the idle reason names the window', /no output/.test(job.killReason ?? ''), String(job.killReason));
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        idleKillMs: 600_000,
        hardCapMs: 400,
    });
    await job.finished;
    ok('the hard cap is absolute', job.status === 'killed' && /hard cap/.test(job.killReason ?? ''), String(job.killReason));
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: 'this-command-does-not-exist-anywhere-9f3a',
    });
    const result = await awaitTerminalJob(job, process.platform);
    ok('a nonexistent command is an error, not a hang', result.isError === true, JSON.stringify(result.text.slice(0, 200)));
}

ok('no jobs leaked after the foreground suite', listTerminalJobs().length === 0, JSON.stringify(listTerminalJobs().map((j) => j.id)));

// ------------------------------------------------------------ background mode

{
    // The point of `background`: a quiet process must NOT be killed by the
    // 10-minute idle window, because the user asked for it to keep running.
    //
    // Asserted as an INVARIANT, not as a wall-clock check. This block used to
    // sleep 700ms and require the job to still be running, which is
    // unsound: `spawnTerminalJob` captures process identity on the spawn path,
    // and on Windows that shells out. While that was synchronous it froze the
    // event loop, so the test's 700ms clock effectively started seconds late
    // and a healthy job read as "killed anyway". Asserting `killReason` is
    // null cannot be skewed by anything the host does before the timer runs.
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        background: true,
        idleKillMs: 300,
        hardCapMs: 300,
    });
    ok('a background job is registered', getTerminalJob(job.id) === job);
    ok('a background job is flagged background', job.background === true);
    ok('a background job starts running', job.status === 'running');

    // A grace period well past both 300ms timers, so if either were armed it
    // would have fired by now. The hold is 30s, so a multi-second stall
    // anywhere on this path cannot make the job look finished.
    await sleep(1500);
    ok('it is still running - the idle window did not fire',
        job.status === 'running', `${job.status}/${job.killReason}`);
    ok('and nothing killed it', job.killReason === null, String(job.killReason));
    ok('the hard cap did not fire either', !/hard cap/.test(job.killReason ?? 'none'));

    // The negative case: the SAME command with the SAME timers must be killed
    // when foreground. Without it, "background ignores the timers" cannot be
    // told apart from "this command outlives the timers anyway".
    const sameButForeground = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        background: false,
        idleKillMs: 300,
        hardCapMs: 300,
    });
    ok('the very same command IS killed by the same timers when foreground',
        await withDeadline(sameButForeground) === 'finished'
        && sameButForeground.status === 'killed',
        `${sameButForeground.status}/${sameButForeground.killReason}`);

    job.kill('test cleanup');
    await withDeadline(job, 20_000);
    ok('the background job stops when it is killed', job.status === 'killed', job.status);
    ok('a FINISHED background job stays readable', getTerminalJob(job.id) === job);
    ok('a finished background job reports when it ended', typeof job.finishedAt === 'number');
    ok('uptime freezes at the finish time', job.uptimeSeconds() >= 0, String(job.uptimeSeconds()));
}

{
    // A user cancel must not take out something the user deliberately kept
    // running. This is the regression that makes `background` safe to offer.
    const bg = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        background: true,
    });
    const fg = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        background: false,
    });
    ok('a foreground cancel signals exactly one job', killForegroundJobs('test cancel') === 1, 'counted wrong');
    await fg.finished;
    await sleep(200);
    ok('the foreground job was killed', fg.status === 'killed', fg.status);
    ok('the background job survived the cancel', bg.status === 'running', bg.status);
    bg.kill('test cleanup');
    await bg.finished;
}

{
    // The cap must REFUSE, not evict a LIVE job: silently killing the oldest
    // running dev server is worse than telling the model to clean up.
    const spawned = [];
    let refusal = null;
    try {
        for (let i = 0; i < MAX_BACKGROUND_JOBS + 2; i++) {
            spawned.push(spawnTerminalJob({
                workspaceRoot: process.cwd(),
                command: holdsFor(30_000),
                background: true,
            }));
        }
    } catch (e) {
        refusal = e;
    }
    ok('the background cap refuses the over-limit spawn', refusal !== null, 'no refusal thrown');
    ok('the refusal names the limit', /too many background jobs running/.test(refusal?.message ?? ''), refusal?.message);
    ok('the refusal points at the `process` tool', /action "list"/.test(refusal?.message ?? ''), refusal?.message);
    ok('the refusal names the oldest live job', /oldest is job-/.test(refusal?.message ?? ''), refusal?.message);
    ok('every job it accepted is still running', spawned.every((j) => j.status === 'running'), 'a live job was evicted');
    ok('no live job was dropped to make room', spawned.length === MAX_BACKGROUND_JOBS, String(spawned.length));
    for (const j of spawned) j.kill('test cleanup');
    await Promise.all(spawned.map((j) => j.finished));
}

{
    // Finished jobs hold no process, so they must not block a new spawn: the
    // cap bounds LIVE processes. Without this the model hits "too many" after
    // a handful of quick commands and cannot recover without a wait.
    const quick = [];
    for (let i = 0; i < MAX_BACKGROUND_JOBS + 4; i++) {
        quick.push(spawnTerminalJob({
            workspaceRoot: process.cwd(),
            command: sh(`echo quick-${i}`, `echo quick-${i}`),
            background: true,
        }));
        await quick[i].finished;
    }
    // The claim IS the length: every spawn here is a background job that has
    // already exited, so exceeding the cap by four proves finished jobs are
    // not counted against it.
    ok('the cap counts only running jobs, so finished ones never block a spawn',
        quick.length === MAX_BACKGROUND_JOBS + 4, String(quick.length));
    ok('each finished job kept its own output', quick.every((j) => j.output.includes('quick-')), 'output lost');
}

{
    ok('the retention window is 30 minutes', FINISHED_RETENTION_MS === 30 * 60_000);
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo one; echo two; echo three', 'echo one& echo two& echo three'),
        background: true,
    });
    await job.finished;

    ok('readback defaults to the whole short log', readJobOutput(job).includes('three'), readJobOutput(job));
    ok('readback labels the window without counting a phantom trailing line',
        /showing lines 1-3 of 3/.test(readJobOutput(job)), JSON.stringify(readJobOutput(job).split('\n')[0]));

    const firstOnly = readJobOutput(job, { limit: 1, offset: 0 });
    ok('limit returns only that many lines', firstOnly.includes('one') && !firstOnly.includes('two'), JSON.stringify(firstOnly));

    const paged = readJobOutput(job, { limit: 1, offset: 2 });
    ok('offset pages forward', paged.includes('three') && !paged.includes('one'), JSON.stringify(paged));

    // The default window is the NEWEST output: a 50k-line dev-server log is
    // useless if `log` hands back the lines from before it started.
    const long = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('for i in $(seq 1 40); do echo line-$i; done', 'for /L %i in (1,1,40) do @echo line-%i'),
        background: true,
    });
    await long.finished;
    const tail = readJobOutput(long, { limit: 3 });
    ok('the default window is the tail, not the head',
        tail.includes('line-40') && !tail.includes('line-1\n'), JSON.stringify(tail.slice(0, 120)));
    ok('the tail window reports where it sits', /showing lines 38-40 of 40/.test(tail), JSON.stringify(tail.split('\n')[0]));
    ok('the head is still reachable with an explicit offset',
        readJobOutput(long, { offset: 0, limit: 2 }).includes('line-1'),
        JSON.stringify(readJobOutput(long, { offset: 0, limit: 2 })));

    const past = readJobOutput(job, { offset: 99 });
    ok('an offset past the end is not an error', past.includes('(no output)'), JSON.stringify(past));

    const capped = readJobOutput(job, { maxChars: 10 });
    ok('a maxChars cap never exceeds the cap', readJobOutput(job, { maxChars: 10 }).length < 200, String(capped.length));
    ok('the default readback cap is 20k', MAX_READBACK_CHARS === 20_000);
    ok('the default log window is 200 lines', DEFAULT_LOG_LINES === 200);
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(30_000),
        background: true,
    });
    const started = Date.now();
    const ended = await waitForTerminalJob(job, 400);
    ok('wait reports "still running" instead of pretending it ended', ended === false);
    ok('wait actually waited about as long as asked', Date.now() - started >= 350, String(Date.now() - started));
    ok('the job is genuinely still running', job.status === 'running');

    job.kill('test cleanup');
    await job.finished;
    ok('wait on an ended job returns immediately', await waitForTerminalJob(job, 60_000) === true);
}

{
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo listing-me', 'echo listing-me'),
        background: true,
    });
    await job.finished;
    const line = describeTerminalJob(job);
    ok('describe names the job id', line.startsWith(job.id), line);
    ok('describe marks it background', line.includes('background'), line);
    ok('describe reports the exit code', /exited with code 0/.test(line), line);
    ok('describe repeats the command', line.includes('$ echo listing-me'), line);
    job.kill('cleanup');
    await job.finished;
}

// Finished background jobs stay in the registry for their retention window by
// design, so the suite's own ending assertion is about LIVE processes leaking,
// not about the map being empty.
{
    const live = listTerminalJobs().filter((j) => j.status === 'running');
    for (const j of live) j.kill('test cleanup');
    await Promise.all(live.map((j) => j.finished));
    ok('no running job leaked after the suite',
        listTerminalJobs().every((j) => j.status !== 'running'),
        JSON.stringify(listTerminalJobs().filter((j) => j.status === 'running').map((j) => j.id)));
}

{
    // The USER releasing the turn must settle the tool call without touching
    // the process. This is the whole point of `released`: a tool call that
    // awaited `finished` would hold the turn until the idle cap killed the dev
    // server the user was trying to keep.
    const events = [];
    const unsubscribe = onJobEvent((e) => events.push(e));
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: holdsFor(2_500),
        idleKillMs: 400,
        hardCapMs: 400,
        callId: 'call-abc',
    });
    ok('a job records the tool call it belongs to', job.callId === 'call-abc', String(job.callId));
    ok('the job is findable from its tool call id', getJobByCallId('call-abc') === job);
    ok('an unknown call id resolves to undefined', getJobByCallId('call-nope') === undefined);
    ok('a foreground job does not announce itself as backgrounded',
        events.every((e) => e.kind !== 'started'));

    ok('a running foreground job can be released', job.moveToBackground(true) === true);
    ok('releasing twice reports honestly', job.moveToBackground(true) === false);
    ok('it is now a background job', job.background === true);
    ok('the transcript records that the USER did it', job.backgroundedByUser === true);
    ok('the released promise resolved as backgrounded', await job.released === 'backgrounded');

    await sleep(700);
    ok('releasing dropped the idle timer, so it is not killed',
        job.status === 'running', `${job.status}/${job.killReason}`);
    ok('a cancel no longer reaches it', killForegroundJobs('test') === 0, 'it was signalled');

    const started = events.filter((e) => e.kind === 'started');
    ok('exactly one started event fired', started.length === 1, String(started.length));
    ok('the started event names the job', started[0]?.jobId === job.id);
    ok('the started event names the tool call', started[0]?.callId === 'call-abc');
    ok('the started event records the user', started[0]?.byUser === true);

    await job.finished;
    ok('it ends on its own afterwards', job.status === 'exited' && job.exitCode === 0, `${job.status}/${job.exitCode}`);
    const settled = events.filter((e) => e.kind === 'settled');
    ok('exactly one settled event fired', settled.length === 1, String(settled.length));
    ok('the settled notice carries the job id', settled[0]?.notice.jobId === job.id);
    ok('the settled notice carries the exit code', settled[0]?.notice.exitCode === 0);
    ok('a settled job leaves the call index', getJobByCallId('call-abc') === undefined);
    unsubscribe();
}

{
    const events = [];
    const unsubscribe = onJobEvent(event => events.push(event));
    const script = join(holdDir,'streaming-background.js');
    writeFileSync(script,"console.log('server starting'); setTimeout(() => console.log('server ready'), 250); setTimeout(() => {}, 750);\n",'utf8');
    const job = spawnTerminalJob({workspaceRoot:process.cwd(),command:sh(`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,`node ${JSON.stringify(script)}`),background:true,callId:'live-background'});
    await job.finished;
    const updates = events.filter(event=>event.kind==='output' && event.jobId===job.id);
    ok('background output reaches the UI without a live agent loop', updates.some(event=>event.output.includes('server ready')),JSON.stringify(updates));
    ok('background output snapshots are bounded',updates.every(event=>event.output.length<=20000));
    ok('completion follows live output',events.at(-2)?.kind==='finished' && events.at(-1)?.kind==='settled');
    unsubscribe();
}

{
    // A job the model already read must not be announced again.
    const events = [];
    const unsubscribe = onJobEvent((e) => events.push(e));
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo consumed', 'echo consumed'),
        background: true,
    });
    await job.finished;
    ok('a background spawn announces itself', events.some((e) => e.kind === 'started' && e.byUser === false));
    ok('a fresh completion still notifies', events.some((e) => e.kind === 'settled'));

    markCompletionConsumed(job.id);
    const late = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo consumed2', 'echo consumed2'),
        background: true,
    });
    const before = events.filter((e) => e.kind === 'settled').length;
    markCompletionConsumed(late.id);
    await late.finished;
    ok('a consumed job still settles in the UI', events.some(e => e.kind === 'finished' && e.notice.jobId === late.id));
    ok('a consumed job is not announced again',
        events.filter((e) => e.kind === 'settled').length === before,
        String(events.filter((e) => e.kind === 'settled').length - before));
    unsubscribe();
}

{
    // A broken listener must not stop the others from being told, or one dead
    // webview silently swallows every future completion notice.
    const seen = [];
    const bad = onJobEvent(() => { throw new Error('listener exploded'); });
    const good = onJobEvent((e) => seen.push(e.kind));
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command: sh('echo resilient', 'echo resilient'),
        background: true,
    });
    await job.finished;
    ok('a throwing listener does not block the others', seen.includes('settled'), JSON.stringify(seen));
    bad();
    good();
}

{
    const notice = formatJobCompletion({
        jobId: 'job-x',
        command: 'npm run dev',
        status: 'exited',
        exitCode: 1,
        killReason: null,
        error: null,
        output: 'boom\n',
    });
    ok('the notice brackets itself so it is not read as the user',
        notice.startsWith('[background job job-x exited with code 1]'), JSON.stringify(notice.slice(0, 60)));
    ok('the notice repeats the command', notice.includes('npm run dev'));
    ok('the notice carries the tail', notice.includes('boom'));
    ok('the notice names the process tool and the job id',
        /action 'log', jobId 'job-x'/.test(notice), notice);
    ok('a success reads as success', /completed successfully/.test(formatJobCompletion({
        jobId: 'j', command: 'c', status: 'exited', exitCode: 0, killReason: null, error: null, output: '',
    })));
    ok('a stop says it was stopped', /was stopped \(the reason\)/.test(formatJobCompletion({
        jobId: 'j', command: 'c', status: 'killed', exitCode: null, killReason: 'the reason', error: null, output: '',
    })));
}

{
    // One handoff story for both paths: the model asking and the user pressing
    // the button must not be able to tell the agent different things.
    // Asserted against the command ACTUALLY used - hardcoding the POSIX one
    // fails the windows leg, where the shell is cmd.exe.
    const command = holdsFor(30_000);
    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        command,
        background: true,
    });
    const text = describeBackgroundHandoff(job);
    ok('the handoff names the job', text.includes(job.id), JSON.stringify(text.slice(0, 80)));
    ok('the handoff names the command', text.includes(command), JSON.stringify(text.slice(0, 160)));
    ok('the handoff says nothing will stop it', /nothing will stop it automatically/.test(text));
    ok('the handoff points at the process tool', /action 'poll'/.test(text) && /action 'kill'/.test(text));
    job.kill('test cleanup');
    await job.finished;
}

{
    // A tool child is almost never the process doing the work: `npm`/`npx` run
    // through a launcher, so the real server is a GRANDCHILD. Killing only the
    // direct child orphans it - still holding a port - and it would go on to
    // create the marker file below. This runs on BOTH legs: it used to be
    // POSIX-only, which is exactly the platform where the group kill makes it
    // easy to pass.
    //
    // Driven from a temp SCRIPT FILE, not `node -e`: inlining the source meant
    // nesting JSON quoting inside shell quoting inside JS quoting, and the
    // test failed on quoting rather than on tree killing.
    const dir = mkdtempSync(join(tmpdir(), 'xratu-tree-'));
    const marker = join(dir, 'grandchild-ran');
    const script = join(dir, 'parent.js');
    // The marker path travels as ARGV, not interpolated into the `-e` source:
    // embedding it inline nested double quotes inside a double-quoted argument
    // and made the generated script a syntax error, so the parent died before
    // printing anything and the test failed on its own quoting.
    writeFileSync(script, [
        "const { spawn } = require('child_process');",
        "const marker = process.argv[2];",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => require(\\'fs\\').writeFileSync(process.argv[1], \\'x\\'), 2000)', marker], { stdio: 'ignore', windowsHide: true });",
        'process.stdout.write(String(g.pid));',
    ].join('\n'), 'utf8');

    const job = spawnTerminalJob({
        workspaceRoot: process.cwd(),
        // Bare `node` on Windows: the absolute execPath lives under
        // "C:\\Program Files\\nodejs", and quoting that inside the cmd.exe
        // line left the command unrunnable, so the parent never printed its
        // grandchild pid.
        command: sh(
            `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(marker)}`,
            `node ${JSON.stringify(script)} ${JSON.stringify(marker)}`,
        ),
        idleKillMs: 600_000,
        hardCapMs: 600_000,
    });

    const end = Date.now() + 15_000;
    let grandchild = null;
    while (Date.now() < end && !grandchild) {
        const m = /\b\d{3,}\b/.exec(job.stdout);
        if (m) grandchild = Number(m[0]);
        else await sleep(50);
    }
    ok('the spawned tree reported a grandchild pid', !!grandchild,
        `status=${job.status} exit=${job.exitCode} stdout=${JSON.stringify(job.stdout)} stderr=${JSON.stringify(job.stderr)}`);
    // Guards the assertion below against being vacuous: if the grandchild were
    // already dead before the kill, "the marker never appeared" would prove
    // nothing about the tree kill at all.
    if (grandchild) {
        ok('the grandchild is alive before the kill', alivePid(grandchild), `pid ${grandchild}`);
    }

    killForegroundJobs('test tree kill');
    ok('the tree kill settles the job', await withDeadline(job) === 'finished');
    // Long enough for the grandchild's 2s timer to have fired had it survived.
    await sleep(3000);
    ok('the grandchild died with the parent - it never got to run',
        !existsSync(marker), `${marker} exists, so the tree kill missed the grandchild`);
    if (grandchild) {
        ok('the grandchild pid is gone too', await waitDead(grandchild), `pid ${grandchild}`);
    }
    // Retries, because this suite spawns process trees: on Windows a
    // just-killed tree can still hold the directory, and `force` does not
    // cover EBUSY.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// Monitoring must keep live processes visible even after many short jobs finish.
const monitorJob = (index, overrides = {}) => ({id:`monitor-${index}`,background:true,command:`cmd ${index}`,status:'exited',startedAt:index,finishedAt:index+1,exitCode:0,cwd:'C:\\project',pid:index,output:'z'.repeat(25_000),uptimeSeconds:()=>1,...overrides});
const monitor = backgroundJobViews(Array.from({length:50},(_,i)=>monitorJob(i)).concat(monitorJob(-1,{status:'running',exitCode:null}),monitorJob(51,{background:false})));
ok('monitor is bounded to 32 processes', monitor.length === 32);
ok('monitor prioritizes live jobs with their actual status', monitor[0].jobId === 'monitor--1' && monitor[0].running && monitor[0].exitCode === null);
ok('monitor retains the newest completion', monitor[1].jobId === 'monitor-49');
ok('monitor output is a bounded tail', monitor[0].output.length === 20_000);
ok('monitor preserves spawn errors', backgroundJobViews([monitorJob(1,{status:'failed',output:'',error:new Error('spawn failed')})])[0].output === 'spawn failed');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

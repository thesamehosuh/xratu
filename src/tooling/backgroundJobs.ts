/**
 * Terminal process ownership for the tool layer.
 *
 * `run_terminal_command` spawns a process, streams its output to the webview,
 * and waits for it to exit. Everything about that - the two timeout timers,
 * the tree kill, the bounded buffers, the "what does the model see when it
 * ends" formatting - lived inline in `mcp.ts`, which made it impossible to
 * reach the process again once the tool call returned: the only handle was a
 * closure in an unkeyed `Set`, so "is it still alive" and "kill job 3" were
 * both unanswerable.
 *
 * This module owns the process instead of the promise. A caller gets a
 * `TerminalJob` back synchronously, so the spawn path and the registry can
 * never drift apart, and the same object serves both modes:
 *
 *  - FOREGROUND (the default): the tool call awaits `finished` and the two
 *    kill timers apply. The job leaves the registry on exit - nothing can
 *    act on it afterwards.
 *  - BACKGROUND: the tool call returns immediately, the job STAYS in the
 *    registry so its output and exit code remain readable, and NO timer
 *    applies. A dev server, a file watcher or a database has no reason to
 *    die because it was quiet for ten minutes, and the user asked for it to
 *    keep running.
 *
 * Deliberately free of the `vscode` import so the pure parts are unit-testable
 * in plain node (see test/test-background-jobs.mjs) - the same precedent as
 * `processTree.ts` / `shellPlatform.ts`.
 */

import * as cp from 'child_process';
import { killPids, killTree, snapshotTree } from './processTree';
import { captureIdentity, isOurProcess, type ProcessIdentity } from './processIdentity';
import { terminalSpawn, terminalFailureHint, appendHintToResult } from './shellPlatform';

/**
 * In-memory ceiling for a single stream. Chatty output (`yes`, a huge log)
 * reaches GBs inside the timeout window, and the clip at finish time runs long
 * after the extension host has already OOM'd - so the cap is CONTINUOUS, not
 * applied to the finished string.
 */
export const MAX_STREAM_CHARS = 200_000;

/** Result text ceiling handed to the model, marker included. */
export const MAX_RESULT_CHARS = 200_000;

/** Idle window: a quiet-but-working process (a release build, a slow test)
 *  must not die, so only the hard cap is absolute. Any output resets it. */
export const IDLE_KILL_MS = 600_000;

/** Absolute ceiling on one foreground command. */
export const HARD_CAP_MS = 1_800_000;

/**
 * How many background jobs may exist at once. Each one holds an open process
 * and a 200KB buffer, and a model that keeps starting dev servers without
 * stopping the old one is a real failure mode, so the cap refuses rather than
 * silently growing.
 */
export const MAX_BACKGROUND_JOBS = 16;

/**
 * How long a FINISHED background job stays readable. Long enough to notice an
 * exit and read its output; short enough that a session's leftovers do not
 * accumulate. Matches the retention other agents use for finished work.
 */
export const FINISHED_RETENTION_MS = 30 * 60_000;

/** Longest a `wait` may block. Bounded so one tool call cannot pin the turn. */
export const MAX_WAIT_MS = 300_000;

/** Default `wait` window: long enough to catch a build that is nearly done. */
export const DEFAULT_WAIT_MS = 5_000;

export type TerminalJobStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface TerminalJob {
    /** Stable handle, unique for the lifetime of the host. */
    id: string;
    command: string;
    cwd: string;
    pid: number | undefined;
    startedAt: number;
    /** Set once the process ended; undefined while running. */
    finishedAt?: number;
    /**
     * True when the tool call released the turn while the process kept
     * running. A background job is never killed by the host - not by a user
     * cancel, not by extension deactivation - because it owns things (a dev
     * server's port, a watcher's file handles) the user expects to survive.
     */
    background: boolean;
    /** True when the USER released the turn rather than the model passing
     *  background=true. The transcript records who made the call. */
    readonly backgroundedByUser: boolean;
    /** True for a process adopted from the startup checkpoint after a window
     *  reload. There is no pipe behind it, so its output is permanently empty
     *  and every read must say so rather than look broken. */
    readonly detached?: boolean;
    status: TerminalJobStatus;
    /** Set when the process exited on its own; null while running or killed. */
    exitCode: number | null;
    /** Why the job was killed, when it was. */
    killReason: string | null;
    /** Set when the process could not be spawned at all. */
    error: Error | null;
    /** stdout tail, bounded by MAX_STREAM_CHARS. */
    readonly stdout: string;
    /** stderr tail, bounded by MAX_STREAM_CHARS. */
    readonly stderr: string;
    /** stdout and stderr interleaved as it arrived - the live view. */
    readonly output: string;
    /** Whole seconds since the job started, for `list`. */
    uptimeSeconds(): number;
    /** Server-side tool_call_id this job belongs to, when it was started by a
     *  tool call. The user's "run in background" button has no other way to
     *  name the running command it is attached to. */
    readonly callId?: string;
    /** Pid + kernel start token captured at spawn. Needed to write a
     *  checkpoint that is safe to act on after a restart. */
    readonly identity?: ProcessIdentity;
    /** Request a tree kill. Idempotent; never throws. */
    kill(why: string): void;
    /** Resolves when the process exits, is killed, or fails to start. */
    readonly finished: Promise<void>;
    /**
     * Resolves when the owning tool call may RETURN: either the process ended,
     * or it was handed to the background. A tool call must never block on
     * `finished` alone - that is exactly what makes a dev server hang the turn
     * until the idle cap kills it.
     */
    readonly released: Promise<'exited' | 'backgrounded'>;
    /**
     * Release the owning tool call while the process keeps running, and drop
     * the foreground kill timers - a backgrounded process must not die of an
     * idle window, because the user asked for it to keep running.
     *
     * Returns false when the job is no longer running (or was already
     * backgrounded), so a late button press reports honestly instead of
     * pretending to have done something.
     */
    moveToBackground(byUser?: boolean): boolean;
}

/**
 * The durable record of a background job - what a checkpoint file holds.
 *
 * Output is deliberately absent: it is up to 200KB per job, and by the time a
 * restart happens the transcript the output belonged to is gone anyway. What
 * MUST survive is the process identity, because that is the only thing that
 * lets the next host window stop what this one started.
 */
export interface BackgroundJobRecord {
    id: string;
    command: string;
    cwd: string;
    identity: ProcessIdentity;
    startedAt: number;
    /** Whole seconds it had been running when the record was written. */
    uptimeSeconds: number;
    backgroundedByUser: boolean;
    status: TerminalJobStatus;
    exitCode: number | null;
}

export interface SpawnTerminalJobOptions {
    workspaceRoot: string;
    command: string;
    /** Called per raw chunk so the webview can render live output. */
    onOutput?: (chunk: string) => void;
    /** Release the turn immediately; no kill timers apply. */
    background?: boolean;
    /** Overridable for tests; defaults to IDLE_KILL_MS / HARD_CAP_MS. */
    idleKillMs?: number;
    hardCapMs?: number;
    /** Overridable for tests; defaults to a monotonic host-local id. */
    id?: string;
    /** The tool_call_id this command belongs to. Lets the user's "run in
     *  background" button find the running job from the row it is attached to. */
    callId?: string;
}

/** Bound `text` to `limit` chars, keeping the TAIL. Live terminal output is
 *  tail-biased because the diagnosis (a stack trace, the `STDERR:` block)
 *  lands at the end. */
export function clipTail(text: string, limit = MAX_STREAM_CHARS): string {
    return text.length > limit ? text.slice(-limit) : text;
}

let jobCounter = 0;

/**
 * Ids are host-local and only need to be unique within one session; the model
 * addresses jobs by them inside one conversation.
 */
function nextJobId(): string {
    jobCounter += 1;
    return `job-${jobCounter}`;
}

/**
 * Ids are NOT unique across host windows: the counter restarts at 1 on every
 * activate, and adoption reuses the previous window's ids verbatim. Without
 * this, the first job started after a reload would be handed `job-1` - the id
 * of a RECOVERED job - and `jobs.set` would silently overwrite it, leaving a
 * live dev server with no handle and a `kill` aimed at the wrong process.
 */
function reserveJobId(id: string): void {
    const n = /^job-(\d+)$/.exec(id)?.[1];
    if (n) jobCounter = Math.max(jobCounter, Number(n));
}

/**
 * Jobs that can still be acted on: every running job, plus finished
 * BACKGROUND jobs inside their retention window. A finished foreground job is
 * dropped immediately - once its tool call returned there is nothing left to
 * poll, read or kill.
 */
const jobs = new Map<string, TerminalJob>();

/** tool_call_id -> job, for the user's background button. A finished job is
 *  removed from here by `finish`, so a stale button press cannot resurrect it. */
const callIndex = new Map<string, TerminalJob>();

/** Drop finished background jobs past their retention window, oldest first. */
function pruneFinished(): void {
    const cutoff = Date.now() - FINISHED_RETENTION_MS;
    for (const [id, job] of [...jobs]) {
        if (job.status !== 'running' && (job.finishedAt ?? 0) < cutoff) jobs.delete(id);
    }
}

/**
 * Refuse a background spawn when too many are RUNNING.
 *
 * The cap counts live processes only. A finished job holds nothing but a
 * buffer, so it never blocks a new command (dropping its output to make room
 * would be a pointless loss) and never occupies a slot - `pruneFinished` is
 * what bounds those, by age.
 *
 * Evicting the oldest RUNNING job instead would silently kill a dev server the
 * model is still using, so the refusal names what is holding the cap.
 *
 * Checked BEFORE the spawn: the extra process would otherwise already be
 * running with nothing pointing at it. Foreground commands are exempt - one
 * holds its slot for the length of a single tool call.
 */
function reserveBackgroundSlot(jobId: string): void {
    pruneFinished();
    if (jobs.has(jobId)) return;
    const running = [...jobs.values()].filter((j) => j.status === 'running');
    if (running.length < MAX_BACKGROUND_JOBS) return;
    const oldest = running.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    throw new Error(
        `too many background jobs running (${running.length}/${MAX_BACKGROUND_JOBS}) - wait for or kill one first`
        + `; the oldest is ${oldest.id}, running ${oldest.uptimeSeconds()}s`
        + '. Use `process` with action "list" to see them.',
    );
}

/**
 * How often a recovered job re-checks whether its process is still alive.
 *
 * Polling the OS is not free - on Windows it is a PowerShell round trip - so
 * the check is throttled and driven by reads rather than run on its own timer.
 * Nothing in the extension needs to know about a recovered job that nobody is
 * looking at, which is exactly when not to spend the call.
 */
const ADOPTED_REVALIDATE_MS = 10_000;

/**
 * Register a process this host did NOT spawn - one adopted from the startup
 * checkpoint after a window reload.
 *
 * There is no pipe and no ChildProcess, so output is unavailable and the job
 * says so: it can be listed and stopped, and that is all. Pretending otherwise
 * would have the model poll a job that can only ever answer "no output".
 *
 * Adoption only happens after `isOurProcess` proved the recorded pid is still
 * the SAME incarnation, so a recycled number can never end up here.
 *
 * Liveness is re-derived rather than assumed. A recovered entry that reported
 * `running` forever would put a dead process in the composer badge
 * permanently, and `pruneFinished` could never reclaim it - the badge is the
 * only thing that ever looks at these.
 */
export function adoptDetachedJob(spec: BackgroundJobRecord): TerminalJob {
    reserveJobId(spec.id);
    const { identity } = spec;
    let killReason: string | null = null;
    let finishedAt: number | undefined;
    let lastChecked = 0;
    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });

    /** Re-derive liveness from the OS, at most every ADOPTED_REVALIDATE_MS. */
    const revalidate = (): void => {
        if (finishedAt !== undefined) return;
        const now = Date.now();
        if (now - lastChecked < ADOPTED_REVALIDATE_MS) return;
        lastChecked = now;
        if (isOurProcess(identity)) return;
        // The process is gone (or was never ours after all). Latch the time so
        // `uptimeSeconds` freezes and `pruneFinished` can eventually drop it.
        finishedAt = now;
        resolveFinished?.();
    };

    const entry: TerminalJob = {
        id: spec.id,
        command: spec.command,
        cwd: spec.cwd,
        pid: identity.pid,
        startedAt: spec.startedAt,
        background: true,
        backgroundedByUser: spec.backgroundedByUser,
        detached: true,
        identity,
        get finishedAt() { revalidate(); return finishedAt; },
        get status() { revalidate(); return killReason ? 'killed' : finishedAt === undefined ? 'running' : 'exited'; },
        get exitCode() { return null; },
        get killReason() { return killReason; },
        get error() { return null; },
        get stdout() { return ''; },
        get stderr() { return ''; },
        get output() { return ''; },
        uptimeSeconds: () => Math.round(((finishedAt ?? Date.now()) - spec.startedAt) / 1000),
        kill(why: string) {
            if (killReason || finishedAt !== undefined) return;
            killReason = why;
            finishedAt = Date.now();
            onJobsChanged?.();
            // Snapshot the tree BEFORE the parent dies: once it exits its
            // children are reparented and the parent/child link is gone, which
            // is exactly what `taskkill /T` and the `ps` walk both depend on.
            const tree = snapshotTree(identity.pid);
            const done = killTree(identity.pid).then(() => killPids(tree));
            // Settle on the kill, but never hang a tool call on it: a wedged
            // `taskkill` must not pin the turn until the job timeout.
            const fallback = setTimeout(() => resolveFinished?.(), 5000);
            void done.finally(() => clearTimeout(fallback));
            void done.then(() => resolveFinished?.());
        },
        moveToBackground: () => false,
        finished,
        // Answers immediately: there is no owning tool call left for a job this
        // host did not start, so nothing is waiting on a handoff.
        released: Promise.resolve('exited'),
    };
    jobs.set(spec.id, entry);
    return entry;
}

/** Live jobs first, then finished ones inside retention. Oldest first. */
export function listTerminalJobs(): TerminalJob[] {
    pruneFinished();
    return [...jobs.values()];
}

export function getTerminalJob(id: string | undefined): TerminalJob | undefined {
    if (!id) return undefined;
    pruneFinished();
    return jobs.get(id);
}

/** The live job a tool call started, if any. Backs the user's "run in
 *  background" action on a running command row. */
export function getJobByCallId(callId: string | undefined): TerminalJob | undefined {
    if (!callId) return undefined;
    return callIndex.get(callId);
}

/**
 * Spawn a shell command and take ownership of it.
 *
 * stdin is a pipe closed IMMEDIATELY: readers of stdin (bare `tail`, `cat`)
 * get EOF and exit instead of blocking forever on an ignored fd, and the tool
 * description tells the model the command must not wait for input.
 *
 * `detached` on POSIX puts the child in its own process group so a group kill
 * reaches the grandchildren a launcher (`npm`, `npx`) spawned. Windows has no
 * process groups and gets `taskkill /T`, which walks the live tree.
 */
export function spawnTerminalJob(options: SpawnTerminalJobOptions): TerminalJob {
    const {
        workspaceRoot,
        command,
        onOutput,
        background: startBackground = false,
        idleKillMs = IDLE_KILL_MS,
        hardCapMs = HARD_CAP_MS,
        id = nextJobId(),
        callId,
    } = options;

    const isWindows = process.platform === 'win32';
    if (startBackground) reserveBackgroundSlot(id);
    // The quoting decision lives in terminalSpawn: without
    // windowsVerbatimArguments Node MSVCRT-escapes the command and cmd.exe
    // tears it apart at the inner quotes.
    const { file, args, windowsVerbatimArguments } = terminalSpawn(process.platform, command);

    let stdout = '';
    let stderr = '';
    /** Append-only transcript, for the live view. */
    let merged = '';
    let killReason: string | null = null;
    let status: TerminalJobStatus = 'running';
    let exitCode: number | null = null;
    let error: Error | null = null;
    let startedAt = Date.now();
    let finishedAt: number | undefined;
    let settled = false;
    // Mutable: a foreground job flips to background when the user releases the
    // turn, and every timer decision below has to see the NEW value or a
    // dev server gets killed by an idle window nobody is waiting on any more.
    let isBackground = startBackground;
    let backgroundedByUser = false;

    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
    let resolveReleased: ((how: 'exited' | 'backgrounded') => void) | undefined;
    const released = new Promise<'exited' | 'backgrounded'>((resolve) => { resolveReleased = resolve; });

    const child = cp.spawn(file, args, {
        cwd: workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows,
        windowsHide: true,
        windowsVerbatimArguments,
    });
    child.stdin.end();
    // Captured ONLY for a job that is background from the start, and then
    // immediately - `processStartToken` shells out (PowerShell on Windows), and
    // paying that on every foreground command froze the extension host for up
    // to the call's own timeout. `moveToBackground` captures lazily instead;
    // it can only succeed while the job is still running, so the pid is
    // certainly ours at that moment too.
    let identity: ProcessIdentity | undefined = startBackground
        ? captureIdentity(child.pid) ?? undefined
        : undefined;

    const job: TerminalJob = {
        id,
        command,
        cwd: workspaceRoot,
        pid: child.pid,
        startedAt,
        callId,
        identity,
        get background() { return isBackground; },
        /** True when the USER released the turn rather than the model asking. */
        get backgroundedByUser() { return backgroundedByUser; },
        get finishedAt() { return finishedAt; },
        get status() { return status; },
        get exitCode() { return exitCode; },
        get killReason() { return killReason; },
        get error() { return error; },
        get stdout() { return stdout; },
        get stderr() { return stderr; },
        get output() { return merged; },
        uptimeSeconds: () => Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000),
        kill,
        moveToBackground,
        finished,
        released,
    };
    jobs.set(id, job);
    // The webview's "run in background" button knows only the tool_call_id of
    // the row it is rendered on, so that is the other way in.
    if (callId) callIndex.set(callId, job);
    if (startBackground) {
        emit({ kind: 'started', jobId: id, command, callId, byUser: false });
        onJobsChanged?.();
    }

    // A background job has no deadline: the user asked for something that
    // keeps running, so the foreground idle/hard timers must not apply.
    let killFallback: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    if (!startBackground) {
        hardTimer = setTimeout(() => kill('the 30-minute hard cap'), hardCapMs);
    }

    /**
     * Release the owning tool call and keep the process alive.
     *
     * The kill timers MUST go: they exist to stop a foreground command from
     * holding the turn forever, and once the turn is released nobody is
     * waiting - leaving them armed means a quiet dev server is killed ten
     * minutes after the user explicitly asked it to keep running.
     */
    function moveToBackground(byUser = false): boolean {
        if (settled || isBackground) return false;
        isBackground = true;
        backgroundedByUser = byUser;
        // Last chance to prove the identity: the process is still alive here,
        // and this is the moment the checkpoint starts caring about it.
        identity ??= captureIdentity(child.pid) ?? undefined;
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        resolveReleased?.('backgrounded');
        emit({ kind: 'started', jobId: id, command, callId, byUser });
        onJobsChanged?.();
        return true;
    }

    function kill(why: string): void {
        if (killReason || settled) return;
        killReason = why;
        try {
            // cmd.exe (/c) and bash (-c) spawn grandchildren; killing only the
            // direct child would leave them running (servers started by the
            // command keep holding ports/files).
            if (isWindows) void killTree(child.pid);
            else if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* gone */ }
        // 'close' normally fires once the killed process group's stdio streams
        // end - but if it never does (a durable grandchild still holds the
        // write end), the job must still settle. The latch makes a late
        // 'close' a no-op.
        killFallback = setTimeout(() => finish(null), 5000);
    }

    function finish(code: number | null): void {
        if (settled) return;
        settled = true;
        // The job is retained when it is background (or was backgrounded
        // mid-flight), so its output stays readable after it ends.
        const retained = isBackground;
        status = killReason ? 'killed' : error ? 'failed' : 'exited';
        exitCode = code;
        finishedAt = Date.now();
        clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        clearTimeout(killFallback);
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        // A background job stays readable after it ends, so the model can poll
        // it once more and read the final output. A foreground job has nothing
        // left to do and is dropped at once.
        if (!retained && jobs.get(id) === job) jobs.delete(id);
        if (callId && callIndex.get(callId) === job) callIndex.delete(callId);
        resolveFinished?.();
        resolveReleased?.('exited');
        // Emitted after the latch and the registry update so a listener that
        // immediately calls `list` sees a consistent world.
        if (retained) {
            onJobsChanged?.();
            emitCompletion({
                jobId: id,
                command,
                status,
                exitCode,
                killReason,
                error,
                output: merged,
            });
        }
    }

    const resetIdle = () => {
        if (isBackground) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
            () => kill(`no output for ${Math.round(idleKillMs / 60_000)} minutes`),
            idleKillMs
        );
    };

    const collect = (target: 'stdout' | 'stderr', chunk: string) => {
        if (target === 'stdout') stdout = clipTail(stdout + chunk);
        else stderr = clipTail(stderr + chunk);
        merged = clipTail(merged + chunk);
        // Stream to the UI as it arrives (the model still gets the capped
        // result at exit; this is for the human watching).
        onOutput?.(chunk);
        resetIdle();
    };

    resetIdle();
    child.stdout.on('data', (d: Buffer) => collect('stdout', d.toString()));
    child.stderr.on('data', (d: Buffer) => collect('stderr', d.toString()));
    child.on('error', (e) => { error = e; finish(null); });
    child.on('close', (code) => finish(code));

    return job;
}

/**
 * The text the model sees when the job ends.
 *
 * A command that SUCCEEDED can still write to stderr - git's "Switched to
 * branch ...", curl progress, npm notices. Printing that under a bare
 * "STDERR:" heading reads as a failure to the user AND to the model, so a
 * successful run gets one neutral OUTPUT block; only a FAILED run is split
 * into the two.
 */
export function formatTerminalResult(job: TerminalJob, platform: NodeJS.Platform): string {
    const failed = job.status !== 'exited' || job.exitCode !== 0;
    let result = failed
        ? `STDOUT:\n${job.stdout || '(empty)'}\nSTDERR:\n${job.stderr || '(empty)'}`
        : `OUTPUT:\n${[job.stdout, job.stderr].filter((part) => part.length > 0).join('\n') || '(no output)'}`;
    if (job.killReason) {
        result += `\nError: killed (${job.killReason}). If this was a long quiet build, redirect output to a file and poll it in chunks; the hard cap is 30 minutes.`;
    } else if (job.error) {
        result += `\nError: ${job.error.message}`;
    } else if (job.exitCode !== 0) {
        result += `\nExit code: ${job.exitCode}`;
    }
    // Dialect correction ON the failure. "is not recognized as an internal or
    // external command" does not tell the model which of its habits to drop;
    // naming the replacement (built-in tool or cmd.exe equivalent) ends it in
    // one round instead of five.
    const hint = failed && !job.killReason && !job.error
        ? terminalFailureHint(platform, job.stderr)
        : null;
    return appendHintToResult(result, hint, MAX_RESULT_CHARS);
}

/** Wait for a job to end, then hand back its result text. */
export async function awaitTerminalJob(
    job: TerminalJob,
    platform: NodeJS.Platform,
): Promise<{ text: string; isError: boolean }> {
    await job.finished;
    return {
        text: formatTerminalResult(job, platform),
        isError: job.status !== 'exited' || job.exitCode !== 0,
    };
}

/**
 * Kill every job still holding a tool call. This is the composer's stop
 * button, so it is also the only place that knows a cancel must NOT touch a
 * process the user deliberately backgrounded.
 *
 * Returns how many were signalled.
 */
export function killForegroundJobs(why = 'cancelled by the user'): number {
    let killed = 0;
    for (const job of [...jobs.values()]) {
        if (job.background || job.status !== 'running') continue;
        try {
            job.kill(why);
            killed += 1;
        } catch { /* already gone */ }
    }
    return killed;
}

// ------------------------------------------------------------ `process` tool

/**
 * How much of a job's output one `log`/`poll` answer may carry. The model is
 * reading this to decide what to do next, so it gets a window, not a dump;
 * `offset` pages through anything longer.
 */
export const MAX_READBACK_CHARS = 20_000;

/** Lines returned by `log` when the caller does not say. */
export const DEFAULT_LOG_LINES = 200;

/** One-line status for `list`/`poll`. */
export function describeTerminalJob(job: TerminalJob): string {
    const state = job.status === 'running'
        ? `running ${job.uptimeSeconds()}s (pid ${job.pid ?? '?'})`
        : job.status === 'killed'
            ? `killed - ${job.killReason}`
            : job.status === 'failed'
                ? `failed to start - ${job.error?.message ?? 'unknown error'}`
                : `exited with code ${job.exitCode}`;
    const origin = job.detached ? 'background, recovered' : job.background ? 'background' : 'foreground';
    return `${job.id}  ${origin}  ${state}\n  $ ${job.command}`;
}

/**
 * A window of a job's output.
 *
 * With no `offset` the window is the NEWEST `limit` lines: the question a model
 * asks a running server is "what did it just print", and a 50k-line log's
 * opening lines answer nothing. Passing `offset` pages from the start instead.
 *
 * Offsets count LINES so `offset`/`limit` are meaningful to a model reading a
 * log; a character offset would be impossible to compute without the whole
 * transcript. The line list is sliced first and the character cap applied
 * after, so the cap can only ever shorten the answer, never overflow it.
 */
export function readJobOutput(
    job: TerminalJob,
    options: { offset?: number; limit?: number; maxChars?: number } = {},
): string {
    const { limit = DEFAULT_LOG_LINES, maxChars = MAX_READBACK_CHARS } = options;
    const { offset } = options;
    // An adopted job has no pipe behind it any more. "(no output)" would read
    // as "it printed nothing", which is a different and wrong claim.
    if (job.detached) {
        return `${job.id}: no output is available - this process survived an extension reload and its output stream is gone. Its status and exit are still knowable.`;
    }
    // Drop the trailing empty element a final newline produces: paging is
    // line-based, and counting a phantom line makes `of N` disagree with what
    // the model sees when it asks for offset 0.
    const lines = job.output.replace(/\n$/, '').split('\n');
    const window = Math.max(1, limit);
    const start = offset === undefined
        ? Math.max(0, lines.length - window)
        : Math.max(0, Math.min(offset, lines.length));
    const end = Math.min(lines.length, start + window);
    const slice = lines.slice(start, end);
    let text = slice.join('\n');
    if (text.length > maxChars) text = `${text.slice(-maxChars)}\n… (earlier output dropped; pass offset to page back)`;
    const more = lines.length - end;
    const header = `${job.id}: showing lines ${start + 1}-${end} of ${lines.length}`;
    return `${header}${more > 0 ? `, ${more} more` : ''}\n${text || '(no output)'}`;
}

/**
 * Block until the job ends or `timeoutMs` elapses. Resolves `false` on
 * timeout so the caller can report "still running" instead of pretending the
 * command finished - the single most expensive lie this tool could tell.
 */
export async function waitForTerminalJob(job: TerminalJob, timeoutMs: number): Promise<boolean> {
    if (job.status !== 'running') return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    try {
        return await Promise.race([job.finished.then(() => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * What the model is told when a command is released into the background.
 *
 * Shared by both paths that can background a command - the model passing
 * `background: true` and the user pressing the button - because they must not
 * be able to drift: a model that gets a different story depending on which
 * one happened will start guessing instead of polling.
 */
export function describeBackgroundHandoff(job: TerminalJob): string {
    const soFar = job.output.trim();
    return [
        `Running in the background as ${job.id}${job.pid ? ` (pid ${job.pid})` : ''}.`,
        `Command: ${job.command}`,
        soFar ? `Output so far:\n${soFar}` : 'No output so far.',
        `It keeps running and nothing will stop it automatically - not a timeout, not a cancel, not the end of this turn. Use \`process\` with action 'poll' or 'log' to read it, and action 'kill' when you are done with it.`,
    ].join('\n');
}

// ------------------------------------------------- completion notifications

/**
 * A background job reaching a terminal state.
 *
 * Emitted exactly once per job - a job cannot settle twice - so the delivery
 * path needs no rate limiter: there is no way for a chatty process to produce a
 * second notice, which is the failure mode that forces per-process cooldowns in
 * pattern-watching designs.
 */
export interface JobCompletionNotice {
    jobId: string;
    command: string;
    status: TerminalJobStatus;
    exitCode: number | null;
    killReason: string | null;
    error: Error | null;
    /** Output tail as of the moment it ended. */
    output: string;
}

/**
 * A change in a background job's lifecycle the host cares about. ONE channel
 * for both directions on purpose: two parallel subscriptions would let the
 * "started" and "settled" paths drift, and the drift is invisible - the badge
 * would just quietly show a stale count.
 */
export type JobEvent =
    | {
        kind: 'started';
        jobId: string;
        command: string;
        /** Present when a tool call started it - the row this belongs to. */
        callId?: string;
        /** True when the USER released the turn rather than the model asking. */
        byUser: boolean;
    }
    | { kind: 'settled'; notice: JobCompletionNotice };

type JobEventListener = (event: JobEvent) => void;
const jobListeners = new Set<JobEventListener>();

/**
 * Called whenever the set of adoptable (running background) jobs changes, so
 * the host can checkpoint them. Installed once at activate; the module has no
 * business knowing where storage lives.
 */
let onJobsChanged: (() => void) | undefined;

export function setJobChangeListener(listener: (() => void) | undefined): void {
    onJobsChanged = listener;
}

/** The records worth checkpointing: running background jobs only. A finished
 *  or foreground job has no process to lose track of, and an adopted one has
 *  no identity to re-verify with. */
export function adoptableJobRecords(): BackgroundJobRecord[] {
    // Detached (recovered) entries are INCLUDED on purpose: they are live
    // processes with a recorded identity, and dropping them here would let the
    // next save overwrite the checkpoint without them - leaving a running dev
    // server that no window can ever find or stop, which is the exact failure
    // this file exists to prevent.
    return [...jobs.values()]
        .filter((j) => j.background && j.status === 'running' && j.identity)
        .map((j) => ({
            id: j.id,
            command: j.command,
            cwd: j.cwd,
            identity: j.identity as ProcessIdentity,
            startedAt: j.startedAt,
            uptimeSeconds: j.uptimeSeconds(),
            backgroundedByUser: j.backgroundedByUser,
            status: j.status,
            exitCode: j.exitCode,
        }));
}

/**
 * Subscribe to background job lifecycle events. Returns an unsubscribe
 * function so `deactivate` can drop the listener instead of leaking a closure
 * that posts into a disposed webview.
 */
export function onJobEvent(listener: JobEventListener): () => void {
    jobListeners.add(listener);
    return () => { jobListeners.delete(listener); };
}

function emit(event: JobEvent): void {
    for (const listener of [...jobListeners]) {
        // One broken listener must not stop the others from being told.
        try { listener(event); } catch { /* a dead webview is not the listener's problem to solve */ }
    }
}

/**
 * Jobs whose completion the model has ALREADY been handed the output of.
 *
 * `log` (and a `wait` that actually returned, and `kill`) put the finished
 * report in front of the model in the same turn, so a later notice would only
 * repeat it. `poll` deliberately does NOT count: a status check is not
 * consumption, and treating it as one silently swallows the notification the
 * model is relying on.
 */
const completionConsumed = new Set<string>();

/** Mark a job's completion as already delivered to the model. */
export function markCompletionConsumed(jobId: string): void {
    completionConsumed.add(jobId);
}

/**
 * The model-facing report for a finished job. Bracketed like a system notice so
 * it cannot be mistaken for the user speaking, and it names the job id in the
 * same breath as the `process` call that reads more of it.
 */
export function formatJobCompletion(notice: JobCompletionNotice): string {
    const outcome = notice.status === 'killed'
        ? `was stopped (${notice.killReason})`
        : notice.status === 'failed'
            ? `could not start: ${notice.error?.message ?? 'unknown error'}`
            : notice.status === 'exited' && notice.exitCode === 0
                ? 'completed successfully'
                : `exited with code ${notice.exitCode}`;
    const tail = notice.output.trim();
    return [
        `[background job ${notice.jobId} ${outcome}]`,
        `Command: ${notice.command}`,
        ...(tail ? [`Output:\n${tail}`] : []),
        `Read the rest with the \`process\` tool (action 'log', jobId '${notice.jobId}'), and 'kill' it if it should not keep running.`,
    ].join('\n');
}

function emitCompletion(notice: JobCompletionNotice): void {
    if (completionConsumed.has(notice.jobId)) return;
    emit({ kind: 'settled', notice });
}
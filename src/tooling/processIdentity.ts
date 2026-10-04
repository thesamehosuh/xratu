/**
 * Process IDENTITY, not just process id.
 *
 * A pid alone is not an identity: the OS recycles pid numbers once a process
 * exits and is reaped, so a pid written to disk now can name a completely
 * unrelated process after a reboot. Acting on it - and `killTree` is a TREE
 * kill - would take down whatever the user happens to be running. This is not
 * hypothetical: it has been observed in the wild as a recycled number landing
 * on a desktop session leader, whose whole tree then got terminated.
 *
 * So a persisted job records the pid AND a token derived from the kernel's own
 * start time for that process. The pair only matches if BOTH the number and the
 * incarnation agree, which is what makes "is this still my job?" answerable
 * across a restart.
 *
 * Kept free of the `vscode` import so it is unit-testable in plain node.
 */

import * as cp from 'child_process';
import * as fs from 'fs';

/** Recorded identity of a process we spawned. */
export interface ProcessIdentity {
    pid: number;
    /** Opaque, platform-specific incarnation token. Never compare pids alone. */
    token: string;
}

let bootIdCache: string | null = null;
let posixBootCache: string | null = null;

/**
 * macOS/BSD boot time. The POSIX token is only second-resolution, so without
 * this a record old enough to span a reboot could match an unrelated process
 * that happens to share a wall-clock second - the recycled-number hazard this
 * module exists to prevent.
 */
function posixBootId(): string {
    if (posixBootCache !== null) return posixBootCache;
    posixBootCache = 'unknown-boot';
    if (process.platform === 'darwin') {
        try {
            const out = cp.execFileSync('sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf-8',
                timeout: 2000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const secs = /sec\s*=\s*(\d+)/.exec(out)?.[1];
            if (secs) posixBootCache = secs;
        } catch { /* keep the placeholder */ }
    }
    return posixBootCache;
}

/**
 * Linux boot id, so tokens cannot collide across reboots. Read once and
 * cached: it cannot change while the host runs, and `/proc` may be absent on
 * non-Linux hosts.
 */
function bootId(): string {
    if (bootIdCache !== null) return bootIdCache;
    bootIdCache = 'unknown-boot';
    if (process.platform === 'linux') {
        try {
            const out = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
            if (out) bootIdCache = out;
        } catch { /* keep the placeholder */ }
    }
    return bootIdCache;
}

/**
 * Field 22 of `/proc/<pid>/stat` is `starttime` - clock ticks since boot at
 * which the process started. Parsed by hand because the second field is the
 * comm string in parentheses and may itself contain spaces or parentheses,
 * so a naive split on whitespace is wrong for a process named `my prog) x`.
 */
function linuxStartTime(pid: number): string | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const close = stat.lastIndexOf(')');
        if (close < 0) return null;
        const fields = stat.slice(close + 2).trim().split(/\s+/);
        // After comm, field 3 is state; starttime is field 22 overall, which is
        // index 19 in this post-comm remainder (fields 3..22 => 0..19).
        const starttime = fields[19];
        return starttime && /^\d+$/.test(starttime) ? starttime : null;
    } catch {
        return null;
    }
}

/**
 * The identity token for a pid, or null when the platform cannot supply one.
 *
 * Returning null is honest and load-bearing: callers must treat "no token" as
 * "cannot prove identity", never as "matches".
 */
export function processStartToken(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'linux') {
        const starttime = linuxStartTime(pid);
        return starttime ? `linux:${bootId()}:${starttime}` : null;
    }
    if (process.platform === 'win32') {
        try {
            const out = cp.execFileSync(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                    // ToUniversalTime, not the local DateTime: the capture and
                    // the post-restart verification can straddle a DST change,
                    // and a shifted offset would serialize to a different
                    // string - so a perfectly healthy job would look recycled.
                    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`],
                // Bounded hard, and stdin ignored: this runs on a path that can
                // block the extension host, so it must never inherit a stdin
                // pipe or wait on an interactive prompt.
                { encoding: 'utf-8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
            ).trim();
            return out ? `win32:${out}` : null;
        } catch {
            return null;
        }
    }
    // macOS and friends: `ps -o lstart=` is second-resolution, which is coarser
    // than Linux's tick resolution but still distinguishes incarnations for any
    // realistic restart gap.
    try {
        const out = cp.execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf-8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return out ? `posix:${posixBootId()}:${out}` : null;
    } catch {
        return null;
    }
}

/**
 * Capture the identity of a pid right after spawning it.
 *
 * Synchronous, and only correct on hosts where reading the start time is
 * cheap: Linux reads `/proc`, macOS shells out to `ps` for a few hundred
 * milliseconds at worst. On Windows the equivalent needs PowerShell, and the
 * synchronous form froze the extension host for the call's whole 2s timeout on
 * every background spawn - which is the exact thing this repo forbids (see the
 * notes on `spawnSync` in mcp.ts and the async rule in shadowGit.ts). Windows
 * therefore uses `captureIdentityAsync`.
 */
export function captureIdentity(pid: number | undefined): ProcessIdentity | null {
    if (!pid || pid <= 0) return null;
    if (process.platform === 'win32') return null;
    const token = processStartToken(pid);
    // No token is still recorded, with an explicit marker: refusing to persist
    // the job would lose it, and pretending the pid alone is an identity is the
    // bug this module exists to prevent. `isOurProcess` then refuses to act.
    return { pid, token: token ?? 'unverified' };
}

/**
 * Asynchronous identity capture, for the one host that needs a subprocess.
 *
 * Returns immediately with an unverified placeholder - enough for the job to
 * exist and be listed - and calls `apply` with the real identity once the
 * answer lands. Until then `isOurProcess` refuses the job, so the window where
 * the identity is unknown is a window where nothing can be killed on its word.
 */
export function captureIdentityAsync(
    pid: number | undefined,
    apply: (identity: ProcessIdentity) => void,
): void {
    if (!pid || pid <= 0) return;
    if (process.platform !== 'win32') {
        const identity = captureIdentity(pid);
        if (identity) apply(identity);
        return;
    }
    // Still pending: recorded as unverified so a checkpoint written in the
    // meantime is honest about not knowing.
    apply({ pid, token: 'unverified' });
    void new Promise<string | null>((resolve) => {
        const child = cp.spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            // ToUniversalTime: a capture and a post-restart verification can
            // straddle a DST change, and a shifted offset serializes to a
            // different string - a healthy job would look recycled.
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
        ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let out = '';
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 5000);
        child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => { clearTimeout(timer); resolve(out.trim() || null); });
    }).then((token) => { apply({ pid, token: token ?? 'unverified' }); });
}

/**
 * True only when `pid` is alive AND still the incarnation we spawned.
 *
 * The token check is what makes this safe. A pid that is merely ALIVE is not
 * enough - that is precisely the recycled-number case.
 */
export function isOurProcess(identity: ProcessIdentity | null | undefined): boolean {
    if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return false;
    if (identity.token === 'unverified') return false;
    let alive = false;
    try {
        process.kill(identity.pid, 0);
        alive = true;
    } catch (err: any) {
        // EPERM means the process exists but belongs to another user - alive,
        // and still not ours to signal.
        if (err?.code !== 'EPERM') return false;
        alive = true;
    }
    if (!alive) return false;
    const current = processStartToken(identity.pid);
    return current !== null && current === identity.token;
}
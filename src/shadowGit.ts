/**
 * Shadow-git checkpoints for Project Xratu.
 *
 * A hidden git repository lives in the extension's GLOBAL storage (outside
 * the user's workspace) and tracks the workspace via GIT_DIR/GIT_WORK_TREE
 * environment variables plus a dedicated index file. Consequences:
 *
 * - Checkpointing NEVER touches the user's own git history, staging area,
 *   or refs. No `git add -A` in their repo, ever - not even under YOLO mode.
 * - Restores are FILES-ONLY: workspace files are rewound to the checkpoint;
 *   files created after it are removed; the user's git state is untouched.
 * - The shadow repo automatically honors the workspace's own .gitignore
 *   (standard git behavior with GIT_WORK_TREE) and additionally excludes
 *   heavyweight junk via its info/exclude file.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * ALL git work here is ASYNCHRONOUS on purpose: spawnSync would freeze the
 * extension host thread (and with it every webview message, keystroke and
 * MCP reply) for the duration of a snapshot on large repos.
 */

interface GitResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Outcome of restoreCheckpoint: `changed: false` means the workspace
 *  already matched the target (no-op - nothing was touched). */
export interface RestoreResult {
    changed: boolean;
    sha: string;
    safety: string;
}

/** Thrown by restoreCheckpoint when the target is the initial empty seed
 *  commit. Distinguishable so flows that "just want to rewind" (edit-resend)
 *  can continue silently while explicit restore flows keep surfacing it. */
export class EmptySeedError extends Error {
    constructor() {
        super('This checkpoint is the empty initial seed; refusing to wipe the workspace.');
        this.name = 'EmptySeedError';
    }
}

function gitExec(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<GitResult> {
    return new Promise((resolve) => {
        cp.execFile(
            'git',
            args,
            // windowsHide: git.exe is a console app - without this flag every
            // checkpoint spawns a visible console window on Windows.
            { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8', windowsHide: true },
            (error, stdout, stderr) => resolve({
                // git exit codes land in error.code; null error means 0.
                code: error ? ((error as any).code ?? 1) : 0,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
            })
        );
    });
}

/** Extra patterns excluded ONLY from the shadow repo (never shipped anywhere). */
const SHADOW_EXCLUDES = [
    '.git',
    'node_modules/',
    '__pycache__/',
    '.venv/',
    'venv/',
];


function shortSha(sha: string): string {
    return (sha || '').slice(0, 12);
}

export class ShadowCheckpointStore {
    /** Turn-scoped snapshot bookkeeping: one automatic snapshot per turn. */
    private _turnSnapshotDone = false;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    /** Call when a brand-new assistant turn begins (fresh prompt or approval round). */
    beginTurn(): void {
        this._turnSnapshotDone = false;
    }

    private repoDir(workspaceRoot: string): string {
        const key = crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
        return path.join(this._context.globalStorageUri.fsPath, 'checkpoints', key);
    }

    private env(workspaceRoot: string): NodeJS.ProcessEnv {
        return {
            ...process.env,
            GIT_DIR: this.repoDir(workspaceRoot),
            GIT_WORK_TREE: workspaceRoot,
            GIT_INDEX_FILE: path.join(this.repoDir(workspaceRoot), 'index'),
        };
    }

    private gitAsync(args: string[], workspaceRoot: string, timeoutMs = 20000): Promise<GitResult> {
        return gitExec(args, this.env(workspaceRoot), timeoutMs);
    }

    /** Identity-free commits: never fail just because the user has no git config. */
    private commitArgs(subject: string): string[] {
        return [
            '-c', 'user.name=Xratu Checkpoints',
            '-c', 'user.email=checkpoint@xratu.invalid',
            'commit', '--no-verify', '-m', subject,
        ];
    }

    /** Repo-local behaviors that must NOT inherit the user's global git
     *  config: byte-exact restores (no CRLF/LF rewriting), no filemode churn
     *  on Windows network drives, and long-path support on Windows. */
    private repoConfigArgs(): string[] {
        return [
            '-c', 'core.autocrlf=false',
            '-c', 'core.filemode=false',
            '-c', 'core.longpaths=true',
            // name-only output must stay raw: C-quoted non-ASCII paths
            // ("\\346...") fail existsSync/rmSync below and silently survive
            // a checkpoint restore.
            '-c', 'core.quotePath=false',
        ];
    }

    private async ensureRepo(workspaceRoot: string): Promise<void> {
        const dir = this.repoDir(workspaceRoot);
        fs.mkdirSync(dir, { recursive: true });
        // Self-heal partial inits: a crash or extension reload mid-setup can
        // leave the directory with HEAD but no info/exclude (or emptier
        // states).  Repair whatever piece is missing instead of assuming a
        // healthy repo from HEAD alone.
        const headPath = path.join(dir, 'HEAD');
        const excludePath = path.join(dir, 'info', 'exclude');
        const headExists = fs.existsSync(headPath);
        const excludeExists = fs.existsSync(excludePath);
        if (!headExists) {
            // BARE layout: the checkpoint dir IS the git dir (GIT_DIR points
            // straight at it).  A plain `git init` would nest everything
            // under dir/.git and every GIT_DIR-based call would fail with
            // "not a git repository".  The init must also NOT see inherited
            // GIT_* env (a bare init rejects GIT_WORK_TREE).
            const initEnv = { ...process.env };
            delete initEnv.GIT_DIR;
            delete initEnv.GIT_WORK_TREE;
            delete initEnv.GIT_INDEX_FILE;
            const init = await gitExec(['init', '--bare', '--quiet', dir], initEnv, 10000);
            if (init.code !== 0) {
                throw new Error(`Could not initialize checkpoint storage: ${init.stderr}`);
            }
            // Seed an empty root commit so restores/diffs always have a base.
            await this.gitAsync([...this.repoConfigArgs(), 'read-tree', '--empty'], workspaceRoot);
            const seeded = await this.gitAsync(
                [...this.repoConfigArgs(), ...this.commitArgs('checkpoint: initial snapshot'), '--allow-empty'],
                workspaceRoot
            );
            if (seeded.code !== 0) {
                throw new Error(`Checkpoint storage init failed: ${seeded.stderr}`);
            }
        }
        if (!excludeExists) {
            fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
            try {
                fs.writeFileSync(excludePath, SHADOW_EXCLUDES.join('\n') + '\n', 'utf-8');
            } catch { /* excludes are an optimization, not a requirement */ }
        }
        this.clearStaleIndexLock(dir);
    }

    /** A killed process (reload mid-snapshot) leaves index.lock behind and
     *  EVERY later git call fails until it is removed.  This store is the
     *  only writer, so any lock older than a minute is ours and stale. */
    private clearStaleIndexLock(dir: string): void {
        const lockPath = path.join(dir, 'index.lock');
        try {
            if (!fs.existsSync(lockPath)) return;
            const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
            if (ageMs > 60_000) fs.rmSync(lockPath, { force: true });
        } catch { /* best effort */ }
    }

    /**
     * Snapshot the workspace once per turn. Called by the MCP bridge right
     * before the first mutating tool executes, so EVERY turn with potential
     * side effects starts from a restorable point without asking anyone.
     */
    async ensureTurnSnapshot(workspaceRoot: string, description: string): Promise<void> {
        if (this._turnSnapshotDone) return;
        this._turnSnapshotDone = true;
        try {
            await this.createCheckpoint(workspaceRoot, description);
        } catch (e) {
            // A failed checkpoint must not block the user's requested action.
            console.error('xratu: turn snapshot failed:', e);
        }
    }

    /** Serialize snapshot/restore operations per store so overlapping tool
     *  calls can't interleave index manipulation. */
    private _queue: Promise<unknown> = Promise.resolve();

    private _serialized<T>(fn: () => Promise<T>): Promise<T> {
        const next = this._queue.then(fn, fn);
        this._queue = next.catch(() => undefined);
        return next;
    }

    async createCheckpoint(workspaceRoot: string, description: string): Promise<string> {
        return this._serialized(() => this._createCheckpointInner(workspaceRoot, description));
    }

    private async _createCheckpointInner(workspaceRoot: string, description: string): Promise<string> {
        await this.ensureRepo(workspaceRoot);
        const add = await this.gitAsync([...this.repoConfigArgs(), 'add', '--all'], workspaceRoot);
        if (add.code !== 0) {
            throw new Error(`Staging failed: ${add.stderr.trim()}`);
        }
        // Exit code 0 from --quiet means nothing staged -> reuse HEAD.
        const unchanged = await this.gitAsync([...this.repoConfigArgs(), 'diff', '--cached', '--quiet'], workspaceRoot);
        if (unchanged.code === 0) {
            const head = await this.gitAsync(['rev-parse', 'HEAD'], workspaceRoot);
            return shortSha(head.stdout.trim());
        }
        const subject = `checkpoint${description ? ': ' + description : ''}`;
        const commit = await this.gitAsync([...this.repoConfigArgs(), ...this.commitArgs(subject)], workspaceRoot);
        if (commit.code !== 0) {
            throw new Error(`Checkpoint commit failed: ${commit.stderr.trim()}`);
        }
        const head = await this.gitAsync(['rev-parse', 'HEAD'], workspaceRoot);
        return shortSha(head.stdout.trim());
    }

    async restoreCheckpoint(workspaceRoot: string, sha: string): Promise<RestoreResult> {
        return this._serialized(() => this._restoreInner(workspaceRoot, sha));
    }

    private async _restoreInner(workspaceRoot: string, sha: string): Promise<RestoreResult> {
        await this.ensureRepo(workspaceRoot);

        const verify = await this.gitAsync(['cat-file', '-t', sha], workspaceRoot);
        if (verify.code !== 0 || verify.stdout.trim() !== 'commit') {
            throw new Error(`Checkpoint not found: ${shortSha(sha)}`);
        }

        // Refuse the empty seed commit: "restoring" to it would mean
        // deleting every file added since - never a real user intent.
        const treeList = await this.gitAsync(['ls-tree', '-r', '--name-only', sha], workspaceRoot);
        if (treeList.code === 0 && treeList.stdout.trim() === '') {
            throw new EmptySeedError();
        }

        // Nothing to do when the workspace already matches the target tree:
        // restoring is a no-op (no safety snapshot, no "restored" toast).
        // `diff --quiet <sha>` exits 0 when worktree+index equal that tree -
        // but it only covers files the shadow index TRACKS. Files CREATED
        // after the last snapshot are untracked and invisible to it, so a
        // pure "agent created files" turn would read as "already matched"
        // and the restore would silently do nothing. Untracked (non-ignored)
        // files therefore count as differences too - the restore's tail
        // (diff-filter=A sha..HEAD) removes exactly those.
        const same = await this.gitAsync([...this.repoConfigArgs(), 'diff', '--quiet', sha], workspaceRoot);
        if (same.code === 0) {
            const others = await this.gitAsync(
                [...this.repoConfigArgs(), 'ls-files', '--others', '--exclude-standard'],
                workspaceRoot
            );
            if (others.code === 0 && others.stdout.trim() === '') {
                return { changed: false, sha: shortSha(sha), safety: '' };
            }
        }

        // Safety net first: the CURRENT state becomes restorable too.
        const safety = await this._createCheckpointInner(workspaceRoot, 'before restore');

        // Materialize the target BEFORE anything destructive: load its tree
        // into the index, then force-write every entry into the worktree.
        // (checkout <sha> -- . cannot express an empty-ish tree - pathspec
        // errors - and must never run half-done.)
        const readTree = await this.gitAsync([...this.repoConfigArgs(), 'read-tree', sha], workspaceRoot);
        if (readTree.code !== 0) {
            throw new Error(`Restore failed: ${readTree.stderr.trim()}`);
        }
        const writeOut = await this.gitAsync([...this.repoConfigArgs(), 'checkout-index', '-a', '-f'], workspaceRoot);
        if (writeOut.code !== 0) {
            throw new Error(`Restore failed: ${writeOut.stderr.trim()}`);
        }

        // Files created AFTER the checkpoint are removed (checkout-index
        // cannot delete); everything else was just rewritten above.
        const head = (await this.gitAsync(['rev-parse', 'HEAD'], workspaceRoot)).stdout.trim();
        if (head && head !== sha) {
            const added = await this.gitAsync(
                [...this.repoConfigArgs(), 'diff', '--name-only', '--diff-filter=A', `${sha}..${head}`],
                workspaceRoot
            );
            for (const rel of added.stdout.split('\n')) {
                const relTrimmed = rel.trim();
                if (!relTrimmed) continue;
                const abs = path.join(workspaceRoot, relTrimmed);
                try {
                    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
                } catch { /* best effort */ }
            }
        }

        return { changed: true, sha: shortSha(sha), safety };
    }

    async listCheckpoints(workspaceRoot: string, limit: number): Promise<string> {
        await this.ensureRepo(workspaceRoot);
        const capped = Math.max(1, Math.min(Number(limit) || 10, 50));
        const log = await this.gitAsync(
            ['log', '--format=%h|%ai|%s', `-n${capped}`],
            workspaceRoot
        );
        if (log.code !== 0 || !log.stdout.trim()) {
            return 'No checkpoints found.';
        }
        return log.stdout.trim().split('\n').map((line) => {
            const [hash, date, subject] = line.split('|');
            return `${hash} | ${date} | ${subject}`;
        }).join('\n');
    }
}

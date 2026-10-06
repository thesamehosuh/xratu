#!/usr/bin/env node
/**
 * Aggregate host-side suite runner - `npm run test:host`.
 *
 * The suite list is DERIVED from the `test:*` scripts in package.json, never
 * hand-maintained. A new suite is picked up automatically, so it can no longer
 * be forgotten in CI.
 *
 * That is a real regression, not a hypothetical one: `test:model-metadata`
 * (90 assertions) shipped as an npm script but was never added to the CI step
 * list, so it only ever ran on a machine where someone typed it by hand.
 * Deriving the list makes "forgot to wire the suite into CI" structurally
 * impossible for host suites.
 *
 * NOT_HOST_SUITES are the `test:*` scripts this runner must not own:
 *   webview / e2e  - need the webview build + a browser (separate CI steps)
 *   host           - this runner
 *
 * Compiles the host itself before running anything, because the suites under
 * test resolve `../out/*.js`. That is not a convenience: a STALE `out/` is
 * worse than a missing one. Observed live - `tsc` failed with four TS2300
 * errors while the previous build stayed in place, and this runner still
 * reported "all 20 suites passed" against output that no longer matched the
 * source. Compiling here makes that false green impossible.
 *
 * A signal-killed suite (status === null) is a FAILED suite, not a skip.
 *
 * ---------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------
 *   --jobs N, -j N     worker pool size (default: availableParallelism()-1,
 *                      clamped to [2,8]).  Also: XRATU_TEST_JOBS.
 *                      `--jobs 1` restores the original serial behaviour.
 *   --filter SUBSTR    run only suites whose name contains SUBSTR (case-insensitive).
 *   --changed [REF]    run only the suites plausibly affected by changed
 *                      source. Without REF it diffs the working tree; with a
 *                      REF it diffs `REF...HEAD` plus uncommitted changes.
 *   --json PATH        write a machine-readable run summary.
 *   --verbose          print every suite's output, not just failures'.
 *
 * `--changed` is deliberately conservative. It discovers which `out/*.js`
 * module each suite actually `require`s (by reading the suite file and the
 * local helpers it loads), maps a changed `src/*.ts` onto that module, and
 * takes the union of the matching suites. If ANY changed file cannot be
 * confidently mapped - a new file, a deleted file, package.json, tsconfig,
 * CI config - it runs the FULL set instead.
 *
 * That fallback is the whole point: a `--changed` run that reports green while
 * skipping a suite that should have run is the exact false-green failure this
 * runner exists to prevent, so "unsure" always means "run everything".
 *
 * ---------------------------------------------------------------------------
 * INVARIANTS (each has a real incident behind it - do not relax these)
 * ---------------------------------------------------------------------------
 *  1. Suites are derived from package.json `test:*`, never hand-listed.
 *  2. Compile FIRST and refuse to run against stale/missing `out/`.
 *  3. status === null (killed by signal) counts as FAILED.
 *
 * ---------------------------------------------------------------------------
 * RUN:  npm run test:host
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// cross-spawn resolves `npm` to npm.cmd on Windows, which a bare spawn would
// not. Its sync API is `.sync` (there is no `.spawnSync`).
const crossSpawn = require('cross-spawn');
const { sync: crossSpawnSync } = crossSpawn;
const os = require('os');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

const NOT_HOST_SUITES = new Set(['webview', 'e2e', 'host']);
const PREFIX = 'test:';

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
    const opts = {
        jobs: 0,
        filter: null,
        changed: null,
        changedRequested: false,
        json: null,
        verbose: process.env.XRATU_TEST_VERBOSE === '1',
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg === '--verbose') opts.verbose = true;
        else if (arg === '--jobs' || arg === '-j') opts.jobs = Number(argv[++i]);
        else if (arg.startsWith('--jobs=')) opts.jobs = Number(arg.slice(7));
        else if (arg === '--filter') opts.filter = argv[++i] ?? null;
        else if (arg.startsWith('--filter=')) opts.filter = arg.slice(9);
        else if (arg === '--json') opts.json = argv[++i] ?? null;
        else if (arg.startsWith('--json=')) opts.json = arg.slice(7);
        else if (arg === '--changed') {
            opts.changedRequested = true;
            // Optional value: only consume the next token when it cannot be
            // another flag, otherwise `--changed --jobs 4` would eat the flag.
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) opts.changed = argv[++i];
        } else if (arg.startsWith('--changed=')) {
            opts.changedRequested = true;
            opts.changed = arg.slice(10);
        } else {
            console.error(`host-tests: unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    if (Number.isNaN(opts.jobs) || opts.jobs < 0) opts.jobs = 0;
    return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
    console.log([
        'host-tests - host-side suite runner',
        '',
        '  --jobs N, -j N   parallel workers (default: cpus-1 clamped 2..8; env XRATU_TEST_JOBS)',
        '  --filter SUBSTR  only suites whose name contains SUBSTR (case-insensitive)',
        '  --changed [REF]  only suites affected by changed source (unsure -> full set)',
        '  --json PATH      write a machine-readable summary',
        '  --verbose        print output for passing suites too (env XRATU_TEST_VERBOSE=1)',
        '  --help           this text',
    ].join('\n'));
    process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 1. Derive the suite list (INVARIANT 1)
 * ------------------------------------------------------------------ */

const allSuites = Object.keys(pkg.scripts ?? {})
    .filter((name) => name.startsWith(PREFIX))
    .map((name) => name.slice(PREFIX.length))
    .filter((name) => !NOT_HOST_SUITES.has(name))
    .sort();

if (allSuites.length === 0) {
    console.error('host-tests: no suites discovered - is package.json intact?');
    process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 2. Compile (INVARIANT 2), with a fingerprint short-circuit
 *
 * Skipping tsc is only safe if the fingerprint covers EVERYTHING the compile
 * reads: the path AND content of every TypeScript file under src/ (so a
 * DELETED file changes it - an mtime check would miss that and happily run the
 * output of a file that no longer exists), plus tsconfig.json and
 * package-lock.json (which pins @types and the lib .d.ts files the compile
 * pulls in).
 *
 * The state file lives INSIDE out/, so a missing or empty out/ can never
 * short-circuit. On any doubt - and always after a failed compile - we compile.
 * ------------------------------------------------------------------ */

const outDir = join(repoRoot, 'out');
const statePath = join(outDir, '.xratu-compile-state.json');

function walkSources(dir, into) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return into;
    }
    for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walkSources(abs, into);
        else if (entry.isFile() && entry.name.endsWith('.ts')) into.push(abs);
    }
    return into;
}

function compileFingerprint() {
    const inputs = walkSources(join(repoRoot, 'src'), []).sort();
    for (const name of ['tsconfig.json', 'package-lock.json']) inputs.push(join(repoRoot, name));
    const hash = createHash('sha256');
    for (const abs of inputs) {
        let digest;
        try {
            digest = createHash('sha256').update(readFileSync(abs)).digest('hex');
        } catch {
            return null; // unreadable input: we cannot prove freshness.
        }
        hash.update(relative(repoRoot, abs).split(sep).join('/'));
        hash.update('\u0000');
        hash.update(digest);
        hash.update('\u0000');
    }
    return hash.digest('hex');
}

function outHasOutput() {
    if (!existsSync(outDir)) return false;
    const stack = [outDir];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const abs = join(dir, entry.name);
            if (entry.isDirectory()) stack.push(abs);
            else if (entry.name.endsWith('.js')) return true;
        }
    }
    return false;
}

/** Drop the recorded state so a later run can never short-circuit on it. */
function invalidateCompileState() {
    try {
        if (existsSync(statePath)) unlinkSync(statePath);
    } catch {
        /* best effort */
    }
}

let compileSkipped = false;
const fingerprint = compileFingerprint();
let fresh = false;

if (fingerprint && outHasOutput() && existsSync(statePath)) {
    try {
        fresh = JSON.parse(readFileSync(statePath, 'utf-8')).fingerprint === fingerprint;
    } catch {
        fresh = false;
    }
}

if (fresh) {
    compileSkipped = true;
    console.log('host-tests: out/ is already current (fingerprint match) - skipping tsc');
} else {
    console.log('host-tests: compiling host (npm run compile-tests)');
    const compile = crossSpawnSync('npm', ['run', '--silent', 'compile-tests'], {
        cwd: repoRoot,
        stdio: 'inherit',
    });
    // INVARIANT 2: a failed compile must not be followed by running suites
    // against whatever build happened to be left in out/.
    if (compile.status !== 0) {
        invalidateCompileState();
        console.error(
            '\nhost-tests: host compile FAILED - refusing to run the suites against '
            + 'stale or missing out/ output.',
        );
        process.exit(1);
    }
    if (!existsSync(outDir) || !outHasOutput()) {
        invalidateCompileState();
        console.error(
            'host-tests: compiled host output is missing (out/) after a successful compile.\n'
            + '  The suites require it - run:  npx tsc -p . --outDir out',
        );
        process.exit(1);
    }
    try {
        writeFileSync(statePath, JSON.stringify({ fingerprint, at: new Date().toISOString() }));
    } catch {
        // Only costs us the optimisation on the next run.
    }
}

/* ------------------------------------------------------------------ *
 * 3. Select suites
 * ------------------------------------------------------------------ */

function gitOutput(args) {
    try {
        const res = crossSpawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
        if (res.status !== 0) return null;
        return String(res.stdout ?? '');
    } catch {
        return null;
    }
}

/** Changed/added/untracked paths, or null when git could not answer. */
function changedPaths(ref) {
    const parts = [];
    // With a REF, the committed range: `a...b` is the merge-base diff, which
    // is what a PR-style "what did I change" question actually means.
    if (ref) parts.push(gitOutput(['diff', '--name-only', `${ref}...HEAD`]));
    // Always layer on uncommitted work. A ref that only looked at the range
    // would happily skip a suite for a file the developer edited but has not
    // committed - i.e. the most common case for a local run.
    parts.push(gitOutput(['diff', '--name-only', 'HEAD']));
    parts.push(gitOutput(['status', '--porcelain']));

    if (parts.every((p) => p === null)) return null;

    const paths = new Set();
    for (const text of parts) {
        if (text === null) continue;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            // `git diff --name-only` lines are bare paths; `--porcelain` lines
            // are two status chars + a space + the path (and may rename with
            // `old -> new`, which must not be taken as a single path).
            const path = line.includes(' -> ') ? '' : (/^[ MADRC?!]{2} /.test(line) ? line.slice(3).trim() : line.trim());
            if (path && path !== '.') paths.add(path);
        }
    }
    return paths;
}

/**
 * The `out/*.js` modules a suite actually loads, discovered by reading the
 * suite file and recursively following its local helper requires. Derived from
 * what the test REALLY imports rather than guessed from its name - which is
 * what makes `--changed` defensible.
 */
function modulesLoadedBy(file, seen = new Set()) {
    const modules = new Set();
    if (seen.has(file) || !existsSync(file)) return modules;
    seen.add(file);
    const dir = dirname(file);
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    let source;
    try {
        source = readFileSync(file, 'utf-8');
    } catch {
        return modules;
    }
    while ((match = re.exec(source)) !== null) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue;
        const abs = join(dir, spec);
        if (spec.includes('..') && /[\\/]out[\\/]/.test(spec)) {
            modules.add(spec.replace(/^.*[\\/]out[\\/]/, '').replace(/\.js$/, ''));
        } else if (spec.endsWith('.mjs') || spec.endsWith('.js')) {
            for (const m of modulesLoadedBy(abs, seen)) modules.add(m);
        }
    }
    return modules;
}

const suiteModuleCache = new Map();
function suiteModules(suite) {
    if (!suiteModuleCache.has(suite)) {
        suiteModuleCache.set(suite, modulesLoadedBy(join(repoRoot, 'test', `test-${suite}.mjs`)));
    }
    return suiteModuleCache.get(suite);
}

function selectSuites() {
    let suites = allSuites;

    if (opts.filter) {
        const needle = opts.filter.toLowerCase();
        suites = suites.filter((s) => s.toLowerCase().includes(needle));
        if (suites.length === 0) {
            console.error(`host-tests: --filter "${opts.filter}" matched no suites.`);
            process.exit(2);
        }
    }

    if (!opts.changedRequested) return { suites, reason: null };

    const paths = changedPaths(opts.changed);
    if (paths === null) return { suites, reason: 'git unavailable - running the full set' };
    if (paths.size === 0) return { suites, reason: 'nothing changed - running the full set' };

    const changedModules = new Set();
    let unmapped = 0;

    for (const path of paths) {
        const posix = path.split(sep).join('/');

        // Config changes ripple: the compile, the suite list, and CI all read
        // these, so no subset can be justified.
        if (posix === 'package.json' || posix === 'package-lock.json'
            || posix === 'tsconfig.json' || posix.startsWith('.github/')) {
            unmapped++;
            continue;
        }
        const selfSuite = /^test\/test-(.+)\.mjs$/.exec(posix);
        if (selfSuite) {
            changedModules.add(`suite:${selfSuite[1]}`);
            continue;
        }
        if (posix.startsWith('src/') && posix.endsWith('.ts')) {
            changedModules.add(posix.slice(4, -3));
            continue;
        }
        unmapped++;
    }

    // INVARIANT of --changed: any path we cannot map means "run everything".
    if (unmapped > 0) {
        return { suites, reason: `${unmapped} changed path(s) could not be mapped - running the full set` };
    }
    if (changedModules.size === 0) {
        return { suites, reason: 'no source modules changed - running the full set' };
    }

    const selected = suites.filter((suite) => {
        if (changedModules.has(`suite:${suite}`)) return true;
        const mods = suiteModules(suite);
        for (const mod of changedModules) if (mods.has(mod)) return true;
        return false;
    });

    if (selected.length === 0) {
        return { suites, reason: 'changed source is imported by no suite - running the full set' };
    }
    return { suites, reason: null };
}

const selection = selectSuites();
const suites = selection.suites;

console.log(`host-tests: ${suites.length}/${allSuites.length} suites selected from package.json`);
if (opts.changedRequested) console.log(`host-tests: --changed: ${selection.reason ?? 'affected subset'}`);

/* ------------------------------------------------------------------ *
 * 4. Run them
 * ------------------------------------------------------------------ */

function defaultJobs() {
    let n;
    try {
        n = os.availableParallelism();
    } catch {
        n = os.cpus().length;
    }
    return Math.min(8, Math.max(2, n - 1));
}

const envJobs = Number(process.env.XRATU_TEST_JOBS);
const requestedJobs = opts.jobs > 0 ? opts.jobs : (envJobs > 0 ? envJobs : defaultJobs());
const jobs = Math.max(1, Math.min(suites.length || 1, requestedJobs));

function runSuite(script) {
    const started = Date.now();
    if (jobs === 1) {
        // Serial mode keeps the original streaming behaviour verbatim, so
        // `--jobs 1` is a faithful escape hatch when interleaving is what you
        // are actually trying to debug.
        process.stdout.write(`\n=== ${script} ===\n`);
        const res = crossSpawnSync('npm', ['run', '--silent', script], { cwd: repoRoot, stdio: 'inherit' });
        return Promise.resolve({ script, passed: res.status === 0, status: res.status, ms: Date.now() - started, output: '' });
    }
    return new Promise((resolve) => {
        const child = crossSpawn('npm', ['run', '--silent', script], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const capture = (chunk) => { output += chunk.toString(); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        child.on('error', (err) => {
            resolve({
                script,
                passed: false,
                status: null,
                ms: Date.now() - started,
                output: `${output}\nspawn error: ${err.message}`,
            });
        });
        child.on('close', (status, signal) => {
            // INVARIANT 3: status === null means the child died on a signal.
            if (signal) output += `\nkilled by signal ${signal}`;
            resolve({ script, passed: status === 0, status, ms: Date.now() - started, output });
        });
    });
}

const startedAt = Date.now();
const results = new Array(suites.length);
let cursor = 0;

async function worker() {
    for (;;) {
        const index = cursor++;
        if (index >= suites.length) return;
        const script = `${PREFIX}${suites[index]}`;
        const result = await runSuite(script);
        results[index] = result;
        if (jobs > 1) {
            process.stdout.write(
                `${result.passed ? 'ok  ' : 'FAIL'} ${result.script} (${(result.ms / 1000).toFixed(1)}s)\n`,
            );
        }
    }
}

await Promise.all(Array.from({ length: jobs }, worker));

const durationMs = Date.now() - startedAt;
const failed = results.filter((r) => !r.passed);

/* ------------------------------------------------------------------ *
 * 5. Report
 * ------------------------------------------------------------------ */

if (jobs > 1) {
    console.log('\n=== host suite summary ===');
    for (const r of results) {
        console.log(`${r.passed ? 'ok  ' : 'FAIL'} ${r.script} (${(r.ms / 1000).toFixed(1)}s)`);
    }
}

// Parallel runs buffer output, so a failure has to open its own buffer: that
// is the whole reason buffering is safe. Passing suites stay quiet unless asked.
if (failed.length) {
    for (const r of failed) {
        console.log(`\n=== FAILED ${r.script} (exit ${r.status}) ===`);
        console.log(r.output.trim() ? r.output.trimEnd() : '(no output captured)');
    }
} else if (jobs > 1 && opts.verbose) {
    for (const r of results) {
        console.log(`\n=== ${r.script} ===`);
        if (r.output.trim()) console.log(r.output.trimEnd());
    }
}

if (opts.json) {
    const payload = {
        compileSkipped,
        jobs,
        durationMs,
        selected: suites.length,
        total: allSuites.length,
        reason: selection.reason,
        passed: results.length - failed.length,
        failed: failed.length,
        suites: results.map((r) => ({
            name: r.script,
            passed: r.passed,
            status: r.status,
            ms: r.ms,
        })),
    };
    try {
        // An absolute --json must not be re-rooted onto the repo (path.join
        // would silently turn /tmp/x.json into <repo>/tmp/x.json).
        const target = isAbsolute(opts.json) ? opts.json : join(repoRoot, opts.json);
        writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
        console.log(`host-tests: wrote ${opts.json}`);
    } catch (err) {
        console.error(`host-tests: could not write ${opts.json}: ${err.message}`);
        process.exitCode = 1;
    }
}

console.log(
    `host-tests: ${results.length} suites in ${(durationMs / 1000).toFixed(1)}s`
    + ` (${jobs} worker${jobs === 1 ? '' : 's'}${compileSkipped ? ', compile skipped' : ''})`,
);

if (failed.length) {
    console.log(`host-tests: ${failed.length}/${results.length} suites FAILED: ${failed.map((f) => f.script).join(', ')}`);
    process.exit(1);
}
console.log(`host-tests: all ${results.length} suites passed`);

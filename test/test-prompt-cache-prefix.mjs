#!/usr/bin/env node
/**
 * Prompt-cache PREFIX INVARIANCE suite.
 *
 * Providers reuse the longest byte-identical PREFIX of a request (tools +
 * system + messages). Every message after the first changed byte is a miss, so
 * the tools + system prompt MUST be byte-stable across the turns of a session.
 *
 * Regression this guards (measured live against OpenCode Go / deepseek-v4.1-flash):
 * the host rebuilt the system prompt on EVERY turn from `collectProjectRules()`,
 * which walks from the workspace root to the ACTIVE EDITOR's directory. Crossing
 * a nested AGENTS.md (switching files) rewrote the system prompt mid-session, so
 * every turn's first request reported 0 cached tokens and the aggregate fell to
 * 41-57%, versus ~95% at turn boundaries with a stable prompt.
 *
 * The fix snapshots the rules once per session (`RulesSnapshot`, keyed by
 * workspace root). This suite drives the REAL assembly (`buildLocalSystemPrompt`)
 * and the REAL snapshot, and proves both directions: frozen rules keep the
 * prefix identical, while the pre-fix per-turn recompute measurably breaks it.
 *
 * Run: node test/test-prompt-cache-prefix.mjs   (after `npx tsc -p . --outDir out`)
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildLocalSystemPrompt } = require('../out/systemPrompt.js');
const { RulesSnapshot } = require('../out/local/rulesSnapshot.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

const json = (value) => JSON.stringify(value ?? null);
function commonPrefixLength(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i]) i++;
    return i;
}

// A stable tool block, exactly as the request serializes it.
const TOOLS = [
    { name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'grep_search', description: 'Search.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
];

/**
 * The cacheable prefix a provider sees: tools first, then the system prompt,
 * then the replayed conversation. The system prompt sits at the FRONT, so a
 * change there invalidates the whole history that follows - exactly what the
 * host did every turn.
 */
const HISTORY = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(120)}` }));
function cacheablePrefix(systemPrompt) {
    return json(TOOLS) + '\u0000' + systemPrompt + '\u0000' + HISTORY.map(json).join('\u0000');
}

/** Rules that change with the active file (a nested AGENTS.md chain). */
function rulesForActiveDir(dir) {
    return `## AGENTS.md\nRoot rules for the workspace.\n\n## ${dir}/AGENTS.md\nRules specific to ${dir}.\n` + `rule line\n`.repeat(40);
}

/**
 * One session: `turn` recomputes rules from the active dir, builds the system
 * prompt, and returns the cacheable prefix. `snapshot` (when given) freezes the
 * rules per workspace root, the shipped behavior.
 */
async function runSession({ turns, snapshot = null, root = '/ws' }) {
    const prefixes = [];
    const systems = [];
    for (let turn = 0; turn < turns; turn++) {
        // The user switches files between turns - the active dir changes.
        const activeDir = `src/area${turn}`;
        const compute = async () => rulesForActiveDir(activeDir);
        const rulesContext = snapshot
            ? await snapshot.resolve(root, compute)
            : await compute();
        const system = buildLocalSystemPrompt({
            rulesContext,
            sessionSummary: null,
            planMode: false,
            evictedUserTurns: 0,
        });
        systems.push(system);
        prefixes.push(cacheablePrefix(system));
    }
    return { systems, prefixes };
}

// ---------------------------------------------------------------------------
// The fix: session-frozen rules keep the system prompt byte-stable.
// ---------------------------------------------------------------------------
{
    const { systems, prefixes } = await runSession({ turns: 5, snapshot: new RulesSnapshot() });
    ok('frozen rules: the system prompt is byte-identical on every turn',
        systems.every((s) => s === systems[0]));
    ok('frozen rules: the cacheable prefix is byte-identical on every turn',
        prefixes.every((p) => p === prefixes[0]));
    ok('frozen rules: turn 5 reuses 100% of turn 1\'s prefix',
        commonPrefixLength(prefixes[0], prefixes[4]) === prefixes[0].length);
    ok('frozen rules: the snapshot captured the FIRST active dir (session-start rules)',
        systems[0].includes('src/area0/AGENTS.md') && !systems[0].includes('src/area4/AGENTS.md'));
}

// ---------------------------------------------------------------------------
// PROOF: the pre-fix per-turn recompute measurably breaks the prefix.
// ---------------------------------------------------------------------------
{
    const { systems, prefixes } = await runSession({ turns: 5, snapshot: null });
    ok('recompute (pre-fix): the system prompt changes between turns',
        systems.some((s) => s !== systems[0]));
    const cover = prefixes.map((p, i) => (i === 0 ? 1 : commonPrefixLength(prefixes[i - 1], p) / prefixes[i - 1].length));
    const minCover = Math.min(...cover.slice(1));
    ok('recompute (pre-fix): a turn boundary re-sends the history that follows the system prompt',
        minCover < 0.5, `minCover=${(minCover * 100).toFixed(1)}%`);
    ok('frozen rules strictly improve prefix reuse over recompute',
        commonPrefixLength(prefixes[0], prefixes[1]) < (await runSession({ turns: 2, snapshot: new RulesSnapshot() })).prefixes[0].length);
}

// ---------------------------------------------------------------------------
// Snapshot lifecycle: key change (workspace switch) and reset (new session)
// both recompute; the same key does not.
// ---------------------------------------------------------------------------
{
    const snap = new RulesSnapshot();
    let computes = 0;
    const compute = (value) => async () => { computes++; return value; };

    await snap.resolve('/ws-a', compute('A'));
    await snap.resolve('/ws-a', compute('A-again'));
    ok('same key computes once (no hot-path recompute)', computes === 1, `computes=${computes}`);

    const b = await snap.resolve('/ws-b', compute('B'));
    ok('a new key recomputes', computes === 2 && b === 'B', `computes=${computes}`);

    snap.reset();
    const a2 = await snap.resolve('/ws-a', compute('A2'));
    ok('reset recomputes (new session picks up edited rules)',
        computes === 3 && a2 === 'A2', `computes=${computes}`);
}

// ---------------------------------------------------------------------------
// Concurrency: same-key reads coalesce, and a stale completion cannot
// overwrite a newer key (a session/workspace transition racing a pending read).
// ---------------------------------------------------------------------------
{
    const deferred = () => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
    };

    // Same key -> one compute, both callers see the value.
    {
        const snap = new RulesSnapshot();
        const d = deferred();
        let computes = 0;
        const compute = async () => { computes++; return d.promise; };
        const p1 = snap.resolve('/ws', compute);
        const p2 = snap.resolve('/ws', compute);
        d.resolve('RULES');
        const [a, b] = await Promise.all([p1, p2]);
        ok('concurrent same-key reads coalesce onto one compute', computes === 1, `computes=${computes}`);
        ok('both concurrent callers get the rules', a === 'RULES' && b === 'RULES');
    }

    // Stale completion must not overwrite a newer key.
    {
        const snap = new RulesSnapshot();
        const dA = deferred();
        const dB = deferred();
        let computesA = 0;
        const pA = snap.resolve('/ws-a', async () => { computesA++; return dA.promise; });
        const pB = snap.resolve('/ws-b', async () => dB.promise);
        dA.resolve('A-VALUE');
        await pA;
        dB.resolve('B-VALUE');
        await pB;
        // The snapshot must still be B (the newer key), so a B read is cached...
        let bComputes = 0;
        const bCached = await snap.resolve('/ws-b', async () => { bComputes++; return 'B-AGAIN'; });
        ok('the newer key stays cached after the stale completion', bCached === 'B-VALUE' && bComputes === 0);
        // ...and an A read recomputes instead of returning the stale value.
        let freshCalls = 0;
        const again = await snap.resolve('/ws-a', async () => { freshCalls++; return 'A-FRESH'; });
        ok('a stale completion does not overwrite the newer key',
            again === 'A-FRESH' && freshCalls === 1 && computesA === 1,
            `again=${again} freshCalls=${freshCalls} computesA=${computesA}`);
    }

    // reset() invalidates an in-flight read.
    {
        const snap = new RulesSnapshot();
        const d = deferred();
        const p = snap.resolve('/ws', async () => d.promise);
        snap.reset();
        d.resolve('STALE');
        await p;
        const fresh = await snap.resolve('/ws', async () => 'FRESH');
        ok('reset invalidates an in-flight read', fresh === 'FRESH');
    }
}

// ---------------------------------------------------------------------------
// The assembly itself: deterministic, and every section lands where expected.
// ---------------------------------------------------------------------------
{
    const inputs = { rulesContext: 'RULES', sessionSummary: 'SUMMARY', planMode: false, evictedUserTurns: 0 };
    ok('assembly is deterministic', buildLocalSystemPrompt(inputs) === buildLocalSystemPrompt({ ...inputs }));
    const s = buildLocalSystemPrompt(inputs);
    ok('rules ride the system prompt', s.includes('Project Rules (from AGENTS.md):\nRULES'));
    ok('summary rides the system prompt', s.includes('Conversation summary:\nSUMMARY'));
    ok('plan guidance is omitted when not in plan mode', !s.includes('PLAN MODE'));
    ok('eviction note is omitted when nothing was evicted', !s.includes('older turn(s) were dropped'));

    const plan = buildLocalSystemPrompt({ ...inputs, planMode: true, evictedUserTurns: 2 });
    ok('plan guidance appears in plan mode', plan.includes('PLAN MODE (READ-ONLY)'));
    ok('eviction note appears when turns were evicted', plan.includes('2 older turn(s) were dropped'));
    ok('rules still come before the summary', plan.indexOf('RULES') < plan.indexOf('SUMMARY'));
}

console.log(failed === 0 ? '\nall prompt-cache-prefix checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

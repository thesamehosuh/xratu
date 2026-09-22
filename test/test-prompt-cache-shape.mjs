#!/usr/bin/env node
/**
 * Prompt-cache SHAPE tests - the cacheable prefix must grow monotonically.
 *
 * Regression: cache hit rate was ~50% in xratu against >98% in a comparable
 * harness. Cause: the volatile per-round note was MERGED into the last
 * message's content. The note is never stored in `messages`, so the next
 * request replayed that message CLEAN - its bytes differed from what was sent
 * - and the cached prefix ended one message early, every round and every turn.
 *
 * THE INVARIANT (stated precisely, because the first version of this test got
 * it wrong): for consecutive requests, the longest common prefix must equal
 * `stored.length` of the PREVIOUS request - that is, every message that
 * request sent, with the volatile note costing exactly ONE extra message at
 * the tail and nothing else.
 *
 * Note the asymmetry that is easy to get wrong: a message PRODUCED in round N
 * cannot be read from cache in round N (it had never been sent before); it
 * becomes readable in round N+1. So the invariant is about the previous
 * request's stored messages, not about "the whole history".
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-prompt-cache-shape.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { appendTailNote } = require('../out/local/localAgent.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
};

const sys = (t) => ({ role: 'system', content: t });
const user = (t) => ({ role: 'user', content: t });
const asst = (t) => ({ role: 'assistant', content: t });
const tool = (t) => ({ role: 'tool', content: t, tool_call_id: 'c1' });

/** Longest common prefix, compared message-by-message as exact bytes. */
function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && JSON.stringify(a[i]) === JSON.stringify(b[i])) i++;
    return i;
}

// Deliberately different every round - that is the point of a volatile note,
// and exactly what the old merge could not survive.
const note1 = '[Task list: 0/3 done]\n[Context status: 12% (120k/1048576 tokens)]';
const note2 = '[Task list: 1/3 done]\n[Context status: 13% (131k/1048576 tokens)]';
const note3 = '[Task list: 2/3 done]\n[Context status: 15% (157k/1048576 tokens)]';

// --- the note must actually reach the model, without mutating anything -----
{
    const base = [sys('S'), user('hello')];
    const wire = appendTailNote(base, note1);
    ok('the note is present in the request', JSON.stringify(wire).includes('Context status'));
    ok('the stored messages are not mutated', !JSON.stringify(base).includes('Context status'));
    ok('a request gains exactly one message', wire.length === base.length + 1);
    ok('the note is the LAST message', wire[wire.length - 1].content.includes('Context status'));
}

// --- WITHIN a turn --------------------------------------------------------
{
    const stored1 = [sys('S'), user('earlier turn'), user('do the thing')];
    const wire1 = appendTailNote(stored1, note1);

    const stored2 = [...stored1, asst('calling tool'), tool('TOOL RESULT 1')];
    const wire2 = appendTailNote(stored2, note2);

    const shared = commonPrefix(wire1, wire2);
    ok(
        "round 2 reuses ALL of round 1's stored prefix",
        shared === stored1.length,
        `shared=${shared}, stored1.length=${stored1.length}`,
    );
    ok('the changing note does not truncate the prefix', shared > 0);
}

// --- ACROSS turns ---------------------------------------------------------
{
    const stored1 = [sys('S'), user('turn one')];
    const wire1 = appendTailNote(stored1, note1);

    const stored2 = [...stored1, asst('worked'), tool('TOOL RESULT 1'), user('turn two')];
    const wire2 = appendTailNote(stored2, note2);

    const shared = commonPrefix(wire1, wire2);
    ok(
        "turn 2 reuses ALL of turn 1's stored prefix",
        shared === stored1.length,
        `shared=${shared}, stored1.length=${stored1.length}`,
    );

    // Turn 3 is where turn 1's produced content becomes readable.
    const stored3 = [...stored2, asst('worked again'), tool('TOOL RESULT 2'), user('turn three')];
    const wire3 = appendTailNote(stored3, note3);
    const shared23 = commonPrefix(wire2, wire3);
    ok(
        "turn 3 reuses ALL of turn 2's stored prefix",
        shared23 === stored2.length,
        `shared=${shared23}, stored2.length=${stored2.length}`,
    );
    const cachedForTurn3 = JSON.stringify(wire3.slice(0, shared23));
    ok(
        "turn 1's tool result is cacheable by turn 3",
        cachedForTurn3.includes('TOOL RESULT 1'),
    );
}

// --- three rounds: the newest tool result must become cacheable -----------
{
    const r1 = appendTailNote([sys('S'), user('u')], note1);
    const stored2 = [sys('S'), user('u'), asst('a'), tool('t1')];
    const r2 = appendTailNote(stored2, note2);
    const stored3 = [...stored2, asst('a2'), tool('t2')];
    const r3 = appendTailNote(stored3, note3);

    const p12 = commonPrefix(r1, r2);
    const p23 = commonPrefix(r2, r3);
    ok('the cacheable prefix grows across rounds', p23 > p12, `p12=${p12} p23=${p23}`);
    ok('round 3 reuses all of round 2', p23 === stored2.length, `p23=${p23}, want ${stored2.length}`);
    ok(
        "round 2's tool result is read from cache in round 3",
        JSON.stringify(r3.slice(0, p23)).includes('t1'),
    );
}

// --- a stale note must never leak into the replayed prefix ----------------
{
    const stored = [sys('S'), user('u')];
    const wire = appendTailNote(stored, note1);
    const replayed = wire.slice(0, stored.length);
    ok('no stale note leaks into the replayed prefix', !JSON.stringify(replayed).includes('Context status'));
}

// --- robustness -----------------------------------------------------------
{
    ok('empty input is returned as-is', appendTailNote([], note1).length === 0);
    const base = [sys('S'), user('u')];
    ok('an empty note is a no-op', appendTailNote(base, '').length === base.length);
    const arr = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    ok('array content is handled', appendTailNote(arr, note1).length === 2);
}

// --- PROOF: the old merge truncated the prefix, this does not -------------
// Reproduces the removed implementation so the regression is MEASURED. If this
// comparison ever stops showing a difference, the test has stopped testing.
{
    const oldAppend = (messages, note) => {
        const out = messages.slice();
        const last = out[out.length - 1];
        out[out.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
        return out;
    };

    const stored1 = [sys('S'), user('u1')];
    const stored2 = [...stored1, asst('a1'), tool('TOOL RESULT 1')];
    const stored3 = [...stored2, asst('a2'), tool('TOOL RESULT 2')];

    const oldP23 = commonPrefix(oldAppend(stored2, note2), oldAppend(stored3, note3));
    const newP23 = commonPrefix(appendTailNote(stored2, note2), appendTailNote(stored3, note3));

    console.log(`\n  cacheable prefix round2->round3: old=${oldP23} new=${newP23} (stored2=${stored2.length})`);
    ok('the old merge fell one message short (regression reproduced)', oldP23 === stored2.length - 1, `old=${oldP23}`);
    ok('the new append reuses the whole previous prefix', newP23 === stored2.length, `new=${newP23}`);
    ok('the fix strictly improves the cacheable prefix', newP23 > oldP23, `old=${oldP23} new=${newP23}`);
    ok(
        "the old shape could not cache the newest tool result (the ~50% cause)",
        !JSON.stringify(oldAppend(stored3, note3).slice(0, oldP23)).includes('TOOL RESULT 1'),
    );
}

console.log(failed === 0 ? '\nall prompt-cache-shape checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

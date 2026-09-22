#!/usr/bin/env node
/**
 * Prompt-cache shape tests - the volatile tail note must not mutate replayed
 * bytes, and must not break role alternation.
 *
 * Regression, measured live: the chat transport merged the per-round note into
 * the last message's content. The note is never stored, so the NEXT request
 * replayed that message clean; its bytes differed from what had been sent and
 * the cached prefix ended one message EARLY, every round and every turn. In a
 * tool-using loop that meant the newest tool result (usually the largest
 * message) could never be read from cache - a ~50% hit rate against >98% for a
 * harness that keeps its prefix stable.
 *
 * The fix appends the note as its OWN trailing user turn, so every stored
 * message stays byte-exact and the cacheable prefix grows monotonically. It
 * still merges when the last stored message is already `user`: some strict
 * OpenAI-compatible servers and every Gemini endpoint reject consecutive
 * same-role turns, and nothing is cached before the first request of a turn, so
 * that merge costs no cache hit while the tool rounds keep the fix.
 *
 * Run: node test/test-prompt-cache-shape.mjs
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

/** No two consecutive contents may share a role (Gemini / strict servers). */
function alternates(messages) {
    for (let i = 1; i < messages.length; i++) {
        if (messages[i].role === messages[i - 1].role) return false;
    }
    return true;
}

// Deliberately different every round - that is the point of a volatile note.
const note1 = '[Task list: 0/3 done]\n[Context status: 12% (120k/1048576 tokens)]';
const note2 = '[Task list: 1/3 done]\n[Context status: 13% (131k/1048576 tokens)]';
const note3 = '[Task list: 2/3 done]\n[Context status: 15% (157k/1048576 tokens)]';

// --- the note reaches the model, without mutating anything ------------------
{
    const toolEnding = [sys('S'), user('hello'), asst('calling tool'), tool('TOOL RESULT')];
    const wire = appendTailNote(toolEnding, note1);
    ok('the note is present in the request', JSON.stringify(wire).includes('Context status'));
    ok('the stored messages are not mutated', !JSON.stringify(toolEnding).includes('Context status'));
    ok('a tool-ending request gains exactly one message', wire.length === toolEnding.length + 1);
    ok('the note is its own LAST user turn', wire[wire.length - 1].role === 'user'
        && String(wire[wire.length - 1].content).includes('Context status'));
    ok('tool-ending shape keeps roles alternating', alternates(wire));
}

// --- a user-ending request MERGES, to keep roles alternating ----------------
{
    const userEnding = [sys('S'), user('hello')];
    const wire = appendTailNote(userEnding, note1);
    ok('a user-ending request does NOT gain a second user turn', wire.length === userEnding.length);
    ok('the merged note still reaches the model', String(wire[wire.length - 1].content).includes('Context status'));
    ok('user-ending shape keeps roles alternating', alternates(wire));
    ok('the merge does not mutate the stored array', !JSON.stringify(userEnding).includes('Context status'));
}

// --- WITHIN a turn: the tool result must become byte-stable -----------------
{
    const stored2 = [sys('S'), user('u'), asst('calling tool'), tool('TOOL RESULT 1')];
    const wire2 = appendTailNote(stored2, note2);

    const stored3 = [...stored2, asst('calling again'), tool('TOOL RESULT 2')];
    const wire3 = appendTailNote(stored3, note3);

    const shared = commonPrefix(wire2, wire3);
    ok('round 3 reuses ALL of round 2\'s stored prefix', shared === stored2.length,
        `shared=${shared}, want ${stored2.length}`);
    ok('round 2\'s tool result is cacheable by round 3',
        JSON.stringify(wire3.slice(0, shared)).includes('TOOL RESULT 1'));
    ok('within-turn shapes keep roles alternating', alternates(wire2) && alternates(wire3));
}

// --- ACROSS turns: a finished turn's tool result must be reusable -----------
{
    const stored2 = [sys('S'), user('turn one'), asst('worked'), tool('TOOL RESULT 1'), user('turn two')];
    const wire2 = appendTailNote(stored2, note2);

    const stored3 = [...stored2, asst('worked again'), tool('TOOL RESULT 2'), user('turn three')];
    const wire3 = appendTailNote(stored3, note3);

    const shared23 = commonPrefix(wire2, wire3);
    // The trailing user turn is the ONE message the note merges into, so it is
    // the only stored message turn 3 cannot reuse - every tool result before it
    // (the large, expensive content) is reused.
    ok('turn 3 reuses turn 2\'s prefix up to the trailing user turn', shared23 === stored2.length - 1,
        `shared=${shared23}, want ${stored2.length - 1}`);
    ok('turn 1\'s tool result is cacheable by turn 3',
        JSON.stringify(wire3.slice(0, shared23)).includes('TOOL RESULT 1'));
    ok('across-turn shapes keep roles alternating', alternates(wire2) && alternates(wire3));
}

// --- a stale note must never leak into the replayed prefix ------------------
{
    const stored = [sys('S'), user('u'), asst('a'), tool('t')];
    const wire = appendTailNote(stored, note1);
    const replayed = wire.slice(0, stored.length);
    ok('no stale note leaks into the replayed prefix', !JSON.stringify(replayed).includes('Context status'));
}

// --- robustness -------------------------------------------------------------
{
    ok('empty input is returned as-is', appendTailNote([], note1).length === 0);
    const base = [sys('S'), user('u')];
    ok('an empty note is a no-op', appendTailNote(base, '').length === base.length);
    const arr = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const merged = appendTailNote(arr, note1);
    ok('array content is merged in place', merged.length === 1
        && merged[0].content.length === 2
        && merged[0].content[1].text.includes('Context status'));
}

// --- PROOF: the old merge truncated the prefix, this does not --------------
// Reproduces the removed implementation so the regression is MEASURED. If this
// comparison ever stops showing a difference, the test has stopped testing.
{
    const oldAppend = (messages, note) => {
        const out = messages.slice();
        const last = out[out.length - 1];
        out[out.length - 1] = { ...last, content: `${last.content}\n\n${note}` };
        return out;
    };

    const stored2 = [sys('S'), user('u1'), asst('a1'), tool('TOOL RESULT 1')];
    const stored3 = [...stored2, asst('a2'), tool('TOOL RESULT 2')];

    const oldP23 = commonPrefix(oldAppend(stored2, note2), oldAppend(stored3, note3));
    const newP23 = commonPrefix(appendTailNote(stored2, note2), appendTailNote(stored3, note3));

    console.log(`\n  cacheable prefix round2->round3: old=${oldP23} new=${newP23} (stored2=${stored2.length})`);
    ok('the old merge fell one message short (regression reproduced)', oldP23 === stored2.length - 1, `old=${oldP23}`);
    ok('the new append reuses the whole previous prefix', newP23 === stored2.length, `new=${newP23}`);
    ok('the fix strictly improves the cacheable prefix', newP23 > oldP23, `old=${oldP23} new=${newP23}`);
    ok('the old shape could not cache the newest tool result (the ~50% cause)',
        !JSON.stringify(oldAppend(stored3, note3).slice(0, oldP23)).includes('TOOL RESULT 1'));
}

console.log(failed === 0 ? '\nall prompt-cache-shape checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

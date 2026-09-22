#!/usr/bin/env node
/**
 * Session task-list tests ("the list IS the plan").
 *
 * `src/taskList.ts` is pure logic shared by the expansion tool executor
 * (xratu_mcp_tools.ts), the host (extension.ts) and the local runtime's
 * trailing reminder - and it had no suite. The reminder is the one thing that
 * keeps a long, post-compaction run on-plan, so its inputs are pinned here.
 *
 * Focus of this suite: `reminderTaskList`. The reminder used to render
 * `request.taskList`, a snapshot captured once when the run started, which
 * stays frozen for the whole run (the loop allows up to 32 rounds). A model
 * that rewrote its plan mid-run therefore never saw its own updates - observed
 * live as the reminder showing a 14-item list while the stored list was 17
 * items with 9 completed. The provider is consulted every round instead.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-task-list.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    TASK_LIST_TOOL_NAME,
    TASK_LIST_MAX_ITEMS,
    TASK_LIST_MAX_LABEL,
    TASK_LIST_STATUSES,
    taskListLabelOf,
    parseTaskListArgs,
    taskListProgress,
    taskListReminderLine,
    reminderTaskList,
} = require('../out/taskList.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};
const t = (label, status = 'pending') => ({ label, status });

// --- constants --------------------------------------------------------------
check('tool name', TASK_LIST_TOOL_NAME, 'update_task_list');
check('three statuses', TASK_LIST_STATUSES.join(','), 'pending,in_progress,completed');
check('100 item cap', TASK_LIST_MAX_ITEMS, 100);

// --- parseTaskListArgs: accepted shapes ------------------------------------
{
    const parsed = parseTaskListArgs({ tasks: [t('a', 'completed'), t('b', 'in_progress'), t('c')] });
    ok('parses a valid list', Array.isArray(parsed) && parsed.length === 3, JSON.stringify(parsed));
    check('keeps statuses', parsed?.[1].status, 'in_progress');
}

{
    const parsed = parseTaskListArgs(JSON.stringify({ tasks: [t('from a json string')] }));
    ok('parses a raw JSON string', Array.isArray(parsed) && parsed.length === 1, JSON.stringify(parsed));
}

{
    // Weak local models emit the wrong label key - all four are accepted.
    for (const key of ['label', 'task', 'content', 'step']) {
        const parsed = parseTaskListArgs({ tasks: [{ [key]: `via ${key}`, status: 'pending' }] });
        check(`label alias "${key}" accepted`, parsed?.[0].label, `via ${key}`);
    }
    check('taskListLabelOf prefers label', taskListLabelOf({ label: 'L', task: 'T' }), 'L');
    check('taskListLabelOf falls through to task', taskListLabelOf({ task: 'T' }), 'T');
    check('taskListLabelOf ignores non-strings', taskListLabelOf({ task: 5 }), undefined);
}

{
    const parsed = parseTaskListArgs({ tasks: [t('  padded  ')] });
    check('trims labels', parsed?.[0].label, 'padded');
    const long = parseTaskListArgs({ tasks: [t('x'.repeat(TASK_LIST_MAX_LABEL + 50))] });
    check('clamps label length', long?.[0].label.length, TASK_LIST_MAX_LABEL);
}

// --- parseTaskListArgs: rejected shapes ------------------------------------
for (const [name, input] of [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['empty tasks array', { tasks: [] }],
    ['tasks not an array', { tasks: 'nope' }],
    ['missing label', { tasks: [{ status: 'pending' }] }],
    ['blank label', { tasks: [{ label: '   ', status: 'pending' }] }],
    ['non-string label', { tasks: [{ label: 7, status: 'pending' }] }],
    ['unknown status', { tasks: [t('a', 'doing')] }],
    ['missing status', { tasks: [{ label: 'a' }] }],
    ['one bad item in a good list', { tasks: [t('good'), { label: 'bad', status: 'nope' }] }],
    ['over the item cap', { tasks: Array.from({ length: TASK_LIST_MAX_ITEMS + 1 }, (_, i) => t(`t${i}`)) }],
    ['malformed JSON string', '{not json'],
    ['non-object', 42],
]) {
    check(`rejects ${name}`, parseTaskListArgs(input), null);
}

// --- taskListProgress ------------------------------------------------------
{
    const p = taskListProgress([t('a', 'completed'), t('b', 'in_progress'), t('c')]);
    check('counts done', p.done, 1);
    check('counts total', p.total, 3);
    check('reports the current item', p.current?.label, 'b');
}
{
    const p = taskListProgress([t('a', 'completed'), t('b', 'completed')]);
    check('no in_progress -> null current', p.current, null);
    check('all done counted', p.done, 2);
}
{
    const p = taskListProgress([]);
    check('empty list -> 0 done', p.done, 0);
    check('empty list -> 0 total', p.total, 0);
    check('empty list -> null current', p.current, null);
}
{
    // First in_progress wins - the list is ordered.
    const p = taskListProgress([t('a', 'in_progress'), t('b', 'in_progress')]);
    check('first in_progress is current', p.current?.label, 'a');
}

// --- taskListReminderLine --------------------------------------------------
check('empty list -> no reminder at all', taskListReminderLine([]), '');

{
    const line = taskListReminderLine([t('first', 'completed'), t('second', 'in_progress'), t('third')]);
    ok('header states progress', line.includes('1/3 done'), line);
    ok('header names the current item', line.includes('current: second'), line);
    ok('marks completed items', line.includes('- [x] first'), line);
    ok('leaves pending items unmarked', line.includes('- [ ] third'), line);
    ok('keeps the guidance for the model', line.includes('update_task_list'), line);
    ok('starts with a blank-line separator', line.startsWith('\n\n'), JSON.stringify(line.slice(0, 4)));
}

// --- reminderTaskList: THE fix --------------------------------------------
{
    const snapshot = [t('snapshot')];
    check('no provider -> snapshot', reminderTaskList({ taskList: snapshot })[0].label, 'snapshot');
    check('no provider, no snapshot -> empty', reminderTaskList({}).length, 0);
}

{
    const live = [t('live')];
    const r = reminderTaskList({ taskList: [t('snapshot')], taskListProvider: () => live });
    check('provider wins over the snapshot', r[0].label, 'live');
}

{
    // The regression: the list the model rewrites mid-run must show up.
    let current = [t('round 1', 'in_progress'), t('round 2')];
    const request = { taskList: [t('frozen snapshot', 'in_progress')], taskListProvider: () => current };
    check('first read sees the run-start list', reminderTaskList(request)[0].label, 'round 1');

    // A mid-run update_task_list write, exactly as the host applies it.
    current = [t('round 1', 'completed'), t('round 2', 'in_progress')];

    const after = reminderTaskList(request);
    check('mid-run write is visible immediately', after[1].status, 'in_progress');
    check('and the completed item is marked done', after[0].status, 'completed');
    const line = taskListReminderLine(after);
    ok('reminder reflects the new progress', line.includes('1/2 done'), line);
    ok('reminder names the NEW current item', line.includes('current: round 2'), line);
}

{
    // A run that STARTS with no list must still pick one up mid-run.
    let current;
    const request = { taskListProvider: () => current };
    check('no list yet -> empty', reminderTaskList(request).length, 0);
    current = [t('created mid-run', 'in_progress')];
    check('list created mid-run is picked up', reminderTaskList(request)[0].label, 'created mid-run');
}

{
    // Provider returning undefined falls back; empty array is a real value.
    check('undefined provider -> snapshot', reminderTaskList({ taskList: [t('s')], taskListProvider: () => undefined })[0].label, 's');
    check('empty provider -> empty (not snapshot)', reminderTaskList({ taskList: [t('s')], taskListProvider: () => [] }).length, 0);
}

{
    // A throwing provider must never take down the run.
    const boom = () => { throw new Error('host callback exploded'); };
    let threw = false;
    let result = null;
    try {
        result = reminderTaskList({ taskList: [t('snapshot')], taskListProvider: boom });
    } catch {
        threw = true;
    }
    ok('throwing provider does not propagate', !threw);
    check('throwing provider degrades to the snapshot', result?.[0].label, 'snapshot');

    let threwNoSnapshot = false;
    try {
        reminderTaskList({ taskListProvider: boom });
    } catch {
        threwNoSnapshot = true;
    }
    ok('throwing provider with no snapshot still survives', !threwNoSnapshot);
}

console.log(failed === 0 ? '\ntask-list tests: all passed' : `\ntask-list tests: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Repro harness: renders MessageItem with the EXACT step sequence the
 * Terminal Game session produced (malformed `task`-key call + valid call,
 * both paired to acks, then a fullResponse) and the App-level taskListView
 * selection logic, via react-dom/server - a render-time infinite loop or
 * thrown exception here matches the user-reported freeze right after the
 * agent's update_task_list calls.
 */

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageItem, parseTaskListStep } from '../src/components/MessageItem';
import type { ChatMessage } from '../src/types';
import { parseTaskListArgs } from '../../src/taskList';

type TaskItem = NonNullable<ReturnType<typeof parseTaskListStep>>[number];

const TASK_ARGS_MALFORMED = JSON.stringify({
    tasks: [{ status: 'pending', task: 'Scaffold project: create game/ package - verify layout' }],
});
const TASK_ARGS_GARBAGE = '{"tasks": "not a list"}';
const TASK_ARGS_OK = JSON.stringify({
    tasks: [
        { label: 'Scaffold project: create game/ package', status: 'pending' },
        { label: 'Implement game/ui.py', status: 'pending' },
    ],
});

function buildMessages(): ChatMessage[] {
    const user: ChatMessage = {
        id: 'u1', role: 'user', text: 'plan the game', steps: [], status: 'done', createdAt: 1,
    };
    const assistant: ChatMessage = {
        id: 'a1', role: 'assistant', text: 'plan', steps: [
            { id: 's1', kind: 'thinking', text: 'thinking…' },
            { id: 's2', kind: 'toolCall', tool: 'list_files', text: '{"path":"."}', result: 'ok' },
            { id: 's3', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_MALFORMED, result: 'Error from VS Code: Error: every task needs a non-empty label…' },
            { id: 's4', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_OK, result: 'Task list updated (2 items, 0 completed, 0 in_progress).' },
        ], status: 'done', createdAt: 2,
    };
    return [user, assistant];
}

function render(
    messages: ChatMessage[],
    taskList?: { stepId: string; tasks: TaskItem[]; editable: boolean; onChange?: (t: TaskItem[]) => void } | null,
): string {
    return renderToString(createElement('div', {},
        messages.map((m) => createElement(MessageItem, {
            key: m.id,
            message: m,
            busy: false,
            activityOnly: true,
            taskList: taskList ?? undefined,
        }))
    ));
}

const messages = buildMessages();

// 1. No task-list view at all (initial render before App memo picks a step)
let html = render(messages);
assert.ok(html.includes('task-list'), 'renders accepted task list without taskList prop');
assert.ok(html.includes('Scaffold project'), 'renders accepted task item labels without taskList prop');

// 2. Interactive checklist bound to the well-formed (second) step
const parsed = parseTaskListStep(TASK_ARGS_OK);
assert.ok(parsed && parsed.length === 2, 'parses well-formed args');
html = render(messages, { stepId: 's4', tasks: parsed, editable: true, onChange: () => {} });
assert.ok(html.includes('task-list'), 'renders interactive checklist');
assert.ok(html.includes('Scaffold project'), 'renders item labels');
assert.ok(html.length < 500_000, 'output size bounded');

// 3. Legacy `task`-key args parse via the alias; truly malformed shapes parse to null.
const malformedParsed = parseTaskListStep(TASK_ARGS_MALFORMED);
assert.ok(malformedParsed && malformedParsed[0].label.includes('Scaffold'), 'legacy `task` key parses');
assert.equal(parseTaskListStep(TASK_ARGS_GARBAGE), null, 'garbage args parse to null');
html = render(messages, { stepId: 's3', tasks: [], editable: true, onChange: () => {} });
assert.ok(html.includes('Scaffold project'), 'still renders accepted s4 checklist when s3 was rejected');
assert.ok(!html.includes('every task needs a non-empty label'), 'rejected s3 error stays hidden');

// 4. Streaming state (no result yet) - read-only live render
const streaming: ChatMessage[] = buildMessages().map((m) =>
    m.id === 'a1' ? { ...m, status: 'streaming' as const, steps: m.steps.map((s) => ({ ...s, result: undefined })) } : m
);
html = render(streaming);
assert.ok(html.includes('Scaffold project'), 'streaming state renders live task items');

// 5. Stress: 100-item list renders (cap parity with the host executor)
const big = JSON.stringify({ tasks: Array.from({ length: 100 }, (_, i) => ({ label: `Step ${i}`, status: i === 5 ? 'in_progress' : i < 5 ? 'completed' : 'pending' })) });
html = render([{ ...messages[0] }, { ...messages[1], steps: [{ id: 's9', kind: 'toolCall', tool: 'update_task_list', text: big, result: 'ok' }] }]);
assert.ok(html.includes('task-list-progress'), 'renders 100-item checklist');
assert.ok(html.includes('Step 99'), 'renders all 100 task items');

// 6. Older well-formed task-list step in a message WITHOUT the interactive prop
const earlier: ChatMessage = {
    id: 'a0', role: 'assistant', text: 'earlier', steps: [
        { id: 's0', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_OK, result: 'Task list updated (2 items, 0 completed).' },
    ], status: 'done', createdAt: 0,
};
html = render([earlier, ...messages]);
assert.ok(html.includes('task-list'), 'well-formed non-bound step renders checklist without crashing');
assert.ok(html.includes('Scaffold project'), 'non-bound earlier list renders read-only from own args');

// 7. Alias tolerance: the model's real-world `task` key (Terminal Game)
const aliasParsed = parseTaskListStep(JSON.stringify({ tasks: [{ status: 'pending', task: 'Do the thing' }] }));
assert.ok(aliasParsed && aliasParsed.length === 1 && aliasParsed[0].label === 'Do the thing', 'alias `task` key accepted');
html = render([{
    id: 'a2', role: 'assistant', text: 'alias', status: 'done', createdAt: 2, steps: [
        { id: 's-alias', kind: 'toolCall', tool: 'update_task_list', text: JSON.stringify({ tasks: [{ status: 'pending', task: 'Do the thing' }] }), result: 'Task list updated (1 item).' },
    ],
}]);
assert.ok(html.includes('Do the thing'), 'alias args render task label');

// 8. Host-side parser parity: string args + alias, via src/taskList.ts
assert.ok(parseTaskListArgs(JSON.stringify({ tasks: [{ task: 'A', status: 'completed' }] })), 'host parser: raw JSON string args');
assert.ok(parseTaskListArgs({ tasks: [{ content: 'B', status: 'pending' }] }), 'host parser: alias keys');
assert.equal(parseTaskListArgs('not json'), null, 'host parser: garbage rejected');

// 9. Parse identity stability: same text yields same array & item object identity
{
    const text = JSON.stringify({
        tasks: [
            { label: 'One', status: 'completed' },
            { label: 'Two', status: 'pending' },
        ],
    });
    const a = parseTaskListStep(text);
    const b = parseTaskListStep(text);
    assert.ok(a !== null && b !== null, 'parse identity: both parses succeed');
    assert.strictEqual(a, b, 'parse identity: same text returns the same array');
    assert.ok(a[0] === b[0] && a[1] === b[1], 'parse identity: items keep object identity');
    const other = parseTaskListStep(JSON.stringify({ tasks: [{ label: 'Three', status: 'pending' }] }));
    assert.ok(other !== null && other !== a, 'parse identity: different text is a different array');
}

// 10. A FAILED update is invisible; accepted update renders its checklist.
{
    const failedOnly: ChatMessage[] = [{
        id: 'f1', role: 'assistant', text: 'x', status: 'done', createdAt: 3, steps: [
            { id: 'f2', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_OK, result: 'Error: tasks must be a non-empty array' },
        ],
    }];
    const failedHtml = render(failedOnly);
    assert.ok(!failedHtml.includes('Scaffold project'), 'a failed update shows no rejected list');
    assert.ok(!failedHtml.includes('non-empty array'), 'a failed update shows no error text');
    assert.ok(!failedHtml.includes('task-list'), 'a failed update renders no checklist');
    assert.ok(!failedHtml.includes('step-status err'), 'a failed update paints no failure pill');

    const garbageFailed = render([{
        id: 'f3', role: 'assistant', text: 'x', status: 'done', createdAt: 4, steps: [
            { id: 'f4', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_GARBAGE, result: 'Error: task[0] needs a label' },
        ],
    }]);
    assert.ok(!garbageFailed.includes('task-list') && !garbageFailed.includes('step-status err'),
        'an unparseable + failed update is hidden too');

    const accepted = render([{
        id: 'f5', role: 'assistant', text: 'x', status: 'done', createdAt: 5, steps: [
            { id: 'f6', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_OK, result: 'Task list updated (2 items).' },
        ],
    }]);
    assert.ok(accepted.includes('task-list') && accepted.includes('Scaffold project'),
        'an accepted update still renders its checklist');
}

console.log('tasklist-render: all assertions passed');

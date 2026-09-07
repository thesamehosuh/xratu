/**
 * Repro harness: renders MessageItem with the EXACT step sequence the
 * Terminal Game session produced (malformed `task`-key call + valid call,
 * both paired to acks, then a fullResponse) and the App-level taskListView
 * selection logic, via react-dom/server - a render-time infinite loop or
 * thrown exception here matches the user-reported freeze right after the
 * agent's update_task_list calls.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageItem, TASK_LIST_TOOL, parseTaskListStep } from '../src/components/MessageItem';
import type { ChatMessage } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else { fail++; console.error('  FAIL:', name); }
}

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

function render(messages: ChatMessage[], taskList?: { stepId: string; tasks: any[]; editable: boolean; onChange?: (t: any[]) => void } | null): string {
    return renderToString(createElement('div', {},
        messages.map((m) => createElement(MessageItem, {
            key: m.id,
            message: m,
            busy: false,
            taskList: taskList ?? undefined,
        }))
    ));
}

const messages = buildMessages();

// 1. No task-list view at all (initial render before App memo picks a step)
let html = render(messages);
ok(html.includes('step') || html.length > 0, 'renders without taskList prop');

// 2. Interactive checklist bound to the well-formed (second) step
const parsed = parseTaskListStep(TASK_ARGS_OK);
ok(!!parsed && parsed.length === 2, 'parses well-formed args');
html = render(messages, { stepId: 's4', tasks: parsed!, editable: true, onChange: () => {} });
ok(html.includes('task-list'), 'renders interactive checklist');
ok(html.includes('Scaffold project'), 'renders item labels');
ok(html.length < 500_000, 'output size bounded');

// 3. Legacy `task`-key args (the Terminal Game payload) now parse via the
//    alias; truly malformed shapes still fall back to the plain pill.
const malformedParsed = parseTaskListStep(TASK_ARGS_MALFORMED);
ok(!!malformedParsed && malformedParsed[0].label.includes('Scaffold'), 'legacy `task` key parses');
ok(parseTaskListStep(TASK_ARGS_GARBAGE) === null, 'garbage args parse to null');
html = render(messages, { stepId: 's3', tasks: [], editable: true, onChange: () => {} });
ok(html.length > 0, 'renders with malformed current step');

// 4. Streaming state (no result yet) - read-only live render
const streaming: ChatMessage[] = buildMessages().map((m) =>
    m.id === 'a1' ? { ...m, status: 'streaming' as const, steps: m.steps.map((s) => ({ ...s, result: undefined })) } : m
);
html = render(streaming);
ok(html.length > 0, 'renders streaming state');

// 5. Stress: 100-item list renders (cap parity with the host executor)
const big = JSON.stringify({ tasks: Array.from({ length: 100 }, (_, i) => ({ label: `Step ${i}`, status: i === 5 ? 'in_progress' : i < 5 ? 'completed' : 'pending' })) });
html = render([{ ...messages[0] }, { ...messages[1], steps: [{ id: 's9', kind: 'toolCall', tool: 'update_task_list', text: big, result: 'ok' }] }]);
ok(html.includes('task-list-progress'), 'renders 100-item checklist');

// 6. THE CRASH: an OLDER well-formed task-list step in a message WITHOUT the
//    interactive prop (previous turn's checklist / non-bound message) - used
//    to hit `view!.onChange` and kill the webview.
const earlier: ChatMessage = {
    id: 'a0', role: 'assistant', text: 'earlier', steps: [
        { id: 's0', kind: 'toolCall', tool: 'update_task_list', text: TASK_ARGS_OK, result: 'Task list updated (2 items, 0 completed).' },
    ], status: 'done', createdAt: 0,
};
html = render([earlier, ...messages]); // no taskList prop anywhere
ok(html.length > 0, 'well-formed non-bound step renders read-only without crashing');
ok(html.includes('Scaffold project'), 'non-bound earlier list renders read-only from own args');

// 7. Alias tolerance: the model's real-world `task` key (Terminal Game)
const aliasParsed = parseTaskListStep(JSON.stringify({ tasks: [{ status: 'pending', task: 'Do the thing' }] }));
ok(!!aliasParsed && aliasParsed.length === 1 && aliasParsed[0].label === 'Do the thing', 'alias `task` key accepted');
html = render([earlier, ...messages].map((m) => m.id === 'a1'
    ? { ...m, steps: m.steps.map((s) => s.id === 's3' ? { ...s, text: JSON.stringify({ tasks: [{ status: 'pending', task: 'Do the thing' }] }) } : s) }
    : m));
ok(html.length > 0, 'alias args render');

// 8. Host-side parser parity: string args + alias, via extension/src/taskList.ts
import { parseTaskListArgs } from '../../src/taskList';
ok(!!parseTaskListArgs(JSON.stringify({ tasks: [{ task: 'A', status: 'completed' }] })), 'host parser: raw JSON string args');
ok(!!parseTaskListArgs({ tasks: [{ content: 'B', status: 'pending' }] }), 'host parser: alias keys');
ok(parseTaskListArgs('not json') === null, 'host parser: garbage rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
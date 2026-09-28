/**
 * Tool pill grouping + subagent pill summary:
 *  - consecutive spam tools (reads/searches) collapse into one grouped pill,
 *    but terminal and SUBAGENT runs never group (each run is its own
 *    top-level pill - no nested run pills);
 *  - the closed subagent pill is TWO rows: the summary (label + delegated
 *    task brief, NO profile name) and a grey elbow row under the icon with
 *    the LATEST live tool call (one at a time) or - once done - the number
 *    of tool calls the run made (parsed from the task_id note).
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageList } from '../src/components/MessageList';
import type { ChatMessage, Step } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else { fail++; console.error('  FAIL:', name); }
}

function messageWith(steps: Step[], status: 'streaming' | 'done' = 'done'): ChatMessage[] {
    return [{
        id: 'm1',
        role: 'assistant' as const,
        text: 'done',
        steps,
        status,
        createdAt: 0,
    }];
}

function render(messages: ChatMessage[]): string {
    return renderToString(createElement(MessageList, {
        messages,
        onScroll: () => {},
        onPickSuggestion: () => {},
        firstVisible: 0,
    }));
}

const taskStep = (id: string, desc: string, extra?: Partial<Step>): Step => ({
    id,
    kind: 'toolCall',
    tool: 'task',
    text: JSON.stringify({ description: desc, prompt: `prompt for ${desc}`, subagent_type: 'explore' }),
    callId: id,
    result: `report for ${desc}\n\n[task_id: ${id}pad1234 · 2 tool calls]`,
    ...extra,
});

// Two consecutive subagent runs: two top-level pills, never a nested group.
let html = render(messageWith([taskStep('a', 'find foo'), taskStep('b', 'find bar')]));
ok(!html.includes('step-group-body'), 'subagent runs do not group (no nested pill body)');
ok(html.includes('report for find foo') && html.includes('report for find bar'),
    'both subagent runs render their own report');
ok(html.includes('find foo'), 'collapsed summary carries the delegated task brief');
ok(!html.includes('explore ·'), 'collapsed summary does NOT show the agent profile');
ok(html.includes('sum-sub'), 'closed pill has the second (elbow) row');
const countRow = /class="sum-live" dir="auto">([^<]+)</.exec(html)?.[1] ?? '';
ok(/^2\b/.test(countRow), `done row shows the localized tool-call count from the note (${countRow})`);

// Running: the elbow row shows the LATEST live tool call (one at a time).
html = render(messageWith([
    taskStep('c', 'find foo', {
        result: undefined,
        live: '▶ explore\n↳ grep_search foo\n✓ 3 matches\n↳ read_file src/x.ts\n',
    }),
], 'streaming'));
const subRow = /class="sum-sub"[\s\S]*?class="sum-live" dir="ltr">([^<]*)</.exec(html)?.[1] ?? '';
ok(subRow.includes('read_file src/x.ts'), `elbow row shows the latest live tool call (readable) (${subRow})`);
ok(!subRow.includes('grep_search'), `elbow row does not stack earlier tool calls (${subRow})`);

// Positive control: consecutive search calls still collapse into a group.
const grepStep = (id: string): Step => ({
    id,
    kind: 'toolCall',
    tool: 'grep_search',
    text: JSON.stringify({ pattern: 'x' }),
    callId: id,
    result: 'match',
});
html = render(messageWith([grepStep('g1'), grepStep('g2')]));
ok(html.includes('step-group-body'), 'spam tools still group');

// Positive control: terminal runs also stay ungrouped.
const termStep = (id: string, cmd: string): Step => ({
    id,
    kind: 'toolCall',
    tool: 'run_terminal_command',
    text: JSON.stringify({ command: cmd }),
    callId: id,
    result: 'ok',
});
html = render(messageWith([termStep('t1', 'ls'), termStep('t2', 'ls')]));
ok(!html.includes('step-group-body'), 'terminal runs do not group');

console.log(fail === 0 ? `tool-pill-grouping: ${pass} checks passed` : `tool-pill-grouping: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);

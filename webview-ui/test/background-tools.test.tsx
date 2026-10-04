/**
 * Background-process affordances in the transcript:
 *  - a RUNNING terminal call offers "run in background", because that call is
 *    holding the whole turn and there is otherwise no way out of it;
 *  - a call that is already backgrounded swaps that button for a stop, so the
 *    same handoff can never be triggered twice and a job always has an exit;
 *  - a finished call offers neither - the command is gone;
 *  - the `process` tool does NOT offer either: it is not a terminal command.
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

function render(steps: Step[], status: 'streaming' | 'done' = 'streaming'): string {
    const messages: ChatMessage[] = [{
        id: 'm1',
        role: 'assistant' as const,
        text: '',
        steps,
        status,
        createdAt: 0,
    }];
    return renderToString(createElement(MessageList, {
        messages,
        onScroll: () => {},
        onPickSuggestion: () => {},
        firstVisible: 0,
    }));
}

const terminalStep = (extra?: Partial<Step>): Step => ({
    id: 's1',
    kind: 'toolCall',
    tool: 'run_terminal_command',
    text: JSON.stringify({ command: 'npm run dev' }),
    callId: 'call-1',
    ...extra,
});

/** The aria-labels the host reads back out of the rendered markup. */
const labels = (html: string): string[] =>
    [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1] ?? '');

const bgButton = (html: string) => labels(html).some((l) => l.includes('پس زمینه') || /background/i.test(l));
const stopButton = (html: string) => labels(html).some((l) => l.includes('متوقف') || /^stop$/i.test(l));

// A streaming terminal call with no result is exactly the state that holds the
// turn hostage.
{
    const html = render([terminalStep()]);
    ok('a running terminal call offers "run in background"', bgButton(html));
    ok('a running terminal call does not yet offer stop', !stopButton(html));
}

{
    const html = render([terminalStep({ background: { jobId: 'job-7', byUser: true } })]);
    ok('a backgrounded call no longer offers the handoff', !bgButton(html));
    ok('a backgrounded call offers stop instead', stopButton(html));
}

{
    const html = render([terminalStep({ result: 'OUTPUT:\nok' })], 'done');
    ok('a finished terminal call offers neither', !bgButton(html) && !stopButton(html));
}

// `process` rows are not terminal commands: they must not grow a handoff
// button, or the user could "background" a poll.
{
    const processStep: Step = {
        id: 's2',
        kind: 'toolCall',
        tool: 'process',
        text: JSON.stringify({ action: 'list' }),
        callId: 'call-2',
    };
    const html = render([processStep]);
    ok('a process tool row offers no handoff and no stop', !bgButton(html) && !stopButton(html));
}

// A non-terminal tool must never grow the button either.
{
    const readStep: Step = {
        id: 's3',
        kind: 'toolCall',
        tool: 'read_file',
        text: JSON.stringify({ path: 'a.ts' }),
        callId: 'call-3',
    };
    ok('a read_file row offers no handoff', !bgButton(render([readStep])));
}

console.log(`${pass} checks passed, ${fail} failed`);
if (fail) process.exit(1);
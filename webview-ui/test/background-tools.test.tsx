/**
 * Background-process affordances in the transcript:
 *  - a RUNNING terminal call offers "run in background" when the host callback
 *    is wired, because that call is holding the whole turn;
 *  - a call that is already backgrounded swaps that button for a stop button,
 *    so the same handoff can never be triggered twice and a job always has an exit;
 *  - a finished call offers neither - the command is gone;
 *  - the `process` tool and non-terminal tools do NOT offer either;
 *  - without host callbacks wired, neither button renders.
 */

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageList } from '../src/components/MessageList';
import type { ChatMessage, Step } from '../src/types';

function render(
    steps: Step[],
    status: 'streaming' | 'done' = 'streaming',
    opts: { withCallbacks?: boolean } = {},
): string {
    const withCallbacks = opts.withCallbacks ?? true;
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
        ...(withCallbacks ? {
            onBackgroundTerminal: () => {},
            onKillBackground: () => {},
        } : {}),
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

const labels = (html: string): string[] =>
    [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1] ?? '');

const bgButton = (html: string) => labels(html).some((l) => l.includes('پس زمینه') || /background/i.test(l));
const stopButton = (html: string) => labels(html).some((l) => l.includes('متوقف') || /^stop$/i.test(l));

// 1. Running terminal call offers handoff, not stop yet.
{
    const html = render([terminalStep()]);
    assert.equal(bgButton(html), true, 'a running terminal call offers "run in background"');
    assert.equal(stopButton(html), false, 'a running terminal call does not yet offer stop');
}

// 2. Without host callbacks, neither control renders.
{
    const html = render([terminalStep()], 'streaming', { withCallbacks: false });
    assert.equal(bgButton(html), false, 'running terminal without onBackgroundTerminal renders no handoff button');
    const bgHtml = render([terminalStep({ background: { jobId: 'job-7', byUser: true } })], 'streaming', { withCallbacks: false });
    assert.equal(stopButton(bgHtml), false, 'backgrounded terminal without onKillBackground renders no stop button');
}

// 3. Backgrounded call swaps handoff for stop.
{
    const html = render([terminalStep({ background: { jobId: 'job-7', byUser: true } })]);
    assert.equal(bgButton(html), false, 'a backgrounded call no longer offers the handoff');
    assert.equal(stopButton(html), true, 'a backgrounded call offers stop instead');
}

// 4. Finished terminal call offers neither.
{
    const html = render([terminalStep({ result: 'OUTPUT:\nok' })], 'done');
    assert.equal(bgButton(html), false, 'a finished terminal call offers no handoff');
    assert.equal(stopButton(html), false, 'a finished terminal call offers no stop');
}

// 5. `process` tool rows are not terminal commands: never offer handoff or stop.
{
    const processStep: Step = {
        id: 's2',
        kind: 'toolCall',
        tool: 'process',
        text: JSON.stringify({ action: 'list' }),
        callId: 'call-2',
    };
    const html = render([processStep]);
    assert.equal(bgButton(html), false, 'a process tool row offers no handoff');
    assert.equal(stopButton(html), false, 'a process tool row offers no stop');
}

// 6. Non-terminal tool rows never offer handoff or stop.
{
    const readStep: Step = {
        id: 's3',
        kind: 'toolCall',
        tool: 'read_file',
        text: JSON.stringify({ path: 'a.ts' }),
        callId: 'call-3',
    };
    const html = render([readStep]);
    assert.equal(bgButton(html), false, 'a read_file row offers no handoff');
    assert.equal(stopButton(html), false, 'a read_file row offers no stop');
}

console.log('background-tools: all assertions passed');

/**
 * Paged message window: MessageList must mount only the trailing window of a
 * long transcript (the host keeps the transcript complete; only the DOM is
 * bounded) while keeping indices absolute and offering a "show earlier"
 * control when older bubbles are hidden.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageList } from '../src/components/MessageList';
import type { ChatMessage } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else { fail++; console.error('  FAIL:', name); }
}

function buildMessages(n: number): ChatMessage[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        text: `ZZ${i}ZZ`,
        steps: [],
        status: 'done' as const,
        createdAt: i,
    }));
}

function render(messages: ChatMessage[], firstVisible: number, onShowEarlier?: () => void): string {
    return renderToString(createElement(MessageList, {
        messages,
        onScroll: () => {},
        onPickSuggestion: () => {},
        firstVisible,
        onShowEarlier,
    }));
}

const messages = buildMessages(60);

// 1. Unwindowed: the whole transcript mounts, no control.
let html = render(messages, 0);
ok(html.includes('ZZ0ZZ'), 'firstVisible=0 renders the oldest bubble');
ok(html.includes('ZZ59ZZ'), 'firstVisible=0 renders the newest bubble');
ok(!html.includes('show-earlier'), 'no show-earlier control when nothing is hidden');

// 2. Windowed: only the tail mounts.
html = render(messages, 20);
ok(html.includes('ZZ20ZZ'), 'window starts at firstVisible');
ok(html.includes('ZZ59ZZ'), 'window always includes the newest bubble');
ok(!html.includes('ZZ19ZZ'), 'bubbles before firstVisible are not mounted');
ok(html.includes('show-earlier'), 'show-earlier control appears when bubbles are hidden');

// 3. A transcript shorter than the window renders fully.
html = render(buildMessages(5), 0);
ok(html.includes('ZZ4ZZ'), 'short transcript renders fully');
ok(!html.includes('show-earlier'), 'short transcript shows no control');

// 4. An out-of-range firstVisible clamps to the tail (never renders nothing).
html = render(buildMessages(5), 99);
ok(html.includes('ZZ4ZZ'), 'over-large firstVisible clamps to the newest bubble');

// 5. The control is wired to the handler.
let clicks = 0;
html = render(messages, 20, () => { clicks++; });
ok(html.includes('show-earlier'), 'control rendered with a handler');
ok(clicks === 0, 'handler is not invoked during render');

if (fail) {
    console.error(`\n${fail} check(s) failed`);
    process.exit(1);
}
console.log(`message-list paging: ${pass} checks passed`);

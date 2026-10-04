/**
 * Transcript display prefs - the Settings page's auto-expand switches
 * (diffs / commands / reasoning).
 *
 * Two things are pinned here:
 *  1. `prefOn` resolution - a stored flag wins, otherwise the row's own
 *     default, otherwise collapsed. The empty blob must therefore resolve to
 *     "diffs open, commands closed, reasoning closed" with no host
 *     round-trip, and a family with no row must never open itself.
 *  2. What the transcript actually does with it - every pill, including the
 *     reasoning one, seeded from its family's switch.
 *
 * `useAutoOpen`'s manual-toggle protection is NOT covered here: it is a
 * post-mount effect, and this harness only server-renders the first paint.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MessageList } from '../src/components/MessageList';
import {
    coerceTranscriptPrefs, prefOn, toolFamily, TRANSCRIPT_ROWS,
    EMPTY_TRANSCRIPT_PREFS, type TranscriptPrefs,
} from '../src/transcriptPrefs';
import type { ChatMessage, Step } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else { fail++; console.error('  FAIL:', name); }
}
function eq(actual: unknown, expected: unknown, name: string): void {
    ok(JSON.stringify(actual) === JSON.stringify(expected),
        `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- prefOn: stored flag, then row default, then collapsed ----------------

eq(prefOn(undefined, 'edit'), true, 'no prefs at all: diffs still auto-expand');
eq(prefOn(undefined, 'terminal'), false, 'no prefs at all: commands stay collapsed');
eq(prefOn(undefined, 'thinking'), false, 'no prefs at all: reasoning stays collapsed');
eq(prefOn(EMPTY_TRANSCRIPT_PREFS, 'read'), false, 'a family with no row never auto-expands');

const stored: TranscriptPrefs = { expand: { edit: false, terminal: true, thinking: true } };
eq(prefOn(stored, 'edit'), false, 'a stored false overrides the row default');
eq(prefOn(stored, 'terminal'), true, 'a stored true overrides the row default');
eq(prefOn(stored, 'thinking'), true, 'reasoning can be switched on');
eq(prefOn(stored, 'read'), false, 'an untouched id stays collapsed');

// --- coercion: the blob is host-persisted JSON, never trust the shape ------

eq(coerceTranscriptPrefs(undefined), EMPTY_TRANSCRIPT_PREFS, 'missing blob → defaults');
eq(coerceTranscriptPrefs('nope'), EMPTY_TRANSCRIPT_PREFS, 'non-object blob → defaults');
eq(coerceTranscriptPrefs([1, 2]), EMPTY_TRANSCRIPT_PREFS, 'array blob → defaults');
eq(coerceTranscriptPrefs({ expand: null }), EMPTY_TRANSCRIPT_PREFS, 'a null map → defaults');
eq(coerceTranscriptPrefs({ expand: { edit: 'yes' } }), EMPTY_TRANSCRIPT_PREFS,
    'a non-boolean value is dropped');

// --- the row schema is what the Settings card renders ---------------------

eq(TRANSCRIPT_ROWS.map((r) => r.id), ['edit', 'terminal', 'thinking'],
    'the shipped rows, in display order');
eq(TRANSCRIPT_ROWS.map((r) => r.defaultOn), [true, false, false], 'shipped defaults');
ok(TRANSCRIPT_ROWS.every((r) => r.labelKey && r.descKey), 'every row names both i18n keys');
ok(new Set(TRANSCRIPT_ROWS.map((r) => r.id)).size === TRANSCRIPT_ROWS.length, 'row ids are unique');

// --- the transcript honors them ------------------------------------------

const diffStep: Step = {
    id: 'p1',
    kind: 'toolCall',
    tool: 'apply_patch',
    text: JSON.stringify({ path: 'src/a.ts', patch: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' }),
    callId: 'p1',
    result: 'done',
};
const termStep: Step = {
    id: 't1',
    kind: 'toolCall',
    tool: 'run_terminal_command',
    text: JSON.stringify({ command: 'npm-test-marker' }),
    callId: 't1',
    result: 'STDOUT:\nall good\nExit code: 0',
};
const thinkStep: Step = { id: 'k1', kind: 'thinking', text: 'reasoning-marker' };

function render(prefs?: TranscriptPrefs): string {
    const messages: ChatMessage[] = [{
        id: 'm1',
        role: 'assistant' as const,
        text: 'done',
        steps: [thinkStep, diffStep, termStep],
        status: 'done',
        createdAt: 0,
    }];
    return renderToString(createElement(MessageList, {
        messages,
        onScroll: () => {},
        onPickSuggestion: () => {},
        firstVisible: 0,
        transcriptPrefs: prefs,
    }));
}

const openCount = (html: string): number => (html.match(/<details[^>]*\sopen=""/g) ?? []).length;

/** Is the pill that CONTAINS `marker` expanded? (SSR renders a closed pill's
 *  body too - the browser is what hides it - so only the tag can say.) */
function pillOpenFor(html: string, marker: string): boolean | null {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.lastIndexOf('<details', at);
    if (start < 0) return null;
    return /\sopen=""/.test(html.slice(start, html.indexOf('>', start)));
}

// Defaults: the diff opens on its own; the command and the reasoning do not.
let html = render();
eq(openCount(html), 1, 'defaults: exactly one pill starts expanded');
eq(pillOpenFor(html, 'src/a.ts'), true, 'defaults: the diff pill starts expanded');
eq(pillOpenFor(html, 'npm-test-marker'), false, 'defaults: the command pill starts collapsed');
eq(pillOpenFor(html, 'reasoning-marker'), false, 'defaults: the reasoning pill starts collapsed');
ok(html.includes('pill-diff-line'), 'defaults: the diff body renders');
ok(html.includes('term-out'), 'defaults: the command output body renders');

// Switching a family off closes the already-rendered pill (the switch is not a
// mount-time-only seed).
html = render({ expand: { edit: false } });
eq(openCount(html), 0, 'auto-expand off: nothing starts expanded');
ok(html.includes('pill-diff-line'), 'auto-expand off: the diff is still there, just closed');

// Switching the reasoning on expands it like any other pill.
html = render({ expand: { thinking: true } });
eq(pillOpenFor(html, 'reasoning-marker'), true, 'reasoning on: the reasoning pill starts expanded');
eq(pillOpenFor(html, 'npm-test-marker'), false, 'reasoning on: other pills are unaffected');
eq(openCount(html), 2, 'reasoning on: the diff and the reasoning pill are open');

// A switch never removes a row - it only decides how it starts.
html = render({ expand: { terminal: true } });
eq(openCount(html), 2, 'commands on: the command pill starts expanded');
ok(html.includes('reasoning-marker'), 'a switch is expansion only: reasoning still renders');
ok(html.includes('npm-test-marker'), 'a switch is expansion only: the command still renders');

// Every family in the shipped rows resolves through the same code path.
html = render({ expand: { edit: true } });
eq(openCount(html), 1, 'edit on: only the diff (its default)');
html = render({ expand: { edit: false, terminal: true } });
eq(openCount(html), 1, 'commands on with diffs off: only the command pill');

// --- the classifier still routes the families the switches are named for ---

eq(toolFamily('apply_patch'), 'edit', 'diff tools route to edit');
eq(toolFamily('run_terminal_command'), 'terminal', 'command tools route to terminal');
eq(toolFamily('mcp__github__create_issue'), 'mcp', 'external tools keep their own family');
eq(toolFamily(undefined), 'generic', 'an unknown tool falls back');

console.log(fail === 0 ? `transcript-prefs: ${pass} checks passed` : `transcript-prefs: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
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
import { ActivityTimeline } from '../src/components/MessageItem';
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
    return renderToString(createElement(ActivityTimeline, {
        messages,
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
ok(html.includes('detail-terminal') && html.includes('all good'), 'defaults: the command output body renders');

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
eq(toolFamily('create_file'), 'edit', 'whole-file writers route to edit too');
eq(toolFamily('run_terminal_command'), 'terminal', 'command tools route to terminal');
eq(toolFamily('mcp__github__create_issue'), 'mcp', 'external tools keep their own family');
eq(toolFamily(undefined), 'generic', 'an unknown tool falls back');

// --- a whole-file writer renders on the EDIT surface ---------------------
//
// create_file/write_file carry new_content, not a patch. Their body used to
// fall through to the generic ArgView dump - a bare monospace <pre>, which is
// exactly how a terminal command pill looks. They must render the same diff
// surface as apply_patch (path header + one row per line), minus the green/red
// tint because there is no before-state to diff against.

const createStep: Step = {
    id: 'w1',
    kind: 'toolCall',
    tool: 'create_file',
    text: JSON.stringify({ path: 'src/new.ts', new_content: 'const a = 1;\nconst b = 2;' }),
    callId: 'w1',
    result: 'created',
};

function renderStep(step: Step): string {
    const messages: ChatMessage[] = [{
        id: 'm1',
        role: 'assistant' as const,
        text: 'done',
        steps: [step],
        status: 'done',
        createdAt: 0,
    }];
    return renderToString(createElement(ActivityTimeline, {
        messages,
        firstVisible: 0,
    }));
}

/** The pill's icon <svg> as markup - the only way to tell which glyph a
 *  TOOL_ICONS entry picked, since they are all inline SVGs. */
const iconMarkup = (html: string): string =>
    /<svg[^>]*step-icon[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';

const createHtml = renderStep(createStep);
ok(createHtml.includes('src/new.ts') && createHtml.includes('edit-file-path'),
    'a create pill renders the same path header a patch pill does');
eq((createHtml.match(/pill-diff-line/g) ?? []).length, 2,
    'a create pill renders one diff row per written line');
ok(!createHtml.includes('pill-diff-line add') && !createHtml.includes('pill-diff-line del'),
    'a create pill tints nothing - there is no before-state to diff against');
ok(!createHtml.includes('arg-view'),
    'a create pill never falls back to the raw argument dump');

eq(iconMarkup(createHtml), iconMarkup(renderStep(diffStep)),
    'a create pill wears the same icon as the other edit tools');
ok(iconMarkup(createHtml) !== iconMarkup(renderStep(termStep)),
    'and not the generic fallback the command pill-adjacent tools get');

// --- a tool pill never carries a success tick ------------------------------
//
// The exit code IS the verdict, and it colors itself red for a non-zero exit.
// A green tick beside "exit code 1" read as success - and worse, a non-zero
// exit never trips `toolRowFailed` (the result text starts with "Command:"),
// so that tick was UNCONDITIONAL: every finished command showed one whatever
// happened. Success is not marked at all now (the finished body, the chevron
// and the stats already say it), and failure keeps its X.

const exitHtml = (code: number): string => renderStep({
    id: 't2',
    kind: 'toolCall',
    tool: 'run_terminal_command',
    text: JSON.stringify({ command: 'npm test' }),
    callId: 't2',
    result: `STDOUT:\nall good\nExit code: ${code}`,
});

/** The pill's own status readout text (locale-formatted label + value).
 *  React SSR splits adjacent text nodes with `<!-- -->` markers, so they are
 *  stripped before reading the text. */
const statText = (html: string): string =>
    (/class="step-stat[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();

// Neither a passing nor a failing exit wears a tick any more; the non-zero
// code colors its own readout.
ok(!exitHtml(0).includes('step-status'),
    'exit code 0 shows no tick at all');
ok(exitHtml(0).includes('step-stat ok') && statText(exitHtml(0)).endsWith('0'),
    'and its readout stays green with the code');
ok(!exitHtml(1).includes('step-status'),
    'a non-zero exit shows no tick beside it either');
ok(exitHtml(1).includes('step-stat d') && statText(exitHtml(1)).endsWith('1'),
    'a non-zero exit tints its own readout and keeps the code');
// No exit code in the output at all -> still nothing. The tick meant nothing
// here either; the row is simply finished.
ok(!renderStep({ ...termStep, result: 'STDOUT:\nkilled' }).includes('step-status'),
    'a command with no parsable exit code gets no tick');

// The X survives: a tool that DID fail is still marked.
const failHtml = renderStep({
    id: 't3',
    kind: 'toolCall',
    tool: 'run_terminal_command',
    text: JSON.stringify({ command: 'npm test' }),
    callId: 't3',
    result: 'Error: command failed',
});
ok(failHtml.includes('step-status err') && !failHtml.includes('step-status ok'),
    'a failing command pill keeps its X and gains no tick');
// The same holds for a read: success is unmarked, failure keeps the X.
ok(!renderStep({ ...termStep, id: 'r1', callId: 'r1', tool: 'read_file',
    text: JSON.stringify({ path: 'a.ts' }), result: 'contents' }).includes('step-status'),
    'a successful read pill is unmarked too');

console.log(fail === 0 ? `transcript-prefs: ${pass} checks passed` : `transcript-prefs: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { strict as assert } from 'node:assert';
import { ActivityTimeline, MessageItem } from '../src/components/MessageItem';
import { conversationPrefs, transcriptOptions } from '../src/transcriptPrefs';
import { setLocale } from '../src/i18n';
import type { ChatMessage, Step } from '../src/types';

setLocale('en');
const call = (id: string, tool: string, extra: Partial<Step> = {}): Step => ({ id, kind: 'toolCall', tool, text: JSON.stringify({ path: `${id}.ts`, command: id, pattern: id }), result: `${id} result`, ...extra });
const text = (id: string): Step => ({ id, kind: 'text', text: id, html: `<p>${id}</p>` });
const thought: Step = { id: 'thought', kind: 'thinking', text: 'private-reasoning-marker' };
const steps = [call('read-a', 'read_file'), thought, call('search', 'grep_search'), call('read-b', 'read_file'), text('progress-marker'), call('edit-a', 'apply_patch'), call('edit-b', 'replace_in_file'), call('npm test', 'run_terminal_command', { result: undefined })];
const message: ChatMessage = { id: 'turn', role: 'assistant', status: 'streaming', text: '', steps, createdAt: 0 };
const render = (extra = {}, value = message) => renderToString(createElement(MessageItem, { message: value, ...extra }));
const groups = (html: string) => (html.match(/class="step conversation-work-group/g) ?? []).length;
const original = JSON.stringify(message);

const balanced = render();
assert.equal(groups(balanced), 2, 'mixed exploration and edits each form one group');
assert.match(balanced, /Explored/);
assert.match(balanced, /2 reads/);
assert.match(balanced, /1 search/);
assert.doesNotMatch(balanced, /private-reasoning-marker/);
assert.match(balanced, /npm test/);
assert.equal(JSON.stringify(message), original, 'display projection leaves recorded steps untouched');

const expandedReasoning = render({ transcriptPrefs: { expand: {}, options: { reasoning: 'expanded' } } });
const expandedGroups = [...expandedReasoning.matchAll(/<details class="step conversation-work-group[^>]*>/g)].map(match => match[0]);
assert.equal(expandedGroups.length, 2);
assert.match(expandedGroups[0], /open=""/, 'thinking opens its containing exploration group');
assert.doesNotMatch(expandedGroups[1], /open=""/, 'thinking does not expand an unrelated edit group');
const editsExpanded = render({ transcriptPrefs: { expand: { edit: true } } });
assert.match(editsExpanded, /<details class="step conversation-work-group" open="">/, 'edit preference still expands edit groups');

const activity = renderToString(createElement(ActivityTimeline, { messages: [message] }));
assert.match(activity, /private-reasoning-marker/);
assert.match(activity, /progress-marker/);
assert.equal(groups(activity), 0, 'Activity keeps the complete recorded trace');
assert.doesNotMatch(balanced, /View in Activity/);
assert.match(activity, /read-b result/);

const detailed = render({ transcriptPrefs: { expand: {}, options: { detail: 'detailed' } } });
assert.equal(groups(detailed), 0);
assert.match(detailed, /private-reasoning-marker/);
const minimal = render({ transcriptPrefs: { expand: {}, options: { detail: 'minimal' } } }, { ...message, steps: [text('old-progress'), ...steps] });
assert.doesNotMatch(minimal, /old-progress/);
assert.match(minimal, /progress-marker/);
assert.match(minimal, /npm test/);
assert.equal(groups(minimal), 2, 'prose remains a grouping boundary even when hidden');

const separated = render({}, { ...message, steps: [steps[0], text('boundary'), steps[2]] });
assert.equal(groups(separated), 2);
const failed = call('failed-command', 'run_terminal_command', { result: 'STDOUT:\nfailed\nExit code: 1' });
const exceptional = render({ transcriptPrefs: { expand: {}, options: { detail: 'minimal' } } }, { ...message, steps: [steps[0], failed, call('background', 'run_terminal_command', { background: { jobId: 'job', byUser: true } }), call('child', 'task'), call('interrupted', 'read_file', { interrupted: true })] });
assert.equal(groups(exceptional), 1, 'failures, processes, children and interrupted calls stay outside groups');
assert.match(exceptional, /class="step fail" open=""/);

const completed = { ...message, status: 'done' as const, steps: [...steps, text('final-answer')] };
assert.match(render({}, completed), /class="completed-steps"/);
assert.doesNotMatch(render({}, completed), /progress-marker/);
assert.doesNotMatch(render({ transcriptPrefs: { expand: {}, options: { compactCompleted: false } } }, completed), /class="completed-steps"/);
assert.match(render({ transcriptPrefs: { expand: {}, options: { compactCompleted: false } } }, completed), /progress-marker/);
const noTimes = renderToString(createElement(ActivityTimeline, { messages: [message], transcriptPrefs: { expand: {}, options: { timestamps: false } } }));
assert.doesNotMatch(noTimes, /class="activity-age"/);
const errors = renderToString(createElement(ActivityTimeline, { messages: [{ ...message, steps: [...steps, failed] }], filter: 'failures' }));
assert.match(errors, /failed-command/);
assert.doesNotMatch(errors, /read-a|private-reasoning-marker/);
const reasoning = renderToString(createElement(ActivityTimeline, { messages: [message], filter: 'thinking', search: 'PRIVATE-REASONING' }));
assert.match(reasoning, /private-reasoning-marker/);
assert.doesNotMatch(reasoning, /read-a/);
const progressSearch = renderToString(createElement(ActivityTimeline, { messages: [completed], search: 'progress-marker' }));
assert.match(progressSearch, /progress-marker/, 'search keeps intermediate prose in Activity');
assert.doesNotMatch(progressSearch, /final-answer/);
const finalSearch = renderToString(createElement(ActivityTimeline, { messages: [completed], search: 'final-answer' }));
assert.match(finalSearch, /No activity matches/);

assert.equal(transcriptOptions().detail, 'balanced');
assert.equal(conversationPrefs().expand.edit, false);
assert.equal(conversationPrefs({ expand: { edit: true } }).expand.edit, true, 'explicit legacy expansion survives');
assert.equal(transcriptOptions({ expand: { thinking: true, terminal: false } }).reasoning, 'expanded');
assert.equal(transcriptOptions({ expand: { terminal: false } }).commands, 'collapsed');
assert.equal(transcriptOptions({ expand: {}, options: { detail: 'minimal' } }).progress, 'latest');
console.log('conversation activity: live grouping, boundaries, retained traces, errors, presets, filters and legacy preferences passed');

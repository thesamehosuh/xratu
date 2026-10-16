import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { strict as assert } from 'node:assert';
import { ActivityTimeline, MessageItem, TASK_LIST_TOOL } from '../src/components/MessageItem';
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
const commandSteps = [call('lint', 'run_terminal_command'), call('build', 'run_terminal_command')];
const commandMessage = { ...message, steps: commandSteps };
const commands = render({}, commandMessage);
assert.equal(groups(commands), 1, 'balanced groups consecutive successful commands');
assert.match(commands, /Commands ran/);
assert.match(commands, /2 commands/);
assert.doesNotMatch(commands, /conversation-work-group" open=""/);
assert.match(render({ transcriptPrefs: { expand: {}, options: { commands: 'expanded' } } }, commandMessage), /conversation-work-group" open=""/, 'expanded commands opens the group');
assert.equal(groups(render({ transcriptPrefs: { expand: {}, options: { detail: 'detailed' } } }, commandMessage)), 0, 'detailed keeps individual commands');
assert.equal(groups(render({}, { ...message, steps: [...commandSteps, failed, call('after-failure', 'run_terminal_command')] })), 2, 'failures split command groups');
assert.equal(groups(render({}, { ...message, steps: [commandSteps[0], text('command-boundary'), commandSteps[1]] })), 2, 'prose splits command groups');
const mixed = render({}, { ...message, steps: [commandSteps[0], call('status', 'git_status'), call('read', 'read_file'), call('edit', 'apply_patch')] });
assert.equal(groups(mixed), 1, 'balanced folds adjacent work across tool families');
assert.match(mixed, /Worked/);
assert.match(mixed, /4 actions/);
assert.equal(groups(render({}, { ...message, steps: [call('status', 'git_status'), call('diff', 'git_diff')] })), 1, 'git calls group together');
const mixedEditsExpanded = render({ transcriptPrefs: { expand: { edit: true } } }, { ...message, steps: [commandSteps[0], call('edit', 'apply_patch')] });
assert.match(mixedEditsExpanded, /conversation-work-group" open=""/, 'mixed groups honor contained edit expansion');
// The heartbeat belongs to the LIVE conversation, not only the read-only
// views: a settled command group is finished, not running, so without it the
// turn reads as stalled between a completed call and the next delta.
const settledTurn = render({}, { ...message, steps: [call('settled-cmd', 'run_terminal_command')] });
assert.match(settledTurn, /class="working-row"/, 'a settled, grouped command still shows the live heartbeat');
assert.doesNotMatch(balanced, /class="working-row"/, 'a row that is still spinning carries its own progress');
assert.doesNotMatch(render({ transcriptPrefs: { expand: {}, options: { compactCompleted: false } } }, { ...message, status: 'done' as const, steps: [...commandSteps, text('final')] }), /class="working-row"/, 'a finished turn never shows the heartbeat');
assert.doesNotMatch(render({}, { ...message, steps: [call('plan', TASK_LIST_TOOL, { result: undefined })] }), /class="working-row"/, 'a pending task list already draws its own spinner');
assert.doesNotMatch(render({}, { ...message, steps: [call('settled-cmd', 'run_terminal_command')], decisions: [{ decision_id: 'q1', question: 'Which one?', options: [] }] }), /class="working-row"/, 'a turn parked on an unanswered question is not a working turn');
const commandActivity = renderToString(createElement(ActivityTimeline, { messages: [commandMessage] }));
assert.equal(groups(commandActivity), 0);
assert.match(commandActivity, /lint result/);
assert.match(commandActivity, /build result/);
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

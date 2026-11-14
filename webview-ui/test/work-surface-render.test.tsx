import { createElement } from 'react';
import { ACCENTS, accentPalette, readAppearance, DEFAULT_APPEARANCE, appearanceStyle } from '../src/appearance';
import { renderToString } from 'react-dom/server';
import { strict as assert } from 'node:assert';
import { MessageItem, ActivityTimeline } from '../src/components/MessageItem';
import { MessageList } from '../src/components/MessageList';
import { ReviewDiff, reviewLines } from '../src/components/ReviewDiff';
import { setLocale } from '../src/i18n';
import { closeTabs, defaultDockLayout, movePanel, readDockLayout } from '../src/dockLayout';
import type { ChatMessage, Step } from '../src/types';
setLocale('en');
const call: Step = { id: 'edit', kind: 'toolCall', tool: 'apply_patch', text: JSON.stringify({path:'src/a.ts',patch:'<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE'}), result: 'Patch applied', callId: 'edit' };
const terminal: Step = { id: 'cmd', kind: 'toolCall', tool: 'run_terminal_command', text: '{"command":"npm test"}', result: 'STDOUT:\nfailed\nSTDERR:\n\nExit code: 1' };
const message: ChatMessage = { id: 'a', role: 'assistant', text: 'Finished.', createdAt: 1000, completedAt: 5000, status: 'done', steps: [{id:'intro',kind:'text',text:'Before tools',html:'<p>Before tools</p>'},call,terminal,{id:'final',kind:'text',text:'Final answer',html:'<p>Final answer</p>'}] };
const render = (m = message, extra = {}) => renderToString(createElement(MessageItem, { message:m,...extra }));
const done = render();
assert.doesNotMatch(render({ ...message, usage: { input_tokens: 10, output_tokens: 20, cost: { amount: 12, currency: 'USD' } } }), /\$12|costTitle|session-cost/);
assert.match(done, /class="completed-steps"/);
assert.doesNotMatch(done, /<details[^>]*open=""/);
assert.doesNotMatch(done, /SEARCH|class="pill-diff"/);
assert.doesNotMatch(done, /Before tools/);
assert.ok(done.indexOf('Final answer') > done.indexOf('completed-steps'));
assert.doesNotMatch(done, /compact-step-list|compact-step failed/);
assert.doesNotMatch(done, /Exit 1/);
assert.doesNotMatch(done, /lucide-check/);
const activity = renderToString(createElement(ActivityTimeline, {messages:[message], transcriptPrefs:{expand:{edit:true}}}));
assert.match(activity, /class="pill-diff"/);
assert.match(activity, /Before tools/);
assert.doesNotMatch(activity, /Final answer/);
assert.match(activity, /class="activity-age"/);
assert.doesNotMatch(activity, /completed-steps/);
assert.doesNotMatch(render({...message,status:'streaming'}), /completed-steps/);
assert.match(render({...message,status:'streaming'}), /Before tools/);
assert.doesNotMatch(render({...message,approval:{approval_id:'ap',approvals:[{tool_call_id:'call',tool_name:'write_file',args:{path:'a',content:'b'}}]}}), /completed-steps/);
assert.doesNotMatch(render({...message,steps:[{...terminal,background:{jobId:'job',byUser:true}}]}), /completed-steps/);
const user=(id:string,cp?:string):ChatMessage=>({id,cp,role:'user',text:id,steps:[],status:'done',createdAt:0});
const checkpoints=renderToString(createElement(MessageList,{messages:[user('u1','aaaaaaa'),{...message,id:'a1'},user('u2','bbbbbbb'),{...message,id:'a2'}],onScroll:()=>{},onPickSuggestion:()=>{},onReviewChanges:()=>{},reviewSha:'bbbbbbb',reviewFiles:[{path:'second-turn.ts',added:3,removed:1,binary:false,untracked:false}]}));
assert.equal((checkpoints.match(/class="turn-outcome"/g)??[]).length,1);
assert.equal((checkpoints.match(/second-turn.ts/g)??[]).length,1);
const untracked=reviewLines({path:'new',kind:'text',before:'',after:'x\n'.repeat(10000),hunks:[{oldStart:1,newStart:1,oldCount:0,newCount:10000,removedLines:[],addedLines:Array(10000).fill('x')}]});
assert.equal(untracked.rows.length,400);
assert.equal(untracked.truncated,true);
const contexts=reviewLines({path:'a',kind:'text',before:'a\nb\nc\nd\ne\nf',after:'a\nB\nc\nD\ne\nf',hunks:[{oldStart:2,oldCount:1,newStart:2,newCount:1,removedLines:['b'],addedLines:['B']},{oldStart:4,oldCount:1,newStart:4,newCount:1,removedLines:['d'],addedLines:['D']}]});
assert.equal(contexts.rows.filter(row=>row.text==='c').length,1);
assert.equal(contexts.rows.filter(row=>row.text==='d').length,1);
assert.equal(contexts.truncated,false);
const unsafeCode = '<img src=x onerror="alert(1)">';
const safeDiff = renderToString(createElement(ReviewDiff, {file: {path:'unsafe.txt',kind:'text',before:'',after:unsafeCode,hunks:[{oldStart:1,oldCount:0,newStart:1,newCount:1,removedLines:[],addedLines:[unsafeCode]}]}}));
assert.doesNotMatch(safeDiff, /<img/);
assert.match(safeDiff, /&lt;img/);
console.log('work-surface render: completed logs, retained activity, approvals, jobs, real exits, checkpoint ownership, and bounded diffs passed');

// Corrupt saved layouts cannot hide or duplicate a panel.
for (const saved of [null, {}, {version: 3}, {version: 1, main: ['conversation', 'activity'], side: ['activity']}, {version: 1, main: ['conversation', 'unknown'], side: ['changes']}]) {
    assert.deepEqual(readDockLayout(saved), defaultDockLayout());
}
let layout = movePanel(defaultDockLayout(), 'activity', 'side');
assert.deepEqual(layout.main, ['conversation', 'agents', 'background', 'downloads', 'pullRequests']);
assert.deepEqual(layout.side, ['changes', 'browser', 'activity']);
assert.equal(layout.sideActive, 'activity');
layout = movePanel(layout, 'changes', 'main');
assert.equal(layout.mainActive, 'changes');
layout = movePanel(layout, 'activity', 'main');
assert.equal(layout.sideActive, 'browser');
assert.deepEqual(layout.side, ['browser']);
assert.deepEqual(readDockLayout(layout), layout);
assert.equal(movePanel(layout, 'conversation', 'side'), layout);
assert.deepEqual(readDockLayout({ ...layout, main: layout.main.filter(tab => tab !== 'conversation'), side: [...layout.side, 'conversation'] }).main[0], 'conversation');
const withBlank = movePanel(layout, 'new-example', 'main');
assert.equal(withBlank.mainActive, 'new-example');
assert.deepEqual(readDockLayout(withBlank), withBlank);
const closed = closeTabs(withBlank, ['changes', 'new-example', 'conversation'], [...withBlank.main, ...withBlank.side]);
assert.ok(!closed.main.includes('changes'));
assert.ok(!closed.main.includes('new-example'));
assert.ok(closed.main.includes('conversation'));
assert.deepEqual(readDockLayout(closed), closed);
const migratedDownloads = readDockLayout({ version: 3, main: ['conversation'], side: [], mainActive: 'conversation' });
assert.deepEqual(migratedDownloads.main, ['conversation', 'downloads']);
assert.deepEqual(readDockLayout(closeTabs(migratedDownloads, ['downloads'], migratedDownloads.main)).main, ['conversation']);
assert.equal(movePanel(closed, 'changes', 'main').mainActive, 'changes');
assert.equal(closeTabs(layout, ['activity'], ['conversation', 'changes', 'activity', 'browser']).mainActive, 'changes');
assert.deepEqual(readDockLayout({version: 3, main: ['conversation', 'new-../../bad'], side: []}), defaultDockLayout());
assert.deepEqual(readDockLayout({version: 3, main: ['conversation', 'new-one', 'new-one'], side: []}), defaultDockLayout());
assert.equal(movePanel(layout, 'changes', 'main'), layout);
assert.equal(readDockLayout({...layout, mainActive: 'unknown'}).mainActive, 'conversation');
const legacyLayout = readDockLayout({ version: 1, main: ['conversation', 'activity', 'agents', 'background'], side: ['changes'], mainActive: 'activity', sideActive: 'changes' });
assert.equal(legacyLayout.mainActive, 'activity');
assert.equal(legacyLayout.main.at(-1), 'browser');
assert.deepEqual(legacyLayout.side, ['changes', 'pullRequests']);
const previousPrLayout = readDockLayout({version: 1, main: ['conversation', 'activity', 'browser', 'pullRequests'], side: ['changes'], mainActive: 'conversation'});
assert.ok(!previousPrLayout.main.includes('pullRequests'));
assert.ok(previousPrLayout.side.includes('pullRequests'));
assert.ok(readDockLayout(movePanel(previousPrLayout, 'pullRequests', 'main')).main.includes('pullRequests'));
const browserDocked = movePanel(legacyLayout, 'browser', 'side');
assert.deepEqual(readDockLayout(browserDocked), browserDocked);

const withApproval = {...message, status: 'streaming' as const, approval: {approval_id:'pending',approvals:[{tool_call_id:'cmd',tool_name:'run_terminal_command',args:{command:'npm test'}}]}};
const observation = renderToString(createElement(ActivityTimeline, {messages:[withApproval,{...withApproval,id:'system-approval',role:'system' as const}], onApprovalDecision:()=>{}, onBackgroundTerminal:()=>{}, onKillBackground:()=>{}}));
assert.doesNotMatch(observation, /approval-card|Send to background|Stop background/);
assert.doesNotMatch(observation, /Final answer/);
assert.doesNotMatch(renderToString(createElement(ReviewDiff, {file:{path:'a.ts',kind:'text',before:'old',after:'new',hunks:[{oldStart:1,oldCount:1,newStart:1,newCount:1,removedLines:['old'],addedLines:['new']}]}})), /@@/);

const lateThinking = { ...message, steps: [...message.steps.map(step => step.id === 'final' ? { ...step, final: true } : step), { id:'late-reasoning', kind:'thinking' as const, text:'Final reasoning bookkeeping' }] };
assert.match(render(lateThinking), /Final answer/);
assert.doesNotMatch(renderToString(createElement(ActivityTimeline, {messages:[lateThinking]})), /Final answer/);

const reordered = movePanel(defaultDockLayout(), 'browser', 'main', 'conversation');
assert.equal(reordered.main[0], 'browser');
assert.equal(new Set([...reordered.main, ...reordered.side]).size, 8);
assert.deepEqual(readDockLayout(reordered), reordered);

const hiddenWake = renderToString(createElement(MessageList, {messages:[user('visible'),{...user('internal notification'),hidden:true},{...message,id:'reply'}],onScroll:()=>{},onPickSuggestion:()=>{}}));
assert.doesNotMatch(hiddenWake, /internal notification/);
assert.match(hiddenWake, /Final answer/);
assert.doesNotMatch(render(message, {reviewSha:'sha',onReviewChanges:()=>{}}), /outcome-review|outcome-actions/);
assert.doesNotMatch(render(message, {reviewSha:'sha',reviewFiles:[],onReviewChanges:()=>{}}), /outcome-review/);
const diffPanelOpen = renderToString(createElement(MessageList, {messages:[user('request','sha'),message],onScroll:()=>{},onPickSuggestion:()=>{},onReviewChanges:()=>{},reviewSha:'sha',reviewPanelOpen:true,reviewFiles:[{path:'file.ts',added:1,removed:0,binary:false}]}));
assert.match(diffPanelOpen, /outcome-review/);
assert.doesNotMatch(diffPanelOpen, /Ask for review/);
const historicalDiffs = renderToString(createElement(MessageList, {messages:[user('first','aaa'),{...message,id:'first-answer'},user('second','bbb'),{...message,id:'second-answer'}],onScroll:()=>{},onPickSuggestion:()=>{},onReviewChanges:()=>{},turnFiles:{'aaa:bbb':[{path:'first.ts',added:1,removed:0,binary:false}],'bbb:':[{path:'second.ts',added:2,removed:0,binary:false}]}}));
assert.equal((historicalDiffs.match(/class="outcome-review"/g)??[]).length,2);

const outsideApproval = render({ ...message, approval: { approval_id: 'outside', approvals: [{ tool_call_id: 'outside-edit', tool_name: 'edit_file', args: { path: '../outside.txt', outside_workspace_paths: ['../outside.txt'] } }] } });
assert.match(outsideApproval, /outside the workspace/);
assert.doesNotMatch(outsideApproval, /class="approval-session"/);
assert.doesNotMatch(outsideApproval, /Auto-denied/);

// Malformed saved UI preferences cannot inject CSS or erase safe defaults.
for (const value of [null, [], 'wide', { scheme: 'light', accent: 'constructor', font: 'url(unsafe)', width: '999999px', interfaceSize: '18px', textSize: -1, codeSize: '16px', density: true, motion: 'always' }]) {
    assert.deepEqual(readAppearance(value), DEFAULT_APPEARANCE);
}
assert.deepEqual(readAppearance({ width:'wide', textSize:18, motion:'reduced', extra:'ignored' }), { ...DEFAULT_APPEARANCE, width:'wide', textSize:18, motion:'reduced' });
assert.equal(appearanceStyle(readAppearance({ width:'wide' }))['--conversation-width' as keyof ReturnType<typeof appearanceStyle>], '900px');

assert.deepEqual(readAppearance({ scheme:'dark', accent:'violet' }), { ...DEFAULT_APPEARANCE, scheme:'dark', accent:'violet' });
assert.equal(Object.prototype.hasOwnProperty.call(appearanceStyle(DEFAULT_APPEARANCE, true), '--xratu-fs-prose'), false, 'theme choices preserve welcome typography');
const interfaceStyle = appearanceStyle(readAppearance({ interfaceSize:18, textSize:12, codeSize:16 }));
assert.equal(interfaceStyle['--xratu-fs-base' as keyof typeof interfaceStyle], '18px');
assert.equal(interfaceStyle['--xratu-fs-prose' as keyof typeof interfaceStyle], '12px');
assert.equal(interfaceStyle['--xratu-fs-code' as keyof typeof interfaceStyle], '16px');
assert.equal(readAppearance({ interfaceSize:99 }).interfaceSize, 14);

const luminance = (hex: string) => {
    const rgb = [1,3,5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
};
for (const accent of Object.values(ACCENTS)) for (const [bg, fg] of [[accent.dark, accent.ink], [accent.light, '#ffffff']]) {
    const a = luminance(bg), b = luminance(fg);
    assert.ok((Math.max(a,b) + .05) / (Math.min(a,b) + .05) >= 4.5, `${accent.label} keeps filled action labels readable`);
}

assert.deepEqual(readAppearance({ saturation:Infinity, customAccent:'red; display:none', darkContrast:NaN }).customAccent, DEFAULT_APPEARANCE.customAccent);
assert.equal(readAppearance({ saturation:300 }).saturation, 150);
assert.equal(readAppearance({ darkContrast:-1 }).darkContrast, 0);
for (const customAccent of ['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#777777']) for (const saturation of [0,100,150]) {
    const palette = accentPalette(readAppearance({accent:'custom',customAccent,saturation}));
    const ratio = (a: string,b: string) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
    assert.ok(ratio(palette.dark,palette.ink)>=4.5, 'custom filled actions remain readable');
    assert.ok(ratio(palette.strong,palette.ink)>=4.5, 'custom hover actions remain readable');
    assert.ok(ratio(palette.light,'#ffffff')>=4.5, 'light accent labels remain readable');
}

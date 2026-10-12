/** Browser-only, opt-in demo fixture. Never imported by the extension or CI specs. */
import { VSCODE_DARK_THEME_CSS } from './vscodeTheme';
import type { FromExtensionMessage } from '../../webview-ui/src/types';
import { curatedMarketplaceEntries } from '../../src/mcpMarketplace';

type Envelope = { type: string; [key: string]: unknown };
const locale = new URLSearchParams(location.search).get('locale') === 'fa' ? 'fa' : 'en';
const inspect = new URLSearchParams(location.search).has('inspect');
const copy = {
    en: {
        titles: ['Engine and model', 'Describe the change', 'Inspect agent progress', 'Approve and review', 'Background terminal', 'Verify in the browser'],
        chapters: ['Connect', 'Task', 'Agents', 'Review', 'Terminal', 'Browser'],
        disclosure: 'Scripted demo · current Xratu UI',
        marketplace: 'Choose tools from the marketplace',
        prompt: 'Add search to the issue board. Include tests and verify it in the browser.',
        plan: ['Inspect the board and existing tests', 'Add search and edge-case coverage', 'Verify the result in the browser'],
        thinking: 'I’ll trace the board component and test coverage in parallel, then propose a small patch.',
        agent: 'Trace the issue board', tests: 'Check search coverage',
        agentText: 'The issue list is in Board.tsx. Search can filter titles without changing the stored issues.',
        agentReport: 'Found the board component. Filter by lowercase title; keep the original issue list intact.',
        testsText: 'Cover case-insensitive search, clearing the query, and no matching issues.',
        result: 'Added issue search and covered the edge cases. All 8 tests pass. The dev server is running for browser verification.',
        followup: 'Add an empty-state test, too.',
        followupResult: 'Empty-state coverage added. All 9 tests pass.',
        draft: 'Check keyboard navigation, too.',
    },
    fa: {
        titles: ['موتور و مدل', 'شرح تغییر', 'پیشرفت عامل ها', 'تایید و بررسی', 'ترمینال پس زمینه', 'بررسی توی مرورگر'],
        chapters: ['اتصال', 'درخواست', 'عامل ها', 'بررسی', 'ترمینال', 'مرورگر'],
        disclosure: 'دموی سناریونویسی شده · رابط فعلی خراتو',
        marketplace: 'انتخاب ابزار از فروشگاه',
        prompt: 'جستجو رو به فهرست کار ها اضافه کن. براش تست بنویس و نتیجه رو توی مرورگر بررسی کن.',
        plan: ['بررسی فهرست کار ها و تست های فعلی', 'اضافه کردن جستجو و تست حالت های خاص', 'بررسی نتیجه توی مرورگر'],
        thinking: 'کامپوننت و تست ها رو موازی بررسی میکنم، بعد یه تغییر کوچیک پیشنهاد میدم.',
        agent: 'بررسی فهرست کار ها', tests: 'بررسی تست های جستجو',
        agentText: 'فهرست کار ها توی Board.tsx هست. میشه عنوان ها رو فیلتر کرد و فهرست اصلی رو دست نزد.',
        agentReport: 'کامپوننت پیدا شد. عنوان ها بدون حساسیت به حروف فیلتر میشن و فهرست اصلی حفظ میشه.',
        testsText: 'حروف بزرگ و کوچیک، پاک کردن جستجو و نتیجه خالی رو تست میکنم.',
        result: 'جستجو اضافه شد و هر ۸ تست پاس شدن. سرور پروژه هم برای بررسی توی مرورگر اجرا شده.',
        followup: 'برای نتیجه خالی هم یه تست اضافه کن.',
        followupResult: 'تست نتیجه خالی اضافه شد. هر ۹ تست پاس شدن.',
        draft: 'جابجایی با کیبورد رو هم بررسی کن.',
    },
}[locale];
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const existingTests = [
    ['shows every issue initially', "expect(searchIssues(issues, '')).toEqual(issues);"],
    ['matches issue titles', "expect(searchIssues(issues, 'keyboard')).toHaveLength(1);"],
    ['ignores query case', "expect(searchIssues(issues, 'KEYBOARD')).toEqual(searchIssues(issues, 'keyboard'));"],
    ['matches part of a title', "expect(searchIssues(issues, 'key')).toHaveLength(1);"],
    ['clears the filter', "expect(searchIssues(issues, '')).toHaveLength(issues.length);"],
    ['returns no unmatched issues', "expect(searchIssues(issues, 'missing')).toEqual([]);"],
    ['keeps the source unchanged', "expect(issues).toEqual(originalIssues);"],
    ['keeps original issue order', "expect(searchIssues(issues, '')).toEqual(issues);"],
].map(([name, assertion]) => `it('${name}', () => {\n  ${assertion}\n});`).join('\n');
const emptyTest = `it('shows an empty state for unmatched search', () => {
  render(<Board issues={issues} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } });
  expect(screen.getByText('No matching issues')).toBeVisible();
});`;
const before = "export function Board({ issues }) {\n  return <IssueList issues={issues} />;\n}";
const after = "export function Board({ issues }) {\n  const [query, setQuery] = useState('');\n  const visible = issues.filter(issue =>\n    issue.title.toLowerCase().includes(query.toLowerCase())\n  );\n  return <>\n    <input aria-label=\"Search issues\" value={query}\n      onChange={event => setQuery(event.target.value)} />\n    <IssueList issues={visible} />\n  </>;\n}";
const hostMessages: Envelope[] = [];
let scene = 0;
let run = 0;
let reviewReady = false;
let followupReady = false;
let filtered = false;
let paced = false;
const beats: { action: string; at: number }[] = [];
const pause = (ms: number) => paced ? wait(ms) : Promise.resolve();
const state: Record<string, unknown> = {};
const PLAYBACK_SPEED = 1.3;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms / PLAYBACK_SPEED));
const post = async (message: FromExtensionMessage) => {
    window.postMessage(message, '*');
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};
async function until<T>(read: () => T | null | undefined | false): Promise<T> {
    const start = performance.now();
    while (performance.now() - start < 5000) {
        const value = read(); if (value) return value;
        await wait(30);
    }
    throw new Error('Demo prerequisite timed out');
}
const element = (selector: string) => until(() => document.querySelector<HTMLElement>(selector));
async function point(target: HTMLElement) {
    if (!paced || inspect) return;
    const box = target.getBoundingClientRect();
    const cursor = document.querySelector<HTMLElement>('.demo-cursor')!;
    cursor.style.opacity = '1';
    const browserSearch = target.matches('.browser-viewport img');
    cursor.style.transform = `translate(${box.x + (browserSearch ? box.width * .23 : Math.min(box.width / 2, 70))}px, ${box.y + box.height * (browserSearch ? .39 : .5)}px)`;
    await wait(380);
}
async function click(selector: string) {
    const target = await element(selector);
    await point(target);
    target.click();
    const cursor = document.querySelector<HTMLElement>('.demo-cursor');
    cursor?.classList.add('clicked');
    await wait(240);
    cursor?.classList.remove('clicked');
    beats.push({ action: selector, at: performance.now() });
}
async function drag(sourceSelector: string, targetSelector: string) {
    const source = await element(sourceSelector);
    const target = await element(targetSelector);
    await point(source);
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    // Let React publish its dragging state before delivering dragover/drop.
    await wait(80);
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.style.direction = getComputedStyle(source).direction;
    ghost.classList.add('demo-drag-ghost');
    ghost.style.width = `${from.width}px`;
    ghost.style.transform = `translate(${from.x}px, ${from.y}px)`;
    document.body.appendChild(ghost);
    await wait(30);
    const destination = { x: to.x + Math.min(to.width / 2, 100), y: to.y + to.height / 2 };
    ghost.style.transform = `translate(${destination.x - from.width / 2}px, ${destination.y - from.height / 2}px)`;
    const cursor = document.querySelector<HTMLElement>('.demo-cursor')!;
    cursor.style.transitionDuration = `${.7 / PLAYBACK_SPEED}s`;
    cursor.style.transform = `translate(${destination.x}px, ${destination.y}px)`;
    await wait(paced ? 650 : 30);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    await wait(paced ? 220 : 30);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    ghost.remove();
    cursor.style.transitionDuration = '';
    await until(() => document.querySelector(sourceSelector)?.closest('.dock-tabs.side'));
    beats.push({ action: `drag ${sourceSelector} to ${targetSelector}`, at: performance.now() });
}
async function fill(selector: string, value: string, settle = true) {
    const input = await element(selector) as HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (settle) await wait(80);
}
async function type(selector: string, text: string) {
    if (!paced) return fill(selector, text);
    await point(await element(selector));
    for (let i = 1; i <= text.length; i++) {
        await fill(selector, text.slice(0, i), false);
        await wait(i % 10 === 0 ? 85 : 36);
    }
}
async function stream(text: string) {
    if (!paced) return post({ type: 'chunk', value: text });
    for (const word of text.match(/\S+\s*/g) ?? []) {
        await post({ type: 'chunk', value: word });
        await wait(55);
    }
}
async function frame() {
    const response = await fetch(filtered ? 'board-search.png' : 'board-all.png');
    if (!response.ok) throw new Error('Capture the board preview PNGs before recording');
    const blob = await response.blob();
    const data = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob); });
    await post({ type: 'browserFrame', frame: { sessionId: 'readme-demo', browserId: 'demo-browser', frameId: filtered ? 2 : 1, data, width: 760, height: 560 } });
}
async function reply(message: Envelope) {
    if (message.type === 'mcpMarketplaceGetState') {
        await post({ type: 'mcpMarketplaceState', query: '', entries: curatedMarketplaceEntries(), sources: [], status: 'cached', fetchedAt: null, error: null, liveSearch: false });
    } else if (message.type === 'changesGetState') {
        await post({ type: 'changesState', sha: String(message.sha), requestId: String(message.requestId), files: message.sha === nextSha ? followupReady ? [{ path: 'test/Board.test.tsx', added: 5, removed: 0, binary: false, untracked: false }] : [] : reviewReady ? [
            { path: 'src/Board.tsx', added: 9, removed: 1, binary: false, untracked: false },
            { path: 'test/Board.test.tsx', added: 24, removed: 0, binary: false, untracked: false },
        ] : [] });
    } else if (message.type === 'changeFileGet') {
        if (message.sha === nextSha) {
            await post({ type: 'changeFileState', sha: nextSha, requestId: String(message.requestId), file: { path: String(message.path), kind: 'text', before: existingTests, after: existingTests + '\n' + emptyTest, hunks: [{ oldStart: 25, oldCount: 0, newStart: 25, newCount: 5, removedLines: [], addedLines: emptyTest.split('\n') }] } });
            return;
        }
        await post({ type: 'changeFileState', sha: String(message.sha), requestId: String(message.requestId), file: { path: String(message.path), kind: 'text', before, after, hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 9, removedLines: [before.split('\n')[1]], addedLines: after.split('\n').slice(1, -1) }] } });
    } else if (message.type === 'browserCommand') {
        const command = message.command as { action: string; text?: string };
        if (command.action === 'type') { filtered = true; await frame(); }
    }
}
Object.assign(window, { acquireVsCodeApi: () => ({
    getState: () => state,
    setState: (value: Record<string, unknown>) => Object.assign(state, value),
    postMessage: (message: Envelope) => { hostMessages.push(message); void reply(message).catch(error => { console.error(error); document.querySelector('#demo-status')!.textContent = String(error); }); },
}) });

const style = document.createElement('style');
style.id = 'xratu-vscode-theme';
style.textContent = VSCODE_DARK_THEME_CSS + `
body{background:#0d1311!important;overflow:hidden}.demo-header,.demo-footer,.demo-controls{font-family:system-ui,sans-serif}.demo-header{height:78px;padding:25px 32px;color:#e6eee9}.demo-meta{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#7c958a}.demo-brand{display:flex;gap:10px;align-items:center;color:#e6eee9;font-size:18px;font-weight:650}.demo-brand img{width:26px;height:26px}.demo-scene{display:flex;align-items:center;gap:22px}#demo-title{font-size:15px;line-height:1.4;letter-spacing:0;margin:0;font-weight:400;color:#96a79d}.demo-window{margin:0 32px;border:1px solid #34483d;border-radius:12px;overflow:hidden;box-shadow:0 16px 50px #0005;height:calc(100vh - 144px);background:#181818}#root{height:100%}.app{height:100%!important}.demo-footer{padding:19px 32px;color:#768b7d;display:flex;align-items:center;justify-content:space-between;font-size:10px}#demo-chapters{display:flex;gap:20px}.demo-chapter{display:flex;gap:7px;align-items:center}.demo-chapter.active{color:#84dec2}.demo-chapter.done{color:#b2c7ba}.demo-number{font-size:9px}.demo-controls{position:fixed;inset-block-end:8px;inset-inline-end:48px;display:flex;gap:8px;color:#9eada4;font-size:11px}.demo-controls button{font:inherit;color:#b5d8c6;background:#192b22;border:1px solid #34483d;border-radius:5px;padding:5px 10px}.recording .demo-controls{visibility:hidden}.demo-header h1{transition:opacity ${.15 / PLAYBACK_SPEED}s ease,transform ${.15 / PLAYBACK_SPEED}s ease}.demo-header.changing h1{opacity:0;transform:translateY(5px)}.inspect .demo-header,.inspect .demo-footer,.inspect .demo-controls{display:none}.inspect .demo-window{height:100vh;margin:0;border:0;border-radius:0;box-shadow:none}@media(max-width:600px){.demo-header{padding:18px 20px;height:65px}#demo-title{font-size:12px}.demo-scene{gap:12px}.demo-window{margin:0 16px;height:calc(100vh - 140px)}.demo-footer{padding:17px 20px}#demo-chapters{gap:10px}.demo-number,#demo-disclosure{display:none}.demo-controls{inset-inline-end:20px}}@media(prefers-reduced-motion:reduce){.demo-header h1{transition:none}}
`;
style.textContent += `.demo-cursor{position:fixed;inset-block-start:0;inset-inline-start:0;z-index:9999;pointer-events:none;opacity:0;transform:translate(150px,150px);transition:transform ${.38 / PLAYBACK_SPEED}s cubic-bezier(.2,.65,.3,1),opacity .2s}.demo-cursor::before{content:"";position:absolute;inset:-10px;border:1px solid #81d7b5;border-radius:50%;opacity:0;transform:scale(.4);transition:transform .3s,opacity .3s}.demo-cursor.clicked::before{opacity:.65;transform:scale(1)}`;
style.textContent += `.demo-drag-ghost{position:fixed;inset-block-start:0;inset-inline-start:0;z-index:9998;pointer-events:none;display:flex;align-items:center;gap:6px;padding:8px;color:#84dec2;background:#20372c;border:1px solid #537d67;border-radius:6px;box-shadow:0 5px 15px #0005;font:12px system-ui;transition:transform ${.7 / PLAYBACK_SPEED}s cubic-bezier(.2,.65,.3,1);opacity:.9}`;
document.documentElement.appendChild(style);

async function caption(index: number) {
    scene = index;
    const header = document.querySelector<HTMLElement>('.demo-header')!;
    header.classList.add('changing'); await wait(150);
    document.querySelector('#demo-title')!.textContent = copy.titles[index];
    document.querySelector('#demo-counter')!.textContent = `0${index + 1} / 06`;
    document.querySelector('#demo-chapters')!.innerHTML = copy.chapters.map((label, i) => `<span class="demo-chapter ${i === index ? 'active' : i < index ? 'done' : ''}"><span class="demo-number">0${i + 1}</span>${label}</span>`).join('');
    header.classList.remove('changing');
}
function trace(profile: string, description: string, text: string, status: 'running' | 'done' = 'running') {
    const now = Date.now();
    return { taskId: profile, profile, description, prompt: description, model: 'qwen3-coder:30b', effort: 'high', tools: ['read_file', 'grep_search'], resumed: false, status, startedAt: now - 2800, updatedAt: now, ...(status === 'done' ? { endedAt: now, report: copy.agentReport } : {}), toolCalls: 2, inputTokens: 2410, outputTokens: 286, entries: [
        { id: 'reason', kind: 'text' as const, text, startedAt: now - 2800, endedAt: now - 2000 },
        { id: 'read', kind: 'tool' as const, tool: 'read_file', text: JSON.stringify({ path: 'src/Board.tsx' }), output: '[src/Board.tsx — lines 12-14 of 42]\n' + before, startedAt: now - 2000, endedAt: now - 1000 },
    ] };
}
async function step(index: number) {
    beats.push({ action: `scene-${index}`, at: performance.now() });
    await caption(index === 4 ? 3 : index);
    if (index === 0) {
        await post({ type: 'showWelcome' });
    } else if (index === 1) {
        await post({ type: 'showChat' });
        document.querySelector('#demo-title')!.textContent = copy.marketplace;
        await click(locale === 'fa' ? '[title="سرور ها و مهارت ها"]' : '[title="Servers & Skills"]');
        await post({ type: 'mcpState', servers: [], hasWorkspace: false, legacyInUse: false });
        await post({ type: 'skillsState', skills: [] });
        await click('.page-sidebar .sidebar-item:nth-of-type(5)');
        await element('.mp-row');
        await pause(2800);
        await click('.sidebar-back');
        await caption(1);
        await post({ type: 'sessionState', id: 'readme-demo', title: 'Add issue search' });
        await post({ type: 'connectionStatus', status: 'connected' });
        await post({ type: 'modelInfo', defaultModel: 'qwen3-coder:30b', selectedModel: 'qwen3-coder:30b', models: ['qwen3-coder:30b'], displayNames: { 'qwen3-coder:30b': 'Qwen3 Coder · Ollama' }, contextWindows: { 'qwen3-coder:30b': 32768 } });
        await post({ type: 'gitStatusState', root: 'open-board', status: { isRepo: true, branch: 'feat/issue-search', upstream: null, detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
        await pause(650);
        await type('.composer-input', copy.prompt);
        await pause(1200);
    } else if (index === 2) {
        await click('.send-btn');
        await post({ type: 'userCheckpoint', userIndex: 0, sha });
        await post({ type: 'startResponse' });
        await stream(copy.thinking);
        await post({ type: 'taskListState', tasks: copy.plan.map((label, i) => ({ id: String(i), label, status: i === 0 ? 'in_progress' : 'pending' })) });
        await pause(1100);
        await post({ type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'explore', description: copy.agent }), callId: 'agent-board' });
        await post({ type: 'subagentState', callId: 'agent-board', trace: trace('explore', copy.agent, copy.agentText) });
        await post({ type: 'toolCall', tool: 'task', args: JSON.stringify({ subagent_type: 'reviewer', description: copy.tests }), callId: 'agent-tests' });
        await post({ type: 'subagentState', callId: 'agent-tests', trace: trace('reviewer', copy.tests, copy.testsText) });
        await pause(900);
        await click('#surface-tab-agents');
        await pause(1800);
        await click('.agent-run-view:not(.panel-hidden) .step > summary');
        await pause(2400);
        await click('.agent-run-card:last-child');
        await pause(1800);
    } else if (index === 3) {
        await post({ type: 'subagentState', callId: 'agent-board', trace: trace('explore', copy.agent, copy.agentText, 'done') });
        await post({ type: 'subagentState', callId: 'agent-tests', trace: trace('reviewer', copy.tests, copy.testsText, 'done') });
        for (const callId of ['agent-board', 'agent-tests']) await post({ type: 'toolResult', tool: 'task', callId, output: copy.agentReport });
        await click('#surface-tab-conversation');
        await post({ type: 'needsApproval', approval_id: 'demo-edit', approvals: [{ tool_call_id: 'edit-board', tool_name: 'edit_file', args: { path: 'src/Board.tsx', patch: `<<<<<<< SEARCH\n${before}\n=======\n${after}\n>>>>>>> REPLACE` }, diff: { file: 'src/Board.tsx', added: 9, removed: 1, lines: ['@@ -12,3 +12,11 @@', ' ' + before.split('\n')[0], '-' + before.split('\n')[1], ...after.split('\n').slice(1, -1).map(line => '+' + line), ' }'] } }] });
        await pause(850);
        await click('.approval-item > summary');
        (await element('.approval-card')).scrollIntoView({ block: 'center', behavior: paced ? 'smooth' : 'instant' });
        await pause(3200);
    } else if (index === 4) {
        await click('.approval-apply');
        await post({ type: 'approvalResolved', approval_id: 'demo-edit', resolution: 'approved' });
        await pause(650);
        await post({ type: 'toolCall', tool: 'edit_file', callId: 'edit-board', args: JSON.stringify({ path: 'src/Board.tsx' }) });
        await post({ type: 'toolResult', tool: 'edit_file', callId: 'edit-board', output: 'Updated src/Board.tsx' });
        await pause(500);
        reviewReady = true;
        await post({ type: 'toolCall', tool: 'run_terminal_command', callId: 'test-board', args: JSON.stringify({ command: 'npm test -- Board' }) });
        await post({ type: 'toolOutput', callId: 'test-board', value: 'Running Board tests…\n' });
        await pause(850);
        await post({ type: 'toolResult', tool: 'run_terminal_command', callId: 'test-board', output: 'PASS test/Board.test.tsx\nTests: 8 passed, 8 total\nExit code: 0' });
        await post({ type: 'toolCall', tool: 'run_terminal_command', callId: 'dev-server', args: JSON.stringify({ command: 'npm run dev' }) });
        await post({ type: 'terminalBackgrounded', callId: 'dev-server', jobId: 'dev', byUser: true });
        await post({ type: 'toolResult', tool: 'run_terminal_command', callId: 'dev-server', output: 'Dev server running in background' });
        await post({ type: 'backgroundJobs', jobs: [{ jobId: 'dev', command: 'npm run dev', running: true, uptimeSeconds: 4 }] });
        await post({ type: 'backgroundJobOutput', jobId: 'dev', output: 'VITE ready in 284 ms\n\n  Local: http://localhost:5173/\n\nWatching for file changes…' });
        await post({ type: 'taskListState', tasks: copy.plan.map((label, i) => ({ id: String(i), label, status: i < 2 ? 'completed' : 'in_progress' })) });
        await post({ type: 'fullResponse', persian: copy.result });
        await pause(1100);
        await click('#surface-tab-changes');
        // Checkpoint replies retain the request identities issued by the real UI.
        const request = hostMessages.filter(m => m.type === 'changesGetState').at(-1)!;
        await reply(request);
        await element('.review-diff');
        await pause(2200);
        const reviewed = await element('.review-footer button:last-child');
        reviewed.scrollIntoView({ block: 'nearest', behavior: paced ? 'smooth' : 'instant' });
        await pause(300);
        await click('.review-footer button:last-child');
        await pause(450);
        await type('.composer-input', copy.followup);
        await click('.send-btn');
        await post({ type: 'userCheckpoint', userIndex: 1, sha: nextSha });
        await post({ type: 'startResponse' });
        await post({ type: 'needsApproval', approval_id: 'demo-empty-test', approvals: [{ tool_call_id: 'empty-test', tool_name: 'edit_file', args: { path: 'test/Board.test.tsx', mode: 'append', content: emptyTest } }] });
        await pause(550);
        await click('.approval-apply');
        await post({ type: 'approvalResolved', approval_id: 'demo-empty-test', resolution: 'approved' });
        followupReady = true;
        await post({ type: 'toolCall', tool: 'edit_file', callId: 'empty-test', args: JSON.stringify({ path: 'test/Board.test.tsx', mode: 'append', content: emptyTest }) });
        await post({ type: 'toolResult', tool: 'edit_file', callId: 'empty-test', output: 'Added empty-state test' });
        await post({ type: 'fullResponse', persian: copy.followupResult });
        await until(() => document.querySelector('.review-turn:not([hidden])'));
        (await element('.review-turn:not([hidden])')).scrollIntoView({ block: 'start', behavior: paced ? 'smooth' : 'instant' });
        await pause(400);
        await click('.review-turn:not([hidden]) > summary');
        await element('.review-turn[open] .review-diff');
        (await element('.review-history-heading')).scrollIntoView({ block: 'start', behavior: paced ? 'smooth' : 'instant' });
        await pause(1800);
        await caption(4);
        await click('#surface-tab-background');
        await pause(2200);
        await post({ type: 'backgroundJobOutput', jobId: 'dev', output: 'VITE ready in 284 ms\n\n  Local: http://localhost:5173/\n\n10:42:08 [vite] hot updated: /src/Board.tsx\nWatching for file changes…' });
        await pause(1800);
    } else if (index === 5) {
        if (innerWidth > 860) {
            await click('#surface-tab-conversation');
            await drag('#surface-tab-conversation', '.dock-tabs.side');
            await pause(350);
        }
        await post({ type: 'browserState', state: { sessionId: 'readme-demo', browserId: 'demo-browser', status: 'ready', url: 'http://localhost:5173', title: 'Open Board', loading: false, viewport: { width: 760, height: 560 }, viewportMode: 'fixed' } });
        await frame();
        await click('#surface-tab-browser');
        await pause(1800);
        await point(await element('.browser-viewport img'));
        filtered = true;
        await frame();
        await post({ type: 'taskListState', tasks: copy.plan.map(label => ({ label, status: 'completed' })) });
        await pause(2200);
        await type('.composer-input', copy.draft);
        await pause(1800);
    }
    document.querySelector('#demo-status')!.textContent = `Scene ${index + 1}`;
}
async function init() {
    document.body.classList.add('vscode-dark');
    const cursor = document.createElement('div');
    cursor.className = 'demo-cursor';
    cursor.innerHTML = '<svg width=18 height=22 viewBox="0 0 18 22"><path d="M2 1v16l4-4 4 7 3-2-4-6h6Z" fill="#f1f4f2" stroke="#15221c" stroke-width="1.5"/></svg>';
    document.body.appendChild(cursor);
    document.body.classList.toggle('inspect', inspect);
    document.querySelector('#demo-disclosure')!.textContent = copy.disclosure;
    if (locale === 'fa') {
        for (const selector of ['#demo-title', '#demo-chapters', '#demo-disclosure']) (document.querySelector(selector) as HTMLElement).style.direction = 'rtl';
    }
    await until(() => hostMessages.some(m => m.type === 'webviewReady'));
    await post({ type: 'locale', locale });
    await step(0);
    document.querySelector('#demo-replay')!.addEventListener('click', () => {
        if (scene === 0) void play();
        else { const url = new URL(location.href); url.searchParams.set('play', '1'); location.href = url.href; }
    });
    document.querySelector('#demo-next')!.addEventListener('click', () => { void step(Math.min(5, scene + 1)).catch(console.error); });
    if (new URLSearchParams(location.search).has('play')) void play();
}
async function play() {
    const current = ++run;
    paced = true;
    beats.length = 0;
    document.body.classList.add('recording');
    try {
        for (let index = 0; index < 6; index++) {
            if (current !== run) return;
            await step(index);
            if (index === 0) await pause(2200);
        }
        document.querySelector('.demo-cursor')?.setAttribute('style', 'opacity:0');
        document.querySelector('#demo-status')!.textContent = 'Complete';
        return { complete: true, beats };
    } catch (error) {
        document.querySelector('#demo-status')!.textContent = String(error);
        console.error(error);
        throw error;
    } finally { paced = false; }
}
Object.assign(window, { xratuDemo: { step, play, messages: hostMessages, beats, stop: () => { run++; }, ready: init } });
document.addEventListener('DOMContentLoaded', () => { void init().catch(console.error); });

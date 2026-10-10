import { expect, test, type Page } from '@playwright/test';
import { installVscodeTheme } from './vscodeTheme';
const post = (page: Page, msg: Record<string, unknown>) => page.evaluate(message => window.postMessage(message, '*'), msg);
const sent = (page: Page): Promise<Array<Record<string, unknown>>> => page.evaluate(() => (window as unknown as {__xratuHostMessages:Array<Record<string,unknown>>}).__xratuHostMessages);
const trace = (status = 'running', extra = {}) => ({taskId:'child-a',profile:'explore',description:'Trace session expiry',prompt:'Find expiry checks and their tests',model:'child-model',effort:'high',tools:['read_file','grep_search'],resumed:false,status,startedAt:Date.now()-3000,updatedAt:Date.now(),toolCalls:2,inputTokens:1234,outputTokens:123,entries:[
    {id:'intro',kind:'text',text:'Checking expiry before editing.',startedAt:Date.now()-3000,endedAt:Date.now()-2000},
    {id:'read',kind:'tool',tool:'read_file',text:JSON.stringify({path:'src/auth.ts'}),output:'[src/auth.ts - lines 38-40 of 100]\nexport function expired(token) {\n  return token.expiresAt < Date.now();\n}',startedAt:Date.now()-2000,endedAt:Date.now()-1000},
    {id:'grep',kind:'tool',tool:'grep_search',text:JSON.stringify({pattern:'expired',path:'src'}),output:'src/auth.ts:38:export function expired(token) {\ntest/auth.test.ts:5:expired(token)',startedAt:Date.now()-1000,endedAt:Date.now()},
],...extra});
test.beforeEach(async ({page}) => {
    await installVscodeTheme(page);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.addInitScript(() => { const messages:unknown[]=[];Object.assign(window,{__xratuHostMessages:messages,acquireVsCodeApi:()=>({postMessage:(m:unknown)=>messages.push(m),getState:()=>undefined,setState:()=>{}})}); });
    await page.goto('/'); await post(page,{type:'showChat'}); await post(page,{type:'locale',locale:'en'});
});
for (const locale of ['en','fa']) for (const width of [420,1080]) {
    test(`child observation, docking, approvals and retained state (${locale}, ${width})`, async ({page}) => {
        await page.setViewportSize({width,height:900}); await post(page,{type:'locale',locale});
        await page.locator('.composer-input').fill('Keep my draft');
        await expect(page.locator('#surface-tab-agents')).toHaveCount(0);
        await post(page,{type:'startResponse'});
        await post(page,{type:'toolCall',tool:'task',args:JSON.stringify({subagent_type:'explore',description:'Trace session expiry',prompt:'Find expiry checks'}),callId:'parent-a'});
        await post(page,{type:'toolCall',tool:'task',args:JSON.stringify({subagent_type:'general',description:'Implement tests'}),callId:'parent-b'});
        await post(page,{type:'subagentState',callId:'parent-a',trace:trace()});
        await expect(page.locator('#surface-tab-conversation')).toHaveAttribute('aria-selected','true');
        await page.locator('.transcript-pane .step').first().locator(':scope > summary').click();
        await page.locator('.transcript-pane .subagent-open').first().click();
        const panel=page.locator('.agents-pane');
        await expect(panel).toBeVisible(); await expect(panel.locator('.agent-run-card')).toHaveCount(2);
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-run-heading')).toContainText('Trace session expiry');
        await expect(panel.locator('.agent-token-metric').first()).toContainText('1,234');
        await expect(panel).toContainText('Checking expiry before editing.');
        const read=panel.locator('.step').first(); await read.locator(':scope > summary').click();
        await expect(read.locator('.detail-line-number').first()).toHaveText('38');
        await expect(read.locator('.detail-source-line')).toHaveCount(3);
        await read.locator('.detail-arguments summary').click();
        await expect(read.locator('.detail-arguments pre')).toContainText('src/auth.ts');
        await panel.locator('.agent-run-card').nth(1).click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-empty')).toBeVisible();
        await panel.locator('.agent-run-card').first().click();
        await expect(read).toHaveAttribute('open','');
        await expect(read.locator('.detail-arguments')).toHaveAttribute('open','');
        await post(page,{type:'subagentState',callId:'parent-a',trace:trace('waiting',{pendingTools:['edit_file']})});
        await post(page,{type:'needsApproval',approval_id:'child-approval',source:{parentCallId:'parent-a',profile:'explore',description:'Trace session expiry'},approvals:[{tool_call_id:'child-write',tool_name:'edit_file',args:{path:'a.ts',patch:'old to new'}}]});
        await expect(panel.locator('.approval-card')).toHaveCount(0);
        await expect(panel.locator('.agent-approval-notice')).toContainText('edit_file');
        await panel.locator('.agent-approval-notice button').click();
        await expect(page.locator('.transcript-pane .approval-source')).toContainText('explore');
        await expect(page.locator('.transcript-pane .approval-card')).toBeVisible();
        await page.locator('.approval-source button').click();
        await expect(panel).toBeVisible();
        if (width>900) {
            await page.locator('#surface-tab-agents').dragTo(page.locator('.dock-tabs.side'));
            await expect(panel).toHaveClass(/panel-side/);
            await expect(panel).toBeVisible();
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.transcript-pane')).toBeVisible();
        }
        await post(page,{type:'approvalResolved',approval_id:'child-approval'});
        await post(page,{type:'subagentState',callId:'parent-a',trace:trace('done',{endedAt:Date.now(),report:'Expiry confirmed'})});
        await post(page,{type:'toolResult',tool:'task',callId:'parent-a',output:'Expiry confirmed'});
        await post(page,{type:'toolResult',tool:'task',callId:'parent-b',output:'Tests implemented'});
        await post(page,{type:'fullResponse',persian:'Final parent answer'});
        if (width===420) await page.locator('#surface-tab-agents').click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden) .agent-run-heading')).toContainText('Trace session expiry');
        await expect(panel.locator('.icon-btn-mini, .msg-footer')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveValue('Keep my draft');
        expect(await panel.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
        await panel.locator('.agent-view-tabs button').nth(1).click();
        await expect(panel.locator('.agent-run-view:not(.panel-hidden)')).toContainText('Checking expiry before editing.');
        if (process.env.XRATU_SCREENSHOTS) await page.screenshot({path:`/tmp/xratu-agents-${locale}-${width}.png`});
    });
}
for (const locale of ['en','fa']) for (const width of [420,1080]) {
    test(`background jobs: handoff, output, failure, stop-all and read-only Activity (${locale}, ${width})`, async ({page}) => {
        await page.setViewportSize({width,height:900});await post(page,{type:'locale',locale});
        await page.locator('.composer-input').fill('Keep drafting while the server runs');
        await post(page,{type:'startResponse'});
        await post(page,{type:'toolCall',tool:'run_terminal_command',args:JSON.stringify({command:'npm run dev -- --host localhost --port 5173'}),callId:'cmd'});
        await post(page,{type:'toolOutput',callId:'cmd',value:'Starting server\n'});
        await page.locator('.transcript-pane .icon-btn-mini').click();
        expect(await sent(page)).toContainEqual({type:'backgroundTerminal',callId:'cmd'});
        await post(page,{type:'terminalBackgrounded',callId:'cmd',jobId:'job',byUser:true});
        await post(page,{type:'toolResult',tool:'run_terminal_command',callId:'cmd',output:'Started background job job'});
        await post(page,{type:'backgroundJobs',jobs:[{jobId:'job',command:'npm run dev -- --host localhost --port 5173',running:true,uptimeSeconds:65},{jobId:'watch',command:'npm run watch',running:true,uptimeSeconds:12}]});
        await post(page,{type:'fullResponse',persian:'Server is running'});
        await post(page,{type:'backgroundJobOutput',jobId:'job',output:'Ready at http://localhost:5173\nHot reload connected'});
        const runningPill=page.locator('.transcript-pane details.step'); await runningPill.locator(':scope > summary').click();
        await expect(runningPill.locator('.detail-terminal .detail-output')).toContainText('Hot reload connected');
        await expect(page.locator('.transcript-pane .completed-steps')).toHaveCount(0);
        await page.locator('#surface-tab-background').click();
        await expect(page.locator('.background-pane')).toBeVisible();
        await expect(page.locator('.background-output')).toContainText('Hot reload connected');
        await expect(page.locator('.bg-job')).toHaveCount(2);
        const initialUptime = await page.locator('.bg-job-up').first().textContent();
        await expect.poll(()=>page.locator('.bg-job-up').first().textContent()).not.toBe(initialUptime);
        await page.locator('.bg-job-copy').first().click();
        expect(await sent(page)).toContainEqual({type:'copyToClipboard',value:'npm run dev -- --host localhost --port 5173'});
        const streamed=Array.from({length:180},(_,index)=>`line ${index}: hot reload output`).join('\n');
        await post(page,{type:'backgroundJobOutput',jobId:'job',output:streamed});
        const log=page.locator('.background-task-detail:not(.panel-hidden) .background-output');
        await expect.poll(()=>log.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(1);
        // A real wheel gesture, not a dispatched `scroll` event: the follow
        // state is driven by the browser's own scrolling, and waiting for the
        // scroll to actually land keeps the assertion off a pane that never
        // moved (which reads as "still following" on a loaded runner).
        await log.hover(); await page.mouse.wheel(0,-20_000);
        await expect.poll(()=>log.evaluate(el=>el.scrollTop)).toBe(0);
        const follow=page.locator('.background-task-detail:not(.panel-hidden) .background-follow');
        await expect(follow).toHaveAttribute('aria-pressed','false');
        const newer=streamed+'\nnew output while reading history';
        await post(page,{type:'backgroundJobOutput',jobId:'job',output:newer});
        await expect(log).toContainText('new output while reading history');
        expect(await log.evaluate(el=>el.scrollTop)).toBe(0);
        await post(page,{type:'backgroundJobs',jobs:[{jobId:'job',command:'npm run dev -- --host localhost --port 5173',running:true,uptimeSeconds:66},{jobId:'watch',command:'npm run watch',running:true,uptimeSeconds:13}]});
        await expect(log).toHaveText(newer);
        await follow.click(); await expect.poll(()=>log.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(1);
        await page.locator('.background-task-detail:not(.panel-hidden) .background-log-bar .bg-job-copy').click();
        expect(await sent(page)).toContainEqual({type:'copyToClipboard',value:newer});
        if(width>900){
            await page.locator('#surface-tab-background').dragTo(page.locator('.dock-tabs.side'));
            await expect(page.locator('.background-pane')).toHaveClass(/panel-side/);
            await expect(log).toHaveText(newer);
            await page.locator('#surface-tab-conversation').click();
            await expect(page.locator('.background-pane')).toBeVisible();
            await expect(page.locator('.transcript-pane')).toBeVisible();
        }
        await expect(page.locator('.composer .bg-jobs')).toHaveCount(0);
        await expect(page.locator('.composer-input')).toHaveValue('Keep drafting while the server runs');
        if(process.env.XRATU_SCREENSHOTS) await page.screenshot({path:`/tmp/xratu-background-${locale}-${width}.png`});
        await page.locator('.bg-jobs-stopall').click();
        expect(await sent(page)).toContainEqual({type:'killBackgroundJob',jobId:'job'});
        expect(await sent(page)).toContainEqual({type:'killBackgroundJob',jobId:'watch'});
        await page.locator('#surface-tab-activity').click();
        await expect(page.locator('.activity-pane .icon-btn-mini')).toHaveCount(0);
        await post(page,{type:'backgroundJobFinished',jobId:'job',status:'exited',exitCode:2,output:'Exit code: 2\nSTDOUT:\n(empty)\nSTDERR:\nPort already in use'});
        await post(page,{type:'backgroundJobs',jobs:[{jobId:'job',command:'npm run dev -- --host localhost --port 5173',running:false,status:'exited',exitCode:2,uptimeSeconds:66,output:'Port already in use'},{jobId:'watch',command:'npm run watch',running:true,uptimeSeconds:13}]});
        const pill=page.locator('.activity-pane details.step'); await pill.locator(':scope > summary').click();
        await expect(pill.locator('.detail-terminal .detail-output')).toHaveText('Port already in use');
        await expect(pill.locator('.detail-exit')).toContainText('2');
        await expect(page.locator('.bg-job')).toHaveCount(2);
        await page.locator('#surface-tab-background').click();
        await page.locator('.background-task-select').first().click();
        await expect(page.locator('.background-task-detail:not(.panel-hidden) .background-exit')).toContainText('2');
        await expect(page.locator('.background-task').first().locator('.bg-job-stop')).toHaveCount(0);
        await expect(page.locator('.bg-job-stop')).toHaveCount(1);
        await post(page,{type:'backgroundJobStopped',jobId:'watch'});
        await post(page,{type:'backgroundJobs',jobs:[]});
        await expect(page.locator('.bg-jobs')).toHaveCount(0);
        expect((await sent(page)).filter(m=>m.type==='askQuestion')).toHaveLength(0);
    });
}
for (const locale of ['en','fa']) {
    test(`current-state tooltips describe mode and permission semantics (${locale})`, async ({page}) => {
        await post(page,{type:'locale',locale});
        const mode=page.locator('[data-policy="mode"]'), permission=page.locator('[data-policy="approval"]');
        await expect(mode).toHaveAttribute('title',/Build/);
        await expect(permission).not.toHaveAttribute('title',/YOLO/);
        const build=await mode.getAttribute('title'), ask=await permission.getAttribute('title');
        await post(page,{type:'planMode',enabled:true});await post(page,{type:'yoloMode',enabled:true});
        await expect(mode).toHaveAttribute('title',/Plan/);
        expect(await mode.getAttribute('title')).not.toBe(build);
        expect(await permission.getAttribute('title')).not.toBe(ask);
        await mode.click(); await expect(page.locator('.composer-policy-menu')).not.toHaveAttribute('aria-label',/read-only/);
    });
}

test('switching locale translates already-mounted child views without losing expansion', async ({page}) => {
    await post(page,{type:'startResponse'});
    await post(page,{type:'toolCall',tool:'task',args:JSON.stringify({subagent_type:'explore',description:'Trace session expiry'}),callId:'parent-a'});
    await post(page,{type:'subagentState',callId:'parent-a',trace:trace()});
    await page.locator('#surface-tab-agents').click();
    const view = page.locator('.agent-run-view:not(.panel-hidden)');
    await view.locator('.step > summary').first().click();
    await post(page,{type:'locale',locale:'fa'});
    await expect(view.locator('.agent-state-text')).toContainText('در حال کار');
    await expect(view.locator('.agent-view-tabs button').first()).toContainText('گفتگو');
    await expect(view.locator('.detail-arguments summary').first()).toContainText('آرگومان ها');
    await expect(view.locator('.step').first()).toHaveAttribute('open','');
});

for(const locale of ['en','fa']) {
    test(`recovered process explains missing output and stays stoppable (${locale})`, async({page})=>{
        await page.setViewportSize({width:420,height:900});await post(page,{type:'locale',locale});
        await post(page,{type:'backgroundJobs',jobs:[{jobId:'recovered',command:'npm run dev',running:true,uptimeSeconds:123,detached:true,pid:123,cwd:'C:\\project'}]});
        await page.locator('#surface-tab-background').click();
        await expect(page.locator('.background-output-empty')).toContainText('VS Code');
        await expect(page.locator('.background-output')).toHaveCount(0);
        await page.locator('.background-task-info > summary').click();
        await expect(page.locator('.background-task-info')).toContainText('C:\\project');
        await expect(page.locator('.background-task-info')).toContainText('PID 123');
        await page.locator('.bg-job-stop').click();
        expect(await sent(page)).toContainEqual({type:'killBackgroundJob',jobId:'recovered'});
    });
}

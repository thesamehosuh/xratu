import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { SessionCoordinator } = require('../out/sessions/coordinator.js');
const { FileCoordinatorStore } = require('../out/sessions/store.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const memory = () => ({ value: undefined, async load() { return structuredClone(this.value); }, async save(value) { this.value = structuredClone(value); } });

// A live driver cannot monopolize the command queue. Stop remains actionable.
{
 const started=deferred(); const store=memory(); const c=await SessionCoordinator.open(store,1);
 const child=await c.create('root','general','Interruptible',{async execute({signal,checkpoint}) {
  await checkpoint({committed:'before command'}); started.resolve();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  return 'Partial result';
 }});
 await c.send(child.id,'Start','parent','request-1'); await started.promise;
 await c.send(child.id,'Do not restart this after stop','user','request-2');
 await c.stop(child.id); const settled=await c.wait(child.id);
 assert.equal(settled.executions.length,1); assert.equal(settled.executions[0].state,'cancelled');
 assert.equal(settled.messages[1].state,'cancelled'); assert.deepEqual(settled.checkpoint,{committed:'before command'});
 await c.close();
}
// A checkpoint owns its input at submission, before command admission.
{
 const c=await SessionCoordinator.open(memory());
 const child=await c.create('root','general','Immutable checkpoint',{async execute({checkpoint}) {
  const value={rows:['committed']};const saved=checkpoint(value);
  value.rows[0]='mutated after submission';await saved;return 'done';
 }});
 await c.send(child.id,'Start','parent');
 assert.deepEqual((await c.wait(child.id)).checkpoint,{rows:['committed']});
 await c.close();
}
// Follow-ups preserve identity and cannot overlap. Duplicate receipts do not run twice.
{
 const gate=deferred(); const started=deferred(); let active=0; let peak=0; let runs=0;
 const store=memory(); const c=await SessionCoordinator.open(store,2);
 const child=await c.create('root','general','Follow-ups',{async execute({session,execution}) {
  active++; peak=Math.max(active,peak); runs++;
  if(runs===1){started.resolve();await gate.promise;}
  active--; return session.messages.filter(m=>execution.messageIds.includes(m.id)).map(m=>m.text).join('\n');
 }});
 await c.send(child.id,'First','parent','first'); await started.promise;
 await Promise.all([c.send(child.id,'Second','parent','second'),c.send(child.id,'Second','parent','second')]);
 await assert.rejects(c.send(child.id,'Changed','parent','second'),/different content/);
 gate.resolve(); const settled=await c.wait(child.id);
 assert.equal(peak,1); assert.equal(runs,2); assert.equal(settled.results[1].text,'Second');
 assert.equal(c.pendingResults('root').length,2);
 await c.acknowledge(child.id,settled.results[0].id); await c.acknowledge(child.id,settled.results[0].id);
 assert.equal(c.pendingResults('root').length,1);
 const view=c.list(); view[0].title='Tampered'; assert.equal(c.list()[0].title,'Follow-ups');
 await c.close(); const restored=await SessionCoordinator.open(store);
 assert.equal(restored.list()[0].results[0].state,'delivered');
 await assert.rejects(restored.send(child.id,'Third','user'),/reconnected/);
 restored.bind(child.id,{async execute(){return 'Third';}}); await restored.send(child.id,'Third','user');
 assert.equal((await restored.wait(child.id)).executions.length,3); await restored.close();
}
// Capacity, queued cancellation, and wait cancellation have different scopes.
{
 const gate=deferred(); const started=deferred(); let secondCalls=0;
 const c=await SessionCoordinator.open(memory(),1);
 const first=await c.create('root','explore','First',{async execute(){started.resolve();await gate.promise;return 'ok';}});
 const second=await c.create('root','explore','Second',{async execute(){secondCalls++;return 'ok';}});
 await c.send(first.id,'Work','parent'); await started.promise; await c.send(second.id,'Work','parent');
 const abort=new AbortController(); const wait=c.wait(first.id,abort.signal); abort.abort(); await assert.rejects(wait,{name:'AbortError'});
 await c.stop(second.id); gate.resolve(); await c.wait(first.id); await c.wait(second.id);
 assert.equal(secondCalls,0); assert.equal(c.list()[0].executions[0].state,'completed'); await c.close();
}
// Recovery never replays a running or queued mutation without a new instruction.
{
 const store=memory(); store.value={version:1,sessions:[{id:'child',parentId:'root',profile:'general',title:'Recover',createdAt:1,revision:1,generation:1,
  messages:[{id:'old',text:'Mutate',source:'parent',state:'queued'}],results:[],executions:[{id:'execution',generation:1,state:'running',messageIds:[]}]}]};
 const c=await SessionCoordinator.open(store);
 assert.equal(c.list()[0].executions[0].state,'interrupted'); assert.equal(c.list()[0].messages[0].state,'cancelled'); await c.close();
}
// Corrupt data and failed storage cannot silently become an empty conversation.
{
 const store=memory(); store.value={version:9,sessions:[]}; await assert.rejects(SessionCoordinator.open(store),/Unsupported/);
 const failing=memory(); const c=await SessionCoordinator.open(failing);
 failing.save=async()=>{throw new Error('disk full');};
 await assert.rejects(c.create('root','general','Not durable',{async execute(){throw new Error('must not execute');}}),/disk full/);
 await assert.rejects(c.create('root','general','Fenced',{}),/fenced/);
}
// Real file persistence, replacement, and unreadable snapshots.
{
 const dir=await mkdtemp(join(tmpdir(),'xratu-coordinator-'));
 try {
  const file=join(dir,'sessions.json'); const store=new FileCoordinatorStore(file); const c=await SessionCoordinator.open(store);
  const child=await c.create('root','explore','Stored',{async execute(){return 'Durable result';}});
  await c.send(child.id,'Investigate','user'); await c.wait(child.id); await c.close();
  const restored=await SessionCoordinator.open(new FileCoordinatorStore(file)); assert.equal(restored.list()[0].results[0].text,'Durable result'); await restored.close();
  await writeFile(file,'{broken'); await assert.rejects(SessionCoordinator.open(new FileCoordinatorStore(file)));
 } finally {await rm(dir,{recursive:true,force:true});}
}
console.log('Session coordinator: ownership, follow-ups, cancellation, delivery, recovery, and storage passed');

// Two coordinators cannot adopt the same family even in the same OS process.
{
 const dir=await mkdtemp(join(tmpdir(),'xratu-session-owner-'));
 try {
  const file=join(dir,'family.json'); const first=await SessionCoordinator.open(new FileCoordinatorStore(file));
  await assert.rejects(SessionCoordinator.open(new FileCoordinatorStore(file)),/another active coordinator/);
  await first.close(); const next=await SessionCoordinator.open(new FileCoordinatorStore(file)); await next.close();
 } finally { await rm(dir,{recursive:true,force:true}); }
}
// A committed tool intent without its result is repaired as uncertain, not re-executed.
{
 const {recoverChildHistory}=require('../out/sessions/subagents.js');
 const healed=recoverChildHistory({defName:'general',startedAt:1,rows:[{role:'user',content:'Work'},
  {role:'assistant',content:'',tool_calls:[{id:'a',type:'function',function:{name:'edit_file',arguments:'{}'}}]}],running:true});
 assert.equal(healed.rows.at(-1).tool_call_id,'a'); assert.equal(healed.rows.at(-1).isError,true); assert.equal(healed.running,false);
}
// Drive the actual built-in loop through the durable coordinator and resume after reload.
{
 const {createSubagentRunner}=require('../out/local/subagentRunner.js');
 const {builtinSubagents}=require('../out/subagents.js');
 const dir=await mkdtemp(join(tmpdir(),'xratu-real-child-')); const original=globalThis.fetch; const requests=[];
 try {
  globalThis.fetch=async(_url,init)=>{
   requests.push(JSON.parse(init.body));
   const bytes=new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta:{content:'Verified child result'}}]})}\n\ndata: [DONE]\n\n`);
   return {ok:true,status:200,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};
  };
  const context=()=>({store:new FileCoordinatorStore(join(dir,'family.json')),parentSessionId:'root',connectionId:'connection',
   baseRequest:def=>({baseUrl:'https://example.invalid/v1',apiKey:'test',model:def.model??'test-model',apiStyle:'chat',contextWindow:def.model?8192:100000}),
   tools:()=>[],systemPrompt:()=> 'Follow the assignment',executor:()=>({execute:async()=>({output:'ok'})}),approvalGate:{requestApproval:async()=>({})}});
  const registry=new Map(); const runner=createSubagentRunner(context(),builtinSubagents(),registry);
  const result=await runner.run({subagentType:'general',description:'Real child',prompt:'Find the cause'});
  assert.equal(result.isError,false); const session=(await runner.sessions())[0]; const id=session.id;
  await assert.rejects(runner.configureChild(id,{model:'bad',effort:'low',rounds:0,revision:session.revision}),/Invalid/);
  await assert.rejects(runner.configureChild(id,{model:'bad',effort:'low',rounds:6,revision:session.revision-1}),/changed/);
  await runner.configureChild(id,{model:'replacement-model',effort:'low',rounds:6,revision:session.revision});
  const {closeSubagentRunner}=require('../out/local/subagentRunner.js'); await closeSubagentRunner(registry);
  const restoredRegistry=new Map(); const restored=createSubagentRunner(context(),builtinSubagents(),restoredRegistry);
  const resumed=await restored.run({taskId:id,subagentType:'',description:'',prompt:'Now check Windows'});
  assert.equal(resumed.isError,false); assert.equal((await restored.sessions()).length,1);
  assert.equal(requests.at(-1).model,'replacement-model');
  assert.ok(JSON.stringify(requests.at(-1)).includes('Find the cause')); assert.ok(JSON.stringify(requests.at(-1)).includes('Now check Windows'));
  await closeSubagentRunner(restoredRegistry);
 } finally { globalThis.fetch=original; await rm(dir,{recursive:true,force:true}); }
}
console.log('Session coordinator real-loop integration and cross-window ownership passed');

// Unsupported restriction syntax cannot turn into an unrestricted profile.
{
 const {parseSubagentDefinition,discoverSubagents}=require('../out/subagents.js');
 assert.ok(parseSubagentDefinition('---\ndescription: review\ntools:\n  - read_file\n---\nReview').error);
 assert.ok(parseSubagentDefinition('---\ndescription: review\ntools: [read_file]\n---\nReview').error);
 const dir=await mkdtemp(join(tmpdir(),'xratu-profile-restrictions-'));
 try {
  const {mkdir}=await import('node:fs/promises'); const agents=join(dir,'.xratu','agents'); await mkdir(agents,{recursive:true});
  await writeFile(join(agents,'reviewer.md'),'---\ndescription: review\ntools:\n  - read_file\n---\nReview');
  assert.ok(discoverSubagents({workspaceRoot:dir,homedir:dir,validation:{toolNames:new Set(['read_file'])}}).find(agent=>agent.name==='reviewer').error);
 } finally {await rm(dir,{recursive:true,force:true});}
}

// Parent orchestration can launch, instruct an active child, then await both executions.
{
 const {createSubagentRunner,closeSubagentRunner}=require('../out/local/subagentRunner.js');
 const {builtinSubagents,filterToolsForSubagent}=require('../out/subagents.js');
 const {sessionToolDefinitions}=require('../out/sessions/tools.js');
 const {isAvailableTool}=require('../out/tooling/toolPolicy.js');
 const {executeSessionTool,SESSION_TOOLS}=require('../out/sessions/tools.js');
 const definitions=sessionToolDefinitions(builtinSubagents());
 for(const name of SESSION_TOOLS) {
  assert.ok(definitions.some(tool=>tool.name===name));
  assert.equal(isAvailableTool(name,true),false);
  assert.ok(!filterToolsForSubagent(definitions,{tools:[name,'read_file']}).some(tool=>tool.name===name));
 }
 const store=memory(); const registry=new Map(); const original=globalThis.fetch; const requests=[]; const gate=deferred(); const started=deferred();
 try {
  globalThis.fetch=async(_url,init)=>{
   requests.push(JSON.parse(init.body)); if(requests.length===1){started.resolve();await gate.promise;}
   const bytes=new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta:{content:'Result '+requests.length}}]})}\n\ndata: [DONE]\n\n`);
   return {ok:true,status:200,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};
  };
  const runner=createSubagentRunner({store,parentSessionId:'root',baseRequest:()=>({baseUrl:'https://example.invalid/v1',apiKey:'test',model:'test-model',apiStyle:'chat',contextWindow:100000}),tools:()=>[],systemPrompt:()=> 'Complete the assignment',executor:()=>({execute:async()=>({output:'ok'})}),approvalGate:{requestApproval:async()=>({})}},builtinSubagents(),registry);
  const launch=await runner.run({subagentType:'general',description:'Parallel investigation',prompt:'Investigate',parentCallId:'launch-receipt',background:true});
  const id=JSON.parse(launch.output).session_id; await started.promise;
  const retried=await runner.run({subagentType:'general',description:'Parallel investigation',prompt:'Investigate',parentCallId:'launch-receipt',background:true});
  assert.equal(JSON.parse(retried.output).session_id,id);
  assert.equal((await runner.sessions()).length,1);
  assert.equal((await runner.sessions())[0].messages.length,1);
  const sent=await executeSessionTool('send_agent',{session_id:id,prompt:'Also verify Windows'},runner,'follow-up');
  assert.equal(JSON.parse(sent.output).session_id,id); gate.resolve();
  const report=await executeSessionTool('wait_agents',{session_ids:[id]},runner);
  const sessions=JSON.parse(report.output); assert.equal(sessions.length,1); assert.equal(sessions[0].results.length,1);
  assert.equal(sessions[0].results[0].text.includes('Result 2'),true);
  assert.equal('checkpoint' in sessions[0],false);
  assert.equal(report.output.includes('providerBlocks'),false);
  assert.ok(JSON.stringify(requests[1]).includes('Also verify Windows'));
  assert.ok(JSON.stringify(requests[1]).includes('Investigate'));
  await closeSubagentRunner(registry);
 } finally {globalThis.fetch=original;}
}
// Parent Stop cancels its foreground wait, not the durable execution.
// Streaming text is published to the child surface before a final checkpoint.
{
 const {createSubagentRunner,closeSubagentRunner}=require('../out/local/subagentRunner.js');
 const {builtinSubagents}=require('../out/subagents.js');
 const {childSessionView}=require('../out/sessions/view.js');
 const parent=new AbortController(),seen=deferred(),finish=deferred();const registry=new Map();let childSignal;
 const original=globalThis.fetch;let runner;
 try {
  globalThis.fetch=async(_url,init)=>{
   childSignal=init.signal;let sent=false;
   return new Response(new ReadableStream({async pull(controller){
    if(!sent){sent=true;controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Live child output"}}]}\n\n'));return;}
    await finish.promise;controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();
   }}),{headers:{'content-type':'text/event-stream'}});
  };
  runner=createSubagentRunner({store:memory(),parentSessionId:'root',baseRequest:()=>({baseUrl:'https://example.invalid/v1',model:'test',signal:parent.signal}),
   tools:()=>[],systemPrompt:()=> 'Work',executor:()=>({execute:async()=>({output:'ok'})}),approvalGate:{requestApproval:async()=>({})},
   onSessions:sessions=>{if(sessions.some(child=>childSessionView(child).liveText?.includes('Live child output')))seen.resolve();}},builtinSubagents(),registry);
  const waiting=runner.run({subagentType:'general',description:'Independent child',prompt:'Work',parentCallId:'foreground'});
  let timer;await Promise.race([seen.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Child streaming output never reached its surface')),3000);})]).finally(()=>clearTimeout(timer));
  parent.abort();assert.equal((await waiting).isError,true);
  assert.equal(childSignal.aborted,false,'the child retains its own controller');
  const child=(await runner.sessions())[0];assert.equal(child.executions.at(-1).state,'running');
  finish.resolve();assert.equal((await runner.wait([child.id]))[0].executions.at(-1).state,'completed');
 } finally {finish.resolve();await closeSubagentRunner(registry);globalThis.fetch=original;}
}
console.log('Parent background launch, active follow-up, event-driven wait, and structural tool gates passed');

// A writer waiting on another window can be cancelled, without blocking later work.
{
 const {WorkspaceWriter,mutatesWorkspace}=require('../out/sessions/resources.js');
 const dir=await mkdtemp(join(tmpdir(),'xratu-checkout-writer-'));
 try {
  const file=join(dir,'checkout');const first=new WorkspaceWriter(file);const second=new WorkspaceWriter(file);
  const gate=deferred();const started=deferred();let overlap=0;let peak=0;
  const running=first.run(new AbortController().signal,async()=>{overlap++;peak=Math.max(peak,overlap);started.resolve();await gate.promise;overlap--;});
  await started.promise;const abort=new AbortController();let executed=false;
  const queued=second.run(abort.signal,async()=>{executed=true;});abort.abort();await assert.rejects(queued);
  gate.resolve();await running;
  await second.run(new AbortController().signal,async()=>{overlap++;peak=Math.max(peak,overlap);overlap--;});
  assert.equal(peak,1);assert.equal(executed,false);
  assert.equal(mutatesWorkspace('task'),false);assert.equal(mutatesWorkspace('spawn_agent'),false);
  assert.equal(mutatesWorkspace('run_terminal_command'),true);assert.equal(mutatesWorkspace('mcp__unknown__tool'),true);
  assert.equal(mutatesWorkspace('read_file'),false);
 } finally {await rm(dir,{recursive:true,force:true});}
}
console.log('Shared workspace writer arbitration and cancellation passed');

// Result receipt recovery follows actual tool ownership, never text in an unrelated tool/user row.
{
 const {committedChildResults}=require('../out/sessions/delivery.js');
 const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const rows=[{role:'assistant',tool_calls:[{id:'owned',function:{name:'wait_agents'}},{id:'foreign',function:{name:'mcp__remote__text'}}]},
  {role:'tool',tool_call_id:'owned',content:JSON.stringify([{results:[{id,executionId:id,sessionId:"child",text:"Report"}]}])}];
 assert.deepEqual(committedChildResults(rows),[id]);
 assert.deepEqual(committedChildResults([{role:'assistant',tool_calls:[{id:'owned',function:{name:'wait_agents'}}]}, {role:'tool',tool_call_id:'owned',content:JSON.stringify([{text:id}])}]),[]);
 assert.deepEqual(committedChildResults([{role:'assistant',tool_calls:[{id:'task',function:{name:'task'}}]}, {role:'tool',tool_call_id:'task',content:`Mention ${id} without a host receipt`}]),[]);
 assert.deepEqual(committedChildResults([{role:'user',content:id},{role:'tool',tool_call_id:'foreign',content:id}]),[]);
}

// Deleting a parent removes its child ledgers; clearing history also removes orphan families.
{
 const {LocalSessionStore}=require('../out/local/localSessionStore.js');
 const {randomUUID}=await import('node:crypto');const {access,readFile}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'xratu-family-deletion-'));
 try {
  const store=new LocalSessionStore(dir);const parent=await store.create(dir);const family=randomUUID();
  const file=join(dir,'children',`${family}.json`);const child=await SessionCoordinator.open(new FileCoordinatorStore(file));
  await child.create(family,'explore','Private child',{execute:async()=>''});await child.close();
  const sentinel=join(dir,'sentinel');await writeFile(sentinel,'keep');
  await store.save(parent.id,{model:null,summary:null,localHistory:[],uiHistory:[],researchConversationId:family,childFamilyIds:[family,'../sentinel']});
  assert.equal(await store.delete(parent.id),true);await assert.rejects(access(file));assert.equal(await readFile(sentinel,'utf8'),'keep');
  const orphanFile=join(dir,'children',`${randomUUID()}.json`);const orphan=new FileCoordinatorStore(orphanFile);await orphan.save({version:1,sessions:[]});await orphan.close();
  assert.equal(await store.clearChildFamilies(),0);await assert.rejects(access(orphanFile));
 } finally {await rm(dir,{recursive:true,force:true});}
}
console.log('Parent deletion, orphan cleanup, and child-storage path guards passed');

// Display projection keeps bounded tool identity, never provider replay carriers.
{
 const { childSessionView } = require('../out/sessions/view.js');
 const view = childSessionView({id:'child',title:'Display',profile:'explore',revision:1,generation:1,executions:[],messages:[],results:[],checkpoint:{rows:[
  {role:'assistant',content:'Inspecting',providerBlocks:{secretReplay:true},tool_calls:[{id:'call-1',function:{name:'read_file',arguments:'{"path":"sample.txt"}'}}]},
  {role:'tool',tool_call_id:'call-1',content:'Contents',isError:false},
 ]}});
 assert.equal(view.messages[0].toolCalls[0].name,'read_file');
 assert.equal(view.messages[1].toolCallId,'call-1');
 assert.equal(JSON.stringify(view).includes('secretReplay'),false);
}

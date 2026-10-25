import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
import {taskInput,setup,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import type {Row} from '../src/core/schema.ts';
import {AgentOrchestrator,type Launcher} from '../src/core/agent-orchestration.ts';
import type {AgentInvocationOptions,ClientRecord,ClientKind} from '../src/core/agent-clients.ts';
import {parseAgentOutput} from '../src/core/agent-output.ts';
import {projectHold} from '../src/core/project-hold.ts';
import {reviewAssignmentContext,startReview,submitReviewResult} from '../src/core/review-workflow.ts';
import {planningOriginLabel} from '../src/shared/planning-origin.ts';
import {projectTimelineGraph} from '../src/shared/project-timeline.ts';
import {normalizeTokenMonitorDetails} from '../src/core/token-monitor-usage.ts';

async function isolated(){const base=process.env.PROJECT_MANAGEMENT_TEST_ROOT||path.join(ROOT,'.test-tmp','project-management-boundaries');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'api-'));const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};seedTestData(new Workbench(config)).close();return {root,config,...await createApp(config,{background:false})};}
async function page(f:Awaited<ReturnType<typeof isolated>>){const host='127.0.0.1:'+f.config.port,boot=await f.app.inject({url:'/api/bootstrap',headers:{host}});return {host,cookie:String(boot.headers['set-cookie']).split(';')[0],'x-workbench-csrf':boot.json().csrf as string};}
function fingerprint(wb:Workbench){const tables=wb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];return crypto.createHash('sha256').update(JSON.stringify(tables.map(t=>[t.name,wb.db.prepare('SELECT * FROM "'+t.name.replaceAll('"','""')+'" ORDER BY rowid').all()]))).digest('hex');}
function plan(root:string,q:Row,patch:Row={}){return {schema_version:1,plan_id:'chat-test-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(root),...patch}]};}
function barrier(){let release!:()=>void;return {promise:new Promise<void>(r=>{release=r;}),release:()=>release()};}
async function until(check:()=>boolean,label:string){const deadline=Date.now()+4000;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(check(),label);}
function routed(f:Awaited<ReturnType<typeof isolated>>){f.wb.put('agents',{...f.wb.get('agents','claude'),id:'hold-test-executor',preset_id:'claude-code',name:'隔离暂停测试执行者',allowed_kinds:['engineering','review'],archived:false});const q=f.wb.request({project_id:'P-workbench',text:'隔离启动竞态测试，不启动真实进程'}),p=f.wb.submitPlan(plan(f.root,q,{agent_id:'hold-test-executor',execution_route:{client:'claude',model:'synthetic-hold'},context_contract:{required:[],supplemental:[],output_dir:path.join(f.root,'outputs'),max_bytes:65536}})),tid=p.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;return {tid,rid};}
function hold(wb:Workbench,shelved:boolean){const p=wb.get('projects','P-workbench');return projectHold(wb,p.id,{version:p.version,shelved});}
function syntheticClients(hooks:{resolve?:()=>Promise<void>;build?:()=>Promise<void>}={}){return {async resolve(_dir:string,kind:ClientKind):Promise<ClientRecord>{await hooks.resolve?.();return {kind,label:'隔离假客户端',status:'verified',reason:'不运行真实客户端',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown'};},async build(_client:ClientRecord,_options:AgentInvocationOptions){await hooks.build?.();return {command:'SYNTHETIC-NOT-EXECUTED',args:[]};},async discover(){return [];}};}

test('insights reads legacy job summary and Token Monitor session view without writing or double counting',async()=>{
  const f=await isolated();try{const s=setup(f.wb,f.root),headers=await page(f),j={id:'AJ-'+crypto.randomUUID(),project_id:'P-workbench',task_id:s.tid,run_id:s.rid,role:'review',route:{client:'dsh',model:'synthetic'},session_id:'session-metered',status:'completed',started_at:'2026-10-25T10:00:00Z',ended_at:'2026-10-25T11:00:00Z',usage:{scope:'invocation_steps',totalTokens:110,inputTokens:5,outputTokens:5,cacheReadTokens:100}};
    f.wb.put('agent_jobs',j,{run_id:s.rid});const detail=normalizeTokenMonitorDetails({updatedAt:'2026-10-25T12:00:00Z',periods:{month:{sessions:{sample:{client:'dsh',sessionId:'session-metered',totalTokens:110,inputTokens:5,outputTokens:5,cacheReadTokens:100}}}}});
    f.wb.put('integrations',{...f.wb.get('integrations','tokenMonitor'),status:'connected',snapshot:{usage_details:detail}});
    const before=fingerprint(f.wb),res=await f.app.inject({url:'/api/projects/P-workbench/insights',headers});assert.equal(res.statusCode,200);const result=res.json();assert.equal(result.usage.subtotal.total_tokens,110);assert.equal(result.usage.coverage.total_tokens.complete_jobs,0);assert.equal(result.token_monitor.periods.month.summary.total_tokens,110);assert.equal(result.token_monitor.periods.month.matched_sessions,1);assert.equal(result.token_monitor.periods.allTime.summary.total_tokens,null);assert.equal(fingerprint(f.wb),before);
    const filtered=(await f.app.inject({url:'/api/projects/P-workbench/insights?from=2026-10-25T10%3A30%3A00Z',headers})).json();assert.equal(filtered.usage.subtotal.total_tokens,null);assert.equal(filtered.token_monitor.periods.month.summary.total_tokens,110,'session window is explicitly independent of call filters');assert.equal(fingerprint(f.wb),before);
  }finally{await f.app.close();}
});

test('chat_planner can read planning context and submit, but cannot dispatch, report, read files or manage',async()=>{
  const f=await isolated();try{const s=setup(f.wb,f.root),q=f.wb.request({project_id:'P-workbench',text:'隔离聊天规划权限边界'}),host='127.0.0.1:'+f.config.port;
    const call=(tool:string,payload:Row)=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+f.wb.keys.chat_planner},payload});
    const before=fingerprint(f.wb),context=await call('get_chat_planning_context',{request_id:q.id});assert.equal(context.statusCode,200);assert.equal(context.json().request.id,q.id);assert.equal(fingerprint(f.wb),before,'context must not mutate any table');
    for(const tool of ['dispatch_run','dispatch_review','continue_run','report_run_event','submit_run_result','get_run_context','read_run_context_file','get_project_context','get_dispatch_context','get_agent_clients','export_execution_order','register_delegation','report_delegation','get_agent_job','submit_review_result','update_request','accept_task']){
      const response=await call(tool,{run_id:s.rid,task_id:s.tid,project_id:'P-workbench',request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision});assert.equal(response.statusCode,403,tool);assert.equal(fingerprint(f.wb),before,tool+' must not mutate any table');
    }
    const submitted=await call('submit_task_plan',plan(f.root,q));assert.equal(submitted.statusCode,200);assert.equal(submitted.json().task_ids.length,1);assert.equal(f.wb.all('agent_jobs').length,0);
  }finally{await f.app.close();}
});
test('chat preview rolls back every DB table including audit; stale version and duplicate import are safe',async()=>{
  const f=await isolated();try{const headers=await page(f),q=f.wb.request({project_id:'P-workbench',text:'隔离预览和幂等导入'}),proposal=plan(f.root,q),body={text:'```json\n'+JSON.stringify(proposal)+'\n```'};
    const call=(url:string,payload:Row)=>f.app.inject({method:'POST',url,headers,payload}),before=fingerprint(f.wb);
    const preview=await call('/api/plans/chat-preview',body);assert.equal(preview.statusCode,200);assert.equal(preview.json().saved,false);assert.equal(fingerprint(f.wb),before);
    const stale=await call('/api/plans/chat-preview',{text:JSON.stringify({...proposal,expected_version:q.version+1})});assert.equal(stale.statusCode,409);assert.equal(fingerprint(f.wb),before);
    const imported=await call('/api/plans/chat-import',body);assert.equal(imported.statusCode,200);const saved=fingerprint(f.wb);assert.equal((await call('/api/plans/chat-import',body)).statusCode,200);assert.equal(fingerprint(f.wb),saved);assert.equal(f.wb.all('tasks').length,1);
    assert.equal((await call('/api/plans/chat-import',{text:JSON.stringify({...proposal,tasks:[{...proposal.tasks[0],title:'相同编号冲突计划'}]})})).statusCode,409);assert.equal(fingerprint(f.wb),saved);
  }finally{await f.app.close();}
});
test('review skip and light review stay bound to explicit user request, not planner choices',async()=>{
  const f=await isolated();try{const headers=await page(f),send=(q:Row,patch:Row)=>f.app.inject({method:'POST',url:'/api/plans/chat-import',headers,payload:{text:JSON.stringify(plan(f.root,q,patch))}});
    const standard=f.wb.request({project_id:'P-workbench',text:'普通需求不能由规划者免审'}),before=fingerprint(f.wb);assert.equal((await send(standard,{reviewer_id:null})).statusCode,400);assert.equal(fingerprint(f.wb),before);
    const skip=f.wb.request({project_id:'P-workbench',text:'用户明确不安排此次独立审查',review_mode:'not_requested',review_note:'隔离测试确认无需此次审查'});assert.equal((await send(skip,{reviewer_id:'grok-build'})).statusCode,400);const allowed=await send(skip,{reviewer_id:null});assert.equal(allowed.statusCode,200);assert.equal(f.wb.get('tasks',allowed.json().task_ids[0]).review_policy.source,'user_requested');
    assert.throws(()=>f.wb.request({project_id:'P-workbench',text:'有限审查必须有检查点',review_mode:'light'}),/检查点/);
    const light=f.wb.request({project_id:'P-workbench',text:'只检查指定的隔离边界',review_mode:'light',review_focus:['验证本次权限边界']});assert.equal((await send(light,{reviewer_id:null})).statusCode,400);const result=await send(light,{});assert.equal(result.statusCode,200);const task=f.wb.get('tasks',result.json().task_ids[0]);assert.equal(task.review_policy.mode,'light');assert.deepEqual(task.review_policy.focus,['验证本次权限边界']);
  }finally{await f.app.close();}
});
test('small requests reject oversized plans via preview, import and chat_planner, with no partial writes',async()=>{
  const f=await isolated();try{const headers=await page(f),q=f.wb.request({project_id:'P-workbench',text:'小需求只需少量交付',workflow_kind:'small'}),proposal={...plan(f.root,q),tasks:Array.from({length:4},(_,i)=>taskInput(f.root,'task_'+i))},before=fingerprint(f.wb);
    for(const url of ['/api/plans/chat-preview','/api/plans/chat-import'])assert.equal((await f.app.inject({method:'POST',url,headers,payload:{text:JSON.stringify(proposal)}})).statusCode,400);
    assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/submit_task_plan',headers:{host:headers.host,authorization:'Bearer '+f.wb.keys.chat_planner},payload:proposal})).statusCode,400);assert.equal(fingerprint(f.wb),before);
  }finally{await f.app.close();}
});
test('project hold preserves a running Task and queued jobs, blocks new dispatch and continuation, and resumes explicitly',async()=>{
  const f=await isolated();try{const s=setup(f.wb,f.root);assert.equal(f.wb.event(event(f.root,s.tid,s.rid,1)).disposition,'applied');const headers=await page(f),project=f.wb.get('projects','P-workbench'),taskBefore=JSON.stringify(f.wb.get('tasks',s.tid)),runBefore=JSON.stringify(f.wb.get('runs',s.rid));
    const queued={id:'AJ-'+crypto.randomUUID(),project_id:project.id,task_id:s.tid,run_id:s.rid,role:'execution',phase:'execution',status:'queued',revision:1,route:{client:'claude',model:'synthetic-never-launched'},created_at:new Date().toISOString(),session_mode:'new'};f.wb.put('agent_jobs',queued,{run_id:s.rid});
    const held=await f.app.inject({method:'POST',url:'/api/projects/'+project.id+'/hold',headers,payload:{version:project.version,shelved:true}});assert.equal(held.statusCode,200);assert.equal(JSON.stringify(f.wb.get('tasks',s.tid)),taskBefore);assert.equal(JSON.stringify(f.wb.get('runs',s.rid)),runBefore);assert.equal(f.wb.get('agent_jobs',queued.id).status,'queued');
    const body={run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision};assert.throws(()=>f.agents.dispatchRun(body,{role:'user',source:'page'}),/暂缓|暂停/);assert.throws(()=>f.agents.continueRun(body,{role:'user',source:'page'}),/暂缓|暂停/);assert.throws(()=>f.wb.exportOrder(s.tid,1),/暂缓|暂停/);
    let calls=0;const owned=f.agents as any,prior=owned.run;owned.run=async()=>{calls++;};await owned.tick();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(f.wb.get('agent_jobs',queued.id).status,'queued');
    const p=f.wb.get('projects',project.id),resumed=await f.app.inject({method:'POST',url:'/api/projects/'+p.id+'/hold',headers,payload:{version:p.version,shelved:false}});assert.equal(resumed.statusCode,200);await owned.tick();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,1,'resuming schedules the existing queue once');owned.run=prior;
    assert.equal(JSON.stringify(f.wb.get('tasks',s.tid)),taskBefore);assert.equal(f.wb.get('agent_jobs',queued.id).status,'queued');
  }finally{await f.app.close();}
});
test('new user-only management routes require page cookie plus CSRF and reject mixed scoped identity',async()=>{
  const f=await isolated();try{const headers=await page(f),q=f.wb.request({project_id:'P-workbench',text:'管理接口页面身份验证'}),payload={text:JSON.stringify(plan(f.root,q))};
    for(const url of ['/api/plans/chat-preview','/api/plans/chat-import']){
      assert.equal((await f.app.inject({method:'POST',url,headers:{host:headers.host,authorization:'Bearer '+f.wb.keys.chat_planner},payload})).statusCode,401);
      assert.equal((await f.app.inject({method:'POST',url,headers:{host:headers.host,cookie:headers.cookie},payload})).statusCode,403);
      assert.equal((await f.app.inject({method:'POST',url,headers:{...headers,authorization:'Bearer '+f.wb.keys.chat_planner},payload})).statusCode,403);
    }
    assert.equal(f.wb.all('plans').length,0);assert.equal(f.wb.all('tasks').length,0);
  }finally{await f.app.close();}
});
test('runner delegation API is scoped to its own current Run and a project hold permits only existing receipts',async()=>{
  const f=await isolated();try{const q=f.wb.request({project_id:'P-workbench',text:'隔离执行者委派API边界'}),proposal=plan(f.root,q,{execution_policy:{allow_subagents:true,child_models:['gpt-6-luna'],max_calls:2,max_concurrency:1,max_depth:1}}),saved=f.wb.submitPlan(proposal),tid=saved.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;
    assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');const other=setup(f.wb,f.root),host='127.0.0.1:'+f.config.port,token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',rid+'.json'),'utf8')).token;
    const call=(tool:string,payload:Row)=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+token},payload});
    const input={run_id:rid,request_id:crypto.randomUUID(),model:'gpt-6-luna',goal:'隔离API验证，无真实子代理执行',parent_id:null,required_files:[],allowed_paths:[f.root],output_dir:f.root,context_bytes:1024};
    assert.ok([401,403].includes((await call('register_delegation',{...input,run_id:other.rid})).statusCode));const response=await call('register_delegation',input);assert.equal(response.statusCode,200);const delegation=response.json();assert.equal(delegation.source,'executor_reported');assert.equal((await call('register_delegation',input)).json().id,delegation.id);assert.equal(f.wb.all('delegations').length,1);
    assert.ok([401,403].includes((await call('report_delegation',{run_id:other.rid,delegation_id:delegation.id,status:'completed'})).statusCode));assert.equal((await call('report_delegation',{run_id:rid,delegation_id:delegation.id,status:'running',actual_model:'gpt-6-astra'})).statusCode,403);
    const headers=await page(f),project=f.wb.get('projects','P-workbench');assert.equal((await f.app.inject({method:'POST',url:'/api/projects/'+project.id+'/hold',headers,payload:{version:project.version,shelved:true}})).statusCode,200);
    assert.equal((await call('register_delegation',{...input,request_id:crypto.randomUUID()})).statusCode,409);assert.equal((await call('report_delegation',{run_id:rid,delegation_id:delegation.id,status:'completed',actual_model:'gpt-6-luna',summary:'仅隔离测试回执，无真实模型调用'})).statusCode,200);assert.equal(f.wb.all('agent_jobs').length,0);
  }finally{await f.app.close();}
});
for(const boundary of ['resolve','build','spawn'] as const)test('project hold at '+boundary+' boundary preserves the same queued job and resumes one synthetic launch',async()=>{
  const f=await isolated(),pause=barrier();let entered=false,spawns=0,launchers=0,o:AgentOrchestrator|undefined;
  try{const s=routed(f),wait=async()=>{if(!entered){entered=true;await pause.promise;}},clients=syntheticClients(boundary==='resolve'?{resolve:wait}:boundary==='build'?{build:wait}:{});
    const launcher:Launcher=async options=>{launchers++;if(boundary==='spawn')await wait();if(options.beforeSpawn&&!options.beforeSpawn())return {exitCode:null,signal:null,processStopped:true,deferred:true};spawns++;options.onSpawn?.(987654321);assert.equal(f.wb.event(event(f.root,s.tid,s.rid,1,'started',{identity:'hold-test-executor'})).disposition,'applied');assert.equal(f.wb.event(event(f.root,s.tid,s.rid,2,'blocked',{identity:'hold-test-executor',message:'隔离假进程完成回执'})).disposition,'applied');return {exitCode:0,signal:null,processStopped:true};};
    o=new AgentOrchestrator(f.wb,launcher,clients);const job=o.dispatchRun({run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision},{role:'user',source:'page'});await until(()=>entered,'must reach controlled '+boundary+' boundary');hold(f.wb,true);pause.release();
    await until(()=>f.wb.get('agent_jobs',job.job_id).status==='queued'&&!(o as any).launching.has(job.job_id),'paused call must return to durable queue');assert.equal(spawns,0);assert.equal(f.wb.get('agent_jobs',job.job_id).process_may_be_running,false);
    await (o as any).tick();await new Promise<void>(r=>setImmediate(r));assert.equal(spawns,0);hold(f.wb,false);await (o as any).tick();await until(()=>f.wb.get('agent_jobs',job.job_id).status==='completed','resumed synthetic call must complete');assert.equal(spawns,1);assert.equal(f.wb.all('agent_jobs').length,1);assert.equal(launchers,boundary==='spawn'?2:1);
  }finally{pause.release();await o?.close();await f.app.close();}
});
test('a project hold after process spawn accepts the existing receipt and never replays a completed call',async()=>{
  const f=await isolated(),finish=barrier();let entered=false,spawns=0,o:AgentOrchestrator|undefined;
  try{const s=routed(f),launcher:Launcher=async options=>{assert.ok(options.beforeSpawn?.());spawns++;options.onSpawn?.(987654321);assert.equal(f.wb.event(event(f.root,s.tid,s.rid,1,'started',{identity:'hold-test-executor'})).disposition,'applied');entered=true;await finish.promise;assert.equal(options.signal.aborted,false);options.onLine(JSON.stringify({type:'system',subtype:'init',session_id:'synthetic-held-session',model:'synthetic-hold'}));assert.equal(f.wb.event(event(f.root,s.tid,s.rid,2,'blocked',{identity:'hold-test-executor',message:'暂停后仍接收原调用真实协议回执'})).disposition,'applied');return {exitCode:0,signal:null,processStopped:true};};
    o=new AgentOrchestrator(f.wb,launcher,syntheticClients());const job=o.dispatchRun({run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision},{role:'user',source:'page'});await until(()=>entered,'synthetic process must start');hold(f.wb,true);assert.equal(f.wb.get('agent_jobs',job.job_id).status,'running');finish.release();await until(()=>f.wb.get('agent_jobs',job.job_id).status==='completed','held active call must retain its formal receipt');hold(f.wb,false);await (o as any).tick();await new Promise<void>(r=>setImmediate(r));assert.equal(spawns,1);assert.equal(f.wb.get('agent_jobs',job.job_id).session_id,'synthetic-held-session');
  }finally{finish.release();await o?.close();await f.app.close();}
});
test('hold reports legacy launching/running jobs through task ID and never changes them',async()=>{
  const f=await isolated();try{const s=setup(f.wb,f.root),jobs=['launching','running'].map(status=>({id:'AJ-'+crypto.randomUUID(),task_id:s.tid,run_id:s.rid,role:'execution',phase:'execution',status,revision:1,route:{client:'claude',model:'synthetic'},created_at:new Date().toISOString()}));for(const job of jobs)f.wb.put('agent_jobs',job,{run_id:s.rid});const before=jobs.map(j=>JSON.stringify(f.wb.get('agent_jobs',j.id))),result=hold(f.wb,true);assert.deepEqual(result.running_jobs.map(j=>j.id).sort(),jobs.map(j=>j.id).sort());assert.deepEqual(jobs.map(j=>JSON.stringify(f.wb.get('agent_jobs',j.id))),before);
  }finally{await f.app.close();}
});
test('held durable queue survives orchestrator restart while uncertain launching calls are never replayed',async()=>{
  const f=await isolated();let o:AgentOrchestrator|undefined,spawns=0;try{const s=setup(f.wb,f.root),queued={id:'AJ-'+crypto.randomUUID(),task_id:s.tid,run_id:s.rid,role:'execution',phase:'execution',status:'queued',revision:1,route:{client:'claude',model:'synthetic'},created_at:new Date().toISOString()},uncertain={...queued,id:'AJ-'+crypto.randomUUID(),status:'launching',process_may_be_running:true};for(const j of [queued,uncertain])f.wb.put('agent_jobs',j,{run_id:s.rid});hold(f.wb,true);o=new AgentOrchestrator(f.wb,async()=>{spawns++;return {exitCode:0,signal:null};},syntheticClients());o.start();await (o as any).tick();await new Promise<void>(r=>setImmediate(r));assert.equal(f.wb.get('agent_jobs',queued.id).status,'queued');assert.equal(f.wb.get('agent_jobs',uncertain.id).status,'interrupted');assert.equal(f.wb.get('agent_jobs',uncertain.id).process_may_be_running,true);assert.equal(spawns,0);
  }finally{await o?.close();await f.app.close();}
});
test('usage receipt, ordinal and job metadata roll back together; stable message replay survives database reopen',async()=>{
  const f=await isolated();let closed=false,reopened:Awaited<ReturnType<typeof createApp>>|undefined;
  try{const s=setup(f.wb,f.root),job={id:'AJ-'+crypto.randomUUID(),task_id:s.tid,run_id:s.rid,role:'execution',phase:'execution',status:'completed',revision:1,route:{client:'grok',model:'synthetic-metered'},created_at:new Date().toISOString()},output=parseAgentOutput('grok',JSON.stringify({type:'message_start',message:{type:'message',id:'stable-usage-1',role:'assistant',model:'synthetic-metered',usage:{input_tokens:11,output_tokens:2}}}));f.wb.put('agent_jobs',job,{run_id:s.rid});const put=f.wb.put.bind(f.wb);let injected=false;f.wb.put=((table:string,row:Row,refs:Row={})=>{if(table==='agent_jobs'&&row.usage_ordinal===1&&!injected){injected=true;throw Error('synthetic job patch failure');}return put(table,row,refs);}) as typeof f.wb.put;
    assert.throws(()=>(f.agents as any).onOutput(job.id,output),/synthetic job patch failure/);f.wb.put=put;assert.equal(f.wb.all('usage_events').length,0);assert.equal(f.wb.get('agent_jobs',job.id).usage_ordinal,undefined);assert.equal(f.wb.get('agent_jobs',job.id).actual_model,undefined);
    (f.agents as any).onOutput(job.id,output);assert.equal(f.wb.all('usage_events').length,1);assert.equal(f.wb.get('agent_jobs',job.id).usage_ordinal,1);
    const delta=parseAgentOutput('grok',JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:30}}));(f.agents as any).onOutput(job.id,delta);assert.equal(f.wb.get('agent_jobs',job.id).usage.outputTokens,30);const original=f.wb.all('usage_events');await f.app.close();closed=true;reopened=await createApp(f.config,{background:false});(reopened.agents as any).onOutput(job.id,output);assert.equal(reopened.wb.all('usage_events').length,2);assert.equal(reopened.wb.get('agent_jobs',job.id).usage_ordinal,2);assert.equal(reopened.wb.get('agent_jobs',job.id).usage.outputTokens,30,'replaying an earlier message must not roll back the latest job usage');assert.equal(reopened.wb.get('agent_jobs',job.id).usage_replayed_events,1);assert.deepEqual(reopened.wb.all('usage_events'),original);
  }finally{if(reopened)await reopened.app.close();if(!closed)await f.app.close();}
});
test('held project blocks manual and automatic review dispatch; paused review preparation resumes the same RA once',async()=>{
  const f=await isolated(),pause=barrier();let entered=false,spawns=0,o:AgentOrchestrator|undefined;
  try{const q=f.wb.request({project_id:'P-workbench',text:'隔离审查排队竞态，不是真实独立审查'}),p=f.wb.submitPlan(plan(f.root,q,{review_route:{client:'grok',model:'synthetic-review'},context_contract:{required:[],supplemental:[],output_dir:path.join(f.root,'outputs'),max_bytes:65536}})),tid=p.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');assert.equal(f.wb.event(event(f.root,tid,rid,2,'submitted',{result:'这是隔离假客户端审查流程的测试交付，不是生产实现或独立审查结论。'})).disposition,'applied');
    const headers=await page(f);hold(f.wb,true);const request={run_id:rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',tid).revision};assert.throws(()=>f.agents.dispatchReview(request),/暂缓|暂停/);assert.equal((await f.app.inject({method:'POST',url:'/api/review-orders',headers,payload:{run_id:rid,reviewer_id:'grok-build',expected_revision:request.expected_revision,reason:'隔离测试不能在暂停项目中新派审'}})).statusCode,409);assert.equal(f.wb.all('review_assignments').length,0);hold(f.wb,false);
    const launcher:Launcher=async options=>{assert.ok(options.beforeSpawn?.());spawns++;options.onSpawn?.(987654321);const job=f.wb.all('agent_jobs').find(j=>j.run_id===rid&&j.role==='review')!,c=reviewAssignmentContext(f.wb,job.review_id);startReview(f.wb,{review_id:job.review_id,identity:'grok-build'});submitReviewResult(f.wb,{review_id:job.review_id,task_id:tid,run_id:rid,review_digest:c.review_digest,verdict:'passed',findings:[],limitations:['隔离假客户端协议测试，不代表正式独立审查'],evidence:['实际读取了本隔离夹具的审查上下文'],report_markdown:'# 隔离协议测试\n\n仅核对暂停后既有审查记录是否能正确接续，不代表产品独立审查结论。'},'reviewer:'+job.review_id);return {exitCode:0,signal:null,processStopped:true};};
    o=new AgentOrchestrator(f.wb,launcher,syntheticClients({resolve:async()=>{if(!entered){entered=true;await pause.promise;}}}));const job=o.dispatchReview({...request,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',tid).revision}),ra=f.wb.get('tasks',tid).current_review_assignment_id;await until(()=>entered,'review resolver must wait');hold(f.wb,true);pause.release();await until(()=>f.wb.get('agent_jobs',job.job_id).status==='queued'&&!(o as any).launching.has(job.job_id),'review remains queued after hold');assert.equal(f.wb.get('review_assignments',ra).status,'awaiting_dispatch');assert.equal(spawns,0);hold(f.wb,false);await (o as any).tick();await until(()=>f.wb.get('agent_jobs',job.job_id).status==='completed','same review should complete after resume');assert.equal(spawns,1);assert.equal(f.wb.all('review_assignments').length,1);assert.equal(f.wb.get('review_assignments',ra).status,'completed');
  }finally{pause.release();await o?.close();await f.app.close();}
});

test('planning provenance records the authenticated channel and only reported model identity',async()=>{
 const f=await isolated();try{const headers=await page(f);
  for(const role of ['chat_planner','manager','planner'] as const){
   const q=f.wb.request({project_id:'P-workbench',text:'隔离规划来源验证 '+role}),proposal={...plan(f.root,q),planner:{name:'GPT 聊天',model:'synthetic-reported-model'}};
   const response=await f.app.inject({method:'POST',url:'/api/mcp/submit_task_plan',headers:{host:headers.host,authorization:'Bearer '+f.wb.keys[role]},payload:proposal});
   assert.equal(response.statusCode,200,response.body);const saved=response.json(),task=f.wb.get('tasks',saved.task_ids[0]);
   assert.equal(saved.planning_origin.channel,role==='chat_planner'?'chat_mcp':role==='manager'?'manager_mcp':'planner_mcp');
   assert.equal(saved.planning_origin.authenticated_role,role);assert.equal(saved.planning_origin.model_status,'reported');assert.equal(saved.planning_origin.reported_model,'synthetic-reported-model');
   assert.deepEqual(task.planning_origin,saved.planning_origin);assert.notEqual(task.source,'codex_plan');assert.doesNotMatch(planningOriginLabel(task),/Codex/);
   const replay=await f.app.inject({method:'POST',url:'/api/plans/chat-import',headers,payload:{text:JSON.stringify(proposal)}});assert.equal(replay.statusCode,200);assert.deepEqual(replay.json().planning_origin,saved.planning_origin);
   const graph=projectTimelineGraph({project_id:'P-workbench',tasks:[task],requests:[q],plans:[saved]});const node=graph.nodes.find(n=>n.kind==='plan')!;
   assert.equal(node.reported_model,'synthetic-reported-model');assert.equal(node.actual_model,null);assert.equal(node.source,'planner_reported');
  }
  const q=f.wb.request({project_id:'P-workbench',text:'普通聊天没有报告模型时必须保留未知'}),proposal=plan(f.root,q),before=fingerprint(f.wb);
  const preview=await f.app.inject({method:'POST',url:'/api/plans/chat-preview',headers,payload:{text:JSON.stringify(proposal)}});assert.equal(preview.statusCode,200);assert.equal(fingerprint(f.wb),before);
  const forged={...proposal,planning_origin:{channel:'manager_mcp',model_status:'verified'}};assert.equal((await f.app.inject({method:'POST',url:'/api/plans/chat-import',headers,payload:{text:JSON.stringify(forged)}})).statusCode,400);
  const response=await f.app.inject({method:'POST',url:'/api/plans/chat-import',headers,payload:{text:JSON.stringify(proposal)}});assert.equal(response.statusCode,200);assert.equal(response.json().planning_origin.channel,'chat_paste');assert.equal(response.json().planning_origin.reported_model,null);assert.equal(response.json().planning_origin.model_status,'unknown');
 }finally{await f.app.close();}
});

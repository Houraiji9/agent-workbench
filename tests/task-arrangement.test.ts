// 用户在同一任务修改执行者、主模型与子代理：按阶段生效，旧执行单与记录不变，权限与独立审查不放松。隔离临时账本，不调用真实客户端。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
import {taskInput,event} from './helpers.ts';
import {normalizePolicy,runTask} from '../src/core/workflow-policy.ts';
import {changeTaskArrangement} from '../src/core/task-arrangement.ts';
import {setMainExecutionControl} from '../src/core/main-execution-control.ts';
import {arrangementPhase} from '../src/shared/arrangement.ts';
import {priorityInstructions} from '../src/core/priority-policy.ts';
import {AgentOrchestrator} from '../src/core/agent-orchestration.ts';
import {reconcileTakeovers} from '../src/core/manual-takeover.ts';

function isolated(){const base=process.env.PROJECT_MANAGEMENT_TEST_ROOT||path.join(ROOT,'.test-tmp','task-arrangement');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'arrangement-'));const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};return {root,wb:seedTestData(new Workbench(config))};}
const policy=(patch:Record<string,unknown>={})=>normalizePolicy({main_model:'gpt-6.1-sol',allow_subagents:true,child_models:['gpt-6-luna'],max_calls:6,...patch});
const candidate=(agent_id:string,model:string)=>({agent_id,model,capability_assessment:'adequate',capability_reason:'规划时判断能力足够',availability:'available',availability_reason:'规划时目录与额度可用'});
const selection={strategy:'adequate_economical',main:{agent_id:'codex',model:'gpt-6.1-sol',reason:'规划建议的主模型'},review:{agent_id:'grok-build',model:'grok-4.7-build-fast',reason:'独立审查者'},
  children:[{agent_id:'codex',model:'gpt-6-luna',reason:'规划建议的子模型'}],fallback_policy:'stop_and_replan',
  evaluation:{criteria:'按任务复杂度选择能力足够且经济的模型',catalog_as_of:'2026-10-21',considered:[candidate('codex','gpt-6.1-sol'),candidate('grok-build','grok-4.7-build-fast'),candidate('codex','gpt-6-luna')]}};
function planned(wb:Workbench,root:string){
  const q=wb.request({project_id:'P-workbench',text:'测试数据：验证用户修改执行安排'});
  const result=wb.submitPlan({schema_version:1,plan_id:'arrangement-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(root),requested_model:'gpt-6.1-sol',execution_policy:policy(),model_selection:selection}]});
  return result.task_ids[0];
}
const userChoice=(revision:number,patch:Record<string,unknown>={},agent_id='codex')=>({revision,agent_id,execution_policy:policy({main_model:'gpt-6-sol',child_models:['gpt-6-astra'],...patch})});
const jobs=(wb:Workbench)=>wb.all('agent_jobs');

test('not started: the user choice replaces the planner selection and the first order freezes it',()=>{
  const f=isolated();try{
    const tid=planned(f.wb,f.root),t=f.wb.get('tasks',tid);assert.equal(arrangementPhase(t,null,[]),'direct');
    const saved=changeTaskArrangement(f.wb,tid,userChoice(t.revision));assert.equal(saved.phase,'direct');
    const rid=f.wb.exportOrder(tid,1).run_id,c=f.wb.get('runs',rid).execution_contract;
    assert.equal(c.requested_model,'gpt-6-sol');assert.deepEqual(c.execution_policy.child_models,['gpt-6-astra']);
    assert.equal(c.model_selection.main.decided_by,'user');assert.equal(c.model_selection.review.model,'grok-4.7-build-fast','review choice is not touched');
    assert.match(priorityInstructions(runTask(f.wb.get('tasks',tid),f.wb.get('runs',rid)),'normal'),/用户选择，覆盖规划建议/);
  }finally{f.wb.close();}
});

test('order generated but not started: the unused order is retired and kept, the new one is current',()=>{
  const f=isolated();try{
    const tid=planned(f.wb,f.root),old=f.wb.exportOrder(tid,1).run_id,oldContract=f.wb.get('runs',old).execution_contract;
    const t=f.wb.get('tasks',tid);assert.equal(arrangementPhase(t,f.wb.get('runs',old),jobs(f.wb)),'replace_unstarted');
    const r=changeTaskArrangement(f.wb,tid,userChoice(t.revision));assert.equal(r.phase,'replace_unstarted');
    const next=f.wb.get('tasks',tid),retired=f.wb.get('runs',old);
    assert.notEqual(next.current_run_id,old);assert.equal(retired.status,'cancelled');assert.match(retired.cancel_reason,/尚未开始/);
    assert.deepEqual(retired.execution_contract,oldContract,'history stays immutable');assert.ok(fs.existsSync(retired.order_path),'old order file stays on disk');
    const created=f.wb.get('runs',next.current_run_id);assert.equal(created.requested_model,'gpt-6-sol');assert.equal(created.arrangement.source,'user_page');
    assert.equal(created.arrangement.previous.requested_model,'gpt-6.1-sol');
    assert.throws(()=>f.wb.event(event(f.root,tid,old,1)),/旧 Run/,'a receipt for the retired order is not accepted');
  }finally{f.wb.close();}
});

test('running: the change is saved as the next version, the live contract is untouched, and the next Run applies it',()=>{
  const f=isolated();try{
    const tid=planned(f.wb,f.root),rid=f.wb.exportOrder(tid,1).run_id;assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');
    const before=f.wb.get('runs',rid).execution_contract,t=f.wb.get('tasks',tid);assert.equal(arrangementPhase(t,f.wb.get('runs',rid),jobs(f.wb)),'pending');
    const r=changeTaskArrangement(f.wb,tid,userChoice(t.revision));assert.equal(r.phase,'pending');
    const pendingTask=f.wb.get('tasks',tid);assert.equal(pendingTask.pending_arrangement.requested_model,'gpt-6-sol');assert.equal(pendingTask.current_run_id,rid);
    assert.deepEqual(f.wb.get('runs',rid).execution_contract,before,'no hot switch of the running order');
    assert.equal(runTask(pendingTask,f.wb.get('runs',rid)).requested_model,'gpt-6.1-sol');
    assert.equal(f.wb.event(event(f.root,tid,rid,2,'failed',{message:'隔离测试结束本次执行'})).disposition,'applied');
    // An automatic retry (as continue/restart would do) uses the user's saved arrangement, not the previous Run's.
    const current=f.wb.get('tasks',tid),order=f.wb.exportOrder(tid,1,true,undefined,current.revision),run=f.wb.get('runs',order.run_id);
    assert.equal(run.requested_model,'gpt-6-sol');assert.equal(run.arrangement.source,'user_pending');assert.equal(f.wb.get('tasks',tid).pending_arrangement,undefined);
    assert.deepEqual(f.wb.get('runs',rid).execution_contract,before);
  }finally{f.wb.close();}
});

test('a saved next version can be withdrawn; stale revisions and reviewer as executor are rejected',()=>{
  const f=isolated();try{
    const tid=planned(f.wb,f.root),rid=f.wb.exportOrder(tid,1).run_id;f.wb.event(event(f.root,tid,rid,1));
    const t=f.wb.get('tasks',tid);changeTaskArrangement(f.wb,tid,userChoice(t.revision));
    assert.throws(()=>changeTaskArrangement(f.wb,tid,userChoice(t.revision)),/刷新/);
    const after=f.wb.get('tasks',tid);
    assert.throws(()=>changeTaskArrangement(f.wb,tid,{revision:after.revision,agent_id:'grok-build',execution_policy:policy({main_model:'grok-4.7-build-fast',child_models:[],allow_subagents:false})}),/独立审查/);
    assert.throws(()=>changeTaskArrangement(f.wb,tid,userChoice(after.revision,{main_model:'not-in-catalog'})),/模型列表/);
    changeTaskArrangement(f.wb,tid,{revision:after.revision,clear_pending:true});assert.equal(f.wb.get('tasks',tid).pending_arrangement,undefined);
  }finally{f.wb.close();}
});

test('finished or failed: the next version is generated from the user choice without the old model contract rejecting it',()=>{
  const f=isolated();try{
    const tid=planned(f.wb,f.root),rid=f.wb.exportOrder(tid,1).run_id;f.wb.event(event(f.root,tid,rid,1));
    assert.equal(f.wb.event(event(f.root,tid,rid,2,'failed',{message:'隔离测试结束本次执行'})).disposition,'applied');
    const t=f.wb.get('tasks',tid);assert.equal(arrangementPhase(t,f.wb.get('runs',rid),jobs(f.wb)),'next_version');
    const r=changeTaskArrangement(f.wb,tid,userChoice(t.revision,{allow_subagents:false,child_models:[]}));assert.equal(r.phase,'next_version');
    const run=f.wb.get('runs',f.wb.get('tasks',tid).current_run_id);
    assert.equal(run.execution_contract.execution_policy.allow_subagents,false);assert.deepEqual(run.execution_contract.model_selection.children,[]);
    assert.equal(run.retry_context.previous_run_id,rid,'the previous delivery stays linked');assert.equal(f.wb.get('runs',rid).status,'failed');
  }finally{f.wb.close();}
});

test('phase rules: closed tasks and live client calls never switch immediately',()=>{
  assert.equal(arrangementPhase({status:'accepted',current_run_id:'R'},{status:'submitted'}),'closed');
  assert.equal(arrangementPhase({id:'T',status:'awaiting_dispatch',current_run_id:'R'},{status:'awaiting_dispatch',has_started:false},[{task_id:'T',status:'running'}]),'pending');
  assert.equal(arrangementPhase({id:'T',status:'running',current_run_id:'R'},{status:'failed'},[{task_id:'T',status:'failed',process_may_be_running:true}]),'pending');
  assert.equal(arrangementPhase({id:'T',status:'changes_requested',current_run_id:'R'},{status:'submitted'}),'next_version');
  assert.equal(arrangementPhase({id:'T',status:'in_review',current_run_id:'R'},{status:'submitted'}),'pending','a delivery under review is not replaced');
});

// —— 2026-10-25 返修（Codex RA-6b59c750）——
const assessed=(agent_id:string,model:string,availability:string)=>({...candidate(agent_id,model),availability,availability_reason:'旧规划时的资源观察记录'});
function plannedWith(wb:Workbench,root:string,extra:Record<string,unknown>){
  const q=wb.request({project_id:'P-workbench',text:'测试数据：返修回归'});
  return wb.submitPlan({schema_version:1,plan_id:'rework-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(root),requested_model:'gpt-6.1-sol',execution_policy:policy(),model_selection:selection,...extra}]}).task_ids[0];
}
// 客户端发现、构建与启动全部被替换为记录后报错，测试中不会调用任何真实模型。
const orchestrator=(wb:Workbench,calls:string[])=>new AgentOrchestrator(wb,async()=>{calls.push('launch');throw Error('测试不启动真实客户端');},{resolve:async()=>{calls.push('resolve');throw Error('不解析客户端');},build:async()=>{throw Error('不构建');},discover:async()=>[]});
const contract=(root:string)=>({required:[],supplemental:[],output_dir:path.join(root,'output'),max_bytes:65536});
const claudeTask=(root:string)=>({agent_id:'claude',requested_model:'claude-opus-5-5',execution_policy:policy({main_model:'claude-opus-5-5',allow_subagents:false,child_models:[]}),
  model_selection:{...selection,main:{agent_id:'claude',model:'claude-opus-5-5',reason:'规划建议的主模型'},children:[],evaluation:{...selection.evaluation,considered:[candidate('claude','claude-opus-5-5'),candidate('grok-build','grok-4.7-build-fast')]}},
  execution_route:{client:'claude',model:'claude-opus-5-5'},context_contract:contract(root)});
const started=(f:{wb:Workbench;root:string},tid:string,rid:string,identity:string)=>f.wb.event({...event(f.root,tid,rid,1),data:{identity,cwd:f.root,message:'测试接单'}});
const stoppedJob=(rid:string,tid:string)=>{const at=new Date().toISOString();return {id:'AJ-'+crypto.randomUUID(),task_id:tid,run_id:rid,role:'execution',phase:'execution',route:{client:'claude',model:'claude-opus-5-5'},status:'interrupted',process_may_be_running:false,process_end_evidence:'owned_child_exit',created_at:at,ended_at:at,revision:1};};

for(const availability of ['unavailable','unknown'])test(`old planner assessment (${availability}) does not lock out a user choice; it is replaced with current evidence and kept`,()=>{
  const f=isolated();try{
    const sel={...selection,evaluation:{...selection.evaluation,considered:[...selection.evaluation.considered,assessed('codex','gpt-6-sol',availability),assessed('codex','gpt-6-astra',availability)]}};
    const tid=plannedWith(f.wb,f.root,{model_selection:sel});
    const saved:any=changeTaskArrangement(f.wb,tid,userChoice(1)).task;
    assert.equal(saved.requested_model,'gpt-6-sol');
    const now=saved.model_selection.evaluation.considered.filter((c:any)=>['gpt-6-sol','gpt-6-astra'].includes(c.model));
    assert.equal(now.length,2);assert.ok(now.every((c:any)=>c.availability==='available'&&c.capability_assessment==='unknown'&&c.availability_reason.includes('规划时记录为 '+availability)));
    assert.deepEqual(saved.model_selection.user_decision.previous_assessments.map((c:any)=>[c.model,c.availability]),[['gpt-6-sol',availability],['gpt-6-astra',availability]]);
    assert.throws(()=>changeTaskArrangement(f.wb,tid,userChoice(saved.revision,{main_model:'not-in-catalog'})),/模型列表/,'the current catalogue is still the gate');
  }finally{f.wb.close();}
});

test('stop then restart onto a member without an automatic route hands off manually instead of rolling back',async()=>{
  const f=isolated(),calls:string[]=[],o=orchestrator(f.wb,calls);try{
    const tid=plannedWith(f.wb,f.root,claudeTask(f.root)),first=f.wb.exportOrder(tid,1).run_id;assert.equal(started(f,tid,first,'claude').disposition,'applied');
    changeTaskArrangement(f.wb,tid,{revision:f.wb.get('tasks',tid).revision,agent_id:'codex',execution_policy:policy({allow_subagents:false,child_models:[]})});
    f.wb.put('agent_jobs',stoppedJob(first,tid),{run_id:first});
    const result:any=o.continueRun({run_id:first,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',tid).revision,fresh_session:true},{role:'user',source:'page'});
    const t=f.wb.get('tasks',tid),next=f.wb.get('runs',t.current_run_id);
    assert.equal(result.automatic_delivery,false);assert.match(result.entry,/请完整读取并执行/);assert.equal(result.previous_run_id,first);
    assert.equal(next.agent_id,'codex');assert.equal(next.requested_model,'gpt-6.1-sol');assert.equal(next.arrangement.source,'user_pending');
    assert.equal(t.pending_arrangement,undefined);assert.equal(t.execution_route,null);assert.equal(f.wb.get('runs',first).status,'cancelled');
    assert.equal(f.wb.all('agent_jobs').filter(j=>j.task_id===tid&&['queued','launching','running'].includes(j.status)).length,0,'no main executor is launched');
    assert.deepEqual(calls,[]);
  }finally{await o.close();f.wb.close();}
});

test('stop then restart with a same-client model change queues the user-requested new session on the new model',async()=>{
  const f=isolated(),calls:string[]=[],o=orchestrator(f.wb,calls);try{
    const tid=plannedWith(f.wb,f.root,claudeTask(f.root)),first=f.wb.exportOrder(tid,1).run_id;assert.equal(started(f,tid,first,'claude').disposition,'applied');
    changeTaskArrangement(f.wb,tid,{revision:f.wb.get('tasks',tid).revision,agent_id:'claude',execution_policy:policy({main_model:'claude-sonnet-5-5',allow_subagents:false,child_models:[]})});
    f.wb.put('agent_jobs',stoppedJob(first,tid),{run_id:first});
    o.continueRun({run_id:first,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',tid).revision,fresh_session:true},{role:'user',source:'page'});
    const t=f.wb.get('tasks',tid),job=f.wb.all('agent_jobs').find(j=>j.run_id===t.current_run_id)!;
    assert.equal(t.execution_route.model,'claude-sonnet-5-5');assert.equal(job.route.model,'claude-sonnet-5-5');assert.equal(job.session_mode,'new','never resumes the old model session');
    assert.equal(f.wb.get('runs',first).status,'cancelled');
  }finally{await o.close();f.wb.close();}
});

function failedLaunchTask(f:{wb:Workbench;root:string}){
  const tid=plannedWith(f.wb,f.root,{review_route:{client:'grok',model:'grok-4.7-build-fast'},automation_policy:{auto_review:true,auto_rework:true,continue_after_review:true,max_rework_rounds:2},context_contract:contract(f.root)});
  const rid=f.wb.exportOrder(tid,1).run_id,at=new Date(Date.now()-60000).toISOString(),jid='AJ-'+crypto.randomUUID();
  const job={id:jid,task_id:tid,run_id:rid,role:'execution',phase:'execution',route:{client:'claude',model:'claude-opus-5-5'},status:'failed',process_may_be_running:false,process_end_evidence:'owned_child_exit',created_at:at,ended_at:at,revision:1,reason:'合成旧客户端启动失败'};
  f.wb.put('agent_jobs',job,{run_id:rid});f.wb.put('tasks',{...f.wb.get('tasks',tid),automation:{job_id:jid,run_id:rid,role:'execution',status:'failed',reason:job.reason}},{project_id:'P-workbench'});
  return {tid,rid,jid,job};
}
async function scheduled(wb:Workbench){
  const calls:string[]=[],o=orchestrator(wb,calls),seen:string[]=[];
  Object.assign(o as any,{dispatchReview:()=>{seen.push('review');return {};},dispatchRun:()=>{seen.push('run');return {};},continueRun:()=>{seen.push('continue');return {};}});
  await (o as any).tick();await o.close();return seen;
}

test('manual takeover after a failed launch: evidence sits on the failed call, review may auto-dispatch, the main executor is not relaunched',async()=>{
  const f=isolated();try{
    const {tid,rid,jid}=failedLaunchTask(f);
    assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');
    const job=f.wb.get('agent_jobs',jid);assert.equal(job.status,'failed','failure history is kept');assert.equal(job.superseded.by,'started');assert.equal(job.superseded.run_id,rid);
    assert.ok(f.wb.get('tasks',tid).automation.superseded);
    assert.equal(f.wb.event(event(f.root,tid,rid,2,'submitted',{result:'隔离测试提交的合成结果，没有调用模型或修改真实数据'})).disposition,'applied');
    assert.deepEqual(await scheduled(f.wb),['review']);
    f.wb.put('tasks',{...f.wb.get('tasks',tid),status:'awaiting_closeout'},{project_id:'P-workbench'});
    assert.deepEqual(await scheduled(f.wb),[],'main-executor closeout is not auto-launched after a manual takeover');
  }finally{f.wb.close();}
});

test('takeover evidence: an unconfirmed process is not superseded; pre-existing records reconcile idempotently; later failures are not covered',()=>{
  const f=isolated();try{
    const a=failedLaunchTask(f);f.wb.put('agent_jobs',{...a.job,process_may_be_running:true},{run_id:a.rid});
    f.wb.event(event(f.root,a.tid,a.rid,1));assert.equal(f.wb.get('agent_jobs',a.jid).superseded,undefined);
    const b=failedLaunchTask(f);assert.equal(f.wb.event(event(f.root,b.tid,b.rid,1)).disposition,'applied');
    // A ledger written before takeover evidence existed.
    const raw=f.wb.get('agent_jobs',b.jid);delete raw.superseded;f.wb.put('agent_jobs',raw,{run_id:b.rid});
    const t=f.wb.get('tasks',b.tid);delete t.automation.superseded;f.wb.put('tasks',t,{project_id:'P-workbench'});
    assert.deepEqual(reconcileTakeovers(f.wb),[b.jid]);assert.equal(f.wb.get('agent_jobs',b.jid).superseded.source,'reconcile');
    assert.ok(f.wb.get('tasks',b.tid).automation.superseded);assert.deepEqual(reconcileTakeovers(f.wb),[]);
    const late=new Date(Date.now()+60000).toISOString(),lateId='AJ-'+crypto.randomUUID();
    const {superseded:_s,...lateJob}={...raw,superseded:null};f.wb.put('agent_jobs',{...lateJob,id:lateId,created_at:late,ended_at:late},{run_id:b.rid});
    assert.deepEqual(reconcileTakeovers(f.wb),[]);
  }finally{f.wb.close();}
});

for(const oldStatus of ['failed','interrupted'])test(`手工接管 ${oldStatus} 后即使开启自动许可也只可派审，不能自动返修或收尾`,async()=>{
  const f=isolated();try{
    const tid=plannedWith(f.wb,f.root,{...claudeTask(f.root),review_route:{client:'grok',model:'grok-4.7-build-fast'},automation_policy:{auto_review:true,auto_rework:true,continue_after_review:true,max_rework_rounds:2}}),rid=f.wb.exportOrder(tid,1).run_id;
    setMainExecutionControl(f.wb,tid,{expected_revision:f.wb.get('tasks',tid).revision,main_execution_control:'automatic'},{role:'user',source:'page'});
    const earlier=new Date(Date.now()-60000).toISOString(),job={...stoppedJob(rid,tid),status:oldStatus,created_at:earlier,ended_at:earlier};
    f.wb.put('agent_jobs',job,{run_id:rid});f.wb.put('tasks',{...f.wb.get('tasks',tid),automation:{job_id:job.id,run_id:rid,role:'execution',status:oldStatus}},{project_id:'P-workbench'});
    assert.equal(started(f,tid,rid,'claude').disposition,'applied');
    assert.equal(f.wb.event(event(f.root,tid,rid,2,'submitted',{identity:'claude',result:'手工接管后的合成正式交付，只验证调度权限且不调用真实模型'})).disposition,'applied');
    assert.ok(f.wb.get('agent_jobs',job.id).superseded);assert.ok(f.wb.get('tasks',tid).execution_route);
    assert.deepEqual(await scheduled(f.wb),['review']);
    for(const status of ['changes_requested','awaiting_closeout']){
      f.wb.put('tasks',{...f.wb.get('tasks',tid),status},{project_id:'P-workbench'});
      assert.deepEqual(await scheduled(f.wb),[],status+' 不得自动启动主执行');
      const calls:string[]=[],o=orchestrator(f.wb,calls);try{
        const request={run_id:rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',tid).revision};
        assert.throws(()=>status==='changes_requested'?o.continueRun(request,{role:'system',source:'automation'}):o.dispatchRun(request,{role:'system',source:'automation'}),/手工接管/);
        assert.deepEqual(calls,[]);assert.equal(f.wb.all('runs').length,1);
      }finally{await o.close();}
    }
  }finally{f.wb.close();}
});

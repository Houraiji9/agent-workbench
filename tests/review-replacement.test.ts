import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,taskInput,event} from './agent-routing-fixture.ts';
import {AgentOrchestrator,type Launcher} from '../src/core/agent-orchestration.ts';
import type {ClientRecord} from '../src/core/agent-clients.ts';
import {applyReviewEdit} from '../src/core/review-replacement.ts';
import {exportReviewOrder} from '../src/core/review-workflow.ts';

async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert(check(),'synthetic operation did not settle');}
function setup(){
 const f=fixture(),launches:Parameters<Launcher>[0][]=[],release:Array<()=>void>=[];
 const launcher:Launcher=options=>new Promise(resolve=>{launches.push(options);release.push(()=>resolve({exitCode:0,signal:null}));options.signal.addEventListener('abort',()=>resolve({exitCode:null,signal:'SIGTERM'}),{once:true});});
 const clients={resolve:async(_dir:string,kind:any):Promise<ClientRecord>=>({kind,label:'synthetic',status:'verified',reason:'synthetic',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown'}),build:async()=>({command:'SYNTHETIC-NEVER-SPAWNED',args:[]}),discover:async()=>[]};
 const agents=new AgentOrchestrator(f.wb,launcher,clients);
 const task=()=>{const q=f.wb.request({project_id:'P-workbench',text:'合成改派管理测试'}),plan=f.wb.submitPlan({schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(f.root),review_route:{client:'grok',model:'grok-4.7-build-fast'}}]}),tid=plan.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;for(const [seq,type] of [[1,'started'],[2,'submitted']] as const){const result=f.wb.event(event(f.root,tid,rid,seq,type,{result:'合成改派测试交付，仅验证账本、调用作用域与显式处置，不执行真实模型。'}));assert.equal(result.disposition,'applied',result.error);}return {tid,rid};};
 return {...f,agents,launches,release,task};
}
test('manage review retain_parallel keeps the actual old assignment and process as an independent report destination',async()=>{
 const f=setup();try{
  const t=f.task(),job=f.agents.dispatchReview({run_id:t.rid,request_id:randomUUID(),expected_revision:f.wb.get('tasks',t.tid).revision});await until(()=>f.launches.length===1);
  const result=await applyReviewEdit(f.wb,f.agents,'member',{run_id:t.rid,review_id:job.review_id,expected_revision:f.wb.get('tasks',t.tid).revision,action:'replace',reviewer_id:'cursor',requested_model:'native-fast-id',replacement_mode:'retain_parallel',reason:'明确保留旧审查并行参考，新增指定审查'}, {role:'runner',id:'scoped-runner',source:'scoped_mcp'});
  assert('review_id' in result);assert.notEqual(result.review_id,job.review_id);assert.equal(f.wb.get('review_assignments',job.review_id!).status,'awaiting_dispatch');assert.equal(f.wb.get('review_assignments',result.review_id).requested_model,'native-fast-id');assert.equal(f.launches[0].signal.aborted,false);assert.equal(f.agents.taskJobs(t.tid)[0].replacement.mode,'retain_parallel');
 }finally{await f.agents.close();f.wb.close();}
});
test('manage review stop_then_replace pending leaves arrangement untouched and requires ended owned process before replacement',async()=>{
 const f=setup();try{
  const t=f.task(),job=f.agents.dispatchReview({run_id:t.rid,request_id:randomUUID(),expected_revision:f.wb.get('tasks',t.tid).revision});await until(()=>f.launches.length===1);
  const edit=()=>({run_id:t.rid,review_id:job.review_id,expected_revision:f.wb.get('tasks',t.tid).revision,action:'replace',reviewer_id:'cursor',requested_model:'native-fast-id',replacement_mode:'stop_then_replace',reason:'明确结束旧owned调用后替换审查者'});
  const before=f.wb.get('review_assignments',job.review_id!),pending=await applyReviewEdit(f.wb,f.agents,'member',edit(),{role:'runner',id:'scoped-runner'});
  assert('status' in pending);assert.equal(pending.status,'pending');assert.deepEqual(f.wb.get('review_assignments',job.review_id!),before);assert.equal(f.wb.runRows('review_assignments',t.rid).length,1);assert.equal(f.launches[0].signal.aborted,true);
  await until(()=>f.wb.get('agent_jobs',job.job_id).process_may_be_running===false);
  const done=await applyReviewEdit(f.wb,f.agents,'member',edit(),{role:'runner',id:'scoped-runner'});assert('review_id' in done);assert.notEqual(done.review_id,job.review_id);assert.equal(f.wb.get('review_assignments',job.review_id!).status,'cancelled');assert.equal(f.wb.get('review_assignments',done.review_id).reviewer_id,'cursor');assert.equal(f.launches.length,1);
 }finally{await f.agents.close();f.wb.close();}
});
test('manage review replacement rejects stale revision and cross-run assignment before stopping any process',async()=>{
 const f=setup();try{
  const t=f.task(),other=f.task(),job=f.agents.dispatchReview({run_id:t.rid,request_id:randomUUID(),expected_revision:f.wb.get('tasks',t.tid).revision});await until(()=>f.launches.length===1);
  const ownRevision=f.wb.get('tasks',t.tid).revision,edit={run_id:t.rid,review_id:job.review_id,expected_revision:ownRevision,action:'replace',reviewer_id:'cursor',replacement_mode:'stop_then_replace',reason:'合成作用域与版本冲突检查'};
  await assert.rejects(applyReviewEdit(f.wb,f.agents,'member',{...edit,expected_revision:ownRevision+1},{role:'runner',id:'scoped-runner'}),/任务已变化/);
  await assert.rejects(applyReviewEdit(f.wb,f.agents,'member',{...edit,run_id:other.rid,expected_revision:f.wb.get('tasks',other.tid).revision},{role:'runner',id:'scoped-runner'}),/目标审查已变化/);
  assert.equal(f.launches[0].signal.aborted,false);assert.equal(f.wb.get('review_assignments',job.review_id!).status,'awaiting_dispatch');assert.equal(f.wb.runRows('review_assignments',t.rid).length,1);
 }finally{await f.agents.close();f.wb.close();}
});

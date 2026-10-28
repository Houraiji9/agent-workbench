import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,setup,taskInput,event} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {setTaskReviewArrangement,setReviewArrangement,exportReviewOrder} from '../src/core/review-workflow.ts';

const user={role:'user' as const},reason='用户在任务页调整审查安排';

test('没有自动客户端的人工审查者仍保留需求预选模型，后续明确清空不会复活旧值',()=>{
 const f=fixture();try{
  const manual={...f.wb.get('agents','grok-build'),id:'manual-peer',preset_id:null,name:'人工审查成员',client_kind:null,kind:'manual',cli:null};f.wb.put('agents',manual);
  const q=f.wb.request({project_id:'P-workbench',text:'人工审查模型预选测试',agent_selection:{review:{agent_id:'manual-peer',model:'user-model'}}});
  const plan=f.wb.submitPlan({schema_version:1,plan_id:'manual-'+randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(f.root),reviewer_id:'manual-peer'}]});
  const tid=plan.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;
  assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');assert.equal(f.wb.event(event(f.root,tid,rid,2,'submitted',{result:'合成测试交付，仅验证预选模型的正式审查单传递，不代表生产成果。'})).disposition,'applied');
  const first=exportReviewOrder(f.wb,{run_id:rid,reviewer_id:'manual-peer',expected_revision:f.wb.get('tasks',tid).revision,reason:'验证用户预选传递'},user);assert.equal(f.wb.get('review_assignments',first.review_id).requested_model,'user-model');
  const changed=setReviewArrangement(f.wb,{run_id:rid,reviewer_id:'manual-peer',requested_model:null,expected_revision:f.wb.get('tasks',tid).revision,reason:'用户明确清空建议模型'},user);
  assert('review' in changed);assert.equal(f.wb.get('review_assignments',changed.review.review_id).requested_model,null);
 }finally{f.wb.close();}
});
function planned(){const f=fixture(),q=f.wb.request({project_id:'P-workbench',text:'隔离测试：规划后调整审查安排'}),p=f.wb.submitPlan({schema_version:1,plan_id:'review-plan-'+randomUUID(),request_id:q.id,expected_version:1,tasks:[taskInput(f.root)]});return {...f,tid:p.task_ids[0],rid:null as string|null};}
function subject(withRun:boolean){if(!withRun)return planned();const f=fixture();return {...f,...setup(f.wb,f.root)};}
function save(f:ReturnType<typeof subject>,extra:Record<string,unknown>={}){return setTaskReviewArrangement(f.wb,f.tid,{expected_revision:f.wb.get('tasks',f.tid).revision,reviewer_id:'zcode',reason,...extra},user);}
function snapshot(f:ReturnType<typeof subject>){return JSON.stringify({task:f.wb.get('tasks',f.tid),runs:f.wb.all('runs'),assignments:f.wb.all('review_assignments'),reviews:f.wb.all('reviews')});}

for(const withRun of [false,true])test(`${withRun?'已有Run':'尚无Run'}审查安排持久化，显式null覆盖旧route模型并保留provider`,()=>{
  const f=subject(withRun);try{
    const beforeContract=f.rid?JSON.stringify(f.wb.get('runs',f.rid).execution_contract):null;
    // Omitted requested_model accepts the supplied route model; explicit null must differ.
    save(f,{route:{client:'dsh',model:'synthetic-initial',provider:'synthetic-provider'}});
    const target=()=>f.rid?f.wb.get('runs',f.rid):f.wb.get('tasks',f.tid);
    assert.equal(target().review_arrangement.requested_model,'synthetic-initial');
    save(f,{requested_model:null,route:{client:'dsh',model:'synthetic-stale-route',provider:'synthetic-provider'}});
    assert.equal(target().review_arrangement.requested_model,null);
    assert.deepEqual(target().review_arrangement.route,{client:'dsh',model:null,provider:'synthetic-provider'});
    assert.equal(target().review_arrangement_history.length,2);
    assert.equal(target().review_arrangement_history[0].requested_model,'synthetic-initial');
    assert.equal(f.wb.get('tasks',f.tid).current_run_id,f.rid);
    assert.equal(f.wb.all('runs').length,withRun?1:0);
    if(f.rid)assert.equal(JSON.stringify(f.wb.get('runs',f.rid).execution_contract),beforeContract);
    f.wb.close();f.wb=new Workbench(f.config);
    assert.equal(target().review_arrangement.requested_model,null);
    assert.equal(target().review_arrangement.route.provider,'synthetic-provider');
    if(!f.rid){const order=f.wb.exportOrder(f.tid,1),contract=f.wb.get('runs',order.run_id).execution_contract;assert.equal(contract.reviewer_id,'zcode');assert.deepEqual(contract.review_route,{client:'dsh',model:null,provider:'synthetic-provider'});}
  }finally{f.wb.close();}
});

for(const withRun of [false,true])test(`${withRun?'已有Run':'尚无Run'}关闭任务与不审查均拒绝改安排，拒绝不写记录`,()=>{
  const f=subject(withRun);try{
    for(const status of ['accepted','cancelled','rework_linked']){
      const task=f.wb.get('tasks',f.tid);task.status=status;f.wb.put('tasks',task,{project_id:task.project_id});const before=snapshot(f);
      assert.throws(()=>save(f,{requested_model:'synthetic-new'}),/已变化或已结束/);
      if(f.rid)assert.throws(()=>setReviewArrangement(f.wb,{run_id:f.rid,expected_revision:task.revision,reviewer_id:'zcode',requested_model:'synthetic-new',reason},user),/已变化或已结束/);
      assert.equal(snapshot(f),before);
    }
    const task=f.wb.get('tasks',f.tid);task.status=withRun?'running':'ready';task.review_policy={mode:withRun?'required':'not_requested',source:'user_requested'};f.wb.put('tasks',task,{project_id:task.project_id});
    if(f.rid){const run=f.wb.get('runs',f.rid);run.execution_contract.review_policy={mode:'not_requested',source:'user_requested'};f.wb.put('runs',run,{task_id:f.tid});}
    const before=snapshot(f);assert.throws(()=>save(f,{requested_model:null}),/未安排独立审查/);
    if(f.rid)assert.throws(()=>setReviewArrangement(f.wb,{run_id:f.rid,expected_revision:task.revision,reviewer_id:'zcode',requested_model:null,reason},user),/未安排独立审查/);
    assert.equal(snapshot(f),before);
  }finally{f.wb.close();}
});

test('已有Run采用本轮冻结的审查策略，任务后来标为不审查不改变本轮安排',()=>{
  const f=subject(true);try{const task=f.wb.get('tasks',f.tid);task.review_policy={mode:'not_requested',source:'user_requested'};f.wb.put('tasks',task,{project_id:task.project_id});save(f,{requested_model:'synthetic-current-run'});assert.equal(f.wb.get('runs',f.rid!).review_arrangement.requested_model,'synthetic-current-run');assert.equal(f.wb.get('runs',f.rid!).execution_contract.review_policy.mode,'required');}finally{f.wb.close();}
});

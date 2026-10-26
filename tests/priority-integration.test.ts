import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../src/core/config.ts';
import {freezeExecutionContract,normalizePolicy,runTask,saveTaskPolicy,registerDelegation,reportDelegation} from '../src/core/workflow-policy.ts';
import {compactOrder} from '../src/core/compact-order.ts';
import {reviewAssignmentContext} from '../src/core/review-workflow.ts';
import {reviewScope} from '../src/core/review-scope.ts';
import {modelSelectionSchema} from '../src/core/priority-policy.ts';
const validatePlannerSelection=(selection:unknown)=>modelSelectionSchema.parse(selection);

const evidenceRoot=process.env.WORKBENCH_TEST_OUTPUT_DIR||path.join(ROOT,'.test-tmp','priority-contract');
before(()=>{fs.mkdirSync(evidenceRoot,{recursive:true})});
const taskId='T-11111111-1111-4111-8111-111111111111',runId='R-22222222-2222-4222-8222-222222222222',reviewId='RA-33333333-3333-4333-8333-333333333333';
function fixture():Record<string,any>{
  const choices=[{agent_id:'executor',model:'execute-best',reason:'复杂执行任务需要完整推理能力'},
    {agent_id:'reviewer',model:'review-best',reason:'独立审查任务需要完整推理能力'},
    {agent_id:'executor',model:'child-best',reason:'复杂子代理任务需要完整推理能力'}];
  return {id:taskId,project_id:'project',current_run_id:runId,current_review_assignment_id:reviewId,revision:1,version:1,status:'running',
    title:'重点交付',goal:'完成复杂工程修改',scope:'本轮指定工程范围',original_request:'完成当前重点需求',work_kind:'engineering',
    agent_id:'executor',reviewer_id:'reviewer',requested_model:'execute-best',importance:'critical',
    execution_policy:normalizePolicy({main_model:'execute-best',allow_subagents:true,child_models:['child-best']}),
    execution_route:{model:'execute-best'},review_route:{model:'review-best'},review_policy:{mode:'required'},
    model_selection:{strategy:'best_capability',main:choices[0],review:choices[1],children:[choices[2]],fallback_policy:'stop_and_replan',
      evaluation:{criteria:'比较当前候选的复杂工程推理与审查能力，并核对可用资源',catalog_as_of:'2026-10-25',
        considered:choices.map(choice=>({agent_id:choice.agent_id,model:choice.model,capability_assessment:'best_capability',
          capability_reason:'根据当前目录及任务约束选择最佳能力候选',availability:'available',availability_reason:'规划时已核对当前账号的可用资源'}))}},
    delivery_target:'source',runtime_root:null,
    delivery_profile:{schema:1,artifacts:['software'],artifact_description:'当前受审服务产物',
      deployment:{mode:'remote',target:'受审测试环境',deploy:'使用当前受审版本更新服务',health:'检查服务状态与应用端点',rollback:'恢复部署前保留的服务版本',verification:'executor_reported'}},
    allowed_paths:[evidenceRoot],required_files:[],forbidden_actions:['禁止读取凭据'],stop_conditions:['资源不符停止重新规划'],
    acceptance:['符合本轮全部验收项'],tests:['检查主链路与失败边界'],deliverables:['当前受审产物'],additional_cost_limit:0,
    user_acceptance:['用户本人确认结果'],currency:'CNY',
  };
}
function fake(task=fixture()){
  const run={id:runId,task_id:taskId,agent_id:task.agent_id,requested_model:task.requested_model,status:'running',cwd:evidenceRoot,directory:evidenceRoot,
    execution_contract:freezeExecutionContract(task,task.agent_id,task.requested_model)};
  const tables:Record<string,Record<string,any>[]>= {tasks:[task],runs:[run],projects:[{id:'project',dispatch_paused:false}],delegations:[],
    agents:[{id:'executor',archived:false,allowed_kinds:['engineering'],model_group:{agent_id:'executor',as_of:'2026-10-25',sources:[],models:[{id:'execute-best'},{id:'child-best'},{id:'economy'}]}}],
    review_assignments:[{id:reviewId,run_id:runId,reviewer_id:'reviewer',status:'awaiting_dispatch',review_digest:'a'.repeat(64)}]};
  const wb:any={config:{timezone:'UTC',dataDir:evidenceRoot,authorizedRoots:[evidenceRoot]},
    get:(name:string,id:string)=>{const value=tables[name]?.find(x=>x.id===id);assert.ok(value,`missing ${name}/${id}`);return structuredClone(value)},
    all:(name:string)=>structuredClone(tables[name]||[]),
    put:(name:string,row:Record<string,any>)=>{const rows=tables[name]||=([]);const i=rows.findIndex(x=>x.id===row.id);if(i<0)rows.push(structuredClone(row));else rows[i]=structuredClone(row)},
    transaction:(body:()=>unknown)=>body(),audit:()=>{},privatePath:()=>false};
  return {wb,tables,run};
}
function delegation(){return {run_id:runId,request_id:'44444444-4444-4444-8444-444444444444',model:'child-best',goal:'完成本轮复杂子任务',
  required_files:[],allowed_paths:[evidenceRoot],output_dir:evidenceRoot,context_bytes:1024};}

test('Run contract snapshots importance, selections, review scope and delivery independently of mutable Task',()=>{
  const t=fixture(),contract=freezeExecutionContract(t,t.agent_id,t.requested_model),run={execution_contract:contract};
  t.importance='normal';t.model_selection.main.model='economy';t.delivery_profile.deployment.target='后来项目目标';
  t.delivery_target='runtime';t.runtime_root='后来安装目录';t.review_policy={mode:'light',focus:['缩减范围']};
  const frozen=runTask(t,run);
  assert.equal(frozen.importance,'critical');assert.equal(frozen.model_selection.main.model,'execute-best');
  assert.equal(frozen.delivery_profile.deployment.target,'受审测试环境');assert.equal(frozen.delivery_target,'source');assert.equal(frozen.runtime_root,null);
  assert.equal(reviewScope(t,run).mode,'required');assert.deepEqual(reviewScope(t,run).acceptance,t.acceptance);
  frozen.model_selection.main.model='accidental-write';frozen.execution_policy.main_model='accidental-write';
  assert.equal(contract.model_selection.main.model,'execute-best');assert.equal(contract.execution_policy.main_model,'execute-best');
});
test('legacy contracts preserve Task fields missing from historical contract',()=>{
  const t=fixture(),contract=freezeExecutionContract(t,t.agent_id,t.requested_model);
  for(const field of ['importance','model_selection','delivery_profile','delivery_target','runtime_root'])delete contract[field];
  const frozen=runTask(t,{execution_contract:contract});
  for(const field of ['importance','model_selection','delivery_profile','delivery_target','runtime_root'])assert.deepEqual(frozen[field],t[field]);
});
test('new legacy runtime contract freezes its own delivery choice without later project defaults',()=>{
  const t:Record<string,any>={...fixture(),importance:'normal',model_selection:undefined,delivery_profile:undefined,delivery_target:'runtime',runtime_root:'原安装目录'};
  const contract=freezeExecutionContract(t,t.agent_id,t.requested_model);t.runtime_root='后来安装目录';
  const frozen=runTask(t,{execution_contract:contract});
  assert.equal(frozen.delivery_profile.deployment.verification,'portable_manifest');assert.equal(frozen.delivery_profile.deployment.target,'原安装目录');
});
test('critical Run creation cannot silently override the selected main model',()=>{
  const t=fixture();assert.throws(()=>freezeExecutionContract(t,t.agent_id,'economy'),/重新规划/);
});
test('ready critical Task: budget edits keep the planner choice; the user\'s explicit model change wins and is recorded',()=>{
  const t=fixture();Object.assign(t,{current_run_id:null,status:'ready',execution_route:{client:'claude',model:'execute-best'}});const {wb,tables}=fake(t);
  tables.agents[0].preset_id='claude';
  const next:any=saveTaskPolicy(wb,taskId,{revision:1,execution_policy:{...t.execution_policy,context_bytes:32768}});
  assert.equal(next.execution_policy.context_bytes,32768);assert.equal(next.model_selection.user_decision,undefined);
  const chosen:any=saveTaskPolicy(wb,taskId,{revision:2,execution_policy:{...next.execution_policy,main_model:'economy',child_models:['economy']}});
  assert.equal(chosen.requested_model,'economy');assert.equal(chosen.execution_route.model,'economy');
  assert.equal(chosen.model_selection.main.model,'economy');assert.equal(chosen.model_selection.main.decided_by,'user');
  assert.deepEqual(chosen.model_selection.children.map((c:any)=>[c.model,c.decided_by]),[['economy','user']]);
  assert.deepEqual(chosen.model_selection.user_decision.previous_main,{agent_id:'executor',model:'execute-best'});
  assert.equal(chosen.model_selection.strategy,'best_capability','strategy and review stay as planned');assert.equal(chosen.model_selection.review.model,'review-best');
  const added=chosen.model_selection.evaluation.considered.find((c:any)=>c.model==='economy');
  assert.equal(added.capability_assessment,'unknown','a user pick is never relabelled as the best capability');
  // Freezing the user's choice works; an automatic freeze with another model is still rejected.
  assert.equal(freezeExecutionContract(tables.tasks[0],'executor','economy').requested_model,'economy');
  assert.throws(()=>freezeExecutionContract(tables.tasks[0],'executor','execute-best'),/重新规划/);
  // A model outside the member's catalogue is still refused.
  assert.throws(()=>saveTaskPolicy(wb,taskId,{revision:3,execution_policy:{...chosen.execution_policy,main_model:'not-listed'}}),/模型列表/);
  assert.equal(tables.tasks[0].revision,3);
});
test('planner plans cannot claim a user decision',()=>{
  const t=fixture();t.model_selection.main.decided_by='user';
  assert.throws(()=>validatePlannerSelection(t.model_selection));
});
test('delegation uses frozen selection after mutable Task is downgraded',()=>{
  const {wb,tables}=fake();tables.tasks[0].importance='normal';tables.tasks[0].execution_policy.child_models=['economy'];
  tables.tasks[0].model_selection=null;
  const d=registerDelegation(wb,delegation());assert.equal(d.requested_model,'child-best');
  assert.throws(()=>registerDelegation(wb,{...delegation(),request_id:'55555555-5555-4555-8555-555555555555',model:'economy'}),/允许名单/);
  assert.throws(()=>reportDelegation(wb,{run_id:runId,delegation_id:d.id,status:'running',actual_model:'economy'}),/重新规划/);
  const result=reportDelegation(wb,{run_id:runId,delegation_id:d.id,status:'running',actual_model:'child-best',session_id:'real-child-session'});
  assert.equal(result.actual_model,'child-best');
});
test('legacy ordinary delegation keeps the existing child allowlist guard',()=>{
  const t=fixture();t.importance='normal';delete t.model_selection;const {wb}=fake(t),d=registerDelegation(wb,delegation());
  assert.throws(()=>reportDelegation(wb,{run_id:runId,delegation_id:d.id,status:'running',actual_model:'economy'}),/授权范围/);
});
test('compact Run shows frozen selection and generic deployment sequence',()=>{
  const t=fixture(),{run}=fake(t);t.importance='normal';t.model_selection=null;t.delivery_profile.deployment.verification='none';
  const order=compactOrder(t,{delivery_profile:{deployment:{target:'later project target'}}},run,evidenceRoot);
  assert.match(order,/需求重要程度：重点/);assert.match(order,/executor \/ execute-best/);assert.match(order,/受审测试环境/);
  for(const instruction of ['delivery_version','get_deployment_context','report_deployment_evidence'])assert.ok(order.includes(instruction));
  assert.ok(!order.includes('later project target'));
});
test('portable and no-deployment compact instructions retain their own flow',()=>{
  const t=fixture();t.delivery_profile={schema:1,artifacts:['source'],deployment:{mode:'none',verification:'none'}};
  const none=fake(t),noneOrder=compactOrder(t,{},none.run,evidenceRoot);
  assert.ok(!noneOrder.includes('get_deployment_context'));assert.match(noneOrder,/无部署步骤/);
  delete t.delivery_profile;t.delivery_target='runtime';t.runtime_root='原安装目录';
  const portable=fake(t),portableOrder=compactOrder(t,{},portable.run,evidenceRoot);
  assert.match(portableOrder,/report_runtime_deployment/);assert.ok(!portableOrder.includes('report_deployment_evidence'));
});
test('review context rejects reassigned reviewer and known model mismatch before proceeding',()=>{
  const {wb,tables}=fake();tables.review_assignments[0].reviewer_id='another-reviewer';
  assert.throws(()=>reviewAssignmentContext(wb,reviewId),/审查模型选择与独立审查者不一致/);
  tables.review_assignments[0].reviewer_id='reviewer';tables.review_assignments[0].actual_model='economy';
  assert.throws(()=>reviewAssignmentContext(wb,reviewId),/审查实际模型与当前安排不符/);
});

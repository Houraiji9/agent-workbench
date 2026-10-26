import test from 'node:test';
import assert from 'node:assert/strict';
import {importanceSchema,modelSelectionSchema,validatePriorityPlan,priorityInstructions} from '../src/core/priority-policy.ts';

function task(){return {
  agent_id:'executor',reviewer_id:'reviewer',requested_model:'engine-best',review_policy:{mode:'required'},
  execution_policy:{main_model:'engine-best',allow_subagents:true,child_models:['child-best']},
  execution_route:{model:'engine-best'},review_route:{model:'review-best'},
  model_selection:{strategy:'best_capability',main:{agent_id:'executor',model:'engine-best',reason:'复杂工程需要完整推理能力'},
    review:{agent_id:'reviewer',model:'review-best',reason:'独立核查工程边界和失败路径'},
    children:[{agent_id:'executor',model:'child-best',reason:'子任务同样需要完整分析能力'}],
    evaluation:{criteria:'比较当前目录中的推理能力、工程适配和可用资源，逐项说明选择依据',catalog_as_of:'2026-10-25',
      considered:[
        {agent_id:'executor',model:'engine-best',capability_assessment:'best_capability',capability_reason:'复杂工程最适合当前候选的完整推理能力',availability:'available',availability_reason:'规划时已确认当前账号资源可用'},
        {agent_id:'reviewer',model:'review-best',capability_assessment:'best_capability',capability_reason:'独立审查在候选中具有完整分析能力',availability:'available',availability_reason:'规划时已确认审查账号资源可用'},
        {agent_id:'executor',model:'child-best',capability_assessment:'best_capability',capability_reason:'子任务同样需要候选中的完整分析能力',availability:'available',availability_reason:'规划时已确认子代理资源可用'},
        {agent_id:'executor',model:'economy',capability_assessment:'adequate',capability_reason:'日常任务够用但不适合当前重点复杂工程',availability:'available',availability_reason:'经济候选当前资源充足但能力较低'},
      ]},fallback_policy:'stop_and_replan'},
};}

test('importance is independent of workflow size and legacy normal tasks remain valid',()=>{
  assert.equal(importanceSchema.parse('normal'),'normal');
  assert.equal(importanceSchema.parse('critical'),'critical');
  assert.throws(()=>importanceSchema.parse('small'));
  validatePriorityPlan({workflow_kind:'small'},'normal');
  validatePriorityPlan({workflow_kind:'standard'},'normal');
  const t=task();Object.assign(t,{workflow_kind:'small'});validatePriorityPlan(t,'critical');
});
test('critical validates a complete explicit planner contract without hardcoded model names',()=>{
  const t=task();validatePriorityPlan(t,'critical');
  const renamed=JSON.parse(JSON.stringify(t).replaceAll('engine-best','future-model-2030'));
  validatePriorityPlan(renamed,'critical');
});
test('critical rejects absent contracts, weak strategies, and reduced review',()=>{
  assert.throws(()=>validatePriorityPlan({},'critical'),/完整的明确模型选择/);
  const t=task();t.model_selection.strategy='adequate_economical';
  assert.throws(()=>validatePriorityPlan(t,'critical'),/最佳能力/);
  for(const mode of ['light','not_requested'])assert.throws(()=>validatePriorityPlan(task(),'critical',{mode}),/完整独立审查/);
});
test('ordinary tasks use economical adequate choices or explain a capability upgrade',()=>{
  const t=task();assert.throws(()=>validatePriorityPlan(t,'normal'),/升级理由/);
  Object.assign(t.model_selection,{upgrade_reason:'跨模块复杂故障需要完整推理能力'});validatePriorityPlan(t,'normal');
  t.model_selection.strategy='adequate_economical';
  for(const c of t.model_selection.evaluation.considered)c.capability_assessment='adequate';
  validatePriorityPlan(t,'normal');
});
test('selected main model must agree with all explicit execution fields and routes',()=>{
  for(const mutate of [
    (t:ReturnType<typeof task>)=>{t.requested_model='other'},
    (t:ReturnType<typeof task>)=>{t.execution_policy.main_model='other'},
    (t:ReturnType<typeof task>)=>{t.execution_route.model='other'},
    (t:ReturnType<typeof task>)=>{t.model_selection.main.agent_id='other'},
    (t:ReturnType<typeof task>)=>{Object.assign(t,{requested_model:null,execution_policy:{}})},
  ]){const t=task();mutate(t);assert.throws(()=>validatePriorityPlan(t,'critical'));}
  const t=task();Object.assign(t.execution_route,{model:undefined});assert.throws(()=>validatePriorityPlan(t,'critical'),/路线/);
});
test('review selection must be explicit, independent, and route-consistent',()=>{
  for(const mutate of [
    (t:ReturnType<typeof task>)=>{Object.assign(t.model_selection,{review:null})},
    (t:ReturnType<typeof task>)=>{t.reviewer_id='executor'},
    (t:ReturnType<typeof task>)=>{t.model_selection.review.agent_id='other'},
    (t:ReturnType<typeof task>)=>{t.review_route.model='other'},
    (t:ReturnType<typeof task>)=>{Object.assign(t.review_route,{model:undefined})},
  ]){const t=task();mutate(t);assert.throws(()=>validatePriorityPlan(t,'critical'));}
});
test('delegation choices exactly match permission and explicit child allowlist',()=>{
  for(const mutate of [
    (t:ReturnType<typeof task>)=>{t.execution_policy.allow_subagents=false},
    (t:ReturnType<typeof task>)=>{t.model_selection.children=[]},
    (t:ReturnType<typeof task>)=>{t.execution_policy.child_models.push('another')},
    (t:ReturnType<typeof task>)=>{t.model_selection.children[0].agent_id='another'},
    (t:ReturnType<typeof task>)=>{t.model_selection.children.push({...t.model_selection.children[0]})},
    (t:ReturnType<typeof task>)=>{t.execution_policy.child_models.push('child-best')},
  ]){const t=task();mutate(t);assert.throws(()=>validatePriorityPlan(t,'critical'));}
  const t=task();t.execution_policy.allow_subagents=false;t.execution_policy.child_models=[];t.model_selection.children=[];
  validatePriorityPlan(t,'critical');
});
test('critical cannot silently use a lower capability, unavailable, or unknown candidate',()=>{
  for(const availability of ['unavailable','unknown']){
    const t=task();t.model_selection.evaluation.considered[0].availability=availability;
    assert.throws(()=>validatePriorityPlan(t,'critical'),/停止并重新规划/);
  }
  for(const capability of ['adequate','insufficient','unknown']){
    const t=task();t.model_selection.evaluation.considered[0].capability_assessment=capability;
    assert.throws(()=>validatePriorityPlan(t,'critical'),/资源不足不能改用较低能力档/);
  }
});
test('every selected model needs nonempty rationale and an unambiguous candidate assessment',()=>{
  const missing=task();missing.model_selection.evaluation.considered.shift();
  assert.throws(()=>validatePriorityPlan(missing,'critical'),/对应的能力比较/);
  const duplicate=task();duplicate.model_selection.evaluation.considered.push({...duplicate.model_selection.evaluation.considered[0]});
  assert.throws(()=>validatePriorityPlan(duplicate,'critical'),/重复/);
  for(const path of ['reason','criteria','capability_reason','availability_reason']){
    const t=task();
    if(path==='reason')t.model_selection.main.reason=' ';
    else if(path==='criteria')t.model_selection.evaluation.criteria=' ';
    else Object.assign(t.model_selection.evaluation.considered[0],{[path]:' '});
    assert.throws(()=>validatePriorityPlan(t,'critical'));
  }
  const fallback=task();Object.assign(fallback.model_selection,{fallback_policy:'auto'});
  assert.throws(()=>modelSelectionSchema.parse(fallback.model_selection));
});
test('ordinary explicit skip has no stale reviewer contract',()=>{
  const t=task();t.model_selection.strategy='adequate_economical';t.review_policy.mode='not_requested';
  assert.throws(()=>validatePriorityPlan(t,'normal'),/跳过审查/);
  Object.assign(t,{reviewer_id:null,review_route:null});Object.assign(t.model_selection,{review:null});
  validatePriorityPlan(t,'normal');
});
test('execution, review, and child instructions preserve explicit selections and limitations',()=>{
  assert.match(priorityInstructions(task(),'critical'),/executor \/ engine-best/);
  assert.match(priorityInstructions(task(),'critical','review'),/reviewer \/ review-best/);
  assert.match(priorityInstructions(task(),'critical','delegation'),/executor \/ child-best/);
  assert.match(priorityInstructions(task(),'critical'),/未用型号排名证明模型客观最强/);
  assert.match(priorityInstructions(task(),'critical'),/禁止隐式回退/);
  assert.match(priorityInstructions({},'normal'),/能力足够且经济/);
});
import {userReviewSelection,storedModelSelectionSchema} from '../src/core/priority-policy.ts';
test('explicit user reviewer override preserves original planner contract without inventing model capability or availability',()=>{const original=task(),frozen=JSON.stringify(original.model_selection);const selected=userReviewSelection(original.model_selection,{reviewer_id:'user-reviewer',requested_model:'user-model',reason:'用户要求当前任务改用此审查者'});assert.equal(JSON.stringify(original.model_selection),frozen);assert.equal(storedModelSelectionSchema.parse(selected).review?.decided_by,'user');const candidate=selected!.evaluation.considered.find(c=>c.agent_id==='user-reviewer');assert.equal(candidate?.availability,'unknown');assert.equal(candidate?.capability_assessment,'unknown');validatePriorityPlan({...original,reviewer_id:'user-reviewer',review_route:{model:'user-model'},model_selection:selected},'critical');});

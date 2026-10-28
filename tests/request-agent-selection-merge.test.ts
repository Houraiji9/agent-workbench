import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,taskInput} from './helpers.ts';
import {applyRequestAgentSelection} from '../src/core/request-agent-selection.ts';
import {normalizePolicy} from '../src/core/workflow-policy.ts';
import {storedModelSelectionSchema} from '../src/core/priority-policy.ts';
import {chatPlanningContext,chatPlanningBrief,previewChatPlan} from '../src/core/chat-planning.ts';
import type {Row} from '../src/core/schema.ts';

function advice(executor='codex',reviewer='grok-build'){
  return {strategy:'adequate_economical',main:{agent_id:executor,model:'old-main',reason:'合成规划中的主模型说明'},review:{agent_id:reviewer,model:'old-review',reason:'合成规划中的审查模型说明'},children:[{agent_id:executor,model:'old-child',reason:'合成规划中的子模型说明'}],evaluation:{criteria:'仅用于合成测试的历史评估',catalog_as_of:'2026-10-28',considered:[]},fallback_policy:'agent_decides'};
}
function planned(root:string,extra:Row={}):Row{
  return {...taskInput(root),requested_model:'old-main',execution_policy:normalizePolicy({main_model:'old-main',allow_subagents:true,child_models:['old-child'],max_calls:11}),model_selection:advice(),review_route:{client:'grok',model:'old-review'},...extra};
}
function submit(wb:ReturnType<typeof fixture>['wb'],q:Row,task:Row){
  const saved=wb.submitPlan({schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:q.version,tasks:[task]});
  return wb.get('tasks',saved.task_ids[0]);
}

test('changing execution Agent drops old task policy/model/active child advice and selects new project defaults',()=>{
  const {wb,root}=fixture();try{
    const project=wb.get('projects','P-workbench');wb.put('projects',{...project,execution_policies:{claude:normalizePolicy({main_model:'new-agent-default',allow_subagents:true,child_models:['new-child'],max_calls:3})}});
    const q=wb.request({project_id:project.id,text:'合成测试：只预选新的执行者',agent_selection:{execution:{agent_id:'claude'}}});
    const original=planned(root),before=structuredClone(original),merged=applyRequestAgentSelection(wb,q,original);
    assert.equal(merged.requested_model,null);assert.equal(merged.execution_policy,undefined);
    assert.deepEqual(merged.execution_route,{client:'claude'});
    assert.equal(merged.model_selection.main.agent_id,'claude');assert.equal(merged.model_selection.main.model,null);assert.deepEqual(merged.model_selection.children,[]);
    assert.deepEqual(merged.model_selection.review,original.model_selection.review);assert.deepEqual(merged.model_selection.evaluation,original.model_selection.evaluation);assert.deepEqual(original,before);
    const task=submit(wb,q,original);assert.equal(task.agent_id,'claude');assert.equal(task.requested_model,'new-agent-default');assert.equal(task.execution_policy.max_calls,3);assert.deepEqual(task.execution_policy.child_models,['new-child']);
    storedModelSelectionSchema.parse(task.model_selection);
  }finally{wb.close()}
});

test('same-Agent preselection with empty or null model retains the planner model, policy and children',()=>{
  const {wb,root}=fixture();try{
    for(const execution of [{agent_id:'deepseek'},{agent_id:'deepseek',model:null,provider:null}]){
      const q=wb.request({project_id:'P-workbench',text:'合成测试：同成员留空模型',agent_selection:{execution}});
      const input=planned(root,{agent_id:'deepseek',model_selection:advice('deepseek'),execution_route:{client:'dsh',model:'old-main',provider:'planned-provider'}});
      const task=submit(wb,q,input);
      assert.equal(task.requested_model,'old-main');assert.deepEqual(task.execution_policy,input.execution_policy);assert.deepEqual(task.model_selection,input.model_selection);assert.deepEqual(task.execution_route,input.execution_route);
    }
  }finally{wb.close()}
});

test('blank and whitespace preselection fields are omitted choices rather than forced model/Agent replacements',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：空字符串交规划者',agent_selection:{execution:{agent_id:' ',model:'',provider:'  '},review:{model:null}}});
    const input=planned(root),task=submit(wb,q,input);
    assert.equal(task.agent_id,'codex');assert.equal(task.requested_model,'old-main');assert.deepEqual(task.model_selection,input.model_selection);assert.deepEqual(task.execution_policy,input.execution_policy);
  }finally{wb.close()}
});

test('disabling review clears an obsolete reviewer selection before checking whether that reviewer is still active',()=>{
  const {wb}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：禁审清旧预选',review_mode:'not_requested',skip_review:true,review_note:'合成测试由用户自行试用',agent_selection:{review:{agent_id:'cursor',model:'stale-model'}}});
    assert.deepEqual(q.agent_selection.review,{});assert.equal(q.review_policy?.mode,'not_requested');
  }finally{wb.close()}
});

test('changing Agent even within the same Harness client drops the old provider and task-specific model',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：同客户端换成员',agent_selection:{execution:{agent_id:'zcode'}}});
    const input=planned(root,{agent_id:'deepseek',model_selection:advice('deepseek'),execution_route:{client:'dsh',model:'old-main',provider:'old-agent-provider'}});
    const task=submit(wb,q,input);assert.equal(task.agent_id,'zcode');assert.equal(task.requested_model,null);assert.equal(task.execution_policy.main_model,null);assert.deepEqual(task.execution_route,{client:'dsh'});assert.deepEqual(task.model_selection.children,[]);
  }finally{wb.close()}
});

test('explicit execution model overrides same-Agent planning declarations without dropping unrelated children or review',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：只预选模型',agent_selection:{execution:{model:'user-model'}}});
    const input=planned(root),task=submit(wb,q,input);
    assert.equal(task.agent_id,'codex');assert.equal(task.requested_model,'user-model');assert.equal(task.execution_policy.main_model,'user-model');
    assert.equal(task.model_selection.main.model,'user-model');assert.equal(task.model_selection.main.decided_by,'user');assert.deepEqual(task.model_selection.children,input.model_selection.children);assert.deepEqual(task.model_selection.review,input.model_selection.review);
    assert.equal(input.model_selection.main.model,'old-main');storedModelSelectionSchema.parse(task.model_selection);
  }finally{wb.close()}
});

test('new execution Agent plus explicit model uses the new project policy rather than old task budget/children',()=>{
  const {wb,root}=fixture();try{
    const project=wb.get('projects','P-workbench');wb.put('projects',{...project,execution_policies:{claude:normalizePolicy({main_model:'project-default',max_calls:2})}});
    const q=wb.request({project_id:project.id,text:'合成测试：成员和模型覆盖',agent_selection:{execution:{agent_id:'claude',model:'user-model'}}});
    const task=submit(wb,q,planned(root));assert.equal(task.requested_model,'user-model');assert.equal(task.execution_policy.main_model,'user-model');assert.equal(task.execution_policy.max_calls,2);assert.deepEqual(task.execution_policy.child_models,[]);assert.deepEqual(task.model_selection.children,[]);assert.equal(task.model_selection.main.model,'user-model');
  }finally{wb.close()}
});

test('changing reviewer drops its old route model/provider and active advice while retaining execution choices',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：只预选新审查者',agent_selection:{review:{agent_id:'deepseek'}}});
    const input=planned(root),task=submit(wb,q,input);
    assert.deepEqual(task.review_route,{client:'dsh'});assert.equal(task.model_selection.review.agent_id,'deepseek');assert.equal(task.model_selection.review.model,null);
    assert.equal(task.requested_model,'old-main');assert.deepEqual(task.execution_policy,input.execution_policy);assert.deepEqual(task.model_selection.main,input.model_selection.main);assert.deepEqual(task.model_selection.children,input.model_selection.children);storedModelSelectionSchema.parse(task.model_selection);
  }finally{wb.close()}
});

test('review-model-only and provider-only preselection preserve unselected planning fields',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：部分模型与供应商',agent_selection:{execution:{provider:'user-provider'},review:{model:'user-review'}}});
    const input=planned(root,{agent_id:'deepseek',model_selection:advice('deepseek'),execution_route:{client:'dsh',model:'old-main',provider:'planned-provider'}}),task=submit(wb,q,input);
    assert.equal(task.requested_model,'old-main');assert.equal(task.execution_route.model,'old-main');assert.equal(task.execution_route.provider,'user-provider');assert.equal(task.reviewer_id,'grok-build');assert.equal(task.review_route.model,'user-review');assert.equal(task.model_selection.review.model,'user-review');
    const same=wb.request({project_id:'P-workbench',text:'合成测试：仅审查者且同人',agent_selection:{review:{agent_id:'grok-build'}}});
    assert.equal(submit(wb,same,planned(root)).review_route.model,'old-review');
  }finally{wb.close()}
});

test('a provider preselection without Agent is not silently discarded when the planner chooses an incompatible client',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：供应商需匹配成员',agent_selection:{execution:{provider:'user-provider'}}});
    assert.throws(()=>submit(wb,q,planned(root)),/供应商.*Harness/);assert.equal(wb.get('requests',q.id).status,'awaiting_planning');
  }finally{wb.close()}
});

test('manual reviewer model remains in explicit selections without inventing an automatic route or model assessment',()=>{
  const {wb,root}=fixture();try{
    wb.put('agents',{...wb.get('agents','grok-build'),id:'manual-reviewer',preset_id:null,name:'合成人工审查成员',account_ids:[],allowed_kinds:['review']});
    const q=wb.request({project_id:'P-workbench',text:'合成测试：人工成员模型预选',agent_selection:{review:{agent_id:'manual-reviewer',model:'manual-model'}}});
    const task=submit(wb,q,taskInput(root));assert.equal(task.reviewer_id,'manual-reviewer');assert.deepEqual(task.agent_selection.review,{agent_id:'manual-reviewer',model:'manual-model'});assert.equal(task.review_route,undefined);assert.equal(task.model_selection,undefined);
  }finally{wb.close()}
});

test('request-level explicit execution policy remains user intent after changing the planned Agent',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：请求级策略是明确设置',execution_policy:normalizePolicy({main_model:'explicit-request-model',max_calls:7}),agent_selection:{execution:{agent_id:'claude'}}});
    const task=submit(wb,q,planned(root));assert.equal(task.requested_model,'explicit-request-model');assert.equal(task.execution_policy.max_calls,7);assert.equal(task.policy_source,'user_request');
  }finally{wb.close()}
});

test('chat template includes known execution/review model/provider pins and leaves model-only Agent choices open',()=>{
  const {wb}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'合成测试：聊天模板',agent_selection:{execution:{agent_id:'claude',model:'user-main'},review:{agent_id:'deepseek',model:'user-review',provider:'user-provider'}}});
    const context=chatPlanningContext(wb,q.id),task=context.plan_template.tasks[0] as Row;
    assert.equal(task.agent_id,'claude');assert.equal(task.requested_model,'user-main');assert.deepEqual(task.execution_route,{client:'claude',model:'user-main'});assert.deepEqual(task.review_route,{client:'dsh',model:'user-review',provider:'user-provider'});
    assert.deepEqual(chatPlanningBrief(context).request.agent_selection,q.agent_selection);
    const partial=wb.request({project_id:'P-workbench',text:'合成测试：模板只填模型',agent_selection:{execution:{model:'only-model'},review:{model:'only-review',provider:'only-provider'}}});
    const placeholder=chatPlanningContext(wb,partial.id).plan_template.tasks[0] as Row;
    assert.equal(placeholder.requested_model,'only-model');assert.match(placeholder.agent_id,/从团队选择/);assert.equal(placeholder.review_route,undefined);
  }finally{wb.close()}
});

test('chat preview displays resolved user selections and new-Agent defaults while rolling back every stored plan/task change',()=>{
  const {wb,root}=fixture();try{
    const project=wb.get('projects','P-workbench');wb.put('projects',{...project,execution_policies:{claude:normalizePolicy({main_model:'new-project-model'})}});
    const q=wb.request({project_id:project.id,text:'合成测试：预览应显示实际结果',agent_selection:{execution:{agent_id:'claude'},review:{model:'user-review'}}});
    const plan={schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:q.version,tasks:[planned(root)]};
    const auditCount=()=>wb.db.prepare('SELECT count(*) AS total FROM audit').get()!.total;
    const before={tasks:wb.all('tasks').length,plans:wb.all('plans').length,request:wb.get('requests',q.id),audit:auditCount()};
    const preview=previewChatPlan(wb,{text:JSON.stringify(plan)});
    assert.equal(preview.tasks[0].agent_id,'claude');assert.equal(preview.tasks[0].model,'new-project-model');assert.equal(preview.tasks[0].model_selection.review.model,'user-review');assert.equal(preview.plan.tasks[0].agent_id,'codex');
    assert.equal(wb.all('tasks').length,before.tasks);assert.equal(wb.all('plans').length,before.plans);assert.equal(auditCount(),before.audit);assert.deepEqual(wb.get('requests',q.id),before.request);
    const task=submit(wb,q,plan.tasks[0]);assert.equal(task.agent_id,preview.tasks[0].agent_id);assert.equal(task.requested_model,preview.tasks[0].model);
  }finally{wb.close()}
});

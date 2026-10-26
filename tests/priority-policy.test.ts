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


test('importance keeps review coverage but imposes no model selection',()=>{
 for(const importance of ['normal','critical'] as const){validatePriorityPlan({},importance);const t=task();t.model_selection.strategy='adequate_economical';t.model_selection.evaluation.considered=[];t.requested_model='not-in-catalog';t.execution_route.model='client-choice';t.execution_policy.child_models=[];validatePriorityPlan(t,importance);}
 for(const mode of ['light','not_requested'])assert.throws(()=>validatePriorityPlan({},'critical',{mode}),/完整独立审查/);
});
test('model suggestions accept availability unknown, other reviewers, defaults and differing child models',()=>{
 const t=task();for(const availability of ['unavailable','unknown']){t.model_selection.evaluation.considered[0].availability=availability;validatePriorityPlan(t,'critical');}
 Object.assign(t.model_selection,{review:null});Object.assign(t.model_selection.main,{model:null});Object.assign(t,{requested_model:null,review_route:{},execution_route:{},execution_policy:{main_model:null,allow_subagents:true,child_models:[]}});validatePriorityPlan(t,'critical');
 const before=JSON.stringify(t);validatePriorityPlan(t,'critical');assert.equal(JSON.stringify(t),before,'historical advice is not rewritten');
});
test('role prompts allow autonomous models without mandatory disclosure even for old frozen contracts',()=>{
 for(const role of ['execution','review','delegation'] as const){const text=priorityInstructions(task(),'critical',role);assert.match(text,/自主选择/);assert.match(text,/无需自报或证明/);assert.doesNotMatch(text,/只能使用|禁止隐式回退|须如实报告/);}
 assert.match(priorityInstructions({},'normal'),/经济且胜任/);
});
import {userReviewSelection,userModelSelection,storedModelSelectionSchema} from '../src/core/priority-policy.ts';
test('clearing an old model selection selects client default without inventing resource evidence',()=>{
 const t=task(),before=JSON.stringify(t.model_selection),v=userModelSelection(t.model_selection,{agent_id:'executor',model:null,child_models:[],allow_subagents:true,revision:2,at:'2026-10-26T00:00:00Z'})!;
 assert.equal(v.main.model,null);assert.equal(v.fallback_policy,'agent_decides');assert.equal(JSON.stringify(t.model_selection),before);assert.deepEqual(v.evaluation,t.model_selection.evaluation);assert.equal(storedModelSelectionSchema.parse(v).main.decided_by,'user');
 const r=userReviewSelection(t.model_selection,{reviewer_id:'reviewer',requested_model:null,reason:'客户端自行选择模型'})!;assert.equal(r.review.model,null);validatePriorityPlan({...t,model_selection:r},'critical');
});
test('new model advice records unknown availability and retains existing historical assessment',()=>{
 const t=task(),v=userModelSelection(t.model_selection,{agent_id:'executor',model:'new-model',child_models:[],allow_subagents:false,revision:2,at:'2026-10-26T00:00:00Z'})!;
 assert.equal(v.evaluation.considered.at(-1)?.availability,'unknown');assert.deepEqual(v.evaluation.considered.slice(0,-1),t.model_selection.evaluation.considered);
});

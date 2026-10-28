import {userReviewSelection} from './priority-policy.ts';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash,id,now,safePath,inside} from './security.ts';
import {validateModel} from './model-catalog.ts';
import {currentModels} from './resource-management.ts';
import {validatePriorityPlan,userModelSelection} from './priority-policy.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';
import {agentClientKind} from './agent-client-kind.ts';

export const executionPolicySchema=z.object({
  main_model:z.string().trim().min(1).max(100).nullable().default(null),
  allow_subagents:z.boolean().default(false),
  child_models:z.array(z.string().trim().min(1).max(100)).max(12).default([]),
  autonomy:z.enum(['agent_decides','fixed','within_allowlist']).default('agent_decides'),
  max_concurrency:z.number().int().min(1).max(4).default(2),
  max_depth:z.number().int().min(0).max(2).default(1),
  max_calls:z.number().int().min(0).max(30).default(6),
  context_bytes:z.number().int().min(1024).max(262144).default(49152),
  token_budget:z.number().int().positive().max(100000000).nullable().default(null),
  note:z.string().trim().max(2000).default(''),
}).strict();
export type ExecutionPolicy=z.infer<typeof executionPolicySchema>;
export const reviewChoiceSchema=z.enum(['required','light','not_requested']);
export function normalizePolicy(value?:unknown){return executionPolicySchema.parse(value||{})}
export function projectPolicyForAgent(project:Row,agentId?:string){
  if(agentId&&Object.hasOwn(project.execution_policies||{},agentId))return normalizePolicy(project.execution_policies[agentId]);
  if(!project.execution_policy)return undefined;
  // Unscoped defaults may set budgets, but must never choose another Agent's model.
  return {...normalizePolicy(project.execution_policy),main_model:null,child_models:[]};
}
export function resolvePolicy(project:Row,task:Row,request?:Row){
  const projectPolicy=projectPolicyForAgent(project,task.agent_id);
  const selected=request?.execution_policy??task.execution_policy??projectPolicy;
  return {policy:normalizePolicy(selected),source:request?.execution_policy?'user_request':task.execution_policy?'planner':projectPolicy?'project_default':'default'};
}
export function freezeExecutionContract(task:Row,agentId:string,model:string|null){
  const data={version:1,agent_id:agentId,requested_model:model,reviewer_id:task.reviewer_id,
    execution_policy:{...normalizePolicy(task.execution_policy),main_model:model},policy_source:task.policy_source||'legacy_default',
    execution_route:task.execution_route?{...task.execution_route,...(model?{model}:{})}:null,review_route:task.review_route||null,
    automation_policy:task.automation_policy||null,review_policy:task.review_policy||{mode:'required'},
    importance:task.importance||'normal',model_selection:task.model_selection||null,agent_selection:task.agent_selection||null,review_arrangement:task.review_arrangement||null,
    delivery_profile:resolveDeliveryProfile(task),delivery_target:task.delivery_target||'source',runtime_root:task.runtime_root??null};
  checkPriority({...task,...data});
  // Detach nested planner declarations from the mutable Task before hashing/storing the Run.
  const frozen=JSON.parse(JSON.stringify(data));
  return {...frozen,digest:hash(JSON.stringify(frozen)),frozen_at:now()};
}
/** A run's choice never follows later project defaults or a mutable Task. */
export function runTask(task:Row,run:Row):Row{
  const c=run.execution_contract?structuredClone(run.execution_contract):null;
  if(!c)return reviewArrangementTask(task,run);
  const additions=Object.fromEntries(['importance','model_selection','delivery_profile','delivery_target','runtime_root','agent_selection','review_arrangement']
    .filter(key=>Object.hasOwn(c,key)).map(key=>[key,structuredClone(c[key])]));
  return reviewArrangementTask({...task,agent_id:c.agent_id,requested_model:c.requested_model,reviewer_id:c.reviewer_id,
    execution_policy:rPolicy(run,c),execution_route:c.execution_route||undefined,review_route:c.review_route||undefined,
    automation_policy:c.automation_policy||undefined,review_policy:c.review_policy,...additions},run);
}
function rPolicy(run:Row,contract:Row){return run.policy_advice||contract.execution_policy;}
function reviewArrangementTask(task:Row,run:Row):Row{
  const a=run.review_arrangement;if(!a)return task;
  return {...task,reviewer_id:a.reviewer_id,review_route:a.route||undefined,
    model_selection:userReviewSelection(task.model_selection,{reviewer_id:a.reviewer_id,requested_model:a.requested_model,reason:a.reason}),
    review_arrangement:a};
}
function checkPriority(task:Row){
  try{validatePriorityPlan(task,task.importance||'normal',task.review_policy)}catch(error){
    if(task.importance==='critical')assert(false,'重点需求模型或审查合约不再符合要求，请重新规划：'+(error instanceof Error?error.message:String(error)),409);
    throw error;
  }
}
export function policyCapabilities(client?:string){return {managed_delegation:'authorization_and_receipts',native_subagents:'instructions_only',native_enforcement:false,
  token_budget:'soft',client:client||'external',note:'工作台记录委派与结果，次数、并发、层数和预算均为建议。未登记的客户端内部调用保持未知。'};}
/**
 * Task fields a user arrangement changes. A route for another client cannot be reused, so it is dropped
 * (the order then waits for manual hand-off) rather than launching a different member's client.
 */
export function applyUserArrangement(t:Row,agent:Row,model:string|null){
  const policy=normalizePolicy(t.execution_policy),sameClient=!!t.execution_route&&agentClientKind(agent)===t.execution_route.client;
  return {agent_id:agent.id,requested_model:model,execution_policy:{...policy,main_model:model},
    execution_route:sameClient?{...t.execution_route,model}:null,
    model_selection:userModelSelection(t.model_selection,{agent_id:agent.id,model,child_models:policy.child_models,allow_subagents:policy.allow_subagents,revision:t.revision,at:now()})};
}
export const taskPolicyInput=z.object({revision:z.number().int().positive(),agent_id:z.string().max(80).optional(),execution_policy:executionPolicySchema}).strict();
export function saveTaskPolicy(wb:Workbench,taskId:string,input:unknown){const v=taskPolicyInput.parse(input);return wb.transaction(()=>{
  const t=wb.get('tasks',taskId);assert(t.revision===v.revision,'任务设置已变化，请刷新',409);

  const agent=v.agent_id||t.agent_id,a=wb.get('agents',agent);assert(agent!==t.reviewer_id,'独立审查须记录另一位审查者');
  const model=validateModel(agent,v.execution_policy.main_model,new Date(),wb.config.timezone,t.work_kind,currentModels(wb));
  for(const child of v.execution_policy.child_models)validateModel(agent,child,new Date(),wb.config.timezone,t.work_kind,currentModels(wb));
  // The user's choice replaces the planner's model selection; another member's automatic route is never reused.
  const next={...t,...applyUserArrangement({...t,execution_policy:v.execution_policy},a,model),policy_source:'user_task',revision:t.revision+1,updated_at:now()};
  checkPriority(next);
  if(t.current_run_id){const r=wb.get('runs',t.current_run_id);r.policy_advice_history=[...(r.policy_advice_history||[]),{at:now(),previous:r.policy_advice||r.execution_contract?.execution_policy,policy:v.execution_policy}];r.policy_advice=v.execution_policy;wb.put('runs',r,{task_id:t.id});}
  wb.put('tasks',next,{project_id:t.project_id});wb.audit('user','set_task_execution_policy',t.id,{policy:next.execution_policy});return next;
})}
export function saveProjectPolicy(wb:Workbench,pid:string,input:unknown){const v=z.object({version:z.number().int().positive(),agent_id:z.string().trim().min(1).max(80).nullable().optional(),execution_policy:executionPolicySchema}).strict().parse(input);return wb.transaction(()=>{
  const p=wb.get('projects',pid);assert(p.version===v.version,'项目设置已变化，请刷新',409);assert(!p.archived,'请先恢复项目',409);
  if(v.agent_id){const a=wb.get('agents',v.agent_id);assert(!a.archived,'请先恢复该 Agent',409);const catalog=currentModels(wb);
    validateModel(a.id,v.execution_policy.main_model,new Date(),wb.config.timezone,undefined,catalog);
    for(const model of v.execution_policy.child_models)validateModel(a.id,model,new Date(),wb.config.timezone,undefined,catalog);
  }else assert(!v.execution_policy.main_model&&!v.execution_policy.child_models.length,'固定主模型或子模型前，请先选择适用的 Agent');
  const fields=v.agent_id?{execution_policies:{...(p.execution_policies||{}),[v.agent_id]:v.execution_policy}}:{execution_policy:v.execution_policy};
  const next={...p,...fields,version:p.version+1,updated_at:now()};wb.put('projects',next);wb.audit('user','set_project_execution_policy',pid,{agent_id:v.agent_id||null,policy:v.execution_policy});return next;
})}
export const delegationInput=z.object({run_id:z.string(),request_id:z.string().uuid(),model:z.string().trim().min(1).max(100).nullable().default(null),goal:z.string().trim().min(5).max(2000),
  parent_id:z.string().nullable().default(null),required_files:z.array(z.string()).max(20),allowed_paths:z.array(z.string()).min(1).max(10),output_dir:z.string(),context_bytes:z.number().int().min(1).max(262144)}).strict();
export function registerDelegation(wb:Workbench,input:unknown){const v=delegationInput.parse(input);return wb.transaction(()=>{
  const r=wb.get('runs',v.run_id),original=wb.get('tasks',r.task_id),t=runTask(original,r),p=normalizePolicy(t.execution_policy);
  assert(original.current_run_id===r.id,'请在当前执行登记委派',409);
  checkPriority(t);
  const existing=wb.all('delegations').find(x=>x.run_id===r.id&&x.request_id===v.request_id),digest=hash(JSON.stringify(v));if(existing){assert(existing.request_digest===digest,'委派请求编号冲突',409);return existing;}
  const warnings:string[]=p.allow_subagents?[]:['原计划未建议使用子代理；本次自主委派已记录'];
  const all=wb.all('delegations').filter(x=>x.run_id===r.id);if(all.length>=p.max_calls)warnings.push('超过建议委派次数');if(all.filter(x=>['authorized','running'].includes(x.status)).length>=p.max_concurrency)warnings.push('超过建议并发数');
  const parent=v.parent_id?all.find(x=>x.id===v.parent_id):null;assert(!v.parent_id||parent&&['authorized','running'].includes(parent.status),'父委派无效',409);
  const depth=(parent?.depth||0)+1;if(depth>p.max_depth)warnings.push('超过建议层数');if(v.context_bytes>p.context_bytes)warnings.push('超过建议上下文预算');
  const roots=wb.roots(wb.get('projects',t.project_id));
  const allowed=v.allowed_paths.map(f=>{const real=safePath(f,roots,true);assert(!wb.privatePath(real),'子代理路径涉及内部数据',403);return real;});
  const output=safePath(v.output_dir,allowed,true);assert(!wb.privatePath(output),'子代理产物不能写入内部数据',403);
  const required=v.required_files.map(f=>{const real=safePath(f,roots);assert(!wb.privatePath(real),'子代理不能读取内部数据',403);return real;});
  const row={...v,id:id('D'),task_id:t.id,project_id:t.project_id,depth,required_files:required,allowed_paths:allowed,output_dir:output,status:'authorized',warnings,
    requested_model:v.model,actual_model:null,session_id:null,source:'executor_reported',control_level:'instructions_only',request_digest:digest,policy_digest:r.execution_contract?.digest||null,created_at:now(),updated_at:now()};
  wb.put('delegations',row,{run_id:r.id});wb.audit('runner','authorize_delegation',row.id,{run_id:r.id});return row;
})}
export const delegationReportInput=z.object({run_id:z.string(),delegation_id:z.string(),status:z.enum(['running','completed','failed','cancelled']),session_id:z.string().max(300).optional(),actual_model:z.string().max(100).nullable().optional(),summary:z.string().trim().max(4000).default(''),artifacts:z.array(z.string()).max(20).default([])}).strict();
export function reportDelegation(wb:Workbench,input:unknown){const v=delegationReportInput.parse(input);return wb.transaction(()=>{
  const d=wb.get('delegations',v.delegation_id),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(d.run_id===r.id&&t.current_run_id===r.id,'禁止跨执行报告子代理',403);
  const frozen=runTask(t,r);checkPriority(frozen);
  const digest=hash(JSON.stringify(v));if(d.report_digest===digest)return d;
  const report_history=[...(d.report_history||[]),...(d.report_digest?[{at:d.updated_at,status:d.status,summary:d.summary,artifacts:d.artifacts,report_digest:d.report_digest}]:[])];
  const artifacts=v.artifacts.map(f=>{const real=safePath(f,d.allowed_paths);assert(!wb.privatePath(real),'产物涉及内部文件',403);return real;});
  const row={...d,...v,artifacts,report_history,report_digest:digest,updated_at:now(),...(['completed','failed','cancelled'].includes(v.status)?{ended_at:now()}:{}),observed_by:'executor_reported'};wb.put('delegations',row,{run_id:r.id});return row;
})}

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
  autonomy:z.enum(['fixed','within_allowlist']).default('fixed'),
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
    importance:task.importance||'normal',model_selection:task.model_selection||null,
    delivery_profile:resolveDeliveryProfile(task),delivery_target:task.delivery_target||'source',runtime_root:task.runtime_root??null};
  checkPriority({...task,...data});
  // Detach nested planner declarations from the mutable Task before hashing/storing the Run.
  const frozen=JSON.parse(JSON.stringify(data));
  return {...frozen,digest:hash(JSON.stringify(frozen)),frozen_at:now()};
}
/** A run's choice never follows later project defaults or a mutable Task. */
export function runTask(task:Row,run:Row):Row{
  const c=run.execution_contract?structuredClone(run.execution_contract):null;
  if(!c)return task;
  const additions=Object.fromEntries(['importance','model_selection','delivery_profile','delivery_target','runtime_root']
    .filter(key=>Object.hasOwn(c,key)).map(key=>[key,structuredClone(c[key])]));
  return {...task,agent_id:c.agent_id,requested_model:c.requested_model,reviewer_id:c.reviewer_id,
    execution_policy:c.execution_policy,execution_route:c.execution_route||undefined,review_route:c.review_route||undefined,
    automation_policy:c.automation_policy||undefined,review_policy:c.review_policy,...additions};
}
function checkPriority(task:Row){
  try{validatePriorityPlan(task,task.importance||'normal',task.review_policy)}catch(error){
    if(task.importance==='critical')assert(false,'重点需求模型或审查合约不再符合要求，请重新规划：'+(error instanceof Error?error.message:String(error)),409);
    throw error;
  }
}
export function policyCapabilities(client?:string){return {managed_delegation:'authorization_and_receipts',native_subagents:'instructions_only',native_enforcement:false,
  token_budget:'soft',client:client||'external',note:'工作台检查经它登记的委派；客户端内部子代理由执行者遵守设置，当前不能强制拦截或保证完整观测。Token预算为提醒，不是硬封顶。'};}
/**
 * Task fields a user arrangement changes. A route for another client cannot be reused, so it is dropped
 * (the order then waits for manual hand-off) rather than launching a different member's client.
 */
export function applyUserArrangement(t:Row,agent:Row,model:string|null){
  const policy=normalizePolicy(t.execution_policy),sameClient=!!t.execution_route&&agentClientKind(agent)===t.execution_route.client;
  return {agent_id:agent.id,requested_model:model,execution_policy:{...policy,main_model:model},
    execution_route:sameClient?{...t.execution_route,...(model?{model}:{})}:null,
    model_selection:userModelSelection(t.model_selection,{agent_id:agent.id,model,child_models:policy.child_models,allow_subagents:policy.allow_subagents,revision:t.revision,at:now()})};
}
export const taskPolicyInput=z.object({revision:z.number().int().positive(),agent_id:z.string().max(80).optional(),execution_policy:executionPolicySchema}).strict();
export function saveTaskPolicy(wb:Workbench,taskId:string,input:unknown){const v=taskPolicyInput.parse(input);return wb.transaction(()=>{
  const t=wb.get('tasks',taskId);assert(t.revision===v.revision,'任务设置已变化，请刷新',409);
  assert(!t.current_run_id&&t.status==='ready','执行单已冻结；模型和委派权限变更需要新执行单，不能修改本轮设置',409);
  const agent=v.agent_id||t.agent_id,a=wb.get('agents',agent);assert(!a.archived&&a.allowed_kinds.includes(t.work_kind)&&agent!==t.reviewer_id,'执行者不符合职责或独立审查要求');
  const model=validateModel(agent,v.execution_policy.main_model??(agent===t.agent_id?t.requested_model:null),new Date(),wb.config.timezone,t.work_kind,currentModels(wb));
  for(const child of v.execution_policy.child_models)validateModel(agent,child,new Date(),wb.config.timezone,t.work_kind,currentModels(wb));
  // The user's choice replaces the planner's model selection; another member's automatic route is never reused.
  const next={...t,...applyUserArrangement({...t,execution_policy:v.execution_policy},a,model),policy_source:'user_task',revision:t.revision+1,updated_at:now()};
  checkPriority(next);
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
export const delegationInput=z.object({run_id:z.string(),request_id:z.string().uuid(),model:z.string().trim().min(1).max(100),goal:z.string().trim().min(5).max(2000),
  parent_id:z.string().nullable().default(null),required_files:z.array(z.string()).max(20),allowed_paths:z.array(z.string()).min(1).max(10),output_dir:z.string(),context_bytes:z.number().int().min(1).max(262144)}).strict();
export function registerDelegation(wb:Workbench,input:unknown){const v=delegationInput.parse(input);return wb.transaction(()=>{
  const r=wb.get('runs',v.run_id),original=wb.get('tasks',r.task_id),t=runTask(original,r),p=normalizePolicy(t.execution_policy);
  assert(original.current_run_id===r.id&&r.status==='running','只能登记当前正在执行的委派',409);assert(!wb.get('projects',t.project_id).dispatch_paused,'项目已暂缓新委派',409);
  checkPriority(t);
  const existing=wb.all('delegations').find(x=>x.run_id===r.id&&x.request_id===v.request_id),digest=hash(JSON.stringify(v));if(existing){assert(existing.request_digest===digest,'委派请求编号冲突',409);return existing;}
  assert(p.allow_subagents,'用户未允许本轮使用子代理',403);assert(p.child_models.includes(v.model),'子模型不在本轮允许名单',403);
  if(t.importance==='critical')assert(t.model_selection.children.some((choice:Row)=>choice.agent_id===t.agent_id&&choice.model===v.model),'重点需求子代理必须使用冻结选择中的模型；请重新规划',403);
  const all=wb.all('delegations').filter(x=>x.run_id===r.id);assert(all.length<p.max_calls,'已达本轮委派次数上限',409);assert(all.filter(x=>['authorized','running'].includes(x.status)).length<p.max_concurrency,'已达委派并发上限',409);
  const parent=v.parent_id?all.find(x=>x.id===v.parent_id):null;assert(!v.parent_id||parent&&['authorized','running'].includes(parent.status),'父委派无效',409);
  const depth=(parent?.depth||0)+1;assert(depth<=p.max_depth,'已达子代理层数上限',403);assert(v.context_bytes<=p.context_bytes,'子代理上下文超过允许预算',403);
  const roots=parent?.allowed_paths||t.allowed_paths;
  const allowed=v.allowed_paths.map(f=>{const real=safePath(f,roots,true);assert(!wb.privatePath(real),'子代理路径涉及内部数据',403);return real;});
  const output=safePath(v.output_dir,allowed,true);assert(!wb.privatePath(output),'子代理产物不能写入内部数据',403);
  const required=v.required_files.map(f=>{const real=safePath(f,t.allowed_paths);assert(!wb.privatePath(real),'子代理不能读取内部数据',403);if(parent)assert(parent.required_files.includes(real)||allowed.some((a:string)=>inside(a,real)),'补读不在父委派范围',403);return real;});
  const row={...v,id:id('D'),task_id:t.id,project_id:t.project_id,depth,required_files:required,allowed_paths:allowed,output_dir:output,status:'authorized',
    requested_model:v.model,actual_model:null,session_id:null,source:'executor_reported',control_level:'instructions_only',request_digest:digest,policy_digest:r.execution_contract?.digest||null,created_at:now(),updated_at:now()};
  wb.put('delegations',row,{run_id:r.id});wb.audit('runner','authorize_delegation',row.id,{run_id:r.id});return row;
})}
export const delegationReportInput=z.object({run_id:z.string(),delegation_id:z.string(),status:z.enum(['running','completed','failed','cancelled']),session_id:z.string().max(300).optional(),actual_model:z.string().max(100).optional(),summary:z.string().trim().max(4000).default(''),artifacts:z.array(z.string()).max(20).default([])}).strict();
export function reportDelegation(wb:Workbench,input:unknown){const v=delegationReportInput.parse(input);return wb.transaction(()=>{
  const d=wb.get('delegations',v.delegation_id),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(d.run_id===r.id&&t.current_run_id===r.id,'禁止跨执行报告子代理',403);
  const frozen=runTask(t,r);checkPriority(frozen);
  if(frozen.importance==='critical'&&v.actual_model)assert(v.actual_model===d.requested_model&&frozen.model_selection.children.some((choice:Row)=>choice.agent_id===frozen.agent_id&&choice.model===v.actual_model),'重点需求子代理实际模型偏离冻结选择；停止继续委派并重新规划',403);
  const digest=hash(JSON.stringify(v));if(d.report_digest===digest)return d;
  assert(['authorized','running'].includes(d.status),'已结束的委派不能覆盖记录',409);
  if(v.actual_model)assert(normalizePolicy(frozen.execution_policy).child_models.includes(v.actual_model),'报告的模型不在授权范围；保留错误并停止继续委派',403);
  const artifacts=v.artifacts.map(f=>{const real=safePath(f,d.allowed_paths);assert(!wb.privatePath(real),'产物涉及内部文件',403);return real;});
  const row={...d,...v,artifacts,report_digest:digest,updated_at:now(),...(['completed','failed','cancelled'].includes(v.status)?{ended_at:now()}:{}),observed_by:'executor_reported'};wb.put('delegations',row,{run_id:r.id});return row;
})}

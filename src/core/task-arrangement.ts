// 用户在同一任务里修改执行者、主模型与子代理安排。按任务阶段生效，旧执行单、交付与审查保持原样。
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,now} from './security.ts';
import {validateModel} from './model-catalog.ts';
import {currentModels} from './resource-management.ts';
import {executionPolicySchema,normalizePolicy,saveTaskPolicy,applyUserArrangement} from './workflow-policy.ts';
import {validatePriorityPlan} from './priority-policy.ts';
import {arrangementPhase} from '../shared/arrangement.ts';

export const arrangementInput=z.object({revision:z.number().int().positive(),agent_id:z.string().trim().min(1).max(80).optional(),
  execution_policy:executionPolicySchema.optional(),clear_pending:z.literal(true).optional()}).strict()
  .refine(v=>!!v.execution_policy!==!!v.clear_pending,'请提供新的执行安排，或明确撤回下一版安排');

export const arrangementProposalInput=z.object({revision:z.number().int().positive(),agent_id:z.string().trim().min(1).max(80).optional(),execution_policy:executionPolicySchema}).strict();

/** A conversation can prepare an arrangement, but only a page action labels it as the user's decision. */
export function proposeTaskArrangement(wb:Workbench,taskId:string,input:unknown){const v=arrangementProposalInput.parse(input);return wb.transaction(()=>{
  const t=wb.get('tasks',taskId);assert(t.revision===v.revision,'任务已变化，请读取最新版本',409);
  const run=t.current_run_id?wb.get('runs',t.current_run_id):null;
  assert(arrangementPhase(t,run,wb.all('agent_jobs'))!=='closed','任务已结束，不能提出新的执行安排',409);
  const policy=normalizePolicy(v.execution_policy),agentId=v.agent_id||run?.agent_id||t.agent_id;
  const {model}=checkCandidate(wb,t,run,agentId,policy);
  const proposal={agent_id:agentId,requested_model:model,execution_policy:{...policy,main_model:model},source:'manager_proposal',base_run_id:t.current_run_id||null,proposed_at:now()};
  const next={...t,proposed_arrangement:proposal,revision:t.revision+1,updated_at:now()};
  wb.put('tasks',next,{project_id:t.project_id});wb.audit('manager','propose_arrangement',t.id,{proposal});
  return {task:next,applied:false,next:'建议已保存到任务的执行安排；用户可以调整后采用，当前执行与下一版安排均未改变。'};
})}

function checkCandidate(wb:Workbench,t:Row,run:Row|null,agentId:string,policy:Row){
  const a=wb.get('agents',agentId);
  assert(!a.archived&&a.allowed_kinds.includes(t.work_kind)&&agentId!==t.reviewer_id,'执行者不符合职责或独立审查要求');
  wb.eligible(agentId);
  const current=run?.agent_id===agentId?run.requested_model:agentId===t.agent_id?t.requested_model:null;
  const catalog=currentModels(wb),model=validateModel(agentId,policy.main_model,new Date(),wb.config.timezone,t.work_kind,catalog);
  for(const child of policy.child_models)validateModel(agentId,child,new Date(),wb.config.timezone,t.work_kind,catalog);
  // Same inputs exportOrder freezes: the Task's selection with the previous Run's review scope.
  const base=run?.execution_contract?{...t,review_policy:run.execution_contract.review_policy}:t;
  const next:Row={...base,...applyUserArrangement({...base,execution_policy:policy},a,model)};
  validatePriorityPlan(next,next.importance||'normal',next.review_policy);
  return {agent:a,model};
}

export function changeTaskArrangement(wb:Workbench,taskId:string,input:unknown){
  return wb.transaction(()=>{
    const result=applyTaskArrangement(wb,taskId,input),task=wb.get('tasks',taskId);
    if(task.proposed_arrangement){delete task.proposed_arrangement;wb.put('tasks',task,{project_id:task.project_id});}
    return {...result,task};
  });
}
function applyTaskArrangement(wb:Workbench,taskId:string,input:unknown){
  const v=arrangementInput.parse(input);
  const t=wb.get('tasks',taskId);assert(t.revision===v.revision,'任务已变化，请刷新后再改',409);
  const run=t.current_run_id?wb.get('runs',t.current_run_id):null,phase=arrangementPhase(t,run,wb.all('agent_jobs'));
  if(v.clear_pending){
    assert(t.pending_arrangement,'没有待生效的下一版安排',409);
    return wb.transaction(()=>{const next:Row={...t,revision:t.revision+1,updated_at:now()};delete next.pending_arrangement;
      wb.put('tasks',next,{project_id:t.project_id});wb.audit('user','clear_pending_arrangement',t.id,{previous:t.pending_arrangement});return {phase,task:next};});
  }
  const policy=normalizePolicy(v.execution_policy),agentId=v.agent_id||run?.agent_id||t.agent_id;
  assert(phase!=='closed','任务已结束，执行安排只留档；如需继续请提新需求',409);
  if(phase==='direct')return {phase,task:saveTaskPolicy(wb,taskId,{revision:v.revision,agent_id:agentId,execution_policy:policy})};
  const {model}=checkCandidate(wb,t,run,agentId,policy);
  if(phase==='pending')return wb.transaction(()=>{
    const pending={agent_id:agentId,requested_model:model,execution_policy:{...policy,main_model:model},saved_at:now(),base_run_id:t.current_run_id,source:'user_page'};
    const next={...t,pending_arrangement:pending,revision:t.revision+1,updated_at:now()};
    wb.put('tasks',next,{project_id:t.project_id});wb.audit('user','save_pending_arrangement',t.id,{run_id:t.current_run_id,pending});return {phase,task:next};
  });
  return wb.transaction(()=>{
    if(phase==='replace_unstarted'){
      // Not started: retire the unused order in place (kept on disk and in the ledger) before freezing the new one.
      const old=wb.get('runs',run!.id);assert(!old.has_started,'执行者已接单，不能作废',409);
      wb.put('runs',{...old,status:'cancelled',cancelled_at:now(),cancel_reason:'用户修改执行安排；该执行单尚未开始，按新安排重新生成',updated_at:now()},{task_id:t.id});
      wb.audit('user','retire_unstarted_order',old.id,{task_id:t.id});
    }
    const order=wb.exportOrder(t.id,t.version,true,agentId,v.revision,model,policy);
    return {phase,order,task:wb.get('tasks',t.id)};
  });
}

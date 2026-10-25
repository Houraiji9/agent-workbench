import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,id,now} from './security.ts';
import {mainExecutionControlInput} from './agent-route-schema.ts';
import {supersededLaunch} from './manual-takeover.ts';

/** Supplied by the authenticated page/MCP route or the internal scheduler, never tool arguments. */
export type MainExecutionCaller={role:'user'|'runner'|'planner'|'manager'|'system';source:'page'|'mcp'|'automation'};
export type MainExecutionIntent='initial'|'rework'|'closeout';
export const isPageUser=(caller:MainExecutionCaller|undefined)=>caller?.role==='user'&&caller.source==='page';

/** A planner's automation policy is a proposal; only a separate page decision grants permission. */
export function mainExecutionControl(task:Row):'user'|'automatic'{
  const decision=task.main_execution_control_decision;
  return task.main_execution_control==='automatic'&&decision?.source==='user_page'&&decision.mode==='automatic'&&!!decision.id?'automatic':'user';
}
export function mainExecutionControlSummary(task:Row){return {mode:mainExecutionControl(task),first_start:'user',
  automatic_rework:mainExecutionControl(task)==='automatic'&&task.automation_policy?.auto_rework===true,
  automatic_closeout:mainExecutionControl(task)==='automatic'&&task.automation_policy?.continue_after_review===true,
  decision:task.main_execution_control_decision||null};}
export function setMainExecutionControl(wb:Workbench,taskId:string,input:unknown,caller:MainExecutionCaller){
  assert(isPageUser(caller),'主执行启动许可只能由用户在工作台页面设置',403);
  const v=mainExecutionControlInput.parse(input);
  return wb.transaction(()=>{const t=wb.get('tasks',taskId);
    assert(t.revision===v.expected_revision,'任务已变化，请刷新后再设置',409);
    assert(!t.request_withdrawn&&!['accepted','cancelled','rework_linked'].includes(t.status)&&!wb.get('projects',t.project_id).archived,'只能设置当前有效任务的主执行启动许可',409);
    const at=now(),decision={id:id('MC'),mode:v.main_execution_control,source:'user_page',at,task_revision:t.revision};
    const next={...t,main_execution_control:v.main_execution_control,main_execution_control_decision:decision,revision:t.revision+1,updated_at:at};
    wb.put('tasks',next,{project_id:t.project_id});
    wb.audit('user','set_main_execution_control',t.id,{previous:mainExecutionControl(t),mode:v.main_execution_control,decision_id:decision.id});
    return {task:next,control:mainExecutionControlSummary(next)};
  });
}
export function manuallyTakenOver(wb:Workbench,taskId:string,runId:string){return wb.all('agent_jobs').some(j=>j.task_id===taskId&&j.run_id===runId&&j.role==='execution'&&supersededLaunch(j));}
function assertAutomatic(wb:Workbench,t:Row,intent:MainExecutionIntent,sourceRunId:string){
  assert(mainExecutionControl(t)==='automatic','主执行由用户掌控；请在任务页面启动，或由用户开启自动返修与收尾',403);
  assert(intent!=='initial','首次启动主执行必须由用户在工作台页面操作',403);
  assert(intent==='rework'?t.automation_policy?.auto_rework===true:t.automation_policy?.continue_after_review===true,'当前任务未安排此自动执行步骤',403);
  assert(!manuallyTakenOver(wb,t.id,sourceRunId)&&!manuallyTakenOver(wb,t.id,t.current_run_id),'本轮已由执行者手工接管，返修或收尾须由用户启动',403);
}
export function authorizeMainLaunch(wb:Workbench,t:Row,caller:MainExecutionCaller|undefined,intent:MainExecutionIntent,sourceRunId:string){
  if(!isPageUser(caller)){
    assert(caller?.role==='system'&&caller.source==='automation','外部主执行只能由用户在工作台页面启动；Agent不能代为启动',403);
    assertAutomatic(wb,t,intent,sourceRunId);
  }
  return {kind:isPageUser(caller)?'user':'automatic',intent,source_run_id:sourceRunId,
    control_decision_id:t.main_execution_control_decision?.id||null,authorized_at:now()};
}
/** Rechecked before resolving the client and immediately before spawn; revocation invalidates queued calls. */
export function assertMainLaunch(wb:Workbench,job:Row,t:Row,r:Row){
  if(job.role!=='execution')return;
  const a=job.main_launch_authorization;
  assert(a&&['user','automatic'].includes(a.kind)&&['initial','rework','closeout'].includes(a.intent),'此主执行调用没有页面启动或自动执行许可，请由用户重新启动',403);
  assert(a.control_decision_id===(t.main_execution_control_decision?.id||null),'主执行启动许可已变化，已排队的调用不能继续启动，请由用户重新安排',403);
  if(a.kind==='automatic'){
    assertAutomatic(wb,t,a.intent,a.source_run_id);
    if(a.intent==='rework')assert(r.retry_context?.previous_run_id===a.source_run_id&&r.retry_context?.task_status==='changes_requested','自动返修必须关联已要求修改的上一轮执行',403);
    if(a.intent==='closeout')assert(job.phase==='closeout'&&a.source_run_id===r.id,'自动收尾必须属于当前已审执行',403);
  }
}

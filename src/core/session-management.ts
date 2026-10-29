import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert} from './security.ts';

/** Credential-derived scope. Tool arguments never select the caller's identity. */
export type ManagementCaller={role:'manager'|'runner'|'reviewer';id:string;run_id?:string;review_id?:string;project_id?:string;project_ids?:string[]};
export const sessionManagementWrites=['classify_project_files','manage_requests','manage_projects','manage_tasks','manage_reviews','manage_memories','link_execution_session','open_workbench_folder'];
export const sessionManagementReads=['preflight_run_evidence','get_release_source','get_project_files','get_project_memories','get_management_context','get_management_result','get_task_detail','get_planning_entry','get_session_messages','read_artifact'];
export function sessionCaller(wb:Workbench,role:'runner'|'reviewer',scope:string):ManagementCaller{
 const a=role==='reviewer'?wb.get('review_assignments',scope):null,r=wb.get('runs',a?.run_id||scope),t=wb.get('tasks',r.task_id);
 assert(t.current_run_id===r.id&&!['cancelled','rework_linked'].includes(t.status),'此连接对应的执行已结束，请使用当前执行连接',409);
 if(a)assert(!['superseded','revoked','cancelled'].includes(a.status),'此审查安排已结束，请使用当前安排',409);
 const actor=role+':'+scope;return {role,id:actor,run_id:r.id,review_id:a?.id,project_id:t.project_id,project_ids:[t.project_id,...(r.management_project_grants||[]).filter((g:Row)=>g.actor===actor).map((g:Row)=>g.project_id)]};
}
/** Ordinary project management stays in the current conversation, within its bound project. */
export function scopeManagementInput(wb:Workbench,name:string,input:Row,caller:ManagementCaller):Row{
 if(caller.role==='manager')return input;
 assert([...sessionManagementWrites,...sessionManagementReads].includes(name),'此操作属于全局设置，请在主会话办理',403);
 const v=structuredClone(input),change=v.change||v,pid=caller.project_id;
 const checkProject=(id:string)=>assert((caller.project_ids||[pid]).includes(id),'该项目尚未关联当前会话，请先按用户要求关联项目范围',403);
 const checkTask=(id:string)=>checkProject(wb.get('tasks',id).project_id);
 const checkRun=(id:string)=>checkTask(wb.get('runs',id).task_id);
 for(const data of [change,change.data,change.data?.changes].filter(Boolean)){
   if(data.project_id&&!(name==='manage_projects'&&change.action==='link_scope'))checkProject(data.project_id);
   if(data.source_task_id)checkTask(data.source_task_id);
   if(data.source_run_id)checkRun(data.source_run_id);
   if(data.task_id)checkTask(data.task_id);
   if(data.run_id)checkRun(data.run_id);
   if(data.review_id){const report=wb.maybe('review_assignments',data.review_id)||wb.get('reviews',data.review_id);checkRun(report.run_id);}
   if(data.artifact_id)checkRun(wb.get('artifacts',data.artifact_id).run_id);
 }
 if(name==='manage_requests'){
   if(change.action!=='create')checkProject(wb.get('requests',change.request_id).project_id);
   if(change.data?.project_id)checkProject(change.data.project_id);
   assert(change.action!=='create'||(caller.project_ids||[pid]).includes(change.data?.project_id),'新需求须属于当前会话已关联的项目',403);
 }
 if(name==='manage_projects'&&['create','link_scope'].includes(change.action))assert(typeof v.user_instruction==='string'&&v.user_instruction.trim().length>=2,'关联新项目需要用户明确要求',403);
 if(name==='get_management_context'){v.project_id=v.project_id||pid;}
 if(name==='get_management_result'){const saved=wb.get('management_calls',v.request_id);assert(saved.caller?.project_id===pid,'此管理记录不属于当前项目',403);}
 if(name==='get_planning_entry')checkProject(wb.get('requests',v.request_id).project_id);
 if(name==='get_session_messages'||name==='link_execution_session'){
   const s=wb.get('sessions',change.session_id);assert(s.project_id===pid||s.run_id&&wb.get('tasks',wb.get('runs',s.run_id).task_id).project_id===pid,'会话不属于当前项目',403);
 }
 return v;
}

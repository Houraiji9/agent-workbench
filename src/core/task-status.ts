import {z} from 'zod';
import type {Workbench} from './workbench.ts';import type {Row} from './schema.ts';
import {taskAction,taskDisplayStatus} from '../shared/workflow-view.ts';
import {runTask} from './workflow-policy.ts';
import {effectiveRouteView} from './agent-route-diagnostics.ts';
const sections=['runs','events','artifacts','reviews','review_assignments','sessions','reply_history'] as const;
export const taskStatusOptions=z.object({detail:z.enum(['brief','full']).default('brief'),section:z.enum(sections).optional(),after_id:z.string().max(200).optional(),id:z.string().max(200).optional(),limit:z.number().int().min(1).max(25).default(5)}).strict();
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');
const text=(v:unknown,n=240)=>String(v??'').slice(0,n);
function summary(r:Row){return {id:text(r.id,160),run_id:r.run_id?text(r.run_id,160):undefined,status:text(r.status||r.verdict||r.event_type||r.disposition,80),at:text(r.updated_at||r.occurred_at||r.created_at,80),reason:text(r.reason||r.message||r.findings||r.data?.message),sha256:r.sha256?text(r.sha256,64):undefined};}
function measured(v:Row){v.usage={...v.usage,bytes:0};for(let i=0;i<4;i++)v.usage.bytes=bytes(v);return v;}
/** Bounded read projection only. Full evidence stays in its original task and record. */
export function taskStatus(wb:Workbench,taskId:string,options:unknown={}){
 const o=taskStatusOptions.parse(options),detail=wb.taskDetail(taskId) as Row;
 if(o.detail==='full')return detail;
 const t=detail.task as Row,r=(detail.runs as Row[]).find(r=>r.id===t.current_run_id),action=taskAction(t),full_ref={tool:'get_task_detail',arguments:{task_id:taskId,detail:'full'}};
 const ref=(section:string,id?:string)=>({tool:'get_task_detail',arguments:{task_id:taskId,section,...(id?{id}:{})}});
 if(o.id&&!o.section)throw Error('按ID读取证据需要 section，例如 {"task_id":"'+taskId+'","section":"reviews","id":"RV-…"}');
 if(o.section&&o.id){const row=(detail[o.section]||[]).find((v:Row)=>v.id===o.id);if(!row)throw Error('此任务没有指定证据 ID');return {task_id:taskId,section:o.section,id:o.id,detail:'full_record',record:row,full_ref};}
 const effective=r?runTask(t,r):t;
 const routeRole=['submitted','in_review'].includes(t.status)?'review':'execution',route=(routeRole==='review'?effective.review_route:effective.execution_route);
 const candidate=t.automation?.job_id?wb.maybe('agent_jobs',t.automation.job_id):null;
 const job=candidate&&candidate.run_id===t.current_run_id&&(candidate.role||t.automation?.role)===routeRole?candidate:null;
 const reason=job&&['failed','interrupted'].includes(job.status)&&!job.superseded?text(job.reason||job.interruption?.kind||'客户端调用未完成',700):text(t.blocker||t.blocked_reason||r?.retry_context?.last_obstacle?.message||action.label,700);
 const verdicts=new Set((detail.reviews||[]).filter((v:Row)=>v.run_id===t.current_run_id&&!v.revoked_at&&!v.historical).map((v:Row)=>v.verdict));
 let blocker:string|null=null;
 if(t.status==='awaiting_confirmation')blocker=t.delivery_target==='runtime'&&!t.deployment?.verified?'deployment_pending':'user_trial';
 else if(['submitted','in_review'].includes(t.status)){const counts=detail.review_summary?.counts||{};blocker=t.review_stage==='awaiting_decision'&&!t.review_can_proceed?(verdicts.size>1?'review_disagreement':'review_decision'):job&&['failed','interrupted'].includes(job.status)&&!job.superseded?'tool_failure':counts.completed<counts.total?'missing_reports':'routine_wait';}
 else if(['blocked','failed','closeout_blocked'].includes(t.status))blocker='reported_obstacle';
 else if(['waiting_input','closeout_waiting_input'].includes(t.status))blocker='answer_required';
 const tool=t.status==='awaiting_confirmation'?(blocker==='deployment_pending'?'get_deployment_context':null):['awaiting_closeout','closing','closeout_blocked','closeout_waiting_input'].includes(t.status)?'get_closeout_context':['submitted','in_review'].includes(t.status)?'get_run_context':t.current_run_id?'get_run_context':null;
 const out:Row={schema_version:1,detail:'brief',task_id:taskId,run_id:t.current_run_id||null,title:text(t.title,240),status:t.status,display_status:taskDisplayStatus(t),run_status:r?.status||null,revision:t.revision,version:t.version,owner:{role:action.owner,id:action.owner==='agent'?effective.agent_id:action.owner==='reviewer'?effective.reviewer_id:null},blocker,reason,next_action:{...action,tool,arguments:tool?{run_id:t.current_run_id}:null},effective_route:route?effectiveRouteView(route,job?.actual_model,job?.actual_model_display,job?.route?'current_task_route_with_job_observation':'current_task_route'):null,review:{stage:t.review_stage||null,counts:detail.review_summary?.counts||t.review_report_counts||null,can_proceed:!!t.review_can_proceed},task:{id:taskId,title:text(t.title,240),project_id:t.project_id,status:t.status,version:t.version,revision:t.revision,current_run_id:t.current_run_id||null,agent_id:effective.agent_id,reviewer_id:effective.reviewer_id,delivery_target:effective.delivery_target||'source'},history:{},omitted:{},full_ref,usage:{limit_bytes:20*1024,source_bytes:bytes(detail),bytes:0}};
 for(const section of sections){
  const rows:Row[]=detail[section]||[],start=o.section===section&&o.after_id?rows.findIndex(v=>v.id===o.after_id)+1:0;
  if(o.section===section&&o.after_id&&start===0)throw Error('分页 after_id 不属于此任务证据；请从 section 首页读取');
  const count=o.section?o.section===section?o.limit:0:2,selected=rows.slice(Math.max(0,start),start+count),items=selected.map(v=>({...summary(v),full_ref:ref(section,v.id)}));
  out.history[section]={total:rows.length,items,next_after_id:start+selected.length<rows.length&&selected.length?selected.at(-1)!.id:null,full_ref:ref(section)};
  out.omitted[section]={count:rows.length-selected.length,bytes:Math.max(0,bytes(rows)-bytes(items))};
 }
 measured(out);
 // Reduce only returned summaries until the serialized UTF8 envelope fits; evidence is retained.
 while(out.usage.bytes>20*1024){
  const section=[...sections].sort((a,b)=>bytes(out.history[b].items)-bytes(out.history[a].items)).find(k=>out.history[k].items.length);
  if(!section){out.review.counts=null;measured(out);break;}
  const h=out.history[section];h.items.pop();h.next_after_id=h.items.length?h.items.at(-1).full_ref.arguments.id:null;
  out.omitted[section]={count:h.total-h.items.length,bytes:Math.max(0,bytes(detail[section]||[])-bytes(h.items))};measured(out);
 }
 return out;
}

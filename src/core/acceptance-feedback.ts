import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {assert,id,now} from './security.ts';
import {assertReworkLink} from './task-dependencies.ts';
const input=z.object({revision:z.number().int().positive(),run_id:z.string(),note:z.string().trim().min(1).max(10000),artifact_hashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),followup_task_id:z.string().optional()}).strict();
export function rejectAcceptance(wb:Workbench,tid:string,value:unknown){assert(!wb.managementContext.getStore(),'请用户在工作台确认退回',403);const v=input.parse(value);return wb.transaction(()=>{
 const t=wb.get('tasks',tid);assert(t.revision===v.revision,'任务已更新，请重新打开确认',409);assert(t.current_run_id===v.run_id,'交付版本已更新，请重新查看',409);
 assert(['submitted','in_review','awaiting_confirmation'].includes(t.status),'当前任务不在试用确认阶段',409);
 const r=wb.get('runs',v.run_id);assert(r.status==='submitted','当前执行尚未交付',409);
 const hashes=wb.all('artifacts').filter(a=>a.run_id===r.id&&a.current).map(a=>a.sha256).sort();
 assert(JSON.stringify([...v.artifact_hashes].sort())===JSON.stringify(hashes),'产物版本已变化，请重新查看',409);
 if(v.followup_task_id){const f=wb.get('tasks',v.followup_task_id);assert(f.id!==t.id&&f.project_id===t.project_id&&!['accepted','cancelled','rework_linked'].includes(f.status),'请选择本项目正在处理的后续任务');assertReworkLink(wb,t.id,f.id);}
 const feedback={id:id('F'),task_id:tid,run_id:r.id,note:v.note,artifact_hashes:hashes,verdict:'rejected',source:'user_entered',created_at:now(),followup_task_id:v.followup_task_id||null};
 t.acceptance_feedback=[...(t.acceptance_feedback||[]),feedback];t.status=v.followup_task_id?'rework_linked':'acceptance_rejected';t.rework_task_id=v.followup_task_id||null;t.revision++;t.updated_at=now();
 wb.put('tasks',t,{project_id:t.project_id});wb.audit('user','reject_acceptance',tid,feedback);return {task:t,feedback};
})}
export function reworkOrder(wb:Workbench,tid:string,value:unknown){const v=z.object({revision:z.number().int().positive(),feedback_id:z.string()}).strict().parse(value),t=wb.get('tasks',tid),feedback=t.acceptance_feedback?.at(-1);
 assert(feedback?.id===v.feedback_id&&!feedback.followup_task_id,'返工意见已更新，请重新打开任务',409);
 const r=wb.get('runs',t.current_run_id);
 if(r.retry_context?.user_feedback?.some((f:any)=>f.id===feedback.id))return wb.exportOrder(tid,t.version);
 assert(t.revision===v.revision&&t.status==='acceptance_rejected','任务已更新，请重新打开任务',409);
 return wb.exportOrder(tid,t.version,true,r.agent_id,t.revision,r.requested_model||null);
}

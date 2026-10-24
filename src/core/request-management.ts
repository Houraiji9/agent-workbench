import {z} from 'zod';import type {Workbench} from './workbench.ts';import {assert,id,now} from './security.ts';import {canEditRequest} from '../shared/request-policy.ts';
const input=z.object({delivery_target:z.enum(['source','runtime']).optional(),project_id:z.string().min(1),text:z.string().trim().min(1).max(20000),status:z.enum(['draft','awaiting_planning']).default('awaiting_planning'),kind:z.enum(['idea','plan','memo']).default('idea'),version:z.number().int().positive().optional(),replan:z.boolean().optional(),skip_review:z.boolean().optional(),review_note:z.string().trim().max(2000).optional()}).strict();
export {input as requestInput};
function withdrawPlan(wb:Workbench,qid:string,reason:string,at:string){
 const tasks=wb.all('tasks').filter(t=>t.request_id===qid&&!t.request_withdrawn),ids=new Set(tasks.map(t=>t.id));
 assert(!wb.all('tasks').some(t=>t.request_id!==qid&&!['accepted','cancelled','rework_linked'].includes(t.status)&&(t.dependencies||[]).some((d:string)=>ids.has(d))),'其他任务正在依赖这份计划，请先调整关联任务',409);
 for(const t of tasks){if(t.current_run_id){const r=wb.get('runs',t.current_run_id);wb.put('runs',{...r,status:'cancelled',updated_at:at},{task_id:t.id});}
   wb.put('tasks',{...t,status:'cancelled',revision:t.revision+1,updated_at:at,request_withdrawn:true,cancel_reason:reason},{project_id:t.project_id});wb.audit('user','withdraw_unstarted_plan',t.id,{request_id:qid,reason});}
}
export function saveRequest(wb:Workbench,qid:string|null,value:unknown){const v=input.parse(value);return wb.transaction(()=>{
 const p=wb.get('projects',v.project_id);assert(!p.archived,'请先恢复这个项目，再修改需求',409);
 const old=qid?wb.get('requests',qid):null;
 if(old){assert(old.version===v.version,'需求已更新，请重新打开再编辑',409);assert(!wb.get('projects',old.project_id).archived,'请先恢复原项目，再修改需求',409);assert(canEditRequest(old,wb.all('tasks'),wb.all('runs')),'这项需求已派发或开始执行，请提交补充需求',409);}
 const at=now();
 if(old?.status==='planned'){
   assert(v.replan===true,'请确认撤回原计划，再保存修改',409);
   withdrawPlan(wb,old.id,'需求修改，原计划撤回',at);
 }
 const policy=v.skip_review?{mode:'not_requested',source:'user_requested',note:v.review_note||'',recorded_at:at}:null;
 if(policy&&v.status==='awaiting_planning')assert(policy.note.length>=5,'不安排审查需要用户说明，请填写至少 5 个字');
 const row={...old,delivery_target:v.delivery_target??old?.delivery_target??p.delivery_target??'source',delivery_target_source:v.delivery_target?'user_selected':old?.delivery_target_source||'project_default',id:old?.id||id('Q'),project_id:v.project_id,text:v.text,status:v.status,kind:v.kind,review_policy:policy,version:(old?.version||0)+1,created_at:old?.created_at||at,updated_at:at,
   history:old?[...(old.history||[]),{text:old.text,project_id:old.project_id,status:old.status,kind:old.kind||'idea',version:old.version,review_policy:old.review_policy||null,saved_at:at}]:[]};
 wb.put('requests',row,{project_id:row.project_id});wb.audit('user',old?'edit_request':'request',row.id,{before:old,after:row});return row;
})}
export function deleteRequest(wb:Workbench,qid:string,value:unknown){const v=z.object({version:z.number().int().positive()}).strict().parse(value);return wb.transaction(()=>{
 const old=wb.get('requests',qid);assert(old.version===v.version,'需求已更新，请重新打开再删除',409);assert(!old.deleted_at,'这项需求已经删除',409);
 assert(!wb.get('projects',old.project_id).archived,'请先恢复项目，再删除需求',409);assert(canEditRequest(old,wb.all('tasks'),wb.all('runs')),'这项需求已派发或开始执行，请在任务中处理',409);
 const at=now();if(old.status==='planned')withdrawPlan(wb,qid,'需求删除，原计划撤回',at);
 const row={...old,status:'deleted',deleted_at:at,updated_at:at,version:old.version+1,history:[...(old.history||[]),{text:old.text,project_id:old.project_id,status:old.status,kind:old.kind||'idea',version:old.version,review_policy:old.review_policy||null,saved_at:at}]};
 wb.put('requests',row,{project_id:old.project_id});wb.audit('user','delete_request',qid,{before:old,after:row});return {id:qid,deleted:true,version:row.version};
})}
export function archiveProject(wb:Workbench,pid:string,value:unknown){const v=z.object({version:z.number().int().positive(),archived:z.boolean()}).strict().parse(value);return wb.transaction(()=>{
 const before=wb.get('projects',pid);assert(before.version===v.version,'项目资料已更新，请重新打开操作',409);assert(!!before.archived!==v.archived,v.archived?'项目已经归档':'项目已经恢复',409);
 if(v.archived){const active=wb.all('tasks').filter(t=>t.project_id===pid&&!['accepted','cancelled','rework_linked'].includes(t.status));assert(!active.length,`还有 ${active.length} 项任务待处理，请先完成或取消后归档`,409);}
 const after={...before,id:pid,archived:v.archived,archived_at:v.archived?now():null,version:before.version+1,updated_at:now()};wb.put('projects',after);wb.audit('user',v.archived?'archive_project':'restore_project',pid,{before,after});return after;
})}

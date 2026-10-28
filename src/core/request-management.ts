import {z} from 'zod';import type {Workbench} from './workbench.ts';import {assert,id,now} from './security.ts';import {canEditRequest} from '../shared/request-policy.ts';
import {executionPolicySchema,reviewChoiceSchema} from './workflow-policy.ts';
import {importanceSchema} from './priority-policy.ts';
import {requestAgentSelectionSchema,validateRequestAgentSelection} from './request-agent-selection.ts';
import {deliveryProfileSchema,resolveDeliveryProfile} from './delivery-profile.ts';
const input=z.object({agent_selection:requestAgentSelectionSchema.optional(),planning_preferences:z.object({delivery:z.enum(['project','planner','custom'])}).strict().optional(),importance:importanceSchema.optional(),delivery_profile:deliveryProfileSchema.optional(),workflow_kind:z.enum(['standard','small']).optional(),desired_output:z.string().trim().max(2000).optional(),success_criteria:z.string().trim().max(2000).optional(),execution_policy:executionPolicySchema.optional(),review_mode:reviewChoiceSchema.optional(),review_focus:z.array(z.string().trim().min(2).max(500)).max(12).optional(),delivery_target:z.enum(['source','runtime']).optional(),project_id:z.string().min(1),text:z.string().trim().min(1).max(20000),status:z.enum(['draft','awaiting_planning']).default('awaiting_planning'),kind:z.enum(['idea','plan','memo']).default('idea'),version:z.number().int().positive().optional(),replan:z.boolean().optional(),skip_review:z.boolean().optional(),review_note:z.string().trim().max(2000).optional()}).strict();
export {input as requestInput};
function withdrawPlan(wb:Workbench,qid:string,reason:string,at:string){
 const tasks=wb.all('tasks').filter(t=>t.request_id===qid&&!t.request_withdrawn),ids=new Set(tasks.map(t=>t.id));
 assert(!wb.all('tasks').some(t=>t.request_id!==qid&&!['accepted','cancelled','rework_linked'].includes(t.status)&&(t.dependencies||[]).some((d:string)=>ids.has(d))),'其他任务正在依赖这份计划，请先调整关联任务',409);
 for(const t of tasks){if(t.current_run_id){const r=wb.get('runs',t.current_run_id);wb.put('runs',{...r,status:'cancelled',updated_at:at},{task_id:t.id});}
   wb.put('tasks',{...t,status:'cancelled',revision:t.revision+1,updated_at:at,request_withdrawn:true,cancel_reason:reason},{project_id:t.project_id});wb.audit('user','withdraw_unstarted_plan',t.id,{request_id:qid,reason});}
}
export function saveRequest(wb:Workbench,qid:string|null,value:unknown){const v=input.parse(value);return wb.transaction(()=>{
 const p=wb.get('projects',v.project_id);assert(!p.archived,'请先恢复这个项目，再修改需求',409);assert(!p.shelved,'这个项目已收纳，请先恢复项目再提需求',409);
 const old=qid?wb.get('requests',qid):null;
 if(old){assert(old.version===v.version,'需求已更新，请重新打开再编辑',409);assert(!wb.get('projects',old.project_id).archived,'请先恢复原项目，再修改需求',409);assert(canEditRequest(old,wb.all('tasks'),wb.all('runs')),'这项需求已派发或开始执行，请提交补充需求',409);}
 const at=now();
 if(old?.status==='planned'){
   assert(v.replan===true,'请确认撤回原计划，再保存修改',409);
   withdrawPlan(wb,old.id,'需求修改，原计划撤回',at);
 }
 const mode=v.review_mode||(v.skip_review!==undefined?(v.skip_review?'not_requested':'required'):old?.review_policy?.mode||'required');
 const sameProject=!old||old.project_id===p.id;
 const importance=v.importance??(sameProject?old?.importance:undefined)??p.importance??'normal';assert(importance!=='critical'||mode==='required','重点需求必须采用完整独立审查，不能有限审查或免审');
 const preferences=v.planning_preferences??(v.delivery_profile||v.delivery_target?{delivery:'custom'}:sameProject?old?.planning_preferences:undefined);
 const deliveryChoice=preferences?.delivery;
 assert(deliveryChoice!=='custom'||v.delivery_profile||sameProject&&old?.delivery_profile,'请选择这次要交付的成果');
 assert(!deliveryChoice||deliveryChoice==='custom'||!v.delivery_profile&&!v.delivery_target,'交给大脑安排或沿用项目时，不要同时提交另一份交付选择');
 const deliveryProfile=deliveryChoice==='project'||deliveryChoice==='planner'?resolveDeliveryProfile({},p):resolveDeliveryProfile(v.delivery_profile?{delivery_profile:v.delivery_profile}:v.delivery_target?{delivery_target:v.delivery_target,runtime_root:p.runtime_root}:sameProject?old||{}:{},p);
 const deliverySource=deliveryChoice==='planner'?'planner_requested':deliveryChoice==='project'?'project_default':v.delivery_profile?'user_selected':sameProject?old?.delivery_profile_source||'project_default':'project_default';
 const policy=mode==='required'?null:{mode,source:'user_requested',note:v.review_note??old?.review_policy?.note??'',focus:v.review_focus??old?.review_policy?.focus??[],recorded_at:at};
 if(mode==='light')assert((policy?.focus||[]).length>0,'有限审查需要至少一个明确检查点');
 if(mode==='not_requested'&&policy&&v.status==='awaiting_planning')assert(policy.note.length>=5,'不安排审查需要用户说明，请填写至少 5 个字');
 const executionPolicy=v.execution_policy??old?.execution_policy;
 const agentSelection=validateRequestAgentSelection(wb,v.agent_selection??(sameProject?old?.agent_selection:undefined),mode);
 const row={...old,agent_selection:agentSelection,planning_preferences:preferences??null,importance,importance_source:v.importance?'user_selected':sameProject?old?.importance_source||'project_default':'project_default',delivery_profile:deliveryProfile,delivery_profile_source:deliverySource,workflow_kind:v.workflow_kind??old?.workflow_kind??'standard',desired_output:v.desired_output??old?.desired_output??'',success_criteria:v.success_criteria??old?.success_criteria??'',...(executionPolicy===undefined?{}:{execution_policy:executionPolicy}),delivery_target:deliveryProfile.deployment.verification==='portable_manifest'?'runtime':'source',delivery_target_source:deliveryChoice?deliverySource:v.delivery_target?'user_selected':sameProject?old?.delivery_target_source||'project_default':'project_default',id:old?.id||id('Q'),project_id:v.project_id,text:v.text,status:v.status,kind:v.kind,review_policy:policy,version:(old?.version||0)+1,created_at:old?.created_at||at,updated_at:at,
   history:old?[...(old.history||[]),{text:old.text,project_id:old.project_id,status:old.status,kind:old.kind||'idea',version:old.version,review_policy:old.review_policy||null,importance:old.importance,importance_source:old.importance_source,delivery_profile:old.delivery_profile,delivery_profile_source:old.delivery_profile_source,planning_preferences:old.planning_preferences,agent_selection:old.agent_selection,saved_at:at}]:[]};
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

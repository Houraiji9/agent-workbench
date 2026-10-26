import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,id,now,safePath} from './security.ts';
import {invalidateCloseout} from './closeout.ts';
import {validateTaskContextContract} from './file-context.ts';
const text=z.string().trim().min(1).max(20000);
export const taskAmendmentInput=z.object({task_id:z.string(),run_id:z.string(),expected_revision:z.number().int().positive(),reason:text,
 changes:z.object({goal:text.optional(),scope:text.optional(),acceptance:z.array(text).min(1).max(40).optional(),tests:z.array(text).min(1).max(100).optional(),required_files:z.array(z.string().min(1)).max(30).optional()}).strict().refine(v=>Object.keys(v).length>0,'请说明需要补充或修改的内容')}).strict();
export function amendTask(wb:Workbench,input:unknown){const v=taskAmendmentInput.parse(input);return wb.transaction(()=>{
 const t=wb.get('tasks',v.task_id),r=wb.get('runs',v.run_id);assert(r.task_id===t.id&&t.current_run_id===r.id,'请修改当前执行的任务',409);
 assert(t.revision===v.expected_revision,'任务已变化，请读取当前版本',409);assert(!['accepted','cancelled','rework_linked'].includes(t.status),'已结束任务仅保留历史',409);
 for(const f of v.changes.required_files||[]){const real=safePath(f,t.allowed_paths);assert(!wb.privatePath(real),'补充阅读不能包含工作台凭据',403);}
 const before=Object.fromEntries(Object.keys(v.changes).map(k=>[k,t[k]]));
 if(JSON.stringify(before)===JSON.stringify(v.changes))return {task:t,run_id:r.id,changed:false};
 const change={id:id('AM'),at:now(),before,changes:v.changes,reason:v.reason,source:wb.managementContext.getStore()||{actor:'user',via:'page'}};
 r.amendments=[...(r.amendments||[]),change];r.scope_revision=(r.scope_revision||0)+1;r.review_decision=null;
 invalidateCloseout(wb,r,'用户补充了本轮任务内容；历史交付保留，按新内容重新核验');
 const amendments=(r.amendments as Row[]);Object.assign(t,v.changes,{revision:t.revision+1,updated_at:now()});
 if(v.changes.required_files&&t.context_contract){t.context_contract={...t.context_contract,required:v.changes.required_files.map(path=>({path})),supplemental:t.context_contract.supplemental.filter((entry:Row)=>!v.changes.required_files!.includes(entry.path))};validateTaskContextContract(wb,t);}
 for(const a of wb.all('review_assignments').filter(a=>a.run_id===r.id&&!['revoked','superseded','cancelled'].includes(a.status))){wb.put('review_assignments',{...a,status:'superseded',superseded_reason:change.reason,superseded_at:change.at},{run_id:r.id});}
 const needsDelivery=['submitted','in_review','changes_requested','awaiting_closeout','closing','closeout_blocked','closeout_waiting_input','awaiting_confirmation'].includes(t.status);
 if(needsDelivery){t.status='changes_requested';t.review_stage='awaiting_delivery';}
 t.current_review_assignment_id=null;wb.put('runs',{...r,amendments,updated_at:now()},{task_id:t.id});wb.put('tasks',t,{project_id:t.project_id});wb.audit('conversation','amend_task',t.id,{run_id:r.id,amendment:change});
 return {task:t,run_id:r.id,amendment:change,changed:true,next:needsDelivery?'补充已保存在本任务；生成下一版执行后交付变更内容，旧成果和审查保留。':'本任务已更新；旧执行单保留，当前会话读取增量后继续。'};
});}

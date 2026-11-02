import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {assert,id,now} from './security.ts';

const key=z.string().trim().min(1).max(200);
export const appendTaskNoteInput=z.object({
 task_id:key,run_id:key,expected_revision:z.number().int().positive(),
 note:z.string().trim().min(1).max(20000),
 references:z.array(z.object({kind:z.enum(['text','run','review','artifact']),value:z.string().trim().min(1).max(2000)}).strict()).max(30).optional(),
}).strict();

/** A management annotation records its actual author; it never constitutes an executor receipt. */
export function appendTaskNote(wb:Workbench,input:unknown,actor:string){
 const v=appendTaskNoteInput.parse(input);key.parse(actor);
 return wb.transaction(()=>{
  const t=wb.get('tasks',v.task_id),r=wb.get('runs',v.run_id);
  assert(r.task_id===t.id&&t.current_run_id===r.id,'备注须绑定任务当前 Run',409);
  assert(t.revision===v.expected_revision,'任务已变化，请读取当前版本',409);
  for(const ref of v.references||[]){
   if(ref.kind==='text')continue;
   const target=ref.kind==='run'?wb.get('runs',ref.value):ref.kind==='artifact'?wb.get('artifacts',ref.value):(wb.maybe('reviews',ref.value)||wb.get('review_assignments',ref.value));
   const run=ref.kind==='run'?target:wb.get('runs',target.run_id);
   assert(wb.get('tasks',run.task_id).project_id===t.project_id,'备注引用不属于目标项目',403);
  }
  const at=now(),note={id:id('TN'),at,actor,note:v.note,references:v.references||[],verification:'unverified_note' as const};
  wb.put('runs',{...r,notes:[...(r.notes||[]),note],updated_at:at},{task_id:t.id});
  wb.put('tasks',{...t,revision:t.revision+1,updated_at:at},{project_id:t.project_id});
  wb.audit(actor,'append_task_note',t.id,{run_id:r.id,note});
  return {task_id:t.id,run_id:r.id,revision:t.revision+1,note,changed:true};
 });
}

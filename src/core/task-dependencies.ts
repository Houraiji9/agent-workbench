import type {Workbench} from './workbench.ts';
import {assert} from './security.ts';

// 旧交付未通过时，依赖等待其替代任务真正验收；旧任务自身保持未通过。
export function dependencySatisfied(wb:Workbench,tid:string){
 const seen=new Set<string>();let t=wb.get('tasks',tid);
 while(t.status==='rework_linked'){
  if(seen.has(t.id)||!t.rework_task_id)return false;
  seen.add(t.id);t=wb.get('tasks',t.rework_task_id);
 }
 return t.status==='accepted';
}

// 将 old -> followup 加入图之前，沿依赖及已有替代关系检查是否会回到 old。
export function assertReworkLink(wb:Workbench,oldId:string,followupId:string){
 const pending=[followupId],seen=new Set<string>();
 while(pending.length){const id=pending.pop()!;assert(id!==oldId,'后续任务依赖这项交付，请选择独立的修改任务',409);if(seen.has(id))continue;seen.add(id);
  const t=wb.get('tasks',id);pending.push(...t.dependencies);if(t.status==='rework_linked'&&t.rework_task_id)pending.push(t.rework_task_id);
 }
}

import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,now} from './security.ts';
export const projectHoldInput=z.object({version:z.number().int().positive(),shelved:z.boolean()}).strict();
export function assertProjectDispatch(wb:Workbench,projectId:string){const p=wb.get('projects',projectId);assert(!p.archived&&!p.dispatch_paused,'项目已收纳暂缓，请恢复后再安排新工作',409);}
export function projectHold(wb:Workbench,pid:string,input:unknown){const v=projectHoldInput.parse(input);return wb.transaction(()=>{
  const p=wb.get('projects',pid);assert(p.version===v.version,'项目已变化，请刷新',409);assert(!p.archived,'归档项目请先恢复',409);
  const taskProjects=new Map(wb.all('tasks').map(t=>[t.id,t.project_id]));
  const jobs=wb.all('agent_jobs').filter(j=>(j.project_id||taskProjects.get(j.task_id))===pid&&['launching','running'].includes(j.status));
  const next={...p,shelved:v.shelved,dispatch_paused:v.shelved,shelved_at:v.shelved?now():null,version:p.version+1,updated_at:now()};wb.put('projects',next);
  wb.audit('user',v.shelved?'shelve_project':'resume_project',pid,{running_jobs:jobs.map(j=>j.id),current_calls_continue:true});
  return {project:next,running_jobs:jobs.map(j=>({id:j.id,task_id:j.task_id,status:j.status})),note:v.shelved?'当前调用继续；后续新派发已暂停。停止当前调用请在任务中单独操作。':'项目已恢复；保留原任务和历史。排队中的工作可继续，已结束调用不会重放。'};
})}
export function visibleProjectTasks(tasks:Row[],projects:Row[]){const hidden=new Set(projects.filter(p=>p.archived||p.shelved).map(p=>p.id));return tasks.filter(t=>!hidden.has(t.project_id));}

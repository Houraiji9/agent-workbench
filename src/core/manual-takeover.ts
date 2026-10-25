// 执行者在工作台自动启动失败后手动接单：失败调用保留原样，另记“已被同一 Run 的正式接单取代”的证据。
// 取代只解除允许的自动审查派发和页面阻碍提示，不恢复主执行的自动启动（返修、收尾仍由用户安排）。
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {now} from './security.ts';

/**
 * 只认定原进程确已结束、属于同一 Run、且接单发生在调用结束之后的失败执行调用。
 * 结束证据：记录了结束时间；没有结束时间时，必须明确记为进程不在运行，并以创建时间判断先后。
 */
export function supersedable(job:Row,runId:string,startedAt:string){
  const ended=job.ended_at?String(job.ended_at)<=startedAt:job.process_may_be_running===false&&String(job.created_at||'')<=startedAt;
  return job.run_id===runId&&job.role==='execution'&&job.phase==='execution'&&['failed','interrupted'].includes(job.status)
    &&job.process_may_be_running!==true&&!job.superseded&&!!startedAt&&ended;
}

export function supersededLaunch(job:Row){return !!job.superseded&&job.process_may_be_running!==true;}

/** 在调用方事务内标记；返回被标记的调用编号。 */
export function markTakeover(wb:Workbench,runId:string,started:{event_id:string;at:string},source:'started'|'reconcile'){
  const marked:string[]=[];
  for(const job of wb.all('agent_jobs').filter(j=>supersedable(j,runId,started.at))){
    const evidence={by:'started',run_id:runId,event_id:started.event_id,started_at:started.at,at:now(),source};
    wb.put('agent_jobs',{...job,superseded:evidence},{run_id:runId});marked.push(job.id);
    const t=wb.get('tasks',job.task_id);
    if(t.automation?.job_id===job.id){t.automation={...t.automation,superseded:evidence};wb.put('tasks',t,{project_id:t.project_id});}
    wb.audit('system','supersede_failed_launch',job.id,evidence);
  }
  return marked;
}

/** 升级前已接单的记录：按已应用的 started 回执补记，可重复执行。 */
export function reconcileTakeovers(wb:Workbench){
  const marked:string[]=[];
  const candidates=wb.all('agent_jobs').filter(j=>j.role==='execution'&&j.phase==='execution'&&['failed','interrupted'].includes(j.status)&&j.process_may_be_running!==true&&!j.superseded);
  if(!candidates.length)return marked;
  wb.transaction(()=>{
    for(const runId of new Set(candidates.map(j=>j.run_id))){
      const started=wb.all('events').filter(e=>e.run_id===runId&&e.event_type==='started'&&e.disposition==='applied').sort((a,b)=>a.seq-b.seq);
      for(const e of started){const at=String(e.received_at||e.occurred_at||'');if(!at)continue;marked.push(...markTakeover(wb,runId,{event_id:e.id,at},'reconcile'));}
    }
  });
  return marked;
}

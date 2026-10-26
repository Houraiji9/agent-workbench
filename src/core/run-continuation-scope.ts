import type {Workbench} from './workbench.ts';
import {assert} from './security.ts';

/** Resolve only durable same-conversation receipts; no task-wide or agent-wide credential grant. */
export function resolveRunnerRun(wb:Workbench,authenticatedRunId:string):string{
  const source=wb.get('runs',authenticatedRunId),task=wb.get('tasks',source.task_id);
  assert(!task.request_withdrawn&&!['cancelled','rework_linked'].includes(task.status)&&!wb.get('projects',task.project_id).archived,'原执行作用域已撤销',403);
  const current=wb.get('runs',task.current_run_id);
  assert(current.agent_id===source.agent_id&&task.agent_id===source.agent_id&&(!task.pending_arrangement||task.pending_arrangement.agent_id===source.agent_id),'执行负责人已改派，原凭据不能跟进新负责人',403);
  let run=source;const seen=new Set<string>();
  while(run.id!==current.id){
    assert(!seen.has(run.id)&&seen.size<100,'执行续接链无效或过长',403);seen.add(run.id);
    assert(!run.program_interruption&&run.status!=='cancelled','原执行已取消，不能续接',403);
    const candidates=(run.continuations||[]).filter((receipt:any)=>receipt.result?.continuation?.mode==='same_session'&&receipt.result.continuation.source_run_id===run.id&&receipt.result.continuation.agent_id===source.agent_id&&receipt.result.continuation.target_run_id===receipt.result.run_id);
    const targets=[...new Set<string>(candidates.map((receipt:any)=>receipt.result.run_id).filter((rid:string)=>rid!==run.id))];
    assert(targets.length===1,'当前执行没有唯一的同会话续接凭据，请使用新执行单连接',403);
    const next=wb.get('runs',targets[0]);
    assert(next.task_id===source.task_id&&next.agent_id===source.agent_id&&next.retry_context?.previous_run_id===run.id&&next.retry_context?.task_status==='changes_requested','禁止跨任务或非返修Run续接',403);
    run=next;
  }
  assert(run.status!=='cancelled','当前执行已取消',403);return run.id;
}

/** Preserve the request's original Run binding after validating the whole live continuation chain. */
export function resolveRunnerContinuationScope(wb:Workbench,authenticatedRunId:string,requestId:string):string{
  const currentId=resolveRunnerRun(wb,authenticatedRunId);
  let run=wb.get('runs',authenticatedRunId);
  const owners:string[]=[];
  for(let depth=0;depth<101;depth++){
    for(const receipt of run.continuations||[]){
      if(receipt.request_id!==requestId)continue;
      const c=receipt.result?.continuation;
      assert(c?.mode==='same_session'&&c.source_run_id===run.id&&c.target_run_id===receipt.result.run_id&&c.agent_id===run.agent_id,'续作请求不属于当前同会话凭据',409);
      assert(receipt.result.run_id===currentId,'此续作结果已被后续Run取代，请读取当前上下文后使用新请求编号',409);
      owners.push(run.id);
    }
    if(run.id===currentId)break;
    // resolveRunnerRun has already validated uniqueness, bounds, identity and retry bindings.
    const link=(run.continuations||[]).find((receipt:any)=>receipt.result?.continuation?.mode==='same_session'&&receipt.result.continuation.source_run_id===run.id&&receipt.result.continuation.target_run_id===receipt.result.run_id&&receipt.result.run_id!==run.id);
    assert(link,'执行续接链已变化，请刷新',409);run=wb.get('runs',link.result.run_id);
  }
  assert(new Set(owners).size<=1,'续作请求编号在多个Run重复，不能确定原始绑定',409);
  return owners[0]||currentId;
}

/** A query may inspect history only when that Run reaches this current Run by formal same-session receipts. */
export function canQueryRunnerJob(wb:Workbench,currentRunId:string,jobRunId:string):boolean{
  if(currentRunId===jobRunId)return true;
  try{const current=wb.get('runs',currentRunId),source=wb.get('runs',jobRunId);return current.task_id===source.task_id&&resolveRunnerRun(wb,jobRunId)===currentRunId;}catch{return false;}
}

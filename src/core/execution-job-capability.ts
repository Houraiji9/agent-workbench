import crypto from 'node:crypto';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash} from './security.ts';
import {resolveRunnerRun} from './run-continuation-scope.ts';

export function executionJobRun(wb:Workbench,job:Row):string{
  if(job.role!=='execution'||!job.continuation_runs?.length)return job.run_id;
  const target=resolveRunnerRun(wb,job.run_id),chain=job.continuation_runs;
  let previous=job.run_id;
  for(const link of chain){assert(link.source_run_id===previous&&link.job_id===job.id,'受管执行续接链无效',403);const source=wb.get('runs',previous);assert(source.continuations?.some((receipt:Row)=>receipt.request_id===link.request_id&&receipt.result?.continuation?.mode==='same_session'&&receipt.result.run_id===link.target_run_id&&receipt.result.continuation.source_run_id===previous),'受管执行缺少正式续接记录',403);previous=link.target_run_id;}
  assert(previous===target,'受管执行不能接替其他续接会话',403);return target;
}
/** Called only after ordinary Run authentication; plaintext capability exists only in child environment. */
export function authenticateExecutionJob(wb:Workbench,authenticatedRunId:string,jobId:unknown,token:unknown):string|undefined{
  if(jobId===undefined&&token===undefined)return undefined;
  assert(typeof jobId==='string'&&typeof token==='string'&&token.length===64,'执行进程能力凭据无效',403);
  const job=wb.maybe('agent_jobs',jobId);
  assert(job?.role==='execution'&&job.status==='running'&&job.process_may_be_running===true&&!job.cancel_requested_at&&typeof job.execution_capability_sha256==='string','执行进程能力已失效',403);
  const supplied=Buffer.from(hash(token),'hex'),expected=Buffer.from(job.execution_capability_sha256,'hex');assert(supplied.length===expected.length&&crypto.timingSafeEqual(supplied,expected),'执行进程能力凭据无效',403);
  const authenticated=wb.get('runs',authenticatedRunId),origin=wb.get('runs',job.run_id);
  assert(authenticated.task_id===origin.task_id&&authenticated.agent_id===origin.agent_id&&resolveRunnerRun(wb,authenticatedRunId)===executionJobRun(wb,job),'执行进程能力不属于当前Run',403);
  return job.id;
}

import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {assert,hash,readBounded,safePath,now} from './security.ts';
import {createAgentOutputParser,type ParsedAgentOutput} from './agent-output.ts';
import {recordUsageEvent,usageInputFromOutput} from './project-usage.ts';
import {bindReviewContextSession} from './review-context.ts';
import {nativeReviewResult} from './native-review-result.ts';
import {reviewAssignmentContext,reviewResultInput,submitReviewResult} from './review-workflow.ts';

export const nativeReviewRecoveryInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),job_id:z.string().regex(/^AJ-[a-f0-9-]{36}$/)}).strict();

/** Recover only this workbench's stored independent-client result. No caller report/path
 * is accepted. This is source provenance, not protection against a local administrator. */
export function recoverNativeReview(wb:Workbench,input:unknown){
 const v=nativeReviewRecoveryInput.parse(input),job=wb.get('agent_jobs',v.job_id),run=wb.get('runs',v.run_id),task=wb.get('tasks',run.task_id);
 assert(job.run_id===run.id&&job.task_id===task.id&&job.role==='review','调用不属于本Run的独立审查',403);
 assert(task.current_run_id===run.id&&!['accepted','cancelled'].includes(task.status),'只能补登记当前未结束的执行',409);
 assert(['failed','interrupted'].includes(job.status)&&!job.cancel_requested_at&&job.process_may_be_running===false&&job.process_end_evidence==='owned_child_exit','原调用尚未确认正常结束，不能从文件恢复',409);
 if(job.process_pid){try{process.kill(job.process_pid,0);assert(false,'原客户端进程仍存在，不能恢复',409);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
 assert(!job.session_mismatch,'原调用存在会话冲突，不能自动恢复',409);
 // In 0.4.6 a JSON.parse exception happens only inside the exitCode===0 terminal
 // branch, before exit_code is saved. Preserve null; do not invent an exit code.
 const legacyParseFailure=job.exit_code==null&&job.route?.client==='cursor'&&/Unexpected token|Unexpected non-whitespace|JSON at position|JSON\.parse/.test(job.reason||'');
 assert(job.exit_code===0||legacyParseFailure,'没有成功退出的证据，不能自动恢复',409);
 const a=reviewAssignmentContext(wb,job.review_id).assignment;
 assert(!a.session_id||a.session_id===job.session_id,'审查单与原调用会话不一致',409);
 const base=task.context_contract?.output_dir||path.join(run.cwd,'.agent-workbench-output',task.id,run.id);
 const expected=safePath(path.join(base,'calls',job.id,'stdout.jsonl'),task.allowed_paths);
 assert(job.files?.stdout&&path.resolve(job.files.stdout)===path.resolve(expected),'原生输出路径与正式调用不一致',409);
 assert(!fs.lstatSync(expected).isSymbolicLink(),'原生输出不能是链接',409);
 const bytes=readBounded(expected,16*1024*1024),parser=createAgentOutputParser(job.route.client);
 let finalText:string|undefined,terminalCount=0,sessionId:string|undefined,terminal:ParsedAgentOutput|undefined,failed=false;
 for(const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)){
  const event=parser.push(line);if(event.sessionId){assert(!sessionId||sessionId===event.sessionId,'原生输出包含多个会话',409);sessionId=event.sessionId;}
  if(event.success===false)failed=true;
  if(event.terminal){terminalCount++;finalText=event.finalText;terminal=event;}
 }
 assert(terminalCount===1&&sessionId&&(!job.session_id||sessionId===job.session_id)&&(!job.resume_session_id||sessionId===job.resume_session_id)&&(!a.session_id||a.session_id===sessionId),'没有唯一且绑定原调用的终态',409);
 const sha256=hash(bytes);if(job.native_output_recovery)assert(job.native_output_recovery.stdout_sha256===sha256,'原生输出已变化，不能重复恢复',409);
 // A cancelled turn supplies real session/usage evidence, never a review verdict.
 if(terminal?.eventType==='grok/end'&&terminal.stopReason==='cancelled'&&finalText===undefined){
  return wb.transaction(()=>{
   const current=wb.get('agent_jobs',job.id);current.session_id=sessionId;current.actual_model=terminal?.model||current.actual_model||null;current.usage=terminal?.usage||current.usage;current.native_stop_reason=terminal?.stopReason;
   if(!current.native_output_recovery){const input=usageInputFromOutput({...current,id:job.id,client_kind:job.route.client,agent_id:a.reviewer_id},terminal!,1,now());if(input)recordUsageEvent(wb,input);}
   current.native_output_recovery={stdout_sha256:sha256,at:now()};wb.put('agent_jobs',current,{run_id:run.id});
   a.session_id=sessionId;wb.put('review_assignments',a,{run_id:run.id});bindReviewContextSession(wb,a.id,job.id);
   wb.audit('native_client_output:'+job.id,'recover_native_session',job.id,{stdout_sha256:sha256,stop_reason:terminal?.stopReason});
   return {review:null,session_id:sessionId,original_job_status:job.status,can_resume:true,reason:'原生会话和用量已恢复；该段已取消，没有审查结论，继续原会话即可。'};
  });
 }
 assert(!failed&&!job.output_failed&&finalText!==undefined,'原生客户端未完成报告，不能恢复为审查结论',409);
 const payload=reviewResultInput.parse({task_id:task.id,run_id:run.id,review_id:a.id,review_digest:a.review_digest,...nativeReviewResult(finalText) as object});
 assert(payload.review_id===a.id&&payload.task_id===task.id&&payload.run_id===run.id,'原生报告属于其他任务或审查',409);
 if(job.native_result_recovery)assert(job.native_result_recovery.stdout_sha256===sha256,'原生输出已变化，不能重复恢复',409);
 return wb.transaction(()=>{
  job.session_id=sessionId;wb.put('agent_jobs',job,{run_id:run.id});
  const receipt=submitReviewResult(wb,payload,'native_client_output:'+job.id),review=wb.get('reviews',receipt.review.id),assignment=wb.get('review_assignments',a.id);
  review.source='native_client_output';review.client_job_id=job.id;review.evidence_level='stored_launched_client_final_output';review.independently_verified=false;review.session_id=job.session_id;review.actual_model=job.actual_model||null;review.native_output_sha256=sha256;wb.put('reviews',review,{run_id:run.id});
  assignment.session_id=job.session_id;assignment.actual_model=job.actual_model||null;wb.put('review_assignments',assignment,{run_id:run.id});
  const current=wb.get('agent_jobs',job.id);current.native_result_recovery=current.native_result_recovery||{at:now(),review_id:review.id,stdout_sha256:sha256,report_sha256:hash(JSON.stringify(payload)),exit_evidence:legacyParseFailure?'legacy_success_terminal_parse_failure':'recorded_zero_exit'};wb.put('agent_jobs',current,{run_id:run.id});
  wb.audit('native_client_output:'+job.id,'recover_native_review',review.id,{job_id:job.id,stdout_sha256:sha256});
  return {...receipt,review,original_job_status:job.status,stdout_sha256:sha256};
 });
}

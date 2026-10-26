import {briefContext,workflowGuidance} from './workflow-guidance.ts';
import {taskMemoryContext} from './project-memory.ts';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash,now} from './security.ts';
import {contextFileReadInput,fileContextSnapshot,readContractFile,taskFileScope} from './file-context.ts';
import {reviewScope} from './review-scope.ts';
import {runTask} from './workflow-policy.ts';
import {priorityInstructions,validatePriorityPlan,userReviewSelection} from './priority-policy.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';

const assignmentId=z.string().regex(/^RA-[a-f0-9-]{36}$/);
export const reviewContextInput=z.object({review_id:assignmentId,mode:z.enum(['brief','delta','full']).default('brief'),known_context_hash:z.string().max(64).optional(),session_id:z.string().min(1).max(300).optional()}).strict();
export const reviewContextAckInput=z.object({review_id:assignmentId,context_hash:z.string().length(64),session_id:z.string().min(1).max(300).optional()}).strict();
export const reviewContextReadInput=contextFileReadInput.extend({review_id:assignmentId}).strict();

/** Server-only: bind earlier delivery records after the scoped launcher reports the actual session.
 * This is transport provenance, never an acknowledgement or evidence of model comprehension.
 */
export function bindReviewContextSession(wb:Workbench,reviewId:string,jobId:string){
  const a=wb.get('review_assignments',reviewId),job=wb.get('agent_jobs',jobId),r=wb.get('runs',a.run_id);
  assert(job.role==='review'&&job.review_id===a.id&&job.run_id===a.run_id&&job.task_id===r.task_id,'调用记录与审查单不匹配',409);
  assert(job.session_id&&job.session_id===a.session_id&&!job.session_mismatch&&(['running','completed'].includes(job.status)||['failed','interrupted'].includes(job.status)&&job.process_may_be_running===false&&job.process_end_evidence==='owned_child_exit'),'尚无本次调用的可靠实际会话证据',409);
  let bound=0;a.context_cache=(a.context_cache||[]).map((x:Row)=>{
    if(x.session_id||x.task_id!==r.task_id||x.reviewer_id!==a.reviewer_id||x.context?.review_id!==a.id||x.dispatch_job_id&&x.dispatch_job_id!==job.id||x.expected_session_id&&x.expected_session_id!==job.session_id)return x;
    bound++;return {...x,session_id:job.session_id,session_binding:{source:'verified_client_job',job_id:job.id,at:now()}};
  });
  wb.put('review_assignments',a,{run_id:a.run_id});return {review_id:a.id,session_id:job.session_id,bound,acknowledged:false,model_reading:'unknown'};
}

/** The caller supplies the evidence-verified reviewAssignmentContext; no broad fallback reads. */
function binding(wb:Workbench,id:string,base:Row){
  const a=wb.get('review_assignments',id),r=wb.get('runs',a.run_id),t=wb.get('tasks',r.task_id);
  assert(base.review_id===id&&base.task_id===t.id&&base.run_id===r.id&&base.review_digest===a.review_digest,'审查上下文版本不匹配',409);

  const frozen=runTask(t,r);if(frozen.model_selection&&a.requested_model)frozen.model_selection=userReviewSelection(frozen.model_selection,{reviewer_id:a.reviewer_id,requested_model:a.requested_model,reason:a.reason,decided_by:a.model_decided_by||((a.created_by==='user'||a.user_instruction)?'user':'planner')});frozen.reviewer_id=a.reviewer_id;frozen.review_route=undefined;validatePriorityPlan(frozen,frozen.importance||'normal',frozen.review_policy);
  return {a,r,t:frozen};
}
function current(wb:Workbench,id:string,base:Row){
  const {a,r,t}=binding(wb,id,base),scope=reviewScope(t,r);
  const context={project_memory:taskMemoryContext(wb,t),task_id:t.id,run_id:r.id,review_id:a.id,reviewer_id:a.reviewer_id,task_version:t.version,review_digest:base.review_digest,title:t.title,goal:t.goal,scope:t.scope,review_scope:scope,acceptance:scope.acceptance,tests:scope.tests,cwd:r.cwd,
    importance:t.importance||'normal',model_selection:t.model_selection||null,requested_model:a.requested_model||null,
    delivery_profile:resolveDeliveryProfile(t),delivery_target:t.delivery_target||'source',runtime_root:t.runtime_root??null,
    artifacts:(base.artifacts||[]).map((x:Row)=>({id:x.id,label:x.label,sha256:x.sha256,archive_path:x.archive_path})),review_files:base.review_files||[],
    previous_findings:(r.retry_context?.reviews||[]).filter((x:Row)=>!x.revoked_at&&x.verdict==='changes_requested').map((x:Row)=>({id:x.id,verdict:x.verdict,findings:x.findings,limitations:x.limitations||[]})),
    delivery_warnings:base.delivery_warnings||[],file_context:fileContextSnapshot(taskFileScope(wb,t,r))};
  return {a,r,t,context,fingerprint:hash(JSON.stringify(context))};
}
function session(wanted:string|undefined,a:Row){if(wanted)assert(a.session_id===wanted,'审查会话与正式接单记录不一致，请使用当前会话',409);return a.session_id||null}
function dispatchSession(wb:Workbench,jobId:string|undefined,a:Row,t:Row,r:Row){
  if(!jobId)return null;
  const job=wb.get('agent_jobs',jobId);
  assert(job.role==='review'&&job.review_id===a.id&&job.task_id===t.id&&job.run_id===r.id,'审查上下文调用记录不匹配',409);
  if(!job.resume_session_id)return null;
  const previous=job.previous_job_id?wb.get('agent_jobs',job.previous_job_id):null;
  const prior=previous?.review_id?wb.get('review_assignments',previous.review_id):null;
  assert(previous&&(previous.status==='completed'||['failed','interrupted'].includes(previous.status)&&previous.process_may_be_running===false&&previous.process_end_evidence==='owned_child_exit')&&previous.role==='review'&&previous.task_id===t.id&&previous.session_id===job.resume_session_id&&!previous.session_mismatch&&JSON.stringify(previous.route)===JSON.stringify(job.route)&&prior?.reviewer_id===a.reviewer_id&&(!prior?.session_id||prior.session_id===previous.session_id),'续审缺少同任务、同路由和真实会话证据',409);
  return job.resume_session_id as string;
}
export function reviewContext(wb:Workbench,value:unknown,base:Row,dispatchJobId?:string){
  const v=reviewContextInput.parse(value),{a,r,t,context,fingerprint}=current(wb,v.review_id,base);
  // A wrong session must get a reset instead of accidentally inheriting another reviewer's knowledge.
  const expected=dispatchSession(wb,dispatchJobId,a,t,r),candidate=a.session_id||expected||null;
  const sid=(!v.session_id||v.session_id===candidate)?candidate:null,continuationPending=!!expected&&!a.session_id;
  const owners=[a,...wb.all('review_assignments').filter(x=>x.id!==a.id&&x.reviewer_id===a.reviewer_id&&x.session_id===sid&&wb.maybe('runs',x.run_id)?.task_id===t.id)];
  const old=sid?owners.flatMap(x=>x.context_cache||[]).find((x:Row)=>x.hash===v.known_context_hash&&x.task_id===t.id&&x.reviewer_id===a.reviewer_id&&x.session_id===sid):undefined;
  const delta=v.mode==='delta'&&!!old;
  const changes=delta?Object.fromEntries(Object.entries(context).filter(([key,val])=>JSON.stringify(old.context[key])!==JSON.stringify(val))):context;
  const response:Row={review_id:a.id,task_id:t.id,run_id:r.id,review_digest:context.review_digest,mode:v.mode==='full'?'full':delta?'delta':'brief',context_hash:fingerprint,reset_required:v.mode==='delta'&&!old,continuation_pending:continuationPending,
    assignment:{id:a.id,task_id:t.id,run_id:r.id,reviewer_id:a.reviewer_id,status:a.status,review_digest:a.review_digest,session_id:a.session_id||null,actual_model:a.actual_model||null,model_status:a.actual_model?'reported':'unknown',delivery_mode:a.delivery_mode||'manual',result_id:a.result_id||null},report_template:base.compact_report_template||base.report_template,
    context:v.mode==='full'?{...context,original_request:t.original_request,report_template:base.report_template}:briefContext(changes),
    authority:{task_id:t.id,run_id:r.id,review_id:a.id,reviewer_id:a.reviewer_id,cwd:r.cwd,read_contract:t.context_contract||null,source_write_allowed:false,output_dir:t.context_contract?.output_dir||null,forbidden_actions:t.forbidden_actions,additional_cost_limit:0},
    file_changes:context.file_context.files.filter((file:Row)=>!old?.context?.file_context?.files?.some((prior:Row)=>prior.key===file.key&&JSON.stringify(prior)===JSON.stringify(file))),
    reading:{context_delivery:'delivered',acknowledgement:!continuationPending&&a.context_ack?.hash===fingerprint&&a.context_ack?.session_id===sid?'acknowledged':'not_acknowledged',files_delivered:(a.context_reads||[]).filter((x:Row)=>x.task_id===t.id&&(x.budget_key?x.budget_key===context.file_context.budget_key&&context.file_context.files.some((file:Row)=>file.key===x.contract_entry_key&&file.file_sha256===x.file_sha256):x.scope_hash===context.file_context.scope_hash)),model_reading:'unknown'},
    references:{full:{tool:'get_review_assignment',arguments:{review_id:a.id,mode:'full'}},artifacts:'归档仍通过本次交付的具体引用读取；文件读取工具不开放账本目录'},
    instructions:'本人完成真实检查后可用 submit_review_report 提交简短报告，连接绑定审查单和交付版本；完整旧格式仍可用。当前项目管理操作使用已有管理工具并写明用户要求，无需重读规划手册。\n首次审查独立建立上下文；只在同任务、同审查者和已登记同一会话内请求增量。摘要、回执和相同模型均不证明已读源码；补读须满足合同条件。\n'+priorityInstructions(t,t.importance||'normal','review')};
  if(v.mode!=='full'){
    response.authority={cwd:r.cwd,output_dir:t.context_contract?.output_dir||null};
    delete response.file_changes;
    response.reading={context_delivery:'delivered',acknowledgement:response.reading.acknowledgement,files_delivered_count:(a.context_reads||[]).length,model_reading:'unknown'};
    response.instructions=workflowGuidance+' 同会话复审优先检查本轮变化与上次问题；已有材料不重读，缺失时按需补读。只报告本人检查结果。';
  }
  const characters=JSON.stringify(response).length;response.usage={characters,token_count:null,token_source:'未获得模型实际用量'};
  const storedSession=continuationPending?null:sid;
  a.context_cache=[...(a.context_cache||[]).filter((x:Row)=>x.hash!==fingerprint||x.session_id!==storedSession),{hash:fingerprint,task_id:t.id,reviewer_id:a.reviewer_id,session_id:storedSession,expected_session_id:continuationPending?sid:null,dispatch_job_id:dispatchJobId||null,context}].slice(-4);
  const usage=a.context_usage||{requests:0,characters:0};a.context_usage={...usage,requests:usage.requests+1,characters:usage.characters+characters,last_at:now()};wb.put('review_assignments',a,{run_id:r.id});return response;
}
export function acknowledgeReviewContext(wb:Workbench,value:unknown,base:Row){
  const v=reviewContextAckInput.parse(value),{a,r,t,fingerprint}=current(wb,v.review_id,base),sid=session(v.session_id,a);
  assert(v.context_hash===fingerprint,'审查上下文已变化，请重新读取',409);
  assert((a.context_cache||[]).some((x:Row)=>x.hash===fingerprint&&x.task_id===t.id&&x.reviewer_id===a.reviewer_id&&x.session_id===sid&&(!x.expected_session_id||x.session_binding?.source==='verified_client_job')),'请先读取当前审查上下文并等待实际会话核验',409);
  a.context_ack={hash:fingerprint,session_id:sid,at:now(),evidence:'caller_acknowledgement',model_reading:'unknown'};wb.put('review_assignments',a,{run_id:r.id});return {acknowledged:true,review_id:a.id,context_hash:fingerprint,model_reading:'unknown'};
}
export function readReviewContextFile(wb:Workbench,value:unknown,base:Row){
  const {review_id,...v}=reviewContextReadInput.parse(value),{a,r,t}=binding(wb,review_id,base),result=readContractFile(taskFileScope(wb,t,r),v,a.context_reads||[]);
  a.context_reads=[...(a.context_reads||[]),result.record];wb.put('review_assignments',a,{run_id:r.id});return {...result,review_id,task_id:t.id,run_id:r.id};
}

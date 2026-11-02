import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {eventSchema} from './schema.ts';
import type {ManagementCaller} from './session-management.ts';
import {assert,hash,now,readBounded,safePath} from './security.ts';
import {EVIDENCE_LIMITS} from './evidence-preflight.ts';
import {reviewDeliveryDigest,acceptanceReviewSnapshot,reviewProceedAuthority} from './latest-review.ts';
import {reviewSkipped} from './acceptance.ts';
import {runTask} from './workflow-policy.ts';
import {ensureCloseout,completeCloseoutRecord,completedCloseoutMatchesDelivery} from './closeout.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';
import {verifyRuntime} from './runtime-delivery.ts';

export const integratedCloseoutInput=z.object({
 task_id:z.string().min(1),run_id:z.string().min(1),expected_revision:z.number().int().positive(),
 source_run_id:z.string().min(1),source_expected_revision:z.number().int().positive(),
 result:z.string().trim().min(20).max(100000),closeout_results:eventSchema.shape.data.shape.closeout_results.unwrap(),
 coverage_note:z.string().trim().max(10000).optional(),limitations:z.array(z.string().trim().min(1).max(4000)).max(30).default([]),
}).strict();

function deliverySnapshot(wb:Workbench,t:Row,r:Row){
 const artifacts=wb.runRows('artifacts',r.id).filter(a=>a.current).sort((a,b)=>a.id.localeCompare(b.id));
 assert(artifacts.length>0,'整合收尾需要双方真实的归档交付',409);
 for(const a of artifacts)assert(hash(readBounded(safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]),EVIDENCE_LIMITS.file_bytes))===a.sha256,'归档产物已变化，不能记录整合收尾',409);
 return {task_id:t.id,run_id:r.id,revision:t.revision,agent_id:r.agent_id,delivery_digest:reviewDeliveryDigest(wb,r.id),delivery_version:r.delivery_version??null,
  artifacts:artifacts.map(a=>({id:a.id,sha256:a.sha256})),review_files:structuredClone(r.review_files||[]),
  review:acceptanceReviewSnapshot(wb,r.id,reviewSkipped(runTask(t,r))),
  deployment:structuredClone(r.deployment||null),deployment_evidence:structuredClone(r.deployment_evidence||null)};
}

function deploymentApplicability(wb:Workbench,t:Row,r:Row){
 const warnings:string[]=[];
 if(!r.deployment&&!r.deployment_evidence)return {status:'not_recorded',warnings};
 try{
  const profile=resolveDeliveryProfile(runTask(t,r),wb.get('projects',t.project_id));
  assert(profile.deployment.mode!=='none','已有部署记录不适用于本Run冻结的无需部署方案',409);
  if(r.deployment_evidence)assert(profile.deployment.verification==='executor_reported','部署回执类型与本Run冻结方案不匹配',409);
  verifyRuntime(wb,t,r);
  if(profile.deployment.verification==='portable_manifest'){
   const authority=reviewProceedAuthority(wb,r.id);
   assert(r.deployment?.review_id===(authority.decision?.binding_review_id??authority.review?.id??null)&&(r.deployment?.review_decision_id||null)===(authority.decision?.id||null),'便携部署记录的审查引用已变化',409);
   assert(wb.runRows('artifacts',r.id).some(a=>a.current&&a.sha256===r.deployment?.manifest_sha256),'便携部署清单不属于当前交付',409);
  }
 }catch(error){warnings.push('整合主单已有部署记录的当前适用性未确认：'+(error as Error).message);}
 return {status:warnings.length?'unverified':'applicable',warnings};
}

/** An explicit management receipt by the integrator, never an event impersonating the contributor. */
export function completeIntegratedCloseout(wb:Workbench,input:unknown,caller:ManagementCaller,user_instruction:string){
 const v=integratedCloseoutInput.parse(input);assert(user_instruction?.trim().length>=2,'整合收尾需要记录本次用户授权',403);
 return wb.transaction(()=>{
  const t=wb.get('tasks',v.task_id),r=wb.get('runs',v.run_id),source=wb.get('runs',v.source_run_id),st=wb.get('tasks',source.task_id);
  assert(['manager','runner','reviewer'].includes(caller.role),'当前连接不能办理整合收尾',403);
  assert(t.project_id===st.project_id,'整合双方必须属于同一项目',403);
  if(caller.role!=='manager'){
   assert((caller.project_ids||[caller.project_id]).includes(t.project_id),'整合收尾不属于当前会话项目范围',403);
   assert(caller.run_id,'当前连接缺少真实执行来源',403);
   assert(wb.get('tasks',wb.get('runs',caller.run_id).task_id).project_id===t.project_id,'当前办理者不属于整合项目',403);
  }
  assert(r.id!==source.id&&r.task_id===t.id,'请明确不同的整合主单和协作任务',409);
  assert(t.current_run_id===r.id&&st.current_run_id===source.id,'只能办理双方当前Run的整合收尾',409);
  assert(t.revision===v.expected_revision&&st.revision===v.source_expected_revision,'整合任务已变化，请读取当前版本',409);
  assert(!['accepted','cancelled','rework_linked'].includes(t.status)&&!['cancelled','rework_linked'].includes(st.status),'整合任务已结束或失效',409);
  assert(['submitted','accepted'].includes(source.status)&&r.status==='submitted','整合双方须已有正式交付',409);
  const sourceSnapshot=deliverySnapshot(wb,st,source),targetSnapshot=deliverySnapshot(wb,t,r),warnings:string[]=[];
  if(completedCloseoutMatchesDelivery(wb,t,r))return {task_id:t.id,run_id:r.id,source_run_id:source.id,status:t.status,revision:t.revision,closeout:r.closeout,recorded_by:r.closeout.recorded_by||null,already_completed:true,note:'当前交付已有完成收尾，原报告和来源保持不变；补充证据请使用append_note。'};
  if(sourceSnapshot.review.review_status!=='passed'&&sourceSnapshot.review.review_status!=='continue_recorded')warnings.push('整合主单的独立审查尚未确认；没有替协作交付登记审查通过');
  const deployment_applicability=deploymentApplicability(wb,st,source);warnings.push(...deployment_applicability.warnings);
  if(deployment_applicability.status==='not_recorded')warnings.push('整合主单没有已记录的部署核验事实');
  const coverage=(r.review_files||[]).map((f:Row)=>{
   const match=(source.review_files||[]).find((s:Row)=>path.resolve(s.path).toLowerCase()===path.resolve(f.path).toLowerCase());
   let current_sha256:string|null=null,error:string|null=null;
   try{const real=safePath(f.path,t.allowed_paths);assert(!wb.privatePath(real),'文件属于受保护范围',403);current_sha256=hash(readBounded(real,EVIDENCE_LIMITS.file_bytes));}catch(e){error=(e as Error).message;}
   const status=error?'unverified':!match?'not_in_source_review':match.sha256!==current_sha256?'source_changed':match.sha256===f.sha256?'unchanged':'integrated_change';
   if(!['unchanged','integrated_change'].includes(status))warnings.push('协作文件覆盖未核实：'+f.path+'（'+status+'）');
   return {path:f.path,target_sha256:f.sha256,source_sha256:match?.sha256||null,current_sha256,status,...(error?{error}:{})};
  });
  if(!coverage.length)warnings.push('协作交付未列出受审文件，整合覆盖范围尚未核实');
  const recorded_at=now(),actor={role:caller.role,id:caller.id,...(caller.run_id?{run_id:caller.run_id}:{}),...(caller.review_id?{review_id:caller.review_id}:{}),...(caller.role==='runner'&&caller.run_id?{agent_id:wb.get('runs',caller.run_id).agent_id}:{})};
  const integration={schema:1,source_task_id:st.id,source_run_id:source.id,target_task_id:t.id,target_run_id:r.id,source:sourceSnapshot,target:targetSnapshot,deployment_applicability,coverage,coverage_note:v.coverage_note||null,limitations:v.limitations,warnings,user_instruction,recorded_by:actor,recorded_at};
  const binding_sha256=hash(JSON.stringify(integration));
  ensureCloseout(wb,t,r);
  const created:string[]=[];
  completeCloseoutRecord(wb,t,r,{result:v.result,closeout_results:v.closeout_results,provenance:{source:'integration_owner',recorded_by:actor,integration:{...integration,binding_sha256}}},created);
  r.closeout.verification_warnings=[...new Set([...(r.closeout.verification_warnings||[]),...warnings,...v.limitations])];
  r.updated_at=recorded_at;t.revision++;t.updated_at=recorded_at;
  wb.put('runs',r,{task_id:t.id});wb.put('tasks',t,{project_id:t.project_id});
  wb.audit(caller.id,'complete_integrated_closeout',t.id,{run_id:r.id,source_run_id:source.id,closeout_id:r.closeout.id,binding_sha256,recorded_by:actor});
  return {task_id:t.id,run_id:r.id,source_run_id:source.id,status:t.status,revision:t.revision,closeout:r.closeout,recorded_by:actor};
 });
}

import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {taskSchema,type Row} from './schema.ts';
import {assert,hash,id,now,readBounded,safePath,protectedName} from './security.ts';
import {runTask,applyUserArrangement} from './workflow-policy.ts';
import {deliveryProfileSchema,validatePlannedDelivery,resolveDeliveryProfile,deliveryProfileDigest} from './delivery-profile.ts';
import {reviewProceedAuthority,reviewDeliveryDigest} from './latest-review.ts';
import {validateAgentRoutes} from './agent-orchestration.ts';
import {validatePriorityPlan} from './priority-policy.ts';
import {validateTaskContextContract} from './file-context.ts';
import {sameAgent} from './reviewer-resources.ts';

const text=z.string().trim().min(1).max(20000),identifier=z.string().trim().min(1).max(200);
export const releaseHandoffInput=z.object({
 handoff_id:z.string().uuid(),source_task_id:identifier,source_run_id:identifier,expected_revision:z.number().int().positive(),
 title:text.max(200),goal:text,scope:text,delivery_profile:deliveryProfileSchema,
 deliverables:z.array(text).min(1).max(40),acceptance:z.array(text).min(1).max(40),tests:z.array(text).min(1).max(100),
 allowed_paths:z.array(text).min(1).max(20).optional(),required_files:z.array(text).max(30).optional(),
 deployment_authorization:z.object({authorized:z.literal(true),target:text.max(4000),reason:text}).strict(),
}).strict();
export type ReleaseHandoffActor={role:string;id:string;source:string};
const actorSchema=z.object({role:identifier,id:identifier,source:identifier}).strict();
function snapshot(wb:Workbench,t:Row,r:Row){
 const authority=reviewProceedAuthority(wb,r.id),digest=reviewDeliveryDigest(wb,r.id),artifacts=wb.runRows('artifacts',r.id).filter(a=>a.current),hashes=artifacts.map(a=>a.sha256).sort();
 assert(authority.can_proceed,'源执行尚无适用的正式独立审查通过',409);
 const assignments=wb.runRows('review_assignments',r.id),author=wb.get('agents',r.agent_id);
 const reports=wb.runRows('reviews',r.id).filter(v=>!v.revoked_at&&!v.historical&&v.verdict==='passed'&&v.reviewer_id&&!sameAgent(wb.get('agents',v.reviewer_id),author)&&v.review_digest===digest&&JSON.stringify([...(v.artifact_hashes||[])].sort())===JSON.stringify(hashes)&&(!assignments.length||assignments.some(a=>a.id===v.review_id&&a.status==='completed'&&a.result_id===v.id)));
 assert(reports.length>0&&artifacts.length>0,'缺少绑定当前源交付指纹的独立通过报告',409);
 assert(Array.isArray(r.review_files)&&r.review_files.length>0,'源交付没有明确受审源码指纹，不能推定源码已受审',409);
 for(const a of artifacts)assert(hash(readBounded(safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]),20*1024*1024))===a.sha256,'源归档产物指纹已变化',409);
 const files=r.review_files.map((f:Row)=>({path:safePath(f.path,t.allowed_paths),sha256:f.sha256}));
 for(const f of files){assert(!wb.privatePath(f.path)&&!protectedName(f.path),'受审源码不能引用受保护文件',403);assert(hash(readBounded(f.path,20*1024*1024))===f.sha256,'源文件已变化，原审查引用失效：'+f.path,409);}
 return {review_ids:reports.map(v=>v.id),review_digest:digest,review_files:files,artifact_hashes:hashes,artifacts:artifacts.map(a=>({id:a.id,sha256:a.sha256}))};
}
/** Explicit planning input creates a successor Task only. No Run, process or old contract is changed. */
export function createReleaseHandoff(wb:Workbench,input:unknown,actor:ReleaseHandoffActor){
 const v=releaseHandoffInput.parse(input),identity=actorSchema.parse(actor),requestDigest=hash(JSON.stringify(v));
 return wb.transaction(()=>{
  const duplicate=wb.all('tasks').find(t=>t.source_delivery?.handoff_id===v.handoff_id);
  if(duplicate){assert(duplicate.source_delivery.request_digest===requestDigest,'同一发布衔接编号的内容不同',409);assert(duplicate.source_delivery.task_id===v.source_task_id&&duplicate.source_delivery.run_id===v.source_run_id,'发布来源冲突',409);return response(duplicate,true);}
  const source=wb.get('tasks',v.source_task_id),run=wb.get('runs',v.source_run_id),project=wb.get('projects',source.project_id);
  assert(source.current_run_id===run.id&&run.task_id===source.id,'只能基于来源任务的当前交付进入发布',409);
  assert(source.revision===v.expected_revision,'来源任务已变化，请读取当前版本',409);
  assert(!project.archived&&!source.request_withdrawn&&!['cancelled','rework_linked'].includes(source.status),'来源任务已失效',409);
  assert(['submitted','accepted'].includes(run.status),'来源执行尚未正式交付',409);
  let selected=runTask(source,run);
  assert(resolveDeliveryProfile(selected,project).deployment.mode==='none','来源已有部署安排，请使用其现有发布关系',409);
  const evidence=snapshot(wb,selected,run),profile=validatePlannedDelivery(v.delivery_profile);
  assert(profile.deployment.mode!=='none','发布衔接须明确新的部署方案',409);
  assert(v.deployment_authorization.target===profile.deployment.target,'部署授权目标与方案不同',409);
  if(profile.deployment.verification==='portable_manifest')assert(project.runtime_root&&path.resolve(profile.deployment.target)===path.resolve(project.runtime_root),'便携交付目标必须与项目登记运行目录一致',409);
  const scopeRoots=wb.roots(project);
  if(profile.deployment.mode==='local'){
   if(project.runtime_root&&path.resolve(profile.deployment.target)===path.resolve(project.runtime_root))scopeRoots.push(safePath(project.runtime_root,wb.config.authorizedRoots,true));
   const target=safePath(profile.deployment.target,scopeRoots,true);assert(!wb.privatePath(target)&&!protectedName(target),'部署目标不能位于受保护目录',403);
  }
  if(source.pending_arrangement){const pending=source.pending_arrangement;selected={...selected,...applyUserArrangement({...selected,execution_policy:pending.execution_policy},wb.get('agents',pending.agent_id),pending.requested_model)};}
  else{selected={...selected,requested_model:run.requested_model??selected.requested_model};if(selected.execution_route&&selected.requested_model)selected.execution_route={...selected.execution_route,model:selected.requested_model};}
  const clone=Object.fromEntries(Object.keys(taskSchema.shape).filter(k=>k!=='model_selection'&&selected[k]!==undefined).map(k=>[k,structuredClone(selected[k])]));
  const allowed=(v.allowed_paths||selected.allowed_paths).map((p:string)=>{const real=safePath(p,scopeRoots,true);assert(!wb.privatePath(real)&&!protectedName(real),'发布范围不能包含受保护路径',403);return real;});
  const fields=taskSchema.parse({...clone,key:'release-'+v.handoff_id,title:v.title,goal:v.goal,scope:v.scope,delivery_profile:profile,delivery_target:profile.deployment.verification==='portable_manifest'?'runtime':'source',allowed_paths:allowed,required_files:v.required_files||[],deliverables:v.deliverables,acceptance:v.acceptance,tests:v.tests,dependencies:[source.id]});
  for(const file of fields.required_files){const real=safePath(file,allowed);assert(!wb.privatePath(real)&&!protectedName(real),'发布必读资料不能引用受保护文件',403);}
  const stamp=now(),taskId=id('T'),group=source.delivery_group_id||source.id;
  const link={schema:1,handoff_id:v.handoff_id,request_digest:requestDigest,task_id:source.id,run_id:run.id,...evidence,created_at:stamp,actor:identity,
   deployment_authorization:{...v.deployment_authorization,actor:identity,at:stamp,delivery_profile_sha256:deliveryProfileDigest(profile)},target:profile.deployment.target,
   route_preference_source:{source_task_id:source.id,source_run_id:run.id,selection:source.pending_arrangement?'user_pending_arrangement':'current_source_run',execution_route:fields.execution_route||null,review_route:fields.review_route||null,requested_model:fields.requested_model||null},
   reuse_policy:'unchanged_source_reference_only',deployment_review:'new_scripts_and_changes_require_new_review'};
  const task:Row={...fields,...(selected.model_selection?{model_selection:structuredClone(selected.model_selection)}:{}),id:taskId,project_id:source.project_id,request_id:source.request_id,original_request:source.original_request,
   importance:source.importance||'normal',review_policy:{mode:'required'},runtime_root:project.runtime_root||null,policy_source:'source_delivery_inheritance',protected_paths:structuredClone(source.protected_paths||[]),
   status:'ready',version:1,revision:1,current_run_id:null,created_at:stamp,updated_at:stamp,source:'release_handoff',delivery_group_id:group,source_delivery:link};
  assert(task.reviewer_id&&task.reviewer_id!==task.agent_id,'后续部署需要独立审查安排',409);
  validateAgentRoutes(wb,task);validatePriorityPlan(task,task.importance,task.review_policy);validateTaskContextContract(wb,task);
  wb.put('tasks',task,{project_id:source.project_id});
  if(!source.delivery_group_id)wb.put('tasks',{...source,delivery_group_id:group,revision:source.revision+1,updated_at:stamp},{project_id:source.project_id});
  wb.audit(identity.role+':'+identity.id,'create_release_handoff',task.id,{source_task_id:source.id,source_run_id:run.id,delivery_group_id:group,handoff_id:v.handoff_id,actor:identity});
  return response(task,false);
 });
}
function response(task:Row,idempotent:boolean){return {task,task_id:task.id,delivery_group_id:task.delivery_group_id,source_delivery:task.source_delivery,idempotent,next:{tool:'export_execution_order',input:{task_id:task.id,expected_version:task.version}},review_status:'not_requested_yet',note:'来源报告仅作未变源码引用；新部署脚本及变化须另行受审，尚无部署执行或用户验收。'};}

/** Re-check links when shown or handed to reviewers; no stale source reference becomes a new pass. */
export function releaseSourceStatus(wb:Workbench,taskId:string){
 const task=wb.get('tasks',taskId),link=task.source_delivery;assert(link,'任务没有发布来源关联',409);
 try{const source=wb.get('tasks',link.task_id),run=wb.get('runs',link.run_id);assert(source.project_id===task.project_id&&run.task_id===source.id,'发布来源不属于本项目',409);const current=snapshot(wb,runTask(source,run),run);assert(current.review_digest===link.review_digest&&link.review_ids.every((id:string)=>current.review_ids.includes(id)),'来源审查已变化',409);return {valid:true,source_delivery:link,review_status:'source_reference_only',deployment_review:'required'};}
 catch(error){return {valid:false,source_delivery:link,review_status:'source_reference_invalid',deployment_review:'required',reason:error instanceof Error?error.message:String(error)};}
}

import {agentRouteSchema} from './agent-route-schema.ts';
import {agentClientKind} from './agent-client-kind.ts';
import {userReviewSelection} from './priority-policy.ts';
import {stageCloseout,invalidateCloseout,writeCloseoutOrder,closeoutStates} from './closeout.ts';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {ROOT} from './config.ts';
import {assert,id,now,hash,secret,safePath,atomicWrite} from './security.ts';
import {getReviewContext,reviewConclusion} from './review-evidence.ts';
import {canReview,sameAgent,reviewCandidates,assertReviewerResources,reviewerResources} from './reviewer-resources.ts';
import {assertMayArrangeReview,reviewActor,type ReviewCaller} from './review-permissions.ts';
import {assertProjectDispatch} from './project-hold.ts';
import {reviewScope} from './review-scope.ts';
import {runTask} from './workflow-policy.ts';
import {priorityInstructions,validatePriorityPlan} from './priority-policy.ts';
import {reviewDeliveryDigest,reviewProceedAuthority} from './latest-review.ts';
import {resolveDeliveryProfile} from './delivery-profile.ts';

export const reviewId=z.string().regex(/^RA-[a-f0-9-]{36}$/);
export const reviewScopeInput=z.object({review_id:reviewId}).strict();
export const reviewOrderInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),reviewer_id:z.string().min(1).max(100),expected_revision:z.number().int(),reason:z.string().trim().min(2).max(2000),delivery_mode:z.enum(['manual','agent']).optional(),new_review:z.boolean().optional(),requested_model:z.string().trim().min(1).max(100).nullable().optional()}).strict();
export const reviewStartInput=reviewScopeInput.extend({identity:z.string().min(1).max(100),session_id:z.string().max(300).optional(),actual_model:z.string().max(100).nullable().optional()}).strict();
export const reviewHandoffInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),review_id:reviewId,expected_revision:z.number().int(),reason:z.string().trim().min(5).max(2000)}).strict();
export const reviewResultInput=reviewConclusion.extend({review_id:reviewId,report_markdown:z.string().trim().min(20).max(100000),evidence:z.array(z.string().trim().min(1).max(2000)).min(1).max(100)}).strict();

function packageDir(wb:Workbench,a:Row){const r=wb.get('runs',a.run_id),root=safePath(r.directory,[...wb.config.authorizedRoots,wb.config.dataDir]);return safePath(path.join(root,'reviews',a.id),[root],true)}
export function reviewAssignmentContext(wb:Workbench,assignmentId:string){
  reviewId.parse(assignmentId);const a=wb.get('review_assignments',assignmentId),r=wb.get('runs',a.run_id),t=wb.get('tasks',r.task_id);
  assert(t.current_run_id===r.id&&!['superseded','revoked','cancelled'].includes(a.status),'审查单已失效，请使用最新审查单',409);
  const frozen=runTask(t,r);if(frozen.model_selection&&a.requested_model)frozen.model_selection=userReviewSelection(frozen.model_selection,{reviewer_id:a.reviewer_id,requested_model:a.requested_model,reason:a.reason,decided_by:a.model_decided_by||((a.created_by==='user'||a.user_instruction)?'user':'planner')});frozen.reviewer_id=a.reviewer_id;frozen.review_route=undefined;validatePriorityPlan(frozen,frozen.importance||'normal',frozen.review_policy);
  const selectedModel=a.requested_model||frozen.model_selection?.review?.model;

  const context=getReviewContext(wb,r.id);if(context.review_digest!==a.review_digest&&!r.scope_revision){const legacy={task_id:t.id,run_id:r.id,task_version:t.version,reviewer_id:a.reviewer_id,review_assignment_id:a.id,artifacts:context.artifacts.map(x=>({id:x.id,sha256:x.sha256})),review_files:r.review_files||[]};if(hash(JSON.stringify(legacy))===a.review_digest)context.review_digest=a.review_digest;}assert(context.review_digest===a.review_digest,'交付已变化，请重新生成审查单',409);
  return {...context,importance:frozen.importance||'normal',model_selection:frozen.model_selection||null,delivery_profile:resolveDeliveryProfile(frozen),
    delivery_target:frozen.delivery_target||'source',runtime_root:frozen.runtime_root??null,requested_model:a.requested_model||null,
    model_status:a.actual_model?'reported':'unknown',instructions:context.instructions+'\n'+priorityInstructions(frozen,frozen.importance||'normal','review'),
    review_id:a.id,assignment:a,compact_report_template:{verdict:'passed 或 changes_requested',findings:[],limitations:[],evidence:['实际查看的文件或执行的检查'],report_markdown:'完整 Markdown 审查报告，包含检查范围、实际验证、问题和结论'},report_template:{...context.final_response,review_id:a.id,report_markdown:'完整 Markdown 审查报告，包含检查范围、实际验证、问题和结论',evidence:['实际查看的文件或执行的检查']}};
}
function orderReply(wb:Workbench,a:Row){
  const c=reviewAssignmentContext(wb,a.id),file=path.join(packageDir(wb,a),'REVIEW.md');
  return {review_id:a.id,run_id:a.run_id,reviewer_id:a.reviewer_id,status:a.status,resource_snapshot:a.resource_snapshot||null,resource_warnings:a.resource_warnings||[],delivery_mode:a.delivery_mode||'manual',order_path:file,entry:`请完整读取并执行：${file}\n独立审查单 ${a.id} / Task ${c.task_id} / Run ${a.run_id}。审查者：${wb.get('agents',a.reviewer_id).name}。先按审查单报告 started 接单，完成后提交报告并回传工作台。`,context:c};
}
function writeOrder(wb:Workbench,a:Row){
  const c=reviewAssignmentContext(wb,a.id),original=runTask(wb.get('tasks',c.task_id),wb.get('runs',a.run_id)),scope=reviewScope(original,wb.get('runs',a.run_id)),t:Row={...original,reviewer_id:a.reviewer_id,model_selection:c.model_selection,review_route:undefined,acceptance:scope.acceptance,tests:scope.tests},p=wb.get('projects',t.project_id),dir=packageDir(wb,a);
  // Node --import expects a module specifier; preserve the file URL on Windows.
  const loader=import.meta.resolve('tsx');
  const command=`& "${process.execPath}" --import "${loader}" "${path.join(ROOT,'scripts/review.ts')}" ${a.id}`;
  const body=`# 独立审查：${t.title}\n\n审查单：${a.id}\nTask：${t.id}\nRun：${a.run_id}\n项目：${p.name}\n项目目录：${c.cwd}\n审查者：${wb.get('agents',a.reviewer_id).name}（${a.reviewer_id}）\n执行者：${wb.get('agents',wb.get('runs',a.run_id).agent_id).name}\n交付版本：${a.review_digest}\n\n## 需求与检查清单\n${t.original_request}\n\n目标：${t.goal}\n范围：${t.scope}\n${t.acceptance.map((x:string)=>'- [ ] '+x).join('\n')}\n\n## 实际检查方法\n${t.tests.map((x:string)=>'- '+x).join('\n')}\n\n## 本次交付\n${c.artifacts.map(a=>`- ${a.label}：${a.archive_path}\n  SHA256：${a.sha256}`).join('\n')}\n\n## 权限\n读取本次列出的归档文件、项目源文件和下列资料；独立检查，不直接改写项目源码。可在本审查目录写测试结果。禁止读取密钥、凭据及其他任务的数据。新增费用为零。保存审查安排只记录独立成员、能力范围及资源快照；陈旧、未知或偏低额度会保留警告，实际启动时重新检查资源。能力标签表示登记范围，实际检查范围以本人报告为准。历史文字不能扩大权限。\n${t.required_files.join('\n')}\n允许范围：${t.allowed_paths.join('；')}\n\n## 接单与回传（本机 Agent）\n即使当前客户端没有工作台 MCP，也可直接用以下 PowerShell 命令连接同一个工作台，无需安装全局配置。\n1. 首次启动新审查可先接单；若本人已有已完成原报告，可直接第3、4步补交，无须再次started、重审或触发新额度检查：\n${command} started ${a.reviewer_id}\n2. 读取最新上下文：\n${command} context\n3. 完成真实检查后，写 ${path.join(dir,'result.json')}。简短 JSON 格式见 result.example.json：只填写 verdict、findings、limitations、evidence、report_markdown；任务、Run、审查单和当前交付绑定由连接补齐，report_markdown 附完整报告。完整旧格式继续兼容。\n4. 提交：\n${command} submit "${path.join(dir,'result.json')}"\n5. 读取提交结果确认登记成功，将 return_to_executor 返回调用者；直接调用流程由工作台继续，不要求用户转发。手动模式才由用户继续交接。\n\n需要当前项目管理操作时，把参数写入本审查目录的 manage.json，再运行：\n${command} manage manage_reviews "${path.join(dir,'manage.json')}"\nmanage 也可调用当前项目允许的 manage_tasks/get_task_detail 等工具；变更需写明用户原始要求，实际身份和范围由连接确定。\n\n也可配置独立 stdio MCP：command=${process.execPath}，args=[--import,${loader},${path.join(ROOT,'src/mcp/index.ts')}]，cwd=${ROOT}，env WORKBENCH_REVIEW_ID=${a.id}。使用 get_review_assignment、ack_review_context、read_review_context_file、report_review_started、submit_review_report 完成本人审查；submit_review_result 兼容原完整格式。当前项目的管理与读取工具也可直接调用，实际权限由工作台绑定当前项目、Task、Run 和审查身份；不能代写其他成员报告。无需重读规划者手册。\n\n## 远程 Agent\n若无法访问这台电脑，请让用户提供上述交付文件。完成后返回 result.example.json 格式的完整 JSON，用户在任务中“导入审查回执”粘贴一次即可附报告并更新状态。无法读取材料时先说明缺少哪些文件，保持待审。\n\n## 交接方式\n${a.delivery_mode==='agent'?'本单由执行者直接调用本机审查 CLI / 接口。由审查者本人先报告 started，完成后提交并将 return_to_executor 返回调用者。调用者继续收尾；调用失败如实记录具体原因；核对原进程与会话后再按计划重试，模型由Agent自主选择，不要求用户搬运整套上下文。':'本单由用户手动转发；审查者本人报告 started 后才进入正在审查。'}\n\n## 结论规则\npassed 表示本审查者报告通过；多人审查由负责人结合全部报告明确决定继续、返工或补审并填写原因，报告结论保持原样。获准继续后由原执行者收尾，再交用户试用确认；changes_requested 必须列明可执行的修改项。写明实际检查范围、证据和未验证项。独立审查只更新审查状态，最终验收由用户完成。\n${a.reviewer_id==='grok-build'?'Grok 也可通过 get_review_context + submit_grok_review 回传真实会话，保留官方会话核验方式。':''}\n`;
  const contract=`## 本轮模型建议与交付档案\n${priorityInstructions(t,t.importance||'normal','review')}\n审查建议模型：${c.requested_model||'未指定'}；实际模型状态：${c.model_status}（可不披露）。\n模型选择：${JSON.stringify(c.model_selection)}\n成果与部署档案：${JSON.stringify(c.delivery_profile)}\n审查范围：${JSON.stringify(scope)}\n\n`;
  atomicWrite(path.join(dir,'REVIEW.md'),`> ${scope.label}${scope.limitation?'：'+scope.limitation:''}\n\n`+contract+body);atomicWrite(path.join(dir,'result.example.json'),JSON.stringify(c.compact_report_template,null,2));
}
export function exportReviewOrder(wb:Workbench,input:unknown,caller:ReviewCaller){
  const v=reviewOrderInput.parse(input),run=wb.get('runs',v.run_id),task=wb.get('tasks',run.task_id);
  assertProjectDispatch(wb,task.project_id);
  assertMayArrangeReview(wb,run.id,caller);const actor=reviewActor(caller);
  assert(task.revision===v.expected_revision,'任务已变化，请刷新后重新生成审查单',409);
  const frozen=runTask(task,run);validatePriorityPlan(frozen,frozen.importance||'normal',frozen.review_policy);
  getReviewContext(wb,run.id);const candidate=wb.get('agents',v.reviewer_id),author=wb.get('agents',run.agent_id);
  assert(!candidate.archived&&!sameAgent(candidate,author)&&canReview(candidate,task.work_kind),'请选择未归档且具备相关能力的独立审查者',403);const resource=reviewerResources(wb,candidate.id),resourceWarnings:string[]=[];if(resource.status!=='available')resourceWarnings.push(resource.reason);try{wb.eligible(candidate.id)}catch(error){resourceWarnings.push((error as Error).message)}
  const old=wb.all('review_assignments').find(a=>a.run_id===run.id&&a.reviewer_id===v.reviewer_id&&['awaiting_dispatch','running'].includes(a.status)&&(!v.requested_model||v.requested_model===a.requested_model));
  if(old&&old.reviewer_id===v.reviewer_id&&!v.new_review&&['awaiting_dispatch','running'].includes(old.status)){
    if(v.delivery_mode&&v.delivery_mode!==(old.delivery_mode||'manual')){assert(old.status==='awaiting_dispatch','审查者已接单，换交接方式需重新安排',409);wb.transaction(()=>{old.delivery_mode=v.delivery_mode;old.delivery_reason=v.reason;task.review_delivery=v.delivery_mode;task.revision++;task.updated_at=now();wb.put('review_assignments',old,{run_id:run.id});wb.put('tasks',task,{project_id:task.project_id});wb.audit(actor,'change_review_delivery',old.id,{delivery_mode:v.delivery_mode,reason:v.reason})})}
    old.resource_snapshot={...resource,observed_at:now()};old.resource_warnings=resourceWarnings;wb.put('review_assignments',old,{run_id:run.id});syncReviewCollaborationState(wb,task,run);wb.put('tasks',task,{project_id:task.project_id});writeOrder(wb,old);return orderReply(wb,old)
  }
  assert(!old||old.status!=='completed'||v.new_review||old.reviewer_id!==v.reviewer_id,'这次审查已完成，需要补审时请重新安排',409);
  const a:Row={id:id('RA'),run_id:run.id,task_id:task.id,reviewer_id:candidate.id,requested_model:v.requested_model||(run.review_arrangement?.reviewer_id===candidate.id?run.review_arrangement.requested_model:null)||(frozen.model_selection?.review?.agent_id===candidate.id?frozen.model_selection.review.model:null)||null,
    importance:frozen.importance||'normal',model_selection:frozen.model_selection||null,delivery_profile:resolveDeliveryProfile(frozen),resource_snapshot:{...resource,observed_at:now()},resource_warnings:resourceWarnings,
    model_decided_by:caller.recovery_review_id?(wb.get('review_assignments',caller.recovery_review_id).model_decided_by||'planner'):caller.role==='user'||caller.user_instruction?'user':'planner',user_instruction:caller.user_instruction||null,source:caller.source||null,status:'awaiting_dispatch',delivery_mode:v.delivery_mode||task.review_delivery||'manual',reason:v.reason,created_at:now(),created_by:actor};
  wb.transaction(()=>{
    if(run.review_decision){run.review_decision=null;wb.put('runs',run,{task_id:task.id});}invalidateCloseout(wb,run,'重新安排独立审查');task.review_handoff_issue=null;task.reviewer_id ||= candidate.id;task.current_review_assignment_id=a.id;task.review_stage='awaiting_dispatch';task.review_delivery=a.delivery_mode;task.status='submitted';task.revision++;task.updated_at=now();wb.put('tasks',task,{project_id:task.project_id});
    a.review_digest=getReviewContext(wb,run.id).review_digest;wb.put('review_assignments',a,{run_id:run.id});syncReviewCollaborationState(wb,task,run);wb.put('tasks',task,{project_id:task.project_id});
    const key=safePath(path.join(wb.config.dataDir,'review-keys',a.id+'.json'),[wb.config.dataDir],true);atomicWrite(key,JSON.stringify({review_id:a.id,token:secret()}));writeOrder(wb,a);
    wb.audit(actor,'export_review_order',a.id,{run_id:run.id,previous_reviewer_id:old?.reviewer_id||null,reason:v.reason});
  });return orderReply(wb,a);
}
export function startReview(wb:Workbench,input:unknown){
  const v=reviewStartInput.parse(input);return wb.transaction(()=>{
    const c=reviewAssignmentContext(wb,v.review_id),a=c.assignment;assert(v.identity===a.reviewer_id,'接单身份与指定审查者不一致',403);
    assert(['awaiting_dispatch','running'].includes(a.status),'审查已结束',409);if(a.status==='running'){const t=wb.get('tasks',c.task_id),before=JSON.stringify(t);syncReviewCollaborationState(wb,t,wb.get('runs',a.run_id));if(JSON.stringify(t)!==before){t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});}return a;}wb.eligible(a.reviewer_id);assertReviewerResources(wb,a.reviewer_id);
    a.status='running';a.started_at=now();a.session_id=v.session_id||null;a.actual_model=v.actual_model||null;wb.put('review_assignments',a,{run_id:a.run_id});
    const t=wb.get('tasks',c.task_id);syncReviewCollaborationState(wb,t,wb.get('runs',a.run_id));t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit('reviewer:'+a.id,'review_started',a.id);return a;
  });
}
/** The executor can report a failed direct invocation, but cannot write a review verdict. */
export function reportReviewHandoff(wb:Workbench,input:unknown){const v=reviewHandoffInput.parse(input);return wb.transaction(()=>{
  const r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id),a=wb.get('review_assignments',v.review_id);
  assert(t.revision===v.expected_revision&&t.current_run_id===r.id&&a.run_id===r.id,'审查交接已更新，请读取当前状态',409);
  assert(['submitted','in_review','changes_requested',...closeoutStates,'awaiting_confirmation'].includes(t.status)&&a.delivery_mode==='agent'&&['awaiting_dispatch','running'].includes(a.status),'本单当前没有等待处理的直接调用',409);
  a.status='superseded';a.handoff_failure=v.reason;a.ended_at=now();wb.put('review_assignments',a,{run_id:r.id});
  if(t.current_review_assignment_id===a.id)t.current_review_assignment_id=wb.all('review_assignments').find(x=>x.run_id===r.id&&x.id!==a.id&&['awaiting_dispatch','running'].includes(x.status))?.id||null;t.review_handoff_issue=v.reason;syncReviewCollaborationState(wb,t,r);t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});
  wb.audit('run:'+r.id,'review_handoff_failed',a.id,{reason:v.reason});return {task:t,next_action:'请执行者或规划者核对调用失败原因与资源后重新安排；只有需要账号、安装或权限处理时才交用户。'};
})}
export function reviewFeedbackText(wb:Workbench,review:Row){const run=wb.get('runs',review.run_id),task=wb.get('tasks',run.task_id);return `独立审查已完成：${task.title}\nTask ${task.id} / Run ${run.id}\n审查者：${wb.get('agents',review.reviewer_id).name}\n结论：${review.verdict==='passed'?'本审查者报告通过':'本审查者要求修改'}\n${review.findings||'未发现需修改项'}\n${review.limitations?.length?'未验证项：'+review.limitations.join('；'):''}\n完整报告已附在工作台任务的审查记录。执行者可调用 get_run_feedback(run_id="${run.id}") 读取报告。${closeoutStates.includes(task.status)?'\n\n'+writeCloseoutOrder(wb,run.id).entry:task.status==='accepted'?'用户已验收。':task.status==='awaiting_confirmation'?'执行者已回报收尾，等待用户验收。':'请核对全部独立报告；负责人可明确决定继续、返工或补审，并填写原因。'}`}
export function submitReviewResult(wb:Workbench,input:unknown,actor:string){
  const v=reviewResultInput.parse(input),payloadHash=hash(JSON.stringify(v));return wb.transaction(()=>{
    const c=reviewAssignmentContext(wb,v.review_id),a=c.assignment;assert(!/^(?:runner|planner|manager)(?::|$)/.test(actor),'执行者和管理者不能代填独立审查报告',403);if(actor.startsWith('reviewer:'))assert(actor==='reviewer:'+a.id,'审查报告身份与审查单不匹配',403);
    assert(v.task_id===c.task_id&&v.run_id===c.run_id&&v.review_digest===c.review_digest,'报告与本次任务或交付版本不符',409);
    if(a.status==='completed'){
      const old=wb.get('reviews',a.result_id);assert(a.result_hash===payloadHash&&!old.revoked_at,'这次审查已提交不同结果或已撤回，请重新安排',409);
      recoverReviewJobs(wb,a,old,actor);return {review:old,return_to_executor:reviewFeedbackText(wb,old)};
    }
    const nativeJob=actor.startsWith('native_client_output:')?wb.maybe('agent_jobs',actor.slice('native_client_output:'.length)):null;const authenticated=actor==='reviewer:'+a.id,nativeOwn=nativeJob?.role==='review'&&nativeJob.review_id===a.id&&nativeJob.run_id===a.run_id&&nativeJob.task_id===a.task_id&&!nativeJob.session_mismatch&&(!nativeJob.session_id||!a.session_id||nativeJob.session_id===a.session_id);if(actor.startsWith('native_client_output:'))assert(nativeOwn,'原生提交会话与审查单不匹配',403);assert(a.status==='running'||actor==='user_import'||a.status==='awaiting_dispatch'&&(authenticated||nativeOwn),'请由本审查者凭据直接提交已完成报告，或先报告 started 接单',409);
    assert(v.verdict!=='changes_requested'||v.findings.some(x=>x.trim()),'请写出需要修改的问题');
    const review:Row={id:id('V'),task_id:c.task_id,run_id:c.run_id,review_id:a.id,reviewer_id:a.reviewer_id,verdict:v.verdict,findings:v.findings.join('\n'),limitations:v.limitations,evidence:v.evidence.join('\n'),report_markdown:v.report_markdown,report_sha256:hash(v.report_markdown),artifact_hashes:c.artifacts.map(a=>a.sha256).sort(),review_digest:c.review_digest,created_at:now(),session_id:a.session_id,actual_model:a.actual_model,source:actor==='user_import'?'user_imported_review':'reviewer_submission',evidence_level:actor==='user_import'?'user_attested':'scoped_reviewer_report',independently_verified:false,recorded_by:actor};
    const scope=reviewScope(wb.get('tasks',c.task_id),wb.get('runs',c.run_id));review.review_scope=scope;if(scope.limitation)review.limitations=[...new Set([...review.limitations,scope.limitation])];
    atomicWrite(path.join(packageDir(wb,a),'REPORT.md'),v.report_markdown);wb.put('reviews',review,{run_id:a.run_id});
    a.status='completed';a.completed_at=now();a.result_id=review.id;a.result_hash=payloadHash;a.report_submission={actor,at:now(),started_reported:!!a.started_at};wb.put('review_assignments',a,{run_id:a.run_id});recoverReviewJobs(wb,a,review,actor);
    const t=wb.get('tasks',c.task_id);syncReviewCollaborationState(wb,t,wb.get('runs',c.run_id),{allowLegacyResult:true});t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit(actor,'submit_review_result',review.id,{review_id:a.id});return {review,return_to_executor:reviewFeedbackText(wb,review)};
  });
}
export function reviewFeedbackOrder(wb:Workbench,runId:string,revision:number){
  const run=wb.get('runs',runId),task=wb.get('tasks',run.task_id);
  if(task.current_run_id!==run.id){
    const current=wb.get('runs',task.current_run_id);
    assert(current.retry_context?.previous_run_id===run.id&&current.retry_context?.task_status==='changes_requested'&&['awaiting_dispatch','dispatched','running','waiting_input','blocked'].includes(current.status)&&!['cancelled','accepted'].includes(task.status),'任务已变化，请使用当前执行',409);
    const order=wb.exportOrder(task.id,task.version);return {...order,text:order.entry};
  }
  assert(task.revision===revision,'任务已变化，请刷新后重试',409);
  const latest=wb.db.prepare("SELECT data FROM reviews WHERE run_id=? AND json_extract(data,'$.revoked_at') IS NULL ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(run.id) as any;const decision=reviewProceedAuthority(wb,run.id).decision;const amendment=run.amendments?.at(-1);assert(latest||decision||amendment,'还没有审查结果、负责人决定或需求变更');const text=latest?reviewFeedbackText(wb,JSON.parse(latest.data)):decision?'审查负责人决定：'+decision.decision+'；'+decision.reason:'用户调整本任务需求：'+amendment.reason;
  if(task.status==='changes_requested'){const order=wb.exportOrder(task.id,task.version,true,run.agent_id,task.revision,run.requested_model);return {...order,text:text+'\n\n'+order.entry}}
  if(closeoutStates.includes(task.status)){const order=writeCloseoutOrder(wb,run.id);return {...order,text}}
  return {text};
}
export {reviewCandidates};

export const reviewDecisionInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),expected_revision:z.number().int(),decision:z.enum(['continue','rework','add_review']),reason:z.string().trim().min(5).max(4000)}).strict();
export const reviewMemberInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),review_id:reviewId,expected_revision:z.number().int(),action:z.enum(['remove','replace']),reason:z.string().trim().min(5).max(4000),reviewer_id:z.string().min(1).max(100).optional(),requested_model:z.string().trim().min(1).max(100).nullable().optional(),delivery_mode:z.enum(['manual','agent']).optional()}).strict();
export function reviewCollaboration(wb:Workbench,runId:string){
 const authority=reviewProceedAuthority(wb,runId),reports=wb.all('reviews').filter(v=>v.run_id===runId);
 const members:Row[]=wb.all('review_assignments').filter(a=>a.run_id===runId).map(a=>({...a,report:reports.find(v=>v.id===a.result_id)||null}));
 const active=members.filter(a=>!['cancelled','superseded','revoked'].includes(a.status));
 const valid=reports.filter(v=>!v.revoked_at&&(v.review_id?active.some(a=>a.id===v.review_id):members.length===0||active.some(a=>a.status==='completed'&&a.result_id===v.id)));
 const counts={total:members.length,active:active.length,pending:active.filter(a=>a.status==='awaiting_dispatch').length,running:active.filter(a=>a.status==='running').length,completed:active.filter(a=>a.status==='completed').length,cancelled:members.length-active.length,passed:valid.filter(v=>v.verdict==='passed').length,changes_requested:valid.filter(v=>v.verdict==='changes_requested').length};
 return {members,counts,decision:authority.decision,can_proceed:authority.can_proceed,disagreement:counts.passed>0&&counts.changes_requested>0};
}
export function decideReviewCollaboration(wb:Workbench,input:unknown,caller:ReviewCaller){
 const v=reviewDecisionInput.parse(input);assertMayArrangeReview(wb,v.run_id,caller);
 assert(!['runner','reviewer'].includes(caller.role)||!!caller.user_instruction,'执行者记录审查决定需要用户明确授权',403);
 return wb.transaction(()=>{const r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(t.current_run_id===r.id&&t.revision===v.expected_revision,'任务已变化，请刷新',409);getReviewContext(wb,r.id);
 const decision={id:id('RD'),binding_review_id:reviewProceedAuthority(wb,r.id).review?.id||null,decision:v.decision,reason:v.reason,considered_review_ids:wb.all('reviews').filter(x=>x.run_id===r.id&&!x.revoked_at).map(x=>x.id),pending_review_ids:wb.all('review_assignments').filter(x=>x.run_id===r.id&&['awaiting_dispatch','running'].includes(x.status)).map(x=>x.id),review_digest:reviewDeliveryDigest(wb,r.id),artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===r.id&&a.current).map(a=>a.sha256).sort(),created_at:now(),recorded_by:reviewActor(caller),user_instruction:caller.user_instruction||null,source:caller.source||null};
 r.review_decision_history=[...(r.review_decision_history||[]),decision];r.review_decision=decision;wb.put('runs',r,{task_id:t.id});
 if(v.decision==='continue')stageCloseout(wb,t,r);else{invalidateCloseout(wb,r,'审查负责人决定：'+v.reason);t.status=v.decision==='rework'?'changes_requested':'submitted';}
 t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit(reviewActor(caller),'decide_review_collaboration',r.id,decision);return reviewCollaboration(wb,r.id);});
}
export function updateReviewMember(wb:Workbench,input:unknown,caller:ReviewCaller){
 const v=reviewMemberInput.parse(input);assertMayArrangeReview(wb,v.run_id,caller);
 return wb.transaction(()=>{const r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id),a=wb.get('review_assignments',v.review_id);assert(t.current_run_id===r.id&&a.run_id===r.id&&t.revision===v.expected_revision,'任务或审查成员已变化，请刷新',409);assert(!['cancelled','superseded','revoked'].includes(a.status),'审查成员已取消',409);
 if(v.action==='replace')assert(v.reviewer_id,'更换审查成员需要指定审查者');
 a.status='cancelled';a.ended_at=now();a.cancelled_by=reviewActor(caller);a.cancellation_reason=v.reason;wb.put('review_assignments',a,{run_id:r.id});
 invalidateCloseout(wb,r,'审查成员调整');if(r.review_decision){r.review_decision=null;wb.put('runs',r,{task_id:t.id});}t.status='submitted';if(t.current_review_assignment_id===a.id)t.current_review_assignment_id=null;syncReviewCollaborationState(wb,t,r);t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit(reviewActor(caller),'cancel_review_member',a.id,{reason:v.reason,user_instruction:caller.user_instruction||null});
 if(v.action==='replace')return exportReviewOrder(wb,{run_id:r.id,expected_revision:t.revision,reviewer_id:v.reviewer_id,requested_model:v.requested_model,delivery_mode:v.delivery_mode,reason:v.reason,new_review:true},caller);
 return reviewCollaboration(wb,r.id);});
}

export const reviewArrangementInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),expected_revision:z.number().int(),reviewer_id:z.string().min(1).max(100),requested_model:z.string().trim().min(1).max(100).nullable().optional(),reason:z.string().trim().min(5).max(4000),route:agentRouteSchema.optional()}).strict();
export function setReviewArrangement(wb:Workbench,input:unknown,caller:ReviewCaller){
 const v=reviewArrangementInput.parse(input),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(caller.role==='user'||!!caller.user_instruction,'调整本轮审查安排需要用户授权',403);if(caller.role==='user')assertMayArrangeReview(wb,r.id,caller);
 assert(t.current_run_id===r.id&&t.revision===v.expected_revision&&!['accepted','cancelled'].includes(t.status),'任务已变化或已结束',409);
 const reviewer=wb.get('agents',v.reviewer_id);if(v.route){assert(agentClientKind(reviewer)===v.route.client,'审查路线客户端与所选审查者不一致',409);}const requested=v.requested_model||v.route?.model||null;const route=v.route||(agentClientKind(reviewer)?{client:agentClientKind(reviewer),model:requested}:null);assert(!sameAgent(reviewer,wb.get('agents',r.agent_id))&&canReview(reviewer,t.work_kind),'请选择具备相关能力的独立审查者',403);
 return wb.transaction(()=>{const previous=runTask(t,r),previousModel=r.review_arrangement?.requested_model||previous.model_selection?.review?.model||previous.review_route?.model||null;const changed=previous.reviewer_id!==v.reviewer_id||previousModel!==requested;const delivered=wb.all('artifacts').some(a=>a.run_id===r.id&&a.current);const arrangement={reviewer_id:v.reviewer_id,requested_model:requested,route,reason:v.reason,source:caller.source||reviewActor(caller),user_instruction:caller.user_instruction||null,created_at:now()};r.review_arrangement_history=[...(r.review_arrangement_history||[]),arrangement];r.review_arrangement=arrangement;if(changed&&delivered){for(const member of wb.all('review_assignments').filter(a=>a.run_id===r.id&&a.reviewer_id===previous.reviewer_id&&(!previousModel||a.requested_model===previousModel)&&!['cancelled','revoked','superseded'].includes(a.status))){member.status='cancelled';member.ended_at=now();member.cancelled_by=reviewActor(caller);member.cancellation_reason=v.reason;wb.put('review_assignments',member,{run_id:r.id});}r.review_decision=null;invalidateCloseout(wb,r,'用户调整本轮审查安排');t.status='submitted';}wb.put('runs',r,{task_id:t.id});t.reviewer_id=v.reviewer_id;t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit(reviewActor(caller),'set_review_arrangement',r.id,arrangement);if(changed&&delivered){const review=exportReviewOrder(wb,{run_id:r.id,reviewer_id:v.reviewer_id,requested_model:requested||undefined,expected_revision:t.revision,reason:v.reason,new_review:true},caller);return {...arrangement,review};}return arrangement;});
}
/** Aggregate member state without changing peer assignments or an explicit proceed decision. */
export function syncReviewCollaborationState(wb:Workbench,t:Row,r:Row,options:{allowLegacyResult?:boolean}={}){
 const all=wb.all('review_assignments').filter(a=>a.run_id===r.id),members=all.filter(a=>!['cancelled','revoked','superseded'].includes(a.status));
 if(members.length>1&&!r.review_collaboration_multi){r.review_collaboration_multi=true;wb.put('runs',r,{task_id:t.id});}
 const running=members.filter(a=>a.status==='running'),pending=members.filter(a=>a.status==='awaiting_dispatch'),focus=running[0]||pending[0]||members.find(a=>a.status==='completed');
 t.active_reviewers=[...running,...pending].map(a=>({review_id:a.id,reviewer_id:a.reviewer_id,status:a.status,delivery_mode:a.delivery_mode||'manual'}));t.current_review_assignment_id=focus?.id||null;
 t.review_delivery_modes=[...new Set([...running,...pending].map(a=>a.delivery_mode||'manual'))];if(t.review_delivery_modes.length===1)t.review_delivery=t.review_delivery_modes[0];if(running.length||pending.length)t.review_handoff_issue=null;
 const authority=reviewProceedAuthority(wb,r.id);
 if(authority.decision?.decision==='continue'){if(!r.closeout)stageCloseout(wb,t,r);t.review_stage=running.length?'running':pending.length?'awaiting_dispatch':'completed';return;}
 if(authority.decision?.decision==='rework'){t.status='changes_requested';t.review_stage='awaiting_decision';return;}
 if(running.length){t.status='in_review';t.review_stage='running';return;}
 if(pending.length){t.status='submitted';t.review_stage='awaiting_dispatch';return;}
 const reports=wb.all('reviews').filter(v=>v.run_id===r.id&&!v.revoked_at&&(v.review_id?members.some(a=>a.id===v.review_id):!all.length||members.some(a=>a.result_id===v.id)));
 const legacy=!r.review_collaboration_multi&&(!all.length||members.length<=1&&reports.length<=1);
 if(options.allowLegacyResult&&legacy&&authority.review){if(authority.can_proceed){if(!r.closeout)stageCloseout(wb,t,r);}else{t.status=authority.review.verdict==='changes_requested'?'changes_requested':'submitted';invalidateCloseout(wb,r,'审查结果尚未获准继续');}t.review_stage='completed';return;}
 t.status='submitted';t.review_stage=members.some(a=>a.status==='completed')||reports.length?'awaiting_decision':'awaiting_dispatch';
}

function terminatedReviewProcess(job:Row){
 const pid=Number(job.process_pid);let dead=false;
 if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;dead=true;}}
 const finished=Number.isFinite(Date.parse(job.finished_at||job.ended_at||''));
 if(job.process_may_be_running===true)return dead&&finished;
 return job.process_may_be_running===false&&(['owned_child_exit','user_attested'].includes(job.process_end_evidence)||finished)||dead&&finished;
}
function matchingReviewRecovery(job:Row,a:Row,review:Row){return job.role==='review'&&job.review_id===a.id&&job.run_id===a.run_id&&job.task_id===a.task_id&&['failed','interrupted'].includes(job.status)&&!job.session_mismatch&&(!job.session_id||!a.session_id||job.session_id===a.session_id)&&(!review.session_id||!job.session_id||review.session_id===job.session_id)&&terminatedReviewProcess(job);}
/** Validate an appended recovery reference without rewriting the original invocation outcome. */
export function isRecoveredReviewJob(wb:Workbench,job:Row):boolean{
 try{const recovery=job.recovery;if(recovery?.kind!=='review_report_submission'||recovery.original_status!==job.status)return false;
 const a=wb.get('review_assignments',recovery.review_assignment_id),review=wb.get('reviews',recovery.review_id),run=wb.get('runs',a.run_id),task=wb.get('tasks',run.task_id);
 const native=recovery.recorded_by?.startsWith('native_client_output:')?wb.maybe('agent_jobs',recovery.recorded_by.slice('native_client_output:'.length)):null;const own=recovery.recorded_by==='reviewer:'+a.id||native?.role==='review'&&native.review_id===a.id&&native.run_id===a.run_id&&native.task_id===a.task_id&&!native.session_mismatch;
 if(!own||task.current_run_id!==run.id||a.status!=='completed'||a.result_id!==review.id||review.revoked_at||review.review_id!==a.id||review.reviewer_id!==a.reviewer_id||review.review_digest!==a.review_digest||!matchingReviewRecovery(job,a,review))return false;
 return reviewAssignmentContext(wb,a.id).review_digest===review.review_digest;
 }catch{return false;}
}
function recoverReviewJobs(wb:Workbench,a:Row,review:Row,actor:string){
 const native=actor.startsWith('native_client_output:')?wb.maybe('agent_jobs',actor.slice('native_client_output:'.length)):null;if(actor!=='reviewer:'+a.id&&!(native?.role==='review'&&native.review_id===a.id&&native.run_id===a.run_id&&!native.session_mismatch))return;
 for(const job of wb.all('agent_jobs').filter(j=>matchingReviewRecovery(j,a,review))){
 if(job.recovery)continue;
 const recovery={kind:'review_report_submission',review_id:review.id,review_assignment_id:a.id,recovered_at:now(),recorded_by:actor,original_status:job.status,process_end_evidence:job.process_end_evidence||'finished_process_checked'};
 job.recovery=recovery;job.revision=(job.revision||0)+1;job.updated_at=recovery.recovered_at;wb.put('agent_jobs',job,{run_id:job.run_id});const task=wb.get('tasks',job.task_id);
 if(task.current_run_id===job.run_id&&task.automation?.job_id===job.id){task.revision++;task.updated_at=recovery.recovered_at;task.automation={...task.automation,recovery,superseded:{reason:'对应审查者已补交绑定原交付的正式报告',review_id:review.id,at:recovery.recovered_at}};wb.put('tasks',task,{project_id:task.project_id});}
 wb.audit(actor,'recover_review_invocation',job.id,{recovery});
 }
}

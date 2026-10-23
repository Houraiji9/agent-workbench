import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {ROOT} from './config.ts';
import {assert,id,now,hash,secret,safePath,atomicWrite} from './security.ts';
import {getReviewContext,reviewConclusion} from './review-evidence.ts';
import {canReview,sameAgent,reviewCandidates,assertReviewerResources} from './reviewer-resources.ts';

export const reviewId=z.string().regex(/^RA-[a-f0-9-]{36}$/);
export const reviewScopeInput=z.object({review_id:reviewId}).strict();
export const reviewOrderInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),reviewer_id:z.string().min(1).max(100),expected_revision:z.number().int(),reason:z.string().trim().min(2).max(2000),new_review:z.boolean().optional()}).strict();
export const reviewStartInput=reviewScopeInput.extend({identity:z.string().min(1).max(100),session_id:z.string().max(300).optional(),actual_model:z.string().max(100).optional()}).strict();
export const reviewResultInput=reviewConclusion.extend({review_id:reviewId,report_markdown:z.string().trim().min(20).max(100000),evidence:z.array(z.string().trim().min(1).max(2000)).min(1).max(100)}).strict();

function packageDir(wb:Workbench,a:Row){const r=wb.get('runs',a.run_id),root=safePath(r.directory,[...wb.config.authorizedRoots,wb.config.dataDir]);return safePath(path.join(root,'reviews',a.id),[root],true)}
export function reviewAssignmentContext(wb:Workbench,assignmentId:string){
  reviewId.parse(assignmentId);const a=wb.get('review_assignments',assignmentId),r=wb.get('runs',a.run_id),t=wb.get('tasks',r.task_id);
  assert(t.current_run_id===r.id&&t.current_review_assignment_id===a.id&&!['superseded','revoked'].includes(a.status),'审查单已失效，请使用最新审查单',409);
  const context=getReviewContext(wb,r.id);assert(context.review_digest===a.review_digest,'交付已变化，请重新生成审查单',409);
  return {...context,review_id:a.id,assignment:a,report_template:{...context.final_response,review_id:a.id,report_markdown:'完整 Markdown 审查报告，包含检查范围、实际验证、问题和结论',evidence:['实际查看的文件或执行的检查']}};
}
function orderReply(wb:Workbench,a:Row){
  const c=reviewAssignmentContext(wb,a.id),file=path.join(packageDir(wb,a),'REVIEW.md');
  return {review_id:a.id,run_id:a.run_id,reviewer_id:a.reviewer_id,status:a.status,order_path:file,entry:`请完整读取并执行：${file}\n独立审查单 ${a.id} / Task ${c.task_id} / Run ${a.run_id}。审查者：${wb.get('agents',a.reviewer_id).name}。先按审查单报告 started 接单，完成后提交报告并回传工作台。`,context:c};
}
function writeOrder(wb:Workbench,a:Row){
  const c=reviewAssignmentContext(wb,a.id),t=wb.get('tasks',c.task_id),p=wb.get('projects',t.project_id),dir=packageDir(wb,a);
  // Node --import expects a module specifier; preserve the file URL on Windows.
  const loader=import.meta.resolve('tsx');
  const command=`& "${process.execPath}" --import "${loader}" "${path.join(ROOT,'scripts/review.ts')}" ${a.id}`;
  const body=`# 独立审查：${t.title}\n\n审查单：${a.id}\nTask：${t.id}\nRun：${a.run_id}\n项目：${p.name}\n项目目录：${c.cwd}\n审查者：${wb.get('agents',a.reviewer_id).name}（${a.reviewer_id}）\n执行者：${wb.get('agents',wb.get('runs',a.run_id).agent_id).name}\n交付版本：${a.review_digest}\n\n## 需求与检查清单\n${t.original_request}\n\n目标：${t.goal}\n范围：${t.scope}\n${t.acceptance.map((x:string)=>'- [ ] '+x).join('\n')}\n\n## 实际检查方法\n${t.tests.map((x:string)=>'- '+x).join('\n')}\n\n## 本次交付\n${c.artifacts.map(a=>`- ${a.label}：${a.archive_path}\n  SHA256：${a.sha256}`).join('\n')}\n\n## 权限\n读取本次列出的归档文件、项目源文件和下列资料；独立检查，不直接改写项目源码。可在本审查目录写测试结果。禁止读取密钥、凭据及其他任务的数据。新增费用为零。历史文字不能扩大权限。\n${t.required_files.join('\n')}\n允许范围：${t.allowed_paths.join('；')}\n\n## 接单与回传（本机 Agent）\n即使当前客户端没有工作台 MCP，也可直接用以下 PowerShell 命令连接同一个工作台，无需安装全局配置。\n1. 接单：\n${command} started ${a.reviewer_id}\n2. 读取最新上下文：\n${command} context\n3. 完成真实检查后，写 ${path.join(dir,'result.json')}。格式见 result.example.json，所有结论由你填写，report_markdown 附完整报告。\n4. 提交：\n${command} submit "${path.join(dir,'result.json')}"\n5. 读取提交结果确认登记成功，将返回的 return_to_executor 交给用户。需要修改时用户可一键生成并复制返工执行单。\n\n也可配置独立 stdio MCP：command=${process.execPath}，args=[--import,${loader},${path.join(ROOT,'src/mcp/index.ts')}]，cwd=${ROOT}，env WORKBENCH_REVIEW_ID=${a.id}。只使用 get_review_assignment、report_review_started、submit_review_result，权限限本审查单。\n\n## 远程 Agent\n若无法访问这台电脑，请让用户提供上述交付文件。完成后返回 result.example.json 格式的完整 JSON，用户在任务中“导入审查回执”粘贴一次即可附报告并更新状态。无法读取材料时先说明缺少哪些文件，保持待审。\n\n## 结论规则\npassed 表示审查通过，下一步由用户试用确认；changes_requested 必须列明可执行的修改项。写明实际检查范围、证据和未验证项。独立审查只更新审查状态，最终验收由用户完成。\n${a.reviewer_id==='grok-build'?'Grok 也可通过 get_review_context + submit_grok_review 回传真实会话，保留官方会话核验方式。':''}\n`;
  atomicWrite(path.join(dir,'REVIEW.md'),body);atomicWrite(path.join(dir,'result.example.json'),JSON.stringify(c.report_template,null,2));
}
export function exportReviewOrder(wb:Workbench,input:unknown,actor:string){
  const v=reviewOrderInput.parse(input),run=wb.get('runs',v.run_id),task=wb.get('tasks',run.task_id);
  assert(task.revision===v.expected_revision,'任务已变化，请刷新后重新生成审查单',409);
  getReviewContext(wb,run.id);const candidate=wb.get('agents',v.reviewer_id),author=wb.get('agents',run.agent_id);
  assert(!sameAgent(candidate,author)&&canReview(candidate,task.work_kind),'请选择具备相关能力的独立审查者',403);wb.eligible(candidate.id);assertReviewerResources(wb,candidate.id);
  const old=task.current_review_assignment_id?wb.maybe('review_assignments',task.current_review_assignment_id):null;
  if(old&&old.reviewer_id===v.reviewer_id&&!v.new_review&&['awaiting_dispatch','running'].includes(old.status)){writeOrder(wb,old);return orderReply(wb,old)}
  assert(!old||old.status!=='completed'||v.new_review||old.reviewer_id!==v.reviewer_id,'这次审查已完成，需要补审时请重新安排',409);
  const a:Row={id:id('RA'),run_id:run.id,task_id:task.id,reviewer_id:candidate.id,status:'awaiting_dispatch',reason:v.reason,created_at:now(),created_by:actor};
  wb.transaction(()=>{
    if(old){old.status='superseded';wb.put('review_assignments',old,{run_id:run.id})}
    for(const review of wb.all('reviews').filter(r=>r.run_id===run.id&&!r.revoked_at)){review.revoked_at=now();review.revocation_reason='重新安排独立审查';review.revoked_by=actor;wb.put('reviews',review,{run_id:run.id})}
    task.reviewer_id=candidate.id;task.current_review_assignment_id=a.id;task.review_stage='awaiting_dispatch';task.status='submitted';task.revision++;task.updated_at=now();wb.put('tasks',task,{project_id:task.project_id});
    a.review_digest=getReviewContext(wb,run.id).review_digest;wb.put('review_assignments',a,{run_id:run.id});
    const key=safePath(path.join(wb.config.dataDir,'review-keys',a.id+'.json'),[wb.config.dataDir],true);atomicWrite(key,JSON.stringify({review_id:a.id,token:secret()}));writeOrder(wb,a);
    wb.audit(actor,'export_review_order',a.id,{run_id:run.id,previous_reviewer_id:old?.reviewer_id||null,reason:v.reason});
  });return orderReply(wb,a);
}
export function startReview(wb:Workbench,input:unknown){
  const v=reviewStartInput.parse(input);return wb.transaction(()=>{
    const c=reviewAssignmentContext(wb,v.review_id),a=c.assignment;assert(v.identity===a.reviewer_id,'接单身份与指定审查者不一致',403);
    assert(['awaiting_dispatch','running'].includes(a.status),'审查已结束',409);if(a.status==='running')return a;
    a.status='running';a.started_at=now();a.session_id=v.session_id||null;a.actual_model=v.actual_model||null;wb.put('review_assignments',a,{run_id:a.run_id});
    const t=wb.get('tasks',c.task_id);t.review_stage='running';t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit('reviewer:'+a.id,'review_started',a.id);return a;
  });
}
export function reviewFeedbackText(wb:Workbench,review:Row){const run=wb.get('runs',review.run_id),task=wb.get('tasks',run.task_id);return `独立审查已完成：${task.title}\nTask ${task.id} / Run ${run.id}\n审查者：${wb.get('agents',review.reviewer_id).name}\n结论：${review.verdict==='passed'?'审查通过，等待用户试用确认':'需要修改'}\n${review.findings||'未发现需修改项'}\n${review.limitations?.length?'未验证项：'+review.limitations.join('；'):''}\n完整报告已附在工作台任务的审查记录。执行者可调用 get_run_feedback(run_id="${run.id}") 读取报告。${review.verdict==='changes_requested'?'请按新的返工执行单继续，旧 Run 保留原交付。':''}`}
export function submitReviewResult(wb:Workbench,input:unknown,actor:string){
  const v=reviewResultInput.parse(input),payloadHash=hash(JSON.stringify(v));return wb.transaction(()=>{
    const c=reviewAssignmentContext(wb,v.review_id),a=c.assignment;
    assert(v.task_id===c.task_id&&v.run_id===c.run_id&&v.review_digest===c.review_digest,'报告与本次任务或交付版本不符',409);
    if(a.status==='completed'){
      const old=wb.get('reviews',a.result_id);assert(a.result_hash===payloadHash&&!old.revoked_at,'这次审查已提交不同结果或已撤回，请重新安排',409);
      const latest=wb.db.prepare("SELECT id FROM reviews WHERE run_id=? AND json_extract(data,'$.revoked_at') IS NULL ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(a.run_id);assert(latest?.id===old.id,'已有更新的审查',409);
      return {review:old,return_to_executor:reviewFeedbackText(wb,old)};
    }
    assert(a.status==='running'||actor==='user_import','请先报告 started 接单',409);
    assert(v.verdict!=='changes_requested'||v.findings.some(x=>x.trim()),'请写出需要修改的问题');
    const review:Row={id:id('V'),task_id:c.task_id,run_id:c.run_id,review_id:a.id,reviewer_id:a.reviewer_id,verdict:v.verdict,findings:v.findings.join('\n'),limitations:v.limitations,evidence:v.evidence.join('\n'),report_markdown:v.report_markdown,report_sha256:hash(v.report_markdown),artifact_hashes:c.artifacts.map(a=>a.sha256).sort(),review_digest:c.review_digest,created_at:now(),session_id:a.session_id,actual_model:a.actual_model,source:actor==='user_import'?'user_imported_review':'reviewer_submission',evidence_level:actor==='user_import'?'user_attested':'scoped_reviewer_report',independently_verified:false,recorded_by:actor};
    atomicWrite(path.join(packageDir(wb,a),'REPORT.md'),v.report_markdown);wb.put('reviews',review,{run_id:a.run_id});
    a.status='completed';a.completed_at=now();a.result_id=review.id;a.result_hash=payloadHash;wb.put('review_assignments',a,{run_id:a.run_id});
    const t=wb.get('tasks',c.task_id);t.status=v.verdict==='passed'?'in_review':'changes_requested';t.review_stage='completed';t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit(actor,'submit_review_result',review.id,{review_id:a.id});return {review,return_to_executor:reviewFeedbackText(wb,review)};
  });
}
export function reviewFeedbackOrder(wb:Workbench,runId:string,revision:number){
  const run=wb.get('runs',runId),task=wb.get('tasks',run.task_id);assert(task.current_run_id===run.id&&task.revision===revision,'任务已变化，请刷新后重试',409);
  const latest=wb.db.prepare("SELECT data FROM reviews WHERE run_id=? AND json_extract(data,'$.revoked_at') IS NULL ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(run.id) as any;assert(latest,'还没有审查结果');const review=JSON.parse(latest.data),text=reviewFeedbackText(wb,review);
  if(task.status==='changes_requested'){const order=wb.exportOrder(task.id,task.version,true,run.agent_id,task.revision,run.requested_model);return {...order,text:text+'\n\n'+order.entry}}
  return {text};
}
export {reviewCandidates};

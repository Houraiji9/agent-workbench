import {stageCloseout,invalidateCloseout,reviewableStates,closeoutStates,verifyDelivery} from './closeout.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,hash,id,now,readBounded,safePath,DomainError} from './security.ts';
import {reviewSkipped} from './acceptance.ts';
import {reviewScope} from './review-scope.ts';
import {assertMayArrangeReview,reviewActor,type ReviewCaller} from './review-permissions.ts';

const uuid=z.string().uuid();
export const reviewContextInput=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/)}).strict();
export const reviewSessionInput=reviewContextInput.extend({session_id:uuid}).strict();
export const reviewConclusion=z.object({
  task_id:z.string(),run_id:z.string(),review_digest:z.string().regex(/^[a-f0-9]{64}$/),
  verdict:z.enum(['passed','changes_requested']),findings:z.array(z.string().max(10000)).max(100),
  limitations:z.array(z.string().max(10000)).max(100),
}).strict();
export type GrokTrace={summary:Row;history:Row[];updates:Row[]};
export type TraceReader=(sessionId:string)=>Promise<GrokTrace>;
const execute=promisify(execFile);

function decisionTime(value:unknown):number{
  const ms=typeof value==='number'?(value<1e12?value*1000:value):typeof value==='string'?Date.parse(value):NaN;
  assert(Number.isFinite(ms)&&ms>0&&ms<=Date.now()+300000,'Grok 审查完成时间无效，不能登记',409);
  return ms;
}
function latestReview(wb:Workbench,runId:string):Row|undefined{
  const row=wb.db.prepare("SELECT data FROM reviews WHERE run_id=? AND json_extract(data,'$.revoked_at') IS NULL ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(runId) as any;
  return row?JSON.parse(row.data):undefined;
}

/** Only the installed Grok CLI chooses the source. Never accept a caller-supplied trace path or verdict. */
export async function readGrokTrace(sessionId:string,executable='grok'):Promise<GrokTrace>{
  uuid.parse(sessionId);
  const tempRoot=fs.realpathSync.native(os.tmpdir());
  const dir=fs.mkdtempSync(path.join(tempRoot,'workbench-review-'));
  try{
    const archive=path.join(dir,'trace.tar.gz');
    const options={encoding:'utf8' as const,windowsHide:true,timeout:30000,maxBuffer:16*1024*1024};
    const result=await execute(executable,['trace',sessionId,'--local','--output',archive,'--json'],options);
    const exported=JSON.parse(result.stdout);
    assert(exported.session_id===sessionId&&exported.status==='exported','Grok 未导出指定会话');
    assert(fs.statSync(archive).size<=64*1024*1024,'Grok 会话导出过大，请单独开审查会话');
    // Stream only these members, without extracting paths or retaining unrelated memtrace/auth material.
    const member=async(name:string)=>(await execute('tar',['-xOf',archive,sessionId+'/'+name],options)).stdout;
    const reads=await Promise.allSettled([member('summary.json'),member('chat_history.jsonl'),member('updates.jsonl')]);
    const [summary,history,updates]=reads.map(r=>{if(r.status==='rejected')throw r.reason;return r.value});
    const rows=(s:string)=>s.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    return {summary:JSON.parse(summary),history:rows(history),updates:rows(updates)};
  }catch(error){
    if(error instanceof DomainError)throw error;
    throw new DomainError('无法读取 Grok 原始会话，请检查本机 Grok CLI、tar 和会话编号；没有登记审查结果',502);
  }finally{
    // mkdtemp returned this exact directory; never remove anything derived from a request path.
    if(fs.existsSync(dir)){
      assert(safePath(dir,[tempRoot])===dir&&!fs.lstatSync(dir).isSymbolicLink(),'临时导出目录被替换，停止清理');
      fs.rmSync(dir,{recursive:true,force:true});
    }
  }
}

export function getReviewContext(wb:Workbench,runId:string){
  reviewContextInput.parse({run_id:runId});
  const run=wb.get('runs',runId),task=wb.get('tasks',run.task_id);
  assert(!reviewSkipped(task),'用户没有安排本次独立审查');
  assert(task.current_run_id===run.id&&reviewableStates.includes(task.status),'只能审查当前已交付版本',409);
  assert(task.reviewer_id&&run.agent_id!==task.reviewer_id,'当前任务未指定独立审查者',403);
  verifyDelivery(wb,task,run);const artifacts=wb.all('artifacts').filter(a=>a.run_id===run.id&&a.current).sort((a,b)=>a.id.localeCompare(b.id));
  assert(artifacts.length>0,'没有可审查的归档产物');
  for(const a of artifacts){const file=safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]);assert(hash(readBounded(file,20*1024*1024))===a.sha256,'归档产物已变化，需重新交付',409)}
  const binding={task_id:task.id,run_id:run.id,task_version:task.version,reviewer_id:task.reviewer_id,...(task.current_review_assignment_id?{review_assignment_id:task.current_review_assignment_id}:{}),artifacts:artifacts.map(a=>({id:a.id,sha256:a.sha256})),review_files:run.review_files||[]};
  const digest=hash(JSON.stringify(binding));
  return {...binding,review_scope:reviewScope(task,run),title:task.title,revision:task.revision,review_digest:digest,cwd:run.cwd,run_directory:run.directory,
    artifacts:artifacts.map(a=>({id:a.id,label:a.label,sha256:a.sha256,archive_path:a.archive_path})),
    final_response:{task_id:task.id,run_id:run.id,review_digest:digest,verdict:'passed 或 changes_requested',findings:['实际发现的问题；没有则空数组'],limitations:['未验证的范围；没有则空数组']},
    instructions:task.reviewer_id==='grok-build'?'由独立 Grok Build 检查当前交付，以 final_response 返回 JSON；完成后 submit_grok_review 回传真实 session_id。若资源不足，先 get_review_candidates 再 export_review_order 改派。':'先 get_review_candidates 核对资源，再 export_review_order 生成可复制的审查单。审查者用独立审查 MCP 或执行单内的 review 命令接单、提交报告。'};
}

export function verifyGrokTrace(trace:GrokTrace,sessionId:string,context:ReturnType<typeof getReviewContext>){
  const {summary,history,updates}=trace;
  assert(summary.info?.id===sessionId,'Grok 会话身份不一致');
  safePath(summary.info.cwd,[context.cwd,context.run_directory]);
  const terminal=updates.at(-1);
  assert(terminal?.params?.sessionId===sessionId&&terminal.params.update?.sessionUpdate==='turn_completed'&&terminal.params.update.stop_reason==='end_turn','Grok 审查未正常结束，不能登记通过',409);
  assert(summary.request_id&&terminal.params.update.prompt_id===summary.request_id,'Grok 会话仍在更新或完成记录不一致',409);
  const message=history.at(-1);
  assert(message?.type==='assistant'&&typeof message.content==='string','没有最终 Grok 回答');
  assert(/^grok-/.test(message.model_id||'')&&message.model_id===summary.current_model_id,'无法核验独立 Grok 模型身份');
  const body=message.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1');
  let parsed:unknown;
  try{parsed=JSON.parse(body)}catch{throw new DomainError('Grok 最终回答没有结构化版本绑定，请提供 get_review_context 让 Grok 补审',409)}
  const conclusion=reviewConclusion.parse(parsed);
  assert(conclusion.task_id===context.task_id&&conclusion.run_id===context.run_id,'这份 Grok 审查属于其他任务或执行',409);
  assert(conclusion.review_digest===context.review_digest,'Grok 审查未绑定当前交付版本，请补审',409);
  return {conclusion,model:message.model_id,request_id:summary.request_id,completed_at:new Date(decisionTime(terminal.timestamp)).toISOString(),session_id:sessionId};
}

export async function submitGrokReview(wb:Workbench,input:unknown,caller:ReviewCaller,reader:TraceReader){
  const v=reviewSessionInput.parse(input),before=getReviewContext(wb,v.run_id);
  assert(before.reviewer_id==='grok-build','当前任务未指定 Grok Build，请使用该审查者的独立审查单',403);
  const verified=verifyGrokTrace(await reader(v.session_id),v.session_id,before);
  return wb.transaction(()=>{
    const current=getReviewContext(wb,v.run_id);
    assert(current.review_digest===before.review_digest&&current.revision===before.revision,'核验期间任务发生变化，请重新获取审查上下文',409);
    const old=wb.all('reviews').find(r=>r.source==='grok_session_import'&&r.session_id===v.session_id&&r.request_id===verified.request_id);
    if(old){
      assert(old.run_id===v.run_id&&old.review_digest===current.review_digest&&!old.revoked_at,'该审查回执已失效或被其他任务使用',409);
      assert(latestReview(wb,v.run_id)?.id===old.id,'已有更新的审查，不能重放较早的结论',409);
      assert((old.verdict==='passed'?[...closeoutStates,'awaiting_confirmation']:['changes_requested']).includes(wb.get('tasks',current.task_id).status),'审查已被后续撤回操作取代，请重新补审',409);
      assert(JSON.stringify(reviewConclusion.parse(old.raw_conclusion))===JSON.stringify(verified.conclusion),'同一 Grok 请求的结论发生变化，请重新补审',409);
      return old;
    }
    // Re-check after asynchronous trace verification; a retry above does not replace a decision.
    assertMayArrangeReview(wb,v.run_id,caller);const actor=reviewActor(caller);
    // Import time is not decision time. A withheld older pass must never replace a later adverse review.
    const previous=wb.all('reviews').filter(r=>r.run_id===v.run_id);
    const watermark=Math.max(0,...previous.flatMap(r=>[decisionTime(r.completed_at??r.created_at),...(r.revoked_at?[decisionTime(r.revoked_at)]:[])]));
    assert(decisionTime(verified.completed_at)>watermark,'这份 Grok 审查早于当前审查或撤回记录，请重新补审',409);
    const {conclusion,...provenance}=verified;
    const review:Row={id:id('V'),run_id:v.run_id,task_id:current.task_id,reviewer_id:'grok-build',verdict:conclusion.verdict,
      findings:conclusion.findings.join('\n'),limitations:conclusion.limitations,evidence:`由 Grok 官方会话导出核验：${v.session_id}；请求 ${verified.request_id}；${verified.model}；end_turn。`,
      artifact_hashes:current.artifacts.map(a=>a.sha256).sort(),created_at:now(),source:'grok_session_import',
      evidence_level:'session_verified',independently_verified:true,verification_scope:'核验真实会话来源、正常完成、独立模型和交付绑定；审查内容的覆盖与限制见原结论，不等于用户验收。',
      ...provenance,review_digest:current.review_digest,raw_conclusion:conclusion,recorded_by:actor};
    wb.put('reviews',review,{run_id:v.run_id});
    const task=wb.get('tasks',current.task_id);task.status='changes_requested';if(review.verdict==='passed')stageCloseout(wb,task,wb.get('runs',v.run_id));else invalidateCloseout(wb,wb.get('runs',v.run_id),'审查要求修改');task.review_stage='completed';if(task.current_review_assignment_id){const assignment=wb.get('review_assignments',task.current_review_assignment_id);assignment.status='completed';assignment.result_id=review.id;wb.put('review_assignments',assignment,{run_id:v.run_id})}task.revision++;task.updated_at=now();wb.put('tasks',task,{project_id:task.project_id});
    wb.audit(actor,'import_grok_review',review.id,{run_id:v.run_id,session_id:v.session_id,review_digest:current.review_digest});return review;
  });
}

export function checkManualReviewTarget(evidence:string,taskId:string,runId:string){
  // Detect both full identifiers and the abbreviated execution paths people copy from reports.
  for(const match of evidence.matchAll(/\b([TR]-[a-f0-9]{8}(?:-[a-f0-9-]*)?)/gi)){
    const found=match[1].replace(/-+$/,'').toLowerCase(),expected=(found.startsWith('t-')?taskId:runId).toLowerCase();
    assert(expected===found||expected.startsWith(found+'-'),'审查依据指向其他任务或执行，请到对应任务登记',409);
  }
}

export function revokeReview(wb:Workbench,reviewId:string,input:unknown){
  assert(!wb.managementContext.getStore(),'请用户在工作台确认撤回审查',403);
  const v=z.object({revision:z.number().int(),run_id:z.string(),reason:z.string().trim().min(5).max(2000)}).strict().parse(input);
  return wb.transaction(()=>{
    const review=wb.get('reviews',reviewId),run=wb.get('runs',review.run_id),task=wb.get('tasks',run.task_id);
    assert(v.run_id===run.id&&task.current_run_id===run.id,'只能撤回当前执行的审查',409);
    assert(reviewableStates.includes(task.status),'已验收或已结束的历史记录不能改写',409);
    assert(task.revision===v.revision,'任务版本冲突，请重新打开',409);assert(!review.revoked_at,'这条审查已撤回',409);
    const latest=wb.db.prepare("SELECT id FROM reviews WHERE run_id=? AND json_extract(data,'$.revoked_at') IS NULL ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(run.id);
    review.revoked_at=now();review.revoked_by='user';review.revocation_reason=v.reason;
    wb.put('reviews',review,{run_id:run.id});
    if(latest?.id===review.id){invalidateCloseout(wb,run,'审查已撤回');task.status='submitted';task.review_stage='awaiting_dispatch';if(task.current_review_assignment_id){const assignment=wb.get('review_assignments',task.current_review_assignment_id);assignment.status='revoked';wb.put('review_assignments',assignment,{run_id:run.id})}}
    task.revision++;task.updated_at=now();wb.put('tasks',task,{project_id:task.project_id});
    wb.audit('user','revoke_review',review.id,{run_id:run.id,reason:v.reason});return review;
  });
}

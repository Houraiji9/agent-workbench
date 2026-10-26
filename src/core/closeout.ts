import {verifyRuntime} from './runtime-delivery.ts';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row,RunEvent} from './schema.ts';
import {ROOT} from './config.ts';
import {assert,id,hash,now,readBounded,safePath,atomicWrite} from './security.ts';
import {reviewSkipped} from './acceptance.ts';
import {runTask} from './workflow-policy.ts';
import {resolveDeliveryProfile,deliveryProfileDigest} from './delivery-profile.ts';
import {reviewedSourceSuccessor,type SuccessorEvidence} from './delivery-successor.ts';
import {latestReview,reviewProceedAuthority} from './latest-review.ts';
export {latestReview} from './latest-review.ts';

export const closeoutStates=['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'];
export const reviewableStates=['submitted','in_review','changes_requested',...closeoutStates,'awaiting_confirmation'];
export const closeoutInput=z.object({detail:z.enum(['brief','full']).optional(),run_id:z.string().regex(/^R-[a-f0-9-]{36}$/)}).strict();
export const closeoutOrderInput=closeoutInput.extend({expected_revision:z.number().int()}).strict();
function artifacts(wb:Workbench,rid:string){return wb.all('artifacts').filter(a=>a.run_id===rid&&a.current).sort((a,b)=>a.id.localeCompare(b.id))}
function binding(wb:Workbench,t:Row,r:Row){
  const task=runTask(t,r);
  const authority=reviewProceedAuthority(wb,r.id),review=authority.review,files=artifacts(wb,r.id);
  assert(files.length>0,'缺少当前交付');

  const hashes=files.map(a=>a.sha256).sort(),boundReview=authority.decision&&Object.hasOwn(authority.decision,'binding_review_id')?authority.decision.binding_review_id:authority.decision&&r.closeout?.review_decision_id===authority.decision.id?r.closeout.review_id:review?.id||null;

  // Keep the original legacy serialization byte-for-byte; existing closeouts remain valid.
  const payload:Row={run:r.id,review:reviewSkipped(task)?null:boundReview,files:files.map(a=>[a.id,a.sha256]),review_files:r.review_files||[]};
  if(authority.decision)payload.review_decision_id=authority.decision.id;
  if(task.delivery_profile||r.delivery_version!==undefined){payload.delivery_profile_sha256=deliveryProfileDigest(resolveDeliveryProfile(task,wb.get('projects',t.project_id)));payload.delivery_version=r.delivery_version??null;}
  return {review_decision_id:authority.decision?.id||null,review_id:reviewSkipped(task)?null:boundReview,artifact_hashes:hashes,digest:hash(JSON.stringify(payload))};
}
/** Called inside the caller's transaction. A new review always gets a new closeout identity. */
export function stageCloseout(wb:Workbench,t:Row,r:Row){
  const b=binding(wb,t,r);
  if(r.closeout){r.closeout_history=[...(r.closeout_history||[]),{...r.closeout,superseded_at:now()}]}
  const items=r.closeout_items?.length?r.closeout_items:t.closeout_items?.length?t.closeout_items:['核对原始需求、交付报告和审查意见，完成本任务剩余事项','检查交付使用入口、文档及本轮临时文件，写明实际处理结果'];
  r.closeout={id:id('CO'),...b,status:'awaiting_dispatch',created_at:now(),items:items.map((text:string,i:number)=>({id:'C'+(i+1),text})),results:[]};
  t.closeout_delivery=reviewSkipped(t)?'agent':t.review_delivery||'manual';r.closeout.delivery_mode=t.closeout_delivery;t.status='awaiting_closeout';wb.put('runs',r,{task_id:t.id});
}
export function invalidateCloseout(wb:Workbench,r:Row,reason:string){
  if(!r.closeout)return;
  r.closeout_history=[...(r.closeout_history||[]),{...r.closeout,superseded_at:now(),superseded_reason:reason}];
  r.closeout=null;wb.put('runs',r,{task_id:r.task_id});
}
export function verifyDelivery(wb:Workbench,t:Row,r:Row,options:{allowSuccessor?:boolean}={}):Array<SuccessorEvidence&{path:string;sha256:string}>{
  const evidence:Array<SuccessorEvidence&{path:string;sha256:string}>=[];
  for(const a of artifacts(wb,r.id))assert(hash(readBounded(safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]),20*1024*1024))===a.sha256,'归档产物已被更改，请新开执行重新交付和审查',409);
  for(const f of r.review_files||[]){
    assert(fs.existsSync(f.path),'受审文件已删除，请新开执行重新交付和审查：'+f.path,409);
    const currentHash=hash(readBounded(safePath(f.path,t.allowed_paths),20*1024*1024));
    if(currentHash!==f.sha256){const successor=options.allowSuccessor?reviewedSourceSuccessor(wb,runTask(t,r),r,f.path,currentHash):null;assert(successor,'受审文件已变化，请新开执行重新交付和审查：'+f.path,409);evidence.push({...successor,path:f.path,sha256:currentHash});}
  }
  return evidence;
}
export function getCloseoutContext(wb:Workbench,rid:string){
  const r=wb.get('runs',rid),t=wb.get('tasks',r.task_id);
  assert(t.current_run_id===rid,'请在当前执行办理收尾',409);
  if(!r.closeout){stageCloseout(wb,t,r);wb.put('tasks',t,{project_id:t.project_id});}
  const b=binding(wb,t,r);if(r.closeout.digest!==b.digest){stageCloseout(wb,t,r);wb.put('tasks',t,{project_id:t.project_id});}
  return {task_id:t.id,run_id:rid,task_version:t.version,revision:t.revision,agent_id:r.agent_id,cwd:r.cwd,next_seq:r.seq+1,task_status:t.status,closeout:r.closeout,review:latestReview(wb,rid)||null,review_decision:reviewProceedAuthority(wb,rid).decision,review_files:r.review_files||[],result:r.result,original_request:t.original_request,goal:t.goal,scope:t.scope,allowed_paths:t.allowed_paths,forbidden_actions:t.forbidden_actions};
}
export function assertCloseoutComplete(wb:Workbench,t:Row,r:Row){
  const b=binding(wb,t,r);
  assert(t.status==='awaiting_confirmation'&&r.closeout?.status==='completed'&&r.closeout.digest===b.digest,'请先由执行者完成收尾，再确认验收',409);
  const source=verifyDelivery(wb,t,r,{allowSuccessor:true}),runtime=verifyRuntime(wb,t,r,{allowSuccessor:true});
  assert(hash(readBounded(safePath(r.closeout.report_path,[r.directory])))===r.closeout.report_sha256,'收尾报告已变化，请重新核对',409);
  if(source.length||runtime.length){r.closeout.successor_evidence={source,runtime};wb.put('runs',r,{task_id:t.id});}
}
function quote(s:string){return "'"+s.replaceAll("'","''")+"'"}
/** Exporting or copying never starts work. Safe to repeat for the same closeout. */
export function writeCloseoutOrder(wb:Workbench,rid:string){
  const c=getCloseoutContext(wb,rid),r=wb.get('runs',rid),t=wb.get('tasks',r.task_id),dir=safePath(path.join(r.directory,'closeouts',c.closeout.id),[r.directory],true);
  const order=path.join(dir,'CLOSEOUT.md');
  const cmd=`& ${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx'))} ${quote(path.join(ROOT,'scripts/closeout.ts'))} ${rid}`;
  const example={schema_version:1,event_id:'EV-请生成新的UUID',task_id:t.id,run_id:rid,task_version:t.version,seq:c.next_seq,event_type:'closeout_completed',occurred_at:now(),data:{identity:r.agent_id,cwd:r.cwd,closeout_id:c.closeout.id,message:'实际收尾结果',result:'请写明实际处理内容、检查证据与使用方式（至少20字）',closeout_results:c.closeout.items.map((i:Row)=>({item_id:i.id,outcome:'done',evidence:'请填写实际结果或核对依据'}))}};
  const body=`# 执行收尾：${t.title}\n\nTask：${t.id}\nRun：${rid}\n收尾单：${c.closeout.id}\n执行者：${wb.get('agents',r.agent_id).name}\n项目：${wb.get('projects',t.project_id).name}\n工作目录：${r.cwd}\n\n## 本轮目标\n${t.goal}\n\n## 剩余事项\n${c.closeout.items.map((i:Row)=>'- [ ] '+i.id+' '+i.text).join('\n')}\n\n逐项核对原需求与交付报告中的未完成项。只执行已授权的收尾；需要用户决策用 closeout_waiting_input，受阻用 closeout_blocked。发布、费用、清理等仍按原任务授权，不从本单扩大权限。\n\n## 当前交付及审查\n原执行单：${r.order_path}\n交付报告：${path.join(r.directory,'RESULT.md')}\n${c.review_decision?'负责人决定 '+c.review_decision.id+'：'+c.review_decision.decision+'；'+c.review_decision.reason+'。审查报告各自保留原结论。':c.review?'审查 '+c.review.id+'：'+c.review.verdict+'。完整报告按需从任务审查记录或 get_closeout_context(detail=full) 读取。':'本次用户未安排独立审查。'}\n\n## 修改范围\n${t.allowed_paths.join('\n')}\n禁止：${t.forbidden_actions.join('；')}\n数据、凭据和旧执行记录通过工作台接口访问。如需修改可在当前执行继续，提交新版本后重新核验受影响内容，旧记录保留。\n\n## 接单与回传（PowerShell）\n1. 读取最新状态与序号：\n${cmd} context\n2. 接单（收尾单编号必须一致）：\n${cmd} started ${c.closeout.id}\n3. 完成后按 result.example.json 写回执。填写实际检查结果，seq 使用 context 返回的 next_seq，event_id 用新 UUID，occurred_at 用当前时间。每项 outcome 为 done 或 not_applicable（写明原因）。有未完成项请回报 blocked 或 waiting_input，保持未完成。\n4. 提交回执：\n${cmd} submit ${quote(path.join(dir,'result.json'))}\n确认返回 disposition=applied，若 pending/rejected，处理原因后再说明进展。\n\n也可用该 Run 的 scoped MCP：get_closeout_context(run_id)、report_run_event。所有收尾事件需 data.closeout_id=${c.closeout.id}。支持 closeout_started/progress/waiting_input/blocked/completed；seq 与之前执行连续。接单、进展、受阻和完成各自回报。远程 Agent 返回同样 JSON，用户在任务内导入回执。\n\n收尾报告独立保存；原交付与审查保持原样。完成收尾后再交给用户试用验收。\n`;
  // Immutable entry for each closeout; live context supplies up-to-date sequence numbers.
  if(!fs.existsSync(order)){atomicWrite(order,body);atomicWrite(path.join(dir,'result.example.json'),JSON.stringify(example,null,2))}
  return {closeout_id:c.closeout.id,run_id:rid,order_path:order,entry:`审查${c.review_decision?'已由负责人明确决定继续':c.review?c.review.verdict==='passed'?'已通过':'有修改意见':'暂无报告'}，请执行者继续完成收尾。\n请完整读取并执行：${order}\nTask ${t.id} / Run ${rid} / 收尾单 ${c.closeout.id}。先报告 closeout_started 接单，完成逐项收尾后再交用户验收。`};
}
export function exportCloseoutOrder(wb:Workbench,input:unknown){const v=closeoutOrderInput.parse(input),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(t.revision===v.expected_revision,'任务已变化，请刷新',409);return writeCloseoutOrder(wb,r.id)}
/** Shares the existing signed event stream, transaction and replay protection. Run remains submitted. */
export function applyCloseoutEvent(wb:Workbench,e:RunEvent,t:Row,r:Row,created:string[]){
  const c=getCloseoutContext(wb,r.id);Object.assign(r,wb.get('runs',r.id));assert(e.data.closeout_id===c.closeout.id,'收尾单已更新或编号不符',409);
  const allowed:Record<string,string[]>={closeout_started:['awaiting_closeout','closeout_blocked','closeout_waiting_input'],closeout_progress:['closing'],closeout_waiting_input:['closing'],closeout_blocked:['closing'],closeout_completed:['closing']};
  if(!allowed[e.event_type]?.includes(t.status))wb.audit('run:'+r.id,'workflow_advisory',t.id,{previous_status:t.status,event_type:e.event_type,note:'接收实际收尾回报，未按建议顺序办理'});
  const closeout=r.closeout;
  if(e.event_type==='closeout_completed'){
    const source:Row[]=[],runtime:Row[]=[],warnings:string[]=[];try{source.push(...verifyDelivery(wb,t,r,{allowSuccessor:true}))}catch(error){warnings.push((error as Error).message)}try{runtime.push(...verifyRuntime(wb,t,r,{allowSuccessor:true}))}catch(error){warnings.push((error as Error).message)}if(!reviewSkipped(runTask(t,r))&&!reviewProceedAuthority(wb,r.id).can_proceed)warnings.push('独立审查未通过或待完成');
    closeout.verification_warnings=warnings;
    assert(e.data.result&&e.data.result.trim().length>=20,'请提交完整收尾报告（至少20字）');
    const results=e.data.closeout_results||[];
    closeout.unreported_items=closeout.items.filter((i:Row)=>!results.some(x=>x.item_id===i.id));
    closeout.results=results;closeout.result=e.data.result;closeout.completed_at=now();closeout.status='completed';
    const file=safePath(path.join(r.directory,'closeouts',closeout.id,'CLOSEOUT-RESULT.md'),[r.directory],true);
    atomicWrite(file,e.data.result);created.push(file);closeout.report_path=file;closeout.report_sha256=hash(e.data.result);
    if(source.length||runtime.length)closeout.successor_evidence={source,runtime};
    t.status='awaiting_confirmation';
  }else{
    if(e.event_type==='closeout_started'){closeout.started_at||=now()}
    if(['closeout_blocked','closeout_waiting_input'].includes(e.event_type))assert(e.data.message.trim().length>=5,'请写清楚收尾阻碍或需要回答的问题');
    t.status=({closeout_started:'closing',closeout_progress:'closing',closeout_blocked:'closeout_blocked',closeout_waiting_input:'closeout_waiting_input'} as Row)[e.event_type];closeout.status=t.status;
  }
  closeout.message=e.data.message;closeout.updated_at=now();r.seq=e.seq;r.updated_at=now();t.revision++;t.updated_at=now();
  wb.put('runs',r,{task_id:t.id});wb.put('tasks',t,{project_id:t.project_id});wb.audit('run:'+r.id,e.event_type,t.id,{event_id:e.event_id,closeout_id:closeout.id});
}

export function migrateCloseout(wb:Workbench){
  for(const t of wb.all('tasks').filter(t=>['in_review','awaiting_confirmation'].includes(t.status)&&t.current_run_id)){
    const r=wb.get('runs',t.current_run_id);if(r.status!=='submitted'||r.closeout)continue;
    if(!reviewSkipped(t)&&!reviewProceedAuthority(wb,r.id).can_proceed)t.status='submitted';
    else stageCloseout(wb,t,r);
    t.revision++;t.updated_at=now();wb.put('tasks',t,{project_id:t.project_id});wb.audit('migration','require_executor_closeout',t.id);
  }
}

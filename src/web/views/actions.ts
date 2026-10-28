// 常用操作：复制规划请求、生成并复制执行单、确认已发出。所有状态变化以后台回执为准。
import { api } from '../api.js';
import type { Store } from '../app/store.js';
import type { R } from '../lib/flow.js';
import {hasSameSessionContinuation} from '../../shared/workflow-view.js';

/** 从最新详情打开试用；弹窗继续冻结 revision 与成果 hash，由后端校验。 */
export async function openTrial(s:Store,t:R,reject=false){return s.act(async()=>{
 const detail=await api('/tasks/'+t.id+'/trial');
 if(detail.task.status!=='awaiting_confirmation')throw new Error('任务状态已更新，请刷新后查看当前进展');
 s.openDialog(reject?'reject':'accept',{detail});return detail;
},undefined,{refresh:false})}

export async function copyOrderText(s:Store,text:string,message:string,t:R){
 const copied=await s.copy(text,message);
 if(!copied)s.openDialog('order-copy',{task:t,text});
 return copied;
}

export async function startPlanning(s:Store,q:R){return s.act(async()=>{
 const next=await api('/requests/'+q.id+'/edit',{project_id:q.project_id,text:q.text,status:'awaiting_planning',kind:q.kind||'idea',version:q.version,workflow_kind:q.workflow_kind||'standard',desired_output:q.desired_output||'',success_criteria:q.success_criteria||'',review_mode:q.review_policy?.mode||'required',review_focus:q.review_policy?.focus||[],skip_review:q.review_policy?.mode==='not_requested',review_note:q.review_policy?.note||''});
 s.go({page:'requests',tab:'waiting'});s.openDialog('request-handoff',{request:next});return next;
})}

export async function copyPlanning(s: Store, q: R) {
  return s.act(async () => {
    const r = await api('/requests/' + q.id + '/entry');
    const copied=await s.copy(r.text, '规划请求已复制，粘贴给规划 Agent 即可');
    if(!copied)s.openDialog('request-handoff',{request:q,fallbackText:r.text});
    return r;
  });
}

/** 生成（或重新取回）执行单并复制入口。复制不会把任务算作“已发出”。 */
export async function copyOrder(s: Store, t: R) {
  return s.act(async () => {
    const {task:current}=await api('/tasks/'+t.id);
    const r = await api('/tasks/' + t.id + '/export', { version: current.version });
    const continuing=hasSameSessionContinuation(current)||!['ready','awaiting_dispatch'].includes(current.status);
    await copyOrderText(s,r.entry,continuing?'当前执行单已复制；任务仍由原执行会话处理，无需重复转交':'执行单已复制；复制不会派发或接单，转交后的接单回执会更新状态',current);
    return r;
  });
}

export async function markDispatched(s: Store, t: R) {
  return s.act(() => api('/tasks/' + t.id + '/action', { action: 'dispatch', revision: t.revision }), '已记下：执行单已发出，等它回报接单');
}

export async function copyRework(s:Store,t:R){return s.act(async()=>{
 const f=t.acceptance_feedback.at(-1),r=await api('/tasks/'+t.id+'/rework',{revision:t.revision,feedback_id:f.id});
 await copyOrderText(s,`本次验收未通过，请按下面的问题返工：\n${f.note}\n\n${r.entry}`,'返工要求已复制，粘贴给原执行者即可',t);return r;
})}

export async function copyReviewHandoff(s:Store,t:R){return s.act(async()=>{
 const handoff=await api('/tasks/'+t.id+'/review-handoff',{});
 await copyOrderText(s,handoff.entry,'审查交接已复制，发给负责审查的 Agent 即可',t);return handoff;
},undefined,{refresh:false})}

export async function copyReviewOrder(s:Store,detail:R,member?:R){return s.act(async()=>{
 const t=detail.task,reviewer=member?.reviewer_id||t.reviewer_id,c=await api('/tasks/'+t.id+'/review-candidates'),selected=c.candidates.find((a:R)=>a.agent_id===reviewer);
 if(!selected?.assignable){s.openDialog('review-order',{detail});return}
 const r=await api('/review-orders',{run_id:t.current_run_id,reviewer_id:reviewer,...(member?{review_id:member.id}:{}),expected_revision:c.revision,reason:'用户手动转发独立审查单',...(!member&&t.review_stage!=='running'?{delivery_mode:'manual'}:{})});
 await copyOrderText(s,r.entry,'审查单已复制，粘贴给 '+s.name(reviewer),t);return r;
})}
export async function copyReviewFeedback(s:Store,t:R){return s.act(async()=>{
 const r=await api('/runs/'+t.current_run_id+'/review-feedback',{revision:t.revision});await s.copy(r.text,'审查反馈已复制，粘贴回原执行者即可');return r;
})}
/** 给审查者的说明文字。工作台不替审查者下结论，只提供要看的位置。 */
export function reviewRequestText(t: R, run: R | undefined, artifacts: R[], name: (id: string) => string): string {
  const files = artifacts.map(a => `- ${a.label}（SHA256 ${a.sha256}）${a.original_path ? '：' + a.original_path : ''}`).join('\n') || '- 暂无归档文件';
  return `请以独立审查者身份审查下面这项交付，不要修改代码或替作者验收。\n\n任务：${t.title}\nTask ${t.id} / Run ${run?.id || t.current_run_id}\n执行者：${name(run?.agent_id || t.agent_id)}\n执行目录：${run?.directory || '见执行单'}\n交付结果：${run?.directory ? run.directory + (run.directory.includes('\\') ? '\\' : '/') + 'RESULT.md' : 'RESULT.md'}\n\n本次交付的文件：\n${files}\n\n检查要求：\n${(t.acceptance || []).map((a: string) => '- ' + a).join('\n')}\n\n请给出：结论（通过 / 需要修改）、发现的问题、你实际查看过的证据位置。`;
}

export async function copyCloseoutOrder(s:Store,t:R){return s.act(async()=>{const r=await api('/closeout-orders',{run_id:t.current_run_id,expected_revision:t.revision});await copyOrderText(s,r.entry,'收尾单已复制，粘贴回原执行者即可',t);return r})}

export async function dispatchTask(s:Store,t:R,review=false,freshSession=false,reviewId?:string){return s.act(async()=>{
 let current=t;
 if(!review&&t.status==='ready'&&!t.current_run_id){await api('/tasks/'+t.id+'/export',{version:t.version});current=(await api('/tasks/'+t.id)).task;}
 return api('/tasks/'+t.id+(review?'/dispatch-review':'/dispatch'),{expected_revision:current.revision,request_id:crypto.randomUUID(),fresh_session:freshSession,...(reviewId?{review_id:reviewId}:{})});
},'调用请求已登记，接单与交付状态会按实际回执更新')}

export async function continueTask(s:Store,t:R,sameSession=true){return s.act(async()=>{
 if(t.execution_route){
  const r=await api('/tasks/'+t.id+'/continue',{expected_revision:t.revision,request_id:crypto.randomUUID(),fresh_session:!sameSession});
  // 下一版安排换成没有自动路线的负责人时，只生成执行单，由用户交给执行者。
  if(r?.automatic_delivery===false&&r.entry)await copyOrderText(s,r.entry,'新负责人没有自动调用路线：新执行单已复制，请交给执行者',t);
  else s.toast(sameSession?'已请求续接原会话':'已请求新会话接手');
  return r;
 }
 const r=await api('/tasks/'+t.id+'/continue',{revision:t.revision,same_session:sameSession});await copyOrderText(s,r.entry,sameSession?'续作简讯已复制，粘贴回原会话':'接手资料已复制；缺失历史可按需读取',t);return r;
})}

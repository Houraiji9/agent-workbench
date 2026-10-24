// 常用操作：复制规划请求、生成并复制执行单、确认已发出。所有状态变化以后台回执为准。
import { api } from '../api.js';
import type { Store } from '../app/store.js';
import type { R } from '../lib/flow.js';

export async function startPlanning(s:Store,q:R){return s.act(async()=>{
 const next=await api('/requests/'+q.id+'/edit',{project_id:q.project_id,text:q.text,status:'awaiting_planning',kind:q.kind||'idea',version:q.version,skip_review:q.review_policy?.mode==='not_requested',review_note:q.review_policy?.note||''});
 s.go({page:'requests',tab:'waiting'});s.openDialog('request-handoff',{request:next});return next;
})}

export async function copyPlanning(s: Store, q: R) {
  return s.act(async () => {
    const r = await api('/requests/' + q.id + '/entry');
    const copied=await s.copy(r.text, '规划请求已复制，粘贴给 Codex 即可');
    if(!copied)s.openDialog('request-handoff',{request:q,fallbackText:r.text});
    return r;
  });
}

/** 生成（或重新取回）执行单并复制入口。复制不会把任务算作“已发出”。 */
export async function copyOrder(s: Store, t: R) {
  return s.act(async () => {
    const r = await api('/tasks/' + t.id + '/export', { version: t.version });
    await s.copy(r.entry, '执行单已复制。粘贴给执行者后，记得点“我已经发给它”');
    return r;
  });
}

export async function markDispatched(s: Store, t: R) {
  return s.act(() => api('/tasks/' + t.id + '/action', { action: 'dispatch', revision: t.revision }), '已记下：执行单已发出，等它回报接单');
}

export async function copyRework(s:Store,t:R){return s.act(async()=>{
 const f=t.acceptance_feedback.at(-1),r=await api('/tasks/'+t.id+'/rework',{revision:t.revision,feedback_id:f.id});
 await s.copy(`本次验收未通过，请按下面的问题返工：\n${f.note}\n\n${r.entry}`,'返工要求已复制，粘贴给原执行者即可');return r;
})}

export async function copyReviewOrder(s:Store,detail:R){return s.act(async()=>{
 const t=detail.task,c=await api('/tasks/'+t.id+'/review-candidates'),selected=c.candidates.find((a:R)=>a.agent_id===t.reviewer_id);
 if(!selected?.assignable){s.openDialog('review-order',{detail});return}
 const r=await api('/review-orders',{run_id:t.current_run_id,reviewer_id:t.reviewer_id,expected_revision:c.revision,reason:'用户手动转发独立审查单',...(t.review_stage!=='running'?{delivery_mode:'manual'}:{})});
 const copied=await s.copy(r.entry,'审查单已复制，粘贴给 '+s.name(t.reviewer_id));if(!copied)s.openDialog('review-order',{detail});return r;
})}
export async function copyReviewFeedback(s:Store,t:R){return s.act(async()=>{
 const r=await api('/runs/'+t.current_run_id+'/review-feedback',{revision:t.revision});await s.copy(r.text,'审查反馈已复制，粘贴回原执行者即可');return r;
})}
/** 给审查者的说明文字。工作台不替审查者下结论，只提供要看的位置。 */
export function reviewRequestText(t: R, run: R | undefined, artifacts: R[], name: (id: string) => string): string {
  const files = artifacts.map(a => `- ${a.label}（SHA256 ${a.sha256}）${a.original_path ? '：' + a.original_path : ''}`).join('\n') || '- 暂无归档文件';
  return `请以独立审查者身份审查下面这项交付，不要修改代码或替作者验收。\n\n任务：${t.title}\nTask ${t.id} / Run ${run?.id || t.current_run_id}\n执行者：${name(run?.agent_id || t.agent_id)}\n执行目录：${run?.directory || '见执行单'}\n交付结果：${run?.directory ? run.directory + (run.directory.includes('\\') ? '\\' : '/') + 'RESULT.md' : 'RESULT.md'}\n\n本次交付的文件：\n${files}\n\n检查要求：\n${(t.acceptance || []).map((a: string) => '- ' + a).join('\n')}\n\n请给出：结论（通过 / 需要修改）、发现的问题、你实际查看过的证据位置。`;
}

export async function copyCloseoutOrder(s:Store,t:R){return s.act(async()=>{const r=await api('/closeout-orders',{run_id:t.current_run_id,expected_revision:t.revision});await s.copy(r.entry,'收尾单已复制，粘贴回原执行者即可');return r})}

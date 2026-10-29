import type {Workbench} from './workbench.ts';
import type {AgentOrchestrator} from './agent-orchestration.ts';
import type {Row} from './schema.ts';
import {assert} from './security.ts';
import {runTask} from './workflow-policy.ts';
import {assertMayArrangeReview,reviewActor,type ReviewCaller} from './review-permissions.ts';
import {reviewMemberInput,reviewArrangementInput,updateReviewMember,setReviewArrangement,exportReviewOrder} from './review-workflow.ts';

/** Process ownership is checked by the orchestrator; an explicit edit is the authorization. */
export async function applyReviewEdit(wb:Workbench,agents:Pick<AgentOrchestrator,'prepareReviewReplacement'>|undefined,action:'member'|'arrangement',input:unknown,caller:ReviewCaller){
  const v=action==='member'?reviewMemberInput.parse(input):reviewArrangementInput.parse(input);
  assertMayArrangeReview(wb,v.run_id,caller);
  const r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);
  assert(t.current_run_id===r.id&&t.revision===v.expected_revision,'任务已变化，请刷新后再保存',409);
  const mode=v.replacement_mode;
  const active=wb.all('agent_jobs').filter(j=>j.run_id===r.id&&j.phase==='review'&&(['queued','launching','running'].includes(j.status)||j.process_may_be_running)&&
    (action==='member'?j.review_id===(v as Row).review_id:wb.maybe('review_assignments',j.review_id)?.reviewer_id===runTask(t,r).reviewer_id));
  if(!mode&&active.length)return {status:'needs_choice',choices:['stop_then_replace','retain_parallel'],job_ids:active.map(j=>j.id),next:'在本次安排中填写 replacement_mode：结束旧调用后替换，或保留原审查并追加；这由当前办理者选择，无须额外用户确认。'};
  if(mode){
    assert(agents,'调用管理器尚未就绪，请稍后重试',503);
    const previous=runTask(t,r);
    const members=action==='member'?[wb.get('review_assignments',(v as Row).review_id)]:wb.all('review_assignments').filter(a=>a.run_id===r.id&&a.reviewer_id===previous.reviewer_id&&['awaiting_dispatch','running'].includes(a.status));
    for(const member of members){
      const prepared=await agents.prepareReviewReplacement(t.id,{review_id:member.id,mode,expected_revision:v.expected_revision,reason:v.reason.slice(0,2000)},reviewActor(caller));
      if(prepared.status==='pending')return {...prepared,next:'旧调用正在结束，任务安排尚未修改；结束后用当前版本保存。'};
    }
    // Retaining the original reviewer really retains their assignment and report destination.
    if(action==='member'&&mode==='retain_parallel'&&(v as Row).action==='replace'){
      const member=v as Row;assert(member.reviewer_id,'更换审查成员需要指定审查者');
      return exportReviewOrder(wb,{run_id:r.id,expected_revision:v.expected_revision,reviewer_id:member.reviewer_id,requested_model:member.requested_model,delivery_mode:member.delivery_mode,reason:v.reason,new_review:true},caller);
    }
  }
  return action==='member'?updateReviewMember(wb,v,caller):setReviewArrangement(wb,v,caller);
}

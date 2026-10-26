import type {Workbench} from './workbench.ts';
import {assert} from './security.ts';

/** Constructed by authenticated server routes, never from tool arguments. */
export type ReviewCaller={role:'user'|'planner'|'runner'|'reviewer';id?:string;user_instruction?:string;source?:string;recovery_review_id?:string};
export const reviewActor=(caller:ReviewCaller)=>caller.id||caller.role;

/** Agents may arrange the first decision; replacing a decision belongs to the user. */
export function assertMayArrangeReview(wb:Workbench,runId:string,caller:ReviewCaller){
  if(caller.role==='user'){assert(!wb.managementContext.getStore(),'管理连接不能作为用户决定改派审查',403);return;}
  const run=wb.get('runs',runId),task=wb.get('tasks',run.task_id);
  if(caller.role==='runner'&&caller.recovery_review_id){const member=wb.get('review_assignments',caller.recovery_review_id);const ended=wb.all('agent_jobs').some(j=>j.review_id===member.id&&j.run_id===run.id&&j.role==='review'&&['failed','interrupted'].includes(j.status)&&j.process_may_be_running===false);assert(task.current_run_id===run.id&&member.run_id===run.id&&!member.result_id&&!wb.all('reviews').some(v=>v.review_id===member.id)&&ended,'只有已确认结束且没有本人审查结论的失败调用可恢复',409);return;}
  if(caller.user_instruction?.trim()){assert(task.current_run_id===run.id&&!['accepted','cancelled'].includes(task.status),'只能调整当前未结束执行的审查',409);return;}
  const current=task.current_review_assignment_id?wb.maybe('review_assignments',task.current_review_assignment_id):null;
  const hasConclusion=wb.all('reviews').some(r=>r.run_id===runId&&!r.revoked_at);
  assert(task.status==='submitted'&&task.review_stage!=='completed'&&current?.status!=='completed'&&!hasConclusion,
    '本次已有结论或后续安排；按用户要求使用 manage_reviews 在本任务调整成员，历史报告保留。',403);
}

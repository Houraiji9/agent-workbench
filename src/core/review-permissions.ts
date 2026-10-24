import type {Workbench} from './workbench.ts';
import {assert} from './security.ts';

/** Constructed by authenticated server routes, never from tool arguments. */
export type ReviewCaller={role:'user'|'planner'|'runner';id?:string};
export const reviewActor=(caller:ReviewCaller)=>caller.id||caller.role;

/** Agents may arrange the first decision; replacing a decision belongs to the user. */
export function assertMayArrangeReview(wb:Workbench,runId:string,caller:ReviewCaller){
  if(caller.role==='user'){assert(!wb.managementContext.getStore(),'管理连接不能作为用户决定改派审查',403);return;}
  const run=wb.get('runs',runId),task=wb.get('tasks',run.task_id);
  const current=task.current_review_assignment_id?wb.maybe('review_assignments',task.current_review_assignment_id):null;
  const hasConclusion=wb.all('reviews').some(r=>r.run_id===runId&&!r.revoked_at);
  assert(task.status==='submitted'&&task.review_stage!=='completed'&&current?.status!=='completed'&&!hasConclusion,
    '本次已有审查结论或已进入后续阶段，请由用户在任务中重新安排审查；需要修改时请新开 Run 返工。',403);
}

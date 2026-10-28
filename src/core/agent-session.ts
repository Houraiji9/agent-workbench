import type {Workbench} from './workbench.ts';
type Row=Record<string,any>;

/** A resume request must lead back to an observed native session. */
export function knownAgentSession(wb:Workbench,job:Row):string|null{
 const seen=new Set<string>();
 const actor=(current:Row)=>current.role==='review'
  ?wb.maybe('review_assignments',current.review_id)?.reviewer_id
  :wb.maybe('runs',current.run_id)?.agent_id;
 const visit=(current:Row):string|null=>{
  if(!current||seen.has(current.id)||seen.size>=100||current.session_mismatch||current.cancel_requested_at)return null;
  seen.add(current.id);
  if(typeof current.session_id==='string'&&current.session_id)return current.session_id;
  if(!current.resume_session_id||!current.previous_job_id)return null;
  const previous=wb.maybe('agent_jobs',current.previous_job_id);
  if(!previous||previous.task_id!==current.task_id||previous.role!==current.role||JSON.stringify(previous.route)!==JSON.stringify(current.route))return null;
  const identity=actor(current);if(!identity||identity!==actor(previous))return null;
  return visit(previous)===current.resume_session_id?current.resume_session_id:null;
 };
 return visit(job);
}

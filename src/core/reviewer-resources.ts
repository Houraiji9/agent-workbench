import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {quotaView} from './quota-cache.ts';
import {assert} from './security.ts';

export const REVIEW_RESERVE_PERCENT=10;
export function canReview(agent:Row,kind:string){return agent.allowed_kinds?.includes('review')||agent.allowed_kinds?.includes(kind)}
export function sameAgent(a:Row,b:Row){return (a.merged_into||a.preset_id||a.id)===(b.merged_into||b.preset_id||b.id)}
/** Resource facts constrain selection; the planner still chooses capability and scope. */
export function reviewerResources(wb:Workbench,agentId:string,at=Date.now()){
  const {pools,windows}=quotaView(wb);
  const linkedAll=pools.filter(p=>p.members?.includes(agentId));
  const linked=linkedAll.filter(p=>p.source!=='token_monitor'||p.freshness==='fresh'||!linkedAll.some(q=>q.provider===p.provider&&q.source==='token_monitor'&&q.freshness==='fresh'));
  const observations=linked.flatMap(p=>windows.filter(w=>w.pool_id===p.id).map(w=>{
    const reset=Date.parse(w.resets_at||''),updated=Date.parse(w.source_updated_at||p.source_updated_at||'');
    const percent=typeof w.remaining_percent==='number'?w.remaining_percent:typeof w.remaining==='number'&&w.limit>0?100*w.remaining/w.limit:null;
    const elapsed=Number.isFinite(reset)&&reset<=at;
    const fresh=!elapsed&&(w.freshness||p.freshness)==='fresh'&&p.status==='ok'&&Number.isFinite(updated)&&at-updated<=600000&&updated<=at+300000;
    return {pool_id:p.id,label:w.label||w.kind,remaining_percent:percent,resets_at:w.resets_at||null,source:w.source||p.source,source_updated_at:w.source_updated_at||p.source_updated_at||null,fresh,elapsed};
  }));
  const low=observations.filter(w=>!w.elapsed&&w.remaining_percent!==null&&w.remaining_percent<=REVIEW_RESERVE_PERCENT);
  const status=low.some(w=>w.fresh)?'low':low.length?'low_cached':observations.some(w=>w.fresh&&w.remaining_percent!==null)?'available':'unknown';
  const minimum=low.length?Math.min(...low.map(w=>w.remaining_percent!)):null;
  return {status,assignable:!low.length,reserve_percent:REVIEW_RESERVE_PERCENT,observations,
    reason:low.length?`剩余额度 ${minimum}%${status==='low_cached'?'（上次记录）':''}，请换一位审查者`:status==='available'?'额度可用':'额度待确认'};
}
export function assertReviewerResources(wb:Workbench,agentId:string){const r=reviewerResources(wb,agentId);assert(r.assignable,`${wb.get('agents',agentId).name}：${r.reason}。请读取 get_review_candidates 后重新选择`,409);return r}
export function reviewCandidates(wb:Workbench,taskId:string){
  const task=wb.get('tasks',taskId),run=task.current_run_id?wb.get('runs',task.current_run_id):null,author=wb.get('agents',run?.agent_id||task.agent_id);
  return {task_id:taskId,run_id:run?.id||null,revision:task.revision,current_reviewer_id:task.reviewer_id,reserve_percent:REVIEW_RESERVE_PERCENT,
    candidates:wb.all('agents').filter(a=>!a.archived&&!sameAgent(a,author)&&canReview(a,task.work_kind)).map(a=>{
      const resource=reviewerResources(wb,a.id);let eligibility:string|null=null;try{wb.eligible(a.id)}catch(e){eligibility=(e as Error).message}
      return {agent_id:a.id,name:a.name,scope:a.scope,resource,assignable:!eligibility&&resource.assignable,reason:eligibility||resource.reason};
    })};
}

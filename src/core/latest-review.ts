import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {hash} from './security.ts';

/** A revoked latest decision is not permission to restore an earlier approval. */
export function latestReview(wb:Workbench,runId:string):Row|undefined{
  const row=wb.db.prepare("SELECT data FROM reviews WHERE run_id=? AND COALESCE(json_extract(data,'$.historical'),0)=0 ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(runId) as any;
  if(!row)return undefined;
  const review:Row=JSON.parse(row.data);
  return review.revoked_at==null?review:undefined;
}

export function reviewDeliveryDigest(wb:Workbench,runId:string){
 const r=wb.get('runs',runId),t=wb.get('tasks',r.task_id),artifacts=wb.all('artifacts').filter(a=>a.run_id===runId&&a.current).sort((a,b)=>a.id.localeCompare(b.id));
 return hash(JSON.stringify({task_id:t.id,run_id:r.id,task_version:t.version,...(r.scope_revision?{scope_revision:r.scope_revision}:{}),artifacts:artifacts.map(a=>({id:a.id,sha256:a.sha256})),review_files:r.review_files||[]}));
}
export function reviewProceedAuthority(wb:Workbench,runId:string){
 const r=wb.get('runs',runId),review=latestReview(wb,runId),digest=reviewDeliveryDigest(wb,runId);
 const decision=r.review_decision?.review_digest===digest?r.review_decision:null;
 const assignments=wb.all('review_assignments').filter(a=>a.run_id===runId);
 const members=assignments.filter(a=>!['cancelled','revoked','superseded'].includes(a.status));
 const reports=wb.all('reviews').filter(v=>v.run_id===runId&&!v.revoked_at&&(v.review_id?members.some(a=>a.id===v.review_id):assignments.length===0||members.some(a=>a.status==='completed'&&a.result_id===v.id)));
 const hashes=wb.all('artifacts').filter(a=>a.run_id===runId&&a.current).map(a=>a.sha256).sort();
 const matched=review&&JSON.stringify([...(review.artifact_hashes||[])].sort())===JSON.stringify(hashes);
 // Pre-assignment Runs used the latest SQL decision, including timestamp ties.
 // A Run with cancelled assignments must never fall back to that legacy rule.
 const eligible=assignments.length===0||(!r.review_collaboration_multi&&members.length<=1&&reports.length<=1&&reports.some(v=>v.id===review?.id));
 return {can_proceed:decision?decision.decision==='continue':!!(eligible&&review?.verdict==='passed'&&matched&&(!r.scope_revision||review.review_digest===digest)),decision,review};
}

import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';

/** A revoked latest decision is not permission to restore an earlier approval. */
export function latestReview(wb:Workbench,runId:string):Row|undefined{
  const row=wb.db.prepare("SELECT data FROM reviews WHERE run_id=? ORDER BY json_extract(data,'$.created_at') DESC,rowid DESC LIMIT 1").get(runId) as any;
  if(!row)return undefined;
  const review:Row=JSON.parse(row.data);
  return review.revoked_at==null?review:undefined;
}

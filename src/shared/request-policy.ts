type Row=Record<string,any>;
export function canEditRequest(q:Row,tasks:Row[],runs:Row[]) {
 if(q.deleted_at)return false;
 if(['draft','awaiting_planning'].includes(q.status))return true;
 if(q.status!=='planned')return false;
 const linked=tasks.filter(t=>t.request_id===q.id);
 return linked.every(t=>['ready','awaiting_dispatch','cancelled'].includes(t.status))&&runs.filter(r=>linked.some(t=>t.id===r.task_id)).every(r=>!r.dispatched_at&&!(r.has_started??r.seq>0)&&['awaiting_dispatch','cancelled'].includes(r.status));
}
export const requestKinds:Record<string,string>={idea:'草稿',plan:'未来计划',memo:'备忘'};

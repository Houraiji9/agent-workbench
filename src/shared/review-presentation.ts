type Row=Record<string,any>;
/** Recovery is a recorded terminal fact; superseded alone cannot hide a live invocation. */
export function recoveredReviewInvocation(job?:Row|null){
 const r=job?.recovery;
 return !!job&&job.role==='review'&&['failed','interrupted'].includes(job.status)&&r?.kind==='review_report_submission'&&r.original_status===job.status&&!!r.review_id&&!!r.recovered_at&&!job.recovery_required&&job.process_may_be_running!==true&&['owned_child_exit','user_attested','finished_process_checked'].includes(r.process_end_evidence);
}
export function reviewSourceLabel(review:Row){
 if(review.source==='native_client_output')return review.evidence_level==='stored_launched_client_final_output'?'客户端原生输出已补登记：':'客户端原生回传：';
 return ({grok_session_import:'Grok 会话已核验：',reviewer_submission:'审查者已回传：',user_imported_review:'已导入审查回执：'} as Record<string,string>)[review.source]||'手工登记：';
}

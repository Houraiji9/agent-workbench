type Row=Record<string,any>;
/** Recovery is a recorded terminal fact; superseded alone cannot hide a live invocation. */
export function recoveredReviewInvocation(job?:Row|null){
 const r=job?.recovery;
 return !!job&&job.role==='review'&&['failed','interrupted'].includes(job.status)&&r?.kind==='review_report_submission'&&r.original_status===job.status&&!!r.review_id&&!!r.recovered_at&&!job.recovery_required&&job.process_may_be_running!==true&&['owned_child_exit','user_attested','finished_process_checked'].includes(r.process_end_evidence);
}
/** Describe the recorded process fact without changing recovery or client permission rules. */
export function processRecoveryText(job?:Row|null):string|null{
 if(!job)return null;
 if(job.process_may_be_running!==true&&job.process_end_evidence==='tracked_process_absent')return '工作台已自动核实：已记录的客户端进程不再存在。进程退出与交付、审查结论分别记录。';
 if(job.process_may_be_running!==true&&job.process_end_evidence==='user_attested')return '原调用结束由用户补充核实并记录。';
 if(!job.recovery_required&&job.process_may_be_running!==true)return null;
 if(!['failed','interrupted'].includes(job.status)&&!job.recovery_required)return null;
 return Number.isSafeInteger(job.process_pid)&&job.process_pid>0?`已记录客户端进程编号 ${job.process_pid}，系统尚未核实其退出。可等待原进程结束；具体核验结果保留在调用记录中。`:'该遗留调用未记录可核验的进程编号，工作台无法据此确认退出；可从原客户端核对实际状态后补充记录。';
}
export function reviewSourceLabel(review:Row){
 if(review.source==='native_client_output')return review.evidence_level==='stored_launched_client_final_output'?'客户端原生输出已补登记：':'客户端原生回传：';
 return ({grok_session_import:'Grok 会话已核验：',reviewer_submission:'审查者已回传：',user_imported_review:'已导入审查回执：'} as Record<string,string>)[review.source]||'手工登记：';
}

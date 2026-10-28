type Row=Record<string,any>;
const removed=new Set(['cancelled','superseded','revoked']);
export function reviewMemberState(member:Row,task:Row={}){
 const id=member.review_id||member.id;
 const fallback=task.automation?.role==='review'&&task.automation.review_id===id&&(!task.automation.run_id||task.automation.run_id===task.current_run_id)?task.automation:null;
 const call=Object.hasOwn(member,'invocation')?member.invocation:fallback;
 const report=member.report&&!member.report.revoked_at?member.report:null;
 if(member.status==='completed'&&(report||member.result_id))return {state:'reported',label:report?.verdict==='passed'?'已回报 · 通过':report?.verdict==='changes_requested'?'已回报 · 需修改':'已回报',tone:report?.verdict==='changes_requested'?'problem':'done',call};
 if(call?.process_may_be_running===true&&['failed','interrupted'].includes(call.status))return {state:'waiting',label:'调用状态待核对',tone:'you',call};
 if(call&&['failed','interrupted','completed'].includes(call.status))return {state:'waiting',label:'待继续 · 尚未回报',tone:'you',call};
 if(call&&['queued','launching'].includes(call.status))return {state:'starting',label:'等待调用',tone:'review',call};
 if(member.status==='running')return {state:'running',label:'审查中',tone:'review',call};
 if(call?.status==='running')return {state:'starting',label:'正在调用',tone:'review',call};
 return {state:'pending',label:'已安排 · 待接单',tone:'quiet',call};
}
export function reviewProgress(task:Row,summary?:Row){
 const source:Row[]=summary?.members||task.review_members||task.active_reviewers||[];
 const members:Row[]=source.filter(m=>!removed.has(m.status)).map(m=>({...m,...reviewMemberState(m,task)}));
 const legacyCompleted=!summary?.members&&!task.review_members?task.review_report_counts?.completed||0:0;
 const total=members.length+legacyCompleted,reported=members.filter(m=>m.state==='reported').length+legacyCompleted,running=members.filter(m=>m.state==='running').length,starting=members.filter(m=>m.state==='starting').length,waiting=members.filter(m=>m.state==='waiting').length,pending=members.filter(m=>m.state==='pending').length;
 const count=`已回报 ${reported}/${total}`;
 return {members,total,reported,running,starting,waiting,pending,count,headline:running?`${running} 位审查中 · ${count}`:starting?`正在调用审查者 · ${count}`:waiting?`审查待继续 · ${count}`:pending?`审查已安排 · ${count}`:total?`审查报告已回齐 · ${count}`:'尚未安排审查'};
}

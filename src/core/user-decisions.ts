import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,id,now,hash} from './security.ts';
import {assertCloseoutComplete,reviewableStates} from './closeout.ts';
import {userAcceptanceItems} from './acceptance.ts';
import {rejectAcceptance} from './acceptance-feedback.ts';
import {exportReviewOrder} from './review-workflow.ts';
import {getReviewContext,revokeReview} from './review-evidence.ts';
import {canReview,sameAgent,assertReviewerResources} from './reviewer-resources.ts';

export type DecisionAction='accept'|'reject'|'assign'|'revoke';
const titles:Record<DecisionAction,string>={accept:'确认验收通过',reject:'确认退回修改',assign:'确认重新安排审查',revoke:'确认撤回审查'};
function binding(wb:Workbench,t:Row){
  const rows=(table:string)=>wb.all(table).filter(x=>x.run_id===t.current_run_id).sort((a,b)=>a.id.localeCompare(b.id));
  return hash(JSON.stringify({task:t,run:wb.get('runs',t.current_run_id),reviews:rows('reviews'),artifacts:rows('artifacts'),assignments:rows('review_assignments')}));
}
export function decisionView(wb:Workbench,d:Row):Row{
  if(d.status!=='pending')return d;
  if(Date.parse(d.expires_at)<=Date.now())return {...d,status:'expired'};
  const t=wb.get('tasks',d.task_id);
  return binding(wb,t)===d.binding?d:{...d,status:'stale'};
}
export function decisionReceipt(wb:Workbench,d:Row){
  const current=decisionView(wb,d);
  return {request_id:d.request_id,status:current.status==='pending'?'awaiting_user_confirmation':current.status,
    result:{decision_id:d.id,decision:current,next:current.status==='pending'?'请用户在工作台“今天”确认已填好的事项；Agent 请勿代点。':undefined,...(d.outcome?{outcome:d.outcome}:{})}};
}
function save(wb:Workbench,d:Row){
  wb.put('user_decisions',d);
  const call=wb.maybe('management_calls',d.request_id);
  if(call)wb.put('management_calls',{...call,status:d.status==='pending'?'awaiting_user_confirmation':d.status,result:decisionReceipt(wb,d),decision_id:d.id});
}

/** Called only with parsed management arguments; no task/review mutations here. */
export function prepareDecision(wb:Workbench,action:DecisionAction,v:Row){
  const context=wb.managementContext.getStore();assert(context,'缺少管理请求上下文');
  const runId=action==='assign'?v.data.run_id:v.run_id,r=wb.get('runs',runId),t=wb.get('tasks',r.task_id);
  const revision=action==='assign'?v.data.expected_revision:v.revision;
  assert(!v.task_id||v.task_id===t.id,'任务与执行不匹配',409);
  assert(t.current_run_id===r.id&&t.revision===revision,'任务已变化，请重新读取后准备确认',409);
  assert(!['accepted','cancelled','rework_linked'].includes(t.status),'任务已结束',409);
  let details:string[]=[],checks:string[]=[];
  if(action==='accept'){
    assertCloseoutComplete(wb,t,r);checks=userAcceptanceItems(t);details=['执行者已完成收尾。请按实际试用确认以下使用结果；审查情况另行记录。'];
  }else if(action==='reject'){
    assert(['submitted','in_review','awaiting_confirmation'].includes(t.status)&&r.status==='submitted','当前任务不在试用确认阶段',409);
    const hashes=wb.all('artifacts').filter(a=>a.run_id===r.id&&a.current).map(a=>a.sha256).sort();
    assert(JSON.stringify([...v.artifact_hashes].sort())===JSON.stringify(hashes),'产物版本已变化，请重新读取',409);
    details=[v.note];
    if(v.followup_task_id)details.push('交给后续任务：'+wb.get('tasks',v.followup_task_id).title);
  }else if(action==='assign'){
    getReviewContext(wb,r.id);const candidate=wb.get('agents',v.data.reviewer_id);
    assert(!sameAgent(candidate,wb.get('agents',r.agent_id))&&canReview(candidate,t.work_kind),'请选择具备相关能力的独立审查者',403);
    wb.eligible(candidate.id);assertReviewerResources(wb,candidate.id);
    details=['审查者：'+candidate.name,v.data.reason,'确认后，现有结论保留为历史，并重新安排独立审查。'];
  }else{
    const review=wb.get('reviews',v.review_id);
    assert(review.run_id===r.id&&!review.revoked_at&&reviewableStates.includes(t.status),'这条审查当前无法撤回',409);
    details=['撤回 '+wb.get('agents',review.reviewer_id).name+' 的'+(review.verdict==='passed'?'通过结论':'修改要求'),v.reason];
  }
  return wb.transaction(()=>{
    // One active card per task. Replacing a proposal never changes its task or review.
    for(const old of wb.all('user_decisions').filter(d=>d.task_id===t.id&&d.status==='pending'))save(wb,{...old,status:'superseded',ended_at:now()});
    const d:Row={id:id('UD'),request_id:context.request_id,task_id:t.id,run_id:r.id,project_id:t.project_id,revision:t.revision,
      action,payload:v,title:titles[action],task_title:t.title,details,checks,user_instruction:context.user_instruction,binding:binding(wb,t),
      status:'pending',created_at:now(),expires_at:new Date(Date.now()+30*60*1000).toISOString()};
    wb.put('user_decisions',d);wb.audit('manager','prepare_user_decision',d.id,{task_id:t.id,action});return decisionReceipt(wb,d);
  });
}

/** Only wired to session + CSRF page routes. Never exposed as an MCP tool. */
export function resolveDecision(wb:Workbench,decisionId:string,choice:'confirm'|'cancel'){
  assert(!wb.managementContext.getStore(),'管理连接只能准备确认事项',403);
  return wb.transaction(()=>{
    const d=wb.get('user_decisions',decisionId);
    if(d.status==='confirmed'&&choice==='confirm'||d.status==='cancelled'&&choice==='cancel')return decisionReceipt(wb,d);
    assert(d.status==='pending','确认事项已处理，请刷新查看',409);
    if(choice==='cancel'){save(wb,{...d,status:'cancelled',ended_at:now()});wb.audit('user','cancel_user_decision',d.id,{task_id:d.task_id});return decisionReceipt(wb,wb.get('user_decisions',d.id))}
    assert(decisionView(wb,d).status==='pending','确认事项已过期或任务已变化，请让 Agent 重新准备',409);
    const v=d.payload;let outcome:unknown;
    if(d.action==='accept')outcome=wb.accept(d.task_id,{revision:d.revision,mode:'user_experience',user_checks:d.checks.map(()=>true)});
    else if(d.action==='reject'){const {action:_,task_id,...data}=v;outcome=rejectAcceptance(wb,d.task_id,data)}
    else if(d.action==='assign')outcome=exportReviewOrder(wb,v.data,{role:'user'});
    else {const {action:_,review_id,...data}=v;outcome=revokeReview(wb,review_id,data)}
    const confirmed={...d,status:'confirmed',confirmed_at:now(),outcome};save(wb,confirmed);
    wb.audit('user','confirm_user_decision',d.id,{task_id:d.task_id,run_id:d.run_id,request_id:d.request_id,action:d.action,user_instruction:d.user_instruction});
    return decisionReceipt(wb,confirmed);
  });
}

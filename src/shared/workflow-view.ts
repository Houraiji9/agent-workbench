import {waitingForDependencies} from './execution-order.js';
import {reviewProgress} from './review-progress.js';
type Row=Record<string,any>;
export type ActionGroup='answer'|'decision'|'trial'|'arrange'|'working'|'waiting'|'done';
export const actionGroups:Record<ActionGroup,string>={answer:'待回答',decision:'待决定',trial:'待试用',arrange:'待安排',working:'正在处理',waiting:'等待前序',done:'已结束'};
/** Display the reviewer's actual receipt without rewriting the task lifecycle. */
export const hasSameSessionContinuation=(t:Row):boolean=>!!t.same_session_continuation?.run_id&&t.same_session_continuation.run_id===t.current_run_id&&t.same_session_continuation.agent_id===t.agent_id&&['ready','awaiting_dispatch','dispatched','changes_requested','awaiting_closeout'].includes(t.status);
export function taskDisplayStatus(t:Row):string{
 if(hasSameSessionContinuation(t)&&taskAction(t).owner==='agent'&&t.status!=='awaiting_closeout')return 'continuation_pending';
 if(['submitted','in_review'].includes(t.status)){
  if(t.review_stage==='awaiting_decision')return t.review_can_proceed?'review_ready_closeout':'review_decision';
  if(t.review_stage!=='completed'){
   const p=reviewProgress(t);if(p.running||p.starting)return 'review_running';if(p.waiting)return 'review_waiting';if(p.pending)return 'review_arranged';
   if(!p.total&&t.review_stage==='running')return 'review_running';
  }
 }
 return t.status;
}
export function taskAction(t:Row):{group:ActionGroup;owner:'user'|'agent'|'reviewer'|'none';label:string}{
  if(['accepted','cancelled','rework_linked'].includes(t.status))return {group:'done',owner:'none',label:'已结束'};
  if(waitingForDependencies(t))return {group:'waiting',owner:'none',label:'等待前序'};
  if(t.pending_user_decision&&Date.parse(t.pending_user_decision.expires_at)>Date.now())return {group:'decision',owner:'user',label:'确认事项'};
  if(['waiting_input','closeout_waiting_input'].includes(t.status))return t.question_answered?{group:'arrange',owner:'user',label:'答复已保存，继续原会话'}:{group:'answer',owner:'user',label:'去回答'};
  // A returned review can advance the Run even when its earlier client call was interrupted.
  // Keep that call's history, but use the current lifecycle once its process is confirmed gone.
  const completedReviewCall=t.review_stage==='completed'&&t.automation?.role==='review'
    &&t.automation.run_id===t.current_run_id&&!!t.current_run_id
    &&t.automation.process_may_be_running===false&&!t.automation.recovery_required
    &&['awaiting_closeout','closing','closeout_blocked','closeout_waiting_input','awaiting_confirmation'].includes(t.status);
  if(['submitted','in_review'].includes(t.status)&&t.review_stage==='awaiting_decision'&&t.review_can_proceed)return {group:'arrange',owner:'user',label:'审查已通过，可交回执行者收尾'};
  if(['submitted','in_review'].includes(t.status)&&t.review_stage==='awaiting_decision')return {group:'decision',owner:'user',label:'审查报告已齐，待负责人决定'};
  if(['submitted','in_review'].includes(t.status)&&t.review_stage!=='awaiting_decision'&&t.review_stage!=='completed'){
    const progress=reviewProgress(t),copy=reviewHandoffCopy(t);
    if(progress.total)return {group:copy.holder==='you'?'arrange':'working',owner:copy.holder==='you'?'user':'reviewer',label:copy.headline};
    if(t.automation?.role==='review'&&['failed','interrupted'].includes(t.automation.status)&&!t.automation.superseded)return {group:'arrange',owner:'user',label:'审查待继续，尚未收到报告'};
  }
  if(t.automation?.role!=='review'&&t.automation&&!completedReviewCall&&(!t.automation.superseded||t.automation.recovery_required||t.automation.process_may_be_running===true)&&['failed','interrupted'].includes(t.automation.status))return {group:'decision',owner:'user',label:'处理客户端调用阻碍'};
  if(t.automation&&(t.automation.role!=='review'||['submitted','in_review'].includes(t.status))&&['queued','launching','running'].includes(t.automation.status))return {group:'working',owner:t.automation.role==='review'?'reviewer':'agent',label:t.automation.role==='review'?(t.review_stage==='running'?'独立审查中':'正在调用审查者'):'客户端正在处理'};
  if(['blocked','failed','closeout_blocked'].includes(t.status))return {group:'decision',owner:'user',label:'处理阻碍'};
  if(t.status==='awaiting_confirmation')return t.delivery_target==='runtime'&&!t.deployment?.verified?{group:'working',owner:'agent',label:'等待本机更新'}:{group:'trial',owner:'user',label:'去试用'};
  if(t.status==='in_review'&&t.review_stage==='running')return {group:'working',owner:'reviewer',label:'独立审查中'};
  if(t.status==='submitted'&&t.reviewer_id===null&&t.review_policy?.mode==='not_requested')return {group:'arrange',owner:'user',label:'继续收尾'};
  if(t.status==='submitted'&&(t.active_reviewers||[]).some((m:Row)=>m.status==='awaiting_dispatch')){const review=reviewHandoffCopy(t);return {group:review.holder==='you'?'arrange':'working',owner:review.holder==='you'?'user':'agent',label:review.headline};}
  if(t.status==='submitted')return t.review_stage==='running'?{group:'working',owner:'reviewer',label:'独立审查中'}:t.review_delivery==='agent'?{group:'working',owner:'agent',label:'安排审查中'}:{group:'arrange',owner:'user',label:'交给审查者'};
  if(hasSameSessionContinuation(t))return {group:'working',owner:'agent',label:t.status==='awaiting_closeout'?'原执行者继续收尾':'原执行者继续返修，等待接单'};
  if(['in_review','awaiting_closeout'].includes(t.status))return t.closeout_delivery==='agent'?{group:'working',owner:'agent',label:'执行者继续收尾'}:{group:'arrange',owner:'user',label:'继续原会话'};
  if(t.status==='changes_requested'&&t.automation_policy?.auto_rework)return {group:'working',owner:'agent',label:'原执行者继续返修'};
  if(['ready','awaiting_dispatch','changes_requested','acceptance_rejected'].includes(t.status))return {group:'arrange',owner:'user',label:['changes_requested','acceptance_rejected'].includes(t.status)?'继续返修':'交给执行者'};
  return {group:'working',owner:'agent',label:t.status==='dispatched'?'等待接单':t.status==='closing'?'正在收尾':'正在执行'};
}
export function briefTask(t:Row){const e=t.execution;return {id:t.id,title:t.title,status:t.status,project_id:t.project_id,agent_id:t.agent_id,reviewer_id:t.reviewer_id,version:t.version,revision:t.revision,current_run_id:t.current_run_id,goal_preview:String(t.goal||'').slice(0,200),dependencies:t.dependencies||[],execution:e?{step:e.step,plan_position:e.plan_position,queue_position:e.queue_position,dependencies_ready:e.dependencies_ready,dependencies:(e.dependencies||[]).map((d:Row)=>({id:d.id,effective_id:d.effective_id,status:d.status,satisfied:d.satisfied,invalid:d.invalid})),active_work_count:e.active_work?.length||0}:undefined,action:taskAction(t),importance:t.importance||'normal',delivery_profile:t.delivery_profile||null,delivery_target:t.delivery_target||'source',deployment:t.deployment||null};}
export type GraphNode={id:string;label:string;kind:string;status?:string;task_id?:string;session_id?:string;agent?:string};
export type GraphEdge={from:string;to:string;kind:string;label:string};
export function relationshipGraph(tasks:Row[],runs:Row[],reviews:Row[],sessions:Row[],projectId:string,view='tasks',includeHistory=true){
  const all=tasks.filter(t=>t.project_id===projectId),shown=all.filter(t=>includeHistory||!['accepted','cancelled','rework_linked'].includes(t.status));
  const nodes:GraphNode[]=shown.map(t=>({id:t.id,label:t.title,kind:'task',status:taskDisplayStatus(t),task_id:t.id,agent:t.agent_id})),edges:GraphEdge[]=[];
  const ids=new Set(shown.map(t=>t.id));let hiddenEdges=0;
  const edge=(from:string,to:string,kind:string,label:string)=>{if(nodes.some(n=>n.id===from)&&nodes.some(n=>n.id===to))edges.push({from,to,kind,label});else hiddenEdges++;};
  for(const t of shown){for(const d of t.dependencies||[])edge(d,t.id,'dependency','前置');if(t.rework_task_id)edge(t.id,t.rework_task_id,'rework','后续返工');}
  if(view==='execution'){
    const relevant=runs.filter(r=>ids.has(r.task_id));
    for(const r of relevant)nodes.push({id:r.id,label:'执行 '+r.id.slice(0,10),kind:'run',status:r.status,task_id:r.task_id,agent:r.agent_id});
    for(const r of relevant){edge(r.task_id,r.id,'execution','执行');if(r.retry_context?.previous_run_id)edge(r.retry_context.previous_run_id,r.id,'rework','返修');}
    for(const review of reviews.filter(v=>!v.revoked_at&&relevant.some(r=>r.id===v.run_id))){const r=relevant.find(r=>r.id===review.run_id)!;nodes.push({id:review.id,label:review.verdict==='passed'?'审查通过':'审查要求修改',kind:'review',status:review.verdict,task_id:r.task_id,agent:review.reviewer_id});edge(r.id,review.id,'review','独立审查');for(const next of relevant.filter(n=>n.retry_context?.previous_run_id===r.id))edge(review.id,next.id,'rework','修改意见');}
  }
  if(view==='sessions')for(const s of sessions){const bound=(s.bindings||[]).filter((b:Row)=>b.project_id===projectId&&ids.has(b.task_id));const legacy=runs.filter(r=>(s.run_ids||[s.run_id]).includes(r.id)&&ids.has(r.task_id));if(!bound.length&&!legacy.length&&!((s.project_ids||[s.project_id]).includes(projectId)))continue;nodes.push({id:s.id,label:String(s.title||s.agent||'会话').slice(0,45),kind:'session',session_id:s.id,agent:s.agent});for(const tid of new Set([...bound.map((b:Row)=>b.task_id),...legacy.map(r=>r.task_id)]))edge(s.id,tid as string,'session','会话关联');}
  return {project_id:projectId,view,nodes,edges,total_tasks:all.length,shown_tasks:shown.length,hidden_tasks:all.length-shown.length,hidden_edges:hiddenEdges,source:'workbench_records',snapshot:false};
}
export function layoutRelationships(nodes:GraphNode[],edges:GraphEdge[]){
  if(!edges.length){const placed=nodes.map((n,i)=>({...n,x:24+(i%3)*310,y:24+Math.floor(i/3)*110}));return {nodes:placed,width:Math.max(600,...placed.map(n=>n.x+270)),height:Math.max(250,...placed.map(n=>n.y+95)),cycle_nodes:[] as string[]};}
  const ranks=new Map(nodes.map(n=>[n.id,0])),degree=new Map(nodes.map(n=>[n.id,0]));for(const e of edges)degree.set(e.to,(degree.get(e.to)||0)+1);
  const queue=nodes.filter(n=>degree.get(n.id)===0).map(n=>n.id),visited=new Set<string>();
  for(let i=0;i<queue.length;i++){const id=queue[i];visited.add(id);for(const e of edges.filter(e=>e.from===id)){ranks.set(e.to,Math.max(ranks.get(e.to)||0,(ranks.get(id)||0)+1));degree.set(e.to,(degree.get(e.to)||0)-1);if(degree.get(e.to)===0)queue.push(e.to);}}
  const levels=new Map<number,number>();const placed=nodes.map(n=>{const rank=ranks.get(n.id)||0,index=levels.get(rank)||0;levels.set(rank,index+1);return {...n,x:24+rank*310,y:24+index*110};});
  return {nodes:placed,width:Math.max(600,...placed.map(n=>n.x+270)),height:Math.max(250,...placed.map(n=>n.y+95)),cycle_nodes:nodes.filter(n=>!visited.has(n.id)).map(n=>n.id)};
}

/** Read only recorded review work; pending orders and returned reports are separate facts. */
export function reviewHandoffCopy(t:Row,summary?:Row){
 const progress=reviewProgress(t,summary);
 if(progress.total){
  const holder=progress.running||progress.starting?'reviewer':progress.waiting||progress.members.some(m=>m.state==='pending'&&m.delivery_mode!=='agent')?'you':'agent';
  return {headline:progress.headline,next:progress.waiting?'尚未回报的成员可继续原会话或手动交接；其他成员的审查与报告各自保留':progress.running||progress.starting?'各审查者并行处理，报告分别收录':progress.reported===progress.total?'查看各方意见，由负责人决定下一步':holder==='you'?'将审查单交给尚未接单的成员':'等待已安排的调用接单',holder,arranged:true};
 }
 const members=summary?.members||t.active_reviewers||[],pending=members.filter((m:Row)=>m.status==='awaiting_dispatch'),running=members.filter((m:Row)=>m.status==='running');
 const reported=summary?.counts?.completed??t.review_report_counts?.completed??0;
 if(running.length||t.review_stage==='running')return {headline:reported?'部分审查已回报，其余仍在审查':'独立审查正在进行',next:'等待尚未完成的审查者回传报告，再由负责人决定下一步',holder:'reviewer',arranged:true};
 if(pending.length){const manual=pending.some((m:Row)=>m.delivery_mode==='manual');return {headline:reported?'部分审查已回报，其余已安排待接单':'独立审查已安排，等待接单',next:manual?'请将已准备的审查单交给尚未接单的审查者':'等待客户端调用已安排的审查者，接单后更新进度',holder:manual?'you':'agent',arranged:true};}
 return {headline:'成果已交付，尚未安排独立审查',next:'请安排独立审查者，再交接审查单',holder:'you',arranged:false};
}
export function leadContinuedReview(t:Row){return !!(t.review_closeout_decision_id||t.closeout?.review_decision_id||t.review_decision?.decision==='continue');}

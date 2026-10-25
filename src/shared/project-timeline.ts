import {planningOriginLabel} from './planning-origin.ts';
type Row=Record<string,any>;
export type TimelineInput={project_id:string;tasks:Row[];requests?:Row[];plans?:Row[];runs?:Row[];reviews?:Row[];review_assignments?:Row[];jobs?:Row[];sessions?:Row[];artifacts?:Row[];events?:Row[];delegations?:Row[];include_history?:boolean};
export type TimelineNode={id:string;record_id:string;kind:string;label:string;status?:string;task_id?:string;agent?:string;occurred_at?:string;sha256?:string;source?:string;control_level?:string;artifact_paths?:string[];actual_model?:string|null;requested_model?:string|null;reported_model?:string|null;planning_channel?:string};
export type TimelineEdge={from:string;to:string;kind:string;label:string};
const list=(value:unknown):string[]=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v):[];
const nodeId=(kind:string,id:string)=>kind+':'+id;
/** Relations are recorded IDs only. Titles and timestamps never infer ownership or acceptance. */
export function projectTimelineGraph(input:TimelineInput){
  const allTasks=input.tasks.filter(t=>t.project_id===input.project_id),tasks=allTasks.filter(t=>input.include_history!==false||!['accepted','cancelled','rework_linked'].includes(t.status));
  const tids=new Set(tasks.map(t=>t.id)),runs=(input.runs||[]).filter(r=>tids.has(r.task_id)),rids=new Set(runs.map(r=>r.id));
  const assignments=(input.review_assignments||[]).filter(r=>rids.has(r.run_id)),aids=new Set(assignments.map(a=>a.id));
  const reviews=(input.reviews||[]).filter(r=>rids.has(r.run_id)),artifacts=(input.artifacts||[]).filter(a=>rids.has(a.run_id));
  const jobs=(input.jobs||[]).filter(j=>tids.has(j.task_id)||rids.has(j.run_id)||aids.has(j.review_assignment_id)||(!j.task_id&&!j.run_id&&!j.review_assignment_id&&j.project_id===input.project_id));
  const sessions=(input.sessions||[]).filter(s=>(s.project_ids||[s.project_id]).includes(input.project_id)||(s.bindings||[]).some((b:Row)=>b.project_id===input.project_id||tids.has(b.task_id)||rids.has(b.run_id))||[s.run_id,...list(s.run_ids)].some(id=>rids.has(id))||jobs.some(j=>j.session_id===s.id||j.workbench_session_id===s.id));
  const nodes:TimelineNode[]=[],edges:TimelineEdge[]=[],unresolved:TimelineEdge[]=[],nodeKeys=new Set<string>(),edgeKeys=new Set<string>();
  const add=(kind:string,row:Row,label:string,agent?:string)=>{const id=nodeId(kind,row.id);if(nodeKeys.has(id))return;nodeKeys.add(id);nodes.push({id,record_id:row.id,kind,label,status:row.status||row.verdict,task_id:row.task_id,agent,occurred_at:row.occurred_at||row.created_at||row.started_at,sha256:row.sha256,actual_model:row.actual_model||null,requested_model:row.requested_model||null});};
  const edge=(fromKind:string,from:string,toKind:string,to:string,kind:string,label:string)=>{if(typeof from!=='string'||!from||typeof to!=='string'||!to)return;const value={from:nodeId(fromKind,from),to:nodeId(toKind,to),kind,label},key=JSON.stringify(value);if(edgeKeys.has(key))return;edgeKeys.add(key);(nodeKeys.has(value.from)&&nodeKeys.has(value.to)?edges:unresolved).push(value);};
  const requests=(input.requests||[]).filter(q=>q.project_id===input.project_id&&(input.include_history!==false||q.status!=='planned'||tasks.some(t=>t.request_id===q.id)));
  const qids=new Set(requests.map(q=>q.id)),plans=(input.plans||[]).filter(p=>qids.has(p.request_id));
  for(const q of requests)add('request',q,String(q.text||q.id));
  for(const p of plans){add('plan',p,'已登记计划 · '+planningOriginLabel(p));const node=nodes.find(n=>n.id===nodeId('plan',p.id))!;node.source=p.planning_origin?'planner_reported':'unknown';node.reported_model=p.planning_origin?.reported_model||null;node.planning_channel=p.planning_origin?.channel;}
  for(const t of tasks){add('task',t,String(t.title||t.id),t.agent_id);if(t.acceptance_record?.confirmed_at)add('acceptance',{id:t.id+'/'+t.acceptance_record.run_id,task_id:t.id,status:'accepted',occurred_at:t.acceptance_record.confirmed_at},'用户已验收','user');}
  for(const r of runs)add('run',r,'执行 '+r.id,r.agent_id);
  for(const a of assignments)add('review_assignment',a,'审查调用 '+a.id,a.reviewer_id);
  for(const r of reviews)add('review',r,r.revoked_at?'已撤销审查':r.verdict==='passed'?'审查通过':'审查要求修改',r.reviewer_id);
  for(const j of jobs)add('job',j,(j.role==='review'?'审查调用 ':j.role==='closeout'?'收尾调用 ':'客户端调用 ')+j.id,j.agent_id);
  for(const s of sessions)add('session',s,String(s.title||s.id),s.agent_id||s.agent);
  for(const a of artifacts)add('artifact',a,String(a.label||a.id));
  const delegations=(input.delegations||[]).filter(d=>rids.has(d.run_id));
  for(const d of delegations){add('delegation',d,String(d.goal||d.id));const node=nodes.find(n=>n.id===nodeId('delegation',d.id))!;node.source='executor_reported';node.control_level=d.control_level||'instructions_only';node.artifact_paths=list(d.artifacts);node.actual_model=d.actual_model||null;node.requested_model=d.requested_model||null;}
  for(const r of runs)if(r.closeout?.id)add('closeout',{...r.closeout,task_id:r.task_id},'执行者收尾',r.agent_id);
  const relevantEvents=(input.events||[]).filter(e=>rids.has(e.run_id)&&e.disposition==='applied'&&String(e.event_type).startsWith('closeout_'));
  for(const e of relevantEvents)add('closeout_event',{...e,status:e.event_type},String(e.event_type),e.data?.identity);
  for(const p of plans){edge('request',p.request_id,'plan',p.id,'planning','模型提交的计划');for(const tid of list(p.task_ids))edge('plan',p.id,'task',tid,'planned_task','计划任务');}
  for(const t of tasks){if(t.request_id&&!plans.some(p=>list(p.task_ids).includes(t.id)))edge('request',t.request_id,'task',t.id,'request_task','需求关联');for(const dependency of list(t.dependencies))edge('task',dependency,'task',t.id,'dependency','前置任务');if(t.rework_task_id)edge('task',t.id,'task',t.rework_task_id,'rework','后续返工');if(t.acceptance_record?.confirmed_at)edge('run',t.acceptance_record.run_id,'acceptance',t.id+'/'+t.acceptance_record.run_id,'user_acceptance','用户实际确认');}
  for(const r of runs){edge('task',r.task_id,'run',r.id,'execution','执行');if(r.retry_context?.previous_run_id)edge('run',r.retry_context.previous_run_id,'run',r.id,'retry','续接返修');if(r.closeout?.id){edge('run',r.id,'closeout',r.closeout.id,'closeout','执行者收尾');for(const hash of list(r.closeout.artifact_hashes))for(const a of artifacts.filter(a=>a.run_id===r.id&&a.sha256===hash))edge('artifact',a.id,'closeout',r.closeout.id,'closeout_artifact','收尾绑定产物');}}
  for(const a of assignments)edge('run',a.run_id,'review_assignment',a.id,'review_assignment','安排独立审查');
  for(const r of reviews){edge('run',r.run_id,'review',r.id,'review','审查回执');for(const hash of list(r.artifact_hashes))for(const a of artifacts.filter(a=>a.run_id===r.run_id&&a.sha256===hash))edge('artifact',a.id,'review',r.id,'review_artifact','审查绑定版本');}
  for(const a of artifacts)edge('run',a.run_id,'artifact',a.id,'artifact','归档产物');
  for(const d of delegations){edge('run',d.run_id,'delegation',d.id,'delegation','执行者报告的委派');if(d.parent_id)edge('delegation',d.parent_id,'delegation',d.id,'parent_child','报告的父子委派');if(d.session_id)edge('delegation',d.id,'session',d.session_id,'delegation_session','报告的会话编号');}
  for(const j of jobs){if(j.run_id)edge('run',j.run_id,'job',j.id,'job','客户端调用');else if(j.task_id)edge('task',j.task_id,'job',j.id,'job','客户端调用');if(j.review_assignment_id)edge('review_assignment',j.review_assignment_id,'job',j.id,'review_job','审查客户端');if(j.closeout_id)edge('closeout',j.closeout_id,'job',j.id,'closeout_job','收尾客户端');if(j.parent_job_id)edge('job',j.parent_job_id,'job',j.id,'parent_child','父子调用');if(j.session_id||j.workbench_session_id)edge('job',j.id,'session',j.workbench_session_id||j.session_id,'job_session','调用会话');}
  for(const s of sessions){for(const rid of new Set([s.run_id,...list(s.run_ids)].filter(Boolean)))edge('session',s.id,'run',rid,'session_run','会话关联');for(const b of s.bindings||[]){if(b.project_id&&b.project_id!==input.project_id)continue;if(b.run_id)edge('session',s.id,'run',b.run_id,'session_run','会话关联');else if(b.task_id)edge('session',s.id,'task',b.task_id,'session_task','会话关联');}if(s.parent_session_id)edge('session',s.parent_session_id,'session',s.id,'parent_child','父子会话');}
  for(const e of relevantEvents){const cid=e.data?.closeout_id||e.closeout_id;if(cid)edge('closeout',cid,'closeout_event',e.id,'closeout_receipt','收尾回执');else edge('run',e.run_id,'closeout_event',e.id,'closeout_receipt','收尾回执');}
  return {project_id:input.project_id,view:'timeline',nodes,edges,unresolved,hidden_tasks:allTasks.length-tasks.length,source:'workbench_records',snapshot:false,note:'只展示显式编号关系；审查撤销、历史执行和未解析关系保留原状态。'};
}

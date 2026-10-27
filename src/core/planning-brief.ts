import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {compactPlanningSummary,planningProjectSummary} from './planning-project-summary.ts';
import {preview} from './workflow-guidance.ts';

const newest=(a:Row,b:Row)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||''))||String(a.id).localeCompare(String(b.id));
export function historySummary(r:Row){return {id:r.id,kind:r.kind,project_id:r.project_id,project_ids:r.project_ids,title:preview(r.title||'',120),status:r.status,agent:r.agent||r.agent_id,source_label:r.source_label,native_id:r.native_id,updated_at:r.updated_at||r.created_at||null,
  summary:preview(r.goal||r.summary||'',240),full_ref:r.kind==='task'?{tool:'get_task_detail',arguments:{task_id:r.id}}:{tool:'get_session_messages',arguments:{session_id:r.id}}};}
export function planningProjectBrief(wb:Workbench,p:Row):Row{
  const summary=compactPlanningSummary(planningProjectSummary(wb,p.id));
  const requests=wb.all('requests').filter(q=>q.project_id===p.id).sort(newest);
  const current=requests.filter(q=>q.status==='awaiting_planning').slice(0,3);
  return {detail:'brief',project:{id:p.id,name:p.name,version:p.version,paths:p.paths,source_root:p.source_root,runtime_root:p.runtime_root,delivery_target:p.delivery_target,delivery_profile:p.delivery_profile||null,goal_preview:preview(p.goal||'',350),stage:preview(p.stage||'',120),next_step:preview(p.next_step||'',240)},
    project_summary:summary,tasks:summary.tasks,requests:current.map(q=>({id:q.id,version:q.version,status:q.status,text_preview:preview(q.text,240)})),
    counts:{tasks:summary.counts.total,requests:requests.length},omitted:{tasks:summary.omitted_tasks,requests:requests.length-current.length},
    references:{history:{tool:'search_execution_history',arguments:{project_id:p.id,limit:5}},memories:{tool:'get_project_memories',arguments:{project_id:p.id}},full:{tool:'get_project_context',arguments:{project_id:p.id,detail:'full'}}},
    guidance:'先用当前摘要定位本轮关联任务；历史、经验和文件只按问题检索，不遍历工程或重读全部会话。'};
}

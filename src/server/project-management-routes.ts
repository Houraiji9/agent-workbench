import type {FastifyInstance} from 'fastify';
import fs from 'node:fs';import path from 'node:path';
import {z} from 'zod';
import type {Workbench} from '../core/workbench.ts';
import type {Row} from '../core/schema.ts';
import {assert,readBounded} from '../core/security.ts';
import {projectHold} from '../core/project-hold.ts';
import {saveProjectPolicy,saveTaskPolicy,taskPolicyInput} from '../core/workflow-policy.ts';
import {changeTaskArrangement} from '../core/task-arrangement.ts';
import {chatPlanningContext,chatPlanningCopy,previewChatPlan,parseChatPlan} from '../core/chat-planning.ts';
import {scanProjectFiles,saveProjectFile,projectFilePath,moveProjectFiles,restoreProjectFile} from '../core/project-files.ts';
import {nativeFileOperations} from '../core/project-native-files.ts';
import {aggregateProjectUsage,withLegacyJobUsage,type UsageEvent,type UsageJob} from '../core/project-usage.ts';
import {projectTokenMonitorUsage} from '../core/token-monitor-usage.ts';
import {projectTimelineGraph} from '../shared/project-timeline.ts';
import {revealFile} from '../core/artifact-folders.ts';
export function projectInsights(wb:Workbench,pid:string,query:unknown={}){
  wb.roots(wb.get('projects',pid));const q=z.object({agent_id:z.string().optional(),model:z.string().optional(),task_id:z.string().optional(),role:z.enum(['execution','review','closeout']).optional(),from:z.string().datetime({offset:true}).optional(),to:z.string().datetime({offset:true}).optional(),history:z.enum(['true','false']).optional()}).strict().parse(query);
  const tasks=wb.executionTasks(),taskById=new Map(tasks.map(t=>[t.id,t])),runs=wb.all('runs'),assignments=wb.all('review_assignments');
  const jobs=wb.all('agent_jobs').map(j=>({...j,id:j.id,run_id:j.run_id,task_id:j.task_id,review_assignment_id:j.review_id||j.review_assignment_id,project_id:j.project_id||taskById.get(j.task_id)?.project_id,agent_id:j.agent_id||(j.role==='review'?assignments.find(a=>a.id===j.review_id)?.reviewer_id:runs.find(r=>r.id===j.run_id)?.agent_id),requested_model:j.route?.model,
    workbench_session_id:wb.all('sessions').find(s=>s.source_id===j.id)?.id}));
  // Legacy summaries are a read-only projection; any existing ledger blocks whole-job fallback.
  const ledger=withLegacyJobUsage(wb.all('usage_events') as UsageEvent[],jobs as UsageJob[]);
  return {usage:aggregateProjectUsage(ledger,jobs as UsageJob[],{project_id:pid,...q}),token_monitor:projectTokenMonitorUsage(wb.maybe('integrations','tokenMonitor'),pid,{jobs,sessions:wb.all('sessions'),projects:wb.all('projects'),agents:wb.all('agents'),delegations:wb.all('delegations').map(d=>({...d,agent_id:runs.find(r=>r.id===d.run_id)?.agent_id}))}),graph:projectTimelineGraph({project_id:pid,tasks,requests:wb.all('requests'),plans:wb.all('plans'),runs,reviews:wb.all('reviews'),review_assignments:assignments,jobs,sessions:wb.all('sessions'),artifacts:wb.all('artifacts'),events:wb.all('events'),delegations:wb.all('delegations'),include_history:q.history!=='false'}),
    unmetered_runs:runs.filter(r=>taskById.get(r.task_id)?.project_id===pid&&!jobs.some(j=>j.run_id===r.id)).length,
    budget_alerts:runs.filter(r=>taskById.get(r.task_id)?.project_id===pid&&r.execution_contract?.execution_policy?.token_budget).flatMap(r=>{const selected=jobs.filter(j=>j.run_id===r.id),total=aggregateProjectUsage(ledger.filter(e=>e.run_id===r.id),selected as UsageJob[],{project_id:pid}).subtotal.total_tokens,budget=r.execution_contract.execution_policy.token_budget;return total!==null&&total>=budget?[{run_id:r.id,task_id:r.task_id,known_tokens:total,budget,note:'已知用量达到提醒预算，当前调用没有被自动停止。'}]:[];}),
    note:'Token Monitor会话与工作台调用分别追溯，不相加。旧调用只补无ledger的合法已结束摘要；缺失、跨项目或时间区间不明保持未知。'};
}
export function registerProjectManagementRoutes(app:FastifyInstance,wb:Workbench,reveal:typeof revealFile=revealFile){
  const user={actor:'user' as const};
  const files=(pid:string)=>{wb.roots(wb.get('projects',pid));return {files:wb.all('project_files').filter(f=>f.project_id===pid),moves:wb.all('file_moves').filter(f=>f.project_id===pid),coverage:wb.get('projects',pid).file_coverage||null}};
  app.post<{Params:{id:string}}>('/api/projects/:id/hold',async req=>projectHold(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/projects/:id/execution-policy',async req=>saveProjectPolicy(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/tasks/:id/execution-policy',async req=>saveTaskPolicy(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/tasks/:id/new-policy-run',async req=>{const v=taskPolicyInput.parse(req.body),t=wb.get('tasks',req.params.id);assert(t.current_run_id&&['failed','cancelled','changes_requested','submitted'].includes(t.status),'请先结束本次执行；审查通过或待验收的交付不能在这里替换',409);assert(!wb.all('agent_jobs').some(j=>j.task_id===t.id&&(j.process_may_be_running||['queued','launching','running'].includes(j.status))),'仍有调用未结束，请核对当前进程后再生成新执行单',409);return wb.exportOrder(t.id,t.version,true,v.agent_id,v.revision,v.execution_policy.main_model||wb.get('runs',t.current_run_id).requested_model,v.execution_policy);});
  app.post<{Params:{id:string}}>('/api/tasks/:id/arrangement',async req=>changeTaskArrangement(wb,req.params.id,req.body));
  app.get<{Params:{id:string}}>('/api/requests/:id/chat-context',async req=>({copy_text:chatPlanningCopy(chatPlanningContext(wb,req.params.id))}));
  app.post('/api/plans/chat-preview',async req=>previewChatPlan(wb,req.body));
  app.post('/api/plans/chat-import',async req=>{const plan=parseChatPlan(req.body);const q=wb.get('requests',plan.request_id);assert(q.workflow_kind!=='small'||plan.tasks.length<=3,'小需求最多三项');return wb.submitPlan(plan,'chat_paste','user')});
  app.get<{Params:{id:string};Querystring:Row}>('/api/projects/:id/insights',async req=>projectInsights(wb,req.params.id,req.query));
  app.get<{Params:{id:string}}>('/api/projects/:id/files',async req=>files(req.params.id));
  app.post<{Params:{id:string}}>('/api/projects/:id/files/scan',async req=>{const result=scanProjectFiles(wb,req.params.id,user,{maxEntries:10000,maxFiles:3000,maxDepth:8,maxMilliseconds:3000});wb.transaction(()=>{const p=wb.get('projects',req.params.id);wb.put('projects',{...p,file_coverage:result.coverage})});return files(req.params.id)});
  app.post<{Params:{id:string;file:string}}>('/api/projects/:id/files/:file/classify',async req=>wb.transaction(()=>saveProjectFile(wb,req.params.id,req.params.file,user,req.body as any)));
  app.post<{Params:{id:string;file:string}}>('/api/projects/:id/files/:file/open',async req=>{const file=projectFilePath(wb,req.params.id,req.params.file,user);await reveal(file);return {opened:true}});
  app.get<{Params:{id:string;file:string}}>('/api/projects/:id/files/:file/preview',async req=>{
    const file=projectFilePath(wb,req.params.id,req.params.file,user),ext=path.extname(file).toLowerCase();
    if(!['.txt','.md','.json','.csv','.log','.html','.htm','.svg','.ts','.tsx','.js','.css','.py','.ps1'].includes(ext)||fs.statSync(file).size>512*1024)return {kind:'unavailable',reason:'此文件暂不支持内置预览，请定位到文件夹查看。'};
    const text=new TextDecoder('utf-8',{fatal:false}).decode(readBounded(file,512*1024));
    return ['.html','.htm'].includes(ext)?{kind:'html',text:`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`+text}:{kind:'text',text};
  });
  app.post<{Params:{id:string}}>('/api/projects/:id/files/move',async req=>{const v=z.object({selections:z.array(z.object({id:z.string(),sourceDeclaration:z.literal('user_created_temporary'),reason:z.string().trim().min(1).max(2000)}).strict()).min(1).max(50)}).strict().parse(req.body);const result=moveProjectFiles(wb,req.params.id,user,v.selections,nativeFileOperations);wb.emit('change');return result;});
  app.post<{Params:{id:string;move:string}}>('/api/projects/:id/files/moves/:move/restore',async req=>{const result=restoreProjectFile(wb,req.params.id,req.params.move,user,nativeFileOperations);wb.emit('change');return result;});
}

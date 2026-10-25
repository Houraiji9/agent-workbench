import fs from 'node:fs';
import {assertProjectDispatch} from './project-hold.ts';
import {runTask} from './workflow-policy.ts';
import {agentClientKind} from './agent-client-kind.ts';
import {supersededLaunch} from './manual-takeover.ts';
import {authorizeMainLaunch,assertMainLaunch,mainExecutionControl,manuallyTakenOver,type MainExecutionCaller} from './main-execution-control.ts';
export {agentClientKind};
import {createUsageEvent,recordUsageEvent,usageInputFromOutput} from './project-usage.ts';
import path from 'node:path';
import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {spawn,type ChildProcess} from 'node:child_process';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {ROOT} from './config.ts';
import {assert,id,now,hash,safePath,atomicWrite,protectedName} from './security.ts';
import {agentDispatchInput,agentJobInput,agentRouteSchema,agentControlInput,agentRecoveryInput,type AgentRoute} from './agent-route-schema.ts';
import {discoverAgentClients,readClientCapabilities,resolveAgentClient,buildAgentInvocation,createAgentOutputParser,type ParsedAgentOutput} from './agent-clients.ts';
import {exportReviewOrder,reviewAssignmentContext,reviewFeedbackOrder,startReview,submitReviewResult,reviewResultInput} from './review-workflow.ts';
import {assertReviewerResources,sameAgent} from './reviewer-resources.ts';
import {executionContext} from './execution-context.ts';
import {reviewContext,bindReviewContextSession} from './review-context.ts';
import {reviewSkipped} from './acceptance.ts';

const active=new Set(['queued','launching','running']);
const terminal=new Set(['completed','failed','interrupted']);
const sessionPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,299}$/;
export function validateAgentRoutes(wb:Workbench,task:Row){
  if(task.execution_route||task.review_route)assert(task.context_contract,'自动调用任务须提供必读/补读文件与产物目录合同，不能默认全量读取项目');
  for(const [field,agentId] of [['execution_route',task.agent_id],['review_route',task.reviewer_id]]){
    if(!task[field!])continue;
    const route=agentRouteSchema.parse(task[field!]),agent=wb.get('agents',agentId!);
    assert(agentClientKind(agent)===route.client,'客户端与指定团队成员不匹配；请由规划者选择该成员真实使用的入口');
    if(route.client==='dsh')assert(!!route.provider,'DSH 路由必须明确 provider，不能按客户端名称猜实际模型');
    if(route.client!=='dsh')assert(!route.provider,'此客户端不接受额外 provider 参数');
  }
  if(task.execution_route&&task.review_route)assert(task.execution_route.client!==task.review_route.client,'执行与独立审查不能使用同一客户端入口副本');
  if(task.automation_policy?.auto_review)assert(task.review_route&&!reviewSkipped(task),'自动审查需要规划者指定独立审查路由');
}
export function jobView(job:Row){
  return {job_id:job.id,task_id:job.task_id,run_id:job.run_id,review_id:job.review_id||null,role:job.role,phase:job.phase,client:job.route.client,
    status:job.status,reason:job.reason,session_id:job.session_id||null,session_mode:job.session_mode,requested_model:job.route.model,actual_model:job.actual_model||null,actual_model_display:job.actual_model_display||null,
    revision:job.revision,created_at:job.created_at,started_at:job.started_at||null,ended_at:job.ended_at||null,exit_code:job.exit_code??null,
    artifacts:job.files||null,usage:job.usage||null,usage_source:job.usage?'client_reported':'unknown',recovery_required:!!job.process_may_be_running&&['failed','interrupted'].includes(job.status),cancel_requested:!!job.cancel_requested_at,process_end_evidence:job.process_end_evidence||null};
}
type ProcessResult={exitCode:number|null;signal:string|null;error?:string;processStopped?:boolean;deferred?:boolean};
type LaunchOptions={command:string;args:string[];stdin?:string;env?:Record<string,string>;cwd:string;onLine:(line:string)=>void;onSpawn?:(pid:number)=>void;beforeSpawn?:()=>boolean;stdout:string;stderr:string;signal:AbortSignal};
export type Launcher=(options:LaunchOptions)=>Promise<ProcessResult>;
/** Supplied by the authenticated route or internal scheduler, never by tool arguments. */
export type ContinueCaller=MainExecutionCaller;
/** No shell, no auto-approval flags, bounded files; only this child's output is captured. */
export const launchAgent:Launcher=options=>new Promise(resolve=>{
  // Check immediately before this synchronous spawn path. A deferred call creates no log streams
  // and consumes no process identity; the existing queued job can be resumed unchanged.
  try{if(options.beforeSpawn&&!options.beforeSpawn()){resolve({exitCode:null,signal:null,processStopped:true,deferred:true});return;}}catch(e){resolve({exitCode:null,signal:null,processStopped:true,error:(e as Error).message});return;}
  const out=fs.createWriteStream(options.stdout,{flags:'wx'}),err=fs.createWriteStream(options.stderr,{flags:'wx'});
  const decoder=new StringDecoder('utf8');
  let child:ChildProcess|undefined,reason='',finished=false,pending='',bytes=0,termination:Promise<boolean>|undefined;
  const stop=()=>{
    if(termination||!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
    const owned=child;
    termination=process.platform==='win32'?new Promise<boolean>(done=>{
      const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
      killer.once('error',e=>{reason+='；停止进程树失败：'+e.message;done(false)});
      killer.once('exit',code=>{if(code!==0)reason+='；未能确认所有子进程已停止';done(code===0)});
    }):Promise.resolve(owned.kill('SIGKILL'));
  };
  const line=(value:string)=>{try{options.onLine(value)}catch(e){reason='客户端输出处理失败：'+(e as Error).message;stop()}};
  const finish=(exitCode:number|null,signal:string|null,error?:string)=>{if(finished)return;finished=true;options.signal.removeEventListener('abort',abort);pending+=decoder.end();if(pending.trim())line(pending);let streams=2;const done=()=>{if(--streams===0)void (async()=>resolve({exitCode,signal,error:error||reason||undefined,processStopped:termination?await termination:true}))()};for(const stream of [out,err]){if(stream.destroyed)done();else{stream.once('close',done);stream.end()}}};
  const abort=()=>{reason='调用已请求停止；保留实际回执和输出，未代写任务结果';stop()};
  const output=(chunk:Buffer,stream:fs.WriteStream,parse:boolean)=>{
    bytes+=chunk.length;if(bytes>20*1024*1024){reason='客户端输出超过20MiB上限，已请求停止调用';stop();return}
    stream.write(chunk);
    if(parse){pending+=decoder.write(chunk);let n;while((n=pending.indexOf('\n'))>=0){const value=pending.slice(0,n);pending=pending.slice(n+1);if(value.length<1024*1024)line(value)}if(pending.length>1024*1024){reason='客户端单条输出超出上限';stop();pending='';}}
  };
  out.on('error',e=>{reason='无法写入项目日志：'+e.message;stop();if(!child)finish(null,null,reason)});
  err.on('error',e=>{reason='无法写入项目日志：'+e.message;stop();if(!child)finish(null,null,reason)});
  try{
    if(options.signal.aborted){finish(null,null,'调用启动前已停止');return}
    const env={...process.env,...options.env};delete env.WORKBENCH_ROLE;delete env.WORKBENCH_RUN_ID;delete env.WORKBENCH_REVIEW_ID;delete env.CODEX_THREAD_ID;delete env.CODEX_SESSION_ID;
    child=spawn(options.command,options.args,{cwd:options.cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    options.signal.addEventListener('abort',abort,{once:true});
    child.stdout!.on('data',chunk=>output(chunk,out,true));child.stderr!.on('data',chunk=>output(chunk,err,false));
    child.once('error',e=>finish(null,null,e.message));child.once('close',(code,signal)=>finish(code,signal));
    child.stdin!.on('error',()=>{});
    try{if(child.pid)options.onSpawn?.(child.pid)}catch(e){reason='无法登记客户端进程：'+(e as Error).message;stop()}
    if(options.signal.aborted)abort();
    child.stdin!.end(reason?'':options.stdin||'');
  }catch(e){finish(null,null,(e as Error).message)}
});

export class AgentOrchestrator {
  private launching=new Map<string,AbortController>();
  private ticking=false;private scheduled=false;private closed=false;private databaseOpen=true;private timer?:NodeJS.Timeout;
  private changed=()=>{if(this.closed||this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;void this.tick()})};
  constructor(readonly wb:Workbench,private launcher:Launcher=launchAgent,private clients:{resolve:typeof resolveAgentClient;build:typeof buildAgentInvocation;discover?:typeof discoverAgentClients}={resolve:resolveAgentClient,build:buildAgentInvocation}){}
  start(){
    // A process may have survived a backend crash. Never blindly launch it a second time.
    for(const j of this.wb.all('agent_jobs').filter(j=>active.has(j.status))){
      // A durable queue entry has never reserved a process. In particular, a held project's queue
      // survives restart. Launching/running and uncertain legacy entries remain conservative.
      if(j.status==='queued'&&!j.process_may_be_running&&!j.process_pid)continue;
      this.update(j.id,{status:'interrupted',reason:'工作台上次调用未正常结束；请核对原客户端会话后继续，不会自动重复派发',ended_at:now()});
    }
    this.wb.on('change',this.changed);this.timer=setInterval(this.changed,3000);this.timer.unref();
    void (this.clients.discover||discoverAgentClients)({dataDir:this.wb.config.dataDir}).catch(()=>{});this.changed();
  }
  async close(){this.closed=true;clearInterval(this.timer);this.wb.off('change',this.changed);for(const [jid,ctl] of this.launching){this.update(jid,{status:'interrupted',reason:'工作台正在退出，客户端调用已请求停止；没有标记交付或审查完成',ended_at:now()});ctl.abort()}
    const deadline=Date.now()+5000;while(this.launching.size&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));this.databaseOpen=false;
  }
  private update(jid:string,changes:Row){if(this.closed&&!this.wb.maybe('agent_jobs',jid))return;this.wb.transaction(()=>{const j=this.wb.get('agent_jobs',jid);Object.assign(j,changes,{revision:j.revision+1,updated_at:now()});this.wb.put('agent_jobs',j,{run_id:j.run_id});const t=this.wb.get('tasks',j.task_id);if(t.current_run_id===j.run_id){t.automation=jobView(j);this.wb.put('tasks',t,{project_id:t.project_id})}})}
  private assertCurrent(runId:string,revision?:number){const r=this.wb.get('runs',runId),t=this.wb.get('tasks',r.task_id);assert(t.current_run_id===r.id&&!t.request_withdrawn&&!['cancelled','accepted','rework_linked','awaiting_confirmation'].includes(t.status)&&!this.wb.get('projects',t.project_id).archived,'只能调用当前有效执行',409);if(revision!==undefined)assert(t.revision===revision,'任务已变化，请读取最新 revision',409);this.wb.assertDependencies(t);assertProjectDispatch(this.wb,t.project_id);return {r,t:runTask(t,r)}}
  private duplicate(input:ReturnType<typeof agentDispatchInput.parse>,role:string){const old=this.wb.all('agent_jobs').find(j=>j.request_id===input.request_id);if(old){assert(old.request_digest===hash(JSON.stringify({...input,role})),'同一调用编号内容冲突',409);return jobView(old)}}
  private priorSession(t:Row,role:string,route:AgentRoute){return this.wb.all('agent_jobs').filter(j=>j.task_id===t.id&&j.role===role&&j.session_id&&j.status==='completed'&&JSON.stringify(j.route)===JSON.stringify(route)).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]}
  private assertNoOrphan(taskId:string){
    for(const j of this.wb.all('agent_jobs').filter(j=>j.task_id===taskId&&j.process_may_be_running)){
      // PID reuse produces a conservative block, never permission to kill or duplicate a process.
      assert(Number.isSafeInteger(j.process_pid),'上次调用在进程身份保存前中断；禁止重复启动。请在任务的“中断调用恢复”核实原客户端已结束并确认，保留审计记录',409);
      try{process.kill(j.process_pid,0);assert(false,`上次客户端进程 ${j.process_pid} 仍存在，禁止重复启动；请先等待原调用结束`,409)}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
      this.update(j.id,{process_may_be_running:false});
    }
  }
  taskJobs(taskId:string){this.wb.get('tasks',taskId);return this.wb.all('agent_jobs').filter(j=>j.task_id===taskId).map(jobView)}
  private stopOwned(jid:string,reason:string,actor:string){
    const job=this.wb.get('agent_jobs',jid),ctl=this.launching.get(jid);assert(ctl||job.status==='queued','本进程未持有该客户端，不能按旧PID强行结束；请使用中断调用恢复',409);
    this.update(jid,{status:'interrupted',cancel_requested_at:now(),reason,ended_at:now()});this.wb.audit(actor,'cancel_agent_job',jid,{reason,run_id:job.run_id});ctl?.abort();return jobView(this.wb.get('agent_jobs',jid));
  }
  cancelJob(taskId:string,input:unknown){const v=agentControlInput.parse(input),t=this.wb.get('tasks',taskId),j=this.wb.get('agent_jobs',v.job_id);assert(j.task_id===t.id,'禁止跨任务停止调用',403);assert(t.revision===v.expected_revision,'任务已变化，请刷新',409);if(j.cancel_requested_at)return jobView(j);assert(active.has(j.status),'此调用已结束',409);return this.stopOwned(j.id,v.reason,'user')}
  confirmProcessEnded(taskId:string,input:unknown){
    const v=agentRecoveryInput.parse(input),t=this.wb.get('tasks',taskId),j=this.wb.get('agent_jobs',v.job_id);
    assert(j.task_id===t.id,'禁止跨任务恢复调用',403);assert(t.revision===v.expected_revision,'任务已变化，请刷新',409);assert(['failed','interrupted'].includes(j.status)&&j.process_may_be_running&&!this.launching.has(j.id),'此调用不属于待核实的遗留进程',409);
    if(Number.isSafeInteger(j.process_pid)){try{process.kill(j.process_pid,0);assert(false,'已记录的进程仍存在，不能确认结束；请先等待或从原客户端结束',409)}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
    this.update(j.id,{process_may_be_running:false,process_end_evidence:'user_attested',process_recovery:{at:now(),actor:'user',reason:v.reason,confirmed:true},reason:'用户确认原调用已结束；保留中断记录，不会重试原调用；已有正式交付可按已登记策略继续独立审查'});
    this.wb.audit('user','confirm_agent_process_ended',j.id,{reason:v.reason,confirmed:true,previous_pid:j.process_pid||null,run_id:j.run_id});return jobView(this.wb.get('agent_jobs',j.id));
  }
  private create(input:ReturnType<typeof agentDispatchInput.parse>,role:'execution'|'review',t:Row,r:Row,phase:string,reviewId?:string,mainAuthorization?:Row){
    assertProjectDispatch(this.wb,t.project_id);
    const route=agentRouteSchema.parse(t[role==='review'?'review_route':'execution_route']);validateAgentRoutes(this.wb,t);
    const existing=this.wb.all('agent_jobs').find(j=>j.task_id===t.id&&j.role===role&&active.has(j.status));if(existing)return {job:existing,created:false};
    this.assertNoOrphan(t.id);
    const prior=input.fresh_session?null:this.priorSession(t,role,route);
    // A current same-role process which failed/interrupted must be inspected; a fresh request does not silently resume it.
    const uncertain=this.wb.all('agent_jobs').filter(j=>j.run_id===r.id&&j.role===role&&j.phase===phase&&['failed','interrupted'].includes(j.status)).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
    assert(!uncertain||input.fresh_session,'上次调用未确认完成；核对原客户端已结束后以 fresh_session 明确重试',409);
    const j:Row={id:id('AJ'),request_id:input.request_id,request_digest:hash(JSON.stringify({...input,role})),task_id:t.id,project_id:t.project_id,run_id:r.id,policy_digest:r.execution_contract?.digest||null,review_id:reviewId||null,role,phase,...(mainAuthorization?{main_launch_authorization:mainAuthorization}:{}),...(phase==='closeout'?{fresh_session:!!input.fresh_session}:{}),route,status:'queued',reason:'等待工作台调用本机客户端',revision:1,created_at:now(),session_id:null,resume_session_id:prior?.session_id||null,session_mode:prior?'resume':'new',previous_job_id:prior?.id||null};
    this.wb.transaction(()=>{this.wb.put('agent_jobs',j,{run_id:r.id});t.automation=jobView(j);if(role==='review')t.review_delivery='agent';this.wb.put('tasks',t,{project_id:t.project_id});this.wb.audit('agent_dispatch','queue_client',j.id,{run_id:r.id,role,client:route.client,model:route.model,...(mainAuthorization?{main_launch_authorization:mainAuthorization}:{})})});
    setImmediate(()=>void this.run(j.id));return {job:j,created:true};
  }
  dispatchRun(input:unknown,caller:MainExecutionCaller){return this.queueRun(input,caller);}
  private queueRun(input:unknown,caller:MainExecutionCaller,reworkSource?:string){
    const v=agentDispatchInput.parse(input),sourceRun=this.wb.get('runs',v.run_id),sourceTask=runTask(this.wb.get('tasks',sourceRun.task_id),sourceRun);
    const intent=reworkSource?'rework':['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'].includes(sourceTask.status)?'closeout':'initial';
    const authorization=authorizeMainLaunch(this.wb,sourceTask,caller,intent,reworkSource||sourceRun.id);
    const old=this.duplicate(v,'execution');if(old)return old;const {r,t}=this.assertCurrent(v.run_id,v.expected_revision);
    assert(t.execution_route,'当前执行者使用原会话，请读取任务简讯继续；未配置自动执行路由',409);
    assert(['ready','awaiting_dispatch','dispatched','waiting_input','blocked','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'].includes(t.status),'当前阶段不允许重新启动执行客户端',409);
    this.wb.eligible(r.agent_id);const phase=['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'].includes(t.status)?'closeout':'execution';
    const created=this.create(v,'execution',t,r,phase,undefined,authorization);return jobView(created.job);
  }
  dispatchReview(input:unknown){const v=agentDispatchInput.parse(input),old=this.duplicate(v,'review');if(old)return old;let {r,t}=this.assertCurrent(v.run_id,v.expected_revision);
    assert(t.status==='submitted'&&!reviewSkipped(t),'当前执行尚未交付或不需要审查',409);assert(t.review_route,'规划者尚未为本任务指定自动审查路由',409);assertReviewerResources(this.wb,t.reviewer_id);validateAgentRoutes(this.wb,t);
    const existing=this.wb.all('agent_jobs').find(j=>j.run_id===r.id&&j.role==='review'&&active.has(j.status));if(existing)return jobView(existing);
    const a=t.current_review_assignment_id?this.wb.maybe('review_assignments',t.current_review_assignment_id):null;
    assert(!a||a.status!=='completed','当前交付已有结论；修改后须新 Run，不能覆盖旧结论',409);
    this.assertNoOrphan(t.id);
    if(a?.status==='running')assert(v.fresh_session&&this.wb.all('agent_jobs').some(j=>j.review_id===a.id&&['failed','interrupted'].includes(j.status)&&!j.process_may_be_running),'已有审查者接单，不能重复启动',409);
    const order=exportReviewOrder(this.wb,{run_id:r.id,reviewer_id:t.reviewer_id,expected_revision:t.revision,reason:'按任务已规划路由直接调用独立审查',delivery_mode:'agent',...(v.fresh_session&&a?{new_review:true}:{})},{role:'runner',id:'dispatcher:'+r.id});
    t=runTask(this.wb.get('tasks',t.id),r);const created=this.create(v,'review',t,r,'review',order.review_id);return jobView(created.job);
  }
  continueRun(input:unknown,caller:ContinueCaller){const v=agentDispatchInput.parse(input),original=this.wb.get('runs',v.run_id),receipt=original.continuations?.find((x:Row)=>x.request_id===v.request_id),digest=hash(JSON.stringify(v));
    const sourceTask=runTask(this.wb.get('tasks',original.task_id),original);
    if(sourceTask.execution_route)authorizeMainLaunch(this.wb,sourceTask,caller,sourceTask.status==='changes_requested'||receipt&&!original.program_interruption?'rework':['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'].includes(sourceTask.status)?'closeout':'initial',original.id);
    const assertPageUser=()=>assert(caller?.role==='user'&&caller.source==='page','停止后的执行重新开始须由用户在工作台页面明确选择，Agent不能代为确认',403);
    if(receipt){if(original.program_interruption?.source==='workbench_process_control')assertPageUser();assert(receipt.digest===digest,'同一续作编号内容冲突',409);return receipt.result}
    const {r,t}=this.assertCurrent(v.run_id,v.expected_revision);
    if(t.status==='running'&&t.execution_route){
      assertPageUser();
      assert(v.fresh_session,'停止后的执行须明确以新Run、新会话重新开始，不能假定中断会话已完成',409);
      const stopped=this.wb.all('agent_jobs').filter(j=>j.run_id===r.id&&j.role==='execution'&&j.phase==='execution'&&['failed','interrupted'].includes(j.status)).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];
      assert(stopped&&!this.launching.has(stopped.id)&&!this.wb.all('agent_jobs').some(j=>j.task_id===t.id&&active.has(j.status)),'原执行调用尚未确认结束，不能重新开始',409);this.assertNoOrphan(t.id);
      return this.wb.transaction(()=>{
        const interrupted={at:now(),source:'workbench_process_control',job_id:stopped.id,reason:'用户明确要求停止后的执行以新Run、新会话重新开始',process_end_evidence:stopped.process_end_evidence||'unknown'};
        r.status='cancelled';r.program_interruption=interrupted;this.wb.put('runs',r,{task_id:t.id});this.wb.audit(caller.role,'restart_interrupted_execution',r.id,{...interrupted,caller_source:caller.source});
        const order=this.wb.exportOrder(t.id,t.version,true,undefined,t.revision),next=this.wb.get('runs',order.run_id),current=this.wb.get('tasks',t.id);
        next.retry_context.last_obstacle={type:'program_interrupted',message:interrupted.reason,occurred_at:interrupted.at,job_id:stopped.id,agent_report:false};this.wb.put('runs',next,{task_id:t.id});
        // A user's next-version arrangement may move the task to a member without an automatic route: hand off manually, never roll back.
        const result=current.execution_route?{...this.dispatchRun({...v,run_id:next.id,expected_revision:current.revision,fresh_session:true},caller),previous_run_id:r.id}
          :{run_id:next.id,task_id:t.id,previous_run_id:r.id,automatic_delivery:false,entry:order.entry,reason:'新执行负责人没有自动调用路线；新执行单已生成，请交给执行者。原执行记录与停止证据保留'};
        r.continuations=[...(r.continuations||[]),{request_id:v.request_id,digest,result}];this.wb.put('runs',r,{task_id:t.id});return result;
      });
    }
    if(t.status!=='changes_requested')return this.dispatchRun(v,caller);
    const count=t.automatic_rework_count||0,limit=t.automation_policy?.max_rework_rounds||2;
    assert(count<limit,'已达到本任务返修轮次上限，请由规划者根据问题重新安排',409);
    this.assertNoOrphan(t.id);
    assert(!this.wb.all('agent_jobs').some(j=>j.task_id===t.id&&active.has(j.status)),'原调用尚未结束，不能开始下一轮执行',409);
    const order:Row=reviewFeedbackOrder(this.wb,r.id,t.revision),next=this.wb.get('runs',order.run_id),current=this.wb.get('tasks',t.id);
    this.wb.transaction(()=>{current.automatic_rework_count=count+1;this.wb.put('tasks',current,{project_id:current.project_id})});
    const result=!current.execution_route?{run_id:next.id,task_id:t.id,automatic_delivery:false,entry:order.entry,reason:'返修单已建立，指定执行者可手工接续；未启动外部客户端',context:executionContext(this.wb,{run_id:next.id,mode:'brief'})}:{...this.queueRun({...v,run_id:next.id,expected_revision:current.revision},caller,r.id),previous_run_id:r.id};
    const saved=this.wb.get('runs',r.id);saved.continuations=[...(saved.continuations||[]),{request_id:v.request_id,digest,result}];this.wb.put('runs',saved,{task_id:t.id});return result;
  }
  async getJob(input:unknown){const v=agentJobInput.parse(input);let j=this.wb.get('agent_jobs',v.job_id);assert(j.run_id===v.run_id,'禁止跨执行查询调用记录',403);const end=Date.now()+v.timeout_ms;while(!terminal.has(j.status)&&j.revision===(v.after_revision??j.revision)&&Date.now()<end&&!this.closed){await new Promise(r=>setTimeout(r,Math.min(200,end-Date.now())));j=this.wb.get('agent_jobs',v.job_id)}return {...jobView(j),changed:v.after_revision===undefined||j.revision!==v.after_revision};}
  private artifactDirectory(j:Row,t:Row,r:Row){const base=t.context_contract?.output_dir||path.join(r.cwd,'.agent-workbench-output',t.id,r.id);const target=safePath(path.join(base,'calls',j.id),t.allowed_paths,true);assert(!this.wb.privatePath(target)&&!protectedName(target),'调用产物目录不能是内部存储或凭据目录');fs.mkdirSync(target,{recursive:true});return target;}
  private prompt(j:Row,t:Row,r:Row,dir:string){
    const command=`& '${process.execPath.replace(/'/g,"''")}' --import '${import.meta.resolve('tsx').replace(/'/g,"''")}' '${path.join(ROOT,'scripts',j.role==='review'?'review.ts':'agent.ts').replace(/'/g,"''")}' ${j.role==='review'?j.review_id:r.id}`;
    const env=`$env:WORKBENCH_ROOT='${this.wb.config.root.replace(/'/g,"''")}'; $env:WORKBENCH_DATA_DIR='${this.wb.config.dataDir.replace(/'/g,"''")}'; $env:WORKBENCH_PORT='${this.wb.config.port}'; `;
    const shared=`你正在执行工作台正式${j.role==='review'?'独立审查':'执行'}任务。所有主动产物（报告、日志、截图、临时测试文件）只写 ${dir} 或合同规定的项目产物目录。Harness正常会话缓存按客户端默认机制保留。不得读凭据、全盘扫描、绕过权限拒绝或伪造测试/回执。只读取本任务必读资料和有具体理由的条件补充，禁止重新扫整个项目或读取全量历史。程序发现的客户端和调用规则由规划者管理，无需重新查找安装路径。\n${j.session_mode==='resume'?`本次恢复同任务原${j.role==='review'?'审查':'执行'}会话 ${j.resume_session_id}；只处理本轮变化。若上下文丢失，读取简版检查点，不假装已记住原文。`:'这是独立的新会话；不要导入作者的完整会话历史。'}\n`;
    if(j.role==='review'){
      const base=reviewAssignmentContext(this.wb,j.review_id),previous=j.previous_job_id?this.wb.get('agent_jobs',j.previous_job_id):null;
      const prior=previous?.review_id?this.wb.maybe('review_assignments',previous.review_id):null;
      const known=prior?.context_ack?.hash||prior?.context_cache?.filter((x:Row)=>x.session_id===j.resume_session_id).at(-1)?.hash;
      const ctx=reviewContext(this.wb,{review_id:j.review_id,mode:known?'delta':'brief',...(known?{known_context_hash:known,session_id:j.resume_session_id}:{})},base,j.id);
      return shared+`Task ${t.id} / Run ${r.id} / Review ${j.review_id}\n目标：${t.goal}\n验收标准：${JSON.stringify(t.acceptance)}\n必要验证：${JSON.stringify(t.tests)}\n可以通过本人回执接单：${env}${command} started ${t.reviewer_id}\n下面已经提供本单精简资料，无需再次完整输出。需要最新资料时 ${env}${command} context；用 read <请求JSON文件> 读取合同内文件，补读按合同说明原因。独立检验源码与证据，不替作者改代码；项目内提供临时测试目录。\n最终回复必须是一个严格JSON对象（不加Markdown围栏或前后说明），包含下面格式的完整 report_markdown。工作台仅从你的原生客户端最终成功输出登记本单结果，不从工具输出或作者文字提取结论。任何未运行测试如实写limitations；审查不通过列具体问题编号和文件位置。不绕过权限拒绝，不能用作者测试充当自己亲测。报告可同时保存 ${path.join(dir,'review-result.json')}；若通过scoped脚本submit登记，最终仍返回相同JSON。\n资料：${JSON.stringify(ctx)}\n结果格式：${JSON.stringify(base.report_template)}\n`;
    }
    const priorJob=j.previous_job_id?this.wb.get('agent_jobs',j.previous_job_id):null,priorRun=priorJob?this.wb.get('runs',priorJob.run_id):null;
    const known=priorRun?.context_ack?.hash||priorRun?.context_cache?.at(-1)?.hash;
    const ctx=executionContext(this.wb,{run_id:r.id,mode:j.session_mode==='resume'&&known?'delta':'brief',...(j.session_mode==='resume'&&known?{known_context_hash:known}:{})});
    return shared+`Task ${t.id} / Run ${r.id}\n本轮不可变模型/委派设置：${JSON.stringify(r.execution_contract||null)}。子代理必须先按register_delegation登记白名单、读取范围和产物，再报告真实执行；原生内部子代理当前仅下发要求，不冒充强制隔离。\n${j.phase==='closeout'?`审查已通过，只完成本Run实际收尾：${env}${command} context；获取 get_closeout_context 按项执行，再通过 closeout <结果JSON> 回报。`:`先本人接单：${env}${command} start。按本轮任务实施和验证；报告用 ${env}${command} report <JSON文件>。交付event_type=submitted，data含result、artifacts、review_files及review_delivery=agent。交付后停止修改受审文件。${t.automation_policy?.auto_review?'工作台按本任务策略自动派审。':t.review_route?`接着调用 ${env}${command} review 直接安排审查。`:'本任务尚未登记自动审查路由，请按当前任务交接安排继续；不要假称已自动派审。'}需要等待则调用wait/get_agent_job，不重复读完整执行单。` }\n资料：${JSON.stringify(ctx)}\n`;
  }
  private onOutput(jid:string,v:ParsedAgentOutput){
    if(!v.recognized)return;
    // The raw event and the job's durable cursor/metadata must commit or roll back together.
    this.wb.transaction(()=>{
    const j=this.wb.get('agent_jobs',jid);const sid=v.sessionId,model=v.model;
    const patch:Row={};
    if(v.messageId)patch.usage_message_id=v.messageId;
    if(v.usage){const ordinal=(j.usage_ordinal||0)+1,task=this.wb.get('tasks',j.task_id);const input=usageInputFromOutput({...j,id:j.id,actual_model:v.modelFormat==='identifier'?v.model:j.actual_model,client_kind:j.route.client,requested_model:j.route.model,project_id:j.project_id||task.project_id,agent_id:j.role==='review'?task.reviewer_id:task.agent_id,usage_message_id:v.messageId||j.usage_message_id},v,ordinal,now());
      if(input){const normalized=createUsageEvent(input),old=input.identity_quality==='source_event_id'?this.wb.maybe('usage_events',normalized.id):undefined;
        if(old){assert(old.scope_id===normalized.scope_id&&old.epoch===normalized.epoch&&old.mode===normalized.mode,'重放用量事件的范围冲突',409);assert(!old.actual_model||!normalized.actual_model||old.actual_model===normalized.actual_model,'重放用量事件的实际模型冲突',409);recordUsageEvent(this.wb,{...old,usage:normalized.usage} as typeof input);this.update(jid,{usage_replayed_events:(j.usage_replayed_events||0)+1});return;}
        else{recordUsageEvent(this.wb,input);patch.usage_ordinal=ordinal;}
      }
    }
    if(typeof sid==='string'&&sessionPattern.test(sid)){
      if(j.resume_session_id&&sid!==j.resume_session_id){patch.session_mismatch=true;patch.reason='客户端返回的会话编号与请求续接不同，不能认定上下文已复用';}
      else patch.session_id=sid;
    }
    if(typeof model==='string'&&model.length<=100&&v.modelFormat==='display_name')patch.actual_model_display=model;
    else if(typeof model==='string'&&model.length<=100){patch.actual_model=model;const requested=j.route.model;
      const claudeAlias=j.route.client==='claude'&&['sonnet','opus','haiku'].includes(requested)&&model.startsWith('claude-'+requested+'-');
      if(model!==requested&&!claudeAlias){patch.model_mismatch=true;patch.reason='客户端报告的实际模型与指定路线不同；保留原证据，停止自动流转';}
    }
    if(v.usage){if(v.usage.scope==='step'){const previous=j.usage?.scope==='invocation_steps'?j.usage:{scope:'invocation_steps',steps:0};const usage:Row={...previous,steps:previous.steps+1};for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'] as const)if(v.usage[key]!==undefined)usage[key]=(previous[key]||0)+v.usage[key]!;patch.usage=usage;}else patch.usage=v.usage;}
    if(v.success===false)patch.output_failed=true;
    if(Object.keys(patch).length)this.update(jid,patch);
    });
  }
  private deferForProjectHold(jid:string){
    const job=this.wb.get('agent_jobs',jid),task=this.wb.get('tasks',job.task_id),project=this.wb.get('projects',job.project_id||task.project_id);
    if(!project.dispatch_paused)return false;
    if(job.status!=='queued'||job.process_may_be_running)this.update(jid,{status:'queued',process_may_be_running:false,started_at:null,ended_at:null,reason:'项目已暂缓；调用尚未启动，保留原排队记录，恢复后继续'});
    return true;
  }
  private async run(jid:string){
    if(this.launching.has(jid))return;
    const ctl=new AbortController();this.launching.set(jid,ctl);let timer:NodeJS.Timeout|undefined,launchCommitted=false;
    try{
      const initial=this.wb.get('agent_jobs',jid);if(this.closed||initial.status!=='queued')return;
      if(this.deferForProjectHold(jid))return;
      const {r,t}=this.assertCurrent(initial.run_id);assertMainLaunch(this.wb,initial,t,r);this.update(jid,{status:'launching',reason:'正在核对本机客户端和本次交付'});
      const client=await this.clients.resolve(this.wb.config.dataDir,initial.route.client);
      if(this.closed||ctl.signal.aborted||this.deferForProjectHold(jid))return;
      const latest=this.assertCurrent(r.id);assertMainLaunch(this.wb,initial,latest.t,latest.r);if(initial.role==='review'){assertReviewerResources(this.wb,t.reviewer_id);reviewAssignmentContext(this.wb,initial.review_id)}else this.wb.eligible(r.agent_id);
      const dir=this.artifactDirectory(initial,latest.t,latest.r),promptFile=path.join(dir,'TASK.txt');atomicWrite(promptFile,this.prompt(initial,latest.t,latest.r,dir));
      const invocation=await this.clients.build(client,{role:initial.role,cwd:r.cwd,artifactDir:dir,model:initial.route.model,provider:initial.route.provider,sessionId:initial.resume_session_id||undefined,promptFile});
      if(this.closed||ctl.signal.aborted||this.deferForProjectHold(jid))return;
      const current=this.assertCurrent(r.id);assertMainLaunch(this.wb,initial,current.t,current.r);validateAgentRoutes(this.wb,current.t);
      assert(JSON.stringify(current.t[initial.role==='review'?'review_route':'execution_route'])===JSON.stringify(initial.route),'调用路线已变化，请重新规划',409);
      if(initial.role==='review'){assertReviewerResources(this.wb,current.t.reviewer_id);const context=reviewAssignmentContext(this.wb,initial.review_id);assert(context.assignment.status==='awaiting_dispatch','审查已被接单或结束，不能再次启动',409)}else this.wb.eligible(r.agent_id);
      const files={prompt:promptFile,stdout:path.join(dir,'stdout.jsonl'),stderr:path.join(dir,'stderr.log')};
      this.update(jid,{status:'running',started_at:now(),files,process_may_be_running:true,reason:initial.role==='review'?'正在启动审查客户端，等待审查者本人回执':'正在启动执行客户端，等待本人回执'});
      if(this.closed||ctl.signal.aborted||this.deferForProjectHold(jid))return;
      timer=setTimeout(()=>ctl.abort(),60*60*1000);timer.unref();
      const parser=createAgentOutputParser(initial.route.client);let finalText:string|undefined;
      const result=await this.launcher({...invocation,cwd:r.cwd,env:{...invocation.env,WORKBENCH_ROOT:this.wb.config.root,WORKBENCH_DATA_DIR:this.wb.config.dataDir,WORKBENCH_PORT:String(this.wb.config.port),TEMP:dir,TMP:dir},beforeSpawn:()=>{if(this.closed||ctl.signal.aborted||this.deferForProjectHold(jid))return false;const latest=this.assertCurrent(r.id);assertMainLaunch(this.wb,initial,latest.t,latest.r);assert(JSON.stringify(latest.t[initial.role==='review'?'review_route':'execution_route'])===JSON.stringify(initial.route),'调用路线已变化，请重新规划',409);launchCommitted=true;return true;},onSpawn:pid=>{launchCommitted=true;if(!this.closed)this.update(jid,{process_pid:pid})},onLine:line=>{if(this.closed)return;launchCommitted=true;const output=parser.push(line);this.onOutput(jid,output);if(output.terminal&&output.success!==false&&output.finalText!==undefined)finalText=output.finalText;},stdout:files.stdout,stderr:files.stderr,signal:ctl.signal});
      if(result.deferred){if(this.databaseOpen&&!this.closed&&!ctl.signal.aborted)this.deferForProjectHold(jid);return;}
      if(this.databaseOpen)this.update(jid,{process_may_be_running:result.processStopped===false,process_end_evidence:result.processStopped===false?'unknown':'owned_child_exit'});if(this.closed)return;const job=this.wb.get('agent_jobs',jid),run=this.wb.get('runs',r.id),task=this.wb.get('tasks',t.id);
      if(job.cancel_requested_at){this.update(jid,{status:'interrupted',exit_code:result.exitCode,ended_at:now(),reason:result.processStopped===false?'已请求停止，但无法确认进程树结束；保留阻碍':'本次调用已停止，原有交付或审查回执仍单独保留；不会自动重试'});return;}
      if(result.processStopped===false){this.update(jid,{status:'interrupted',exit_code:result.exitCode,ended_at:now(),reason:'已有正式回执仍保留，但未能确认进程树已结束；请核实后通过中断调用恢复，不会自动重试'});return;}
      let complete=false;
      if(initial.role==='review'){
        let a=this.wb.get('review_assignments',initial.review_id);
        if(a.session_id&&job.session_id&&a.session_id!==job.session_id)job.session_mismatch=true;
        if(a.actual_model&&job.actual_model&&a.actual_model!==job.actual_model)job.model_mismatch=true;
        if(a.status!=='completed'&&finalText!==undefined&&result.exitCode===0&&!result.error&&!job.session_mismatch&&!job.model_mismatch&&!job.output_failed){
          // Only the launched independent client's terminal answer can enter this path.
          // No HTTP endpoint accepts caller-provided native output or changes its provenance.
          const payload=reviewResultInput.parse(JSON.parse(finalText.trim()));
          assert(payload.review_id===a.id&&payload.task_id===t.id&&payload.run_id===r.id,'客户端最终报告属于其他审查任务',409);
          const context=reviewAssignmentContext(this.wb,a.id);assert(payload.review_digest===context.review_digest,'客户端报告不属于当前交付版本',409);
          atomicWrite(path.join(dir,'review-result.json'),JSON.stringify(payload,null,2));
          this.wb.transaction(()=>{
            if(a.status==='awaiting_dispatch')startReview(this.wb,{review_id:a.id,identity:a.reviewer_id,...(job.session_id?{session_id:job.session_id}:{}),...(job.actual_model?{actual_model:job.actual_model}:{})});
            const receipt=submitReviewResult(this.wb,payload,'native_client_output:'+jid);
            const review=this.wb.get('reviews',receipt.review.id);review.source='native_client_output';review.client_job_id=jid;review.evidence_level='launched_client_final_output';review.independently_verified=false;this.wb.put('reviews',review,{run_id:r.id});
          });a=this.wb.get('review_assignments',initial.review_id);
        }
        complete=a.status==='completed'&&!!a.result_id;
        if(job.session_id&&!job.session_mismatch&&!job.model_mismatch&&['running','completed'].includes(a.status))this.wb.transaction(()=>{a.session_id=job.session_id;a.actual_model=job.actual_model||a.actual_model;this.wb.put('review_assignments',a,{run_id:a.run_id});if(a.result_id){const review=this.wb.get('reviews',a.result_id);review.session_id=job.session_id;review.actual_model=job.actual_model||review.actual_model;this.wb.put('reviews',review,{run_id:a.run_id})}bindReviewContextSession(this.wb,a.id,jid)});
      }else{
        complete=initial.phase==='closeout'?['awaiting_confirmation','accepted'].includes(task.status):['submitted','waiting_input','blocked','failed'].includes(run.status);
        const identity=initial.phase==='closeout'?run.closeout:run;
        assert(identity,'当前Run缺少收尾记录，不能登记客户端会话身份',409);
        const source=initial.phase==='closeout'&&identity.client_job_id?this.wb.maybe('agent_jobs',identity.client_job_id):null;
        const replaceCloseoutIdentity=initial.phase==='closeout'&&initial.fresh_session===true&&source&&source.id!==job.id&&source.run_id===run.id&&source.phase==='closeout'&&['failed','interrupted'].includes(source.status)&&source.process_may_be_running===false&&source.session_id===identity.session_id&&(!identity.actual_model||source.actual_model===identity.actual_model);
        if(!replaceCloseoutIdentity&&identity.session_id&&job.session_id&&identity.session_id!==job.session_id)job.session_mismatch=true;
        if(!replaceCloseoutIdentity&&identity.actual_model&&job.actual_model&&identity.actual_model!==job.actual_model)job.model_mismatch=true;
        if(job.session_id&&!job.session_mismatch&&!job.model_mismatch)this.wb.transaction(()=>{identity.session_id=job.session_id;identity.actual_model=job.actual_model||(replaceCloseoutIdentity?null:identity.actual_model);if(initial.phase==='closeout')identity.client_job_id=job.id;this.wb.put('runs',run,{task_id:run.task_id});this.wb.upsertSession({agent:run.agent_id,native_id:job.session_id,source:'client_invocation',source_id:job.id,run_id:run.id,project_id:task.project_id,title:task.title,summary:'客户端调用返回真实会话编号'})});
      }
      const mismatch=job.session_mismatch||job.model_mismatch,status=complete&&!mismatch?'completed':'failed';
      this.update(jid,{status,session_mismatch:!!job.session_mismatch,model_mismatch:!!job.model_mismatch,exit_code:result.exitCode,ended_at:now(),reason:mismatch?'客户端会话或模型身份与指定路线/正式回执冲突，保留各自证据并停止自动流转':complete?(result.error||result.exitCode!==0?'已收到正式结果；客户端退出异常，详见项目日志':'已收到正式回执，工作台已登记结果'):(result.error||`客户端退出码 ${result.exitCode}，没有收到所需的正式${initial.role==='review'?'审查':'执行'}结果；未标记完成`)});
    }catch(e){if(!this.closed){if(!launchCommitted&&!ctl.signal.aborted&&this.deferForProjectHold(jid))return;this.update(jid,{status:'failed',reason:(e as Error).message.slice(0,2000),ended_at:now()})}}
    finally{clearTimeout(timer);this.launching.delete(jid);this.changed()}
  }
  private async tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{
      for(const jid of this.launching.keys()){const job=this.wb.get('agent_jobs',jid);if(job.cancel_requested_at)continue;const task=this.wb.get('tasks',job.task_id),assignment=job.review_id?this.wb.maybe('review_assignments',job.review_id):null;
        if(task.current_run_id!==job.run_id||task.request_withdrawn||['cancelled','rework_linked'].includes(task.status)||this.wb.get('projects',task.project_id).archived||job.role==='review'&&(task.current_review_assignment_id!==job.review_id||['superseded','revoked'].includes(assignment?.status)))this.stopOwned(jid,'任务或审查已取消、撤回、归档、改派或当前Run已更换，已请求停止原客户端','system')}
      for(const j of this.wb.all('agent_jobs'))if(j.status==='queued'&&!this.launching.has(j.id)&&!this.wb.get('projects',this.wb.get('tasks',j.task_id).project_id).dispatch_paused)setImmediate(()=>{if(!this.launching.has(j.id))void this.run(j.id)});
      for(const t of this.wb.all('tasks')){
      if(this.closed||!t.automation_policy||!t.current_run_id||this.wb.get('projects',t.project_id).dispatch_paused)continue;
      const jobs=this.wb.all('agent_jobs').filter(j=>j.task_id===t.id),inProgress=jobs.some(j=>active.has(j.status)||this.launching.has(j.id));if(inProgress)continue;
      const currentRun=this.wb.get('runs',t.current_run_id),formallySubmitted=currentRun.status==='submitted';
      const recoveredExecution=(j:Row)=>formallySubmitted&&j.status==='interrupted'&&j.role==='execution'&&j.phase==='execution'&&j.process_may_be_running===false&&['owned_child_exit','user_attested'].includes(j.process_end_evidence)&&!j.session_mismatch&&!j.model_mismatch&&(!j.session_id||!currentRun.session_id||j.session_id===currentRun.session_id)&&(!j.actual_model||!currentRun.actual_model||j.actual_model===currentRun.actual_model);
      let action:'review'|'rework'|'closeout'|null=null;
      if(t.status==='submitted'&&t.automation_policy.auto_review&&!jobs.some(j=>j.run_id===t.current_run_id&&j.role==='review')&&!t.current_review_assignment_id)action='review';
      if(t.status==='changes_requested'&&t.automation_policy.auto_rework&&t.execution_route&&!jobs.some(j=>j.run_id===t.current_run_id&&j.phase==='rework_blocked'))action='rework';
      if(t.status==='awaiting_closeout'&&t.automation_policy.continue_after_review&&t.execution_route&&!jobs.some(j=>j.run_id===t.current_run_id&&j.phase==='closeout'))action='closeout';
      if(!action)continue;
      if(action!=='review'&&(mainExecutionControl(t)!=='automatic'||manuallyTakenOver(this.wb,t.id,currentRun.id)))continue;
      // A failed launch that the executor's own started on this Run superseded only stops blocking the independent review.
      // Main-executor rework/closeout stays with the user: a manual takeover is never turned back into an automatic launch.
      if(jobs.some(j=>j.run_id===t.current_run_id&&['failed','interrupted'].includes(j.status)&&!recoveredExecution(j)&&!(action==='review'&&supersededLaunch(j))&&!jobs.some(next=>next.run_id===j.run_id&&next.role===j.role&&next.phase===j.phase&&next.status==='completed'&&next.created_at>j.created_at)))continue;
      try{const input={run_id:t.current_run_id,request_id:crypto.randomUUID(),expected_revision:t.revision};if(action==='review')this.dispatchReview(input);else if(action==='rework')this.continueRun(input,{role:'system',source:'automation'});else this.dispatchRun(input,{role:'system',source:'automation'})}catch(e){
        // Persist the blocking observation once. Never turn an unknown outcome into a retry loop.
        const current=this.wb.get('tasks',t.id),reason=(e as Error).message.slice(0,2000);if(current.automation?.reason===reason)continue;
        this.wb.transaction(()=>{current.automation={status:'failed',role:action==='review'?'review':'execution',reason,client:current[action==='review'?'review_route':'execution_route']?.client,blocked_action:action};this.wb.put('tasks',current,{project_id:current.project_id})});
      }
    }}finally{this.ticking=false}
  }
  async capabilities(){return {clients:await readClientCapabilities(this.wb.config.dataDir)}}
}

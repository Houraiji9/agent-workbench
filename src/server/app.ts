import {registerProjectManagementRoutes} from './project-management-routes.ts';
import {chatPlanningContext} from '../core/chat-planning.ts';
import {registerDelegation,reportDelegation} from '../core/workflow-policy.ts';
import {AgentOrchestrator,agentClientKind} from '../core/agent-orchestration.ts';
import {mainExecutionControlSummary,setMainExecutionControl} from '../core/main-execution-control.ts';
import {discoverAgentClients,readClientCapabilities,setClientOverride} from '../core/agent-clients.ts';
import {readRunContextFile} from '../core/execution-context.ts';
import {reviewContext,acknowledgeReviewContext,readReviewContextFile} from '../core/review-context.ts';
import {clientKindSchema} from '../core/agent-route-schema.ts';
import {executionContext,acknowledgeContext,reportActivity,dispatchBrief,prepareContinuation,briefCloseout,waitRunUpdate,finishRunCloseout} from '../core/execution-context.ts';
import {reportDeployment} from '../core/runtime-delivery.ts';
import {getDeploymentEvidenceContext,reportDeploymentEvidence} from '../core/deployment-evidence.ts';
import {relationshipGraph} from '../shared/workflow-view.ts';
import {resolveDecision} from '../core/user-decisions.ts';
import {reportReviewHandoff} from '../core/review-workflow.ts';
import {getCloseoutContext,exportCloseoutOrder,closeoutInput} from '../core/closeout.ts';
import {getReviewContext,submitGrokReview,revokeReview,reviewContextInput,readGrokTrace,type TraceReader} from '../core/review-evidence.ts';
import {reviewCandidates,exportReviewOrder,reviewAssignmentContext,startReview,submitReviewResult,reviewFeedbackOrder,reviewId} from '../core/review-workflow.ts';
import {Archify} from '../integrations/archify.ts';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import {rejectAcceptance,reworkOrder} from '../core/acceptance-feedback.ts';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {Workbench} from '../core/workbench.ts';
import {openArtifactFolder,revealFile} from '../core/artifact-folders.ts';
import {saveRequest,deleteRequest,archiveProject} from '../core/request-management.ts';
import {Integrations} from '../integrations/adapters.ts';
import {editQuotaCache,editWorkBuddyPoints} from '../core/quota-cache.ts';
import {saveAgent,archiveAgent,saveQuota,archiveQuota} from '../core/resource-management.ts';
import {type Config} from '../core/config.ts';
import {assert,DomainError,secret,same,safePath,readBounded,hash} from '../core/security.ts';
import {createBackup} from '../../scripts/backup.ts';
import {addAuthorizedRoot,authorizeProject} from '../core/roots.ts';
import type {Row} from '../core/schema.ts';
import type {ReviewCaller} from '../core/review-permissions.ts';
import {manage,readManagement,managementTools,managementReadTools} from '../core/management.ts';

// 下载文件名：ASCII 兜底名 + UTF-8 中文名，兼容不同浏览器与桌面窗口。
export function disposition(name:string){const clean=name.replace(/[\r\n"\\/:*?<>|]/g,'_');const ext=(clean.match(/\.[A-Za-z0-9]{1,8}$/)||[''])[0];const ascii=(clean.slice(0,clean.length-ext.length).replace(/[^\x20-\x7e]/g,'').replace(/\s+/g,' ').trim()||'workbench-file')+ext;return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`}

export async function createApp(config:Config,{background=true,revealArtifact=revealFile,grokTraceReader}: {background?:boolean;revealArtifact?:typeof revealFile;grokTraceReader?:TraceReader}={}){
  const wb=new Workbench(config),integrations=new Integrations(wb),app=Fastify({logger:false,bodyLimit:2*1024*1024});
  const archify=new Archify(wb),agents=new AgentOrchestrator(wb);
  const graph=(pid:string,view='tasks',history=true)=>{wb.roots(wb.get('projects',pid));assert(['tasks','execution','sessions'].includes(view),'关系图类型无效');return relationshipGraph(wb.executionTasks(),wb.all('runs'),wb.all('reviews'),wb.all('sessions'),pid,view,history)};
  const readReviewTrace=grokTraceReader||((sid:string)=>readGrokTrace(sid,config.review?.grokExecutable||process.env.WORKBENCH_GROK_EXECUTABLE||'grok'));
  const importingReviews=new Set<string>();
  const openProject=(projectId:string)=>{const p=wb.get('projects',projectId);const folder=safePath(p.source_root||p.paths[0],config.authorizedRoots);assert(!wb.privatePath(folder),'项目目录不可用');assert(process.platform==='win32','当前系统未实现目录打开');spawn('explorer.exe',[folder],{shell:false,windowsHide:true,detached:true,stdio:'ignore'}).unref();return {opened:true,folder}};
  const managementServices={integrations,readReviewTrace,revealArtifact,openProject};
  const importReview=async(b:Row,caller:ReviewCaller)=>{const key=String(b.run_id);assert(!importingReviews.has(key),'这次审查正在核验，请稍后重试',409);importingReviews.add(key);try{return await submitGrokReview(wb,b,caller,readReviewTrace)}finally{importingReviews.delete(key)}};
  const sessions=new Map<string,{csrf:string;created:number}>();
  app.setErrorHandler((e:any,_req,res)=>res.code(e instanceof DomainError?e.status:e instanceof z.ZodError?400:e.statusCode||500).send({error:e instanceof z.ZodError?'输入格式不符合 schema：'+e.issues.map((i:Row)=>i.path.join('.')+' '+i.message).join('; '):e.statusCode===500?'服务内部错误，请检查运行日志':e.message}));
  app.addHook('onRequest',async(req,res)=>{
    const host=req.headers.host||'';const allowed=[`127.0.0.1:${config.port}`,`localhost:${config.port}`];assert(allowed.includes(host),'Host 不受信任',403);
    const origin=req.headers.origin;assert(!origin||allowed.map(h=>'http://'+h).includes(origin),'Origin 不受信任',403);
    const cross=req.headers['sec-fetch-site'];assert(cross!=='cross-site','拒绝跨站访问',403);
    res.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Cache-Control','no-store');
    res.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if(req.url.startsWith('/api/mcp/')||req.url==='/api/health')return;
    if(req.url==='/api/bootstrap')return;
    if(req.url.startsWith('/api/')){
      const sid=req.headers.cookie?.match(/(?:^|; )wb_session=([a-f0-9]+)/)?.[1]||'';const session=sessions.get(sid);assert(session&&Date.now()-session.created<12*3600000,'会话失效，请刷新页面',401);
      if(req.method!=='GET'&&req.method!=='HEAD')assert(same(String(req.headers['x-workbench-csrf']||''),session.csrf),'缺少合法的页面操作凭据',403);
      assert(!req.headers.authorization,'Agent 凭据只能调用对应的 MCP 接口，不能混用页面身份',403);
    }
  });
  app.get('/api/health',async()=>({ok:true,app:'agent-workbench',version:fs.existsSync(path.join(config.root,'package.json'))?JSON.parse(fs.readFileSync(path.join(config.root,'package.json'),'utf8')).version:'unknown',pid:process.pid}));
  app.get('/api/bootstrap',async(_req,res)=>{const sid=secret(),csrf=secret();for(const[k,v]of sessions)if(Date.now()-v.created>12*3600000)sessions.delete(k);sessions.set(sid,{csrf,created:Date.now()});res.header('Set-Cookie',`wb_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return {csrf,...wb.snapshot()}});
  app.get('/api/state',async()=>wb.snapshot());
  registerProjectManagementRoutes(app,wb,revealArtifact);
  app.get('/api/agent-clients',async()=>agents.capabilities());
  app.post('/api/agent-clients/refresh',async()=>{await discoverAgentClients({dataDir:config.dataDir,force:true});return agents.capabilities()});
  app.post('/api/agent-clients/override',async req=>{const v=z.object({kind:clientKindSchema,executable:z.string().min(1).max(2000)}).strict().parse(req.body);await setClientOverride({dataDir:config.dataDir,...v});return agents.capabilities()});
  const dispatchBody=(taskId:string,body:Row)=>{const t=wb.get('tasks',taskId);return {run_id:t.current_run_id,request_id:body.request_id,expected_revision:body.expected_revision,...(body.fresh_session!==undefined?{fresh_session:body.fresh_session}:body.same_session===false?{fresh_session:true}:{})}};
  app.get<{Params:{id:string}}>('/api/tasks/:id/main-execution-control',async req=>mainExecutionControlSummary(wb.get('tasks',req.params.id)));
  app.post<{Params:{id:string}}>('/api/tasks/:id/main-execution-control',async req=>setMainExecutionControl(wb,req.params.id,req.body,{role:'user',source:'page'}));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/dispatch',async req=>agents.dispatchRun(dispatchBody(req.params.id,req.body),{role:'user',source:'page'}));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/dispatch-review',async req=>agents.dispatchReview(dispatchBody(req.params.id,req.body)));
  app.post<{Params:{id:string}}>('/api/user-decisions/:id/:choice',async req=>{
    assert(!req.headers.authorization,'确认事项请使用工作台页面',403);
    const params=z.object({id:z.string(),choice:z.enum(['confirm','cancel'])}).parse(req.params);
    z.object({}).strict().parse(req.body);return resolveDecision(wb,params.id,params.choice);
  });
  app.get('/api/events',async(req,res)=>{
    res.hijack();res.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.raw.write('event: ready\ndata: {}\n\n');const onChange=()=>res.raw.write('event: changed\ndata: {}\n\n');wb.on('change',onChange);const timer=setInterval(()=>res.raw.write(': heartbeat\n\n'),20000);req.raw.on('close',()=>{clearInterval(timer);wb.off('change',onChange)});
  });
  app.post('/api/projects',async req=>wb.registerProject(req.body as Row));
  app.post<{Body:Row}>('/api/projects/authorize',async req=>{
    const r=authorizeProject(config,req.body,real=>wb.registerProject({...req.body,path:real,create:false}));
    if(r.added)wb.transaction(()=>wb.audit('user','add_authorized_root',r.added!,{roots:r.roots}));
    return r.value;
  });
  app.post<{Params:{id:string}}>('/api/projects/:id/edit',async req=>wb.editProject(req.params.id,req.body));
  app.post<{Params:{id:string};Body:Row}>('/api/projects/:id/paths',async req=>wb.addProjectPath(req.params.id,req.body.path,req.body.version));
  app.get<{Params:{id:string};Querystring:Row}>('/api/projects/:id/context',async(req,res)=>{const c=wb.projectContext(req.params.id);if(req.query.download){res.header('Content-Disposition',disposition(String(c.project.name)+'-项目上下文.json'));res.type('application/json; charset=utf-8');return JSON.stringify(c,null,2)}return c});
  app.post<{Params:{id:string}}>('/api/projects/:id/open',async req=>{const p=wb.get('projects',req.params.id);const folder=safePath(p.source_root||p.paths[0],config.authorizedRoots);assert(process.platform==='win32','当前系统未实现目录打开');spawn('explorer.exe',[folder],{shell:false,windowsHide:true,detached:true,stdio:'ignore'}).unref();return {opened:true}});
  app.post('/api/diagrams',async req=>archify.generate(req.body));
  app.get<{Params:{id:string};Querystring:Row}>('/api/diagrams/:id/content',async(req,res)=>{
    const {row,bytes}=archify.content(req.params.id);
    res.header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.type('text/html; charset=utf-8');if(req.query.download)res.header('Content-Disposition',disposition(row.title+'.html'));return bytes;
  });
  app.post('/api/requests',async req=>wb.request(req.body as Row));
  app.post<{Params:{id:string}}>('/api/requests/:id/edit',async req=>saveRequest(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/requests/:id/delete',async req=>deleteRequest(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/projects/:id/archive',async req=>archiveProject(wb,req.params.id,req.body));
  app.get<{Params:{id:string}}>('/api/requests/:id/entry',async req=>wb.planningEntry(req.params.id));
  app.post('/api/plans',async req=>wb.submitPlan(req.body,'page_import','user'));
  app.get<{Params:{id:string};Querystring:Row}>('/api/projects/:id/relations',async req=>graph(req.params.id,String(req.query.view||'tasks'),req.query.history!=='false'));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/continue',async req=>{
    assert(!req.headers.authorization,'继续执行请使用工作台用户页面，Agent不能代为确认',403);
    if(!req.body.request_id)return prepareContinuation(wb,{...req.body,task_id:req.params.id});
    const input=dispatchBody(req.params.id,req.body),previous=wb.all('runs').find(r=>r.task_id===req.params.id&&r.continuations?.some((c:Row)=>c.request_id===req.body.request_id));
    if(previous)input.run_id=previous.id;
    return agents.continueRun(input,{role:'user',source:'page'});
  });
  app.get<{Params:{id:string}}>('/api/tasks/:id',async req=>({...wb.taskDetail(req.params.id),agent_jobs:agents.taskJobs(req.params.id)}));
  app.post<{Params:{id:string}}>('/api/tasks/:id/agent-cancel',async req=>{assert(!req.headers.authorization,'此操作仅供用户页面使用',403);return agents.cancelJob(req.params.id,req.body)});
  // Deliberately UI-only: runner/reviewer/manager MCP cannot attest that a user inspected an orphan.
  app.post<{Params:{id:string}}>('/api/tasks/:id/agent-recovery',async req=>{assert(!req.headers.authorization,'进程恢复须由用户确认，Agent不能代为声明',403);return agents.confirmProcessEnded(req.params.id,req.body)});
  app.post<{Params:{id:string}}>('/api/tasks/:id/reply',async req=>wb.saveReply(req.params.id,req.body));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/export',async req=>wb.exportOrder(req.params.id,req.body.version,req.body.new_run,req.body.agent_id,req.body.expected_revision,req.body.requested_model));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/action',async req=>wb.manualAction(req.params.id,req.body.action,req.body.revision));
  app.post<{Params:{id:string};Body:Row}>('/api/tasks/:id/accept',async req=>wb.accept(req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/tasks/:id/reject',async req=>rejectAcceptance(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/tasks/:id/rework',async req=>reworkOrder(wb,req.params.id,req.body));
  app.post('/api/receipts',async req=>wb.event(req.body,undefined,'user_imported'));
  app.get<{Params:{id:string}}>('/api/tasks/:id/review-candidates',async req=>reviewCandidates(wb,req.params.id));
  app.post('/api/closeout-orders',async req=>exportCloseoutOrder(wb,req.body));
  app.post('/api/review-orders',async req=>exportReviewOrder(wb,req.body,{role:'user'}));
  app.post('/api/review-receipts',async req=>submitReviewResult(wb,req.body,'user_import'));
  app.post<{Params:{id:string};Body:Row}>('/api/runs/:id/review-feedback',async req=>reviewFeedbackOrder(wb,req.params.id,req.body.revision));
  app.get<{Params:{id:string}}>('/api/reviews/:id/report',async(req,res)=>{const r=wb.get('reviews',req.params.id);assert(r.report_markdown,'这条审查没有附报告',404);assert(hash(r.report_markdown)===r.report_sha256,'报告内容校验失败',409);return res.type('text/markdown; charset=utf-8').header('Content-Disposition',disposition('审查报告.md')).send(r.report_markdown)});
  app.post('/api/reviews',async req=>wb.review(req.body as Row));
  app.post<{Params:{id:string}}>('/api/reviews/:id/revoke',async req=>revokeReview(wb,req.params.id,req.body));
  app.post('/api/reviews/grok',async req=>importReview(req.body as Row,{role:'user'}));
  app.get<{Params:{id:string}}>('/api/runs/:id/review-context',async req=>getReviewContext(wb,req.params.id));
  app.post<{Params:{id:string};Body:Row}>('/api/subscriptions/:id/confirm',async req=>wb.confirmSubscription(req.params.id,req.body));
  app.post('/api/subscriptions',async req=>wb.createSubscription(req.body));
  app.post<{Params:{id:string}}>('/api/subscriptions/:id/delete',async req=>wb.deleteSubscription(req.params.id,req.body));
  app.post('/api/memories',async req=>wb.memory(req.body as Row));
  app.post<{Params:{table:string;id:string};Body:Row}>('/api/baseline/:table/:id',async req=>wb.updateBaseline(req.params.table,req.params.id,req.body.changes,req.body.version));
  app.post('/api/backup',async()=>createBackup(wb));
  app.post<{Body:Row}>('/api/settings/roots',async req=>{const r=addAuthorizedRoot(config,req.body?.path);if(r.added)wb.transaction(()=>wb.audit('user','add_authorized_root',r.added!,{roots:r.roots}));return r});
  app.get<{Querystring:Row}>('/api/history',async req=>wb.history(req.query));
  app.get<{Querystring:Row}>('/api/history/external',async req=>integrations.search(req.query));
  app.post<{Params:{id:string};Body:Row}>('/api/sessions/:id/link',async req=>wb.linkSession(req.params.id,req.body.run_id));
  app.get<{Params:{id:string};Querystring:Row}>('/api/sessions/:id/messages',async req=>integrations.sessionPage(req.params.id,Number(req.query.from)||0));
  app.post<{Params:{id:string};Body:Row}>('/api/integrations/:id/refresh',async req=>integrations.refresh(req.params.id,req.body?.cursor||''));
  app.post<{Params:{provider:string};Body:Row}>('/api/quota-cache/:provider',async req=>editQuotaCache(wb,req.params.provider,req.body));
  app.post('/api/manual-points/workbuddy',async req=>editWorkBuddyPoints(wb,req.body));
  app.post('/api/agents',async req=>saveAgent(wb,null,req.body));
  app.post<{Params:{id:string}}>('/api/agents/:id/edit',async req=>saveAgent(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/agents/:id/delete',async req=>archiveAgent(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/agents/:id/restore',async req=>archiveAgent(wb,req.params.id,req.body,true));
  app.post('/api/quotas',async req=>saveQuota(wb,null,req.body));
  app.post('/api/quotas/hide-source',async req=>saveQuota(wb,null,req.body,true));
  app.post<{Params:{id:string}}>('/api/quotas/:id/edit',async req=>saveQuota(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/quotas/:id/delete',async req=>archiveQuota(wb,req.params.id,req.body));
  app.post<{Params:{id:string}}>('/api/quotas/:id/restore',async req=>archiveQuota(wb,req.params.id,req.body,true));
  app.post<{Params:{id:string}}>('/api/artifacts/:id/open-folder',async req=>{
    const v=z.object({target:z.enum(['original','archive'])}).strict().parse(req.body);
    return openArtifactFolder(wb,req.params.id,v.target,revealArtifact);
  });
  app.get<{Params:{id:string};Querystring:Row}>('/api/artifacts/:id/content',async(req,res)=>{
    const a=wb.get('artifacts',req.params.id);const file=safePath(a.archive_path,[path.join(config.dataDir,'artifacts')]);const bytes=readBounded(file,20*1024*1024);assert(hash(bytes)===a.sha256,'归档产物完整性校验失败',409);
    const types:Record<string,string>={'.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8','.csv':'text/plain; charset=utf-8','.diff':'text/plain; charset=utf-8','.patch':'text/plain; charset=utf-8','.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    res.header('Content-Security-Policy',"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.type(types[a.extension]||'application/octet-stream');if(req.query.download||!types[a.extension])res.header('Content-Disposition',disposition(a.label));return bytes;
  });
  app.post<{Params:{tool:string};Body:Row}>('/api/mcp/:tool',async req=>{
    const token=req.headers.authorization?.replace(/^Bearer /,'')||'';let role:string|undefined,scope:string|undefined;if(same(token,wb.keys.manager))role='manager';else if(same(token,wb.keys.planner))role='planner';else if(same(token,wb.keys.chat_planner))role='chat_planner';else if(typeof req.body?.run_id==='string'){const rid=req.body.run_id;assert(/^R-[a-f0-9-]{36}$/.test(rid),'MCP Run ID 无效',401);const run=wb.maybe('runs',rid);if(run){const f=path.join(config.dataDir,'run-keys',rid+'.json');if(fs.existsSync(f)&&same(token,JSON.parse(fs.readFileSync(f,'utf8')).token)){role='runner';scope=rid}}}if(!role&&typeof req.body?.review_id==='string'&&reviewId.safeParse(req.body.review_id).success){const aid=req.body.review_id;const file=safePath(path.join(config.dataDir,'review-keys',aid+'.json'),[config.dataDir],true);if(wb.maybe('review_assignments',aid)&&fs.existsSync(file)&&same(token,JSON.parse(fs.readFileSync(file,'utf8')).token)){role='reviewer';scope=aid}}assert(role,'MCP 认证失败',401);
    const tool=req.params.tool,b=req.body;if(role==='chat_planner'){assert(['get_chat_planning_context','submit_task_plan'].includes(tool),'聊天规划连接仅可读取需求规划包和提交计划',403);if(tool==='get_chat_planning_context')return chatPlanningContext(wb,b.request_id);const q=wb.get('requests',b.request_id);assert(q.workflow_kind!=='small'||Array.isArray(b.tasks)&&b.tasks.length<=3,'小需求最多三项');return wb.submitPlan(b,'chat_mcp',role)}const isReport=['report_run_event','submit_run_result'].includes(tool);if(role==='runner')assert(isReport||['register_delegation','report_delegation','dispatch_review','continue_run','get_agent_job','read_run_context_file','wait_run_update','complete_run_closeout','get_run_context','ack_run_context','report_run_activity','report_runtime_deployment','get_deployment_context','report_deployment_evidence','report_review_handoff','get_closeout_context','export_closeout_order','get_run_feedback','get_review_context','submit_grok_review','get_review_candidates','export_review_order'].includes(tool),'执行凭据仅可回报或查询自己的 Run',403);
    if(role==='reviewer'){
      assert(b.review_id===scope&&['get_review_assignment','ack_review_context','read_review_context_file','report_review_started','submit_review_result'].includes(tool),'审查凭据仅可操作本审查单',403);
      if(tool==='get_review_assignment')return reviewContext(wb,b,reviewAssignmentContext(wb,scope!));
      if(tool==='ack_review_context')return acknowledgeReviewContext(wb,b,reviewAssignmentContext(wb,scope!));
      if(tool==='read_review_context_file')return readReviewContextFile(wb,b,reviewAssignmentContext(wb,scope!));
      if(tool==='report_review_started')return startReview(wb,b);
      return submitReviewResult(wb,b,'reviewer:'+scope);
    }
    if(tool==='import_execution_receipt')throw new DomainError('执行回报请使用本 Run 的独立连接；远程回执由用户在页面导入',403);
    if(['get_deployment_context','report_deployment_evidence'].includes(tool)){assert(role==='runner'&&scope===b.run_id,'部署回执仅供本Run执行者处理',403);return tool==='get_deployment_context'?getDeploymentEvidenceContext(wb,b):reportDeploymentEvidence(wb,b);}
    if(Object.hasOwn(managementTools,tool)||Object.hasOwn(managementReadTools,tool)){assert(role==='manager','请使用本地主会话管理连接办理用户交代的操作',403);return Object.hasOwn(managementTools,tool)?manage(wb,managementServices,tool,b):readManagement(wb,managementServices,tool,b)}
    if(['get_review_assignment','ack_review_context','read_review_context_file','report_review_started','submit_review_result'].includes(tool))throw new DomainError('请使用独立审查者凭据回传；作者和规划者不能代填结论',403);
    if(['wait_run_update','complete_run_closeout','get_run_context','ack_run_context','report_run_activity','report_runtime_deployment'].includes(tool)){
      if(role==='runner')assert(scope===b.run_id,'禁止跨执行访问',403);
      if(tool==='wait_run_update')return waitRunUpdate(wb,b);
      if(tool==='get_run_context')return executionContext(wb,b);
      assert(role==='runner'&&scope===b.run_id,'该操作必须使用本Run凭据',403);
      if(tool==='complete_run_closeout')return finishRunCloseout(wb,b);
      if(tool==='ack_run_context')return acknowledgeContext(wb,b);
      if(tool==='report_run_activity')return reportActivity(wb,b);
      return reportDeployment(wb,b);
    }
    if(tool==='register_delegation'||tool==='report_delegation'){assert(role==='runner'&&scope===b.run_id,'委派登记与回报限本Run执行者',403);return tool==='register_delegation'?registerDelegation(wb,b):reportDelegation(wb,b)}
    if(tool==='get_chat_planning_context'){assert(['manager','planner'].includes(role),'仅供规划者读取',403);return chatPlanningContext(wb,b.request_id)}
    if(tool==='get_agent_clients'){assert(['planner','manager'].includes(role),'客户端规划信息仅供大脑使用',403);return agents.capabilities()}
    if(tool==='dispatch_run'){assert(false,'外部主执行只能由用户在工作台页面启动；Agent不能代为启动',403);}
    if(tool==='dispatch_review'||tool==='continue_run'||tool==='get_agent_job'||tool==='read_run_context_file'){
      if(role==='runner')assert(scope===b.run_id,'禁止跨执行调用',403);
      if(tool==='dispatch_review')return agents.dispatchReview(b);
      if(tool==='continue_run')return agents.continueRun(b,{role:role==='runner'?'runner':role==='manager'?'manager':'planner',source:'mcp'});
      if(tool==='get_agent_job')return agents.getJob(b);
      return readRunContextFile(wb,b);
    }
    if(tool==='get_project_graph')return graph(b.project_id,b.view||'tasks',b.include_history!==false);
    if(tool==='report_review_handoff'){assert(role==='runner'&&scope===b.run_id,'只有本次执行者可以回报直接调用阻碍',403);return reportReviewHandoff(wb,b)}
    if(tool==='get_closeout_context'||tool==='export_closeout_order'){if(role==='runner')assert(scope===b.run_id,'禁止跨执行操作收尾',403);if(tool==='get_closeout_context')return b.detail==='full'?getCloseoutContext(wb,closeoutInput.parse(b).run_id):briefCloseout(getCloseoutContext(wb,closeoutInput.parse(b).run_id));return exportCloseoutOrder(wb,b)}
    if(tool==='get_review_candidates'){const v=z.object({task_id:z.string(),run_id:z.string().optional()}).strict().parse(b);if(role==='runner')assert(wb.get('runs',scope!).task_id===v.task_id,'禁止跨任务查询',403);const result=reviewCandidates(wb,v.task_id),clients=await readClientCapabilities(config.dataDir);return {...result,candidates:result.candidates.map(a=>({...a,client_capability:clients.find(c=>c.kind===agentClientKind(wb.get('agents',a.agent_id)))||a.client_capability}))}}
    if(tool==='export_review_order'){if(role==='runner')assert(scope===b.run_id,'禁止跨执行安排审查',403);return exportReviewOrder(wb,b,{role:role==='runner'?'runner':'planner',id:role==='runner'?'runner:'+scope:'planner'})}
    if(tool==='get_review_context'){const v=reviewContextInput.parse(b);if(role==='runner')assert(scope===v.run_id,'禁止跨执行读取审查',403);return getReviewContext(wb,v.run_id)}
    if(tool==='submit_grok_review'){if(role==='runner')assert(scope===b.run_id,'禁止跨执行登记审查',403);return importReview(b,{role:role==='runner'?'runner':'planner',id:role==='runner'?'runner:'+scope:'planner'})}
    if(tool==='get_run_feedback'){const v=z.object({run_id:z.string().regex(/^R-[a-f0-9-]{36}$/)}).strict().parse(b);if(role==='runner')assert(scope===v.run_id,'禁止跨执行查询回答',403);return wb.runFeedback(v.run_id)}
    if(tool==='create_project_diagram')return archify.generate(b);
    if(tool==='get_dispatch_context'){const clients=await readClientCapabilities(config.dataDir);const context={...wb.dispatchContext(),client_capabilities:clients};return b.detail==='full'?context:dispatchBrief(context,b.project_id)}
    if(tool==='get_project_context')return wb.projectContext(b.project_id,b.detail||'brief');
    if(tool==='search_execution_history')return wb.history(b);
    if(tool==='submit_task_plan')return wb.submitPlan(b,role==='manager'?'manager_mcp':'planner_mcp',role);
    if(tool==='export_execution_order')return wb.exportOrder(b.task_id,b.expected_version,b.new_run,b.agent_id,b.expected_revision,b.requested_model);
    if(isReport){assert(role==='runner'&&scope===b.run_id,'执行回报必须使用该 Run 的独立凭据',403);if(tool==='submit_run_result')assert(b.event_type==='submitted','结果工具仅接收 submitted');return wb.event(b,scope,'mcp_'+role)}
    throw new DomainError('工具不在允许清单',403);
  });
  const dist=path.join(config.root,'dist');if(fs.existsSync(dist)){await app.register(fastifyStatic,{root:dist,wildcard:false});app.setNotFoundHandler((req,res)=>(req.url.startsWith('/api/')||path.extname(req.url.split('?')[0]))?res.code(404).send({error:'接口不存在'}):res.type('text/html').send(fs.readFileSync(path.join(dist,'index.html'))))}
  let receiptTimer:NodeJS.Timeout|undefined;if(background){agents.start();wb.scanReceipts();receiptTimer=setInterval(()=>wb.scanReceipts(),1500);receiptTimer.unref();integrations.start()}
  app.addHook('onClose',async()=>{clearInterval(receiptTimer);integrations.stop();await agents.close();await archify.close();wb.close()});return {app,wb,integrations,agents};
}

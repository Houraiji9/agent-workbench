import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,setup,event,taskInput} from './agent-routing-fixture.ts';
import {createApp} from '../src/server/app.ts';
import {exportReviewOrder,updateReviewMember} from '../src/core/review-workflow.ts';
import type {Workbench} from '../src/core/workbench.ts';
import type {Row} from '../src/core/schema.ts';
import type {Launcher} from '../src/core/agent-orchestration.ts';
import type {AgentInvocationOptions,ClientKind,ClientRecord} from '../src/core/agent-clients.ts';

async function apiFixture(){const f=fixture();f.wb.close();return {...f,...await createApp(f.config,{background:false})}}
function keys(dataDir:string,kind:'run'|'review',id:string){return JSON.parse(fs.readFileSync(path.join(dataDir,kind+'-keys',id+'.json'),'utf8')).token as string}
function contract(wb:Workbench,root:string,s:ReturnType<typeof setup>){
  fs.writeFileSync(path.join(root,'allowed.txt'),'HIDDEN_FIRST_LINE\n合同内正文\nHIDDEN_LAST_LINE\n');
  fs.writeFileSync(path.join(root,'outside.txt'),'UNAUTHORIZED_FIXTURE_CONTENT');
  fs.writeFileSync(path.join(root,'oversized.txt'),'大'.repeat(500));
  fs.writeFileSync(path.join(root,'.env'),'SYNTHETIC_PRIVATE_CONTENT');
  const t=wb.get('tasks',s.tid);t.context_contract={required:[{path:'allowed.txt',range:{start_line:2,end_line:2}},{path:'oversized.txt'}],supplemental:[{path:'outside.txt',reason:'仅当必读正文没有说明失败原因'}],output_dir:'output',max_bytes:1024};wb.put('tasks',t,{project_id:t.project_id});
}
function deliver(wb:Workbench,root:string,s:ReturnType<typeof setup>){
  assert.equal(wb.event(event(root,s.tid,s.rid,1)).disposition,'applied');
  assert.equal(wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离接口测试交付，只验证权限边界，不是真实模型执行或独立审查。'})).disposition,'applied');
  return exportReviewOrder(wb,{run_id:s.rid,reviewer_id:'zcode',expected_revision:wb.get('tasks',s.tid).revision,reason:'隔离API权限回归测试'},{role:'user'});
}

test('runner只能派审/查询本Run，不能读取全机客户端、派执行或查询其他job',async()=>{
  const f=await apiFixture();try{
    const a=setup(f.wb,f.root),b=setup(f.wb,f.root);contract(f.wb,f.root,a);
    const token=keys(f.config.dataDir,'run',a.rid),host='127.0.0.1:'+f.config.port;
    const call=(tool:string,body:Row,key=token)=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+key},payload:body});
    const dispatch={run_id:a.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',a.tid).revision};
    assert.equal((await call('get_agent_clients',{run_id:a.rid})).statusCode,403);
    assert.equal((await call('dispatch_run',dispatch)).statusCode,403);
    assert.equal((await f.app.inject({url:'/api/agent-clients',headers:{host,authorization:'Bearer '+token}})).statusCode,401);
    const context=await call('get_run_context',{run_id:a.rid});assert.equal(context.statusCode,200);assert.equal(context.json().task_revision,f.wb.get('tasks',a.tid).revision);assert(!Object.hasOwn(context.json(),'client_capabilities'));
    for(const tool of ['get_run_context','read_run_context_file','dispatch_review','continue_run','recover_native_review']){
      const result=await call(tool,{...dispatch,run_id:b.rid,path:'allowed.txt'});assert([401,403].includes(result.statusCode),tool+' must reject another Run');
    }
    const jobs=[a,b].map(s=>({id:'AJ-'+crypto.randomUUID(),task_id:s.tid,run_id:s.rid,role:'execution',phase:'execution',route:{client:'dsh',provider:'fixture',model:'fixture'},status:'completed',revision:1,session_mode:'new'}));
    for(const job of jobs)f.wb.put('agent_jobs',job,{run_id:job.run_id});
    assert.equal((await call('get_agent_job',{run_id:a.rid,job_id:jobs[0].id,timeout_ms:0})).statusCode,200);
    assert.equal((await call('get_agent_job',{run_id:a.rid,job_id:jobs[1].id,timeout_ms:0})).statusCode,403);
    assert.equal((await call('recover_native_review',{run_id:a.rid,job_id:jobs[1].id})).statusCode,403);
    assert.equal((await call('recover_native_review',{run_id:a.rid,job_id:jobs[0].id})).statusCode,403);
    const noRoute=await call('dispatch_review',dispatch);assert.equal(noRoute.statusCode,409);assert.equal(f.wb.all('agent_jobs').length,2);
    const spoof=await call('report_run_activity',{run_id:a.rid,event_id:'identity-spoof',event_type:'started',data:{identity:'zcode',message:'伪造本人身份'}});assert.equal(spoof.statusCode,400);assert.equal(f.wb.get('runs',a.rid).has_started,false);
  }finally{await f.app.close()}
});

test('runner文件接口执行片段、条件补读、预算和保护路径边界',async()=>{
  const f=await apiFixture();try{
    const s=setup(f.wb,f.root);contract(f.wb,f.root,s);const token=keys(f.config.dataDir,'run',s.rid),host='127.0.0.1:'+f.config.port;
    const read=(body:Row)=>f.app.inject({method:'POST',url:'/api/mcp/read_run_context_file',headers:{host,authorization:'Bearer '+token},payload:{run_id:s.rid,...body}});
    assert.equal((await read({path:'allowed.txt'})).statusCode,403);
    assert.equal((await read({path:'allowed.txt',range:{start_line:1,end_line:2}})).statusCode,403);
    const selected=await read({path:'allowed.txt',range:{start_line:2,end_line:2}});assert.equal(selected.statusCode,200);assert.equal(selected.json().content,'合同内正文\n');assert(!selected.body.includes('HIDDEN_'));assert.equal(selected.json().record.status,'delivered');assert.equal(selected.json().usage.token_count,null);
    const conditional=await read({path:'outside.txt'});assert.equal(conditional.statusCode,403);assert(!conditional.body.includes('UNAUTHORIZED_FIXTURE_CONTENT'));
    assert.equal((await read({path:'outside.txt',reason:'随意补读'})).statusCode,403);
    assert.equal((await read({path:'outside.txt',reason:'仅当必读正文没有说明失败原因'})).statusCode,200);
    assert.equal((await read({path:'oversized.txt'})).statusCode,413);
    const link=path.join(f.root,'ledger-link');fs.symlinkSync(f.config.dataDir,link,'junction');
    for(const file of ['.env',path.join(f.config.dataDir,'keys.json'),'ledger-link/keys.json',path.join(f.root,'..','outside.txt')]){
      const result=await read({path:file});assert.notEqual(result.statusCode,200);assert(!result.body.includes('SYNTHETIC_PRIVATE_CONTENT'));assert(!result.body.includes(f.wb.keys.planner));assert(!result.body.includes(f.wb.keys.manager));
    }
    assert.equal(f.wb.get('runs',s.rid).context_reads.length,2);
  }finally{await f.app.close()}
});

test('reviewer仅能使用当前RA合同，不能冒充身份、访问其他RA或代执行',async()=>{
  const f=await apiFixture();try{
    const a=setup(f.wb,f.root),b=setup(f.wb,f.root);contract(f.wb,f.root,a);contract(f.wb,f.root,b);const first=deliver(f.wb,f.root,a),second=deliver(f.wb,f.root,b);
    const token=keys(f.config.dataDir,'review',first.review_id),runner=keys(f.config.dataDir,'run',a.rid),host='127.0.0.1:'+f.config.port;
    const call=(tool:string,body:Row,key=token)=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+key},payload:body});
    assert.equal((await call('get_review_assignment',{review_id:second.review_id})).statusCode,401);
    assert.equal((await call('read_review_context_file',{review_id:second.review_id,path:'allowed.txt',range:{start_line:2,end_line:2}})).statusCode,401);
    for(const tool of ['get_agent_clients','get_dispatch_context','get_run_context','dispatch_review','continue_run','read_run_context_file'])assert.equal((await call(tool,{review_id:first.review_id,run_id:a.rid})).statusCode,403);
    assert.equal((await call('report_review_started',{review_id:first.review_id,identity:'codex'})).statusCode,403);assert.equal(f.wb.get('review_assignments',first.review_id).status,'awaiting_dispatch');
    assert.equal((await call('report_review_started',{review_id:first.review_id,identity:'zcode',session_id:'isolated-review-session'})).statusCode,200);
    const context=await call('get_review_assignment',{review_id:first.review_id});assert.equal(context.statusCode,200);assert.equal(context.json().task_id,a.tid);assert(!JSON.stringify(context.json().context).includes(b.tid));
    assert.equal((await call('ack_review_context',{review_id:first.review_id,context_hash:context.json().context_hash,session_id:'isolated-review-session'})).statusCode,200);
    const read=await call('read_review_context_file',{review_id:first.review_id,path:'allowed.txt',range:{start_line:2,end_line:2}});assert.equal(read.statusCode,200);assert.equal(read.json().content,'合同内正文\n');
    for(const body of [{path:'allowed.txt'},{path:'outside.txt'},{path:'.env'},{path:path.join(f.config.dataDir,'keys.json')}])assert.equal((await call('read_review_context_file',{review_id:first.review_id,...body})).statusCode,403);
    for(const key of [runner,f.wb.keys.planner,f.wb.keys.manager])assert.equal((await call('read_review_context_file',{review_id:first.review_id,run_id:a.rid,path:'allowed.txt'},key)).statusCode,403);
    const replacement=updateReviewMember(f.wb,{run_id:a.rid,review_id:first.review_id,action:'replace',reviewer_id:'claude',expected_revision:f.wb.get('tasks',a.tid).revision,reason:'隔离测试撤销旧审查权限'},{role:'user'});assert('review_id' in replacement);assert.notEqual(replacement.review_id,first.review_id);
    assert.equal((await call('read_review_context_file',{review_id:first.review_id,path:'allowed.txt',range:{start_line:2,end_line:2}})).statusCode,409);
  }finally{await f.app.close()}
});

test('新增派发和客户端配置接口要求页面会话及CSRF，Bearer仍受Host/Origin限制',async()=>{
  const f=await apiFixture();try{
    const s=setup(f.wb,f.root),host='127.0.0.1:'+f.config.port,token=keys(f.config.dataDir,'run',s.rid);
    const boot=await f.app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(boot.headers['set-cookie']).split(';')[0],csrf=boot.json().csrf;
    const dispatch={request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision};
    for(const url of ['/api/tasks/'+s.tid+'/dispatch','/api/tasks/'+s.tid+'/dispatch-review','/api/agent-clients/override']){
      const body=url.endsWith('override')?{kind:'invalid',executable:'invalid'}:dispatch;
      assert.equal((await f.app.inject({method:'POST',url,headers:{host,authorization:'Bearer '+token},payload:body})).statusCode,401);
      assert.equal((await f.app.inject({method:'POST',url,headers:{host,cookie},payload:body})).statusCode,403);
      assert.equal((await f.app.inject({method:'POST',url,headers:{host,cookie,'x-workbench-csrf':'invalid'},payload:body})).statusCode,403);
      assert.equal((await f.app.inject({method:'POST',url,headers:{host,cookie,'x-workbench-csrf':csrf},payload:body})).statusCode,url.endsWith('override')?400:409);
    }
    for(const extra of [{host:'evil.example'}, {origin:'https://evil.example'}, {'sec-fetch-site':'cross-site'}])assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/get_run_context',headers:{host,authorization:'Bearer '+token,...extra},payload:{run_id:s.rid}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/get_run_context',headers:{host},payload:{run_id:s.rid}})).statusCode,401);
    assert.equal(f.wb.all('agent_jobs').length,0);assert.equal(f.wb.all('review_assignments').length,0);
  }finally{await f.app.close()}
});

// R2 fixtures remain under the explicit handoff folder for review; no production clients run.
import {fileURLToPath as recoveryApiFileURLToPath} from 'node:url';
import {Workbench as RecoveryApiWorkbench} from '../src/core/workbench.ts';
import {seedTestData as recoveryApiSeed} from './fixtures.ts';
async function recoveryApiFixture() {
  const evidence = process.env.AGENT_ROUTING_R2_ROOT || path.resolve(path.dirname(recoveryApiFileURLToPath(import.meta.url)), '../../..', '工程/docs/handoff/agent-routing-20261025/r2');
  fs.mkdirSync(evidence, {recursive: true});
  const root = fs.mkdtempSync(path.join(evidence, 'api-fixture-'));
  const config = {root, dataDir: path.join(root, 'data'), port: 14317, timezone: 'America/Los_Angeles', authorizedRoots: [root], integrations: {tokenMonitor: {baseUrl: ''}, agentsView: {baseUrl: ''}}};
  recoveryApiSeed(new RecoveryApiWorkbench(config)).close();
  return {root, config, ...await createApp(config, {background: false})};
}
function routedRecoverySetup(wb: Workbench, root: string, model: string): ReturnType<typeof setup> {
  const agent = wb.get('agents', 'codex'); agent.preset_id = 'claude-code'; wb.put('agents', agent);
  const q = wb.request({project_id: 'P-workbench', text: '测试数据：验证回执生命周期'});
  const plan = {schema_version: 1, plan_id: 'plan-' + crypto.randomUUID(), request_id: q.id, expected_version: 1, tasks: [taskInput(root)]};
  const submitted = wb.submitPlan(plan), tid = submitted.task_ids[0], task = wb.get('tasks', tid);
  // The initial Run freezes its execution contract at export time.
  task.execution_route = {client: 'claude', model};
  task.context_contract = {required: [], supplemental: [], output_dir: path.join(root, 'outputs'), max_bytes: 65536};
  wb.put('tasks', task, {project_id: task.project_id});
  const order = wb.exportOrder(tid, 1);
  return {q, plan, tid, rid: order.run_id, order};
}
function recoveryApiJob(f: Awaited<ReturnType<typeof recoveryApiFixture>>, s: ReturnType<typeof setup>, extra: Row = {}) {
  const job = {id: 'AJ-' + crypto.randomUUID(), task_id: s.tid, run_id: s.rid, role: 'execution', phase: 'execution', route: {client: 'claude', model: 'synthetic'}, status: 'interrupted', revision: 1, created_at: new Date().toISOString(), session_mode: 'new', reason: '隔离API遗留调用', process_may_be_running: true, ...extra};
  f.wb.put('agent_jobs', job, {run_id: s.rid}); return job;
}
async function recoveryPage(f: Awaited<ReturnType<typeof recoveryApiFixture>>) {
  const host = '127.0.0.1:' + f.config.port, boot = await f.app.inject({url: '/api/bootstrap', headers: {host}});
  return {host, cookie: String(boot.headers['set-cookie']).split(';')[0], 'x-workbench-csrf': boot.json().csrf as string};
}
function recoveryBody(f: Awaited<ReturnType<typeof recoveryApiFixture>>, tid: string, jobId: string) {return {job_id: jobId, expected_revision: f.wb.get('tasks', tid).revision, reason: '隔离API测试：用户已核实原客户端是否结束'};}

test('R2 API：取消和恢复仅允许页面会话加CSRF，所有scoped身份均拒绝', async () => {
  const f = await recoveryApiFixture(); try {
    const s = setup(f.wb, f.root), review = deliver(f.wb, f.root, s), headers = await recoveryPage(f);
    const cancel = recoveryApiJob(f, s, {status: 'queued', process_may_be_running: false}), recovery = recoveryApiJob(f, s);
    const tokens = [keys(f.config.dataDir, 'run', s.rid), keys(f.config.dataDir, 'review', review.review_id), f.wb.keys.planner, f.wb.keys.manager];
    for (const [suffix, job] of [['agent-cancel', cancel], ['agent-recovery', recovery]] as const) {
      const url = '/api/tasks/' + s.tid + '/' + suffix, body = {...recoveryBody(f, s.tid, job.id), ...(suffix === 'agent-recovery' ? {confirmed: true} : {})};
      assert.equal((await f.app.inject({method: 'POST', url, headers: {host: headers.host}, payload: body})).statusCode, 401);
      assert.equal((await f.app.inject({method: 'POST', url, headers: {host: headers.host, cookie: headers.cookie}, payload: body})).statusCode, 403);
      assert.equal((await f.app.inject({method: 'POST', url, headers: {...headers, 'x-workbench-csrf': 'invalid'}, payload: body})).statusCode, 403);
      for (const token of tokens) {
        assert.equal((await f.app.inject({method: 'POST', url, headers: {host: headers.host, authorization: 'Bearer ' + token}, payload: body})).statusCode, 401);
        assert.equal((await f.app.inject({method: 'POST', url, headers: {...headers, authorization: 'Bearer ' + token}, payload: body})).statusCode, 403, suffix + ': mixed scoped identity must not become a user action');
      }
    }
    assert.equal(f.wb.get('agent_jobs', cancel.id).status, 'queued'); assert.equal(f.wb.get('agent_jobs', recovery.id).process_may_be_running, true);
    assert.equal(f.wb.db.prepare("SELECT count(*) AS total FROM audit WHERE action IN ('cancel_agent_job','confirm_agent_process_ended')").get()!.total, 0);
  } finally {await f.app.close();}
});

test('R2 API：跨Task、旧revision和未明确确认不能改变调用，合法恢复保留user_attested审计', async () => {
  const f = await recoveryApiFixture(); try {
    const a = setup(f.wb, f.root), b = setup(f.wb, f.root), headers = await recoveryPage(f);
    const missing = recoveryApiJob(f, a), queued = recoveryApiJob(f, a, {status: 'queued', process_may_be_running: false}), other = recoveryApiJob(f, b);
    const call = (tid: string, suffix: string, body: Row) => f.app.inject({method: 'POST', url: '/api/tasks/' + tid + '/' + suffix, headers, payload: body});
    for (const [suffix, job] of [['agent-cancel', queued], ['agent-recovery', missing]] as const) {
      const body = {...recoveryBody(f, a.tid, job.id), ...(suffix === 'agent-recovery' ? {confirmed: true} : {})};
      assert.equal((await call(b.tid, suffix, {...body, expected_revision: f.wb.get('tasks', b.tid).revision})).statusCode, 403);
      assert.equal((await call(a.tid, suffix, {...body, expected_revision: 1})).statusCode, 409);
    }
    for (const patch of [{}, {confirmed: false}, {confirmed: 'true'}]) assert.equal((await call(a.tid, 'agent-recovery', {...recoveryBody(f, a.tid, missing.id), ...patch})).statusCode, 400);
    assert.equal(f.wb.get('agent_jobs', missing.id).process_may_be_running, true); assert.equal(f.wb.get('agent_jobs', queued.id).status, 'queued');
    const detail = await f.app.inject({url: '/api/tasks/' + a.tid, headers}); assert.equal(detail.statusCode, 200);
    assert.deepEqual(new Set(detail.json().agent_jobs.map((j: Row) => j.job_id)), new Set([missing.id, queued.id])); assert(!detail.json().agent_jobs.some((j: Row) => j.job_id === other.id));
    const recovered = await call(a.tid, 'agent-recovery', {...recoveryBody(f, a.tid, missing.id), confirmed: true});
    assert.equal(recovered.statusCode, 200); assert.equal(recovered.json().status, 'interrupted'); assert.equal(recovered.json().recovery_required, false); assert.equal(recovered.json().process_end_evidence, 'user_attested');
    const audit = f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='confirm_agent_process_ended' AND entity_id=?").get(missing.id) as {actor: string; data: string};
    assert.equal(audit.actor, 'user'); assert.equal(JSON.parse(audit.data).confirmed, true); assert.equal(JSON.parse(audit.data).previous_pid, null);
    const cancelled = await call(a.tid, 'agent-cancel', recoveryBody(f, a.tid, queued.id)); assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().status, 'interrupted');
    assert.equal((await call(a.tid, 'agent-cancel', recoveryBody(f, a.tid, queued.id))).statusCode, 200);
    assert.equal(f.wb.db.prepare("SELECT count(*) AS total FROM audit WHERE action='cancel_agent_job' AND entity_id=?").get(queued.id)!.total, 1);
    assert.equal(f.wb.get('runs', a.rid).has_started, false); assert.equal(f.wb.all('reviews').length, 0); assert.equal(f.wb.get('agent_jobs', other.id).process_may_be_running, true);
  } finally {await f.app.close();}
});

test('R2 API：活PID拒绝用户恢复，历史运行不得通过页面接口按旧PID强杀', async () => {
  const f = await recoveryApiFixture(); try {
    const s = setup(f.wb, f.root), headers = await recoveryPage(f), live = recoveryApiJob(f, s, {process_pid: process.pid}), orphan = recoveryApiJob(f, s, {status: 'running', process_pid: process.pid});
    const recovered = await f.app.inject({method: 'POST', url: '/api/tasks/' + s.tid + '/agent-recovery', headers, payload: {...recoveryBody(f, s.tid, live.id), confirmed: true}});
    assert.equal(recovered.statusCode, 409); assert.match(recovered.json().error, /进程仍存在/); assert.equal(f.wb.get('agent_jobs', live.id).process_may_be_running, true);
    const cancelled = await f.app.inject({method: 'POST', url: '/api/tasks/' + s.tid + '/agent-cancel', headers, payload: recoveryBody(f, s.tid, orphan.id)});
    assert.equal(cancelled.statusCode, 409); assert.match(cancelled.json().error, /未持有|旧PID/); assert.equal(f.wb.get('agent_jobs', orphan.id).status, 'running');
    assert.doesNotThrow(() => process.kill(process.pid, 0)); assert.equal(f.wb.db.prepare("SELECT count(*) AS total FROM audit WHERE action IN ('cancel_agent_job','confirm_agent_process_ended')").get()!.total, 0);
  } finally {await f.app.close();}
});

test('R4 API F1：停止后新Run仅允许纯页面用户，MCP拒绝且页面重放幂等并按user审计', async () => {
  const f = await recoveryApiFixture();
  const launches: Parameters<Launcher>[0][] = [], builds: AgentInvocationOptions[] = [];
  let resolutions = 0;
  const launcher: Launcher = options => new Promise(resolve => {
    launches.push(options);
    options.signal.addEventListener('abort', () => resolve({exitCode: null, signal: 'SIGTERM', processStopped: true}), {once: true});
  });
  Object.assign(f.agents, {launcher, clients: {
    async resolve(_dataDir: string, kind: ClientKind): Promise<ClientRecord> {resolutions++; return {kind, label: 'R4合成客户端', status: 'verified', reason: '隔离API权限回归', checkedAt: new Date().toISOString(), authentication: 'unknown', quota: 'unknown', invocation: 'unknown'};},
    async build(_client: ClientRecord, options: AgentInvocationOptions) {builds.push(options); return {command: 'SYNTHETIC-NOT-EXECUTED', args: []};},
    async discover() {return [];},
  }});
  try {
    const s = routedRecoverySetup(f.wb, f.root, 'synthetic-r4-execution'), headers = await recoveryPage(f);
    assert.equal(f.wb.event(event(f.root, s.tid, s.rid, 1, 'started', {session_id: 'r4-original-session', actual_model: 'synthetic-r4-execution'})).disposition, 'applied');
    const stopped = recoveryApiJob(f, s, {process_may_be_running: false, process_end_evidence: 'owned_child_exit', session_id: 'r4-original-session', actual_model: 'synthetic-r4-execution'});
    const original = f.wb.get('runs', s.rid), eventIds = f.wb.all('events').filter(e => e.run_id === s.rid).map(e => e.id);
    const body = {run_id: s.rid, request_id: crypto.randomUUID(), expected_revision: f.wb.get('tasks', s.tid).revision, fresh_session: true};
    const pageUrl = '/api/tasks/' + s.tid + '/continue';
    const tokens = [keys(f.config.dataDir, 'run', s.rid), f.wb.keys.planner, f.wb.keys.manager];
    const mcp = (token: string) => f.app.inject({method: 'POST', url: '/api/mcp/continue_run', headers: {host: headers.host, authorization: 'Bearer ' + token}, payload: body});
    for (const token of tokens) assert.equal((await mcp(token)).statusCode, 403, 'runner/planner/manager cannot restart an interrupted execution');
    assert.equal((await f.app.inject({method: 'POST', url: pageUrl, headers: {host: headers.host}, payload: body})).statusCode, 401);
    assert.equal((await f.app.inject({method: 'POST', url: pageUrl, headers: {host: headers.host, cookie: headers.cookie}, payload: body})).statusCode, 403);
    assert.equal((await f.app.inject({method: 'POST', url: pageUrl, headers: {...headers, 'x-workbench-csrf': 'invalid'}, payload: body})).statusCode, 403);
    for (const token of tokens) assert.equal((await f.app.inject({method: 'POST', url: pageUrl, headers: {...headers, authorization: 'Bearer ' + token}, payload: body})).statusCode, 403, 'mixed Bearer and page credentials must not become a user action');
    assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.all('agent_jobs').length, 1);
    assert.deepEqual(f.wb.get('runs', s.rid), original); assert.deepEqual(f.wb.get('agent_jobs', stopped.id), stopped);
    assert.equal(resolutions, 0); assert.equal(builds.length, 0); assert.equal(launches.length, 0);
    assert.equal(f.wb.db.prepare("SELECT count(*) AS total FROM audit WHERE action='restart_interrupted_execution'").get()!.total, 0);

    const accepted = await f.app.inject({method: 'POST', url: pageUrl, headers, payload: body});
    assert.equal(accepted.statusCode, 200, accepted.body); const result = accepted.json();
    assert.notEqual(result.run_id, s.rid); assert.equal(result.previous_run_id, s.rid); assert.equal(result.session_mode, 'new');
    const repeated = await f.app.inject({method: 'POST', url: pageUrl, headers, payload: body});
    assert.equal(repeated.statusCode, 200, repeated.body); assert.deepEqual(repeated.json(), result);
    for (const token of tokens) assert.equal((await mcp(token)).statusCode, 403, 'MCP replay cannot reuse a user-only restart receipt');
    const deadline = Date.now() + 4000;
    while (!launches.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resolutions, 1); assert.equal(builds.length, 1); assert.equal(launches.length, 1); assert.equal(builds[0].sessionId, undefined);
    assert.equal(f.wb.all('runs').length, 2); assert.equal(f.wb.all('agent_jobs').length, 2);
    const old = f.wb.get('runs', s.rid);
    assert.equal(old.status, 'cancelled'); assert.equal(old.session_id, original.session_id); assert.equal(old.actual_model, original.actual_model); assert.equal(old.seq, original.seq);
    assert.deepEqual(f.wb.all('events').filter(e => e.run_id === s.rid).map(e => e.id), eventIds); assert.deepEqual(f.wb.get('agent_jobs', stopped.id), stopped);
    const audits = f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='restart_interrupted_execution' AND entity_id=?").all(s.rid) as Array<{actor: string; data: string}>;
    assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'user'); assert.equal(JSON.parse(audits[0].data).job_id, stopped.id);
  } finally {await f.app.close();}
});

test('R5 API：running及停止后仍running时，三种MCP身份不能通过导出新Run加派发绕过', async () => {
  for (const scenario of ['active', 'stopped'] as const) {
    const f = await recoveryApiFixture(), launches: Parameters<Launcher>[0][] = [], builds: AgentInvocationOptions[] = [];
    let resolutions = 0;
    const launcher: Launcher = options => new Promise(resolve => {
      launches.push(options);
      options.signal.addEventListener('abort', () => resolve({exitCode: null, signal: 'SIGTERM', processStopped: true}), {once: true});
    });
    Object.assign(f.agents, {launcher, clients: {
      async resolve(_dataDir: string, kind: ClientKind): Promise<ClientRecord> {resolutions++; return {kind, label: 'R5合成客户端', status: 'verified', reason: '隔离导出与派发边界回归', checkedAt: new Date().toISOString(), authentication: 'unknown', quota: 'unknown', invocation: 'unknown'};},
      async build(_client: ClientRecord, options: AgentInvocationOptions) {builds.push(options); return {command: 'SYNTHETIC-NOT-EXECUTED', args: []};},
      async discover() {return [];},
    }});
    try {
      const s = routedRecoverySetup(f.wb, f.root, 'synthetic-r5-execution'), page = await recoveryPage(f);
      const tokens = {runner: keys(f.config.dataDir, 'run', s.rid), planner: f.wb.keys.planner, manager: f.wb.keys.manager};
      const call = (role: keyof typeof tokens, tool: string, body: Row) => f.app.inject({method: 'POST', url: '/api/mcp/' + tool, headers: {host: page.host, authorization: 'Bearer ' + tokens[role]}, payload: body});
      const initial = await f.app.inject({method:'POST',url:'/api/tasks/'+s.tid+'/dispatch',headers:page,payload:{request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision}});
      assert.equal(initial.statusCode, 200, initial.body); const jobId = initial.json().job_id;
      await r5ApiUntil(() => launches.length === 1, 'R5 基线合成执行应实际进入调用状态');
      const started = await call('runner', 'report_run_event', event(f.root, s.tid, s.rid, 1, 'started', {session_id: 'r5-original-session', actual_model: 'synthetic-r5-execution'}));
      assert.equal(started.statusCode, 200, started.body); assert.equal(started.json().disposition, 'applied');
      if (scenario === 'stopped') {
        const cancel = await f.app.inject({method: 'POST', url: '/api/tasks/' + s.tid + '/agent-cancel', headers: page, payload: {job_id: jobId, expected_revision: f.wb.get('tasks', s.tid).revision, reason: 'R5合成场景：用户停止调用但本人尚未交付'}});
        assert.equal(cancel.statusCode, 200, cancel.body);
        await r5ApiUntil(() => f.wb.get('agent_jobs', jobId).process_may_be_running === false, 'R5 合成停止调用必须确认结束');
        assert.equal(f.wb.get('agent_jobs', jobId).status, 'interrupted');
      } else {assert.equal(f.wb.get('agent_jobs', jobId).status, 'running');}
      const originalTask = f.wb.get('tasks', s.tid), originalRun = f.wb.get('runs', s.rid), originalJob = f.wb.get('agent_jobs', jobId);
      const originalEvents = f.wb.all('events').filter(e => e.run_id === s.rid), originalOrder = fs.readFileSync(originalRun.order_path), originalAuditCount = f.wb.db.prepare('SELECT count(*) AS total FROM audit').get()!.total;
      assert.equal(originalTask.status, 'running'); assert.equal(originalRun.status, 'running'); assert.equal(originalRun.has_started, true);
      for (const role of ['runner', 'planner', 'manager'] as const) {
        const exported = await call(role, 'export_execution_order', {run_id: s.rid, task_id: s.tid, expected_version: originalTask.version, expected_revision: originalTask.revision, new_run: true});
        const dispatchRunId = exported.statusCode === 200 ? exported.json().run_id : f.wb.get('tasks', s.tid).current_run_id;
        const dispatched = await call(role, 'dispatch_run', {run_id: dispatchRunId, request_id: crypto.randomUUID(), expected_revision: f.wb.get('tasks', s.tid).revision, fresh_session: true});
        await new Promise<void>(resolve => setImmediate(resolve));
        console.info('R5 export/dispatch observation ' + JSON.stringify({scenario, role, export_status: exported.statusCode, export_error: exported.json().error ?? null, dispatch_status: dispatched.statusCode, dispatch_error: dispatched.json().error ?? null, run_count: f.wb.all('runs').length, job_count: f.wb.all('agent_jobs').length, client_launches: launches.length}));
        assert.equal(exported.statusCode, role === 'runner' ? 403 : 400, scenario + '/' + role + ': ' + exported.body);
        if (role !== 'runner') assert.match(exported.json().error, /请先交付、失败或取消当前 Run/);
        assert.equal(dispatched.statusCode, 403, scenario + '/' + role + ': ' + dispatched.body);
        if (role !== 'runner') {
          assert.match(dispatched.json().error, /用户.*页面启动/);
          const sameOrder = await call(role, 'export_execution_order', {run_id: s.rid, task_id: s.tid, expected_version: originalTask.version, new_run: false});
          assert.equal(sameOrder.statusCode, 200, sameOrder.body); assert.equal(sameOrder.json().run_id, s.rid);
        }
        assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.all('agent_jobs').length, 1);
        assert.deepEqual(f.wb.get('tasks', s.tid), originalTask); assert.deepEqual(f.wb.get('runs', s.rid), originalRun); assert.deepEqual(f.wb.get('agent_jobs', jobId), originalJob);
        assert.deepEqual(f.wb.all('events').filter(e => e.run_id === s.rid), originalEvents); assert.deepEqual(fs.readFileSync(originalRun.order_path), originalOrder);
        assert.equal(f.wb.db.prepare('SELECT count(*) AS total FROM audit').get()!.total, originalAuditCount);
        assert.equal(f.wb.db.prepare("SELECT count(*) AS total FROM audit WHERE action='restart_interrupted_execution'").get()!.total, 0);
        assert.equal(resolutions, 1); assert.equal(builds.length, 1); assert.equal(launches.length, 1);
      }
      assert.equal(launches[0].signal.aborted, scenario === 'stopped');
    } finally {await f.app.close();}
  }
});

async function r5ApiUntil(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(check(), message);
}

test('主执行许可仅页面可设：CSRF、版本、审计与规划参数不可伪造',async()=>{
  const f=await recoveryApiFixture();try{
    const s=routedRecoverySetup(f.wb,f.root,'synthetic-controlled-execution'),page=await recoveryPage(f),url='/api/tasks/'+s.tid+'/main-execution-control';
    const initial=f.wb.get('tasks',s.tid),payload={expected_revision:initial.revision,main_execution_control:'automatic'};
    const current=await f.app.inject({url,headers:page});assert.equal(current.statusCode,200);assert.equal(current.json().mode,'user');
    assert.equal((await f.app.inject({method:'POST',url,headers:{host:page.host},payload})).statusCode,401);
    assert.equal((await f.app.inject({method:'POST',url,headers:{host:page.host,cookie:page.cookie},payload})).statusCode,403);
    for(const token of [keys(f.config.dataDir,'run',s.rid),f.wb.keys.planner,f.wb.keys.manager]){
      assert.equal((await f.app.inject({method:'POST',url,headers:{...page,authorization:'Bearer '+token},payload})).statusCode,403);
      const dispatch={run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:initial.revision};
      assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/dispatch_run',headers:{host:page.host,authorization:'Bearer '+token},payload:dispatch})).statusCode,403);
      // Runner can request same-session continuation, but this initial Run has no rework to continue.
      assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/continue_run',headers:{host:page.host,authorization:'Bearer '+token},payload:dispatch})).statusCode,token===keys(f.config.dataDir,'run',s.rid)?409:403);
    }
    assert.equal(f.wb.get('tasks',s.tid).revision,initial.revision);assert.equal(f.wb.all('agent_jobs').length,0);
    const q=f.wb.request({project_id:'P-workbench',text:'合成规划不能授权启动'});
    assert.throws(()=>f.wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(f.root),main_execution_control:'automatic',main_execution_control_decision:{source:'user_page'}}]}),/Unrecognized|main_execution_control/);
    const accepted=await f.app.inject({method:'POST',url,headers:page,payload});assert.equal(accepted.statusCode,200,accepted.body);
    assert.equal(accepted.json().task.revision,initial.revision+1);assert.equal(accepted.json().control.mode,'automatic');assert.equal(accepted.json().control.first_start,'user');
    assert.equal((await f.app.inject({method:'POST',url,headers:page,payload})).statusCode,409);
    const audits=f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='set_main_execution_control' AND entity_id=?").all(s.tid) as Row[];
    assert.equal(audits.length,1);assert.equal(audits[0].actor,'user');assert.equal(JSON.parse(audits[0].data).mode,'automatic');
    for(const token of [keys(f.config.dataDir,'run',s.rid),f.wb.keys.planner,f.wb.keys.manager])assert.equal((await f.app.inject({method:'POST',url:'/api/mcp/dispatch_run',headers:{host:page.host,authorization:'Bearer '+token},payload:{run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:initial.revision+1}})).statusCode,403);
    assert.equal(f.wb.all('agent_jobs').length,0);
  }finally{await f.app.close();}
});

test('HTTP original runner key follows only its formal same-session rework Run',async()=>{
 const f=await apiFixture();try{
 const s=setup(f.wb,f.root),other=setup(f.wb,f.root);contract(f.wb,f.root,s);const ra=deliver(f.wb,f.root,s);
 const {reviewAssignmentContext,startReview,submitReviewResult}=await import('../src/core/review-workflow.ts');const ctx=reviewAssignmentContext(f.wb,ra.review_id);startReview(f.wb,{review_id:ra.review_id,identity:ctx.assignment.reviewer_id});submitReviewResult(f.wb,{review_id:ra.review_id,task_id:s.tid,run_id:s.rid,review_digest:ctx.review_digest,verdict:'changes_requested',findings:['合成接口测试需要返修'],limitations:['不调用真实模型'],evidence:['当前交付绑定'],report_markdown:'# 合成返修报告：仅验证同会话作用域链，不调用真实模型或审查'},'reviewer:'+ra.review_id);
 const token=keys(f.config.dataDir,'run',s.rid),host='127.0.0.1:'+f.config.port;
 const call=(tool:string,body:Row={})=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+token},payload:{run_id:s.rid,...body}});
 const firstRequest={request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision};const continued=await call('continue_run',firstRequest);assert.equal(continued.statusCode,200,continued.body);const next=continued.json().run_id;assert.notEqual(next,s.rid);
 const response=await call('get_run_context',{mode:'brief'});assert.equal(response.statusCode,200,response.body);const context=response.json();assert.equal(context.authority.run_id,next);assert.equal(context.state.run_status,'awaiting_dispatch');assert.equal(context.next_action.owner,'agent');assert.notEqual(context.next_action.label,'交给执行者');
 assert([401,403].includes((await call('get_run_context',{run_id:other.rid})).statusCode));
 const ack=await call('ack_run_context',{context_hash:context.context_hash});assert.equal(ack.statusCode,200,ack.body);
 const started=await call('report_run_activity',{event_id:'continued-start-'+crypto.randomUUID(),event_type:'started',data:{message:'同会话返修接单'}});assert.equal(started.statusCode,200,started.body);assert.equal(f.wb.get('runs',next).has_started,true);assert.equal(f.wb.get('runs',s.rid).status,'submitted');
 const repeated=await call('continue_run',firstRequest);assert.equal(repeated.statusCode,200,repeated.body);assert.deepEqual(repeated.json(),continued.json());
 const submitted=await call('report_run_activity',{event_id:'continued-submitted-'+crypto.randomUUID(),event_type:'submitted',data:{result:'同会话第二轮真实接口状态测试交付，不调用模型或生产客户端。'}});assert.equal(submitted.statusCode,200,submitted.body);assert.equal(submitted.json().disposition,'applied',submitted.body);
 const secondRa=exportReviewOrder(f.wb,{run_id:next,reviewer_id:'zcode',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'第二次同会话返修接口测试'},{role:'user'});const secondCtx=reviewAssignmentContext(f.wb,secondRa.review_id);startReview(f.wb,{review_id:secondRa.review_id,identity:secondCtx.assignment.reviewer_id});submitReviewResult(f.wb,{review_id:secondRa.review_id,task_id:s.tid,run_id:next,review_digest:secondCtx.review_digest,verdict:'changes_requested',findings:['第二轮合成返修'],limitations:['无真实模型'],evidence:['第二轮交付绑定'],report_markdown:'# 第二轮合成审查报告：验证原凭据在中间Run的请求幂等性'},'reviewer:'+secondRa.review_id);
 const secondRequest={request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision};const second=await call('continue_run',secondRequest);assert.equal(second.statusCode,200,second.body);assert.notEqual(second.json().run_id,next);assert.equal(second.json().previous_run_id,next);
 const secondReplay=await call('continue_run',secondRequest);assert.equal(secondReplay.statusCode,200,secondReplay.body);assert.deepEqual(secondReplay.json(),second.json());
 const oldReplay=await call('continue_run',firstRequest);assert.equal(oldReplay.statusCode,409,oldReplay.body);
 const latestContext=await call('get_run_context');assert.equal(latestContext.json().authority.run_id,second.json().run_id);
 const nonChainId='R-'+crypto.randomUUID();f.wb.put('runs',{...f.wb.get('runs',s.rid),id:nonChainId,continuations:[]},{task_id:s.tid});
 const jobRuns=[s.rid,next,second.json().run_id,other.rid,nonChainId];const jobs=jobRuns.map((run_id,index)=>({id:'AJ-'+crypto.randomUUID(),run_id,task_id:run_id===other.rid?other.tid:s.tid,role:index===0?'execution':'review',route:{client:'grok',model:'synthetic'},phase:'review',status:'completed',revision:1,session_mode:'new'}));for(const job of jobs)f.wb.put('agent_jobs',job,{run_id:job.run_id});
 for(const job of jobs.slice(0,3)){const read=await call('get_agent_job',{job_id:job.id,timeout_ms:0});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().run_id,job.run_id);}
 for(const job of jobs.slice(3)){const read=await call('get_agent_job',{job_id:job.id,timeout_ms:0});assert.equal(read.statusCode,403,read.body);}
 const management=await call('get_task_detail',{task_id:s.tid});assert.equal(management.statusCode,200,management.body);
 }finally{await f.app.close();}
});




test('HTTP managed capability distinguishes the live owner and survives formal Run continuation',async()=>{
 const f=await apiFixture();let release=()=>{};let launch:Parameters<Launcher>[0]|undefined;
 Object.assign(f.agents,{launcher:(options:Parameters<Launcher>[0])=>new Promise(resolve=>{launch=options;release=()=>resolve({exitCode:0,signal:null,processStopped:true});options.signal.addEventListener('abort',()=>resolve({exitCode:null,signal:'SIGTERM',processStopped:true}),{once:true});}),clients:{async resolve(_data:string,kind:ClientKind){return {kind,label:'合成',status:'verified',reason:'隔离',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown'};},async build(){return {command:'SYNTHETIC-NOT-EXECUTED',args:[]};},async discover(){return [];}}});
 try{const s=routedRecoverySetup(f.wb,f.root,'synthetic-managed-http'),job=f.agents.dispatchRun({run_id:s.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision},{role:'user',source:'page'});const deadline=Date.now()+4000;while(!launch&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert(launch);
 const ra=deliver(f.wb,f.root,s),{reviewAssignmentContext,startReview,submitReviewResult}=await import('../src/core/review-workflow.ts'),ctx=reviewAssignmentContext(f.wb,ra.review_id);startReview(f.wb,{review_id:ra.review_id,identity:ctx.assignment.reviewer_id});submitReviewResult(f.wb,{review_id:ra.review_id,task_id:s.tid,run_id:s.rid,review_digest:ctx.review_digest,verdict:'changes_requested',findings:['合成受管返修'],limitations:['无真实模型'],evidence:['当前正式交付'],report_markdown:'# 合成受管进程接口审查：仅验证能力凭据和正式返修链'},'reviewer:'+ra.review_id);
 const token=keys(f.config.dataDir,'run',s.rid),host='127.0.0.1:'+f.config.port,cap={'x-workbench-execution-job-id':job.job_id,'x-workbench-execution-job-token':launch.env!.WORKBENCH_EXECUTION_JOB_TOKEN};const call=(tool:string,body:Row={},headers:Row={})=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+token,...headers},payload:{run_id:s.rid,...body}});const request={request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',s.tid).revision};
 const absent=await call('continue_run',request);assert.equal(absent.statusCode,409,absent.body);const wrong=await call('continue_run',request,{...cap,'x-workbench-execution-job-token':'0'.repeat(64)});assert.equal(wrong.statusCode,403,wrong.body);
 const next=await call('continue_run',request,cap);assert.equal(next.statusCode,200,next.body);const rid=next.json().run_id;assert.notEqual(rid,s.rid);const replay=await call('continue_run',request,cap);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),next.json());
 const context=await call('get_run_context',{mode:'brief'},cap);assert.equal(context.statusCode,200,context.body);assert.equal(context.json().authority.run_id,rid);assert.equal(context.json().next_action.owner,'agent');assert.notEqual(context.json().next_action.label,'交给执行者');const originalJob=await call('get_agent_job',{job_id:job.job_id,timeout_ms:0},cap);assert.equal(originalJob.statusCode,200,originalJob.body);assert.equal(originalJob.json().run_id,s.rid);assert.equal((await call('ack_run_context',{context_hash:context.json().context_hash},cap)).statusCode,200);const started=await call('report_run_activity',{event_id:'managed-http-start-'+crypto.randomUUID(),event_type:'started',data:{message:'受管本人同会话返修接单'}},cap);assert.equal(started.statusCode,200,started.body);assert.equal(started.json().disposition,'applied');assert.equal(started.json().run_id,rid);
 const submitted=await call('report_run_activity',{event_id:'managed-http-submit-'+crypto.randomUUID(),event_type:'submitted',data:{result:'受管本人同会话返修正式报告：隔离API验证通过，无真实模型调用。'}},cap);assert.equal(submitted.statusCode,200,submitted.body);assert.equal(submitted.json().disposition,'applied');assert.equal(f.wb.get('runs',rid).status,'submitted');await(f.agents as any).tick();assert.equal(launch.signal.aborted,false);release();const end=Date.now()+4000;while(f.wb.get('agent_jobs',job.job_id).status==='running'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(f.wb.get('agent_jobs',job.job_id).status,'completed');assert.equal(f.wb.get('agent_jobs',job.job_id).run_id,s.rid);assert(!next.body.includes(cap['x-workbench-execution-job-token']));
 }finally{release();await f.app.close();}
});

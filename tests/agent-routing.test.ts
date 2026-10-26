import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, taskInput, event, finishCloseout } from './agent-routing-fixture.ts';
import { AgentOrchestrator, type Launcher } from '../src/core/agent-orchestration.ts';
import {setMainExecutionControl,mainExecutionControlSummary} from '../src/core/main-execution-control.ts';
import type { AgentInvocationOptions, ClientKind, ClientRecord } from '../src/core/agent-clients.ts';
import { reviewAssignmentContext, startReview, submitReviewResult,exportReviewOrder,updateReviewMember,decideReviewCollaboration } from '../src/core/review-workflow.ts';

// Every launcher and discovery dependency is synthetic. These tests never launch a client or model.
type F = ReturnType<typeof fixture>;
type Row = Record<string, any>;
type Launch = Parameters<Launcher>[0];
const pageUser={role:'user',source:'page'} as const;
function fakeClients() {
  const launches: Launch[] = [], builds: AgentInvocationOptions[] = [];
  const releases: Array<(result?: { exitCode: number | null; signal: string | null; error?: string }) => void> = [];
  let discoveries = 0;
  const launcher: Launcher = options => new Promise(resolve => {
    launches.push(options); releases.push(result => resolve(result || { exitCode: 0, signal: null }));
    options.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true });
  });
  const clients = {
    async resolve(_dataDir: string, kind: ClientKind): Promise<ClientRecord> { return { kind, label: '合成客户端', status: 'verified', reason: '隔离测试', checkedAt: new Date().toISOString(), authentication: 'unknown', quota: 'unknown', invocation: 'unknown' }; },
    async build(_client: ClientRecord, options: AgentInvocationOptions) { builds.push(options); return { command: 'SYNTHETIC-NOT-EXECUTED', args: [] }; },
    async discover() { discoveries++; return []; },
  };
  return { launcher, clients, launches, builds, releases, get discoveries() { return discoveries; } };
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert(check(), message);
}
function planned(f: F, extra: Row = {}) {
  const q = f.wb.request({ project_id: 'P-workbench', text: '合成调度测试需求，不调用真实模型' });
  const p = f.wb.submitPlan({ schema_version: 1, plan_id: crypto.randomUUID(), request_id: q.id, expected_version: 1, tasks: [{ ...taskInput(f.root), review_route: { client: 'grok', model: 'synthetic-review' }, context_contract: { required: [], supplemental: [], output_dir: path.join(f.root, 'outputs'), max_bytes: 65536 }, ...extra }] });
  const tid = p.task_ids[0], order = f.wb.exportOrder(tid, 1);
  return { tid, rid: order.run_id };
}
function executionRoute(f: F) {
  f.wb.put('agents', { ...f.wb.get('agents', 'claude'), id: 'routing-executor', name: '合成执行者', preset_id: 'claude-code', allowed_kinds: ['engineering', 'review'], archived: false });
  return { agent_id: 'routing-executor', execution_route: { client: 'claude', model: 'synthetic-execution' } };
}
function receipt(f: F, tid: string, rid: string, type: string, extra: Row = {}) {
  const r = f.wb.get('runs', rid);
  const result = f.wb.event(event(r.cwd, tid, rid, r.seq + 1, type, { identity: r.agent_id, ...extra }), rid, 'run');
  assert.equal(result.disposition, 'applied', result.error);
  return result;
}
function deliver(f: F, tid: string, rid: string) {
  receipt(f, tid, rid, 'started');
  receipt(f, tid, rid, 'submitted', { result: '隔离调度测试交付：只验证正式状态和调用隔离，没有运行模型或生产任务。' });
}
function input(f: F, tid: string, rid = f.wb.get('tasks', tid).current_run_id) { return { run_id: rid, request_id: crypto.randomUUID(), expected_revision: f.wb.get('tasks', tid).revision }; }
function finishReview(f: F, reviewId: string, verdict: 'passed' | 'changes_requested' = 'passed', sessionId?: string) {
  const context = reviewAssignmentContext(f.wb, reviewId);
  startReview(f.wb, { review_id: reviewId, identity: context.assignment.reviewer_id, ...(sessionId ? { session_id: sessionId } : {}) });
  return submitReviewResult(f.wb, { review_id: reviewId, task_id: context.task_id, run_id: context.run_id, review_digest: context.review_digest, verdict,
    findings: verdict === 'changes_requested' ? ['合成问题：本轮还需补充验证'] : [], limitations: ['合成客户端回执，不代表真实独立审查'], evidence: ['测试读取了当前正式交付绑定'], report_markdown: '# 合成审查报告\n\n这里只核验自动调用是否遵守当前 Task、Run 与 RA 的正式状态，不代表产品技术审查。' }, 'reviewer:' + reviewId);
}
async function terminal(f: F, jobId: string) { await until(() => ['completed', 'failed', 'interrupted'].includes(f.wb.get('agent_jobs', jobId).status), '调用应在测试期限内结束'); return f.wb.get('agent_jobs', jobId); }
function grokSession(launch: Launch, sessionId: string, text = '合成客户端会话事件，不是正式报告') {
  launch.onLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }));
}
function dshReviewRoute(f: F) {
  f.wb.put('agents', { ...f.wb.get('agents', 'deepseek'), preset_id: 'deepseek', allowed_kinds: ['engineering', 'review'], archived: false });
  return { reviewer_id: 'deepseek', review_route: { client: 'dsh', model: 'deepseek-flash', provider: 'deepseek-account' } };
}
function nativeReviewResult(f: F, reviewId: string, extra: Row = {}) {
  const c = reviewAssignmentContext(f.wb, reviewId);
  return { review_id: reviewId, task_id: c.task_id, run_id: c.run_id, review_digest: c.review_digest, verdict: 'passed', findings: [], limitations: ['合成DSH协议事件，仅验证登记边界，不是真实模型审查'], evidence: ['隔离夹具的当前交付绑定'], report_markdown: '# 合成原生客户端报告\n\n测试使用已观察的DSH session/status/final事件形状，不调用模型，不代表产品独立审查结论。', ...extra };
}
function dshFinal(launch: Launch, sessionId: string, result: Row) {
  launch.onLine(JSON.stringify({ type: 'session', sessionId }));
  launch.onLine(JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 } }));
  launch.onLine(JSON.stringify({ type: 'final', text: JSON.stringify(result) }));
}

test('Cursor successful terminal narration preserves the unique genuine report and rejects ambiguous reports',async()=>{
 for(const scenario of ['passed','changes_requested','ambiguous']){const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);try{
  f.wb.put('agents',{...f.wb.get('agents','cursor'),preset_id:'cursor',archived:false});
  const t=planned(f,{reviewer_id:'cursor',review_route:{client:'cursor',model:'synthetic-cursor'}});deliver(f,t.tid,t.rid);
  const j=o.dispatchReview(input(f,t.tid));await until(()=>fake.launches.length===1,'隔离Cursor调用应启动');
  const report=nativeReviewResult(f,j.review_id!,{verdict:scenario==='changes_requested'?'changes_requested':'passed',findings:scenario==='changes_requested'?['隔离测试实际缺陷']:[]});
  const body='先核对本轮固定入口。'+JSON.stringify(report)+(scenario==='ambiguous'?'\n'+JSON.stringify({...report,verdict:'changes_requested'}):'');
  fake.launches[0].onLine(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'synthetic-cursor-'+scenario,result:body,usage:{inputTokens:120,outputTokens:30,cacheReadTokens:450}}));fake.releases[0]();const ended=await terminal(f,j.job_id);
  if(scenario==='ambiguous'){assert.equal(ended.status,'failed');assert.equal(f.wb.all('reviews').length,0);}else{assert.equal(ended.status,'completed',ended.reason);const saved=f.wb.all('reviews')[0];assert.equal(saved.verdict,scenario);assert.equal(saved.source,'native_client_output');assert.equal(saved.report_markdown,report.report_markdown);assert.equal(saved.client_job_id,j.job_id);assert.equal(ended.usage.inputTokens,120);assert.equal(f.wb.get('tasks',t.tid).status,scenario==='passed'?'awaiting_closeout':'changes_requested');}
 }finally{await o.close();f.wb.close();}}
});

test('successful native result records already completed work even if launch eligibility changes afterwards',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,dshReviewRoute(f));deliver(f,t.tid,t.rid);const job=o.dispatchReview(input(f,t.tid));await until(()=>fake.launches.length===1,'合成审查已真正启动');
  const body=nativeReviewResult(f,job.review_id!);const eligible=f.wb.eligible.bind(f.wb);
  f.wb.eligible=(id:string)=>{if(id==='deepseek')throw Error('合成：调用完成后无法再启动');return eligible(id);};
  dshFinal(fake.launches[0],'synthetic-already-finished',body);fake.releases[0]();const done=await terminal(f,job.job_id);
  assert.equal(done.status,'completed',done.reason);assert.equal(done.exit_code,0);assert.equal(f.wb.get('review_assignments',job.review_id!).started_at,undefined);
  assert.equal(f.wb.all('reviews')[0].source,'native_client_output');
 }finally{await o.close();f.wb.close();}
});

test('closeout client prompt distinguishes explicit continue from a real passed review',async()=>{
 for(const scenario of ['zero_reports','disagreement','passed']){const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
  try{const t=planned(f);deliver(f,t.tid,t.rid);
   if(scenario!=='zero_reports'){const a=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'验证收尾启动提示与实际依据一致'},{role:'user'});finishReview(f,a.review_id,scenario==='passed'?'passed':'changes_requested');}
   if(scenario!=='passed')decideReviewCollaboration(f.wb,{run_id:t.rid,expected_revision:f.wb.get('tasks',t.tid).revision,decision:'continue',reason:'测试负责人明确决定继续，保留尚未完成和反对意见'},{role:'user'});
   const task=f.wb.get('tasks',t.tid),run=f.wb.get('runs',t.rid),prompt=(o as any).prompt({role:'execution',phase:'closeout',session_mode:'new'},task,run,path.join(f.root,'output'));
   if(scenario==='passed')assert.match(prompt,/审查已通过，只完成本Run实际收尾/);else{assert.match(prompt,/负责人已决定继续，审查意见各自保留原结论/);assert.doesNotMatch(prompt,/审查已通过/);}
  }finally{await o.close();f.wb.close();}
 }
});

test('authenticated late report recovers a stopped parse failure for authorized closeout without rewriting failure',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients),seen:string[]=[];
 try{const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:false,auto_rework:false,continue_after_review:true,max_rework_rounds:2}});deliver(f,t.tid,t.rid);
  setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'automatic'},pageUser);
  const a=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'隔离补交恢复流程验证'},{role:'runner',id:'synthetic'});
  const failed={id:'AJ-'+crypto.randomUUID(),task_id:t.tid,run_id:t.rid,review_id:a.review_id,role:'review',phase:'review',route:{client:'grok',model:'synthetic-review'},status:'failed',reason:'原始解析失败',process_may_be_running:false,process_end_evidence:'owned_child_exit',ended_at:new Date().toISOString(),exit_code:0,created_at:new Date().toISOString()};f.wb.put('agent_jobs',failed,{run_id:t.rid});
  submitReviewResult(f.wb,nativeReviewResult(f,a.review_id),'reviewer:'+a.review_id);
  Object.assign(o as any,{dispatchRun:()=>{seen.push('closeout');return {};}});await(o as any).tick();assert.deepEqual(seen,['closeout']);
  const stored=f.wb.get('agent_jobs',failed.id);assert.equal(stored.status,'failed');assert.equal(stored.reason,failed.reason);assert.equal(stored.exit_code,0);assert.equal(stored.recovery.review_assignment_id,a.review_id);
  const view=await o.getJob({run_id:t.rid,job_id:failed.id,timeout_ms:0});assert.equal(view.recovery.review_id,stored.recovery.review_id);assert.equal(view.process_may_be_running,false);assert.equal(view.status,'failed');
  const result=f.wb.all('reviews')[0];f.wb.put('reviews',{...result,revoked_at:new Date().toISOString()},{run_id:t.rid});seen.length=0;await(o as any).tick();assert.deepEqual(seen,[]);
 }finally{await o.close();f.wb.close();}
});

test('多人审查可分别派给成员并同时运行，默认成员变更不取消其他在审成员',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{
   const t=planned(f,dshReviewRoute(f));deliver(f,t.tid,t.rid);o.start();
   const first=o.dispatchReview(input(f,t.tid,t.rid));await until(()=>fake.launches.length===1,'首位审查启动');
   const second=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'claude',requested_model:'synthetic-peer-model',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'用户增加另一位独立审查者'},{role:'user'});
   const job=o.dispatchReview({...input(f,t.tid,t.rid),review_id:second.review_id});await until(()=>{const current=f.wb.get('agent_jobs',job.job_id);assert.notEqual(current.status,'failed',current.reason);return fake.launches.length===2;},'另一审查可独立启动');
   assert.notEqual(first.job_id,job.job_id);assert.equal(fake.builds[1].model,'synthetic-peer-model');assert.equal(f.wb.get('agent_jobs',first.job_id).status,'running');
   startReview(f.wb,{review_id:second.review_id,identity:'claude'});
   finishReview(f,first.review_id!);fake.releases[0]();assert.equal((await terminal(f,first.job_id)).status,'completed');assert.equal(f.wb.get('tasks',t.tid).status,'in_review');
   finishReview(f,second.review_id,'changes_requested');fake.releases[1]();assert.equal((await terminal(f,job.job_id)).status,'completed');
   assert.equal(f.wb.get('tasks',t.tid).review_stage,'awaiting_decision');assert.equal(f.wb.all('reviews').length,2);assert.equal(f.wb.get('tasks',t.tid).current_run_id,t.rid);
 }finally{await o.close();f.wb.close();}
});

test('派审同请求幂等、同编号异内容拒绝；版本冲突和跨Run读取不会新增调用', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f); deliver(f, t.tid, t.rid);
    assert.throws(() => o.dispatchReview({ ...input(f, t.tid), expected_revision: 1 }), /revision|变化/);
    assert.equal(f.wb.all('agent_jobs').length, 0);
    const request = input(f, t.tid), first = o.dispatchReview(request), again = o.dispatchReview(request);
    assert.equal(again.job_id, first.job_id);
    assert.equal(f.wb.all('review_assignments').length, 1);
    assert.throws(() => o.dispatchReview({ ...request, fresh_session: true }), /编号内容冲突/);
    const other = planned(f);
    await assert.rejects(o.getJob({ run_id: other.rid, job_id: first.job_id }), /跨执行/);
    await until(() => fake.launches.length === 1, '应仅启动一个合成审查调用');
    fake.releases[0](); await terminal(f, first.job_id);
    assert.equal(fake.launches.length, 1);
  } finally { await o.close(); f.wb.close(); }
});

test('未指定审查路线时不创建RA、不启动客户端', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, { review_route: undefined }); deliver(f, t.tid, t.rid);
    assert.throws(() => o.dispatchReview(input(f, t.tid)), /未.*审查路由/);
    assert.equal(f.wb.all('review_assignments').length, 0); assert.equal(fake.launches.length, 0);
  } finally { await o.close(); f.wb.close(); }
});

test('CLI退出0和声称成功都不能替代正式审查回执；失败不会自动重派', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f); deliver(f, t.tid, t.rid);
    const job = o.dispatchReview(input(f, t.tid));
    await until(() => fake.launches.length === 1, '合成审查应启动');
    grokSession(fake.launches[0], 'synthetic-failed-session', 'PASS，所有测试已通过');
    fake.releases[0](); const ended = await terminal(f, job.job_id);
    assert.equal(ended.status, 'failed'); assert.match(ended.reason, /正式.*结果/);
    assert.equal(f.wb.get('tasks', t.tid).status, 'submitted'); assert.equal(f.wb.all('reviews').length, 0);
    assert.throws(() => o.dispatchReview(input(f, t.tid)), /未确认完成|fresh_session/);
    assert.equal(fake.launches.length, 1);
    const retry = o.dispatchReview({ ...input(f, t.tid), fresh_session: true });
    await until(() => fake.launches.length === 2, '明确新会话后允许重试');
    assert.equal(fake.builds[1].sessionId, undefined, '失败调用的会话不能被当作已完成历史恢复');
    fake.releases[1](); await terminal(f, retry.job_id);
  } finally { await o.close(); f.wb.close(); }
});

test('只有当前RA的正式回执能完成审查调用，通过后仍需执行收尾且不能再次派审', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f); deliver(f, t.tid, t.rid);
    const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成审查应启动');
    grokSession(fake.launches[0], 'synthetic-scoped-review');
    const report = finishReview(f, job.review_id!, 'passed', 'synthetic-scoped-review');
    fake.releases[0](); const ended = await terminal(f, job.job_id);
    assert.equal(ended.status, 'completed'); assert.equal(ended.session_id, 'synthetic-scoped-review');
    assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_closeout'); assert.equal(f.wb.get('tasks', t.tid).acceptance_record, undefined);
    assert.equal(report.review.source, 'reviewer_submission'); assert.equal(report.review.run_id, t.rid);
    assert.throws(() => o.dispatchReview(input(f, t.tid)), /当前执行|已有结论/);
    assert.equal(f.wb.all('reviews').length, 1);
  } finally { await o.close(); f.wb.close(); }
});

test('执行客户端也必须本人回报；主动输出与TEMP/TMP都在当前项目', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'});
    await until(() => fake.launches.length === 1, '合成执行应启动');
    const launch = fake.launches[0];
    for (const location of [launch.stdout, launch.stderr, launch.env?.TEMP!, launch.env?.TMP!, fake.builds[0].promptFile]) assert(!path.relative(f.root, location).startsWith('..'));
    assert.equal(launch.cwd, f.root); assert(fs.readFileSync(fake.builds[0].promptFile, 'utf8').includes(t.rid));
    fake.launches[0].onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'synthetic-execution-session', model: 'synthetic-execution' }));
    deliver(f, t.tid, t.rid); fake.releases[0](); assert.equal((await terminal(f, job.job_id)).status, 'completed');
    assert.equal(f.wb.get('runs', t.rid).session_id, 'synthetic-execution-session');
    assert.equal(f.wb.get('tasks', t.tid).status, 'submitted');
  } finally { await o.close(); f.wb.close(); }
});

test('返修只建一个新Run、同请求幂等且保留原交付；超过轮次上限不继续', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, { ...executionRoute(f), automation_policy: { auto_review: false, auto_rework: false, continue_after_review: false, max_rework_rounds: 1 } }); deliver(f, t.tid, t.rid);
    const original = fs.readFileSync(f.wb.get('runs', t.rid).order_path, 'utf8');
    const review = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成审查应启动');
    finishReview(f, review.review_id!, 'changes_requested'); fake.releases[0](); await terminal(f, review.job_id);
    const request = input(f, t.tid), next = o.continueRun(request, {role: 'user', source: 'page'}), repeated = o.continueRun(request, {role: 'user', source: 'page'});
    assert.notEqual(next.run_id, t.rid); assert.equal(repeated.run_id, next.run_id); assert.equal(f.wb.all('runs').length, 2);
    assert.equal(fs.readFileSync(f.wb.get('runs', t.rid).order_path, 'utf8'), original);
    assert.equal(f.wb.get('runs', next.run_id).retry_context.previous_run_id, t.rid);
    assert.throws(() => o.continueRun({ ...request, fresh_session: true }, {role: 'user', source: 'page'}), /编号内容冲突/);
    await until(() => fake.launches.length === 2, '返修执行应只调用一次');
    deliver(f, t.tid, next.run_id);
    fake.releases[1](); await terminal(f, next.job_id);
    const second = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 3, '返修审查应启动');
    finishReview(f, second.review_id!, 'changes_requested'); fake.releases[2](); await terminal(f, second.job_id);
    assert.throws(() => o.continueRun(input(f, t.tid), {role: 'user', source: 'page'}), /轮次上限/); assert.equal(f.wb.all('runs').length, 2);
  } finally { await o.close(); f.wb.close(); }
});

test('只有同Task同route已完成调用的真实会话可续审，不借用其他任务或模型的历史', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f); deliver(f, t.tid, t.rid);
    const first = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '首次审查应启动');
    grokSession(fake.launches[0], 'synthetic-continuation');
    finishReview(f, first.review_id!, 'changes_requested', 'synthetic-continuation'); fake.releases[0](); await terminal(f, first.job_id);
    const next = o.continueRun(input(f, t.tid), {role: 'user', source: 'page'}); deliver(f, t.tid, next.run_id);
    const same = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 2, '同任务续审应启动');
    assert.equal(fake.builds[1].sessionId, 'synthetic-continuation');
    grokSession(fake.launches[1], 'synthetic-continuation');
    finishReview(f, same.review_id!, 'changes_requested', 'synthetic-continuation'); fake.releases[1](); await terminal(f, same.job_id);
    const other = planned(f); deliver(f, other.tid, other.rid);
    const otherJob = o.dispatchReview(input(f, other.tid)); await until(() => fake.launches.length === 3, '其他任务审查应启动');
    assert.equal(fake.builds[2].sessionId, undefined); fake.releases[2](); await terminal(f, otherJob.job_id);
    const frozen = f.wb.get('runs', next.run_id).execution_contract;
    const task = f.wb.get('tasks', t.tid); task.review_route.model = 'synthetic-other-model'; f.wb.put('tasks', task, { project_id: task.project_id });
    assert.deepEqual(f.wb.get('runs', next.run_id).execution_contract, frozen, 'Task路线调整不能追改已冻结的Run合同');
    // A changed route belongs to the next Run, whose contract freezes at export.
    const changed = o.continueRun(input(f, t.tid), {role: 'user', source: 'page'});
    assert.equal(f.wb.get('runs', changed.run_id).execution_contract.review_route.model, 'synthetic-other-model');
    assert.deepEqual(f.wb.get('runs', next.run_id).execution_contract, frozen, '新Run承载新路线，历史Run合同保留原值');
    deliver(f, t.tid, changed.run_id);
    const different = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 4, '新路线审查应启动');
    assert.equal(fake.builds[3].model, 'synthetic-other-model'); assert.equal(fake.builds[3].sessionId, undefined); fake.releases[3](); await terminal(f, different.job_id);
  } finally { await o.close(); f.wb.close(); }
});

test('工作台重启把遗留调用标为interrupted，不自动重新启动未知进程', async () => {
  const f = fixture(), fake = fakeClients(), first = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  let restarted: AgentOrchestrator | undefined;
  try {
    const t = planned(f); deliver(f, t.tid, t.rid);
    const job = first.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '首个调用应启动');
    const isolated = fakeClients(); restarted = new AgentOrchestrator(f.wb, isolated.launcher, isolated.clients); restarted.start();
    await until(() => f.wb.get('agent_jobs', job.job_id).status === 'interrupted', '遗留调用应被标记中断');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(isolated.discoveries, 1); assert.equal(isolated.launches.length, 0);
    assert.equal(f.wb.all('agent_jobs').length, 1); assert.equal(f.wb.get('tasks', t.tid).status, 'submitted');
  } finally { await restarted?.close(); await first.close(); f.wb.close(); }
});

test('已启用策略在正式submitted后自动派审，多次状态通知不重复调用', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, { automation_policy: { auto_review: true, auto_rework: false, continue_after_review: false, max_rework_rounds: 1 } });
    o.start(); receipt(f, t.tid, t.rid, 'started');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(fake.launches.length, 0);
    receipt(f, t.tid, t.rid, 'submitted', { result: '合成自动派审交付报告：只有这份正式交付回执出现后，策略才可以启动审查。' });
    await until(() => fake.launches.length === 1, '正式交付后应自动调用审查者');
    for (let i = 0; i < 3; i++) f.wb.emit('change');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fake.launches.length, 1); assert.equal(f.wb.all('review_assignments').length, 1);
    const job = f.wb.all('agent_jobs')[0]; finishReview(f, job.review_id); fake.releases[0]();
    assert.equal((await terminal(f, job.id)).status, 'completed');
    assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_closeout');
    assert.equal(fake.discoveries, 1);
  } finally { await o.close(); f.wb.close(); }
});

test('DSH原生session/status/final严格JSON只登记当前RA并保留native_client_output来源', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid);
    const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成DSH审查应启动');
    const body = nativeReviewResult(f, job.review_id!); dshFinal(fake.launches[0], 'dsh-native-success', body); fake.releases[0]();
    const ended = await terminal(f, job.job_id), a = f.wb.get('review_assignments', job.review_id!), review = f.wb.get('reviews', a.result_id);
    assert.equal(ended.status, 'completed'); assert.equal(ended.session_id, 'dsh-native-success'); assert.equal(ended.model_mismatch, false);
    assert.equal(a.status, 'completed'); assert.equal(a.session_id, 'dsh-native-success'); assert.equal(review.reviewer_id, 'deepseek');
    assert.equal(review.source, 'native_client_output'); assert.equal(review.client_job_id, job.job_id); assert.equal(review.evidence_level, 'launched_client_final_output'); assert.equal(review.independently_verified, false);
    assert.equal(review.review_digest, body.review_digest); assert.equal(review.report_markdown, body.report_markdown);
    assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_closeout'); assert.equal(f.wb.get('tasks', t.tid).acceptance_record, undefined);
    assert.equal(fake.builds[0].provider, 'deepseek-account'); assert.equal(fake.builds[0].model, 'deepseek-flash');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fake.builds[0].artifactDir, 'review-result.json'), 'utf8')).review_id, job.review_id);
    assert(a.context_cache.some((x: Row) => x.session_id === 'dsh-native-success' && x.session_binding?.job_id === job.job_id));
  } finally { await o.close(); f.wb.close(); }
});

test('DSH最终JSON的错误digest在接单前拒绝，不留下started或正式报告', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid);
    const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成DSH审查应启动');
    dshFinal(fake.launches[0], 'dsh-wrong-digest', nativeReviewResult(f, job.review_id!, { review_digest: '0'.repeat(64) })); fake.releases[0]();
    const ended = await terminal(f, job.job_id), a = f.wb.get('review_assignments', job.review_id!);
    assert.equal(ended.status, 'failed'); assert.match(ended.reason, /交付版本/); assert.equal(a.status, 'awaiting_dispatch'); assert.equal(a.started_at, undefined); assert.equal(a.result_id, undefined);
    assert.equal(f.wb.get('tasks', t.tid).review_stage, 'awaiting_dispatch'); assert.equal(f.wb.get('tasks', t.tid).status, 'submitted'); assert.equal(f.wb.all('reviews').length, 0);
    assert.equal(fs.existsSync(path.join(fake.builds[0].artifactDir, 'review-result.json')), false);
  } finally { await o.close(); f.wb.close(); }
});

test('非零退出、任意工具stdout或DSH错误事件均不能把JSON提升为正式结论', async () => {
  for (const scenario of ['nonzero', 'tool_stdout', 'native_error']) {
    const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid);
      const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成DSH审查应启动');
      const body = nativeReviewResult(f, job.review_id!), launch = fake.launches[0];
      if (scenario === 'tool_stdout') {
        const nested = JSON.stringify({ type: 'final', text: JSON.stringify(body) });
        launch.onLine(JSON.stringify({ type: 'tool_result', stdout: nested, content: JSON.stringify(body), sessionId: 'forged-tool-session' }));
        launch.onLine(JSON.stringify(body));
      } else {
        if (scenario === 'native_error') launch.onLine(JSON.stringify({ type: 'error', message: '合成客户端失败，不接收后续final' }));
        dshFinal(launch, 'dsh-' + scenario, body);
      }
      fake.releases[0]({ exitCode: scenario === 'nonzero' ? 17 : 0, signal: null });
      const ended = await terminal(f, job.job_id), a = f.wb.get('review_assignments', job.review_id!);
      assert.equal(ended.status, 'failed', scenario); assert.equal(a.status, 'awaiting_dispatch', scenario); assert.equal(a.started_at, undefined, scenario); assert.equal(f.wb.all('reviews').length, 0, scenario);
      assert.equal(f.wb.get('tasks', t.tid).status, 'submitted', scenario);
      if (scenario === 'tool_stdout') assert.equal(ended.session_id, null);
      if (scenario === 'native_error') assert.equal(ended.output_failed, true);
    } finally { await o.close(); f.wb.close(); }
  }
});

test('原生会话与已登记scoped审查会话冲突时保留原会话和报告并停止自动流转', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid);
    const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成DSH审查应启动');
    const submitted = finishReview(f, job.review_id!, 'passed', 'scoped-original-session');
    dshFinal(fake.launches[0], 'native-conflicting-session', nativeReviewResult(f, job.review_id!)); fake.releases[0]();
    const ended = await terminal(f, job.job_id), a = f.wb.get('review_assignments', job.review_id!), review = f.wb.get('reviews', submitted.review.id);
    assert.equal(ended.status, 'failed'); assert.equal(ended.session_mismatch, true); assert.equal(ended.session_id, 'native-conflicting-session');
    assert.equal(a.session_id, 'scoped-original-session'); assert.equal(review.session_id, 'scoped-original-session'); assert.equal(review.source, 'reviewer_submission'); assert.equal(f.wb.all('reviews').length, 1);
    assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_closeout'); assert.equal(fake.launches.length, 1);
  } finally { await o.close(); f.wb.close(); }
});

test('执行客户端的冲突会话也不能覆盖本人回执的已登记会话', async () => {
  const f = fixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, '合成执行应启动');
    receipt(f, t.tid, t.rid, 'started', { session_id: 'scoped-executor-session', actual_model: 'synthetic-execution' });
    receipt(f, t.tid, t.rid, 'submitted', { result: '合成执行者本人回报，保留当前绑定；后续原生输出不得覆盖此会话。' });
    fake.launches[0].onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'conflicting-executor-session', model: 'synthetic-execution' })); fake.releases[0]();
    const ended = await terminal(f, job.job_id); assert.equal(ended.status, 'failed'); assert.equal(ended.session_mismatch, true); assert.equal(ended.model_mismatch, false);
    assert.equal(f.wb.get('runs', t.rid).session_id, 'scoped-executor-session'); assert.equal(f.wb.get('runs', t.rid).actual_model, 'synthetic-execution');
  } finally { await o.close(); f.wb.close(); }
});

test('startup中断的客户端PID仍存活时fresh_session也不能重启或改派RA', async () => {
  const f = fixture(), fake = fakeClients(), first = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  let restarted: AgentOrchestrator | undefined;
  try {
    const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid);
    const job = first.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, '合成DSH调用应启动');
    fake.launches[0].onSpawn?.(process.pid);
    const isolated = fakeClients(); restarted = new AgentOrchestrator(f.wb, isolated.launcher, isolated.clients); restarted.start();
    const interrupted = f.wb.get('agent_jobs', job.job_id); assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.process_may_be_running, true); assert.equal(interrupted.process_pid, process.pid);
    assert.throws(() => restarted!.dispatchReview({ ...input(f, t.tid), fresh_session: true }), /仍存在|禁止重复启动/);
    assert.equal(f.wb.all('agent_jobs').length, 1); assert.equal(f.wb.all('review_assignments').length, 1); assert.equal(f.wb.get('tasks', t.tid).current_review_assignment_id, job.review_id);
    assert.equal(isolated.launches.length, 0); assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await restarted?.close(); await first.close(); f.wb.close(); }
});

test('客户端build等待期间任务取消后不得启动执行进程', async () => {
  const f = fixture(), fake = fakeClients();
  let releaseBuild!: () => void;
  const waiting = new Promise<void>(resolve => { releaseBuild = resolve; });
  const clients = { ...fake.clients, async build(client: ClientRecord, options: AgentInvocationOptions) {
    const invocation = await fake.clients.build(client, options);
    await waiting;
    return invocation;
  } };
  const o = new AgentOrchestrator(f.wb, fake.launcher, clients);
  try {
    const t = planned(f, executionRoute(f)), job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'});
    await until(() => fake.builds.length === 1, '合成客户端应停在build等待点');
    assert.equal(fake.launches.length, 0);
    const task = f.wb.get('tasks', t.tid); task.status = 'cancelled'; task.revision++;
    f.wb.put('tasks', task, { project_id: task.project_id });
    releaseBuild();
    const ended = await terminal(f, job.job_id);
    assert.equal(ended.status, 'failed'); assert.equal(fake.launches.length, 0); assert.equal(fake.builds.length, 1);
    assert.equal(f.wb.get('tasks', t.tid).status, 'cancelled'); assert.equal(f.wb.get('runs', t.rid).has_started, false);
    assert.equal(ended.started_at, undefined); assert.notEqual(ended.process_may_be_running, true);
  } finally { releaseBuild(); await o.close(); f.wb.close(); }
});

// R2 recovery fixtures are deliberately retained in the requested handoff evidence folder.
import {fileURLToPath as recoveryFileURLToPath} from 'node:url';
import {Workbench as RecoveryWorkbench} from '../src/core/workbench.ts';
import {seedTestData as recoverySeed} from './fixtures.ts';
function recoveryFixture(): F {
  const evidence = process.env.AGENT_ROUTING_R2_ROOT || path.resolve(path.dirname(recoveryFileURLToPath(import.meta.url)), '../../..', '工程/docs/handoff/agent-routing-20261025/r2');
  fs.mkdirSync(evidence, {recursive: true});
  const root = fs.mkdtempSync(path.join(evidence, 'coordinator-fixture-'));
  const config: F['config'] = {root, dataDir: path.join(root, 'data'), port: 14317, timezone: 'America/Los_Angeles', authorizedRoots: [root], integrations: {tokenMonitor: {baseUrl: ''}, agentsView: {baseUrl: ''}}};
  return {root, config, wb: recoverySeed(new RecoveryWorkbench(config))};
}
function recoveryJob(f: F, t: {tid: string; rid: string}, changes: Row = {}) {
  const job = {id: 'AJ-' + crypto.randomUUID(), task_id: t.tid, run_id: t.rid, role: 'execution', phase: 'execution', route: {client: 'claude', model: 'synthetic-execution'}, status: 'interrupted', revision: 1, session_mode: 'new', session_id: null, created_at: new Date().toISOString(), reason: '合成中断记录', process_may_be_running: true, ...changes};
  f.wb.put('agent_jobs', job, {run_id: t.rid}); return job;
}
function controlInput(f: F, tid: string, jobId: string) {return {job_id: jobId, expected_revision: f.wb.get('tasks', tid).revision, reason: '隔离回归：用户已经核实本次客户端状态'};}
function recoveryAudits(f: F, jobId: string, action: string) {return f.wb.db.prepare('SELECT actor,data FROM audit WHERE entity_id=? AND action=?').all(jobId, action) as Array<{actor: string; data: string}>;}

test('R2 控制：用户停止本次拥有的运行，拒绝跨任务和旧revision且不自动重启', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: true, continue_after_review: true, max_rework_rounds: 2}}), other = planned(f);
    o.start(); const job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R2 合成执行应启动');
    assert.throws(() => o.cancelJob(other.tid, controlInput(f, other.tid, job.job_id)), /跨任务/);
    assert.throws(() => o.cancelJob(t.tid, {...controlInput(f, t.tid, job.job_id), expected_revision: 1}), /变化|刷新/);
    assert.equal(fake.launches[0].signal.aborted, false);
    const stopped = o.cancelJob(t.tid, controlInput(f, t.tid, job.job_id));
    assert.equal(stopped.status, 'interrupted'); assert.equal(fake.launches[0].signal.aborted, true);
    await until(() => f.wb.get('agent_jobs', job.job_id).process_may_be_running === false, 'R2 取消应等模拟进程退出');
    assert.equal(f.wb.get('agent_jobs', job.job_id).status, 'interrupted');
    assert.equal(f.wb.get('runs', t.rid).has_started, false); assert.equal(f.wb.all('reviews').length, 0);
    assert.equal(o.cancelJob(t.tid, controlInput(f, t.tid, job.job_id)).status, 'interrupted');
    const audits = recoveryAudits(f, job.job_id, 'cancel_agent_job'); assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'user');
    for (let i = 0; i < 3; i++) f.wb.emit('change'); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fake.launches.length, 1); assert.equal(f.wb.all('agent_jobs').length, 1);
    assert.deepEqual(o.taskJobs(t.tid).map(x => x.job_id), [job.job_id]); assert.deepEqual(o.taskJobs(other.tid), []);
  } finally {await o.close(); f.wb.close();}
});

test('R2 控制：任务取消、撤回、项目归档和更换Run均中止运行中的原调用', async () => {
  for (const scenario of ['cancelled', 'withdrawn', 'archived', 'new_run'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: true, continue_after_review: true, max_rework_rounds: 2}});
      o.start(); const job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, scenario + ': R2 合成调用应启动');
      f.wb.transaction(() => {
        const task = f.wb.get('tasks', t.tid);
        if (scenario === 'cancelled') task.status = 'cancelled';
        if (scenario === 'withdrawn') task.request_withdrawn = true;
        if (scenario === 'archived') {const project = f.wb.get('projects', task.project_id); project.archived = true; f.wb.put('projects', project);}
        if (scenario === 'new_run') {const replacement = {...f.wb.get('runs', t.rid), id: 'R-' + crypto.randomUUID()}; f.wb.put('runs', replacement, {task_id: t.tid}); task.current_run_id = replacement.id;}
        task.revision++; f.wb.put('tasks', task, {project_id: task.project_id});
      });
      await until(() => fake.launches[0].signal.aborted, scenario + ': 应中止本次持有的调用');
      await until(() => f.wb.get('agent_jobs', job.job_id).process_may_be_running === false, scenario + ': 模拟进程应退出');
      assert.equal(f.wb.get('agent_jobs', job.job_id).status, 'interrupted', scenario);
      assert.equal(f.wb.get('runs', t.rid).has_started, false); assert.equal(f.wb.all('reviews').length, 0);
      const audits = recoveryAudits(f, job.job_id, 'cancel_agent_job'); assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'system');
      for (let i = 0; i < 3; i++) f.wb.emit('change'); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(fake.launches.length, 1, scenario + ': 不得自动重启');
    } finally {await o.close(); f.wb.close();}
  }
});

test('R2 恢复：缺PID遗留记录必须明确确认并审计，仅解除进程阻碍不伪造完成', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), other = planned(f), old = recoveryJob(f, t);
    assert.throws(() => o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'}), /身份保存前中断|中断调用恢复/);
    assert.throws(() => o.confirmProcessEnded(t.tid, controlInput(f, t.tid, old.id)), /confirmed|Invalid/);
    assert.throws(() => o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, old.id), confirmed: false}), /confirmed|Invalid/);
    assert.throws(() => o.confirmProcessEnded(other.tid, {...controlInput(f, other.tid, old.id), confirmed: true}), /跨任务/);
    assert.throws(() => o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, old.id), expected_revision: 1, confirmed: true}), /变化|刷新/);
    assert.equal(f.wb.get('agent_jobs', old.id).process_may_be_running, true); assert.equal(recoveryAudits(f, old.id, 'confirm_agent_process_ended').length, 0);
    const recovered = o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, old.id), confirmed: true});
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.recovery_required, false); assert.equal(recovered.process_end_evidence, 'user_attested');
    const saved = f.wb.get('agent_jobs', old.id); assert.equal(saved.process_recovery.actor, 'user'); assert.equal(saved.process_recovery.confirmed, true);
    const audits = recoveryAudits(f, old.id, 'confirm_agent_process_ended'); assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'user'); assert.equal(JSON.parse(audits[0].data).previous_pid, null);
    assert.equal(f.wb.all('reviews').length, 0); assert.equal(f.wb.get('runs', t.rid).has_started, false); assert.equal(fake.launches.length, 0);
    assert.throws(() => o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}), /fresh_session|未确认完成/);
    const retried = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'}); await until(() => fake.launches.length === 1, '明确恢复后仍需显式fresh_session重试');
    fake.releases[0](); await terminal(f, retried.job_id); assert.equal(f.wb.get('agent_jobs', old.id).status, 'interrupted');
  } finally {await o.close(); f.wb.close();}
});

test('R2 恢复：活PID和本进程未持有的运行不能被确认结束或按旧PID停止', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), live = recoveryJob(f, t, {process_pid: process.pid});
    assert.throws(() => o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, live.id), confirmed: true}), /进程仍存在/);
    assert.equal(f.wb.get('agent_jobs', live.id).process_may_be_running, true); assert.equal(recoveryAudits(f, live.id, 'confirm_agent_process_ended').length, 0);
    const orphan = recoveryJob(f, t, {status: 'running', process_pid: process.pid});
    assert.throws(() => o.cancelJob(t.tid, controlInput(f, t.tid, orphan.id)), /未持有|不能按旧PID/);
    assert.equal(f.wb.get('agent_jobs', orphan.id).status, 'running'); assert.equal(recoveryAudits(f, orphan.id, 'cancel_agent_job').length, 0);
    assert.doesNotThrow(() => process.kill(process.pid, 0)); assert.equal(fake.launches.length, 0);
  } finally {await o.close(); f.wb.close();}
});

import {exportReviewOrder as r3ExportReviewOrder} from '../src/core/review-workflow.ts';

test('R3 F1：已started执行中断后显式新会话续作，新Run幂等且不伪造Agent事件', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'});
    await until(() => fake.launches.length === 1, 'R3 原执行调用应启动');
    receipt(f, t.tid, t.rid, 'started', {session_id: 'r3-original-session', actual_model: 'synthetic-execution'});
    fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-original-session', model: 'synthetic-execution'}));
    assert.equal(f.wb.get('tasks', t.tid).status, 'running'); assert.equal(f.wb.get('runs', t.rid).status, 'running');
    const originalOrder = fs.readFileSync(f.wb.get('runs', t.rid).order_path, 'utf8'), originalSeq = f.wb.get('runs', t.rid).seq;
    const originalEvents = f.wb.all('events').filter(e => e.run_id === t.rid).map(e => e.id);
    o.cancelJob(t.tid, controlInput(f, t.tid, job.job_id));
    await until(() => f.wb.get('agent_jobs', job.job_id).process_may_be_running === false, 'R3 原调用应确认退出');
    assert.equal(fake.launches[0].signal.aborted, true); assert.equal(f.wb.get('agent_jobs', job.job_id).status, 'interrupted');
    assert.throws(() => o.continueRun(input(f, t.tid), {role: 'user', source: 'page'}), /新Run|新会话|fresh_session/);
    assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.get('runs', t.rid).status, 'running');
    const request = {...input(f, t.tid), fresh_session: true}, next = o.continueRun(request, {role: 'user', source: 'page'}), duplicate = o.continueRun(request, {role: 'user', source: 'page'});
    assert.deepEqual(duplicate, next); assert.notEqual(next.run_id, t.rid); assert.equal(next.previous_run_id, t.rid);
    assert.equal(f.wb.all('runs').length, 2); assert.equal(f.wb.all('agent_jobs').length, 2);
    assert.throws(() => o.continueRun({...request, fresh_session: false}, {role: 'user', source: 'page'}), /编号内容冲突/);
    const old = f.wb.get('runs', t.rid), current = f.wb.get('runs', next.run_id);
    assert.equal(old.status, 'cancelled'); assert.equal(old.has_started, true); assert.equal(old.session_id, 'r3-original-session'); assert.equal(old.seq, originalSeq);
    assert.deepEqual(f.wb.all('events').filter(e => e.run_id === t.rid).map(e => e.id), originalEvents);
    assert.equal(old.program_interruption.source, 'workbench_process_control'); assert.equal(old.program_interruption.job_id, job.job_id); assert.equal(old.program_interruption.process_end_evidence, 'owned_child_exit');
    assert.equal(old.continuations.length, 1); assert.equal(old.continuations[0].request_id, request.request_id);
    assert.equal(current.retry_context.last_obstacle.type, 'program_interrupted'); assert.equal(current.retry_context.last_obstacle.agent_report, false); assert.equal(current.retry_context.last_obstacle.job_id, job.job_id);
    const audits = recoveryAudits(f, t.rid, 'restart_interrupted_execution'); assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'user'); assert.equal(JSON.parse(audits[0].data).source, 'workbench_process_control');
    assert.equal(fs.readFileSync(old.order_path, 'utf8'), originalOrder);
    await until(() => fake.launches.length === 2, 'R3 仅启动一个新Run调用');
    assert.equal(fake.builds[1].sessionId, undefined); assert.equal(f.wb.get('agent_jobs', next.job_id).session_mode, 'new'); assert.equal(f.wb.get('agent_jobs', next.job_id).resume_session_id, null);
    receipt(f, t.tid, next.run_id, 'started', {session_id: 'r3-new-session', actual_model: 'synthetic-execution'});
    fake.launches[1].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-new-session', model: 'synthetic-execution'}));
    receipt(f, t.tid, next.run_id, 'submitted', {result: 'R3合成新Run正式交付，确认新旧会话及原始回执隔离。'});
    fake.releases[1](); assert.equal((await terminal(f, next.job_id)).status, 'completed');
    assert.equal(f.wb.get('runs', next.run_id).session_id, 'r3-new-session'); assert.equal(f.wb.get('runs', t.rid).session_id, 'r3-original-session');
    assert.equal(f.wb.get('runs', t.rid).status, 'cancelled'); assert.equal(fake.launches.length, 2);
  } finally {await o.close(); f.wb.close();}
});

test('R3 F1：原调用仍在退出或活PID未核实结束时fresh_session也不能新建Run', async () => {
  const f = recoveryFixture(), fake = fakeClients();
  let finish!: (result: Awaited<ReturnType<Launcher>>) => void;
  const launcher: Launcher = launch => new Promise(resolve => {fake.launches.push(launch);finish = resolve;});
  const o = new AgentOrchestrator(f.wb, launcher, fake.clients);
  try {
    const t = planned(f, executionRoute(f)), job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R3 合成执行应启动');
    receipt(f, t.tid, t.rid, 'started', {session_id: 'r3-unfinished-session'}); fake.launches[0].onSpawn?.(process.pid);
    o.cancelJob(t.tid, controlInput(f, t.tid, job.job_id)); assert.equal(fake.launches[0].signal.aborted, true);
    assert.throws(() => o.continueRun({...input(f, t.tid), fresh_session: true}, {role: 'user', source: 'page'}), /尚未确认结束|禁止重复启动/);
    assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.get('runs', t.rid).program_interruption, undefined);
    finish({exitCode: null, signal: 'SIGTERM', processStopped: false});
    await until(() => f.wb.get('agent_jobs', job.job_id).process_end_evidence === 'unknown', 'R3 未确认进程树结束的结果应保留');
    assert.throws(() => o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, job.job_id), confirmed: true}), /进程仍存在/);
    assert.throws(() => o.continueRun({...input(f, t.tid), fresh_session: true}, {role: 'user', source: 'page'}), /仍存在|禁止重复启动/);
    assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.get('runs', t.rid).status, 'running'); assert.equal(f.wb.get('runs', t.rid).session_id, 'r3-unfinished-session');
    assert.equal(recoveryAudits(f, t.rid, 'restart_interrupted_execution').length, 0); assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {finish?.({exitCode: null, signal: 'SIGTERM', processStopped: false});await o.close();f.wb.close();}
});

test('R3 F2：正式submitted不能掩盖processStopped false，必须保留恢复阻碍和正式交付', async () => {
  for (const pidState of ['missing', 'live'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: false, continue_after_review: true, max_rework_rounds: 1}});
      o.start(); const job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R3 合成执行应启动');
      if (pidState === 'live') fake.launches[0].onSpawn?.(process.pid);
      deliver(f, t.tid, t.rid);
      const eventIds = f.wb.all('events').filter(e => e.run_id === t.rid).map(e => e.id), hashes = f.wb.all('artifacts').filter(a => a.run_id === t.rid).map(a => a.sha256), seq = f.wb.get('runs', t.rid).seq;
      const result = {exitCode: 0, signal: null, processStopped: false}; fake.releases[0](result);
      const ended = await terminal(f, job.job_id), view = o.taskJobs(t.tid).find(j => j.job_id === job.job_id)!;
      assert.equal(ended.status, 'interrupted'); assert.equal(ended.process_may_be_running, true); assert.equal(ended.process_end_evidence, 'unknown'); assert.equal(view.recovery_required, true);
      assert.equal(f.wb.get('tasks', t.tid).status, 'submitted'); assert.equal(f.wb.get('runs', t.rid).status, 'submitted'); assert.equal(f.wb.get('runs', t.rid).seq, seq);
      assert.deepEqual(f.wb.all('events').filter(e => e.run_id === t.rid).map(e => e.id), eventIds); assert.deepEqual(f.wb.all('artifacts').filter(a => a.run_id === t.rid).map(a => a.sha256), hashes);
      for (let i = 0; i < 3; i++) f.wb.emit('change'); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(fake.launches.length, 1); assert.equal(f.wb.all('review_assignments').length, 0);
      if (pidState === 'live') {
        assert.throws(() => o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, job.job_id), confirmed: true}), /进程仍存在/);
        assert.equal(f.wb.get('agent_jobs', job.job_id).process_may_be_running, true); assert.doesNotThrow(() => process.kill(process.pid, 0));
      } else {
        const confirmed = o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, job.job_id), confirmed: true});
        assert.equal(confirmed.status, 'interrupted'); assert.equal(confirmed.process_end_evidence, 'user_attested'); assert.equal(confirmed.recovery_required, false);
        await until(() => fake.launches.length === 2, '恢复后已有正式交付应按原auto_review策略启动独立审查');
        assert.equal(fake.builds[1].role, 'review'); assert.equal(f.wb.all('review_assignments').length, 1);
      }
      for (let i = 0; i < 3; i++) f.wb.emit('change'); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(fake.launches.length, pidState === 'live' ? 1 : 2); assert.equal(f.wb.all('review_assignments').length, pidState === 'live' ? 0 : 1); assert.equal(f.wb.get('runs', t.rid).status, 'submitted');
      assert.equal(f.wb.all('agent_jobs').filter(j => j.role === 'execution').length, 1); assert.equal(f.wb.get('runs', t.rid).seq, seq);
      assert.deepEqual(f.wb.all('events').filter(e => e.run_id === t.rid).map(e => e.id), eventIds); assert.deepEqual(f.wb.all('artifacts').filter(a => a.run_id === t.rid).map(a => a.sha256), hashes);
    } finally {await o.close();f.wb.close();}
  }
});

test('R3 审查：RA改派或撤回会停止owned旧调用，迟到最终输出不能登记旧RA', async () => {
  for (const change of ['reassigned', 'revoked'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, dshReviewRoute(f)); deliver(f, t.tid, t.rid); o.start();
      const job = o.dispatchReview(input(f, t.tid)); await until(() => fake.launches.length === 1, 'R3 旧审查调用应启动');
      startReview(f.wb, {review_id: job.review_id!, identity: 'deepseek', session_id: 'r3-old-review'});
      const lateReport = nativeReviewResult(f, job.review_id!); let replacement: string | undefined;
      if (change === 'reassigned') {
        const changed=updateReviewMember(f.wb, {run_id: t.rid,review_id:job.review_id,action:'replace', reviewer_id: 'claude', expected_revision: f.wb.get('tasks', t.tid).revision, reason: 'R3合成正式改派，旧运行必须停止'}, {role: 'user'});assert('review_id' in changed);replacement=changed.review_id;
      } else {
        f.wb.transaction(() => {const a = f.wb.get('review_assignments', job.review_id!);a.status = 'revoked';f.wb.put('review_assignments', a, {run_id: t.rid});});
      }
      await until(() => fake.launches[0].signal.aborted, change + ': 旧审查必须收到取消');
      await until(() => f.wb.get('agent_jobs', job.job_id).process_may_be_running === false, change + ': 模拟旧审查应退出');
      dshFinal(fake.launches[0], 'r3-old-review', lateReport); fake.releases[0](); await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(f.wb.get('agent_jobs', job.job_id).status, 'interrupted'); assert.equal(f.wb.all('reviews').length, 0);
      assert.equal(f.wb.get('review_assignments', job.review_id!).status, change === 'reassigned' ? 'cancelled' : 'revoked');
      if (replacement) {assert.equal(f.wb.get('tasks', t.tid).current_review_assignment_id, replacement); assert.equal(f.wb.get('review_assignments', replacement).status, 'awaiting_dispatch');}
      const audits = recoveryAudits(f, job.job_id, 'cancel_agent_job'); assert.equal(audits.length, 1); assert.equal(audits[0].actor, 'system'); assert.equal(fake.launches.length, 1);
    } finally {await o.close();f.wb.close();}
  }
});

function r3CloseoutReady(f: F) {
  const route = executionRoute(f); route.execution_route.model = 'synthetic-closeout';
  // This fixture launches only closeout; freeze that invocation route before export.
  // The original execution identity is independently reported by its own receipt.
  const t = planned(f, route);
  receipt(f, t.tid, t.rid, 'started', {session_id: 'r3-execution-session', actual_model: 'synthetic-execution'});
  receipt(f, t.tid, t.rid, 'submitted', {result: 'R3合成执行正式交付，用于核对收尾调用身份与原始执行身份分别保留。'});
  const review = r3ExportReviewOrder(f.wb, {run_id: t.rid, reviewer_id: 'grok-build', expected_revision: f.wb.get('tasks', t.tid).revision, reason: 'R3合成审查用于进入独立收尾阶段'}, {role: 'user'});
  finishReview(f, review.review_id);
  const task = f.wb.get('tasks', t.tid);
  assert.equal(task.status, 'awaiting_closeout');
  assert.equal(f.wb.get('runs', t.rid).execution_contract.execution_route.model, 'synthetic-closeout');
  return t;
}

test('R3 closeout identity：fresh_session收尾保留原执行身份并单独登记新会话和模型', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = r3CloseoutReady(f), job = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'});
    await until(() => fake.launches.length === 1, 'R3 合成收尾调用应启动');
    assert.equal(job.phase, 'closeout'); assert.equal(job.session_mode, 'new'); assert.equal(fake.builds[0].sessionId, undefined);
    fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-closeout-session', model: 'synthetic-closeout'}));
    finishCloseout(f.wb, t.tid); fake.releases[0]();
    const ended = await terminal(f, job.job_id), run = f.wb.get('runs', t.rid);
    assert.equal(ended.status, 'completed'); assert.equal(ended.session_mismatch, false); assert.equal(ended.model_mismatch, false);
    assert.equal(run.session_id, 'r3-execution-session'); assert.equal(run.actual_model, 'synthetic-execution');
    assert.equal(run.closeout.session_id, 'r3-closeout-session'); assert.equal(run.closeout.actual_model, 'synthetic-closeout'); assert.equal(run.closeout.client_job_id, job.job_id);
    assert.equal(run.status, 'submitted'); assert.equal(run.closeout.status, 'completed'); assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_confirmation');
    assert.equal(f.wb.all('sessions').filter(s => s.native_id === 'r3-closeout-session' && s.run_id === t.rid).length, 1);
  } finally {await o.close(); f.wb.close();}
});

test('R3 closeout identity：收尾本身已有会话或模型冲突时保留两阶段原身份', async () => {
  for (const mismatch of ['session', 'model'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = r3CloseoutReady(f), run = f.wb.get('runs', t.rid);
      const closeoutIdentity = {session_id: mismatch === 'session' ? 'r3-existing-closeout-session' : 'r3-closeout-session', actual_model: mismatch === 'model' ? 'synthetic-existing-closeout' : 'synthetic-closeout'};
      Object.assign(run.closeout, closeoutIdentity); f.wb.put('runs', run, {task_id: t.tid});
      const job = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R3 合成收尾冲突调用应启动');
      fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-closeout-session', model: 'synthetic-closeout'}));
      finishCloseout(f.wb, t.tid); fake.releases[0]();
      const ended = await terminal(f, job.job_id), current = f.wb.get('runs', t.rid);
      assert.equal(ended.status, mismatch === 'session'?'failed':'completed'); assert.equal(ended.session_mismatch, mismatch === 'session'); assert.equal(ended.model_mismatch, false);
      assert.equal(current.session_id, 'r3-execution-session'); assert.equal(current.actual_model, 'synthetic-execution');
      assert.equal(current.closeout.session_id, closeoutIdentity.session_id); assert.equal(current.closeout.actual_model, mismatch === 'session'?closeoutIdentity.actual_model:'synthetic-closeout');
      assert.equal(current.closeout.status, 'completed'); assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_confirmation');
    } finally {await o.close(); f.wb.close();}
  }
});

test('R3 closeout identity：缺失收尾记录时失败且不回写原执行身份', async () => {
  const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
  try {
    const t = r3CloseoutReady(f), job = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'});
    await until(() => fake.launches.length === 1, 'R3 合成收尾调用应启动');
    fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-closeout-session', model: 'synthetic-closeout'}));
    const run = f.wb.get('runs', t.rid); delete run.closeout; f.wb.put('runs', run, {task_id: t.tid});
    fake.releases[0](); const ended = await terminal(f, job.job_id), current = f.wb.get('runs', t.rid);
    assert.equal(ended.status, 'failed'); assert.match(ended.reason, /缺少收尾记录/);
    assert.equal(current.session_id, 'r3-execution-session'); assert.equal(current.actual_model, 'synthetic-execution'); assert.equal(current.closeout, undefined);
  } finally {await o.close(); f.wb.close();}
});

test('R3 closeout identity：失败S1之后显式fresh S2可正式完成且旧job身份完整保留', async () => {
  for (const reportedModel of ['synthetic-closeout', undefined]) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = r3CloseoutReady(f), first = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'});
      await until(() => fake.launches.length === 1, 'R3 首次合成收尾调用应启动');
      fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-closeout-S1', model: 'synthetic-closeout'}));
      fake.releases[0](); const failed = await terminal(f, first.job_id);
      assert.equal(failed.status, 'failed'); assert.equal(failed.process_may_be_running, false);
      const previous = f.wb.get('runs', t.rid).closeout;
      assert.equal(previous.status, 'awaiting_dispatch'); assert.equal(previous.session_id, 'r3-closeout-S1'); assert.equal(previous.client_job_id, first.job_id);
      assert.throws(() => o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}), /fresh_session/);
      const second = o.dispatchRun({...input(f, t.tid), fresh_session: true}, {role:'user',source:'page'});
      await until(() => fake.launches.length === 2, 'R3 显式fresh收尾重试应启动');
      assert.equal(second.session_mode, 'new'); assert.equal(fake.builds[1].sessionId, undefined);
      fake.launches[1].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: 'r3-closeout-S2', ...(reportedModel ? {model: reportedModel} : {})}));
      finishCloseout(f.wb, t.tid); fake.releases[1]();
      const ended = await terminal(f, second.job_id), current = f.wb.get('runs', t.rid);
      assert.equal(ended.status, 'completed'); assert.equal(ended.session_mismatch, false); assert.equal(ended.model_mismatch, false);
      assert.equal(current.closeout.session_id, 'r3-closeout-S2'); assert.equal(current.closeout.actual_model, reportedModel ?? null); assert.equal(current.closeout.client_job_id, second.job_id);
      assert.equal(current.session_id, 'r3-execution-session'); assert.equal(current.actual_model, 'synthetic-execution');
      assert.deepEqual(f.wb.get('agent_jobs', first.job_id), failed); assert.equal(failed.session_id, 'r3-closeout-S1'); assert.equal(failed.actual_model, 'synthetic-closeout');
      assert.equal(current.closeout.status, 'completed'); assert.equal(f.wb.get('tasks', t.tid).status, 'awaiting_confirmation');
    } finally {await o.close(); f.wb.close();}
  }
});

test('R4 F2：恢复前禁止派审，用户授权后按策略派审并安排一次收尾且不重试旧执行', async () => {
  for (const autoReview of [true, false]) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: autoReview, auto_rework: false, continue_after_review: autoReview, max_rework_rounds: 1}});
      setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'automatic'},{role:'user',source:'page'});
      o.start(); const job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R4 合成执行应启动');
      receipt(f, t.tid, t.rid, 'started', {session_id: 'r4-submitted-session', actual_model: 'synthetic-execution'});
      receipt(f, t.tid, t.rid, 'submitted', {result: 'R4合成正式交付；即使执行进程未确认结束，报告、事件和产物仍应完整保留。'});
      const delivered = f.wb.get('runs', t.rid), events = f.wb.all('events').filter(e => e.run_id === t.rid), artifacts = f.wb.all('artifacts').filter(a => a.run_id === t.rid);
      fake.releases[0]({exitCode: 0, signal: null, processStopped: false} as Parameters<typeof fake.releases[0]>[0]);
      const interrupted = await terminal(f, job.job_id); assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.process_may_be_running, true);
      await r4Ticks(f); assert.equal(fake.launches.length, 1); assert.equal(f.wb.all('review_assignments').length, 0);
      assert.throws(() => o.confirmProcessEnded(t.tid, controlInput(f, t.tid, job.job_id)), /confirmed/);
      await r4Ticks(f); assert.equal(fake.launches.length, 1);
      const confirmed = o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, job.job_id), confirmed: true});
      assert.equal(confirmed.status, 'interrupted'); assert.equal(confirmed.process_end_evidence, 'user_attested'); assert.equal(confirmed.recovery_required, false);
      const recoveredJob = f.wb.get('agent_jobs', job.job_id);
      await r4Ticks(f);
      if (autoReview) {
        await until(() => fake.launches.length === 2, 'R4 已确认结束的正式交付应开始独立审查');
        assert.equal(fake.builds[1].role, 'review'); assert.equal(f.wb.all('review_assignments').length, 1);
        const reviewJob = f.wb.all('agent_jobs').find(j => j.role === 'review')!;
        finishReview(f, reviewJob.review_id); fake.releases[1](); assert.equal((await terminal(f, reviewJob.id)).status, 'completed');
        await until(() => fake.launches.length === 3, 'R4 审查通过后旧中断不能再次阻断独立收尾');
      }
      await r4Ticks(f);
      assert.equal(fake.launches.length, autoReview ? 3 : 1); assert.equal(fake.builds.filter(b => b.role === 'execution').length, autoReview ? 2 : 1);
      assert.equal(f.wb.all('agent_jobs').filter(j => j.phase === 'execution').length, 1); assert.equal(f.wb.all('agent_jobs').filter(j => j.phase === 'closeout').length, autoReview ? 1 : 0);
      assert.equal(f.wb.all('review_assignments').length, autoReview ? 1 : 0); assert.equal(f.wb.all('runs').length, 1);
      assert.deepEqual(f.wb.get('agent_jobs', job.job_id), recoveredJob);
      const current = f.wb.get('runs', t.rid);
      assert.equal(current.status, 'submitted'); assert.equal(current.seq, delivered.seq); assert.equal(current.result, delivered.result);
      assert.equal(current.session_id, delivered.session_id); assert.equal(current.actual_model, delivered.actual_model);
      assert.deepEqual(f.wb.all('events').filter(e => e.run_id === t.rid), events); assert.deepEqual(f.wb.all('artifacts').filter(a => a.run_id === t.rid), artifacts);
      assert.equal(f.wb.get('tasks', t.tid).status, autoReview ? 'awaiting_closeout' : 'submitted');
    } finally {await o.close(); f.wb.close();}
  }
});

async function r4Ticks(f: F) {
  for (let i = 0; i < 3; i++) {f.wb.emit('change'); await new Promise<void>(resolve => setImmediate(resolve));}
}

test('R4 F2：明确子进程结束可派审，未知结束证据和其他失败阶段仍保持阻碍', async () => {
  for (const scenario of ['owned_exit', 'unknown_evidence', 'identity_conflict', 'failed_review', 'failed_closeout', 'no_submission'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: false, continue_after_review: false, max_rework_rounds: 1}});
      if (scenario === 'no_submission') receipt(f, t.tid, t.rid, 'started'); else deliver(f, t.tid, t.rid);
      const job = recoveryJob(f, t, {process_may_be_running: false, process_end_evidence: scenario === 'unknown_evidence' ? 'unknown' : 'owned_child_exit', ...(scenario === 'identity_conflict' ? {session_mismatch: true} : {})});
      if (scenario === 'failed_review' || scenario === 'failed_closeout') recoveryJob(f, t, {status: 'failed', role: scenario === 'failed_review' ? 'review' : 'execution', phase: scenario === 'failed_review' ? 'review' : 'closeout', process_may_be_running: false, process_end_evidence: 'owned_child_exit'});
      const saved = f.wb.get('agent_jobs', job.id); o.start(); await r4Ticks(f);
      if (scenario === 'owned_exit') await until(() => fake.launches.length === 1, 'R4 已确认的子进程退出允许现有正式交付进入独立审查');
      assert.equal(fake.launches.length, scenario === 'owned_exit' ? 1 : 0, scenario);
      assert.equal(fake.builds.filter(b => b.role === 'execution').length, 0, scenario); assert.deepEqual(f.wb.get('agent_jobs', job.id), saved);
      assert.equal(f.wb.all('runs').length, 1); assert.equal(f.wb.get('runs', t.rid).status, scenario === 'no_submission' ? 'running' : 'submitted');
      await r4Ticks(f); assert.equal(fake.launches.length, scenario === 'owned_exit' ? 1 : 0, scenario);
    } finally {await o.close(); f.wb.close();}
  }
});

test('R4 F2：用户授权后旧中断不阻碍按auto_rework策略新Run返修且不重复', async () => {
  for (const autoRework of [true, false]) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: autoRework, continue_after_review: false, max_rework_rounds: 1}});
      setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'automatic'},{role:'user',source:'page'});
      deliver(f, t.tid, t.rid);
      const oldRun = f.wb.get('runs', t.rid), events = f.wb.all('events').filter(e => e.run_id === t.rid), artifacts = f.wb.all('artifacts').filter(a => a.run_id === t.rid);
      const oldJob = recoveryJob(f, t, {process_may_be_running: false, process_end_evidence: 'user_attested'});
      o.start(); await until(() => fake.launches.length === 1, 'R4 已确认结束的原交付应开始独立审查');
      const reviewJob = f.wb.all('agent_jobs').find(j => j.role === 'review')!;
      finishReview(f, reviewJob.review_id, 'changes_requested'); fake.releases[0](); assert.equal((await terminal(f, reviewJob.id)).status, 'completed');
      await r4Ticks(f);
      if (autoRework) await until(() => fake.launches.length === 2, 'R4 审查要求修改后应按原策略建立新Run返修');
      const task = f.wb.get('tasks', t.tid);
      assert.equal(fake.launches.length, autoRework ? 2 : 1); assert.equal(f.wb.all('runs').length, autoRework ? 2 : 1);
      if (autoRework) {
        assert.notEqual(task.current_run_id, t.rid); assert.equal(fake.builds[1].role, 'execution'); assert.equal(fake.builds[1].sessionId, undefined);
        assert.equal(f.wb.get('runs', task.current_run_id).retry_context.previous_run_id, t.rid);
      } else {assert.equal(task.current_run_id, t.rid); assert.equal(task.status, 'changes_requested');}
      assert.equal(f.wb.all('agent_jobs').filter(j => j.run_id === t.rid && j.role === 'execution').length, 1); assert.deepEqual(f.wb.get('agent_jobs', oldJob.id), oldJob);
      const preserved = f.wb.get('runs', t.rid); assert.equal(preserved.status, 'submitted'); assert.equal(preserved.seq, oldRun.seq); assert.equal(preserved.result, oldRun.result);
      assert.deepEqual(f.wb.all('events').filter(e => e.run_id === t.rid), events); assert.deepEqual(f.wb.all('artifacts').filter(a => a.run_id === t.rid), artifacts);
      await r4Ticks(f); assert.equal(fake.launches.length, autoRework ? 2 : 1); assert.equal(f.wb.all('review_assignments').length, 1);
    } finally {await o.close(); f.wb.close();}
  }
});

test('R4 F2：进程未知早退尚未标冲突时，恢复仍核对原生输出与正式回执身份', async () => {
  for (const conflict of ['session', 'model'] as const) {
    const f = recoveryFixture(), fake = fakeClients(), o = new AgentOrchestrator(f.wb, fake.launcher, fake.clients);
    try {
      const t = planned(f, {...executionRoute(f), automation_policy: {auto_review: true, auto_rework: false, continue_after_review: false, max_rework_rounds: 1}});
      o.start(); const job = o.dispatchRun(input(f, t.tid), {role:'user',source:'page'}); await until(() => fake.launches.length === 1, 'R4 合成执行应启动');
      receipt(f, t.tid, t.rid, 'started', {session_id: 'r4-formal-session', actual_model: conflict === 'model' ? 'synthetic-formal-model' : 'synthetic-execution'});
      fake.launches[0].onLine(JSON.stringify({type: 'system', subtype: 'init', session_id: conflict === 'session' ? 'r4-native-other-session' : 'r4-formal-session', model: 'synthetic-execution'}));
      receipt(f, t.tid, t.rid, 'submitted', {result: 'R4合成正式交付；原生输出与正式回执身份冲突应保留证据并阻止自动派审。'});
      const submitted = f.wb.get('runs', t.rid);
      fake.releases[0]({exitCode: 0, signal: null, processStopped: false} as Parameters<typeof fake.releases[0]>[0]);
      const interrupted = await terminal(f, job.job_id);
      assert.equal(interrupted.status, 'interrupted'); assert.equal(!!interrupted.session_mismatch, false); assert.equal(!!interrupted.model_mismatch, false);
      o.confirmProcessEnded(t.tid, {...controlInput(f, t.tid, job.job_id), confirmed: true});
      await r4Ticks(f);
      if(conflict==='session'){assert.equal(fake.launches.length, 1); assert.equal(f.wb.all('review_assignments').length, 0); assert.equal(f.wb.all('agent_jobs').length, 1);}
      else {await until(()=>fake.launches.length===2,'model differences must not block independent review');assert.equal(f.wb.all('review_assignments').length,1);}
      assert.deepEqual(f.wb.get('runs', t.rid), submitted); assert.equal(f.wb.get('tasks', t.tid).status, 'submitted');
      const recovered = f.wb.get('agent_jobs', job.job_id);
      assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.process_end_evidence, 'user_attested'); assert.equal(recovered.session_id, interrupted.session_id); assert.equal(recovered.actual_model, interrupted.actual_model);
    } finally {await o.close(); f.wb.close();}
  }
});

test('主执行默认由页面用户启动：旧策略或伪造模式字段不授予许可，MCP身份不能代启',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
  try{
    const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:true,auto_rework:true,continue_after_review:true,max_rework_rounds:2}});
    const original=f.wb.get('tasks',t.tid);
    assert.equal(mainExecutionControlSummary(original).mode,'user');
    assert.equal(mainExecutionControlSummary({...original,main_execution_control:'automatic'}).mode,'user');
    for(const role of ['runner','planner','manager'] as const){
      assert.throws(()=>o.dispatchRun(input(f,t.tid),{role,source:'mcp'}),/用户.*页面启动/);
      assert.throws(()=>o.continueRun(input(f,t.tid),{role,source:'mcp'}),/用户.*页面启动/);
    }
    const enabled=setMainExecutionControl(f.wb,t.tid,{expected_revision:original.revision,main_execution_control:'automatic'},pageUser);
    assert.equal(enabled.control.mode,'automatic');
    assert.throws(()=>o.dispatchRun(input(f,t.tid),{role:'system',source:'automation'}),/首次启动/);
    for(const role of ['runner','planner','manager'] as const)assert.throws(()=>o.dispatchRun(input(f,t.tid),{role,source:'mcp'}),/用户.*页面启动/);
    assert.equal(f.wb.all('agent_jobs').length,0);assert.equal(fake.launches.length,0);
    o.dispatchRun(input(f,t.tid),pageUser);await until(()=>fake.launches.length===1,'页面用户仍能启动执行');
  }finally{await o.close();f.wb.close();}
});

test('旧任务自动策略不能启动主执行：默认仅自动审查，返修和收尾等待用户',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients),seen:string[]=[];
  Object.assign(o as any,{dispatchReview:()=>{seen.push('review');return {};},dispatchRun:()=>{seen.push('main');return {};},continueRun:()=>{seen.push('rework');return {};}});
  try{
    const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:true,auto_rework:true,continue_after_review:true,max_rework_rounds:2}});deliver(f,t.tid,t.rid);
    await(o as any).tick();assert.deepEqual(seen,['review']);seen.length=0;
    for(const status of ['changes_requested','awaiting_closeout']){f.wb.put('tasks',{...f.wb.get('tasks',t.tid),status},{project_id:'P-workbench'});await(o as any).tick();assert.deepEqual(seen,[]);}
  }finally{await o.close();f.wb.close();}
});

for(const boundary of ['queued','resolving'] as const)test('关闭许可后已排队主执行不能启动：'+boundary,async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
  let resolveEntered=false,release=()=>{};const gate=new Promise<void>(done=>{release=done;});
  const originalResolve=fake.clients.resolve;fake.clients.resolve=async(...args)=>{resolveEntered=true;if(boundary==='resolving')await gate;return originalResolve(...args);};
  try{
    const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:false,auto_rework:true,continue_after_review:true,max_rework_rounds:2}});deliver(f,t.tid,t.rid);
    f.wb.put('tasks',{...f.wb.get('tasks',t.tid),status:'awaiting_closeout'},{project_id:'P-workbench'});
    setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'automatic'},pageUser);
    const job=o.dispatchRun(input(f,t.tid),{role:'system',source:'automation'});
    if(boundary==='resolving')await until(()=>resolveEntered,'客户端准备边界应可控');
    setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'user'},pageUser);
    // Re-enabling cannot revive a queue entry created under the withdrawn permission.
    setMainExecutionControl(f.wb,t.tid,{expected_revision:f.wb.get('tasks',t.tid).revision,main_execution_control:'automatic'},pageUser);
    release();const stopped=await terminal(f,job.job_id);assert.equal(stopped.status,'failed');assert.match(stopped.reason,/许可已变化/);
    assert.equal(fake.builds.length,0);assert.equal(fake.launches.length,0);assert.equal(resolveEntered,boundary==='resolving');
  }finally{release();await o.close();f.wb.close();}
});

test('没有外部路线的本人仍可经runner建立返修续单，独立审查不受主执行开关限制',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
  try{
    const t=planned(f);deliver(f,t.tid,t.rid);
    const review=o.dispatchReview(input(f,t.tid));await until(()=>fake.launches.length===1,'独立审查可直接派发');
    finishReview(f,review.review_id!,'changes_requested');fake.releases[0]();await terminal(f,review.job_id);
    const result=o.continueRun(input(f,t.tid),{role:'runner',source:'mcp'});
    assert.equal(result.automatic_delivery,false);assert.notEqual(result.run_id,t.rid);assert.equal(fake.launches.length,1);
    assert.equal(f.wb.get('runs',result.run_id).agent_id,'codex');assert.equal(f.wb.get('tasks',t.tid).execution_route,undefined);
  }finally{await o.close();f.wb.close();}
});
test('fresh review retry replaces only failed running RA without user text while preserving peer report',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f);deliver(f,t.tid,t.rid);const first=o.dispatchReview(input(f,t.tid));await until(()=>fake.launches.length===1,'初次独立审查启动');
 grokSession(fake.launches[0],'retry-old-independent-session');startReview(f.wb,{review_id:first.review_id!,identity:'grok-build',session_id:'retry-old-independent-session'});
 const peer=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'claude',requested_model:'synthetic-peer-review',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'用户并行增加真实独立审查成员'},{role:'user'});finishReview(f,peer.review_id,'changes_requested');
 fake.releases[0]({exitCode:1,signal:null,error:'隔离测试的审查进程已确认结束'});const ended=await terminal(f,first.job_id);assert.equal(ended.status,'failed');assert.equal(ended.process_may_be_running,false);
 const retry=o.dispatchReview({...input(f,t.tid),review_id:first.review_id!,fresh_session:true});await until(()=>fake.launches.length===2,'没有额外用户文字也能恢复已确认结束的失败调用');
 assert.notEqual(retry.review_id,first.review_id);assert.equal(f.wb.get('review_assignments',first.review_id!).status,'cancelled');assert.equal(f.wb.get('review_assignments',peer.review_id).status,'completed');assert.equal(f.wb.all('reviews').length,1);assert.equal(f.wb.all('reviews')[0].review_id,peer.review_id);assert.equal(f.wb.get('review_assignments',retry.review_id!).reviewer_id,'grok-build');assert.equal(fake.builds[1].sessionId,undefined);assert.equal(f.wb.get('agent_jobs',first.job_id).session_id,'retry-old-independent-session');
 grokSession(fake.launches[1],'retry-new-independent-session');finishReview(f,retry.review_id!,'passed','retry-new-independent-session');fake.releases[1]();assert.equal((await terminal(f,retry.job_id)).status,'completed');assert.equal(f.wb.get('review_assignments',first.review_id!).session_id,'retry-old-independent-session');assert.equal(f.wb.get('review_assignments',retry.review_id!).session_id,'retry-new-independent-session');
 }finally{await o.close();f.wb.close();}
});

test('runner same-session route rework is local, idempotent, scoped and outside automatic retry budget',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:false,auto_rework:false,continue_after_review:false,max_rework_rounds:1}});deliver(f,t.tid,t.rid);
 const ra=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'隔离测试真实状态路径',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,ra.review_id,'changes_requested');
 f.wb.put('tasks',{...f.wb.get('tasks',t.tid),automatic_rework_count:99},{project_id:'P-workbench'});
 const request=input(f,t.tid),caller={role:'runner',source:'mcp',run_id:t.rid} as const;
 assert.throws(()=>o.continueRun(request,{...caller,run_id:'R-'+crypto.randomUUID()}),/跨Run/);
 const result=o.continueRun(request,caller);assert.equal(result.continuation.mode,'same_session');assert.equal(result.automatic_delivery,false);assert.notEqual(result.run_id,t.rid);const {taskAction}=await import('../src/shared/workflow-view.ts');assert.equal(f.wb.get('runs',result.run_id).has_started,false);assert.equal(f.wb.get('tasks',t.tid).status,'awaiting_dispatch');assert.equal(taskAction(f.wb.get('tasks',t.tid)).owner,'agent');assert.equal(result.context.next_action.owner,'agent');assert.equal(f.wb.get('tasks',t.tid).automatic_rework_count,99);assert.equal(f.wb.all('agent_jobs').length,0);
 assert.deepEqual(o.continueRun(request,caller),result);
 const {resolveRunnerRun}=await import('../src/core/run-continuation-scope.ts');assert.equal(resolveRunnerRun(f.wb,t.rid),result.run_id);
 f.wb.put('tasks',{...f.wb.get('tasks',t.tid),pending_arrangement:{agent_id:'codex'}},{project_id:'P-workbench'});
 assert.throws(()=>resolveRunnerRun(f.wb,t.rid),/改派/);assert.throws(()=>o.continueRun(request,caller),/改派/);
 }finally{await o.close();f.wb.close();}
});

test('runner closeout returns current context without dispatching an execution route',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,executionRoute(f));deliver(f,t.tid,t.rid);const ra=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'隔离测试收尾路径',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,ra.review_id);
 const request=input(f,t.tid),caller={role:'runner',source:'mcp',run_id:t.rid} as const;
 const result=o.continueRun(request,caller);assert.equal(result.run_id,t.rid);assert.equal(result.closeout_context.run_id,t.rid);assert.equal(f.wb.all('agent_jobs').length,0);assert.deepEqual(o.continueRun(request,caller),result);
 }finally{await o.close();f.wb.close();}
});

test('same-session continuation blocks active execution and forged scope chains',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,executionRoute(f));deliver(f,t.tid,t.rid);const ra=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'隔离测试续接保护',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,ra.review_id,'changes_requested');
 const jid='AJ-'+crypto.randomUUID();f.wb.put('agent_jobs',{id:jid,task_id:t.tid,run_id:t.rid,role:'execution',status:'running',revision:1},{run_id:t.rid});
 assert.throws(()=>o.continueRun(input(f,t.tid),{role:'runner',source:'mcp',run_id:t.rid}),/并发接续/);assert.equal(f.wb.all('runs').length,1);
 f.wb.put('agent_jobs',{...f.wb.get('agent_jobs',jid),status:'completed',process_may_be_running:false},{run_id:t.rid});
 const result=o.continueRun(input(f,t.tid),{role:'runner',source:'mcp',run_id:t.rid});const {resolveRunnerRun}=await import('../src/core/run-continuation-scope.ts');assert.equal(resolveRunnerRun(f.wb,t.rid),result.run_id);
 const source=f.wb.get('runs',t.rid);source.continuations[0].result.continuation.source_run_id=result.run_id;f.wb.put('runs',source,{task_id:t.tid});assert.throws(()=>resolveRunnerRun(f.wb,t.rid),/唯一/);
 }finally{await o.close();f.wb.close();}
});

test('managed execution capability continues the owned process, keeps origin and completes from latest Run',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,executionRoute(f));const job=o.dispatchRun(input(f,t.tid),pageUser);await until(()=>fake.launches.length===1,'受管执行已启动');
 const launch=fake.launches[0],env=launch.env!,{authenticateExecutionJob}=await import('../src/core/execution-job-capability.ts');
 assert.equal(env.WORKBENCH_EXECUTION_JOB_ID,job.job_id);assert.equal(env.WORKBENCH_EXECUTION_JOB_TOKEN.length,64);assert(!JSON.stringify(f.wb.get('agent_jobs',job.job_id)).includes(env.WORKBENCH_EXECUTION_JOB_TOKEN));
 assert.equal(authenticateExecutionJob(f.wb,t.rid,undefined,undefined),undefined);assert.throws(()=>authenticateExecutionJob(f.wb,t.rid,job.job_id,'0'.repeat(64)),/能力凭据/);
 deliver(f,t.tid,t.rid);const ra=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'受管进程返修能力测试',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,ra.review_id,'changes_requested');
 const request=input(f,t.tid);assert.throws(()=>o.continueRun(request,{role:'runner',source:'mcp',run_id:t.rid}),/并发接续/);
 const own=authenticateExecutionJob(f.wb,t.rid,env.WORKBENCH_EXECUTION_JOB_ID,env.WORKBENCH_EXECUTION_JOB_TOKEN)!;
 const foreign='AJ-'+crypto.randomUUID();f.wb.put('agent_jobs',{id:foreign,run_id:t.rid,task_id:t.tid,role:'execution',status:'queued',revision:1},{run_id:t.rid});assert.throws(()=>o.continueRun(request,{role:'runner',source:'mcp',run_id:t.rid,job_id:own}),/并发接续/);f.wb.put('agent_jobs',{...f.wb.get('agent_jobs',foreign),status:'completed'},{run_id:t.rid});
 const next=o.continueRun(request,{role:'runner',source:'mcp',run_id:t.rid,job_id:own});assert.notEqual(next.run_id,t.rid);const stored=f.wb.get('agent_jobs',own);assert.equal(stored.run_id,t.rid);assert.equal(stored.continuation_runs[0].target_run_id,next.run_id);
 assert.equal(authenticateExecutionJob(f.wb,t.rid,own,env.WORKBENCH_EXECUTION_JOB_TOKEN),own);await(o as any).tick();assert.equal(launch.signal.aborted,false);
 // Exiting with only the old Run submitted must fail: final completion follows the new Run.
 fake.releases[0]();const ended=await terminal(f,own);assert.equal(ended.status,'failed');assert.equal(f.wb.get('tasks',t.tid).automation.job_id,own);assert.equal(f.wb.get('tasks',t.tid).automation.status,'failed');assert.equal(f.wb.get('tasks',t.tid).automation.run_id,next.run_id);const {taskAction}=await import('../src/shared/workflow-view.ts');assert.equal(taskAction(f.wb.get('tasks',t.tid)).group,'decision');assert.equal(f.wb.get('runs',next.run_id).has_started,false);
 }finally{await o.close();f.wb.close();}
});

test('managed execution final result belongs to continued current Run',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,executionRoute(f)),job=o.dispatchRun(input(f,t.tid),pageUser);await until(()=>fake.launches.length===1,'受管执行启动');deliver(f,t.tid,t.rid);const ra=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'受管最终回执测试',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,ra.review_id,'changes_requested');
 const {authenticateExecutionJob}=await import('../src/core/execution-job-capability.ts'),env=fake.launches[0].env!,own=authenticateExecutionJob(f.wb,t.rid,job.job_id,env.WORKBENCH_EXECUTION_JOB_TOKEN)!;const next=o.continueRun(input(f,t.tid),{role:'runner',source:'mcp',run_id:t.rid,job_id:own});deliver(f,t.tid,next.run_id);await(o as any).tick();assert.equal(fake.launches[0].signal.aborted,false);fake.releases[0]();assert.equal((await terminal(f,own)).status,'completed');assert.equal(f.wb.get('agent_jobs',own).run_id,t.rid);assert.equal(f.wb.get('runs',next.run_id).status,'submitted');assert.equal(f.wb.get('tasks',t.tid).automation.status,'completed');assert.equal(f.wb.get('tasks',t.tid).automation.run_id,next.run_id);assert.equal(f.wb.get('tasks',t.tid).automation.source_run_id,t.rid);assert.throws(()=>authenticateExecutionJob(f.wb,t.rid,job.job_id,env.WORKBENCH_EXECUTION_JOB_TOKEN),/失效/);
 }finally{await o.close();f.wb.close();}
});

test('submitted owned managed process can await automatic independent review without exiting or spawning another main',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,{...executionRoute(f),automation_policy:{auto_review:true,auto_rework:true,continue_after_review:true,max_rework_rounds:2}}),job=o.dispatchRun(input(f,t.tid),pageUser);await until(()=>fake.launches.length===1,'受管执行启动');deliver(f,t.tid,t.rid);
 await(o as any).tick();await until(()=>fake.launches.length===2,'执行本人等待时独立审查可自动启动');assert.equal(f.wb.all('agent_jobs').filter(j=>j.role==='execution').length,1);assert.equal(fake.launches[0].signal.aborted,false);await(o as any).tick();assert.equal(fake.launches.length,2);
 const review=f.wb.all('agent_jobs').find(j=>j.role==='review')!;finishReview(f,review.review_id,'changes_requested');fake.releases[1]();await terminal(f,review.id);await(o as any).tick();assert.equal(f.wb.all('runs').length,1);assert.equal(f.wb.all('agent_jobs').filter(j=>j.role==='execution').length,1);assert.equal(f.wb.get('agent_jobs',job.job_id).status,'running');fake.releases[0]();await terminal(f,job.job_id);
 }finally{await o.close();f.wb.close();}
});

test('managed original process finishes reviewed continued Run closeout without a second main process',async()=>{
 const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
 try{const t=planned(f,executionRoute(f)),job=o.dispatchRun(input(f,t.tid),pageUser);await until(()=>fake.launches.length===1,'受管执行启动');deliver(f,t.tid,t.rid);const review=()=>exportReviewOrder(f.wb,{run_id:f.wb.get('tasks',t.tid).current_run_id,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'受管本人连续收尾测试',delivery_mode:'agent'},{role:'runner',id:'test'});finishReview(f,review().review_id,'changes_requested');
 const {authenticateExecutionJob}=await import('../src/core/execution-job-capability.ts'),env=fake.launches[0].env!,own=authenticateExecutionJob(f.wb,t.rid,job.job_id,env.WORKBENCH_EXECUTION_JOB_TOKEN)!;const next=o.continueRun(input(f,t.tid),{role:'runner',source:'mcp',run_id:t.rid,job_id:own});deliver(f,t.tid,next.run_id);finishReview(f,review().review_id);const closing=o.continueRun(input(f,t.tid),{role:'runner',source:'mcp',run_id:next.run_id,job_id:own});assert.equal(closing.closeout_context.run_id,next.run_id);finishCloseout(f.wb,t.tid);await(o as any).tick();assert.equal(fake.launches[0].signal.aborted,false);assert.equal(fake.launches.length,1);fake.releases[0]();assert.equal((await terminal(f,own)).status,'completed');assert.equal(f.wb.get('tasks',t.tid).status,'awaiting_confirmation');
 }finally{await o.close();f.wb.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.ts';
import {Workgroups} from '../src/core/workgroups.ts';
import type {WorkgroupCaller,WorkgroupRunner,WorkgroupRuntimeInput,WorkgroupRuntimeResult} from '../src/core/workgroup-schema.ts';
import {callWorkgroupTool} from '../src/mcp/workgroup-tools.ts';

const done=(text='合成成员公开结果',nativeSessionId?:string):WorkgroupRuntimeResult=>({status:'completed',text,exitCode:0,processStopped:true,...(nativeSessionId?{nativeSessionId}:{})});
const create=(groups:Workgroups,extra:Record<string,unknown>={})=>groups.create({request_id:randomUUID(),project_id:'P-workbench',name:'隔离工作群',leader_agent_id:'codex',member_agent_ids:['claude'],...extra});
const dispatch=(groups:Workgroups,room:string,member:string,extra:Record<string,unknown>={})=>groups.dispatch(room,{request_id:randomUUID(),member_id:member,instruction:'仅在合成夹具中验证任务',...extra});
function harness(t:any,runner:WorkgroupRunner=async()=>done(),extra:Record<string,unknown>={}){const f=fixture(),groups=new Workgroups(f.wb,{runner,autoStart:false,...extra});t.after(async()=>{await groups.close();f.wb.close();});return {...f,groups};}
async function settle(groups:Workgroups,room:string){for(let i=0;i<20;i++){await groups.drain();const jobs=groups.detail(room).jobs;await Promise.all(jobs.filter(j=>j.status==='running').map(j=>groups.wait(j.id,2000)));if(!groups.detail(room).jobs.some(j=>['queued','running'].includes(j.status)))return;}throw Error('synthetic_queue_did_not_settle');}
function memberCaller(room:any,member:any):WorkgroupCaller{return {kind:'agent',id:'runner:fixture',agent_id:member.agent_id,member_id:member.id,room_id:room.id,project_ids:[room.project_id]};}

test('room and message idempotence preserve sequence without creating tasks',async t=>{
  let calls=0;const f=harness(t,async()=>{calls++;return done();}),request={request_id:randomUUID(),project_id:'P-workbench',name:'隔离群',leader_agent_id:'codex',member_agent_ids:['claude']};
  const created=f.groups.create(request);assert.equal(f.groups.create(request).room.id,created.room.id);
  assert.throws(()=>f.groups.create({...request,request_id:randomUUID(),member_agent_ids:Array.from({length:16},(_,i)=>'synthetic-'+i)}),/最多16位成员/);
  const input={request_id:randomUUID(),content:'普通讨论，不唤醒'};const first=f.groups.post(created.room.id,input);assert.equal(f.groups.post(created.room.id,input).message.id,first.message.id);
  assert.throws(()=>f.groups.post(created.room.id,{...input,content:'改变请求正文'}),/同一请求/);await f.groups.drain();assert.equal(calls,0);assert.equal(f.groups.detail(created.room.id).room.seq,1);assert.equal(f.wb.all('tasks').length,0);
});

test('manager management records real actor and user instruction, enforces project and path scope',t=>{
  const f=harness(t),sub=path.join(f.root,'scope');fs.mkdirSync(sub);const caller:WorkgroupCaller={kind:'manager',id:'runner:real-fixture',management:true,project_ids:['P-workbench'],allowed_paths:[sub]};
  const base={request_id:randomUUID(),user_instruction:'在这个项目创建工作群并允许成员协作',action:'create',data:{project_id:'P-workbench',name:'有界群',leader_agent_id:'claude',member_agent_ids:['codex'],allowed_paths:[sub]}};
  const created=f.groups.manage(base,caller) as any;assert.equal(created.room.authorization.actor,caller.id);assert.equal(created.room.authorization.source,'manager');
  const again=f.groups.manage(base,caller) as any;assert.equal(again.room.id,created.room.id);
  assert.throws(()=>f.groups.manage({...base,request_id:randomUUID(),data:{...base.data,allowed_paths:[f.root]}},caller),/授权根目录/);
  assert.throws(()=>f.groups.manage({...base,request_id:randomUUID()},memberCaller(created.room,created.members[0])),/管理身份/);
  const audit=f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='manage_workgroups'").get() as any;assert.equal(audit.actor,caller.id);assert.equal(JSON.parse(audit.data).user_instruction,base.user_instruction);
});

test('leader executes once, delegates a real child, receives one bounded result turn with its own session',async t=>{
  let groups:Workgroups,room:any,leader:any,child:any;const inputs:WorkgroupRuntimeInput[]=[];let delegated=false;
  const f=harness(t,async input=>{inputs.push(input);input.onSessionId(input.agentId==='codex'?'leader-session':'child-session');const caller=groups.authenticate(input.mcp.token)!;assert(caller);
    if(input.agentId==='codex'&&!delegated){delegated=true;callWorkgroupTool(groups,'dispatch_workgroup_task',{room_id:room.id,request_id:randomUUID(),member_id:child.id,instruction:'成员实际执行合成工作'},caller);return done('负责人已派活','leader-session');}
    return done(input.agentId==='claude'?'成员已执行并回报':'负责人已收到成员结果并汇总',input.agentId==='codex'?'leader-session':'child-session');
  });groups=f.groups;const created=create(groups);room=created.room;leader=created.members.find(m=>m.agent_id==='codex');child=created.members.find(m=>m.agent_id==='claude');
  const started=groups.post(room.id,{request_id:randomUUID(),content:'请负责人安排执行并总结',wake:'leader'});assert(started.job);await settle(groups,room.id);
  assert.deepEqual(inputs.map(i=>i.agentId),['codex','claude','codex']);assert.equal(inputs[2].nativeSessionId,'leader-session');assert.equal(inputs[1].nativeSessionId,undefined);
  const jobs=groups.detail(room.id).jobs;assert.equal(jobs.filter(j=>j.result_of).length,1);assert.equal(jobs.find(j=>j.result_of)!.actor.kind,'system');assert(jobs.every(j=>j.status==='completed'));assert.equal(f.wb.all('tasks').length,0);
});

test('zero automatic replies still allows explicit member dispatch and exposes pending feedback',async t=>{
  let groups:Workgroups,room:any,child:any,first=true;const f=harness(t,async input=>{if(input.agentId==='codex'&&first){first=false;groups.dispatch(room.id,{request_id:randomUUID(),member_id:child.id,instruction:'预算为零仍可明确派活'},groups.authenticate(input.mcp.token)!);}return done();});groups=f.groups;const created=create(groups,{max_followups:0});room=created.room;child=created.members.find(m=>m.agent_id==='claude');groups.post(room.id,{request_id:randomUUID(),content:'负责人执行任务',wake:'leader'});await settle(groups,room.id);const jobs=groups.detail(room.id).jobs;assert.equal(jobs.length,2);const childJob=jobs.find(j=>j.member_id===child.id)!;assert.equal(childJob.status,'completed');assert.equal(childJob.followup_status,'pending_budget');assert(childJob.followup_reason.includes('收件箱'));
});

test('job credentials bind one room/member, cannot impersonate or increase authority, and expire',async t=>{
  let release!:()=>void,current!:WorkgroupRuntimeInput;const gate=new Promise<void>(resolve=>release=resolve);const f=harness(t,async input=>{current=input;await gate;return done();});const a=create(f.groups),b=create(f.groups);const first=dispatch(f.groups,a.room.id,a.room.leader_member_id);await f.groups.drain();
  const caller=f.groups.authenticate(current.mcp.token)!;assert(caller);assert.equal(f.groups.list(undefined,caller).rooms.length,1);
  assert.throws(()=>f.groups.detail(b.room.id,{},caller),/跨工作群/);assert.throws(()=>callWorkgroupTool(f.groups,'post_workgroup_message',{room_id:a.room.id,request_id:randomUUID(),content:'冒充用户',sender:{kind:'user'}},caller));
  assert.throws(()=>f.groups.manage({request_id:randomUUID(),user_instruction:'自行增加权限',action:'update',room_id:a.room.id,data:{expected_revision:1,auto_dispatch:true}},caller),/管理身份/);
  const persisted=f.wb.db.prepare('SELECT data,token_hash FROM workgroup_jobs WHERE id=?').get(first.id) as any;assert(!JSON.stringify(persisted).includes(current.mcp.token));assert(!current.prompt.includes(current.mcp.token));assert.equal(current.mcp.tools.length,7);
  const child=a.members.find(m=>m.agent_id==='claude')!;const reflected=f.groups.dispatch(a.room.id,{request_id:randomUUID(),member_id:child.id,instruction:'误回显 '+current.mcp.token},caller);assert(!JSON.stringify(reflected).includes(current.mcp.token));assert(!JSON.stringify(f.groups.detail(a.room.id)).includes(current.mcp.token));
  release();await f.groups.wait(first.id);assert.equal(f.groups.authenticate(current.mcp.token),null);
});

test('inbox delivery and acknowledgement are durable, bounded and member-specific',t=>{
  const f=harness(t),created=create(f.groups),caller=memberCaller(created.room,created.members[0]);for(let i=0;i<4;i++)f.groups.post(created.room.id,{request_id:randomUUID(),content:'消息'+i});
  assert.throws(()=>f.groups.ack({room_id:created.room.id,through_seq:2},caller),/未投递/);assert.throws(()=>f.groups.inbox({room_id:created.room.id,after_seq:4},caller),/跳过/);
  const first=f.groups.inbox({room_id:created.room.id,limit:2},caller);assert.equal(first.messages.length,2);assert.equal(first.cursor,0);f.groups.ack({room_id:created.room.id,through_seq:first.next_seq},caller);
  assert.equal(f.groups.inbox({room_id:created.room.id},caller).messages.length,2);const other=f.groups.inbox({room_id:created.room.id},memberCaller(created.room,created.members[1]));assert.equal(other.cursor,0);assert.equal(other.messages.length,4);
  const page=f.groups.detail(created.room.id,{limit:2});assert.deepEqual(page.messages.map(m=>m.seq),[3,4]);assert(page.has_older);assert.deepEqual(f.groups.detail(created.room.id,{before_seq:3,limit:2}).messages.map(m=>m.seq),[1,2]);
});

test('narrow runner cannot use wider room paths and cross-project task links are rejected',t=>{
  const f=harness(t),created=create(f.groups),sub=path.join(f.root,'narrow');fs.mkdirSync(sub);const caller={...memberCaller(created.room,created.members[0]),allowed_paths:[sub]};
  assert.throws(()=>f.groups.dispatch(created.room.id,{request_id:randomUUID(),member_id:created.members[1].id,instruction:'不能扩展目录'},caller),/授权根目录/);
  assert.throws(()=>f.groups.dispatch(created.room.id,{request_id:randomUUID(),member_id:created.members[1].id,instruction:'跨项目链接',task_id:'missing-task'}),/不存在/);
  const manager:WorkgroupCaller={kind:'manager',id:'narrow-runner',management:true,project_ids:['P-workbench'],allowed_paths:[sub]};
  assert.equal(f.groups.list(undefined,manager).rooms.length,0);
  assert.throws(()=>f.groups.detail(created.room.id,{},manager),/授权根目录/);
  assert.throws(()=>f.groups.manage({request_id:randomUUID(),user_instruction:'本Run只授权子目录',action:'update',room_id:created.room.id,data:{expected_revision:1,auto_dispatch:false}},manager),/授权根目录/);
  assert.throws(()=>f.groups.addRoomMember(created.room.id,{request_id:randomUUID(),agent_id:'deepseek'},manager),/授权根目录/);
  assert.throws(()=>f.groups.removeMember(created.room.id,created.members[1].id,1,manager),/授权根目录/);
});

test('same-member jobs serialize and a still-live cancelled process blocks the next job',async t=>{
  let finish!:()=>void,calls=0,alive=true;const gate=new Promise<void>(resolve=>finish=resolve);const f=harness(t,async input=>{calls++;if(calls===1){input.onSpawn(123456);await gate;return {...done(),status:'cancelled',processStopped:false};}return done();},{processAlive:()=>alive});const created=create(f.groups,{max_followups:0}),a=dispatch(f.groups,created.room.id,created.room.leader_member_id),b=dispatch(f.groups,created.room.id,created.room.leader_member_id);
  await f.groups.drain();assert.equal(calls,1);f.groups.cancel(created.room.id,a.id);finish();await f.groups.wait(a.id);await f.groups.drain();assert.equal(calls,1);assert.equal(f.groups.getJob(created.room.id,b.id).status,'queued');
  alive=false;await settle(f.groups,created.room.id);assert.equal(calls,2);assert.equal(f.groups.getJob(created.room.id,b.id).status,'completed');
});

test('service restart interrupts old jobs and revokes grants without replaying a live or unknown process',async t=>{
  const f=fixture();let alive=true,calls=0;const initial=new Workgroups(f.wb,{autoStart:false,runner:async()=>done()});const created=create(initial),old=dispatch(initial,created.room.id,created.room.leader_member_id),queued=dispatch(initial,created.room.id,created.room.leader_member_id);
  const stored={...old,status:'running',process_pid:456789,process_may_be_running:true};f.wb.db.prepare('UPDATE workgroup_jobs SET status=?,token_hash=?,data=? WHERE id=?').run('running','synthetic-old-token-hash',JSON.stringify(stored),old.id);await initial.close();
  const restored=new Workgroups(f.wb,{autoStart:false,processAlive:()=>alive,runner:async()=>{calls++;return done();}});t.after(async()=>{await restored.close();f.wb.close();});assert.equal(restored.getJob(created.room.id,old.id).status,'interrupted');assert(restored.getJob(created.room.id,old.id).recovery_required);await restored.drain();assert.equal(calls,0);assert.equal(restored.getJob(created.room.id,queued.id).status,'queued');
  assert.throws(()=>restored.resume(created.room.id,old.id,{request_id:randomUUID()}),/未确认退出/);alive=false;await settle(restored,created.room.id);assert.equal(calls,1);assert.equal(restored.getJob(created.room.id,old.id).status,'interrupted');
});

test('native session mismatch is visible and does not overwrite the member session',async t=>{
  let calls=0;const f=harness(t,async input=>{calls++;if(calls===1){input.onSessionId('session-original');return done('首次完成','session-original');}return done('错误会话','session-other');});const created=create(f.groups,{max_followups:0});const first=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();await f.groups.wait(first.id);const second=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();const result=await f.groups.wait(second.id);assert.equal(result.status,'failed');assert.equal(result.error_code,'session_mismatch');assert(result.error_message.includes('新会话'));assert.equal(f.groups.detail(created.room.id).members.find(m=>m.id===created.room.leader_member_id)!.native_session_id,'session-original');
});

test('room pause retains queues, cancellation before launch spends no runtime call, and history is independently readable',async t=>{
  let calls=0;const f=harness(t,async()=>{calls++;return done('历史结果');}),created=create(f.groups);const job=dispatch(f.groups,created.room.id,created.room.leader_member_id);f.groups.update(created.room.id,{expected_revision:created.room.revision,status:'paused'});await f.groups.drain();assert.equal(calls,0);f.groups.cancel(created.room.id,job.id);assert.equal(f.groups.getJob(created.room.id,job.id).status,'cancelled');const detail=f.groups.jobDetail(created.room.id,job.id);assert.equal(detail.job.id,job.id);assert(detail.messages.some(m=>m.kind==='dispatch'));
});

test('external bridge definitions are passed without a manager credential',async t=>{
  let captured!:WorkgroupRuntimeInput;const extra={name:'list_external_services',description:'合成外部工具',inputSchema:{type:'object'}};const f=harness(t,async input=>{captured=input;return done();},{additionalTools:[extra]});const created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();await f.groups.wait(job.id);assert.equal(captured.mcp.tools.length,8);assert(captured.mcp.tools.some(t=>t.name==='list_external_services'));assert.notEqual(captured.mcp.token,f.wb.keys.manager);assert.equal(captured.cwd,f.root);assert(!captured.allowedRoots.includes(f.config.dataDir));
});

test('managed artifacts create a private ignore file without replacing an existing file',async t=>{
  let captured!:WorkgroupRuntimeInput;const f=harness(t,async input=>{captured=input;return done();}),created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();await f.groups.wait(job.id);
  const ignore=path.join(f.root,'.workbench-workgroups','.gitignore');assert.equal(fs.readFileSync(ignore,'utf8'),'*\n');assert(captured.prompt.includes('不得提交、打包'));
  fs.writeFileSync(ignore,'# fixture-owned existing rules\n*\n');const before=fs.readFileSync(ignore),next=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();await f.groups.wait(next.id);assert.deepEqual(fs.readFileSync(ignore),before);
});

test('managed artifact junction is rejected before creating files or starting the native runner',async t=>{
  let calls=0;const f=harness(t,async()=>{calls++;return done();}),target=path.join(f.root,'linked-target'),managed=path.join(f.root,'.workbench-workgroups');fs.mkdirSync(target);fs.symlinkSync(target,managed,'junction');const created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();const result=await f.groups.wait(job.id);assert.equal(result.status,'failed');assert.equal(calls,0);assert.equal(fs.readdirSync(target).length,0);assert(fs.lstatSync(managed).isSymbolicLink());
});

test('archived agents cannot join and retiring a queued member blocks native startup',async t=>{
  let calls=0;const f=harness(t,async()=>{calls++;return done();}),created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);const agent=f.wb.get('agents','codex');f.wb.transaction(()=>f.wb.put('agents',{...agent,archived:true}));
  assert.throws(()=>create(f.groups),/已归档/);await f.groups.drain();const result=await f.groups.wait(job.id);assert.equal(result.status,'blocked');assert.equal(result.error_code,'agent_unavailable');assert(result.error_message.includes('没有启动客户端'));assert.equal(calls,0);assert(!fs.existsSync(path.join(f.root,'.workbench-workgroups')));
});

test('explicit start waits for the server lifecycle and then enables automatic queue draining once',async t=>{
  let calls=0;const f=harness(t,async()=>{calls++;return done();}),created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(f.groups.getJob(created.room.id,job.id).status,'queued');
  f.groups.start();f.groups.start();const result=await f.groups.wait(job.id);assert.equal(result.status,'completed');assert.equal(calls,1);
  const next=dispatch(f.groups,created.room.id,created.room.leader_member_id);assert.equal((await f.groups.wait(next.id)).status,'completed');assert.equal(calls,2);
});

test('only the selected public native error reaches the job, bounded and without its scoped credential',async t=>{
  let token='';const f=harness(t,async input=>{token=input.mcp.token;return {status:'failed',text:'',errorCode:'native_api_error',errorMessage:'429 session limit resets 9:50am '+token+' '+'.'.repeat(1200),exitCode:1,processStopped:true,stderr:'RAW_STDERR_MUST_NOT_BE_PUBLISHED',stdout:'RAW_STDOUT_MUST_NOT_BE_PUBLISHED'};}),created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();const result=await f.groups.wait(job.id);
  assert(result.error_message.startsWith('429 session limit resets 9:50am'));assert.equal(result.error_message.length,1000);assert(!result.error_message.includes(token));const detail=f.groups.jobDetail(created.room.id,job.id);assert(detail.messages.some(m=>m.kind==='result'&&m.content===result.error_message));assert(!JSON.stringify(detail).includes('RAW_STDERR'));assert(!JSON.stringify(detail).includes('RAW_STDOUT'));assert(!JSON.stringify(detail).includes(token));
});

test('closing during preparation persists an unspawned terminal receipt and lets the queue continue after restart',async t=>{
  const f=fixture();let input!:WorkgroupRuntimeInput,calls=0;
  const initial=new Workgroups(f.wb,{autoStart:false,runner:async current=>{input=current;await new Promise<void>(resolve=>current.signal.addEventListener('abort',()=>resolve(),{once:true}));return {...done('准备取消，未启动原生进程'),status:'cancelled'};}});
  let restored:Workgroups|undefined;t.after(async()=>{await initial.close();await restored?.close();f.wb.close();});
  const created=create(initial,{max_followups:0}),old=dispatch(initial,created.room.id,created.room.leader_member_id),queued=dispatch(initial,created.room.id,created.room.leader_member_id);
  await initial.drain();const preparing=initial.getJob(created.room.id,old.id);assert.equal(preparing.process_phase,'preparing');assert.equal(preparing.process_may_be_running,false);assert.equal(preparing.process_pid,null);assert(initial.authenticate(input.mcp.token));
  const closing=initial.close();assert.equal(initial.authenticate(input.mcp.token),null);await closing;
  const stopped=initial.getJob(created.room.id,old.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.process_phase,'stopped');assert.equal(stopped.process_may_be_running,false);assert.equal(stopped.process_end_evidence,'not_spawned');assert.equal(stopped.recovery_required,false);assert(stopped.result_message_id);
  assert.equal((f.wb.db.prepare('SELECT token_hash FROM workgroup_jobs WHERE id=?').get(old.id) as any).token_hash,null);
  restored=new Workgroups(f.wb,{autoStart:false,runner:async()=>{calls++;return done();}});await settle(restored,created.room.id);assert.equal(calls,1);assert.equal(restored.getJob(created.room.id,queued.id).status,'completed');assert.equal(restored.getJob(created.room.id,old.id).status,'cancelled');
  const resumed=restored.resume(created.room.id,old.id,{request_id:randomUUID()});await settle(restored,created.room.id);assert.equal(restored.getJob(created.room.id,resumed.id).status,'completed');assert.equal(calls,2);
});

test('restart recovers explicitly unspawned preparation but retains both spawn-intent and legacy no-PID uncertainty',async t=>{
  for(const phase of ['preparing','spawn_requested','legacy'] as const)await t.test(phase,async t=>{
    const f=fixture();let calls=0;const initial=new Workgroups(f.wb,{autoStart:false});const created=create(initial,{max_followups:0}),old=dispatch(initial,created.room.id,created.room.leader_member_id),queued=dispatch(initial,created.room.id,created.room.leader_member_id);
    const stored={...old,status:'running',process_phase:phase==='legacy'?undefined:phase,process_pid:null,process_may_be_running:phase!=='preparing'};
    f.wb.db.prepare('UPDATE workgroup_jobs SET status=?,token_hash=?,data=? WHERE id=?').run('running','synthetic-old-token-hash',JSON.stringify(stored),old.id);await initial.close();
    const restored=new Workgroups(f.wb,{autoStart:false,processAlive:()=>false,runner:async()=>{calls++;return done();}});t.after(async()=>{await restored.close();f.wb.close();});const interrupted=restored.getJob(created.room.id,old.id);assert.equal(interrupted.status,'interrupted');assert.equal((f.wb.db.prepare('SELECT token_hash FROM workgroup_jobs WHERE id=?').get(old.id) as any).token_hash,null);
    if(phase==='preparing'){assert.equal(interrupted.process_may_be_running,false);assert.equal(interrupted.process_end_evidence,'not_spawned');await settle(restored,created.room.id);assert.equal(calls,1);assert.equal(restored.getJob(created.room.id,queued.id).status,'completed');}
    else {assert.equal(interrupted.process_may_be_running,true);assert.equal(interrupted.recovery_required,true);await restored.drain();assert.equal(calls,0);assert.equal(restored.getJob(created.room.id,queued.id).status,'queued');assert.throws(()=>restored.resume(created.room.id,old.id,{request_id:randomUUID()}),/未确认退出/);}
  });
});

test('spawn intent is durable before PID notification and an exception without PID remains unknown',async t=>{
  const f=fixture();let groups!:Workgroups,before:any,intent:any;groups=new Workgroups(f.wb,{autoStart:false,runner:async input=>{before=groups.getJob(input.roomId,input.jobId);input.onBeforeSpawn!();intent=groups.getJob(input.roomId,input.jobId);throw Error('synthetic failure between spawn request and PID receipt');}});
  let restored:Workgroups|undefined;t.after(async()=>{await groups.close();await restored?.close();f.wb.close();});const created=create(groups,{max_followups:0}),old=dispatch(groups,created.room.id,created.room.leader_member_id),queued=dispatch(groups,created.room.id,created.room.leader_member_id);await groups.drain();const failed=await groups.wait(old.id);
  assert.equal(before.process_phase,'preparing');assert.equal(before.process_may_be_running,false);assert.equal(intent.process_phase,'spawn_requested');assert.equal(intent.process_may_be_running,true);assert(intent.spawn_requested_at);assert.equal(intent.process_pid,null);assert.equal(failed.status,'failed');assert.equal(failed.process_may_be_running,true);assert.equal(failed.process_end_evidence,'unknown');assert.equal(failed.recovery_required,true);assert.equal((f.wb.db.prepare('SELECT token_hash FROM workgroup_jobs WHERE id=?').get(old.id) as any).token_hash,null);
  await groups.close();let calls=0;restored=new Workgroups(f.wb,{autoStart:false,processAlive:()=>false,runner:async()=>{calls++;return done();}});await restored.drain();assert.equal(calls,0);assert.equal(restored.getJob(created.room.id,queued.id).status,'queued');assert.throws(()=>restored!.resume(created.room.id,old.id,{request_id:randomUUID()}),/未确认退出/);
});

test('normal close accepts late PID, session and exit receipts without scheduling a result follow-up',async t=>{
  let input!:WorkgroupRuntimeInput;const f=harness(t,async current=>{input=current;current.onBeforeSpawn!();await new Promise<void>(resolve=>current.signal.addEventListener('abort',()=>resolve(),{once:true}));current.onSpawn(654321);current.onSessionId('close-confirmed-session');return {...done('关闭前的公开退出回执','close-confirmed-session'),status:'cancelled'};},{processAlive:()=>true});
  const created=create(f.groups),child=created.members.find(m=>m.agent_id==='claude')!,job=dispatch(f.groups,created.room.id,child.id);await f.groups.drain();const pending=f.groups.getJob(created.room.id,job.id);assert.equal(pending.process_phase,'spawn_requested');assert.equal(pending.process_pid,null);assert.equal(pending.process_may_be_running,true);
  await f.groups.close();const stopped=f.groups.getJob(created.room.id,job.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.process_pid,654321);assert.equal(stopped.process_phase,'stopped');assert.equal(stopped.process_may_be_running,false);assert.equal(stopped.process_end_evidence,'owned_child_exit');assert.equal(stopped.session_id,'close-confirmed-session');assert.equal(stopped.result,'关闭前的公开退出回执');assert.equal(f.groups.detail(created.room.id).members.find(m=>m.id===child.id)!.native_session_id,'close-confirmed-session');assert.equal(f.groups.detail(created.room.id).jobs.length,1);assert.equal(stopped.followup_job_id,undefined);assert.equal(f.groups.authenticate(input.mcp.token),null);assert.equal((f.wb.db.prepare('SELECT token_hash FROM workgroup_jobs WHERE id=?').get(job.id) as any).token_hash,null);
});

test('preparation cancellation rejects a late spawn intent without recording an uncertain process',async t=>{
  let refused=false;const f=harness(t,async input=>{await new Promise<void>(resolve=>input.signal.addEventListener('abort',()=>resolve(),{once:true}));try{input.onBeforeSpawn!();}catch{refused=true;}return {...done(),status:'cancelled'};});const created=create(f.groups),job=dispatch(f.groups,created.room.id,created.room.leader_member_id);await f.groups.drain();await f.groups.close();const stopped=f.groups.getJob(created.room.id,job.id);assert.equal(refused,true);assert.equal(stopped.spawn_requested_at,undefined);assert.equal(stopped.process_may_be_running,false);assert.equal(stopped.process_end_evidence,'not_spawned');
});

test('a recorded spawn request with an explicit no-process receipt permits the next queued job',async t=>{
  let groups!:Workgroups,calls=0;const f=harness(t,async input=>{calls++;if(calls===1){input.onBeforeSpawn!();return {status:'failed',text:'',exitCode:null,errorCode:'native_spawn_failed',processStopped:true};}return done();});groups=f.groups;const created=create(groups,{max_followups:0}),old=dispatch(groups,created.room.id,created.room.leader_member_id),queued=dispatch(groups,created.room.id,created.room.leader_member_id);await settle(groups,created.room.id);const stopped=groups.getJob(created.room.id,old.id);assert.equal(stopped.process_may_be_running,false);assert.equal(stopped.process_phase,'stopped');assert.equal(stopped.process_end_evidence,'runtime_confirmed_stopped');assert.equal(stopped.error_code,'native_spawn_failed');assert.equal(groups.getJob(created.room.id,queued.id).status,'completed');assert.equal(calls,2);
});

test('explicit dispatch permits exactly 32 jobs in a root chain and idempotent retries do not consume another slot',async t=>{
  let groups!:Workgroups,room:any,child:any,accepted=0,rejected=false,duplicate=false;
  const f=harness(t,async input=>{const caller=groups.authenticate(input.mcp.token)!;for(let n=0;n<31;n++){const request={request_id:randomUUID(),member_id:child.id,instruction:'明确派活 '+n};const job=groups.dispatch(room.id,request,caller);accepted++;if(n===30)duplicate=groups.dispatch(room.id,request,caller).id===job.id;}try{groups.dispatch(room.id,{request_id:randomUUID(),member_id:child.id,instruction:'第33个明确调用不应进入队列'},caller);}catch(error){rejected=error instanceof Error&&error.message.includes('32次');}return done();});groups=f.groups;const created=create(groups,{max_followups:0});room=created.room;child=created.members.find(m=>m.agent_id==='claude');const root=dispatch(groups,room.id,room.leader_member_id);await groups.drain();assert.equal((await groups.wait(root.id)).status,'completed');assert.equal(accepted,31);assert.equal(duplicate,true);assert.equal(rejected,true);const jobs=groups.detail(room.id).jobs;assert.equal(jobs.length,32);assert(jobs.every(j=>j.root_job_id===root.id));assert.equal(jobs.filter(j=>j.status==='queued').length,31);
});

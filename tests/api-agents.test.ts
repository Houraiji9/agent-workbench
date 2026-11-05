import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fixture} from './helpers.ts';
import {ApiAgents,type ApiAgentTurn} from '../src/core/api-agents.ts';
import {API_AGENT_STATE_MAX_BYTES,normalizeApiAgentEndpoint,type ApiAgentPrivateState} from '../src/core/api-agent-schema.ts';
import type {ExternalVault} from '../src/core/external-vault.ts';
import {hash} from '../src/core/security.ts';

function syntheticVault():ExternalVault{const key=crypto.randomBytes(32);return {available:true,async encrypt(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');},async decrypt(value){const bytes=Buffer.from(value,'base64'),cipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());}};}
const base=()=>({name:'合成 API 成员',base_url:'https://fixture.example/v1',protocol:'chat_completions' as const,model:'explicit-fixture-model',api_key:'synthetic-api-secret-'+crypto.randomUUID()});
function harness(t:any,vault=syntheticVault()){const f=fixture();t.after(()=>f.wb.close());return {...f,agents:new ApiAgents(f.wb,{vault}),vault};}
function binding(f:ReturnType<typeof harness>,agentId:string,existing?:{roomId:string;memberId:string}){
  const roomId=existing?.roomId||'WG-'+crypto.randomUUID(),memberId=existing?.memberId||'WM-'+crypto.randomUUID(),jobId='WJ-'+crypto.randomUUID();
  if(!existing){f.wb.db.prepare('INSERT INTO workgroup_rooms(id,project_id,data) VALUES(?,?,?)').run(roomId,'P-workbench',JSON.stringify({id:roomId,project_id:'P-workbench'}));f.wb.db.prepare('INSERT INTO workgroup_members(id,room_id,agent_id,data) VALUES(?,?,?,?)').run(memberId,roomId,agentId,JSON.stringify({id:memberId,room_id:roomId,agent_id:agentId,status:'running',revision:1,native_session_id:null}));}
  const data={id:jobId,agent_id:agentId,room_id:roomId,member_id:memberId,status:'running',process_may_be_running:false};f.wb.db.prepare('INSERT INTO workgroup_jobs(id,room_id,member_id,status,data) VALUES(?,?,?,?,?)').run(jobId,roomId,memberId,'running',JSON.stringify(data));return {agentId,roomId,memberId,jobId};
}
function finish(f:ReturnType<typeof harness>,bound:ReturnType<typeof binding>){const row=f.wb.db.prepare('SELECT data FROM workgroup_jobs WHERE id=?').get(bound.jobId) as any;f.wb.db.prepare('UPDATE workgroup_jobs SET status=?,data=? WHERE id=?').run('completed',JSON.stringify({...JSON.parse(row.data),status:'completed'}),bound.jobId);const member=f.wb.db.prepare('SELECT data FROM workgroup_members WHERE id=?').get(bound.memberId) as any;f.wb.db.prepare('UPDATE workgroup_members SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(member.data),status:'idle'}),bound.memberId);}
const state=(lease:ApiAgentTurn,items:Record<string,unknown>[]=[]):ApiAgentPrivateState=>({schema_version:1,sessionId:lease.session.id,protocol:lease.config.protocol,model:lease.config.model,endpointHash:hash(lease.config.endpoint),items});

test('API endpoints preserve explicit paths and reject insecure or ambiguous destinations',()=>{
  assert.equal(normalizeApiAgentEndpoint('https://fixture.example/v1/','chat_completions'),'https://fixture.example/v1/chat/completions');
  assert.equal(normalizeApiAgentEndpoint('https://fixture.example/custom/responses/','responses'),'https://fixture.example/custom/responses');
  assert.equal(normalizeApiAgentEndpoint('http://127.0.0.1:3210/v1','responses'),'http://127.0.0.1:3210/v1/responses');
  assert.equal(normalizeApiAgentEndpoint('http://[::1]:3210/v1','responses'),'http://[::1]:3210/v1/responses');
  for(const url of ['http://fixture.example/v1','https://user:password@fixture.example/v1','https://fixture.example/v1?','https://fixture.example/v1#','https://fixture.example/v1?key=secret','file:///v1','https://fixture.example\\v1','https://fixture.example/v1\n'])assert.throws(()=>normalizeApiAgentEndpoint(url,'responses'));
  assert.throws(()=>normalizeApiAgentEndpoint('https://fixture.example/v1/responses','chat_completions'),/协议不一致/);
});

test('API configuration creates real distinct agents and keeps keys out of public records and audit',async t=>{
  const f=harness(t),input=base(),created=await f.agents.save(input),second=await f.agents.save({...base(),name:'第二位 API 成员'});
  assert.notEqual(created.id,second.id);assert.equal(created.id,created.agent_id);assert.equal(created.status,'ready');assert.equal(created.has_key,true);assert.equal(f.wb.get('agents',created.id).preset_id,'api-agent');assert.equal(f.wb.get('agents',created.id).model,input.model);assert.equal(f.agents.capability(created.id).available,true);
  const publicData=JSON.stringify([f.wb.snapshot(),f.agents.snapshot(),f.agents.check(created.id),f.wb.db.prepare('SELECT * FROM audit').all()]);assert(!publicData.includes(input.api_key));assert(!publicData.includes('secret_cipher'));assert(!publicData.includes('api_key'));assert(!JSON.stringify(f.wb.db.prepare('SELECT * FROM api_agent_configs').all()).includes(input.api_key));assert(f.agents.check(created.id).message.includes('未联网'));
});

test('blank keys preserve the credential, explicit clearing removes it, and stale writes fail',async t=>{
  const f=harness(t),input=base(),created=await f.agents.save(input),cipher=(f.wb.db.prepare('SELECT secret_cipher FROM api_agent_configs WHERE agent_id=?').get(created.id) as any).secret_cipher;
  const renamed=await f.agents.save({id:created.id,version:created.version,name:'API 更名',api_key:'   '});assert.equal(renamed.has_key,true);assert.equal(renamed.model,input.model);assert.equal((f.wb.db.prepare('SELECT secret_cipher FROM api_agent_configs WHERE agent_id=?').get(created.id) as any).secret_cipher,cipher);
  await assert.rejects(f.agents.save({id:created.id,version:created.version,name:'过期更名'}),/变化/);await assert.rejects(f.agents.save({id:created.id,version:renamed.version,wipe_key:true,api_key:'new-secret'}),/同时/);
  const cleared=await f.agents.save({id:created.id,version:renamed.version,wipe_key:true});assert.equal(cleared.has_key,false);assert.equal(cleared.status,'missing_key');assert.equal(cleared.model,input.model);assert.equal((f.wb.db.prepare('SELECT secret_cipher FROM api_agent_configs WHERE agent_id=?').get(created.id) as any).secret_cipher,null);
});

test('unavailable and failing vaults never fall back to plaintext or leak raw failures',async t=>{
  const unavailable:ExternalVault={available:false,encrypt:async()=>{throw Error('unused');},decrypt:async()=>{throw Error('unused');}},f=harness(t,unavailable),input=base();await assert.rejects(f.agents.save(input),/明文降级/);assert.equal(f.wb.db.prepare('SELECT COUNT(*) AS count FROM api_agent_configs').get()?.count,0);
  const draft=await f.agents.save({...input,api_key:''});assert.equal(draft.status,'missing_key');
  const throwing=new ApiAgents(f.wb,{vault:{available:true,encrypt:async()=>{throw Error(input.api_key);},decrypt:async()=>{throw Error(input.api_key);}}});await assert.rejects(throwing.save({...input,name:'失败保险库'}),error=>error instanceof Error&&!error.message.includes(input.api_key)&&error.message.includes('无法加密'));
});

test('archived agents cannot change API configuration or acquire turns',async t=>{
  const f=harness(t),created=await f.agents.save(base()),bound=binding(f,created.id),agent=f.wb.get('agents',created.id);f.wb.put('agents',{...agent,archived:true});assert.equal(f.agents.capability(created.id).available,false);assert.equal(f.agents.snapshot().agents.length,0);await assert.rejects(f.agents.save({id:created.id,version:1,name:'不能修改'}),/恢复/);await assert.rejects(f.agents.acquireTurn(bound),/恢复/);
});

test('private API state survives a store restart and is bound to room member model and configuration',async t=>{
  const f=harness(t),input=base(),created=await f.agents.save(input),bound=binding(f,created.id),lease=await f.agents.acquireTurn(bound);assert.equal(lease.config.apiKey,input.api_key);const privateText='PRIVATE_REASONING_FIXTURE_DO_NOT_PUBLISH';await lease.save(state(lease,[{role:'assistant',content:privateText},{nested:{content:input.api_key,[input.api_key]:'provider echoes a credential as a property name'}}]));const sid=lease.session.id;assert.equal(lease.session.revision,1);lease.release();finish(f,bound);
  const stored=f.wb.db.prepare('SELECT * FROM api_agent_sessions WHERE id=?').get(sid) as any;assert(!JSON.stringify(stored).includes(privateText));assert(!JSON.stringify(stored).includes(input.api_key));assert(!JSON.stringify(f.agents.snapshot()).includes(sid));
  const reopened=new ApiAgents(f.wb,{vault:f.vault}),next=binding(f,created.id,bound),continued=await reopened.acquireTurn({...next,sessionId:sid});assert.equal(continued.session.state?.items[0].content,privateText);assert.equal((continued.session.state?.items[1].nested as any).content,'[API Key 已隐藏]');assert(!JSON.stringify(continued.session.state).includes(input.api_key));assert.equal((continued.session.state?.items[1].nested as any)['[API Key 已隐藏]'],'provider echoes a credential as a property name');continued.release();finish(f,next);
  const other=binding(f,created.id);await assert.rejects(reopened.acquireTurn({...other,sessionId:sid}),/成员或配置版本/);finish(f,other);
});

test('an active lease and active jobs block changes, while an idle update resets only this agent member bindings',async t=>{
  const f=harness(t),created=await f.agents.save(base()),bound=binding(f,created.id),lease=await f.agents.acquireTurn(bound);await assert.rejects(f.agents.save({id:created.id,version:1,model:'new-model'}),/正在执行/);finish(f,bound);await assert.rejects(f.agents.save({id:created.id,version:1,model:'new-model'}),/正在执行/);
  const member=JSON.parse((f.wb.db.prepare('SELECT data FROM workgroup_members WHERE id=?').get(bound.memberId) as any).data);f.wb.db.prepare('UPDATE workgroup_members SET data=? WHERE id=?').run(JSON.stringify({...member,native_session_id:lease.session.id}),bound.memberId);const oldSessionId=lease.session.id;await lease.save(state(lease));lease.release();
  const emptyBinding=binding(f,created.id);finish(f,emptyBinding);const otherAgent=await f.agents.save({...base(),name:'不受影响的 API 成员'}),otherBinding=binding(f,otherAgent.id);finish(f,otherBinding);const otherBefore=(f.wb.db.prepare('SELECT data FROM workgroup_members WHERE id=?').get(otherBinding.memberId) as any).data;
  const updated=await f.agents.save({id:created.id,version:1,name:'同步群成员名称',model:'new-model'});assert.equal(updated.version,2);for(const mid of [bound.memberId,emptyBinding.memberId]){const member=JSON.parse((f.wb.db.prepare('SELECT data FROM workgroup_members WHERE id=?').get(mid) as any).data);assert.equal(member.native_session_id,null);assert.equal(member.name,'同步群成员名称');assert.equal(member.model,'new-model');assert.equal(member.revision,2);}assert.equal((f.wb.db.prepare('SELECT data FROM workgroup_members WHERE id=?').get(otherBinding.memberId) as any).data,otherBefore);assert(f.wb.db.prepare('SELECT id FROM api_agent_sessions WHERE id=?').get(oldSessionId));
  const next=binding(f,created.id,bound);await assert.rejects(f.agents.acquireTurn({...next,sessionId:oldSessionId}),/配置版本/);const fresh=await f.agents.acquireTurn(next);assert.notEqual(fresh.session.id,oldSessionId);assert.equal(fresh.config.model,'new-model');fresh.release();
});

test('configuration is rechecked after encryption so a newly started job cannot be overwritten',async t=>{
  const f=harness(t),created=await f.agents.save(base());let release!:()=>void,entered!:()=>void;const enteredGate=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),delayed=new ApiAgents(f.wb,{vault:{...f.vault,encrypt:async value=>{entered();await gate;return f.vault.encrypt(value);}}});
  const saving=delayed.save({id:created.id,version:1,api_key:'synthetic-replacement'});await enteredGate;binding(f,created.id);release();await assert.rejects(saving,/进行中/);assert.equal(f.agents.publicConfiguration(created.id)?.version,1);
});

test('queued and uncertain old jobs also block configuration changes before credential encryption',async t=>{
  const f=harness(t),created=await f.agents.save(base()),bound=binding(f,created.id);let encryptions=0;const agents=new ApiAgents(f.wb,{vault:{...f.vault,encrypt:async value=>{encryptions++;return f.vault.encrypt(value);}}});
  for(const [status,uncertain] of [['queued',false],['interrupted',true]] as const){const row=JSON.parse((f.wb.db.prepare('SELECT data FROM workgroup_jobs WHERE id=?').get(bound.jobId) as any).data);f.wb.db.prepare('UPDATE workgroup_jobs SET status=?,data=? WHERE id=?').run(status,JSON.stringify({...row,status,process_may_be_running:uncertain}),bound.jobId);await assert.rejects(agents.save({id:created.id,version:1,api_key:'synthetic-replacement'}),/群调用/);}
  assert.equal(encryptions,0);assert.equal(agents.publicConfiguration(created.id)?.version,1);
});

test('API sessions reject forged calls, concurrent turns and released checkpoints',async t=>{
  const f=harness(t),created=await f.agents.save(base()),bound=binding(f,created.id);await assert.rejects(f.agents.acquireTurn({...bound,roomId:'WG-forged'}),/不一致/);const lease=await f.agents.acquireTurn(bound);await assert.rejects(f.agents.acquireTurn(bound),/正在执行/);await assert.rejects(lease.save({...state(lease),sessionId:'APIS-forged'}),/配置不一致/);lease.release();await assert.rejects(lease.save(state(lease)),/租约已结束/);finish(f,bound);await assert.rejects(f.agents.acquireTurn(bound),/结束或取消/);
});

test('checkpoints retain pending call phases privately and enforce the 512 KiB limit',async t=>{
  const f=harness(t),created=await f.agents.save(base()),bound=binding(f,created.id),lease=await f.agents.acquireTurn(bound),pending:ApiAgentPrivateState={...state(lease),pending:[{id:'call-synthetic',name:'dispatch_workgroup_task',arguments:{instruction:'合成派活'},phase:'started'}]};await lease.save(pending);assert.equal(lease.session.state?.pending?.[0].phase,'started');await assert.rejects(lease.save(state(lease,[{content:'x'.repeat(API_AGENT_STATE_MAX_BYTES)}])),/保存上限/);assert.equal(lease.session.revision,1);lease.release();
});

test('concurrent checkpoint writes preserve exactly one revision instead of losing history',async t=>{
  const f=harness(t);const queued:(()=>void)[]=[];let block=false;const agents=new ApiAgents(f.wb,{vault:{...f.vault,encrypt:async value=>{if(block&&'state'in value)await new Promise<void>(resolve=>queued.push(resolve));return f.vault.encrypt(value);}}}),created=await agents.save(base()),bound=binding(f,created.id),lease=await agents.acquireTurn(bound);block=true;const first=lease.save(state(lease,[{content:'first'}])),second=lease.save(state(lease,[{content:'second'}]));assert.equal(queued.length,2);queued.forEach(resolve=>resolve());const results=await Promise.allSettled([first,second]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(lease.session.revision,1);lease.release();
});

test('quote-heavy private histories near 512 KiB stay below the existing DPAPI output ceiling and resume intact',async t=>{
  const f=harness(t);let wrappedBytes=0;const agents=new ApiAgents(f.wb,{vault:{...f.vault,encrypt:async value=>{if('state'in value){assert.equal(value.encoding,'base64-json-v1');wrappedBytes=Buffer.byteLength(JSON.stringify(value));}return f.vault.encrypt(value);}}}),created=await agents.save(base()),bound=binding(f,created.id),lease=await agents.acquireTurn(bound),text='\\"'.repeat(125000),history=state(lease,[{opaque:text}]);
  const serializedBytes=Buffer.byteLength(JSON.stringify(history));assert(serializedBytes>500000&&serializedBytes<API_AGENT_STATE_MAX_BYTES);await lease.save(history);assert(wrappedBytes<700000);assert(Math.ceil((wrappedBytes+4096)/3)*4<1024*1024);const sid=lease.session.id;lease.release();finish(f,bound);const next=binding(f,created.id,bound),resumed=await agents.acquireTurn({...next,sessionId:sid});assert.equal(resumed.session.state?.items[0].opaque,text);resumed.release();
});

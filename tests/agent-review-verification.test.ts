import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,taskInput,event} from './agent-routing-fixture.ts';
import {AgentOrchestrator,type Launcher} from '../src/core/agent-orchestration.ts';
import type {AgentInvocationOptions,ClientKind,ClientRecord} from '../src/core/agent-clients.ts';
import {reviewAssignmentContext} from '../src/core/review-workflow.ts';
import {projectHold} from '../src/core/project-hold.ts';
import {prepareReviewVerification,validatePreparedReviewVerification} from '../src/core/review-verification.ts';
import {acquireCursorReviewPermission,listCursorReviewPermissions} from '../src/core/cursor-review-permissions.ts';

type F=ReturnType<typeof fixture>;
type Launch=Parameters<Launcher>[0];
type ProcessResult=Awaited<ReturnType<Launcher>>;
const sha=(data:string|Buffer)=>crypto.createHash('sha256').update(data).digest('hex');
const stateDir=(f:F)=>path.join(f.config.dataDir,'cursor-review-permissions');
const configFile=(f:F)=>path.join(f.root,'.cursor','cli.json');
const leases=(f:F)=>listCursorReviewPermissions({stateDir:stateDir(f)});
const originalConfig='\uFEFF{\r\n  "permissions": {"allow": ["Read"], "deny": ["Shell(powershell)"]},\r\n  "syntheticSetting": true\r\n}\r\n';
function seedConfig(f:F){fs.mkdirSync(path.dirname(configFile(f)),{recursive:true});fs.writeFileSync(configFile(f),originalConfig);}
function fakeClients(){
  const launches:Launch[]=[],builds:AgentInvocationOptions[]=[],finishes:Array<(result?:ProcessResult)=>void>=[];
  const hooks={failBuild:false,failSpawn:false,abortStopped:true,env:{} as Record<string,string>,build:undefined as undefined|((options:AgentInvocationOptions)=>void|Promise<void>),launch:undefined as undefined|((options:Launch)=>void)};
  let spawned=0;
  const clients={
    async resolve(_dataDir:string,kind:ClientKind):Promise<ClientRecord>{return {kind,label:'Synthetic isolated Cursor',status:'verified',reason:'No model is launched',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown'};},
    async build(_client:ClientRecord,options:AgentInvocationOptions){builds.push(options);await hooks.build?.(options);if(hooks.failBuild)throw Error('synthetic build failure');return {command:'SYNTHETIC-NOT-EXECUTED',args:[],env:{NODE_OPTIONS:'--require=synthetic-not-loaded',NODE_PATH:'synthetic-not-used',...hooks.env}};},
    async discover(){return [];},
  };
  const launcher:Launcher=options=>new Promise(resolve=>{
    launches.push(options);
    try{hooks.launch?.(options);if(options.beforeSpawn?.()===false){resolve({exitCode:null,signal:null,processStopped:true,deferred:true});return;}}
    catch(error){resolve({exitCode:null,signal:null,processStopped:true,error:(error as Error).message});return;}
    if(hooks.failSpawn){resolve({exitCode:null,signal:null,processStopped:true,error:'synthetic spawn ENOENT'});return;}
    spawned++;
    const finish=(result?:ProcessResult)=>resolve(result||{exitCode:0,signal:null,processStopped:true});finishes.push(finish);
    options.signal.addEventListener('abort',()=>finish({exitCode:null,signal:'SIGTERM',processStopped:hooks.abortStopped}),{once:true});
  });
  return {clients,launcher,launches,builds,finishes,hooks,get spawned(){return spawned;}};
}
async function until(check:()=>boolean,message:string){const deadline=Date.now()+5000;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert(check(),message);}
function planAndDeliver(f:F,withFiles=true){
  f.wb.put('agents',{...f.wb.get('agents','cursor'),preset_id:'cursor',archived:false});
  const q=f.wb.request({project_id:'P-workbench',text:'Synthetic managed reviewer verification integration; no real client or model.'});
  const p=f.wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(f.root),reviewer_id:'cursor',review_route:{client:'cursor',model:'synthetic-cursor'},context_contract:{required:[],supplemental:[],output_dir:path.join(f.root,'outputs'),max_bytes:65536}}]});
  const tid=p.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;
  const source=path.join(f.root,'source with 中文.ts'),artifact=path.join(f.root,'delivery-note.txt');fs.writeFileSync(source,'export const synthetic = true;\n');fs.writeFileSync(artifact,'Synthetic delivered file.\n');
  for(const [type,extra] of [['started',{}],['submitted',{result:'Synthetic isolated integration delivery. No production work, model execution, or actual review happened.',...(withFiles?{review_files:[source],artifacts:[{path:source,label:'duplicate source'},{path:artifact,label:'delivery note'}]}:{})}]] as const){
    const r=f.wb.get('runs',rid),result=f.wb.event(event(r.cwd,tid,rid,r.seq+1,type,{identity:r.agent_id,...extra}),rid,'run');assert.equal(result.disposition,'applied',result.error);
  }
  return {tid,rid,source,artifact};
}
function dispatch(o:AgentOrchestrator,f:F,t:{tid:string;rid:string}){return o.dispatchReview({run_id:t.rid,request_id:crypto.randomUUID(),expected_revision:f.wb.get('tasks',t.tid).revision});}
async function launched(fake:ReturnType<typeof fakeClients>,f:F,jid:string){await until(()=>fake.launches.length>0||f.wb.get('agent_jobs',jid).status==='failed','launch must settle');assert.equal(fake.launches.length,1,f.wb.get('agent_jobs',jid).reason);}
async function released(f:F,jid:string){await until(()=>f.wb.get('agent_jobs',jid).review_verification?.permission_state==='released','temporary permission must be released');assert.equal(leases(f).length,0);assert.equal(fs.readFileSync(configFile(f),'utf8'),originalConfig);return f.wb.get('agent_jobs',jid);}
function nativeReport(f:F,reviewId:string){const context=reviewAssignmentContext(f.wb,reviewId);return {review_id:reviewId,task_id:context.task_id,run_id:context.run_id,review_digest:context.review_digest,verdict:'passed',findings:[],limitations:['Synthetic launcher report, not an actual independent product review.'],evidence:['Isolated fixture only.'],report_markdown:'# Synthetic integration report\n\nThis tests transport provenance and state, not product acceptance.'};}

test('Cursor launch has frozen helper and exact lease; running the real helper never becomes a review verdict',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);
  try{
    const t=planAndDeliver(f);let checkedAtBuild=false;
    const preload=path.join(f.root,'synthetic preload.cjs'),marker=path.join(f.root,'preload-must-not-run.txt');fs.writeFileSync(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'synthetic preload ran');`);fake.hooks.env.NODE_OPTIONS=`--require=${JSON.stringify(preload)}`;
    fake.hooks.build=()=>{const job=f.wb.all('agent_jobs')[0],prepared=job.review_verification;validatePreparedReviewVerification(prepared);assert.equal(prepared.permission_state,'active');assert.equal(leases(f)[0].token,prepared.permissionToken);checkedAtBuild=true;};
    const j=dispatch(o,f,t);await launched(fake,f,j.job_id);assert(checkedAtBuild);
    const prepared=f.wb.get('agent_jobs',j.job_id).review_verification;
    assert.equal(prepared.command,`node .workbench-review-checks/${j.job_id}/verify.mjs`);assert.equal(prepared.permissionToken,`Shell(node:.workbench-review-checks/${j.job_id}/verify.mjs)`);
    assert.equal(prepared.fileCount,2);assert.equal(prepared.omitted_count,1,'internal RESULT is omitted and original artifact paths are deduplicated');
    const payload=JSON.parse(fs.readFileSync(prepared.payloadPath,'utf8'));assert.deepEqual(payload.files.map((v:any)=>v.path).sort(),[t.source,t.artifact].sort());
    const config=JSON.parse(fs.readFileSync(configFile(f),'utf8').replace(/^\uFEFF/,''));assert.deepEqual(config.permissions.allow,['Read',prepared.permissionToken]);assert.deepEqual(config.permissions.deny,['Shell(powershell)']);
    assert.equal(fake.launches[0].env?.NODE_OPTIONS,'');assert.equal(fake.launches[0].env?.NODE_PATH,'');assert.equal(fake.launches[0].env?.PATH?.split(path.delimiter)[0],path.dirname(process.execPath));
    const prompt=fs.readFileSync(fake.builds[0].promptFile,'utf8');assert(prompt.includes(prepared.command));assert.match(prompt,/输出不是独立审查结论/);
    const result=spawnSync(process.execPath,[prepared.helperPath],{cwd:f.root,env:{...process.env,...fake.launches[0].env},encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'verified');assert.equal(fs.existsSync(marker),false,'managed helper must not load inherited Node preloads');assert.equal(f.wb.all('reviews').length,0);assert.equal(f.wb.get('tasks',t.tid).status,'submitted');
    fake.launches[0].onLine(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'synthetic-verifier-only',result:result.stdout}));fake.finishes[0]();
    const ended=await released(f,j.job_id);assert.equal(ended.status,'failed');assert.equal(f.wb.all('reviews').length,0);assert.notEqual(f.wb.get('review_assignments',j.review_id!).status,'completed');assert(fs.existsSync(prepared.helperPath));
  }finally{await o.close();f.wb.close();}
});

test('a genuine-shaped synthetic client final report completes the review and restores original permission bytes',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);
  try{const t=planAndDeliver(f),j=dispatch(o,f,t);await launched(fake,f,j.job_id);const report=nativeReport(f,j.review_id!);fake.launches[0].onLine(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'synthetic-formal-review',result:JSON.stringify(report)}));fake.finishes[0]();
    const ended=await released(f,j.job_id);assert.equal(ended.status,'completed',ended.reason);assert.equal(f.wb.all('reviews').length,1);assert.equal(f.wb.all('reviews')[0].source,'native_client_output');assert.equal(f.wb.all('reviews')[0].client_job_id,j.job_id);assert.equal(f.wb.get('tasks',t.tid).status,'awaiting_closeout');
  }finally{await o.close();f.wb.close();}
});

test('build failure, spawn failure, and pre-spawn helper tampering all return the lease without launching a model',async t=>{
  for(const scenario of ['build','spawn','tamper','deny'] as const)await t.test(scenario,async()=>{
    const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);
    try{const task=planAndDeliver(f);fake.hooks.failBuild=scenario==='build';fake.hooks.failSpawn=scenario==='spawn';if(scenario==='tamper')fake.hooks.build=()=>{fs.appendFileSync(f.wb.all('agent_jobs')[0].review_verification.helperPath,'\n// synthetic tamper\n');};if(scenario==='deny')fs.writeFileSync(configFile(f),originalConfig.replace('Shell(powershell)','Shell(node)'));
      const j=dispatch(o,f,task);if(scenario==='deny'){await until(()=>f.wb.get('agent_jobs',j.job_id).review_verification?.permission_state==='not_acquired','explicit deny must never be marked acquired');assert.equal(fake.spawned,0);return;}
      const ended=await released(f,j.job_id);assert.equal(ended.status,'failed');assert.match(ended.reason,scenario==='build'?/synthetic build failure/:scenario==='spawn'?/synthetic spawn ENOENT/:/helper_hash_mismatch/);assert.equal(fake.spawned,0);assert.equal(f.wb.all('reviews').length,0);
    }finally{await o.close();f.wb.close();}
  });
});

test('cancel releases only after confirmed process stop; uncertain stop keeps the narrow lease',async t=>{
  for(const stopped of [true,false])await t.test(stopped?'confirmed stop':'uncertain stop',async()=>{
    const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);fake.hooks.abortStopped=stopped;
    try{const task=planAndDeliver(f),j=dispatch(o,f,task);await launched(fake,f,j.job_id);o.cancelJob(task.tid,{job_id:j.job_id,expected_revision:f.wb.get('tasks',task.tid).revision,reason:'Cancel this isolated synthetic invocation.'});
      await until(()=>f.wb.get('agent_jobs',j.job_id).process_end_evidence===(stopped?'owned_child_exit':'unknown')&&f.wb.get('agent_jobs',j.job_id).status==='interrupted','cancel must finish its owned launcher');
      if(stopped)await released(f,j.job_id);else{await new Promise(resolve=>setImmediate(resolve));assert.equal(leases(f).length,1);assert.equal(f.wb.get('agent_jobs',j.job_id).review_verification.permission_state,'active');assert.equal(f.wb.get('agent_jobs',j.job_id).process_may_be_running,true);}
      assert.equal(f.wb.all('reviews').length,0);
    }finally{await o.close();f.wb.close();}
  });
});

test('restart recovers only an OS-confirmed dead PID and leaves live or unknown process leases intact',async t=>{
  const child=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(child.status,0);assert(child.pid);
  for(const [label,pid] of [['dead',child.pid],['live',process.pid],['unknown',null]] as const)await t.test(label,async()=>{
    const f=fixture(),fake=fakeClients();seedConfig(f);const task=planAndDeliver(f),jid='AJ-'+crypto.randomUUID(),run=f.wb.get('runs',task.rid);
    const prepared=prepareReviewVerification({workspace:f.root,jobId:jid,files:run.review_files,allowedRoots:[f.root]});
    acquireCursorReviewPermission({workspace:f.root,jobId:jid,stateDir:stateDir(f),retentionDir:path.join(f.root,'.workbench-review-checks','retained-permissions'),token:prepared.permissionToken});
    f.wb.put('agent_jobs',{id:jid,task_id:task.tid,run_id:task.rid,role:'review',phase:'review',route:{client:'cursor',model:'synthetic-cursor'},status:'running',revision:1,created_at:new Date().toISOString(),process_pid:pid,process_may_be_running:true,review_verification:{...prepared,permission_state:'active'}},{run_id:task.rid});
    const o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);
    try{o.start();await new Promise(resolve=>setImmediate(resolve));const job=f.wb.get('agent_jobs',jid);assert.equal(job.status,'interrupted');
      if(label==='dead'){await released(f,jid);assert.equal(job.process_end_evidence,'tracked_process_absent');assert.equal(job.process_may_be_running,false);}else{assert.equal(leases(f).length,1);assert.equal(job.review_verification.permission_state,'active');assert.equal(job.process_may_be_running,true);}
      assert.equal(fake.launches.length,0);assert.equal(f.wb.all('reviews').length,0);
    }finally{await o.close();f.wb.close();}
  });
});

test('a result-only delivery still starts Cursor review without granting an empty verifier permission',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);
  try{const task=planAndDeliver(f,false),j=dispatch(o,f,task);await launched(fake,f,j.job_id);const meta=f.wb.get('agent_jobs',j.job_id).review_verification;assert.equal(meta.permission_state,'not_needed');assert.equal(meta.fileCount,0);assert.equal(leases(f).length,0);assert.equal(fs.readFileSync(configFile(f),'utf8'),originalConfig);assert.match(fs.readFileSync(fake.builds[0].promptFile,'utf8'),/未添加命令权限/);fake.finishes[0]();await until(()=>f.wb.get('agent_jobs',j.job_id).status==='failed','no report must remain incomplete');
  }finally{await o.close();f.wb.close();}
});

test('project hold during build releases permission, then the same job safely reuses its frozen helper on resume',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);let releaseBuild:()=>void=()=>{};
  try{const task=planAndDeliver(f),gate=new Promise<void>(resolve=>releaseBuild=resolve);fake.hooks.build=async()=>{if(fake.builds.length===1)await gate;};o.start();const j=dispatch(o,f,task);await until(()=>fake.builds.length===1,'first build should reach the gate');
    const first=f.wb.get('agent_jobs',j.job_id).review_verification;assert.equal(leases(f).length,1);projectHold(f.wb,'P-workbench',{version:f.wb.get('projects','P-workbench').version,shelved:true});releaseBuild();await released(f,j.job_id);assert.equal(f.wb.get('agent_jobs',j.job_id).status,'queued');assert.equal(fake.launches.length,0);
    projectHold(f.wb,'P-workbench',{version:f.wb.get('projects','P-workbench').version,shelved:false});await launched(fake,f,j.job_id);const resumed=f.wb.get('agent_jobs',j.job_id).review_verification;assert.equal(resumed.expectedHelperSha256,first.expectedHelperSha256);assert.equal(resumed.expectedPayloadSha256,first.expectedPayloadSha256);assert.equal(resumed.permission_state,'active');assert.equal(leases(f).length,1);fake.finishes[0]();await released(f,j.job_id);
  }finally{releaseBuild();await o.close();f.wb.close();}
});

test('a temporary permission lock failure is retried after the conflict clears',async()=>{
  const f=fixture(),fake=fakeClients(),o=new AgentOrchestrator(f.wb,fake.launcher,fake.clients);seedConfig(f);
  try{const task=planAndDeliver(f),j=dispatch(o,f,task);await launched(fake,f,j.job_id);const lease=leases(f)[0],lock=path.join(stateDir(f),lease.workspaceHash,'lease.lock');
    fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:crypto.randomUUID()}),{flag:'wx'});fake.finishes[0]();await until(()=>f.wb.get('agent_jobs',j.job_id).review_verification.permission_state==='cleanup_pending','live lock should defer release');assert.equal(leases(f).length,1);assert.equal(f.wb.all('reviews').length,0);
    // Move our synthetic lock within its already bounded fixture; preserve it rather than deleting evidence.
    fs.renameSync(lock,path.join(path.dirname(lock),'synthetic-lock-retained-'+crypto.randomUUID()+'.json'));
    const retries=(o as any).permissionCleanupRetry as Map<string,{attempt:number;next:number}>;assert(retries.get(j.job_id));retries.get(j.job_id)!.next=0;
    o.start();await released(f,j.job_id);assert.equal(retries.has(j.job_id),false);assert.equal(f.wb.get('agent_jobs',j.job_id).status,'failed');assert.equal(f.wb.all('reviews').length,0);
  }finally{await o.close();f.wb.close();}
});

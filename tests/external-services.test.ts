import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,setup} from './helpers.ts';
import {ROOT} from '../src/core/config.ts';
import {ExternalServices} from '../src/core/external-services.ts';
import {windowsExternalVault,type ExternalVault} from '../src/core/external-vault.ts';
import type {ExternalCaller} from '../src/core/external-service-schema.ts';
const fakeVault:ExternalVault={available:true,encrypt:async value=>'fixture:'+Buffer.from(JSON.stringify(value)).toString('base64'),decrypt:async value=>JSON.parse(Buffer.from(value.slice(8),'base64').toString())};
const caller:ExternalCaller={id:'fixture:codex',agent_id:'codex',project_id:'P-workbench',kind:'runner'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=';
function input(){return {preset_id:'openai-images',name:'隔离图片服务',base_url:'https://fixture.example/v1',model:'fixture-image',enabled:true,allow_paid:true,allowed_project_ids:['P-workbench'],allowed_agent_ids:['codex'],secrets:{apiKey:'fixture-private-secret-123456789'}};}
test('DPAPI round trip is current-user protected and rejects damaged ciphertext',{skip:process.platform!=='win32'},async()=>{
 const secret='synthetic-secret-'+crypto.randomUUID(),cipher=await windowsExternalVault.encrypt({apiKey:secret});assert(!cipher.includes(secret));assert.equal((await windowsExternalVault.decrypt(cipher)).apiKey,secret);await assert.rejects(windowsExternalVault.decrypt('dpapi:v1:AAAA'));
});
test('connection update and revoke preserve configuration; responses and calling card contain no secret',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const services=new ExternalServices(f.wb,fakeVault);
 const c=await services.save(input());assert(!JSON.stringify(services.snapshot()).includes('fixture-private'));assert(!services.calling(c.id).markdown.includes('fixture-private'));
 const changed=await services.save({id:c.id,version:c.version,name:'更新后的名字',model:'new-image'});assert.equal(changed.base_url,input().base_url);assert(changed.credential_configured);
 const revoked=await services.save({id:c.id,version:changed.version,enabled:false,wipe_secrets:true});assert.equal(revoked.model,'new-image');assert.equal(revoked.credential_configured,false);
 await assert.rejects(services.save({id:c.id,version:c.version,name:'陈旧写入'}),/变化/);
});
test('explicit caller scopes and consumption switches fail before network',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let calls=0;const services=new ExternalServices(f.wb,fakeVault,(async()=>{calls++;throw Error();})as typeof fetch);
 const c=await services.save({...input(),allow_paid:false}),request={service_id:c.id,operation:'image.generate',input:{prompt:'test'},request_id:crypto.randomUUID()};
 await assert.rejects(services.invoke(request,caller),/允许生成/);await assert.rejects(services.invoke(request,{...caller,id:'fixture:other',agent_id:'grok-build'}),/未授权/);
 await assert.rejects(services.invoke({...request,agent_id:'codex'},caller));assert.equal(calls,0);
});
test('two authenticated callers share one connection without sharing invocation records; retries never duplicate generation',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let calls=0;const services=new ExternalServices(f.wb,fakeVault,(async(_url,init)=>{calls++;assert(String((init!.headers as any).Authorization).includes('fixture-private'));return Response.json({data:[{b64_json:png}]});})as typeof fetch);
 const c=await services.save({...input(),allowed_agent_ids:['codex','grok-build']}),request={service_id:c.id,operation:'image.generate',input:{prompt:'合成图片'},request_id:crypto.randomUUID()};
 const first=await services.invoke(request,caller);const repeated=await services.invoke(request,caller);assert.equal(first.invocation_id,repeated.invocation_id);const done=await services.wait(first.invocation_id);assert.equal(calls,1);assert.equal(done.status,'succeeded');assert.equal(done.artifacts.length,1);assert(fs.existsSync(done.artifacts[0].path));
 assert.equal(services.artifact(done.id,done.artifacts[0].id,caller).inline_image.data,png);
 const other={...caller,id:'fixture:grok',agent_id:'grok-build'};assert.throws(()=>services.get(done.id,other),/当前身份/);
 const second=await services.invoke({...request,request_id:crypto.randomUUID()},other);await services.wait(second.id);assert.equal(calls,2);
 await assert.rejects(services.invoke({...request,input:{prompt:'不同请求'}},caller),/不同请求/);
 fs.writeFileSync(done.artifacts[0].path,'modified fixture');assert.throws(()=>services.artifact(done.id,done.artifacts[0].id,caller),/已被修改/);
});

test('complete HTTP client rejections fail clearly; repaired requests need a new id, while uncertain responses never retry',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let status=401,calls=0;const services=new ExternalServices(f.wb,fakeVault,(async()=>{calls++;return status===200?Response.json({data:[{b64_json:png}]}):new Response('provider error text with confidential content',{status});})as typeof fetch),c=await services.save(input());
 for(const code of [400,401,403,422,429,503]){status=code;const req={service_id:c.id,operation:'image.generate',input:{prompt:'synthetic'},request_id:crypto.randomUUID()},job=await services.invoke(req,caller),done=await services.wait(job.id);assert.equal(done.status,[429,503].includes(code)?'unknown':'failed');assert.equal(done.error_code,'http_'+code);assert(!JSON.stringify(done).includes('confidential'));const sent=calls;await services.invoke(req,caller);assert.equal(calls,sent);}
 status=200;const fresh=await services.invoke({service_id:c.id,operation:'image.generate',input:{prompt:'synthetic'},request_id:crypto.randomUUID()},caller);assert.equal((await services.wait(fresh.id)).status,'succeeded');assert.equal(calls,7);
});

test('CLI process exit, timeout and resource limits are not reported as successful tasks',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const script=path.join(f.root,'synthetic-agent-cli.cjs');fs.writeFileSync(script,'const state=process.argv[2];console.log(state==="plain"?"command output":JSON.stringify({status:state}));');
 const services=new ExternalServices(f.wb,fakeVault),c=await services.save({...input(),preset_id:'minimax-mcode',executable:process.execPath,args:[script],cwd:f.root,secrets:{}});
 for(const state of ['plain','timeout','limit_exceeded','cancelled','completed']){const job=await services.invoke({service_id:c.id,operation:'cli.invoke',input:{args:[state]},request_id:crypto.randomUUID()},caller),done=await services.wait(job.id);assert.equal(done.status,['plain','completed'].includes(state)?'command_completed':'failed');assert.notEqual(done.evidence,'invocation_verified');}
});
test('async media polls same provider task and archives into original invocation, without another create',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const urls:string[]=[];const services=new ExternalServices(f.wb,fakeVault,(async(url)=>{
  urls.push(String(url));if(String(url).endsWith('/video_generation'))return Response.json({task_id:'task-safe-1',base_resp:{status_code:0}});
  if(String(url).includes('query/video_generation'))return Response.json({task_id:'task-safe-1',status:'Success',file_id:'file-safe-1',base_resp:{status_code:0}});
  if(String(url).includes('files/retrieve'))return Response.json({file:{file_id:'file-safe-1',download_url:'https://cdn.example/output.mp4?X-Amz-Signature=synthetic-signature'},base_resp:{status_code:0}});
  return new Response(Buffer.from('synthetic-video'),{headers:{'content-type':'video/mp4'}});
 })as typeof fetch);
 const c=await services.save({...input(),preset_id:'minimax-media',model:'fixture-video'});const started=await services.invoke({service_id:c.id,operation:'video.create',input:{prompt:'模拟视频'},request_id:crypto.randomUUID()},caller);
 const submitted=await services.wait(started.id);assert.equal(submitted.status,'submitted');assert.equal(submitted.provider_task_id,'task-safe-1');const done=await services.poll(started.id,caller);assert.equal(done.status,'succeeded');assert.equal(done.artifacts.length,1);assert.equal(urls.filter(u=>u.endsWith('/video_generation')).length,1);assert.equal(done.id,started.id);assert(!JSON.stringify(done).includes('cdn.example'));
});
test('MiniMax accepted task/file ids survive a failed follow-up lookup and only the original file is retried',async t=>{
 for(const failure of ['http401','network'] as const)await t.test(failure,async t=>{
  const f=fixture();t.after(()=>f.wb.close());let failing=true,creates=0,queries=0,fileReads=0;
  const identityAtFileRead:{task?:string;file?:string;status?:string}[]=[];let services:ExternalServices;
  services=new ExternalServices(f.wb,fakeVault,(async(url)=>{
   const request=new URL(String(url));
   if(request.pathname==='/v1/video_generation'){creates++;return Response.json({task_id:'accepted-task',base_resp:{status_code:0}});}
   if(request.pathname==='/v1/query/video_generation'){queries++;assert.equal(request.searchParams.get('task_id'),'accepted-task');return Response.json({task_id:'accepted-task',status:'Success',file_id:'accepted-file',base_resp:{status_code:0}});}
   if(request.pathname==='/v1/files/retrieve'){
    fileReads++;assert.equal(request.searchParams.get('file_id'),'accepted-file');
    const persisted=services.snapshot().invocations.find(r=>r.operation==='video.status');
    identityAtFileRead.push({task:persisted?.provider_task_id,file:persisted?.provider_file_id,status:persisted?.status});
    if(failing){if(failure==='network')throw Error('synthetic file lookup disconnected');return new Response('synthetic confidential provider error',{status:401});}
    return Response.json({file:{file_id:'accepted-file',download_url:'https://cdn.example/recovered.mp4'},base_resp:{status_code:0}});
   }
   assert.equal(request.href,'https://cdn.example/recovered.mp4');return new Response(Buffer.from('synthetic-recovered-video'),{headers:{'content-type':'video/mp4'}});
  })as typeof fetch);
  const c=await services.save({...input(),preset_id:'minimax-media',model:'fixture-video'});
  const createRequest={service_id:c.id,operation:'video.create',input:{prompt:'synthetic'},request_id:crypto.randomUUID()};
  const created=await services.invoke(createRequest,caller);assert.equal((await services.wait(created.id)).status,'submitted');
  const statusRequest={service_id:c.id,operation:'video.status',input:{taskId:'accepted-task'},request_id:crypto.randomUUID()};
  const statusJob=await services.invoke(statusRequest,caller),failedLookup=await services.wait(statusJob.id);
  assert.deepEqual(identityAtFileRead[0],{task:'accepted-task',file:'accepted-file',status:'running'});
  assert.equal(failedLookup.status,'unknown');assert.equal(failedLookup.evidence,'invocation_not_verified');
  assert.equal(failedLookup.provider_task_id,'accepted-task');assert.equal(failedLookup.provider_file_id,'accepted-file');assert.equal(failedLookup.artifacts.length,0);
  assert.match(failedLookup.message,/原文件/);assert(!JSON.stringify(failedLookup).includes('confidential'));
  if(failure==='http401')assert.equal(failedLookup.error_code,'http_401');
  const beforeRepeat={creates,queries,fileReads};assert.equal((await services.invoke(statusRequest,caller)).id,statusJob.id);assert.equal((await services.invoke(createRequest,caller)).id,created.id);assert.deepEqual({creates,queries,fileReads},beforeRepeat);
  // A separate authorized read retains its input file id even when no response arrives.
  const fileRequest={service_id:c.id,operation:'file.retrieve',input:{fileId:'accepted-file'},request_id:crypto.randomUUID()};
  const fileJob=await services.invoke(fileRequest,caller),fileFailed=await services.wait(fileJob.id);
  assert.equal(fileFailed.status,'unknown');assert.equal(fileFailed.provider_file_id,'accepted-file');const readsAfterFailure=fileReads;
  assert.equal((await services.invoke(fileRequest,caller)).id,fileJob.id);assert.equal(fileReads,readsAfterFailure);
  failing=false;
  const recoveredFile=await services.invoke({...fileRequest,request_id:crypto.randomUUID()},caller),recovered=await services.wait(recoveredFile.id);
  assert.equal(recovered.status,'succeeded');assert.equal(recovered.provider_file_id,'accepted-file');assert.equal(recovered.artifacts.length,1);
  assert.equal(fileReads,readsAfterFailure+1,'file.retrieve must not recursively fetch the same file a second time');
  // Polling the original unknown receipt also uses its durable file id, not creation/status.
  const readsBeforePoll=fileReads,queriesBeforePoll=queries,done=await services.poll(statusJob.id,caller);
  assert.equal(done.id,statusJob.id);assert.equal(done.status,'succeeded');assert.equal(done.evidence,'invocation_verified');assert.equal(done.provider_task_id,'accepted-task');assert.equal(done.provider_file_id,'accepted-file');assert.equal(done.artifacts.length,1);
  assert.equal(fileReads,readsBeforePoll+1);assert.equal(queries,queriesBeforePoll);assert.equal(creates,1);
 });
});
test('uncertain network failures are recorded once; same id never retries paid creation',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let calls=0;const services=new ExternalServices(f.wb,fakeVault,(async()=>{calls++;throw Error('network failed');})as typeof fetch),c=await services.save(input());
 const req={service_id:c.id,operation:'image.generate',input:{prompt:'test'},request_id:crypto.randomUUID()};const first=await services.invoke(req,caller);assert.equal((await services.wait(first.id)).status,'unknown');await services.invoke(req,caller);assert.equal(calls,1);
});
test('local image upload cannot read protected files or paths outside authorized project',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let calls=0;const services=new ExternalServices(f.wb,fakeVault,(async()=>{calls++;return Response.json({data:[{b64_json:png}]});})as typeof fetch),c=await services.save(input());
 const sensitive=path.join(f.root,'.env');fs.writeFileSync(sensitive,'synthetic only');const job=await services.invoke({service_id:c.id,operation:'image.edit',input:{prompt:'edit',images:[{image_url:sensitive}]},request_id:crypto.randomUUID()},caller);const done=await services.wait(job.id);assert.equal(done.status,'failed');assert.equal(done.evidence,'not_sent');assert.equal(calls,0);
});

test('external status/file lookups cannot query another caller task and stop after connection revoke',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let calls=0;const services=new ExternalServices(f.wb,fakeVault,(async()=>{calls++;return Response.json({task_id:'owned-task',base_resp:{status_code:0}});})as typeof fetch);
 const c=await services.save({...input(),preset_id:'minimax-media'}),job=await services.invoke({service_id:c.id,operation:'video.create',input:{prompt:'test'},request_id:crypto.randomUUID()},caller);await services.wait(job.id);
 await assert.rejects(services.invoke({service_id:c.id,operation:'video.status',input:{taskId:'other-task'},request_id:crypto.randomUUID()},caller),/当前身份/);
 await assert.rejects(services.invoke({service_id:c.id,operation:'file.retrieve',input:{fileId:'other-file'},request_id:crypto.randomUUID()},caller),/当前身份/);
 await services.save({id:c.id,version:c.version,enabled:false});await assert.rejects(services.poll(job.id,caller),/已停用/);assert.equal(calls,1);
});

test('revoking during credential decryption prevents a not-yet-sent call',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let resume!:()=>void,entered!:()=>void,calls=0;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r);
 const vault={...fakeVault,decrypt:async(value:string)=>{entered();await gate;return fakeVault.decrypt(value);}},services=new ExternalServices(f.wb,vault,(async()=>{calls++;throw Error();})as typeof fetch),c=await services.save(input());
 const job=await services.invoke({service_id:c.id,operation:'image.generate',input:{prompt:'test'},request_id:crypto.randomUUID()},caller);await started;await services.save({id:c.id,version:c.version,enabled:false});resume();const result=await services.wait(job.id);assert.equal(result.status,'failed');assert.equal(result.evidence,'not_sent');assert.equal(calls,0);
});

test('shutdown aborts a provider request and preserves an uncertain receipt without retry',async t=>{
 const f=fixture();t.after(()=>f.wb.close());let entered!:()=>void;const started=new Promise<void>(r=>entered=r),services=new ExternalServices(f.wb,fakeVault,((url,init)=>new Promise((_resolve,reject)=>{entered();init!.signal!.addEventListener('abort',()=>reject(Error('request cancelled')),{once:true});}))as typeof fetch),c=await services.save(input());
 const job=await services.invoke({service_id:c.id,operation:'image.generate',input:{prompt:'test'},request_id:crypto.randomUUID()},caller);await started;await services.close();assert.equal(services.get(job.id).status,'unknown');
});

test('Dreamina uses configured noninteractive profile and preserves nested async acceptance',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const script=path.join(f.root,'synthetic-cli.cjs');fs.writeFileSync(script,'process.stdout.write(JSON.stringify({ok:true,data:{items:[{state:"submitted",submitId:"synthetic-job"}]},argv:process.argv.slice(2)}))');
 const services=new ExternalServices(f.wb,fakeVault),c=await services.save({...input(),preset_id:'dreamina-canvas',executable:process.execPath,args:[script],profile:'isolated',cwd:f.root,secrets:{}});
 const job=await services.invoke({service_id:c.id,operation:'cli.invoke',input:{args:['node','run']},request_id:crypto.randomUUID()},caller),done=await services.wait(job.id);
 assert.equal(done.status,'submitted');assert.equal(done.evidence,'command_accepted');const output=JSON.parse(done.text);assert.deepEqual(output.argv.slice(0,7),['--non-interactive','--format','json','--profile','isolated','--region','cn']);
 const rejected=await services.invoke({service_id:c.id,operation:'cli.invoke',input:{args:['node','run','--yes']},request_id:crypto.randomUUID()},caller);assert.equal((await services.wait(rejected.id)).evidence,'not_sent');
});

test('headless execution and review use separate scoped identities and expire with their Run',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const {rid,tid}=setup(f.wb,f.root);f.config.root=ROOT;const services=new ExternalServices(f.wb,fakeVault),c=await services.save(input());
 const execution=await services.headlessPatch(rid);assert.equal(execution.length,1);const read=async(patch:any)=>{const file=patch[0].insert[0].config.env.WORKBENCH_EXTERNAL_TOOLS_CREDENTIAL_FILE;return (await fakeVault.decrypt(JSON.parse(fs.readFileSync(file,'utf8')).protected_token)).token;};
 const executionToken=await read(execution);assert.equal(services.authenticate(executionToken)?.agent_id,'codex');
 const reviewId='RA-'+crypto.randomUUID();f.wb.put('review_assignments',{id:reviewId,run_id:rid,task_id:tid,reviewer_id:'grok-build',status:'awaiting_dispatch'},{run_id:rid});
 assert.deepEqual(await services.headlessPatch(rid,reviewId),[]);await services.save({id:c.id,version:c.version,allowed_agent_ids:['codex','grok-build']});
 const review=await services.headlessPatch(rid,reviewId),reviewToken=await read(review);assert.notEqual(reviewToken,executionToken);assert.equal(services.authenticate(reviewToken)?.agent_id,'grok-build');
 f.wb.put('tasks',{...f.wb.get('tasks',tid),status:'cancelled'},{project_id:'P-workbench'});assert.equal(services.authenticate(executionToken),undefined);assert.equal(services.authenticate(reviewToken),undefined);
});

test('mmx archives only its own generated files and never mutates caller argv used for idempotency',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const script=path.join(f.root,'synthetic-mmx.cjs');fs.writeFileSync(script,`const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);const dir=args[args.indexOf('--out-dir')+1],file=path.join(dir,'image_001.png');fs.writeFileSync(file,Buffer.from('${png}','base64'));process.stdout.write(JSON.stringify({saved:[file],success_count:1,failed_count:0}));`);
 const services=new ExternalServices(f.wb,fakeVault),c=await services.save({...input(),preset_id:'minimax-mmx',executable:process.execPath,args:[script],cwd:f.root,secrets:{}}),req={service_id:c.id,operation:'cli.invoke',input:{args:['image','generate','--prompt','synthetic']},request_id:crypto.randomUUID()};
 const job=await services.invoke(req,caller),done=await services.wait(job.id);assert.equal(done.status,'succeeded');assert.equal(done.artifacts.length,1);assert.equal(done.evidence,'local_artifacts_verified');assert.deepEqual(req.input.args,['image','generate','--prompt','synthetic']);assert.equal((await services.invoke(req,caller)).id,job.id);
});
test('bridge grant cannot overwrite arbitrary data and rotates old identity',async t=>{
 const f=fixture();t.after(()=>f.wb.close());const services=new ExternalServices(f.wb,fakeVault);const key=path.join(f.config.dataDir,'keys.json'),before=fs.readFileSync(key);await assert.rejects(services.createImageGrant('P-workbench','codex',key),/专用文件/);assert.deepEqual(fs.readFileSync(key),before);
 const file=path.join(f.config.dataDir,'external-tools','harness-image-bridge.json');await services.createImageGrant('P-workbench','codex',file);const saved=JSON.parse(fs.readFileSync(file,'utf8')),first=(await fakeVault.decrypt(saved.protected_token)).token;assert(services.authenticate(first));await services.createImageGrant('P-workbench','codex',file);assert.equal(services.authenticate(first),undefined);
});

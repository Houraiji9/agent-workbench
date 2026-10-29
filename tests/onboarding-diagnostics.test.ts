import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workbench } from '../src/core/workbench.ts';
import { executeOnboardingDiagnostic, refreshOnboardingModels, getOnboardingDiagnostics, parseOnboardingModelEnumeration, classifyOnboardingDiagnosticFailure, buildCursorDiagnosticInvocation, type OnboardingDiagnosticHooks } from '../src/core/onboarding-diagnostics.ts';
import type { ClientRecord } from '../src/core/client-discovery.ts';

function fixture(){
  const dataDir=path.resolve('.local-dev/test-onboarding-diagnostics',randomUUID());fs.mkdirSync(dataDir,{recursive:true});
  const agents:any[]=[{id:'grok-build',name:'审查',version:1},{id:'cursor',name:'Cursor',version:1},{id:'deepseek',name:'Harness',version:1},{id:'claude',name:'Claude',version:1},{id:'manual',name:'手动网页',version:1}];
  const audits:any[]=[];let resolves=0,calls=0,reported:string|undefined='Native-ID';
  const wb={config:{dataDir},all:()=>structuredClone(agents),get:(_table:string,id:string)=>{const a=agents.find(a=>a.id===id);assert.ok(a);return structuredClone(a);},put:(_table:string,row:any)=>{agents[agents.findIndex(a=>a.id===row.id)]=structuredClone(row);},transaction:(f:()=>any)=>f(),audit:(...args:any[])=>audits.push(args)} as unknown as Workbench;
  const record=(kind:any):ClientRecord=>({kind,label:kind,status:'verified',reason:'synthetic',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown',executable:process.execPath,version:'fixture',supportedFlags:['--list-models','--trust','--print','--mode','--output-format','--model','--workspace'],help:'--mode <mode> plan: read-only/planning (choices: "plan")'});
  const hooks:OnboardingDiagnosticHooks={resolve:async(_dir,kind)=>{resolves++;assert.notEqual(kind,'claude');return record(kind);},routes:async()=>[{model:'Exact-DSH',provider:'deepseek-account'},{model:'claude-opus',provider:'Anthropic'}],build:async(_record,options)=>({command:process.execPath,args:[options.promptFile],resolvedRoute:options.provider?{model:options.model!,provider:options.provider,source:'fixture'}:undefined}),run:async(invocation,cwd)=>{
    calls++;if(invocation.args.includes('--list-models'))return {stdout:JSON.stringify({models:[{id:'Native-ID',name:'模型展示名'},{id:'claude-opus',provider:'Anthropic'}]}),exit_code:0};
    const nonce=fs.readFileSync(path.join(cwd,'PROMPT.txt'),'utf8').match(/WB_DIAGNOSTIC_[a-z0-9-]+/)![0];
    return {stdout:JSON.stringify({type:'text',data:nonce})+'\n'+JSON.stringify({type:'end',sessionId:'fixture-session',stopReason:'end_turn',...(reported?{modelUsage:{[reported]:{}}}:{})}),exit_code:0};
  }};
  return {wb,agents,audits,hooks,input:()=>({request_id:randomUUID(),agent_id:'grok-build',model:'Native-ID'}),counts:()=>({resolves,calls}),setModel:(v:string|undefined)=>{reported=v;}};
}
test('refresh accepts observed native IDs, excludes Claude, and records web unknown',async()=>{
  const f=fixture(),result=await refreshOnboardingModels(f.wb,{},'actor:actual',f.hooks);
  assert.equal(result.results.find(r=>r.agent_id==='claude').status,'skipped');assert.equal(result.results.find(r=>r.agent_id==='manual').status,'unknown');
  assert.equal(f.agents[0].local_capabilities.history[0].models.length,1);assert.equal(f.agents[2].local_capabilities.history[0].models[0].provider,'deepseek-account');assert.equal(f.counts().resolves,3);
});
test('Claude rejection and needs_model happen before filesystem/discovery',async()=>{
  const f=fixture();for(const patch of [{agent_id:'claude'},{model:'Claude-Opus'},{provider:'Anthropic'}])await assert.rejects(()=>executeOnboardingDiagnostic(f.wb,{...f.input(),...patch},'actor',f.hooks));
  assert.equal((await executeOnboardingDiagnostic(f.wb,{request_id:randomUUID(),agent_id:'cursor'},'actor',f.hooks)).status,'needs_model');
  assert.deepEqual(f.counts(),{resolves:0,calls:0});assert.equal(fs.existsSync(path.join(f.wb.config.dataDir,'onboarding-diagnostics.json')),false);
});
test('nonce plus native terminal and matching model promotes internal evidence once',async()=>{
  const f=fixture(),input=f.input();const result=await executeOnboardingDiagnostic(f.wb,input,'executor:actual',f.hooks);
  assert.equal(result.status,'success');assert.equal(result.actual_model,'Native-ID');assert.equal(result.nonce_echo,true);assert.equal(result.actor,'executor:actual');
  assert.equal(f.agents[0].local_capabilities.history[0].models[0].status,'invocation_verified');
  assert.deepEqual(await executeOnboardingDiagnostic(f.wb,input,'executor:actual',f.hooks),result);assert.equal(f.counts().calls,1);
  await assert.rejects(()=>executeOnboardingDiagnostic(f.wb,{...input,model:'Other'},'executor:actual',f.hooks));assert.equal(getOnboardingDiagnostics(f.wb).records.length,1);
});
test('unknown actual model never promotes claimed requested model; mismatch stays explicit',async()=>{
  const f=fixture();f.setModel(undefined);const result=await executeOnboardingDiagnostic(f.wb,f.input(),'actor',f.hooks);assert.equal(result.status,'success');assert.equal(result.actual_model,'unknown');assert.equal(f.agents[0].local_capabilities,undefined);
  f.setModel('Other-Model');const mismatch=await executeOnboardingDiagnostic(f.wb,f.input(),'actor',f.hooks);assert.equal(mismatch.status,'model_mismatch');assert.equal(f.agents[0].local_capabilities,undefined);
});
test('exit0, arbitrary status, timeout and wrong nonce cannot masquerade as success',async()=>{
  const f=fixture();for(const output of [{stdout:JSON.stringify({status:'success'}),exit_code:0},{stdout:'',exit_code:null,timed_out:true},{stdout:JSON.stringify({type:'text',data:'wrong'})+'\n'+JSON.stringify({type:'end',sessionId:'s',stopReason:'end_turn'}),exit_code:0}]){
    const result=await executeOnboardingDiagnostic(f.wb,f.input(),'actor',{...f.hooks,run:async()=>output});assert.notEqual(result.status,'success');
  }
  assert.equal(f.agents[0].local_capabilities,undefined);
});
test('concurrent duplicate requests start only one invocation; saved started record never retried',async()=>{
  const f=fixture(),input=f.input();await Promise.all([executeOnboardingDiagnostic(f.wb,input,'actor',f.hooks),executeOnboardingDiagnostic(f.wb,input,'actor',f.hooks)]);assert.equal(f.counts().calls,1);
  const target=path.join(f.wb.config.dataDir,'onboarding-diagnostics.json'),saved=JSON.parse(fs.readFileSync(target,'utf8'));saved.records[0].status='started';fs.writeFileSync(target,JSON.stringify(saved));
  assert.equal((await executeOnboardingDiagnostic(f.wb,input,'actor',f.hooks)).status,'started');assert.equal(f.counts().calls,1);
});
test('Harness final echo works without pretending its undisclosed actual model was verified',async()=>{
  const f=fixture(),result=await executeOnboardingDiagnostic(f.wb,{request_id:randomUUID(),agent_id:'deepseek',model:'Exact-DSH'},'actor',{...f.hooks,run:async(_invocation,cwd)=>{
    const nonce=fs.readFileSync(path.join(cwd,'PROMPT.txt'),'utf8').match(/WB_DIAGNOSTIC_[a-z0-9-]+/)![0];return {stdout:JSON.stringify({type:'final',text:nonce}),exit_code:0};
  }});
  assert.equal(result.status,'success');assert.equal(result.requested_provider,'deepseek-account');assert.equal(result.actual_model,'unknown');assert.equal(f.agents[2].local_capabilities,undefined);
});
test('Cursor reports display labels as display labels rather than a verified native ID',async()=>{
  const f=fixture(),result=await executeOnboardingDiagnostic(f.wb,{request_id:randomUUID(),agent_id:'cursor',model:'Native-ID'},'actor',{...f.hooks,run:async(invocation,cwd)=>{
    const nonce=invocation.args.at(-1)!.match(/WB_DIAGNOSTIC_[a-z0-9-]+/)![0];assert.deepEqual(fs.readdirSync(cwd),[]);assert.equal(invocation.args.filter(a=>a==='--trust').length,1);assert.equal(invocation.args[invocation.args.indexOf('--mode')+1],'plan');assert.equal(invocation.args[invocation.args.indexOf('--model')+1],'Native-ID');assert(!invocation.args.some(a=>['--force','--yolo','-f'].includes(a)));assert(!invocation.args.at(-1)!.includes('PROMPT.txt'));return {stdout:JSON.stringify({type:'system',subtype:'init',session_id:'s',model:'Nice Label'})+'\n'+JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'s',result:nonce}),exit_code:0};
  }});
  assert.equal(result.status,'success');assert.equal(result.actual_model,'unknown');assert.equal(result.actual_model_label,'Nice Label');assert.equal(result.actual_model_format,'display_name');assert.equal(f.agents[1].local_capabilities,undefined);
});
test('Cursor trust is bounded to supported flags and newly created clean diagnostic workspaces',async()=>{
  for(const patch of [{supportedFlags:['--print','--mode','--output-format','--model','--workspace']},{help:'--mode <mode> choices agent'},{prefixArgs:['--force']}]){
    const f=fixture();let calls=0;const resolve=f.hooks.resolve!;
    const result=await executeOnboardingDiagnostic(f.wb,{request_id:randomUUID(),agent_id:'cursor',model:'grok-4.7-xhigh-fast'},'actor',{...f.hooks,resolve:async(d,k)=>({...await resolve(d,k),...patch}),run:async()=>{calls++;return {stdout:'',exit_code:0};}});
    assert.equal(result.status,'failed');assert.equal(result.failure_stage,'build_invocation');assert.equal(calls,0);
  }
  const f=fixture(),input={request_id:randomUUID(),agent_id:'cursor',model:'Native-ID'},dir=path.join(f.wb.config.dataDir,'onboarding-diagnostics',input.request_id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'foreign.txt'),'do not trust');
  const result=await executeOnboardingDiagnostic(f.wb,input,'actor',f.hooks);assert.equal(result.failure_stage,'create_isolated_directory');assert.equal(f.counts().calls,0);
  const record=await f.hooks.resolve!(f.wb.config.dataDir,'cursor');assert.throws(()=>buildCursorDiagnosticInvocation(record,f.wb.config.dataDir,'Native-ID','nonce'));
  const linked=fixture(),target=path.join(linked.wb.config.dataDir,'linked-target');fs.mkdirSync(target);fs.symlinkSync(target,path.join(linked.wb.config.dataDir,'onboarding-diagnostics'),'junction');
  const rejected=await executeOnboardingDiagnostic(linked.wb,{request_id:randomUUID(),agent_id:'cursor',model:'Native-ID'},'actor',linked.hooks);assert.equal(rejected.failure_stage,'create_isolated_directory');assert.equal(linked.counts().calls,0);assert.deepEqual(fs.readdirSync(target),[]);
});
test('diagnostic failure classification preserves exit status and safe actionable advice without raw output',async()=>{
  assert.equal(classifyOnboardingDiagnosticFailure('Workspace Trust Required\nPass --trust'), 'workspace_trust');assert.equal(classifyOnboardingDiagnosticFailure('Permission denied'),'permission');assert.equal(classifyOnboardingDiagnosticFailure('strange exit code'),undefined);
  for(const failure_kind of ['workspace_trust','permission'] as const){const f=fixture();const result=await executeOnboardingDiagnostic(f.wb,f.input(),'actor',{...f.hooks,run:async()=>({stdout:'private_token=secret-do-not-save',exit_code:1,failure_kind})});assert.equal(result.status,failure_kind);assert.equal(result.exit_code,1);assert(result.reason.length>20);assert(!JSON.stringify(getOnboardingDiagnostics(f.wb)).includes('secret-do-not-save'));}
  const f=fixture(),result=await executeOnboardingDiagnostic(f.wb,f.input(),'actor',{...f.hooks,run:async()=>({stdout:'',exit_code:91})});assert.equal(result.exit_code,91);assert.match(result.reason,/91/);assert.equal(result.status,'failed');
});
test('observed Cursor text list parses exact native rows, never labels, automatic modes or tip examples',async()=>{
  const raw=fs.readFileSync(new URL('./fixtures/cursor-onboarding-models.txt',import.meta.url),'utf8');
  const models=parseOnboardingModelEnumeration(raw,'cursor');
  assert.deepEqual(models.map(m=>m.id),['gpt-5.3-codex-low','gpt-5.3-codex-low-fast','composer-2.5','gpt-5.6-sol-high','cursor-grok-4.5-high','grok-4.7-xhigh-fast','deepseek-v41-flash-1017-max']);
  assert.equal(models[3].name,'GPT-5.6 Sol 1M High');assert.equal(models[3].status,'advertised');
  assert.throws(()=>parseOnboardingModelEnumeration(raw,'grok'));assert.throws(()=>parseOnboardingModelEnumeration('gpt-5.3-codex - Codex 5.3','cursor'));
  assert.deepEqual(parseOnboardingModelEnumeration(JSON.stringify({models:[{id:'Exact-ID',name:'Label'},{id:'default'},{id:'Claude-ID'}]}),'cursor').map(m=>m.id),['Exact-ID']);
  const f=fixture();const result=await refreshOnboardingModels(f.wb,{agent_id:'cursor'},'actor',{...f.hooks,run:async()=>({stdout:raw,exit_code:0})});
  assert.equal(result.results[0].model_count,7);assert.equal(f.agents[1].local_capabilities.history[0].models[3].id,'gpt-5.6-sol-high');
});

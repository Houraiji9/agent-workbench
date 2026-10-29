import test from 'node:test';
import assert from 'node:assert/strict';
import type { Workbench } from '../src/core/workbench.ts';
import { currentMachineId, listOnboardingTeam, recordOnboardingModels, recordOnboardingInvocation, resolveOnboardingModel } from '../src/core/onboarding-models.ts';

function fixture(){
  const agents:any[]=[{id:'grok-build',name:'自定义审查员',version:4,scope:'保留职责',model_group:{agent_id:'grok-build',as_of:'2020-01-01',sources:['manual'],models:[{id:'existing',name:'人工名称',purpose:'人工说明'}]}},{id:'claude',name:'Claude',version:1}];
  const audits:any[]=[];
  const wb={all:()=>structuredClone(agents),get:(_table:string,id:string)=>{const a=agents.find(a=>a.id===id);assert.ok(a);return structuredClone(a);},put:(_table:string,row:any)=>{agents[agents.findIndex(a=>a.id===row.id)]=structuredClone(row);},transaction:(f:()=>any)=>f(),audit:(...args:any[])=>audits.push(args)} as unknown as Workbench;
  const input:any={agent_id:'grok-build',machine_id:currentMachineId(),client_id:'grok',client_version:'1.2',observed_at:new Date().toISOString(),source:'client_models',models:[{id:'grok-4.7-build-fast',name:'Grok Build',provider:'xAI',status:'advertised'}]};
  return {wb,agents,audits,input};
}
test('exact IDs and provider survive recording; preserve manual information/history and actor',()=>{
  const {wb,agents,audits,input}=fixture();recordOnboardingModels(wb,input,'executor:real');recordOnboardingModels(wb,input,'executor:real');
  assert.equal(agents[0].name,'自定义审查员');assert.equal(agents[0].scope,'保留职责');assert.equal(agents[0].local_capabilities.history.length,2);assert.equal(agents[0].model_group.models.length,1);
  assert.equal(audits[0][0],'executor:real');assert.equal(audits[0][3].client_version,'1.2');
  assert.equal(resolveOnboardingModel(wb,'grok-build','grok-4.7-build-fast','xAI').status,'advertised');
  const alias=resolveOnboardingModel(wb,'grok-build','Grok Build');assert.equal(alias.status,'alias_requires_explicit_id');assert.equal(alias.requested_model,'Grok Build');assert.equal(alias.blocking,false);
  assert.equal(resolveOnboardingModel(wb,'grok-build','GROK-4.7-BUILD-FAST').status,'alias_requires_explicit_id');
  assert.equal(resolveOnboardingModel(wb,'grok-build','grok-4.7-build-fast','other').status,'not_observed');
});
test('reject foreign/static evidence and caller-claimed invocation',()=>{
  const {wb,input,agents}=fixture();
  for(const patch of [{machine_id:'different-machine'},{source:'static_catalog'},{source:'invocation',models:[{id:'x',status:'invocation_verified'}]},{models:[{id:' x',status:'advertised'}]}])assert.throws(()=>recordOnboardingModels(wb,{...input,...patch},'actor'));
  assert.equal(agents[0].local_capabilities,undefined);
  recordOnboardingInvocation(wb,{...input,source:'invocation',models:[{id:'Exact-ID-Suffix',status:'invocation_verified'}]},'diagnostic:real');
  assert.equal(resolveOnboardingModel(wb,'grok-build','Exact-ID-Suffix').status,'invocation_verified');
});
test('Claude and Anthropic routes are excluded without importing discovery or reading files',()=>{
  const {wb,input,agents,audits}=fixture();
  for(const patch of [{agent_id:'claude'},{client_id:'Claude Code'},{models:[{id:'Claude-Opus',status:'advertised'}]},{models:[{id:'opaque-id',provider:'Anthropic',status:'advertised'}]}])assert.throws(()=>recordOnboardingModels(wb,{...input,...patch},'actor'));
  assert.equal(audits.length,0);assert.equal(agents[1].version,1);assert.equal(listOnboardingTeam(wb).agents.find(a=>a.agent_id==='claude')?.status,'skipped');
});
test('conflicts preserve manual metadata; web/manual unknown and omitted members survive',()=>{
  const {wb,input,agents}=fixture();const result=recordOnboardingModels(wb,{...input,models:[{id:'existing',name:'发现的名称',provider:'p',status:'advertised'}]},'actor');
  assert.equal(result.conflicts[0].resolution,'preserved_existing');assert.equal(agents[0].model_group.models[0].name,'人工名称');assert.equal(agents.length,2);
  recordOnboardingModels(wb,{...input,source:'manual',models:[],reason:'仅网页，无法枚举'},'actor');
  assert.equal(listOnboardingTeam(wb).agents[0].status,'unknown');assert.equal(resolveOnboardingModel(wb,'grok-build','unknown').status,'not_observed');
  agents[0].local_capabilities.history=[{...input,machine_id:'old-computer'}];assert.equal(listOnboardingTeam(wb).agents[0].evidence_count,0);
});
test('stale evidence remains history and advisory candidates, never verified availability',()=>{
  const {wb,input,agents}=fixture();recordOnboardingModels(wb,{...input,observed_at:'2020-01-01T00:00:00Z'},'actor');
  assert.equal(listOnboardingTeam(wb).agents[0].status,'stale');
  const advice=resolveOnboardingModel(wb,'grok-build','grok-4.7-build-fast');assert.equal(advice.status,'stale');assert.equal(advice.blocking,false);assert.equal(advice.candidates[0].id,'grok-4.7-build-fast');
  assert.equal(agents[0].local_capabilities.history.length,1);
});
test('mixed-provider collisions remain distinct in evidence and are explicit in merge result',()=>{
  const {wb,input,agents}=fixture();const result=recordOnboardingModels(wb,{...input,models:[{id:'Same-ID',name:'A label',provider:'P1',status:'advertised'},{id:'Same-ID',name:'B label',provider:'P2',status:'advertised'}]},'actor');
  assert.equal(result.conflicts.length,1);assert.equal(agents[0].local_capabilities.history[0].models.length,2);
  const advice=resolveOnboardingModel(wb,'grok-build','Same-ID','P2');assert.equal(advice.status,'advertised');assert.equal(advice.candidates[0].provider,'P2');
});
test('one-model invocation enriches the latest catalog without hiding other observed routes',()=>{
  const {wb,input,agents}=fixture(),catalogTime=new Date(Date.now()-2000).toISOString(),callTime=new Date(Date.now()-1000).toISOString();
  recordOnboardingModels(wb,{...input,observed_at:catalogTime,models:[{id:'A-ID',name:'A展示',provider:'P1',status:'advertised'},{id:'B-ID',provider:'P2',status:'advertised'}]},'actor');
  recordOnboardingInvocation(wb,{...input,observed_at:callTime,source:'invocation',models:[{id:'A-ID',provider:'P1',status:'invocation_verified'}]},'internal');
  const models=listOnboardingTeam(wb).agents[0].models;
  assert.equal(models.length,2);assert.equal(models.find((m:any)=>m.id==='A-ID').status,'invocation_verified');assert.equal(models.find((m:any)=>m.id==='A-ID').name,'A展示');assert.equal(models.find((m:any)=>m.id==='A-ID').observed_at,callTime);
  assert.equal(models.find((m:any)=>m.id==='B-ID').status,'advertised');assert.equal(models.find((m:any)=>m.id==='B-ID').source,'client_models');assert.equal(models.find((m:any)=>m.id==='B-ID').observed_at,catalogTime);
  assert.equal(resolveOnboardingModel(wb,'grok-build','B-ID','P2').status,'advertised');assert.equal(agents[0].local_capabilities.history.length,2);
  recordOnboardingModels(wb,{...input,observed_at:new Date().toISOString(),models:[{id:'B-ID',provider:'P2',status:'advertised'}]},'actor');
  assert.deepEqual(listOnboardingTeam(wb).agents[0].models.map((m:any)=>m.id),['B-ID']);assert.equal(agents[0].local_capabilities.history.length,3);
});
test('advertised catalogs never populate team choices; registered exact models lead planning and retain manual names',()=>{
  const {wb,input,agents}=fixture();agents[0].model_group.models=[{id:'grok-4.7-xhigh-fast',name:'用户常用Grok',purpose:'用户登记',provider:'Cursor'}];
  recordOnboardingModels(wb,{...input,models:[{id:'grok-4.7-xhigh-fast',name:'原生名称',provider:'Cursor',status:'advertised'},{id:'not-actually-usable',status:'advertised'}]},'actor');
  assert.equal(agents[0].model_group.models.length,1);const registered=listOnboardingTeam(wb).agents[0].registered_models;
  assert.equal(registered.length,1);assert.equal(registered[0].id,'grok-4.7-xhigh-fast');assert.equal(registered[0].name,'用户常用Grok');assert.equal(registered[0].source,'team_registration');assert.equal(registered[0].status,'configured');assert.equal(registered[0].observed_at,null);
  assert.equal(resolveOnboardingModel(wb,'grok-build','grok-4.7-xhigh-fast','Cursor').status,'configured');
  recordOnboardingInvocation(wb,{...input,source:'invocation',models:[{id:'grok-4.7-xhigh-fast',provider:'Cursor',status:'invocation_verified'}]},'internal');
  assert.equal(listOnboardingTeam(wb).agents[0].registered_models[0].status,'invocation_verified');assert.equal(agents[0].model_group.models.length,1);
});

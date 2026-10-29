import test from 'node:test';
import assert from 'node:assert/strict';
import { agentInput } from '../src/core/resource-management.ts';
import { currentMachineId, recordOnboardingModels, recordOnboardingInvocation } from '../src/core/onboarding-models.ts';
import { chatPlanningContext, chatPlanningBrief } from '../src/core/chat-planning.ts';
import { dispatchBrief } from '../src/core/execution-context.ts';
import { fixture } from './helpers.ts';

test('team editor preserves only necessary optional provider/status metadata',()=>{
  const input={version:1,name:'测试成员',scope:'测试',restriction:'',model:null,icon_key:'codex',allowed_kinds:['engineering'],models:[{id:'Exact-ID-Suffix',name:'人工展示名',purpose:'人工说明',provider:'Case-Sensitive-Provider',status:'configured'}]};
  assert.equal(agentInput.parse(input).models[0].provider,'Case-Sensitive-Provider');assert.equal(agentInput.parse(input).models[0].status,'configured');
  assert.throws(()=>agentInput.parse({...input,models:[{...input.models[0],credentials:'forbidden'}]}));assert.throws(()=>agentInput.parse({...input,models:[{...input.models[0],status:'available'}]}));
  const {provider,status,...legacy}=input.models[0];assert.equal(agentInput.parse({...input,models:[legacy]}).models[0].id,'Exact-ID-Suffix');
});

test('chat and dispatch briefs retain exact local model evidence, excluding static and foreign catalogs',()=>{
  const f=fixture();try{
    const q=f.wb.request({project_id:'P-workbench',text:'测试：按本机原生模型编号安排'}),observed_at=new Date().toISOString();
    const registered=f.wb.get('agents','grok-build');f.wb.put('agents',{...registered,model:'Other-ID',model_group:{agent_id:'grok-build',as_of:'2026-10-29',sources:[],models:[{id:'Case-ID-Fast',name:'用户名称',purpose:'用户常用',provider:'Exact-P'},{id:'Other-ID',name:'其他登记',purpose:'用户登记',provider:'Other-P'}]}});
    recordOnboardingModels(f.wb,{agent_id:'grok-build',machine_id:currentMachineId(),client_id:'grok',client_version:'synthetic-1',source:'client_models',observed_at,models:[{id:'Case-ID-Fast',name:'展示名称',provider:'Exact-P',status:'advertised'},{id:'Other-ID',provider:'Other-P',status:'advertised'},{id:'Advertised-Only',status:'advertised'}]},'test:synthetic');
    recordOnboardingInvocation(f.wb,{agent_id:'grok-build',machine_id:currentMachineId(),client_id:'grok',source:'invocation',observed_at,models:[{id:'Other-ID',provider:'Other-P',status:'invocation_verified'}]},'test:synthetic-internal');
    const codex=f.wb.get('agents','codex');f.wb.put('agents',{...codex,local_capabilities:{history:[{machine_id:'other-machine',source:'client_models',observed_at,models:[{id:'FOREIGN-ID',status:'invocation_verified'}]}]}});
    const chat=chatPlanningBrief(chatPlanningContext(f.wb,q.id)),dispatch=dispatchBrief(f.wb.dispatchContext(),q.project_id);
    for(const brief of [chat,dispatch]){
      const local=brief.local_models.agents.find((a:any)=>a.agent_id==='grok-build');assert.equal(local.preferred_model,'Other-ID');assert.equal(local.models.length,2);assert.equal(local.models[0].id,'Case-ID-Fast');assert.equal(local.models[0].name,'用户名称');assert.equal(local.models[0].provider,'Exact-P');assert.equal(local.models[0].status,'configured');assert.equal(local.models[0].source,'team_registration');assert.equal(local.models[0].observed_at,null);assert.equal(local.models[1].status,'invocation_verified');assert.equal(local.models[1].source,'invocation');assert.equal(local.advertised_reference_count,3);assert(!JSON.stringify(local.models).includes('Advertised-Only'));
      assert.equal(brief.local_models.agents.find((a:any)=>a.agent_id==='codex').status,'unknown');assert(!JSON.stringify(brief.local_models).includes('FOREIGN-ID'));assert(!('manual_models' in local));assert(!('history' in local));
      assert.equal(brief.local_models.agents.find((a:any)=>a.agent_id==='claude').status,'skipped');
    }
    assert(!('models' in chat));assert(!('model_catalog' in dispatch));
  }finally{f.wb.close();}
});

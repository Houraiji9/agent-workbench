import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createApp} from '../src/server/app.ts';
import {fixture} from './helpers.ts';
import type {ExternalVault} from '../src/core/external-vault.ts';

test('API Agent page routes enforce real app authentication and expose no key; configuration checks never call the provider',async t=>{
  const f=fixture();f.wb.close();let providerCalls=0;const encrypted=new Map<string,Record<string,string>>(),vault:ExternalVault={available:true,async encrypt(value){const key='synthetic-cipher:'+crypto.randomUUID();encrypted.set(key,structuredClone(value));return key;},async decrypt(key){const value=encrypted.get(key);assert(value);return structuredClone(value);}};
  const runtime=await createApp(f.config,{background:false,apiAgentVault:vault,apiAgentFetch:(async()=>{providerCalls++;throw Error('synthetic provider must not be invoked by configuration UI');})as typeof fetch});t.after(()=>runtime.app.close());
  const host='127.0.0.1:'+f.config.port,boot=await runtime.app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(boot.headers['set-cookie']).split(';')[0],headers={host,cookie,'x-workbench-csrf':boot.json().csrf},input={name:'配置页 API 成员',base_url:'https://fixture.example/v1',protocol:'responses',model:'exact-user-model',api_key:'synthetic-route-secret-'+crypto.randomUUID()};
  assert.equal((await runtime.app.inject({url:'/api/api-agents',headers:{host}})).statusCode,401);
  assert.equal((await runtime.app.inject({url:'/api/api-agents/save',method:'POST',headers:{host,cookie},payload:input})).statusCode,403);
  assert.equal((await runtime.app.inject({url:'/api/api-agents/save',method:'POST',headers:{...headers,origin:'https://cross-site.example'},payload:input})).statusCode,403);
  assert.equal((await runtime.app.inject({url:'/api/api-agents/save',method:'POST',headers:{...headers,authorization:'Bearer '+runtime.wb.keys.manager},payload:input})).statusCode,403);
  const saved=await runtime.app.inject({url:'/api/api-agents/save',method:'POST',headers,payload:input});assert.equal(saved.statusCode,200,saved.body);assert(!saved.body.includes(input.api_key));const config=saved.json();assert.equal(config.has_key,true);assert.equal(runtime.wb.get('agents',config.id).preset_id,'api-agent');
  const checked=await runtime.app.inject({url:'/api/api-agents/'+config.id+'/check',method:'POST',headers,payload:{}});assert.equal(checked.statusCode,200,checked.body);assert.equal(checked.json().ready,true);assert(checked.json().message.includes('未调用模型'));assert.equal(providerCalls,0);
  const listing=await runtime.app.inject({url:'/api/api-agents',headers});assert.equal(listing.statusCode,200);assert.equal(listing.json().agents.length,1);assert(!listing.body.includes(input.api_key));assert(!listing.body.includes('synthetic-cipher:'));
  const candidates=await runtime.app.inject({url:'/api/workgroups/candidates?project_id=P-workbench',headers});assert.equal(candidates.statusCode,200,candidates.body);const candidate=candidates.json().candidates.find((entry:any)=>entry.agent_id===config.id);assert(candidate);assert.equal(candidate.client_id,'api-agent');assert.equal(candidate.available,true);
  const created=await runtime.app.inject({url:'/api/workgroups',method:'POST',headers,payload:{request_id:crypto.randomUUID(),project_id:'P-workbench',name:'API 负责人测试群',leader_agent_id:config.id}});assert.equal(created.statusCode,200,created.body);assert.equal(created.json().members[0].model,input.model);assert.equal(providerCalls,0);
  const cleared=await runtime.app.inject({url:'/api/api-agents/save',method:'POST',headers,payload:{id:config.id,version:config.version,wipe_key:true}});assert.equal(cleared.statusCode,200,cleared.body);assert.equal(cleared.json().has_key,false);assert.equal(cleared.json().model,input.model);assert.equal(providerCalls,0);
});

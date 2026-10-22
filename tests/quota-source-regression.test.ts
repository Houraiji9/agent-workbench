import {test} from 'node:test';import assert from 'node:assert/strict';import {fixture} from './helpers.ts';import {Integrations} from '../src/integrations/adapters.ts';import {editQuotaCache} from '../src/core/quota-cache.ts';
test('分组手填后接口与规划保留其他组的实时来源和时间，断线后只有来源组变为缓存',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  const at=new Date(Date.now()-20000).toISOString();i.saveToken({limits:{updatedAt:at,providers:[{provider:'antigravity',status:'ok',updatedAt:at,windows:[{kind:'session',label:'Gemini 5-hour',remainingPercent:31},{kind:'weekly',label:'Gemini 4 Argon weekly',remainingPercent:41},{kind:'weekly',label:'Claude/GPT weekly',remainingPercent:51}]}]}});
  editQuotaCache(wb,'antigravity',{version:1,group:'argon',windows:[{kind:'weekly',label:'Gemini 4 Argon weekly',remaining_percent:21,resets_at:null}]});
  for(const s of [wb.snapshot(),wb.dispatchContext()]){const ws=s.quota_windows.filter((w:any)=>w.pool_id==='CACHE-antigravity');assert.equal(s.quota_pools.find((p:any)=>p.provider==='antigravity').source,'mixed');for(const w of ws.filter((w:any)=>!w.label.includes('Argon'))){assert.equal(w.source,'token_monitor');assert.equal(w.source_updated_at,at);assert.equal(w.display_state,'live');assert.equal(w.freshness,'fresh')}const m=ws.find((w:any)=>w.label.includes('Argon'));assert.equal(m.source,'user_entered');assert.equal(m.display_state,'manual')}
  wb.put('integrations',{...wb.get('integrations','tokenMonitor'),status:'disconnected'});const ws=wb.snapshot().quota_windows.filter((w:any)=>w.pool_id==='CACHE-antigravity');assert(ws.filter((w:any)=>!w.label.includes('Argon')).every((w:any)=>w.display_state==='cached'&&w.freshness==='stale'));assert.equal(ws.find((w:any)=>w.label.includes('Argon')).display_state,'manual');
 }finally{i.stop();wb.close()}
});
test('分组手填后其他组的旧来源在接口与规划仍然陈旧',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  const at=new Date(Date.now()-3600000).toISOString();i.saveToken({limits:{updatedAt:at,providers:[{provider:'antigravity',status:'ok',updatedAt:at,windows:[{kind:'session',label:'Gemini 5-hour',remainingPercent:31},{kind:'weekly',label:'Gemini 4 Argon weekly',remainingPercent:41}]}]}});
  editQuotaCache(wb,'antigravity',{version:1,group:'argon',windows:[{kind:'weekly',label:'Gemini 4 Argon weekly',remaining_percent:21,resets_at:null}]});const s=wb.dispatchContext(),old=s.quota_windows.find((w:any)=>w.label==='Gemini 5-hour');assert(old);assert.equal(old.source,'token_monitor');assert.equal(old.source_updated_at,at);assert.equal(old.display_state,'cached');assert.equal(old.freshness,'stale');assert.equal(s.quota_pools.find((p:any)=>p.provider==='antigravity')?.freshness,'stale');
 }finally{i.stop();wb.close()}
});

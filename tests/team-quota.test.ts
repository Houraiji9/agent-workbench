import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {fixture,taskInput,event} from './helpers.ts';import {Workbench} from '../src/core/workbench.ts';import {Integrations} from '../src/integrations/adapters.ts';import {editQuotaCache,quotaView} from '../src/core/quota-cache.ts';import {modelCatalog,validateModel} from '../src/core/model-catalog.ts';import {createApp} from '../src/server/app.ts';
import {isModelRetired} from '../src/shared/model-policy.ts';
const stamp=(offset=0)=>new Date(Date.now()+offset).toISOString();
const input=(version=0,n:number|null=38)=>({version,windows:[{label:'5 小时',kind:'session',remaining_percent:n,resets_at:null}]});
const raw=(at:string,providers:any[])=>({limits:{updatedAt:at,providers:providers.map(p=>({updatedAt:at,windows:[],status:'ok',...p}))}});
const quota=(provider='antigravity',n=44)=>({provider,accountKey:'test-only-account',windows:[{kind:'session',label:'5 小时',remainingPercent:n}]});

test('目录退役日期按工作台时区显示，但型号建议不按退役日期或任务种类拒绝',()=>{
 const m={retire_at:'2026-11-02'},at=new Date('2026-11-01T17:00:00Z');assert(isModelRetired(m,'Asia/Shanghai',at));assert(!isModelRetired(m,'America/Los_Angeles',at));
 assert.equal(validateModel('antigravity','GPT-OSS 120B',at,'Asia/Shanghai'),'GPT-OSS 120B');
 assert.equal(validateModel('antigravity','GPT-OSS 120B',at,'America/Los_Angeles'),'GPT-OSS 120B');
 assert.equal(validateModel('antigravity','Claude Opus 5.5 Thinking',new Date(),'UTC','engineering'),'Claude Opus 5.5 Thinking');
 assert.equal(validateModel('antigravity','Claude Opus 5.5 Thinking',new Date(),'UTC','frontend_light'),'Claude Opus 5.5 Thinking');
 assert.equal(validateModel('claude','claude-opus-5-5',new Date(),'UTC','engineering'),'claude-opus-5-5');
});

test('两个缓存保留成功额度，关闭来源、空窗口、缺失提供方和旧快照后仍在，重启保留',()=>{
 const f=fixture();let wb=f.wb;let i=new Integrations(wb);
 try{
  i.saveToken(raw(stamp(-100000),[quota(),quota('claude',27)]));const before=wb.all('quota_cache');assert.equal(before.length,2);
  i.saveToken(raw(stamp(-80000),[{provider:'antigravity',status:'notConfigured'},{provider:'claude',status:'ok'}]));
  i.saveToken(raw(stamp(-70000),[{provider:'workbuddy',status:'notConfigured'}]));
  assert.deepEqual(wb.all('quota_cache'),before);assert.equal(quotaView(wb).pools.find(p=>p.provider==='antigravity')?.display_state,'cached');
  i.saveToken(raw(stamp(-200000),[quota('claude',99)]));assert.deepEqual(wb.all('quota_cache'),before);
  i.stop();wb.close();wb=new Workbench(f.config);assert.deepEqual(wb.all('quota_cache'),before);assert.equal(wb.snapshot().quota_windows.find((w:any)=>w.pool_id==='CACHE-claude').remaining_percent,27);
 }finally{i.stop();wb.close()}
});
test('来源时间超前的同一采集在手填后重复读取和重启均不覆盖，严格新采集才替换',()=>{
 const f=fixture();let wb=f.wb,i=new Integrations(wb);const at=stamp(60000);try{
  i.saveToken(raw(at,[quota('claude',90)]));const c=editQuotaCache(wb,'claude',input(1,12));assert(c.source_updated_at<at);assert.equal(c.upstream_watermark,at);assert.equal(quotaView(wb).pools.find(p=>p.provider==='claude')?.freshness,'fresh');
  i.saveToken(raw(at,[quota('claude',90)]));assert.deepEqual(wb.get('quota_cache','claude'),c);i.stop();wb.close();wb=new Workbench(f.config);i=new Integrations(wb);assert.deepEqual(wb.get('quota_cache','claude'),c);
  i.saveToken(raw(new Date(Date.parse(at)+1000).toISOString(),[quota('claude',61)]));assert.equal(wb.get('quota_cache','claude').windows[0].remaining_percent,61);
 }finally{i.stop();wb.close()}
});
test('Antigravity分组编辑只改该组，其他组数值时间和来源保留，版本冲突及跨组拒绝',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  i.saveToken(raw(stamp(-10000),[{provider:'antigravity',windows:[{kind:'session',label:'Gemini 5-hour',remainingPercent:32},{kind:'weekly',label:'Gemini 4 Argon weekly',remainingPercent:42},{kind:'weekly',label:'Claude/GPT weekly',remainingPercent:52}]}]));
  const old=wb.get('quota_cache','antigravity');const patch={version:old.version,group:'argon',windows:[{label:'Gemini 4 Argon weekly',kind:'weekly',remaining_percent:18,resets_at:null}]};
  editQuotaCache(wb,'antigravity',patch);const after=wb.get('quota_cache','antigravity');assert.equal(after.windows.length,3);for(const w of old.windows.filter((w:any)=>!w.label.includes('Argon')))assert.deepEqual(after.windows.find((x:any)=>x.label===w.label),w);
  assert.equal(after.windows.find((w:any)=>w.label.includes('Argon')).remaining_percent,18);assert.throws(()=>editQuotaCache(wb,'antigravity',patch),/额度已更新/);
  assert.throws(()=>editQuotaCache(wb,'antigravity',{...patch,version:after.version,group:'gemini'}),/分组/);assert.throws(()=>editQuotaCache(wb,'claude',{...patch,version:0}),/分组/);
 }finally{i.stop();wb.close()}
});
test('手填零值持久化，旧采集不能覆盖，新采集覆盖并审计，表单冲突拒绝',()=>{
 const f=fixture();let wb=f.wb;let i=new Integrations(wb);
 try{
  const at=stamp(-100000);i.saveToken(raw(at,[quota('claude',88)]));const v=wb.get('quota_cache','claude').version;
  const c=editQuotaCache(wb,'claude',input(v,0));assert.equal(wb.snapshot().quota_windows.find((w:any)=>w.pool_id==='CACHE-claude').remaining_percent,0);
  i.saveToken(raw(at,[quota('claude',88)]));assert.equal(wb.get('quota_cache','claude').source,'user_entered');
  assert.throws(()=>editQuotaCache(wb,'claude',input(v)),/额度已更新/);
  i.stop();wb.close();wb=new Workbench(f.config);i=new Integrations(wb);assert.deepEqual(wb.get('quota_cache','claude'),c);
  i.saveToken(raw(stamp(1000),[quota('claude',63)]));assert.equal(wb.get('quota_cache','claude').source,'token_monitor');assert.equal(wb.get('quota_cache','claude').windows[0].remaining_percent,63);
  assert(wb.db.prepare("SELECT 1 FROM audit WHERE action='refresh_manual_quota'").get());
 }finally{i.stop();wb.close()}
});
test('仅支持两个缓存，非法手填和非法来源均不改变最后数值',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  editQuotaCache(wb,'antigravity',input());const c=wb.get('quota_cache','antigravity');
  for(const provider of ['codex','deepseek','workbuddy','__proto__'])assert.throws(()=>editQuotaCache(wb,provider,input()),/由 Token Monitor/);
  for(const n of [-1,101,NaN,null])assert.throws(()=>editQuotaCache(wb,'antigravity',input(1,n)));
  assert.throws(()=>i.saveToken(raw(stamp(),[quota('antigravity',110)])));
  assert.throws(()=>i.saveToken(raw(stamp(600000),[quota()])));assert.deepEqual(wb.get('quota_cache','antigravity'),c);
  const empty=quotaView(wb).pools.find(p=>p.provider==='claude');assert.equal(empty?.display_state,'empty');assert(!quotaView(wb).windows.some(w=>w.pool_id===empty?.id));
 }finally{i.stop();wb.close()}
});
test('智谱去货币余额、DeepSeek去同币同额重复窗口、WorkBuddy去重、计划池隐去且原记录保留',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  i.saveToken(raw(stamp(),[{...quota('zai',80),balance:{amount:0,currency:'CNY'},windows:[{kind:'session',remainingPercent:80},{kind:'billing',label:'Balance',remaining:0,currency:'CNY'}]},
   {provider:'deepseek',balance:{amount:160.25,currency:'CNY'},windows:[{kind:'billing',label:'Balance',remaining:160.25,currency:'CNY'},{kind:'billing',label:'其他币种',remaining:160.25,currency:'USD'}]},
   {provider:'workbuddy',status:'notConfigured'},{provider:'workbuddy',accountKey:'second',status:'notConfigured'}]));
  const v=quotaView(wb),z=v.pools.find(p=>p.provider==='zai')!,d=v.pools.find(p=>p.provider==='deepseek')!;
  assert.equal(z.balance,null);assert.equal(v.windows.filter(w=>w.pool_id===z.id).length,1);assert.equal(d.balance.amount,160.25);assert.deepEqual(v.windows.filter(w=>w.pool_id===d.id).map(w=>w.unit),['USD']);
  assert.equal(v.pools.filter(p=>p.provider==='workbuddy').length,1);assert.equal(wb.all('quota_pools').filter(p=>p.provider==='workbuddy').length,2);
  assert(!v.pools.some(p=>p.id==='test-shared-planned'));assert(wb.get('quota_pools','test-shared-planned').archived);assert.deepEqual(wb.snapshot().quota_pools,wb.dispatchContext().quota_pools);
  assert.equal(wb.get('quota_pools',z.id).balance.amount,0);assert.equal(wb.all('quota_windows').filter(w=>w.pool_id===d.id).length,2);
 }finally{i.stop();wb.close()}
});
test('缓存编辑接口需要页面会话与 CSRF，保存后读接口和规划一致',async()=>{
 const f=fixture();f.wb.close();const {app}=await createApp(f.config,{background:false}),host='127.0.0.1:'+f.config.port;
 try{const b=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(b.headers['set-cookie']).split(';')[0],headers={host,cookie,'x-workbench-csrf':b.json().csrf};
  assert.equal((await app.inject({method:'POST',url:'/api/quota-cache/claude',headers:{host,cookie},payload:input()})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/quota-cache/codex',headers,payload:input()})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/quota-cache/claude',headers,payload:input()})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/quota-cache/claude',headers,payload:input()})).statusCode,409);
  const s=(await app.inject({url:'/api/state',headers:{host,cookie}})).json();assert.equal(s.quota_windows.find((w:any)=>w.pool_id==='CACHE-claude').remaining_percent,38);
 }finally{await app.close()}
});
test('当前十一位成员目录保留来源和模式分类，目录外或退役名称仍可作为建议',()=>{
 const {wb}=fixture();try{assert.equal(modelCatalog.length,11);for(const a of wb.dispatchContext().agents){const g=modelCatalog.find(x=>x.agent_id===a.id)!;assert(g&&g.models.length);assert(g.sources.every(s=>s.startsWith('https://')));assert.equal(new Set(g.models.map(m=>m.id)).size,g.models.length)}
  assert.equal(validateModel('grok-bot','auto'),'auto');assert.equal(validateModel('grok-bot','private-client-model'),'private-client-model');assert(modelCatalog.find(x=>x.agent_id==='grok-search')!.models.every(m=>m.kind==='mode'));
  assert.equal(validateModel('antigravity','GPT-OSS 120B',new Date('2026-11-02')),'GPT-OSS 120B');assert.equal(wb.snapshot().model_catalog.length,11);
 }finally{wb.close()}
});
test('模型建议允许目录外值和同Run修改，实际回报独立，旧包和改派历史保留',()=>{
 const {wb,root}=fixture();try{
  const q=wb.request({project_id:'P-workbench',text:'测试：可选模型建议'}),plan={schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(root),requested_model:'private-client-model'}]};
  assert.throws(()=>wb.submitPlan({...plan,tasks:[{...plan.tasks[0],requested_model:'invalid\u0000model'}]}));assert.equal(wb.get('requests',q.id).status,'awaiting_planning');
  const p=wb.submitPlan(plan),t=wb.get('tasks',p.task_ids[0]),r=wb.exportOrder(t.id,1),text=fs.readFileSync(r.path,'utf8');assert.match(text,/建议模型 \/ 模式: private-client-model/);assert.equal(wb.get('runs',r.run_id).actual_model,null);
  assert.throws(()=>wb.exportOrder(t.id,1,false,'deepseek'),/执行者已固定/);assert.equal(wb.exportOrder(t.id,1,false,undefined,undefined,'gpt-6-luna').run_id,r.run_id);assert.equal(wb.exportOrder(t.id,1).run_id,r.run_id);
  assert.equal(wb.get('runs',r.run_id).model_advice_history[0].previous,'private-client-model');assert.equal(wb.get('runs',r.run_id).model_advice_history[0].model,'gpt-6-luna');
  wb.event(event(root,t.id,r.run_id,1,'started',{actual_model:'runtime-reported-model'}));assert.equal(wb.get('runs',r.run_id).requested_model,'gpt-6-luna');assert.equal(wb.get('runs',r.run_id).actual_model,'runtime-reported-model');
  wb.event(event(root,t.id,r.run_id,2,'failed'));const current=wb.get('tasks',t.id);const retry=wb.exportOrder(t.id,1,true,'deepseek',current.revision);assert.equal(wb.get('runs',retry.run_id).requested_model,null);assert.equal(fs.readFileSync(r.path,'utf8'),text);
  const frozen=JSON.parse(fs.readFileSync(wb.get('runs',retry.run_id).directory+'/task.json','utf8'));assert.equal(frozen.agent_id,'deepseek');assert.equal(frozen.requested_model,null);
 }finally{wb.close()}
});

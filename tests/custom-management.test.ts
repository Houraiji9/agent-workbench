import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fixture,taskInput} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {saveAgent,archiveAgent,currentModels,saveQuota,archiveQuota} from '../src/core/resource-management.ts';
import {agentPresets} from '../src/core/agent-presets.ts';
import {createApp} from '../src/server/app.ts';
import {Integrations} from '../src/integrations/adapters.ts';
import {modelCatalog} from '../src/core/model-catalog.ts';

const agent=(name='测试自定义成员')=>({version:0,preset_id:null,name,scope:'开发与测试',restriction:'',model:null,icon_key:'auto',allowed_kinds:['engineering','review'],models:[{id:'test-model',name:'测试型号',purpose:'隔离测试'}]});
const win=(metric='percent',remaining:number|null=0)=>({label:'测试窗口',metric,remaining,limit:null,currency:metric==='currency'?'USD':null,unit:metric==='count'?'次':'',resets_at:null});
const quota=(members:string[]=[])=>({version:0,source_ref:null,name:'测试共享额度',members,windows:[win(),win('points',100),win('currency',22.5),win('count',null)]});

test('预设不添加真实成员或订阅，用户添加后可编辑模型、规划导出、删除恢复并跨重启保留',()=>{
 const f=fixture();let wb=f.wb;try{
  const original=wb.all('subscriptions'),originalCount=wb.all('agents').length;
  assert(agentPresets.length>=30);assert.equal(new Set(agentPresets.map(p=>p.id)).size,agentPresets.length);
  assert(agentPresets.every(p=>p.sources.every(url=>url.startsWith('https://'))));
  assert.equal(wb.snapshot().agent_presets.length,agentPresets.length);assert.equal(wb.all('agents').length,originalCount);
  const preset=agentPresets.find(p=>p.id==='qoder')!;
  let a=saveAgent(wb,null,{...agent(),preset_id:preset.id,name:preset.name});
  assert.throws(()=>saveAgent(wb,null,{...agent('重复预设'),preset_id:preset.id}),/已经在团队/);
  a=saveAgent(wb,a.id,{...agent('测试 Qoder'),version:a.version,preset_id:a.preset_id,models:[{id:'test-2',name:'新模型',purpose:'测试用途'}]});
  assert.throws(()=>saveAgent(wb,a.id,{...agent(),version:1}),/已更新/);
  const q=wb.request({project_id:'P-workbench',text:'测试：自定义成员实际派单'});
  const t={...taskInput(f.root),agent_id:a.id,requested_model:'test-2'};
  const plan=wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:1,tasks:[t]});
  const order=wb.exportOrder(plan.task_ids[0],1),before=fs.readFileSync(order.path);
  assert.match(before.toString(),/test-2/);
  assert.throws(()=>archiveAgent(wb,a.id,{version:a.version}),/还有 1 项任务/);
  const task=wb.get('tasks',plan.task_ids[0]);wb.manualAction(task.id,'cancel',task.revision);
  a=archiveAgent(wb,a.id,{version:a.version});assert(!wb.dispatchContext().agents.some((x:any)=>x.id===a.id));assert.throws(()=>wb.eligible(a.id),/已移出/);
  wb.close();wb=new Workbench(f.config);assert(wb.get('agents',a.id).archived);assert.equal(currentModels(wb).find(g=>g.agent_id===a.id),undefined);
  a=archiveAgent(wb,a.id,{version:a.version},true);assert.equal(currentModels(wb).find(g=>g.agent_id===a.id)?.models[0].id,'test-2');
  assert.deepEqual(fs.readFileSync(order.path),before);assert.deepEqual(wb.all('subscriptions'),original);
 }finally{wb.close()}
});

test('成员数据校验、模型去重、Grok职责和旧合并入口约束保持',()=>{
 const {wb}=fixture();try{
  assert.throws(()=>saveAgent(wb,null,{...agent(),allowed_kinds:[] }));
  assert.throws(()=>saveAgent(wb,null,{...agent(),models:[...agent().models,...agent().models]}),/重复/);
  assert.throws(()=>saveAgent(wb,null,{...agent(),icon_key:'https://bad.site/icon.svg'}));
  assert.throws(()=>saveAgent(wb,null,{...agent(),archived:false}));
  const g=wb.get('agents','grok-build');assert.throws(()=>saveAgent(wb,g.id,{...agent(),version:g.version}),/独立审查/);
  for(const aid of ['antigravity-flash','cursor-claude']){const archived=wb.get('agents',aid);assert(archived.archived);assert(!archived.managed_archived);assert.throws(()=>archiveAgent(wb,archived.id,{version:archived.version},true),/旧入口/);assert.throws(()=>wb.eligible(aid),/已移出/)}
  const a=saveAgent(wb,null,agent());assert.throws(()=>saveAgent(wb,null,agent()),/已有这个名称/);
  const q=wb.request({project_id:'P-workbench',text:'测试未登记型号'});const p=wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(wb.config.root),agent_id:a.id,requested_model:'missing-model'}]});
  assert.equal(wb.get('tasks',p.task_ids[0]).requested_model,'missing-model');
 }finally{wb.close()}
});

test('手动额度保留零与未知，单位分开、多人共用单一池，修改删除恢复并持久化',()=>{
 const f=fixture();let wb=f.wb;try{
  const a=saveAgent(wb,null,agent()),b=saveAgent(wb,null,agent('测试成员二'));
  let d=saveQuota(wb,null,quota([a.id,b.id]));
  const context=wb.dispatchContext(),p=context.quota_pools.find((p:any)=>p.id===d.id)!;
  assert.deepEqual(p.members,[a.id,b.id]);assert.equal(context.quota_pools.filter((p:any)=>p.id===d.id).length,1);
  for(const aid of [a.id,b.id])assert(context.agents.find((a:any)=>a.id===aid)!.pool_ids.includes(d.id));
  const ws=context.quota_windows.filter((w:any)=>w.pool_id===d.id);assert.equal(ws[0].remaining_percent,0);assert.equal(ws[1].unit,'积分');assert.equal(ws[2].unit,'USD');assert.equal(ws[3].remaining,null);
  d=saveQuota(wb,d.id,{...quota([a.id]),version:1,windows:[{...win('points',50),limit:200}]});assert.equal(wb.snapshot().quota_windows.find((w:any)=>w.pool_id===d.id).remaining_percent,25);
  assert.throws(()=>saveQuota(wb,d.id,{...quota(),version:1}),/已更新/);
  d=archiveQuota(wb,d.id,{version:d.version});wb.close();wb=new Workbench(f.config);assert(!wb.snapshot().quota_pools.some((p:any)=>p.id===d.id));
  d=archiveQuota(wb,d.id,{version:d.version},true);assert.equal(wb.snapshot().quota_windows.find((w:any)=>w.pool_id===d.id).remaining,50);
  archiveAgent(wb,a.id,{version:a.version});assert.deepEqual(wb.dispatchContext().quota_pools.find((p:any)=>p.id===d.id)!.members,[]);
 }finally{wb.close()}
});

test('同步额度的名称共享关系和隐藏设置独立于采集；后续更新不会复活，原数据保留',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  const update=(amount:number)=>i.saveToken({limits:{updatedAt:new Date().toISOString(),providers:[{provider:'deepseek',status:'ok',balance:{amount,currency:'CNY'},windows:[]}]}});
  update(10);const p=wb.snapshot().quota_pools.find((p:any)=>p.provider==='deepseek');const raw=wb.get('quota_pools',p.id);
  let d=saveQuota(wb,null,{version:0,source_ref:p.id,name:'我的 DeepSeek',members:['deepseek','codex'],windows:[]});
  assert.deepEqual(wb.get('quota_pools',p.id),raw);assert.equal(wb.snapshot().quota_pools.filter((q:any)=>q.id===p.id).length,1);
  assert.throws(()=>saveQuota(wb,null,{version:0,source_ref:p.id,name:'重复',members:[],windows:[]}),/已登记/);
  d=archiveQuota(wb,d.id,{version:d.version});update(22);assert(!wb.snapshot().quota_pools.some((q:any)=>q.id===p.id));assert.equal(wb.get('quota_pools',p.id).balance.amount,22);
  d=archiveQuota(wb,d.id,{version:d.version},true);assert.equal(wb.snapshot().quota_pools.find((q:any)=>q.id===p.id).balance.amount,22);
  assert.throws(()=>saveQuota(wb,d.id,{version:d.version,source_ref:null,name:'变换来源',members:[],windows:[win()]}),/来源保持/);
 }finally{i.stop();wb.close()}
});

test('拒绝伪造来源、负值、非法百分比、空窗口、无效成员和版本；来源隐藏可原子创建',()=>{
 const {wb}=fixture();try{
  for(const patch of [{windows:[]},{windows:[win('percent',101)]},{windows:[win('points',-1)]},{windows:[{...win('points',10),limit:5}]},{members:['missing']},{source_ref:'not-a-source',windows:[]},{version:3}])assert.throws(()=>saveQuota(wb,null,{...quota(),...patch}));
  const q=saveQuota(wb,null,{version:0,source_ref:'MANUAL-workbuddy-points',name:'WorkBuddy',members:['workbuddy'],windows:[]},true);assert(q.archived);assert(!wb.snapshot().quota_pools.some((p:any)=>p.points_editable));
  assert.throws(()=>saveQuota(wb,q.id,{...quota(),version:1,source_ref:q.source_ref}),/先恢复/);
 }finally{wb.close()}
});

test('管理写入要求页面会话和CSRF，不能通过规划MCP修改团队',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});const host='127.0.0.1:'+f.config.port;
 try{
  const boot=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(boot.headers['set-cookie']).split(';')[0];
  for(const [url,payload] of [['/api/agents',agent()],['/api/quotas',quota()]] as const){
   assert.equal((await app.inject({method:'POST',url,headers:{host},payload})).statusCode,401);
   assert.equal((await app.inject({method:'POST',url,headers:{host,cookie},payload})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url,headers:{host,cookie,'x-workbench-csrf':boot.json().csrf},payload})).statusCode,200);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/mcp/save_agent',headers:{host,authorization:'Bearer '+wb.keys.planner},payload:agent()})).statusCode,403);
 }finally{await app.close()}
});

test('移除预设成员后须恢复原身份；历史 Cursor 预设仍遵守订阅资格',()=>{
 const {wb}=fixture();try{
  for(const aid of ['codex','zcode','antigravity']){
   const old=wb.get('agents',aid),archived=archiveAgent(wb,aid,{version:old.version});
   assert.throws(()=>saveAgent(wb,null,{...agent('重新添加 '+aid),preset_id:aid}),/恢复原记录/);
   const restored=archiveAgent(wb,aid,{version:archived.version},true);assert.equal(restored.id,aid);assert.deepEqual(restored.account_ids,old.account_ids);
  }
  assert.throws(()=>wb.eligible('codex',new Date('2099-01-01')),/订阅已到期/);
  const cursor=saveAgent(wb,null,{...agent('新 Cursor'),preset_id:'cursor'});assert.doesNotThrow(()=>wb.eligible(cursor.id));assert.equal(cursor.account_ids.length,0);
  let a=saveAgent(wb,null,{...agent('自定义 Qoder'),preset_id:'qoder'});a=archiveAgent(wb,a.id,{version:a.version});
  assert.throws(()=>saveAgent(wb,null,{...agent('另一 Qoder'),preset_id:'qoder'}),/恢复原记录/);
 }finally{wb.close()}
});

test('预设借用模型时保留官方来源日期，修改资料和模型保留来源信息',()=>{
 const {wb}=fixture();try{
  for(const [key,from] of [['claude-code','claude'],['kimi-code','kimi']]){
   const preset=agentPresets.find(p=>p.id===key)!,catalog=modelCatalog.find(g=>g.agent_id===from)!;
   const a=saveAgent(wb,null,{...agent(key),preset_id:key,models:preset.models});
   assert.equal(a.model_group.as_of,catalog.as_of);for(const url of catalog.sources)assert(a.model_group.sources.includes(url));
   wb.put('agents',{...a,model_group:{...a.model_group,as_of:'2026-01-01'}});
   const updated=saveAgent(wb,a.id,{...agent(key+' 改名'),preset_id:key,version:a.version,models:preset.models});
   assert.equal(updated.model_group.as_of,'2026-01-01');assert.deepEqual(updated.model_group.sources,a.model_group.sources);
  }
 }finally{wb.close()}
});

test('手填额度按数值更新时间进入概况，空值、改名和恢复不会刷新旧数值',()=>{
 const {wb}=fixture();try{
  let d=saveQuota(wb,null,quota());let s=wb.snapshot(),ws=s.quota_windows.filter((w:any)=>w.pool_id===d.id);
  assert.equal(s.quota_pools.find((p:any)=>p.id===d.id).freshness,'fresh');assert.equal(ws[0].freshness,'fresh');assert.equal(ws[3].freshness,'stale');assert.equal(ws[3].display_state,'empty');
  const old='2026-01-01T00:00:00.000Z';wb.put('quota_definitions',{...d,updated_at:old,values_updated_at:old});
  d=saveQuota(wb,d.id,{...quota(),version:d.version,name:'仅改名'});assert.equal(d.values_updated_at,old);
  d=archiveQuota(wb,d.id,{version:d.version});d=archiveQuota(wb,d.id,{version:d.version},true);
  assert.equal(wb.snapshot().quota_pools.find((p:any)=>p.id===d.id).freshness,'stale');
  d=saveQuota(wb,d.id,{...quota(),version:d.version,windows:[win('percent',20)]});s=wb.snapshot();assert.equal(s.quota_windows.find((w:any)=>w.pool_id===d.id).freshness,'fresh');
 }finally{wb.close()}
});

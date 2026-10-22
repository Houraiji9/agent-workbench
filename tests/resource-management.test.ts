import {test} from 'node:test';import assert from 'node:assert/strict';
import {fixture,setup} from './helpers.ts';import {Workbench} from '../src/core/workbench.ts';import {createApp} from '../src/server/app.ts';

test('订阅和安排新增、编辑、删除后重启仍保留；基线删除不会复活',()=>{
 const f=fixture();let wb=f.wb;
 try{
  const plan=wb.createSubscription({title:'测试待定安排',status:'planned',planned_date:null});assert.equal(plan.confirmed_at,null);assert.equal(plan.account_id,null);
  const sub=wb.createSubscription({title:'测试订阅',status:'user_reported_active',account_id:'google',amount:10,currency:'USD',interval:'month'});
  wb.updateBaseline('subscriptions',sub.id,{amount:12,status:'user_reported_expired'},1);
  wb.deleteSubscription(plan.id,{version:1});wb.deleteSubscription('test-active-kimi',{version:1});
  assert(!wb.snapshot().subscriptions.some((s:any)=>[plan.id,'test-active-kimi'].includes(s.id)));
  assert(!wb.dispatchContext().subscriptions.some((s:any)=>s.id===plan.id));
  wb.close();wb=new Workbench(f.config);
  assert.equal(wb.get('subscriptions',sub.id).amount,12);assert.equal(wb.get('subscriptions',sub.id).status,'user_reported_expired');
  assert(wb.get('subscriptions','test-active-kimi').deleted_at);assert(!wb.all('subscriptions').some(s=>s.id==='test-active-kimi'));
  assert.throws(()=>wb.updateBaseline('subscriptions',plan.id,{title:'不能复活'},2),/删除/);assert.throws(()=>wb.confirmSubscription(plan.id,{}),/删除/);
 }finally{wb.close()}
});

test('删除后不算可派单资源；旧表单删除冲突保留数据；外部订阅不可改删',()=>{
 const {wb}=fixture();try{
  wb.updateBaseline('subscriptions','test-active-codex',{note:'别处先改'},1);
  assert.throws(()=>wb.deleteSubscription('test-active-codex',{version:1}),/版本冲突/);
  wb.deleteSubscription('test-active-codex',{version:2});assert.doesNotThrow(()=>wb.eligible('codex'));assert(!wb.dispatchContext().subscriptions.some(s=>s.id==='test-active-codex'));
  wb.put('subscriptions',{id:'external',source:'token_monitor',version:1},{account_id:null});
  assert.throws(()=>wb.deleteSubscription('external',{version:1}),/外部事实/);
  assert.throws(()=>wb.updateBaseline('subscriptions','external',{title:'不能改'},1),/外部事实/);
 }finally{wb.close()}
});

test('新增不接受购买事实注入，无效日期/金额/账号原子拒绝；计划不能编辑成购买',()=>{
 const {wb}=fixture();try{
  const before=wb.all('subscriptions').length;
  for(const extra of [{status:'user_confirmed_active'},{source:'user_confirmed'},{confirmed_at:new Date().toISOString()},{id:'fake'},{amount:1},{planned_date:'2026-02-30'},{account_id:'missing'}])assert.throws(()=>wb.createSubscription({title:'测试',status:'planned',...extra}));
  assert.equal(wb.all('subscriptions').length,before);
  assert.throws(()=>wb.updateBaseline('subscriptions','test-plan-shared',{status:'user_reported_active'},1),/不能通过编辑/);
  assert.equal(wb.get('subscriptions','test-plan-shared').status,'planned');
 }finally{wb.close()}
});

test('已确认订阅也能编辑删除，但实际确认依据与关联计划历史保留',()=>{
 const {wb}=fixture();try{
  const actual=wb.confirmSubscription('test-plan-price',{version:1,occurred_at:new Date().toISOString(),end_date:null,note:'隔离测试：在平台上核实'});
  const edited=wb.updateBaseline('subscriptions',actual.id,{title:'测试新名称',amount:15,currency:'USD',interval:'month'},1);
  assert.equal(edited.plan_id,'test-plan-price');assert.equal(edited.occurred_at,actual.occurred_at);assert.equal(edited.source,'user_confirmed');
  wb.deleteSubscription('test-plan-price',{version:2});assert(wb.all('subscriptions').some(s=>s.id===actual.id));
  wb.deleteSubscription(actual.id,{version:2});assert(wb.get('subscriptions',actual.id).deleted_at);
  assert(wb.db.prepare("SELECT 1 FROM audit WHERE action='confirm_subscription' AND entity_id=?").get(actual.id));
 }finally{wb.close()}
});

test('团队迁移一次生效，移出入口不能再派单，既有任务与会话不改写',()=>{
 const f=fixture();let wb=f.wb;
 try{
  const {tid}=setup(wb,f.root),task=wb.get('tasks',tid);task.agent_id='antigravity-flash';wb.put('tasks',task,{project_id:task.project_id});
  const agents=wb.dispatchContext().agents;assert.equal(agents.find(a=>a.id==='claude')?.name,'Claude');assert.equal(agents.find(a=>a.id==='grok-search')?.name,'Grok 网页');
  assert.equal(agents.filter(a=>a.id.startsWith('antigravity')).length,1);assert(!agents.some(a=>a.id.startsWith('cursor')));
  assert(!wb.dispatchContext().quota_pools.some(p=>p.id==='test-shared-planned'));
  const pool={id:'verified-shared-test',status:'ok',provider:'test',candidate_members:['cursor','grok-build']};wb.put('quota_pools',pool);
  assert.deepEqual(wb.dispatchContext().quota_pools.find(p=>p.id===pool.id)?.candidate_members,['grok-build']);assert.deepEqual(wb.get('quota_pools',pool.id).candidate_members,['cursor','grok-build']);
  for(const id of ['cursor','cursor-claude','antigravity-claude','antigravity-flash'])assert.throws(()=>wb.eligible(id),/移出团队或合并/);
  const a=wb.get('agents','grok-search');wb.updateBaseline('agents',a.id,{scope:'用户自行补充的网页工作'},a.version);
  wb.close();wb=new Workbench(f.config);assert.equal(wb.get('agents','grok-search').scope,'用户自行补充的网页工作');assert.deepEqual(wb.get('tasks',tid),task);
 }finally{wb.close()}
});

test('订阅增删接口需要页面会话与 CSRF，合法新增再删除后不可见',async()=>{
 const f=fixture();f.wb.close();const {app}=await createApp(f.config,{background:false});const host='127.0.0.1:'+f.config.port;
 try{
  const b=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(b.headers['set-cookie']).split(';')[0],headers={host,cookie,'x-workbench-csrf':b.json().csrf};
  const payload={title:'测试接口订阅',status:'user_reported_active'};
  assert.equal((await app.inject({method:'POST',url:'/api/subscriptions',headers:{host,cookie},payload})).statusCode,403);
  const r=await app.inject({method:'POST',url:'/api/subscriptions',headers,payload});assert.equal(r.statusCode,200);const sub=r.json();
  assert.equal((await app.inject({method:'POST',url:'/api/subscriptions/'+sub.id+'/delete',headers:{host,cookie},payload:{version:1}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/subscriptions/'+sub.id+'/delete',headers,payload:{version:1}})).statusCode,200);
  assert(!(await app.inject({url:'/api/state',headers:{host,cookie}})).json().subscriptions.some((s:any)=>s.id===sub.id));
 }finally{await app.close()}
});

test('兼容迁移保留用户名称、分工和历史任务',()=>{
 const f=fixture();let wb=f.wb;
 try{
  const {tid}=setup(wb,f.root),task=wb.get('tasks',tid);
  const old={...wb.get('agents','antigravity'),name:'反重力',scope:'用户已补充的分工',version:7};wb.put('agents',old);
  wb.db.prepare('DELETE FROM migrations WHERE version=5').run();wb.close();wb=new Workbench(f.config);
  const updated=wb.get('agents','antigravity');assert.equal(updated.name,'反重力');assert.equal(updated.scope,old.scope);assert.equal(updated.version,7);
  assert.deepEqual(wb.get('tasks',tid),task);
  const count=()=>Number((wb.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='agent_display_name_update' AND entity_id='antigravity'").get() as any).n);
  assert.equal(count(),0);wb.close();wb=new Workbench(f.config);assert.deepEqual(wb.get('agents','antigravity'),updated);assert.equal(count(),0);
 }finally{wb.close()}
});

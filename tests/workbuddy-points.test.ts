import {test} from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './helpers.ts';import {Workbench} from '../src/core/workbench.ts';import {editWorkBuddyPoints,quotaView} from '../src/core/quota-cache.ts';import {createApp} from '../src/server/app.ts';import {Integrations} from '../src/integrations/adapters.ts';

test('WorkBuddy 积分初始为空，零和小数保存重启，清空保留版本和审计',()=>{
 const f=fixture();let wb=f.wb;try{
  assert.equal(quotaView(wb).pools.find(p=>p.points_editable)?.points_amount,null);
  assert(!quotaView(wb).windows.some(w=>w.pool_id==='MANUAL-workbuddy-points'));
  editWorkBuddyPoints(wb,{version:0,remaining:0});assert.equal(wb.snapshot().quota_pools.find((p:any)=>p.points_editable).points_amount,0);
  editWorkBuddyPoints(wb,{version:1,remaining:128.125});wb.close();wb=new Workbench(f.config);
  for(const s of [wb.snapshot(),wb.dispatchContext()]){const p=s.quota_pools.find((p:any)=>p.points_editable),w=s.quota_windows.find((w:any)=>w.pool_id===p.id);assert.equal(p.points_amount,128.125);assert.equal(p.balance,null);assert.equal(w.unit,'积分');assert.equal(w.remaining,128.125);assert.equal(w.remaining_percent,null);assert.equal(w.source,'user_entered')}
  assert.throws(()=>editWorkBuddyPoints(wb,{version:1,remaining:7}),/积分已更新/);
  editWorkBuddyPoints(wb,{version:2,remaining:null});wb.close();wb=new Workbench(f.config);
  const p=quotaView(wb).pools.find(p=>p.points_editable)!;assert.equal(p.points_amount,null);assert.equal(p.points_version,3);assert.equal(p.display_state,'empty');assert(!quotaView(wb).windows.some(w=>w.pool_id===p.id));
  assert(wb.db.prepare("SELECT 1 FROM audit WHERE action='clear_workbuddy_points'").get());
 }finally{wb.close()}
});

test('积分输入拒绝负值、超范围、非法精度和字段，独立于自动采集及订阅历史',()=>{
 const {wb}=fixture(),i=new Integrations(wb);try{
  const subs=wb.all('subscriptions');editWorkBuddyPoints(wb,{version:0,remaining:2100});const old=wb.get('quota_cache','workbuddy-points');
  for(const remaining of [-1,NaN,Infinity,1e9+1,0.0001,'2',''])assert.throws(()=>editWorkBuddyPoints(wb,{version:1,remaining}));
  assert.throws(()=>editWorkBuddyPoints(wb,{version:1,remaining:25,provider:'deepseek'}));
  i.saveToken({limits:{updatedAt:new Date().toISOString(),providers:[{provider:'workbuddy',status:'notConfigured',windows:[]},{provider:'workbuddy',accountKey:'other',status:'notConfigured',windows:[]},{provider:'deepseek',status:'ok',balance:{amount:160.25,currency:'CNY'},windows:[]}]}});
  assert.deepEqual(wb.get('quota_cache','workbuddy-points'),old);assert.deepEqual(wb.all('subscriptions'),subs);
  assert.equal(quotaView(wb).pools.filter(p=>p.provider==='workbuddy').length,1);assert.equal(quotaView(wb).pools.find(p=>p.provider==='deepseek')?.balance.amount,160.25);
 }finally{i.stop();wb.close()}
});

test('积分写入仅接受页面会话和 CSRF，MCP 规划入口只读取积分',async()=>{
 const f=fixture();f.wb.close();const {app}=await createApp(f.config,{background:false});const host='127.0.0.1:'+f.config.port;
 try{const b=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(b.headers['set-cookie']).split(';')[0],headers={host,cookie,'x-workbench-csrf':b.json().csrf},payload={version:0,remaining:0};
  assert.equal((await app.inject({method:'POST',url:'/api/manual-points/workbuddy',headers:{host},payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/manual-points/workbuddy',headers:{host,cookie},payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/manual-points/workbuddy',headers,payload})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/manual-points/workbuddy',headers,payload})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/api/manual-points/workbuddy',headers,payload:{version:1,remaining:-1}})).statusCode,400);
  const s=(await app.inject({url:'/api/state',headers:{host,cookie}})).json();assert.equal(s.quota_windows.find((w:any)=>w.pool_id==='MANUAL-workbuddy-points').remaining,0);
 }finally{await app.close()}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {fixture,setup,event,taskInput} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {editWorkBuddyPoints} from '../src/core/quota-cache.ts';
import {saveQuota,saveAgent} from '../src/core/resource-management.ts';
import {monthlyPercent,otherPoints} from '../src/shared/points.ts';
import {rejectAcceptance,reworkOrder} from '../src/core/acceptance-feedback.ts';
import {createApp} from '../src/server/app.ts';
import {dependencySatisfied} from '../src/core/task-dependencies.ts';

test('月度积分包含在总积分内，零未知分开、跨重启及过刷新日保留、不重复计池',()=>{
 const f=fixture();let wb=f.wb;try{
  editWorkBuddyPoints(wb,{version:0,remaining:1800,monthly:{allowance:500,remaining:500},resets_at:null});
  for(const s of [wb.snapshot(),wb.dispatchContext()]){const pools=s.quota_pools.filter((p:any)=>p.provider==='workbuddy'),ws=s.quota_windows.filter((w:any)=>w.pool_id===pools[0].id);assert.equal(pools.length,1);assert.equal(ws.length,1);assert.equal(ws[0].remaining,1800);assert.equal(monthlyPercent(ws[0] as any),100);assert.equal(otherPoints(ws[0] as any),1300)}
  for(const monthly of [{allowance:500,remaining:501},{allowance:0,remaining:0},{allowance:500,remaining:-1}])assert.throws(()=>editWorkBuddyPoints(wb,{version:1,remaining:1800,monthly}));
  assert.throws(()=>editWorkBuddyPoints(wb,{version:1,remaining:499}),/包含在总积分/);
  assert.throws(()=>editWorkBuddyPoints(wb,{version:0,remaining:1800}),/已更新/);
  editWorkBuddyPoints(wb,{version:1,remaining:1300,monthly:{allowance:500,remaining:0},resets_at:'2020-01-01T00:00:00.000Z'});
  wb.close();wb=new Workbench(f.config);let w=wb.snapshot().quota_windows.find((w:any)=>w.pool_id==='MANUAL-workbuddy-points');assert.equal(w.remaining,1300);assert.equal(monthlyPercent(w as any),0);assert.equal(otherPoints(w as any),1300);
  editWorkBuddyPoints(wb,{version:2,remaining:1300,monthly:{allowance:500,remaining:null}});w=wb.snapshot().quota_windows.find((w:any)=>w.pool_id==='MANUAL-workbuddy-points');assert.equal(monthlyPercent(w as any),null);assert.equal(otherPoints(w as any),null);
  editWorkBuddyPoints(wb,{version:3,remaining:1300,monthly:{allowance:500,remaining:200}});editWorkBuddyPoints(wb,{version:4,remaining:null});
  const row=wb.db.prepare("SELECT data FROM audit WHERE action='clear_workbuddy_points' ORDER BY rowid DESC LIMIT 1").get() as any;assert.equal(JSON.parse(row.data).before.monthly.remaining,200);assert.equal(JSON.parse(row.data).after.monthly.remaining,null);
 }finally{wb.close()}
});

test('自定义积分可使用月度组成，金额和次数拒绝月度积分配置',()=>{
 const {wb}=fixture();try{
  const w={label:'积分',metric:'points',remaining:1200,limit:null,currency:null,unit:'',resets_at:null,monthly:{allowance:500,remaining:250}},input={version:0,source_ref:null,name:'测试千问积分',members:[],windows:[w]};
  const q=saveQuota(wb,null,input),projected=wb.dispatchContext().quota_windows.find((x:any)=>x.pool_id===q.id);assert.equal(monthlyPercent(projected as any),50);assert.equal(otherPoints(projected as any),950);
  for(const windows of [[{...w,metric:'currency',currency:'CNY'}],[{...w,remaining:200}],[{...w,limit:1200}]])assert.throws(()=>saveQuota(wb,null,{...input,name:'测试非法额度',windows}));
  const unknown=saveQuota(wb,null,{...input,name:'测试总量未知',windows:[{...w,remaining:null}]}),snapshot=wb.snapshot(),pool=snapshot.quota_pools.find((x:any)=>x.id===unknown.id),window=snapshot.quota_windows.find((x:any)=>x.pool_id===unknown.id);assert.equal(pool.display_state,'manual');assert.equal(window.display_state,'manual');assert.equal(monthlyPercent(window),50);assert.equal(otherPoints(window),null);
 }finally{wb.close()}
});

function delivered(wb:Workbench,root:string){const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离测试的交付结果，验证使用意见与技术审查相互独立。'}));const hashes=wb.all('artifacts').filter(a=>a.run_id===s.rid).map(a=>a.sha256);const review={run_id:s.rid,reviewer_id:'grok-build',performed:true,evidence:'隔离测试夹具，不是真实 Grok 审查',verdict:'passed',artifact_hashes:hashes};wb.review(review);return {...s,hashes,review,payload:()=>({revision:wb.get('tasks',s.tid).revision,run_id:s.rid,note:'卡片太高，请保持原有设计并拆开。',artifact_hashes:hashes})}}

test('用户拒绝独立保存、重开 Run 和复制幂等，固化原因并保护旧包/Review/产物',()=>{
 const f=fixture();let wb=f.wb;try{
  const d=delivered(wb,f.root),oldRun=wb.get('runs',d.rid),oldPackage=fs.readFileSync(d.order.path),arts=wb.all('artifacts'),reviews=wb.all('reviews');
  const r=rejectAcceptance(wb,d.tid,d.payload());assert.equal(r.task.status,'acceptance_rejected');assert.equal(r.feedback.verdict,'rejected');
  assert.throws(()=>wb.review(d.review),/仅可审查/);assert.throws(()=>wb.accept(d.tid,{revision:r.task.revision,checks:[true]}));
  const e=wb.event(event(f.root,d.tid,d.rid,3,'started'));assert.equal(e.disposition,'rejected');assert.equal(wb.get('tasks',d.tid).status,'acceptance_rejected');
  const v={revision:r.task.revision,feedback_id:r.feedback.id},order=reworkOrder(wb,d.tid,v);assert.notEqual(order.run_id,d.rid);assert.equal(order.status,'awaiting_dispatch');assert.equal(reworkOrder(wb,d.tid,v).run_id,order.run_id);
  const run=wb.get('runs',order.run_id);assert.equal(run.agent_id,oldRun.agent_id);assert.equal(run.requested_model,oldRun.requested_model);assert.match(fs.readFileSync(order.path,'utf8'),/卡片太高/);assert.equal(JSON.parse(fs.readFileSync(run.directory+'/REWORK.json','utf8')).user_feedback[0].id,r.feedback.id);
  assert.deepEqual(fs.readFileSync(d.order.path),oldPackage);assert.deepEqual(wb.all('artifacts'),arts);assert.deepEqual(wb.all('reviews'),reviews);
  assert.throws(()=>wb.event(event(f.root,d.tid,d.rid,4)),/旧 Run/);
  wb.close();wb=new Workbench(f.config);assert.equal(wb.get('tasks',d.tid).acceptance_feedback[0].note,r.feedback.note);
  wb.event(event(f.root,d.tid,order.run_id,1));wb.event(event(f.root,d.tid,order.run_id,2,'submitted',{result:'测试返工再次交付，应该重新进行独立审查和用户确认。'}));assert.throws(()=>wb.accept(d.tid,{revision:wb.get('tasks',d.tid).revision,checks:[true]}),/Review/);
 }finally{wb.close()}
});

test('拒绝校验版本、Run和产物；关联真实后续任务后旧任务保持未通过且不可再次派单',()=>{
 const {wb,root}=fixture();try{
  const d=delivered(wb,root),second=setup(wb,root);
  for(const patch of [{revision:1},{run_id:second.rid},{artifact_hashes:['0'.repeat(64)]},{note:' '},{followup_task_id:d.tid}])assert.throws(()=>rejectAcceptance(wb,d.tid,{...d.payload(),...patch}));
  const r=rejectAcceptance(wb,d.tid,{...d.payload(),followup_task_id:second.tid});assert.equal(r.task.status,'rework_linked');assert.equal(r.task.rework_task_id,second.tid);assert(!r.task.acceptance_record);
  assert.throws(()=>wb.exportOrder(d.tid,1,true,undefined,r.task.revision));assert.throws(()=>wb.manualAction(d.tid,'cancel',r.task.revision));assert.throws(()=>reworkOrder(wb,d.tid,{revision:r.task.revision,feedback_id:r.feedback.id}));
 }finally{wb.close()}
});

test('拒绝与返工接口只接受页面会话和CSRF，过期写入返回冲突',async()=>{
 const f=fixture(),d=delivered(f.wb,f.root),payload=d.payload();f.wb.close();const {app}=await createApp(f.config,{background:false}),host='127.0.0.1:'+f.config.port;
 try{const b=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(b.headers['set-cookie']).split(';')[0],headers={host,cookie,'x-workbench-csrf':b.json().csrf};
  for(const endpoint of ['reject','rework']){assert.equal((await app.inject({method:'POST',url:'/api/tasks/'+d.tid+'/'+endpoint,headers:{host},payload})).statusCode,401);assert.equal((await app.inject({method:'POST',url:'/api/tasks/'+d.tid+'/'+endpoint,headers:{host,cookie},payload})).statusCode,403)}
  const r=await app.inject({method:'POST',url:'/api/tasks/'+d.tid+'/reject',headers,payload});assert.equal(r.statusCode,200);assert.equal((await app.inject({method:'POST',url:'/api/tasks/'+d.tid+'/reject',headers,payload})).statusCode,409);
 }finally{await app.close()}
});

test('改派后的不通过返工沿用实际执行者与指定模型，并支持未审查的真实交付退回',()=>{
 const {wb,root}=fixture();try{
  const d=delivered(wb,root),agent=saveAgent(wb,null,{version:0,preset_id:null,name:'测试改派成员',scope:'隔离测试',restriction:'',model:null,icon_key:'auto',allowed_kinds:['engineering'],models:[{id:'test-model',name:'测试模型',purpose:'验证返工'}]});
  const order=wb.exportOrder(d.tid,1,true,agent.id,wb.get('tasks',d.tid).revision,'test-model');
  wb.event(event(root,d.tid,order.run_id,1,'started',{identity:agent.id}));wb.event(event(root,d.tid,order.run_id,2,'submitted',{identity:agent.id,result:'改派后隔离测试交付，用户仍可以在独立Review之前退回。'}));
  const t=wb.get('tasks',d.tid),r=rejectAcceptance(wb,d.tid,{revision:t.revision,run_id:order.run_id,note:'测试：继续交给实际执行者修改',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===order.run_id).map(a=>a.sha256)}),retry=reworkOrder(wb,d.tid,{revision:r.task.revision,feedback_id:r.feedback.id}),run=wb.get('runs',retry.run_id);
  assert.equal(wb.get('tasks',d.tid).agent_id,'codex');assert.equal(run.agent_id,agent.id);assert.equal(run.requested_model,'test-model');assert.equal(run.retry_context.previous_run_id,order.run_id);assert.equal(run.status,'awaiting_dispatch');
 }finally{wb.close()}
});

function dependent(wb:Workbench,root:string,dependencies:string[]){const q=wb.request({project_id:'P-workbench',text:'测试返工依赖'});return wb.submitPlan({schema_version:1,plan_id:q.id,request_id:q.id,expected_version:1,tasks:[{...taskInput(root),dependencies}]}).task_ids[0]}
test('关联后续返工拒绝直接、间接及跨替代链的循环，拒绝不改变旧任务',()=>{
 const {wb,root}=fixture();try{
  const a=delivered(wb,root),b=dependent(wb,root,[a.tid]),c=dependent(wb,root,[b]);
  for(const target of [b,c])assert.throws(()=>rejectAcceptance(wb,a.tid,{...a.payload(),followup_task_id:target}),/后续任务依赖/);
  assert.equal(wb.get('tasks',a.tid).status,'in_review');assert(!wb.get('tasks',a.tid).acceptance_feedback);
  const next=delivered(wb,root);rejectAcceptance(wb,a.tid,{...a.payload(),followup_task_id:next.tid});
  assert.throws(()=>rejectAcceptance(wb,next.tid,{...next.payload(),followup_task_id:c}),/后续任务依赖/);assert.equal(wb.get('tasks',next.tid).status,'in_review');
 }finally{wb.close()}
});
test('原任务未通过，依赖仅在替代成果真正验收后解除，多轮替代仍需等待最后一轮',()=>{
 const {wb,root}=fixture();try{
  const a=delivered(wb,root),b=delivered(wb,root),c=delivered(wb,root),waiting=dependent(wb,root,[a.tid]);
  rejectAcceptance(wb,a.tid,{...a.payload(),followup_task_id:b.tid});assert(!dependencySatisfied(wb,a.tid));assert.throws(()=>wb.exportOrder(waiting,1),/尚未验收/);
  rejectAcceptance(wb,b.tid,{...b.payload(),followup_task_id:c.tid});assert(!dependencySatisfied(wb,a.tid));assert.throws(()=>wb.exportOrder(waiting,1),/尚未验收/);
  wb.accept(c.tid,{revision:wb.get('tasks',c.tid).revision,checks:[true]});assert(dependencySatisfied(wb,a.tid));assert.equal(wb.get('tasks',a.tid).status,'rework_linked');assert.equal(wb.get('tasks',b.tid).status,'rework_linked');assert.equal(wb.exportOrder(waiting,1).status,'awaiting_dispatch');
 }finally{wb.close()}
});

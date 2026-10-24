import {finishCloseout} from './helpers.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,setup,event,taskInput} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {defaultUserAcceptance} from '../src/core/acceptance.ts';

function delivered(custom=false){
  const f=fixture(),{wb,root}=f;
  const s=custom?(()=>{
    const q=wb.request({project_id:'P-workbench',text:'测试专用：普通话使用确认'});
    const p=wb.submitPlan({schema_version:1,plan_id:q.id,request_id:q.id,expected_version:1,tasks:[{...taskInput(root),user_acceptance:['我能找到项目里的任务','我能看懂下一步要做什么']}]});
    const order=wb.exportOrder(p.task_ids[0],1);
    return {tid:p.task_ids[0],rid:order.run_id,order};
  })():setup(wb,root);
  wb.event(event(root,s.tid,s.rid,1));
  wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'测试专用结果：验证使用确认与技术要求分开，不能证明生产审查。'}));
  const hashes=wb.all('artifacts').map(a=>a.sha256);
  const review={run_id:s.rid,reviewer_id:'grok-build',performed:true,evidence:'隔离测试夹具：并非真实 Grok 审查',verdict:'passed',artifact_hashes:hashes};
  const payload=()=>({revision:wb.get('tasks',s.tid).revision,artifact_hashes:hashes,mode:'user_experience',user_checks:[true,true]});
  return {...f,...s,review,payload};
}

test('使用结果确认单独持久化，并保存实际确认文本、审查及产物版本；不代填技术 checks',()=>{
 const f=delivered(true),{wb}=f;
 try{
  const order=fs.readFileSync(f.order.path,'utf8');
  assert.match(order,/技术检查（执行者与独立 Reviewer 负责）/);assert.match(order,/我能找到项目里的任务/);
  const review=wb.review(f.review);finishCloseout(wb,f.tid);
  const t=wb.accept(f.tid,f.payload());
  assert.equal(t.status,'accepted');assert.deepEqual(t.acceptance,['真实测试通过']);
  assert.equal(t.acceptance_record.mode,'user_experience');assert.equal(t.acceptance_record.review_id,review.id);
  assert.deepEqual(t.acceptance_record.items,['我能找到项目里的任务','我能看懂下一步要做什么']);
  const audit=wb.db.prepare("SELECT data FROM audit WHERE action='accept' AND entity_id=?").get(f.tid) as any;
  assert.deepEqual(JSON.parse(audit.data),t.acceptance_record);
 }finally{wb.close()}
 const next=new Workbench(f.config);
 try{assert.equal(next.get('tasks',f.tid).acceptance_record.mode,'user_experience')}finally{next.close()}
});

test('拒绝漏勾、混用技术字段、未知模式，以及对新任务调用旧验收协议',()=>{
 const f=delivered(true),{wb}=f;try{
  wb.review(f.review);finishCloseout(wb,f.tid);
  for(const extra of [{user_checks:[true,false]},{user_checks:[true]},{user_checks:['true',true]},{checks:[true]},{mode:'anything'},{mode:undefined,user_checks:undefined,checks:[true]}]){
   assert.throws(()=>wb.accept(f.tid,{...f.payload(),...extra}));
   assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');
  }
 }finally{wb.close()}
});

test('使用结果确认仍拒绝未审查、过期版本、旧产物和随后要求修改的审查',()=>{
 const f=delivered(),{wb}=f;try{
  assert.throws(()=>wb.accept(f.tid,f.payload()),/独立 Review/);
  wb.review(f.review);finishCloseout(wb,f.tid);
  assert.throws(()=>wb.accept(f.tid,{...f.payload(),revision:1}),/版本冲突/);
  assert.throws(()=>wb.accept(f.tid,{...f.payload(),artifact_hashes:['old']}),/产物版本/);
  wb.review({...f.review,verdict:'changes_requested'});
  assert.throws(()=>wb.accept(f.tid,f.payload()),/独立 Review/);
  wb.review(f.review);finishCloseout(wb,f.tid);
  fs.appendFileSync(wb.all('artifacts')[0].archive_path,'tamper');
  assert.throws(()=>wb.accept(f.tid,f.payload()),/更改/);
 }finally{wb.close()}
});

test('旧任务使用明确的通用确认项，旧协议保留 legacy 标识而不改写成技术证据',()=>{
 const a=delivered(),b=delivered();try{
  a.wb.review(a.review);b.wb.review(b.review);finishCloseout(a.wb,a.tid);finishCloseout(b.wb,b.tid);
  assert.deepEqual(a.wb.accept(a.tid,a.payload()).acceptance_record.items,defaultUserAcceptance);
  const old=b.wb.accept(b.tid,{revision:b.wb.get('tasks',b.tid).revision,checks:[true]});
  assert.equal(old.acceptance_record.mode,'legacy_checklist');assert.equal(old.acceptance_record.items[0],'真实测试通过');
 }finally{a.wb.close();b.wb.close()}
});

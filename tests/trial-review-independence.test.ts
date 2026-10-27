import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,setup,event,finishCloseout} from './helpers.ts';
import {exportReviewOrder} from '../src/core/review-workflow.ts';
import {prepareDecision} from '../src/core/user-decisions.ts';
import {getCloseoutContext} from '../src/core/closeout.ts';

function delivered(){
 const f=fixture(),s=setup(f.wb,f.root),{wb,root}=f;
 wb.event(event(root,s.tid,s.rid,1));
 assert.equal(wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付：验证用户试用确认与审查情况独立记录，不操作真实账本。'})).disposition,'applied');
 const pass=()=>wb.review({run_id:s.rid,reviewer_id:'grok-build',performed:true,evidence:'合成测试中的审查事实，不是真实外部审查',verdict:'passed',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===s.rid&&a.current).map(a=>a.sha256)});
 const close=()=>{getCloseoutContext(wb,s.rid);finishCloseout(wb,s.tid)};
 const accept=(extra={})=>wb.accept(s.tid,{revision:wb.get('tasks',s.tid).revision,checks:[true],...extra});
 return {...f,...s,pass,close,accept};
}
test('无审查的已收尾产物可确认试用，保留未确认审查状态',()=>{const f=delivered();try{
 f.close();f.wb.managementContext.run({request_id:'synthetic-confirmation',tool:'manage_tasks',user_instruction:'准备试用确认'},()=>prepareDecision(f.wb,'accept',{run_id:f.rid,task_id:f.tid,revision:f.wb.get('tasks',f.tid).revision}));const text=f.wb.all('user_decisions')[0].details.join(' ');assert.doesNotMatch(text,/独立审查.*已完成/);assert.match(text,/审查情况另行记录/);const t=f.accept();assert.equal(t.status,'accepted');assert.equal(t.acceptance_record.review_status,'unconfirmed');assert.equal(t.acceptance_record.review_id,null);assert.equal(f.wb.all('reviews').length,0);
}finally{f.wb.close()}});
test('多人审查未裁决不阻挡试用，保留报告而不生成继续决定',()=>{const f=delivered();try{
 f.pass();for(const reviewer_id of ['zcode','claude'])exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id,expected_revision:f.wb.get('tasks',f.tid).revision,reason:'合成测试增加真实结构的多人审查成员'},{role:'user'});f.close();const t=f.accept();
 assert.equal(t.acceptance_record.review_status,'unconfirmed');assert(t.acceptance_record.review_id);assert.equal(t.acceptance_record.review_decision_id,null);assert.equal(f.wb.all('reviews').length,1);
}finally{f.wb.close()}});
test('范围变化后的旧通过报告不能成为当前有效审查，仍允许试用确认',()=>{const f=delivered();try{
 f.pass();const original=f.wb.all('reviews')[0],r=f.wb.get('runs',f.rid);r.scope_revision=1;f.wb.put('runs',r,{task_id:f.tid});f.close();const t=f.accept();
 assert.equal(t.acceptance_record.review_status,'unconfirmed');assert.equal(t.acceptance_record.review_id,null);assert.equal(t.acceptance_record.review_snapshot.observed_review_id,original.id);assert.equal(t.acceptance_record.review_snapshot.applicable,false);assert.deepEqual(f.wb.all('reviews')[0],original);
}finally{f.wb.close()}});
test('有效单人审查保留通过事实',()=>{const f=delivered();try{
 f.pass();f.close();const t=f.accept();assert.equal(t.acceptance_record.review_status,'passed');assert.equal(t.acceptance_record.review_id,f.wb.all('reviews')[0].id);
}finally{f.wb.close()}});
test('页面旧版本、未确认结果与会话代验收仍被区分',()=>{const f=delivered();try{
 f.close();assert.throws(()=>f.accept({revision:0}),/版本冲突/);assert.throws(()=>f.accept({artifact_hashes:['stale']}),/产物版本/);assert.throws(()=>f.accept({checks:[false]}),/逐项确认/);
 assert.throws(()=>f.wb.managementContext.run({request_id:'test',tool:'manage_tasks',user_instruction:'合成调用',actor:'run:test'},()=>f.accept()),/用户在工作台/);assert.equal(f.wb.get('tasks',f.tid).status,'awaiting_confirmation');
}finally{f.wb.close()}});
test('归档产物被改写不被当成用户已经试用的同一成果',()=>{const f=delivered();try{
 f.close();const a=f.wb.all('artifacts').find(a=>a.run_id===f.rid&&a.current)!;fs.writeFileSync(a.archive_path,'合成测试改写');assert.throws(()=>f.accept(),/归档产物已被更改/);
}finally{f.wb.close()}});

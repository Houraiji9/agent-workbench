import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Workbench} from '../src/core/workbench.ts';
import {ROOT} from '../src/core/config.ts';
import {seedTestData} from './fixtures.ts';
import {setup,event,finishCloseout} from './helpers.ts';
import {ensureCloseout} from '../src/core/closeout.ts';
import {exportReviewOrder,updateReviewMember,submitReviewResult,syncReviewCollaborationState,decideReviewCollaboration} from '../src/core/review-workflow.ts';
import {amendTask} from '../src/core/task-amendment.ts';

function delivered(){
 const root=path.join(ROOT,'.test-tmp','flow-1102',crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
 const wb=seedTestData(new Workbench({root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}}));
 const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));
 const send=(type:string,extra:any={})=>wb.event(event(root,s.tid,s.rid,wb.get('runs',s.rid).seq+1,type,extra));
 send('submitted',{result:'合成隔离测试交付，验证晚到活动不会回退交付及收尾状态，未访问真实项目。'});
 const close=()=>{ensureCloseout(wb,wb.get('tasks',s.tid),wb.get('runs',s.rid));finishCloseout(wb,s.tid);};
 const review=()=>exportReviewOrder(wb,{run_id:s.rid,expected_revision:wb.get('tasks',s.tid).revision,reviewer_id:'grok-build',reason:'合成测试追加独立审查',new_review:true},{role:'user'});
 return {wb,root,...s,send,close,review};
}

test('late activity preserves submitted delivery and completed closeout; explicit new delivery supersedes',()=>{
 const f=delivered(),{wb}=f;try{
 for(const phase of ['submitted','awaiting_confirmation']){
  if(phase==='awaiting_confirmation')f.close();
  const before=wb.get('runs',f.rid),revision=wb.get('tasks',f.tid).revision;
  for(const type of ['started','progress','waiting_input','blocked','failed'])assert.equal(f.send(type,{message:'合成测试晚到活动，原交付不应退回执行'}).disposition,'applied');
  assert.equal(wb.get('tasks',f.tid).status,phase);assert.equal(wb.get('tasks',f.tid).revision,revision);
  assert.equal(wb.get('runs',f.rid).status,'submitted');assert.equal(wb.get('runs',f.rid).seq,before.seq+5);
 }
 const old=wb.get('runs',f.rid).closeout.id;
 assert.equal(f.send('submitted',{result:'合成测试明确重新交付新版本，旧收尾必须保留历史并失效，不能冒充新内容完成。'}).disposition,'applied');
 assert.equal(wb.get('runs',f.rid).closeout,null);assert.equal(wb.get('runs',f.rid).closeout_history.at(-1).id,old);
 }finally{wb.close();}
});

test('same delivery review additions and removals retain completed closeout; amendment invalidates it',()=>{
 const f=delivered(),{wb}=f;try{
 f.close();const original=wb.get('runs',f.rid).closeout;
 for(const decision of ['continue','add_review']){
  decideReviewCollaboration(wb,{run_id:f.rid,expected_revision:wb.get('tasks',f.tid).revision,decision,reason:'合成测试同交付继续或追加审查'},{role:'user'});
  assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(wb.get('runs',f.rid).closeout,original);
 }
 const order=f.review();assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(wb.get('runs',f.rid).closeout,original);
 const replacement=updateReviewMember(wb,{run_id:f.rid,review_id:order.review_id,expected_revision:wb.get('tasks',f.tid).revision,action:'replace',reviewer_id:'grok-build',reason:'合成测试替换同交付审查成员'},{role:'user'});
 assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(wb.get('runs',f.rid).closeout,original);
 assert.ok('review_id' in replacement);const a=wb.get('review_assignments',replacement.review_id);
 submitReviewResult(wb,{review_id:a.id,task_id:f.tid,run_id:f.rid,review_digest:a.review_digest,verdict:'changes_requested',findings:['合成测试审查发现待改善事项'],limitations:[],evidence:['合成测试报告，未调用外部模型'],report_markdown:'合成隔离测试中的补充审查意见，保留已完成收尾事实并展示审查发现。'},'reviewer:'+a.id);
 assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(wb.get('runs',f.rid).closeout,original);
 updateReviewMember(wb,{run_id:f.rid,review_id:a.id,expected_revision:wb.get('tasks',f.tid).revision,action:'remove',reason:'合成测试取消新增审查成员'},{role:'user'});
 assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(wb.get('runs',f.rid).closeout,original);
 amendTask(wb,{task_id:f.tid,run_id:f.rid,expected_revision:wb.get('tasks',f.tid).revision,reason:'合成测试修改实际范围',changes:{scope:'合成测试更新后的任务范围'}});
 assert.equal(wb.get('runs',f.rid).closeout,null);assert.equal(wb.get('tasks',f.tid).status,'changes_requested');
 }finally{wb.close();}
});

test('late snapshot review archives after terminal state; member management cannot resurrect it',()=>{
 for(const terminal of ['accepted','cancelled']){
  const f=delivered(),{wb}=f;try{
   const order=f.review(),a=wb.get('review_assignments',order.review_id);f.close();
   if(terminal==='accepted')wb.accept(f.tid,{revision:wb.get('tasks',f.tid).revision,checks:[true]});
   else wb.manualAction(f.tid,'cancel',wb.get('tasks',f.tid).revision);
   const before=wb.get('tasks',f.tid);
   const result=submitReviewResult(wb,{review_id:a.id,task_id:f.tid,run_id:f.rid,review_digest:a.review_digest,verdict:'passed',findings:[],limitations:[],evidence:['合成测试报告，未调用外部模型'],report_markdown:'合成隔离测试中的晚到审查报告，记录原交付证据，不恢复已结束任务。'},'reviewer:'+a.id);
   assert.equal(result.review.historical,true);assert.deepEqual(wb.get('tasks',f.tid),before);
   assert.throws(()=>updateReviewMember(wb,{run_id:f.rid,review_id:a.id,expected_revision:before.revision,action:'remove',reason:'合成测试尝试修改已结束任务'},{role:'user'}),/任务已结束/);
   const t=wb.get('tasks',f.tid);syncReviewCollaborationState(wb,t,wb.get('runs',f.rid));assert.equal(t.status,terminal);
  }finally{wb.close();}
 }
});

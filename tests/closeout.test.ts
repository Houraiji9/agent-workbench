import {decideReviewCollaboration} from '../src/core/review-workflow.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event,finishCloseout,taskInput} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {exportReviewOrder,startReview,submitReviewResult,reviewFeedbackOrder} from '../src/core/review-workflow.ts';
import {getReviewContext,revokeReview} from '../src/core/review-evidence.ts';
import {getCloseoutContext,exportCloseoutOrder} from '../src/core/closeout.ts';
import {rejectAcceptance,reworkOrder} from '../src/core/acceptance-feedback.ts';
import {createBackup} from '../scripts/backup.ts';
import {restore} from '../scripts/restore.ts';

function delivered(){
  const f=fixture(),{wb,root}=f,s=setup(wb,root),file=path.join(root,'source.ts');fs.writeFileSync(file,'export const value=1;');
  wb.event(event(root,s.tid,s.rid,1));
  wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离测试真实交付，检查审查后的收尾和用户验收，保留原始报告。',review_files:[file],closeout_items:['核对实际使用入口','处理本轮临时文件']}));
  const pass=()=>wb.review({run_id:s.rid,reviewer_id:'grok-build',performed:true,evidence:'隔离测试审查记录，不是真实 Grok 审查',verdict:'passed',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===s.rid).map(a=>a.sha256)});
  const accept=()=>wb.accept(s.tid,{revision:wb.get('tasks',s.tid).revision,checks:[true]});
  const send=(type:string,extra:any={},seq?:number)=>{const r=wb.get('runs',s.rid);return wb.event(event(root,s.tid,s.rid,seq??r.seq+1,type,{closeout_id:r.closeout?.id,...extra}))};
  return {...f,...s,file,pass,accept,send};
}

test('通过审查 -> 复制收尾 -> 接单 -> 完成 -> 用户验收，复制及空事项不能提前放行',()=>{
  const f=delivered(),{wb}=f;try{
    const original=fs.readFileSync(path.join(wb.get('runs',f.rid).directory,'RESULT.md'),'utf8');f.pass();
    assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');assert.throws(f.accept,/收尾/);
    const input={run_id:f.rid,expected_revision:wb.get('tasks',f.tid).revision},a=exportCloseoutOrder(wb,input),b=exportCloseoutOrder(wb,input);
    assert.equal(a.closeout_id,b.closeout_id);assert(fs.existsSync(a.order_path));assert.match(fs.readFileSync(a.order_path,'utf8'),/file:\/\//);assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');
    assert.equal(f.send('closeout_completed',{result:'这是隔离测试完整收尾结果报告，未接单时不能直接完成。',closeout_results:[]}).disposition,'rejected');
    assert.equal(f.send('closeout_started').disposition,'applied');
    assert.equal(f.send('closeout_completed',{result:'这是隔离测试完整收尾结果报告，漏项不能被登记为完成。',closeout_results:[]}).disposition,'rejected');
    const ctx=getCloseoutContext(wb,f.rid);f.send('closeout_completed',{result:'这是隔离测试收尾结果报告，逐项核对了使用入口并清理本轮文件。',closeout_results:ctx.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试核对完成，有对应记录'}))});
    assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.equal(fs.readFileSync(path.join(wb.get('runs',f.rid).directory,'RESULT.md'),'utf8'),original);
    assert.equal(f.accept().status,'accepted');
  }finally{wb.close()}
});

test('收尾受阻、等待回答、恢复；回答只保存，复制不恢复',()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();f.send('closeout_started');f.send('closeout_blocked',{message:'目标文件正在使用，需关闭后继续'});assert.throws(f.accept,/收尾/);
    f.send('closeout_started');const q=f.send('closeout_waiting_input',{message:'需要确认本轮是否发布到 GitHub？'});
    assert.equal(wb.runFeedback(f.rid).current_question!.id,q.id);
    wb.saveReply(f.tid,{run_id:f.rid,revision:wb.get('tasks',f.tid).revision,question_event_id:q.id,message:'本次先不发布，完成其他收尾'});
    assert.equal(wb.get('tasks',f.tid).status,'closeout_waiting_input');finishCloseout(wb,f.tid);assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');
  }finally{wb.close()}
});

test('收尾回执乱序、重复、内容冲突、错误身份都沿用 Run 的严格校验',()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();const c=getCloseoutContext(wb,f.rid),done=event(f.root,f.tid,f.rid,4,'closeout_completed',{closeout_id:c.closeout.id,result:'隔离测试逐项收尾报告：乱序完成要等接单回报到达才能应用。',closeout_results:c.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'逐项检查完成的测试证据'}))});
    assert.equal(wb.event(done).disposition,'pending');assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');
    f.send('closeout_started',{},3);assert.equal(wb.event(done).disposition,'applied');assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');
    assert.throws(()=>wb.event({...done,data:{...done.data,message:'不同内容'}}),/冲突/);
    assert.throws(()=>f.send('closeout_progress',{identity:'claude'}),/身份/);
  }finally{wb.close()}
});

test('补审/改派后旧收尾失效；新的通过必须新收尾，迟到旧审查不能覆盖',()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();const old=getCloseoutContext(wb,f.rid).closeout.id;finishCloseout(wb,f.tid);
    const order=exportReviewOrder(wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:wb.get('tasks',f.tid).revision,reason:'隔离测试改派审查'},{role:'user'});
    assert.equal(f.send('closeout_started',{closeout_id:old}).disposition,'rejected');
    startReview(wb,{review_id:order.review_id,identity:'claude'});
    const result={...getReviewContext(wb,f.rid).final_response,review_id:order.review_id,verdict:'passed',findings:[],limitations:[],evidence:['隔离测试检查'],report_markdown:'这是隔离测试 Claude 审查报告，用来验证回传流转，不是生产独立审查。'};
    const submitted=submitReviewResult(wb,result,'reviewer:'+order.review_id);decideReviewCollaboration(wb,{run_id:f.rid,expected_revision:wb.get('tasks',f.tid).revision,decision:'continue',reason:'隔离测试负责人核对两份报告后继续收尾'},{role:'user'});
    assert.notEqual(getCloseoutContext(wb,f.rid).closeout.id,old);assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');
    assert.equal(f.send('closeout_started',{closeout_id:old}).disposition,'rejected');
    finishCloseout(wb,f.tid);submitReviewResult(wb,result,'reviewer:'+order.review_id);assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');
    revokeReview(wb,submitted.review.id,{run_id:f.rid,revision:wb.get('tasks',f.tid).revision,reason:'隔离测试撤回错误审查'});assert.throws(()=>submitReviewResult(wb,result,'reviewer:'+order.review_id));assert.throws(f.accept);
  }finally{wb.close()}
});

test('收尾中受审源码变化拦截完成，收尾后变化也拦截验收',()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();f.send('closeout_started');fs.appendFileSync(f.file,'//changed');
    const c=getCloseoutContext(wb,f.rid);assert.equal(f.send('closeout_completed',{result:'隔离测试收尾结果：源码已经改变，因此不能沿用审查放行。',closeout_results:c.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试证据已填写完整'}))}).disposition,'rejected');
    fs.writeFileSync(f.file,'export const value=1;');f.send('closeout_blocked',{message:'隔离测试已恢复原始受审文件'});finishCloseout(wb,f.tid);
    fs.appendFileSync(f.file,'//changed after closeout');assert.throws(f.accept,/受审文件已变化/);
  }finally{wb.close()}
});

test('取消与旧 Run 的迟到收尾不能复活任务',()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();wb.manualAction(f.tid,'cancel',wb.get('tasks',f.tid).revision);assert.equal(f.send('closeout_started').disposition,'rejected');assert.equal(wb.get('tasks',f.tid).status,'cancelled');
    wb.exportOrder(f.tid,1,true,'codex',wb.get('tasks',f.tid).revision);assert.throws(()=>f.send('closeout_started'),/旧 Run/);
  }finally{wb.close()}
});

test('用户跳过审查仍需执行者收尾，不伪造审查记录',()=>{
  const {wb,root}=fixture();try{
    const q=wb.request({project_id:'P-workbench',text:'测试：不安排独立审查，仍需要执行者收尾',skip_review:true,review_note:'用户测试明确选择不审查'}),p=wb.submitPlan({schema_version:1,plan_id:q.id,request_id:q.id,expected_version:1,tasks:[{...taskInput(root),reviewer_id:null}]});
    const tid=p.task_ids[0],r=wb.exportOrder(tid,1);wb.event(event(root,tid,r.run_id,1));wb.event(event(root,tid,r.run_id,2,'submitted',{result:'隔离测试成果：本次不安排审查，交付后仍要完成执行者收尾。'}));
    assert.equal(wb.get('tasks',tid).status,'awaiting_closeout');assert.equal(wb.all('reviews').length,0);finishCloseout(wb,tid);assert.equal(wb.accept(tid,{revision:wb.get('tasks',tid).revision,checks:[true]}).status,'accepted');
  }finally{wb.close()}
});

test('升级只迁移尚未验收的旧通过；重启不重建收尾、不修改已验收历史',()=>{
  const f=delivered(),g=delivered();f.pass();g.pass();finishCloseout(g.wb,g.tid);g.accept();
  for(const x of [f,g]){x.wb.transaction(()=>{if(x===f){const t=x.wb.get('tasks',x.tid),r=x.wb.get('runs',x.rid);t.status='in_review';delete r.closeout;x.wb.put('tasks',t,{project_id:t.project_id});x.wb.put('runs',r,{task_id:t.id})}x.wb.db.exec('DELETE FROM migrations WHERE version=9')});x.wb.close()}
  let a=new Workbench(f.config),b=new Workbench(g.config),co:string;
  try{assert.equal(a.get('tasks',f.tid).status,'awaiting_closeout');co=a.get('runs',f.rid).closeout.id;assert.equal(b.get('tasks',g.tid).status,'accepted')}finally{a.close();b.close()}
  a=new Workbench(f.config);try{assert.equal(a.get('runs',f.rid).closeout.id,co!)}finally{a.close()}
});

test('审查退回 -> 新 Run -> 再通过 -> 收尾 -> 用户拒绝 -> 再返工；每轮有独立证据',()=>{
  const f=delivered(),{wb}=f;try{
    const v=f.pass();wb.review({...v,performed:true,verdict:'changes_requested',evidence:'隔离测试发现一个必须修改的问题'});
    const order=reviewFeedbackOrder(wb,f.rid,wb.get('tasks',f.tid).revision);assert('run_id' in order);assert.notEqual(order.run_id,f.rid);const again=reviewFeedbackOrder(wb,f.rid,0);assert('run_id' in again);assert.equal(again.run_id,order.run_id);assert.equal(wb.get('runs',order.run_id).retry_context.reviews.length,2);
    wb.event(event(f.root,f.tid,order.run_id,1));wb.event(event(f.root,f.tid,order.run_id,2,'submitted',{result:'隔离测试第二轮已修复，实际交付新版本并等待重新审查和收尾。'}));
    wb.review({run_id:order.run_id,reviewer_id:'grok-build',performed:true,evidence:'隔离测试第二轮独立审查记录',verdict:'passed',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===order.run_id).map(a=>a.sha256)});finishCloseout(wb,f.tid);
    const feedback=rejectAcceptance(wb,f.tid,{run_id:order.run_id,revision:wb.get('tasks',f.tid).revision,note:'用户测试结果仍不符合需求',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===order.run_id).map(a=>a.sha256)});
    const next=reworkOrder(wb,f.tid,{revision:feedback.task.revision,feedback_id:feedback.feedback.id});assert.equal(wb.get('runs',next.run_id).seq,0);assert.equal(wb.get('runs',f.rid).status,'submitted');assert.equal(wb.get('runs',order.run_id).closeout.status,'completed');
  }finally{wb.close()}
});

test('收尾报告及命令随备份恢复到新位置，原执行包移走后仍可核对与验收',async()=>{
  const f=delivered(),{wb}=f;try{
    f.pass();exportCloseoutOrder(wb,{run_id:f.rid,expected_revision:wb.get('tasks',f.tid).revision});finishCloseout(wb,f.tid);
    const saved=await createBackup(wb),target=path.join(f.root,'restored-closeout');restore(saved.path,target);
    const original=wb.get('runs',f.rid).directory;fs.renameSync(original,original+'-moved');
    const other=new Workbench({...f.config,dataDir:target});try{
      const r=other.get('runs',f.rid);assert(r.closeout.report_path.startsWith(target));assert(fs.existsSync(r.closeout.report_path));
      const order=exportCloseoutOrder(other,{run_id:f.rid,expected_revision:other.get('tasks',f.tid).revision});assert(!fs.readFileSync(order.order_path,'utf8').includes(original));
      assert.equal(other.accept(f.tid,{revision:other.get('tasks',f.tid).revision,checks:[true]}).status,'accepted');
    }finally{other.close()}
  }finally{wb.close()}
});

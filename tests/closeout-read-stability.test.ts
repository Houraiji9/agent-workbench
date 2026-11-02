import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,setup,event} from './helpers.ts';
import {getCloseoutContext,assertCloseoutComplete,invalidateCloseout} from '../src/core/closeout.ts';
import {amendTask} from '../src/core/task-amendment.ts';
import {finishRunCloseout} from '../src/core/execution-context.ts';
import {exportReviewOrder} from '../src/core/review-workflow.ts';

function delivered(){const f=fixture(),s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'合成隔离交付，只验证收尾查询和晚到事件不修改真实用户任务。'}));return {...f,...s};}
function records(f:ReturnType<typeof delivered>){return {task:f.wb.get('tasks',f.tid),run:f.wb.get('runs',f.rid),events:f.wb.all('events'),reviews:f.wb.all('reviews')};}
function finish(f:ReturnType<typeof delivered>){const c=getCloseoutContext(f.wb,f.rid),input={run_id:f.rid,event_id:'synthetic-closeout',result:'合成测试逐项收尾已完成，后续审查与补充说明只记录事实，用户未验收。',closeout_results:c.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'本项仅为合成隔离回归验证'}))};return {input,result:finishRunCloseout(f.wb,input)};}

test('范围变更和同交付重新收尾使用独立报告，预览稳定且历史字节不被覆盖',()=>{const f=delivered();try{
 finish(f);const first=f.wb.get('runs',f.rid).closeout,bytes=fs.readFileSync(first.report_path);
 amendTask(f.wb,{task_id:f.tid,run_id:f.rid,expected_revision:f.wb.get('tasks',f.tid).revision,reason:'合成测试补充实际范围，保留第一版收尾证据',changes:{scope:'合成测试第二版范围'}});
 const preview=getCloseoutContext(f.wb,f.rid);assert.notEqual(preview.closeout.id,first.id);assert.equal(getCloseoutContext(f.wb,f.rid).closeout.id,preview.closeout.id);
 finishRunCloseout(f.wb,{run_id:f.rid,event_id:'synthetic-closeout-scope',result:'合成测试第二版范围已处理完成，本次报告必须独立保存，不得覆盖第一版报告。',closeout_results:[]});
 const second=f.wb.get('runs',f.rid).closeout;assert.equal(second.id,preview.closeout.id);assert.notEqual(second.report_path,first.report_path);assert.deepEqual(fs.readFileSync(first.report_path),bytes);
 const secondBytes=fs.readFileSync(second.report_path);invalidateCloseout(f.wb,f.wb.get('runs',f.rid),'合成测试明确重开同一交付');
 const reopened=getCloseoutContext(f.wb,f.rid);assert.notEqual(reopened.closeout.id,second.id);
 finishRunCloseout(f.wb,{run_id:f.rid,event_id:'synthetic-closeout-reopened',result:'合成测试同一交付明确重开后再次收尾，仍应保留之前两份报告及其真实字节。',closeout_results:[]});
 const last=f.wb.get('runs',f.rid);assert.equal(last.closeout.id,reopened.closeout.id);assert.equal(last.closeout.delivery_digest,second.delivery_digest);assert(last.closeout_history.some((c:any)=>c.id===first.id&&c.report_sha256===first.report_sha256));assert.deepEqual(fs.readFileSync(first.report_path),bytes);assert.deepEqual(fs.readFileSync(second.report_path),secondBytes);
}finally{f.wb.close();}});

test('收尾查询仅返回可提交预览，终态及缺交付读取均不修改记录',()=>{const f=delivered();try{
 const before=records(f),one=getCloseoutContext(f.wb,f.rid),two=getCloseoutContext(f.wb,f.rid);
 assert(one.closeout_preview);assert.equal(one.closeout.id,two.closeout.id);assert.deepEqual(records(f),before);
 for(const status of ['accepted','cancelled']){const t=f.wb.get('tasks',f.tid);t.status=status;f.wb.put('tasks',t,{project_id:t.project_id});const snapshot=records(f);assert.equal(getCloseoutContext(f.wb,f.rid).closeout,null);assert.deepEqual(records(f),snapshot);}
 const other=setup(f.wb,f.root),snapshot=f.wb.get('tasks',other.tid),run=f.wb.get('runs',other.rid);assert.equal(getCloseoutContext(f.wb,other.rid).closeout,null);assert.deepEqual(f.wb.get('tasks',other.tid),snapshot);assert.deepEqual(f.wb.get('runs',other.rid),run);
}finally{f.wb.close();}});

test('收尾完成后补审、查询及相同完成请求重放保留原结果和用户确认入口',()=>{const f=delivered();try{
 const completed=finish(f);assert.equal(completed.result.disposition,'applied');const original=f.wb.get('runs',f.rid).closeout;
 exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:f.wb.get('tasks',f.tid).revision,reason:'合成测试同交付追加审查不重复收尾'},{role:'user'});
 const before=records(f),ctx=getCloseoutContext(f.wb,f.rid);assert(ctx.review_binding_changed||ctx.closeout.id===original.id);assert.equal(ctx.closeout.status,'completed');assert.deepEqual(records(f),before);
 assert.equal(finishRunCloseout(f.wb,completed.input).disposition,'applied');assert.deepEqual(records(f),before);
 assert.equal(f.wb.get('runs',f.rid).closeout.report_sha256,original.report_sha256);assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.wb.get('tasks',f.tid),f.wb.get('runs',f.rid)));
}finally{f.wb.close();}});

test('晚到收尾进展及另一完成事件保留正式收尾字节并消费真实回报序号',()=>{const f=delivered();try{
 finish(f);const original=f.wb.get('runs',f.rid).closeout,bytes=fs.readFileSync(original.report_path);
 for(const type of ['closeout_started','closeout_progress','closeout_blocked','closeout_waiting_input','closeout_completed']){const r=f.wb.get('runs',f.rid),result=f.wb.event(event(f.root,f.tid,f.rid,r.seq+1,type,{closeout_id:original.id,message:'合成迟到收尾回报，应记录但不倒退状态',result:'合成迟到的另一报告，不应覆盖已经完成的正式收尾和原始字节。',closeout_results:[]}));assert.equal(result.disposition,'applied');assert.equal(f.wb.get('runs',f.rid).seq,r.seq+1);assert.equal(f.wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.deepEqual(f.wb.get('runs',f.rid).closeout,original);assert.deepEqual(fs.readFileSync(original.report_path),bytes);}
}finally{f.wb.close();}});

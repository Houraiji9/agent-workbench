import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fixture,setup,event} from './helpers.ts';
import {getReviewContext,submitGrokReview,verifyGrokTrace,revokeReview,type GrokTrace} from '../src/core/review-evidence.ts';
import {createApp} from '../src/server/app.ts';

function delivered(){const f=fixture(),s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付，验证审查会话归属。此结果不代表实际模型执行。'}));return {...f,...s}}
function traceFor(context:ReturnType<typeof getReviewContext>,sid:string,extra:any={}):GrokTrace{
  return {summary:{info:{id:sid,cwd:context.cwd},current_model_id:'grok-test-fixture',request_id:'test-request'},
    history:[{type:'user',content:'隔离测试'},{type:'assistant',model_id:'grok-test-fixture',content:JSON.stringify({task_id:context.task_id,run_id:context.run_id,review_digest:context.review_digest,verdict:'passed',findings:[],limitations:['只用于测试，不是真实 Grok 审查'],...extra})}],
    updates:[{timestamp:Date.now()/1000,params:{sessionId:sid,update:{sessionUpdate:'turn_completed',stop_reason:'end_turn',prompt_id:'test-request'}}}]};
}

test('真实来源适配后的审查绑定本次成果，幂等登记只进入待用户确认',async()=>{
 const f=delivered(),sid=crypto.randomUUID();try{
  const c=getReviewContext(f.wb,f.rid),trace=traceFor(c,sid);
  const r=await submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'test_fixture',async()=>trace);
  assert.equal(r.source,'grok_session_import');assert.equal(r.independently_verified,true);assert.equal(r.recorded_by,'test_fixture');
  assert.equal(f.wb.get('tasks',f.tid).status,'in_review');assert.equal(f.wb.get('tasks',f.tid).acceptance_record,undefined);
  const revision=f.wb.get('tasks',f.tid).revision;
  assert.equal((await submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'test_fixture',async()=>trace)).id,r.id);
  assert.equal(f.wb.get('tasks',f.tid).revision,revision);assert.equal(f.wb.all('reviews').length,1);
 }finally{f.wb.close()}
});
test('错误任务、旧版本、伪造身份、失败及未完成会话都不能推进审查',async()=>{
 const f=delivered(),sid=crypto.randomUUID();try{
  const c=getReviewContext(f.wb,f.rid);
  const mutations=[
    (t:GrokTrace)=>{t.summary.info.id=crypto.randomUUID()},
    (t:GrokTrace)=>{t.summary.info.cwd=f.config.dataDir+'-outside'},
    (t:GrokTrace)=>{t.history.at(-1)!.model_id='author-model'},
    (t:GrokTrace)=>{t.history.at(-1)!.type='user'},
    (t:GrokTrace)=>{t.history.push({type:'user',content:'继续执行'})},
    (t:GrokTrace)=>{t.updates.at(-1)!.params.update.stop_reason='cancelled'},
    (t:GrokTrace)=>{t.updates.push({params:{update:{sessionUpdate:'agent_message_chunk'}}})},
    (t:GrokTrace)=>{t.summary.request_id='other-request'},
  ];
  for(const mutate of mutations){const trace=traceFor(c,sid);mutate(trace);await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace))}
  for(const extra of [{task_id:'T-other'},{run_id:'R-other'},{review_digest:'0'.repeat(64)},{verdict:'accepted'},{arbitrary:'not allowed'}]){
    await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>traceFor(c,sid,extra)));
  }
  assert.equal(f.wb.all('reviews').length,0);assert.equal(f.wb.get('tasks',f.tid).status,'submitted');
 }finally{f.wb.close()}
});
test('作者不能在回传参数里夹带通过结论或自选证据文件',async()=>{
 const f=delivered();try{for(const extra of [{verdict:'passed'},{trace_path:'fake.json'},{reviewer_id:'grok-build'}])await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:crypto.randomUUID(),...extra},'fixture',async()=>{throw Error('不应读取')}))}finally{f.wb.close()}
});
test('核验期间的任务竞争及归档篡改均拒绝',async()=>{
 const f=delivered(),sid=crypto.randomUUID();try{
  const c=getReviewContext(f.wb,f.rid);
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>{const t=f.wb.get('tasks',f.tid);t.revision++;f.wb.put('tasks',t,{project_id:t.project_id});return traceFor(c,sid)}),/核验期间/);
  fs.appendFileSync(f.wb.all('artifacts')[0].archive_path,'tampered');assert.throws(()=>getReviewContext(f.wb,f.rid),/变化/);
  assert.equal(f.wb.all('reviews').length,0);
 }finally{f.wb.close()}
});
test('变化请求保留具体问题与限制，不能冒充 passed',async()=>{
 const f=delivered(),sid=crypto.randomUUID();try{const c=getReviewContext(f.wb,f.rid);const r=await submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>traceFor(c,sid,{verdict:'changes_requested',findings:['修复错误任务归属']}));assert.equal(r.findings,'修复错误任务归属');assert.equal(f.wb.get('tasks',f.tid).status,'changes_requested')}finally{f.wb.close()}
});
test('手工误贴完整编号或缩写路径时拒绝；正确归属仍可登记',()=>{
 const f=delivered();try{
  const v={run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',artifact_hashes:f.wb.all('artifacts').map(a=>a.sha256)};
  for(const evidence of ['报告 T-2b9482af-... / R-78eeeefc-... 确认通过','报告 T-'+crypto.randomUUID()+' 通过','报告 R-'+crypto.randomUUID()+' 通过'])assert.throws(()=>f.wb.review({...v,evidence}),/其他任务/);
  assert.equal(f.wb.all('reviews').length,0);
  f.wb.review({...v,task_id:f.tid,revision:f.wb.get('tasks',f.tid).revision,evidence:`测试夹具 ${f.tid} / ${f.rid} 确认归属`});
 }finally{f.wb.close()}
});
test('撤回保留原记录、审计和原因，不重新启用更早的通过记录；用户验收不可改写',()=>{
 const f=delivered();try{
  const v={run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',evidence:'隔离测试，手工声明而非真实审查',artifact_hashes:f.wb.all('artifacts').map(a=>a.sha256)};
  f.wb.review(v);const r=f.wb.review(v),payload=()=>({run_id:f.rid,revision:f.wb.get('tasks',f.tid).revision,reason:'误贴其他任务报告'});
  assert.throws(()=>revokeReview(f.wb,r.id,{...payload(),revision:0}),/版本/);
  revokeReview(f.wb,r.id,payload());assert.equal(f.wb.all('reviews').length,2);assert.ok(f.wb.get('reviews',r.id).revoked_at);assert.equal(f.wb.get('reviews',r.id).verdict,'passed');
  assert.equal(f.wb.get('tasks',f.tid).status,'submitted');assert.throws(()=>f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]}));
  const replacement=f.wb.review(v);f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]});
  assert.throws(()=>revokeReview(f.wb,replacement.id,payload()),/历史记录/);
 }finally{f.wb.close()}
});
test('已撤回的 Grok 请求不能重放恢复通过；更早记录撤回不影响较新的结论',async()=>{
 const f=delivered(),sid=crypto.randomUUID();try{
  const c=getReviewContext(f.wb,f.rid),trace=traceFor(c,sid),r=await submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace);
  const later=f.wb.review({run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',evidence:'隔离测试补审发现问题，仍需修改',artifact_hashes:c.artifacts.map(a=>a.sha256)});
  revokeReview(f.wb,r.id,{run_id:f.rid,revision:f.wb.get('tasks',f.tid).revision,reason:'测试：撤回较早的审查'});
  assert.equal(f.wb.get('tasks',f.tid).status,'changes_requested');assert.ok(later);
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace),/失效/);
 }finally{f.wb.close()}
});
test('HTTP：Run 限域与人工撤回边界，planner 仅能导入经 Grok 来源核验的结论',async()=>{
 const f=delivered(),sid=crypto.randomUUID(),c=getReviewContext(f.wb,f.rid);f.wb.close();
 const {app,wb}=await createApp(f.config,{background:false,grokTraceReader:async()=>traceFor(c,sid)});
 try{
  const token=JSON.parse(fs.readFileSync(f.config.dataDir+'/run-keys/'+f.rid+'.json','utf8')).token;
  const post=(tool:string,payload:any,auth=token)=>app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:14317',authorization:'Bearer '+auth},payload});
  assert.equal((await post('get_review_context',{run_id:f.rid})).statusCode,200);
  const other=setup(wb,f.root);
  assert.equal((await post('get_review_context',{run_id:other.rid})).statusCode,401);
  assert.equal((await post('revoke_review',{run_id:f.rid})).statusCode,403);
  assert.equal((await post('submit_grok_review',{run_id:f.rid,session_id:sid,verdict:'passed'})).statusCode,400);
  const res=await post('submit_grok_review',{run_id:f.rid,session_id:sid},wb.keys.planner);assert.equal(res.statusCode,200,res.body);
  assert.equal(wb.get('tasks',f.tid).status,'in_review');assert.equal(wb.get('tasks',f.tid).acceptance_record,undefined);
  assert.equal((await post('accept',{run_id:f.rid},wb.keys.planner)).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/reviews/'+res.json().id+'/revoke',headers:{host:'127.0.0.1:14317'},payload:{}})).statusCode,401);
 }finally{await app.close()}
});

test('较早完成的跨会话通过不能覆盖后来的修改要求；无完成时间拒绝',async()=>{
 const f=delivered();try{
  const c=getReviewContext(f.wb,f.rid),base=Date.now(),badId=crypto.randomUUID(),oldId=crypto.randomUUID();
  const newer=traceFor(c,badId,{verdict:'changes_requested',findings:['仍有缺陷']}),older=traceFor(c,oldId);
  newer.updates[0].timestamp=(base-1000)/1000;older.updates[0].timestamp=base-2000;
  await submitGrokReview(f.wb,{run_id:f.rid,session_id:badId},'fixture',async()=>newer);
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:oldId},'fixture',async()=>older),/早于/);
  assert.equal(f.wb.get('tasks',f.tid).status,'changes_requested');
  assert.throws(()=>f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]}));
  for(const timestamp of [undefined,null,'invalid',Infinity,base+600000]){
   const trace=traceFor(c,oldId);trace.updates[0].timestamp=timestamp;
   await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:oldId},'fixture',async()=>trace),/完成时间/);
  }
  older.updates[0].timestamp=base-500;
  await submitGrokReview(f.wb,{run_id:f.rid,session_id:oldId},'fixture',async()=>older);
  assert.equal(f.wb.get('tasks',f.tid).status,'in_review');
 }finally{f.wb.close()}
});

test('重试拒绝同请求改结论和旧通过；撤回后不能导入事先留存的通过',async()=>{
 const f=delivered();try{
  const c=getReviewContext(f.wb,f.rid),sid=crypto.randomUUID(),trace=traceFor(c,sid);
  const r=await submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace);
  const edited=structuredClone(trace);edited.history.at(-1)!.content=JSON.stringify({...JSON.parse(edited.history.at(-1)!.content),limitations:['改写结论']});
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>edited),/结论发生变化/);
  const later=f.wb.review({run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',evidence:'测试：最新人工复核要求修改',artifact_hashes:c.artifacts.map(a=>a.sha256)});
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace),/更新的审查/);
  revokeReview(f.wb,later.id,{run_id:f.rid,revision:f.wb.get('tasks',f.tid).revision,reason:'测试撤回，不启用旧通过'});
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid},'fixture',async()=>trace),/撤回操作/);
  const sid2=crypto.randomUUID(),old=traceFor(c,sid2);old.updates[0].timestamp=Date.now()-1000;
  await assert.rejects(submitGrokReview(f.wb,{run_id:f.rid,session_id:sid2},'fixture',async()=>old),/早于/);
  assert.equal(f.wb.get('tasks',f.tid).status,'submitted');assert.ok(r);
 }finally{f.wb.close()}
});

test('撤回按审查时间排序而不是插入顺序，旧通过不能恢复验收',()=>{
 const f=delivered();try{
  const v={run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',evidence:'隔离测试的人工审查记录',artifact_hashes:f.wb.all('artifacts').map(a=>a.sha256)};
  const first=f.wb.review(v),last=f.wb.review(v);
  first.created_at='2026-01-02T00:00:00.000Z';last.created_at='2026-01-01T00:00:00.000Z';
  f.wb.put('reviews',first,{run_id:f.rid});f.wb.put('reviews',last,{run_id:f.rid});
  revokeReview(f.wb,first.id,{run_id:f.rid,revision:f.wb.get('tasks',f.tid).revision,reason:'撤回时间最新但先插入的通过'});
  assert.equal(f.wb.get('tasks',f.tid).status,'submitted');
  assert.throws(()=>f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]}));
 }finally{f.wb.close()}
});

test('手工登记复核归档字节，验收拒绝根目录外同内容路径，并保留用户勾选',()=>{
 const f=delivered();try{
  const a=f.wb.all('artifacts')[0],bytes=fs.readFileSync(a.archive_path),v={run_id:f.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',evidence:'隔离测试，验证文件实际版本',artifact_hashes:[a.sha256]};
  fs.appendFileSync(a.archive_path,'changed');assert.throws(()=>f.wb.review(v),/变化/);assert.equal(f.wb.all('reviews').length,0);
  fs.writeFileSync(a.archive_path,bytes);f.wb.review(v);
  const original=a.archive_path;a.archive_path=f.root+'/outside-artifacts.txt';fs.writeFileSync(a.archive_path,bytes);f.wb.put('artifacts',a,{run_id:f.rid});
  assert.throws(()=>f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]}),/授权根目录/);
  a.archive_path=original;f.wb.put('artifacts',a,{run_id:f.rid});
  const accepted=f.wb.accept(f.tid,{revision:f.wb.get('tasks',f.tid).revision,checks:[true]});
  assert.deepEqual(accepted.acceptance_record.checks,[true]);
 }finally{f.wb.close()}
});

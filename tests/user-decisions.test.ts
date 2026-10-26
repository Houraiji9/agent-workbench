import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event,finishCloseout} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {Workbench} from '../src/core/workbench.ts';
import {manage,readManagement} from '../src/core/management.ts';
import {exportReviewOrder,startReview,submitReviewResult} from '../src/core/review-workflow.ts';
import {resolveDecision} from '../src/core/user-decisions.ts';
const input=(change:any)=>({request_id:crypto.randomUUID(),user_instruction:'隔离测试：用户原话不是授权凭据。',change});
function reviewed(wb:Workbench,root:string,verdict='changes_requested'){
  const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));const delivered=wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离安全回归交付：实际用于验证管理权限和用户确认的完整生命周期，不作为真实生产审查。'}));assert.equal(delivered.disposition,'applied',delivered.error);
  const a=exportReviewOrder(wb,{run_id:s.rid,reviewer_id:'claude',expected_revision:wb.get('tasks',s.tid).revision,reason:'隔离测试独立审查'},{role:'planner'});
  startReview(wb,{review_id:a.review_id,identity:'claude'});
  const report={...a.context.final_response,review_id:a.review_id,verdict,findings:verdict==='passed'?[]:['隔离缺陷须修复'],limitations:['测试夹具'],evidence:['隔离回归实际执行'],report_markdown:'隔离回归的独立审查测试报告，专用于验证权限边界。'};
  const review=submitReviewResult(wb,report,'reviewer:'+a.review_id).review;
  return {...s,a,report,review};
}
test('Claude复现反向回归 HTTP：manager 不能伪造通过、导入报告、代验收或自动撤回结论',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
  try{
    const s=reviewed(wb,f.root),before=wb.get('tasks',s.tid),original=JSON.stringify(wb.get('reviews',s.review.id));
    const headers={host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+wb.keys.manager};
    const post=(name:string,body:any)=>app.inject({method:'POST',url:'/api/mcp/'+name,headers,payload:body});
    const record={action:'record',run_id:s.rid,task_id:s.tid,revision:before.revision,reviewer_id:'claude',performed:true,verdict:'passed',evidence:'作者自行填写的隔离伪造报告',artifact_hashes:s.review.artifact_hashes};
    for(const [tool,change] of [['manage_reviews',record],['manage_reviews',{action:'import_result',data:{...s.report,verdict:'passed'}}],['import_grok_review_for_user',{run_id:s.rid,session_id:'fake'}]] as const){
      const r=await post(tool,input(change));assert.equal(r.statusCode,403,r.body);
    }
    assert.equal((await post('manage_tasks',input({action:'accept',task_id:s.tid,run_id:s.rid,revision:before.revision}))).statusCode,409);
    const assign=input({action:'assign',data:{run_id:s.rid,reviewer_id:'zcode',expected_revision:before.revision,reason:'当前会话直接安排独立复审'}});
    const proposal=await post('manage_reviews',assign);assert.equal(proposal.statusCode,200,proposal.body);assert.equal(proposal.json().status,'completed');
    assert.deepEqual((await post('manage_reviews',assign)).json(),proposal.json());
    assert.equal(JSON.stringify(wb.get('reviews',s.review.id)),original);assert(wb.get('tasks',s.tid).revision>before.revision);
    assert(wb.all('review_assignments').some(a=>a.run_id===s.rid&&a.reviewer_id==='zcode'));
    const accepted=reviewed(wb,f.root,'passed');finishCloseout(wb,accepted.tid);
    const acceptance=input({action:'accept',task_id:accepted.tid,run_id:accepted.rid,revision:wb.get('tasks',accepted.tid).revision});
    const pending=await post('manage_tasks',acceptance);assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().status,'awaiting_user_confirmation');
    const decisionId=pending.json().result.decision_id,url='/api/user-decisions/'+decisionId+'/confirm';
    assert.equal((await app.inject({method:'POST',url,headers,payload:{}})).statusCode,401);
    const boot=await app.inject({url:'/api/bootstrap',headers:{host:headers.host}}),page={host:headers.host,cookie:String(boot.headers['set-cookie']).split(';')[0]};
    assert.equal((await app.inject({method:'POST',url,headers:page,payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url,headers:{...page,'x-workbench-csrf':boot.json().csrf,authorization:headers.authorization},payload:{}})).statusCode,403);
    assert.equal((await post('confirm_user_decision',{decision_id:decisionId})).statusCode,403);
    const confirmed=await app.inject({method:'POST',url,headers:{...page,'x-workbench-csrf':boot.json().csrf},payload:{}});assert.equal(confirmed.statusCode,200,confirmed.body);
    assert.equal(confirmed.json().status,'confirmed');assert.equal(wb.get('tasks',accepted.tid).status,'accepted');
    assert.equal(JSON.stringify(wb.get('reviews',s.review.id)),original);
    assert.equal((await post('manage_tasks',acceptance)).json().status,'confirmed');
    const audits=wb.db.prepare("SELECT actor,data FROM audit WHERE action='confirm_user_decision'").all() as any[];
    assert.equal(audits.length,1);assert.equal(audits[0].actor,'user');assert.equal(JSON.parse(audits[0].data).request_id,acceptance.request_id);
  }finally{await app.close()}
});
test('验收提案：收尾前拒绝；重启持久化；重复确认一次；用户确认才解锁',async()=>{
  const f=fixture();let wb=f.wb;try{
    const s=reviewed(wb,f.root,'passed');
    const accept=()=>input({action:'accept',task_id:s.tid,run_id:s.rid,revision:wb.get('tasks',s.tid).revision});
    await assert.rejects(manage(wb,{} as any,'manage_tasks',accept()),/收尾/);
    finishCloseout(wb,s.tid);const body=accept(),proposal=await manage(wb,{} as any,'manage_tasks',body),did=proposal.result.decision_id;
    assert.equal(wb.get('tasks',s.tid).status,'awaiting_confirmation');
    wb.close();wb=new Workbench(f.config);
    assert.equal((await manage(wb,{} as any,'manage_tasks',body)).status,'awaiting_user_confirmation');
    const [one,two]=await Promise.all([Promise.resolve().then(()=>resolveDecision(wb,did,'confirm')),Promise.resolve().then(()=>resolveDecision(wb,did,'confirm'))]);
    assert.deepEqual(one,two);assert.equal(wb.get('tasks',s.tid).status,'accepted');
    assert.equal((wb.db.prepare("SELECT count(*) n FROM audit WHERE action='accept'").get() as any).n,1);
    const read:any=await readManagement(wb,{} as any,'get_management_result',{request_id:body.request_id});assert.equal(read.status,'confirmed');
    assert.equal(read.result.outcome.acceptance_record.mode,'user_experience');
  }finally{wb.close()}
});
test('过期、取消、替换、版本变化、新Run、产物变化和旧权限缓存均不推进任务',async()=>{
  const f=fixture(),wb=f.wb;try{
    const s=reviewed(wb,f.root,'passed'),before=JSON.stringify(wb.get('reviews',s.review.id));finishCloseout(wb,s.tid);
    const body=()=>input({action:'accept',run_id:s.rid,task_id:s.tid,revision:wb.get('tasks',s.tid).revision});
    const proposal=async()=>{const b=body(),r=await manage(wb,{} as any,'manage_tasks',b);return {b,id:r.result.decision_id}};
    let p=await proposal();let d=wb.get('user_decisions',p.id);wb.put('user_decisions',{...d,expires_at:new Date(Date.now()-1).toISOString()});
    assert.throws(()=>resolveDecision(wb,p.id,'confirm'),/过期/);assert.equal((await manage(wb,{} as any,'manage_tasks',p.b)).status,'expired');
    p=await proposal();assert.equal(resolveDecision(wb,p.id,'cancel').status,'cancelled');assert.throws(()=>resolveDecision(wb,p.id,'confirm'),/已处理/);
    p=await proposal();const next=await proposal();assert.equal((await manage(wb,{} as any,'manage_tasks',p.b)).status,'superseded');
    const task=wb.get('tasks',s.tid);wb.put('tasks',{...task,revision:task.revision+1},{project_id:task.project_id});assert.throws(()=>resolveDecision(wb,next.id,'confirm'),/变化/);
    p=await proposal();const newer=wb.exportOrder(s.tid,task.version,true,'codex',task.revision+1);assert.notEqual(newer.run_id,s.rid);assert.throws(()=>resolveDecision(wb,p.id,'confirm'),/变化/);
    assert.equal(JSON.stringify(wb.get('reviews',s.review.id)),before);
    const a=reviewed(wb,f.root,'passed');finishCloseout(wb,a.tid);
    const ab=input({action:'accept',task_id:a.tid,run_id:a.rid,revision:wb.get('tasks',a.tid).revision});const ap=await manage(wb,{} as any,'manage_tasks',ab);
    const artifact=wb.all('artifacts').find(x=>x.run_id===a.rid)!;fs.appendFileSync(artifact.archive_path,'tamper');
    assert.throws(()=>resolveDecision(wb,ap.result.decision_id,'confirm'),/更改/);assert.equal(wb.get('tasks',a.tid).status,'awaiting_confirmation');
    const old=wb.get('management_calls',ab.request_id);delete old.policy_version;wb.put('management_calls',old);await assert.rejects(manage(wb,{} as any,'manage_tasks',ab),/旧权限/);
  }finally{wb.close()}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fixture,setup,event} from './agent-routing-fixture.ts';import {createApp} from '../src/server/app.ts';
import {openReviewHandoff,claimReviewHandoff,handoffCredentialPath} from '../src/core/open-review-handoff.ts';
import {reviewCollaboration,reviewAssignmentContext,exportReviewOrder} from '../src/core/review-workflow.ts';
import {reviewContext} from '../src/core/review-context.ts';
function delivered(wb:any,root:string){const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));assert.equal(wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离开放式审查交接测试，产物仅为合成数据，不代表生产验收。'})).disposition,'applied');return s;}
test('one handoff has no assigned recipient; arbitrary real receivers claim separately without models, retries reuse records',()=>{
 const {wb,root}=fixture();try{const s=delivered(wb,root);const t=wb.get('tasks',s.tid);t.reviewer_id=null;wb.put('tasks',t,{project_id:t.project_id});const h=openReviewHandoff(wb,s.rid);assert.equal(wb.runRows('review_assignments',s.rid).length,0);assert.equal(openReviewHandoff(wb,s.rid).handoff_id,h.handoff_id);assert.doesNotMatch(h.entry,/审查者：|grok|claude/i);
 const first=claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'Claude'}),second=claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'实际外部审查者'});assert.notEqual(first.review_id,second.review_id);assert.equal(first.reviewer_id,'claude');assert.equal(claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'Claude'}).review_id,first.review_id);
 const c=reviewContext(wb,{review_id:first.review_id,mode:'full'},reviewAssignmentContext(wb,first.review_id));assert.equal(c.context.requested_model,null);assert.equal(c.context.model_selection,null);assert.equal(reviewCollaboration(wb,s.rid).counts.running,2);assert.throws(()=>claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'Codex'}),/独立/);
 const third=claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'Claude',session_id:'another-real-session'});assert.notEqual(third.review_id,first.review_id);assert.equal(claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'Claude',session_id:'another-real-session'}).review_id,third.review_id);assert.equal(reviewCollaboration(wb,s.rid).counts.running,3);
 }finally{wb.close();}
});
test('handoff credential only reads and claims; reviewer can dispatch a peer and query its call, never impersonate peer report or cross runs',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});try{const s=delivered(wb,f.root),h=openReviewHandoff(wb,s.rid),hand=JSON.parse(fs.readFileSync(handoffCredentialPath(wb,h.handoff_id),'utf8')).token;
 const call=async(tool:string,token:string,payload:any)=>{const r=await app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+token},payload});return {status:r.statusCode,body:r.json()};};
 assert.equal((await call('get_open_review_context',hand,{handoff_id:h.handoff_id})).status,200);assert.equal((await call('submit_review_report',hand,{handoff_id:h.handoff_id})).status,403);
 const claimed=await call('claim_review_handoff',hand,{handoff_id:h.handoff_id,identity:'claude'});assert.equal(claimed.status,200,JSON.stringify(claimed));const ra=claimed.body.review_id,token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',ra+'.json'),'utf8')).token;
 const peer=claimReviewHandoff(wb,{handoff_id:h.handoff_id,identity:'grok-build'});const a=wb.get('review_assignments',peer.review_id);a.status='awaiting_dispatch';wb.put('review_assignments',a,{run_id:s.rid});
 // Background launcher is disabled: dispatch creates a recorded job but starts no real CLI.
 const dispatched=await call('dispatch_review',token,{review_id:ra,target_review_id:peer.review_id,request_id:crypto.randomUUID(),expected_revision:wb.get('tasks',s.tid).revision});assert.equal(dispatched.status,200,JSON.stringify(dispatched));const job=dispatched.body;assert.equal(job.review_id,peer.review_id);assert.equal(wb.get('agent_jobs',job.job_id).status,'queued');
 assert.equal((await call('get_agent_job',token,{review_id:ra,job_id:job.job_id})).status,200);assert.equal((await call('submit_review_report',token,{review_id:peer.review_id,verdict:'passed'})).status,401);
 const other=delivered(wb,f.root),otherOrder=exportReviewOrder(wb,{run_id:other.rid,reviewer_id:'grok-build',expected_revision:wb.get('tasks',other.tid).revision,reason:'隔离跨执行检查'},{role:'user'});
 assert.equal((await call('dispatch_review',token,{review_id:ra,target_review_id:otherOrder.review_id,request_id:crypto.randomUUID(),expected_revision:wb.get('tasks',s.tid).revision})).status,403);
 }finally{await app.close();}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fixture,setup,event} from './helpers.ts';
import {exportReviewOrder,reviewAssignmentContext,isRecoveredReviewJob} from '../src/core/review-workflow.ts';
import {recoverNativeReview} from '../src/core/native-review-recovery.ts';
function prepared(){
 const f=fixture(),t=setup(f.wb,f.root);f.wb.event(event(f.root,t.tid,t.rid,1));f.wb.event(event(f.root,t.tid,t.rid,2,'submitted',{result:'本隔离测试只检查真实调用报告登记规则，不调用真实模型或访问生产账本。'}));
 const a=exportReviewOrder(f.wb,{run_id:t.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',t.tid).revision,reason:'合成原生补登记验证'},{role:'runner',id:'fixture'});
 const ctx=reviewAssignmentContext(f.wb,a.review_id),jid='AJ-'+crypto.randomUUID(),dir=path.join(f.root,'.agent-workbench-output',t.tid,t.rid,'calls',jid);fs.mkdirSync(dir,{recursive:true});
 const payload={...ctx.report_template,verdict:'passed',findings:[],limitations:['合成原生事件，不代表独立审查'],evidence:['本测试当前交付摘要'],report_markdown:'# 合成报告\n\n用于验证独立客户端原生回传失败之后的完整报告自动登记路径。'};
 const wire={type:'result',subtype:'success',is_error:false,session_id:'synthetic-native-recovery',result:'先核对资料。\n'+JSON.stringify(payload)};
 const job={id:jid,task_id:t.tid,run_id:t.rid,review_id:a.review_id,role:'review',phase:'review',route:{client:'cursor',model:'synthetic-cursor'},status:'failed',reason:'Unexpected token in JSON at position 0',process_may_be_running:false,process_end_evidence:'owned_child_exit',exit_code:0,session_id:wire.session_id,files:{stdout:path.join(dir,'stdout.jsonl')},ended_at:new Date().toISOString()};
 fs.writeFileSync(job.files.stdout,JSON.stringify(wire)+'\n');f.wb.put('agent_jobs',job,{run_id:t.rid});return {f,t,a,job,payload,wire};
}
test('saved independent terminal report is recovered idempotently with provenance; original failure remains',()=>{
 const {f,t,a,job}=prepared();try{const r=recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id}),again=recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id});
 assert.equal(r.review.verdict,'passed');assert.equal(r.review.source,'native_client_output');assert.equal(r.review.client_job_id,job.id);assert.equal(again.review.id,r.review.id);assert.equal(f.wb.all('reviews').length,1);
 assert.equal(f.wb.get('agent_jobs',job.id).status,'failed');assert.equal(f.wb.get('agent_jobs',job.id).reason,job.reason);assert.equal(isRecoveredReviewJob(f.wb,f.wb.get('agent_jobs',job.id)),true);assert.equal(f.wb.get('review_assignments',a.review_id).started_at,undefined);
 }finally{f.wb.close();}
});
test('legacy parse error with recorded owned exit preserves unknown exit code while recovering original result',()=>{
 const {f,t,job}=prepared();try{f.wb.put('agent_jobs',{...job,exit_code:null},{run_id:t.rid});recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id});const saved=f.wb.get('agent_jobs',job.id);assert.equal(saved.exit_code,null);assert.equal(saved.native_result_recovery.exit_evidence,'legacy_success_terminal_parse_failure');}finally{f.wb.close();}
});
test('native recovery refuses uncertain/alive processes, mismatches, external paths and caller-authored reports',()=>{
 const {f,t,job}=prepared();try{
 for(const patch of [{process_may_be_running:true},{process_pid:process.pid},{session_mismatch:true},{exit_code:2},{exit_code:null,reason:'permission denied'},{files:{stdout:path.join(f.root,'other.json')}}]){f.wb.put('agent_jobs',{...job,...patch},{run_id:t.rid});assert.throws(()=>recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id}));assert.equal(f.wb.all('reviews').length,0);}
 f.wb.put('agent_jobs',job,{run_id:t.rid});assert.throws(()=>recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id,verdict:'passed'}));
 }finally{f.wb.close();}
});
test('native recovery refuses ambiguous terminal, tool-only output, foreign digest/session and cancelled assignment',()=>{
 const {f,t,a,job,wire,payload}=prepared();try{
 const invalid=[JSON.stringify(wire)+'\n'+JSON.stringify(wire),JSON.stringify({type:'tool_result',content:JSON.stringify(payload)}),JSON.stringify({...wire,session_id:'foreign'}),JSON.stringify({...wire,result:JSON.stringify({...payload,review_digest:'0'.repeat(64)})}),JSON.stringify({...wire,is_error:true})];
 for(const text of invalid){fs.writeFileSync(job.files.stdout,text);assert.throws(()=>recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id}));assert.equal(f.wb.all('reviews').length,0);}
 fs.writeFileSync(job.files.stdout,JSON.stringify(wire));f.wb.put('review_assignments',{...f.wb.get('review_assignments',a.review_id),status:'cancelled'},{run_id:t.rid});assert.throws(()=>recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id}));
 }finally{f.wb.close();}
});

test('old model-only mismatch recovers original changes_requested without a new invocation',()=>{
 const {f,t,a,job,wire,payload}=prepared();try{
 f.wb.put('agent_jobs',{...job,model_mismatch:true,actual_model:'grok-4.7-build',route:{...job.route,model:'grok-4.7'},reason:'old model mismatch'},{run_id:t.rid});
 const assignment=f.wb.get('review_assignments',a.review_id);assignment.actual_model='previous-display-name';f.wb.put('review_assignments',assignment,{run_id:t.rid});
 const findings=['first actual issue','second actual issue','third actual issue'];fs.writeFileSync(job.files.stdout,JSON.stringify({...wire,model:'grok-new-label',result:JSON.stringify({...payload,verdict:'changes_requested',findings})}));
 const r=recoverNativeReview(f.wb,{run_id:t.rid,job_id:job.id});assert.equal(r.review.verdict,'changes_requested');assert.equal(r.review.findings,findings.join('\n'));assert.equal(f.wb.all('agent_jobs').length,1);assert.equal(f.wb.get('agent_jobs',job.id).reason,'old model mismatch');assert.equal(isRecoveredReviewJob(f.wb,f.wb.get('agent_jobs',job.id)),true);
 }finally{f.wb.close();}
});

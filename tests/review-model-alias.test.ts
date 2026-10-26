import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {fixture,setup,event} from './helpers.ts';import {requestedModelMatches} from '../src/core/model-identity.ts';import {exportReviewOrder,reviewAssignmentContext,startReview,submitReviewResult} from '../src/core/review-workflow.ts';
test('Claude aliases match only their model family; full names and other clients remain exact',()=>{
 for(const name of ['sonnet','opus','haiku']){assert(requestedModelMatches('claude',name,'claude-'+name+'-5-5'));assert(!requestedModelMatches('cursor',name,'claude-'+name+'-5-5'));}
 assert(!requestedModelMatches('claude','sonnet','claude-opus-5-5'));assert(!requestedModelMatches('claude','claude-sonnet-5-5','claude-sonnet-5-6'));assert(requestedModelMatches('grok','grok-4.7-high','grok-4.7-high'));
});
test('Claude short alias remains readable through started, native submission and completed review context',()=>{const f=fixture();try{
 const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离模型别名测试交付，不调用真实模型或改正式账本。'}));
 const order=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'claude',requested_model:'sonnet',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'合成Claude别名回归'},{role:'user'});
 startReview(f.wb,{review_id:order.review_id,identity:'claude',session_id:'synthetic-alias-session',actual_model:'claude-opus-5-5'});
 const context=reviewAssignmentContext(f.wb,order.review_id);assert.equal(context.assignment.actual_model,'claude-opus-5-5');
 const jobId='AJ-'+crypto.randomUUID();f.wb.put('agent_jobs',{id:jobId,role:'review',review_id:order.review_id,run_id:s.rid,task_id:s.tid,route:{client:'claude',model:'sonnet'},status:'running',actual_model:'claude-opus-5-5',session_id:'synthetic-alias-session'},{run_id:s.rid});
 const result=submitReviewResult(f.wb,{...context.final_response,review_id:order.review_id,verdict:'passed',findings:[],limitations:['隔离夹具，不是实际审查'],evidence:['合成模型与单据绑定'],report_markdown:'这是一份合成审查报告，只验证原生结果与模型别名兼容，不代表真实审查。'},'native_client_output:'+jobId);assert.equal(result.review.verdict,'passed');assert.equal(reviewAssignmentContext(f.wb,order.review_id).assignment.status,'completed');
}finally{f.wb.close()}});

test('a reviewer may omit model disclosure or explicitly report null',()=>{for(const actual_model of [undefined,null]){const f=fixture();try{const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'Synthetic model-optional review: no real provider called.'}));const order=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'claude',requested_model:null,expected_revision:f.wb.get('tasks',s.tid).revision,reason:'Model may be undisclosed'},{role:'user'});startReview(f.wb,{review_id:order.review_id,identity:'claude',actual_model});assert.equal(reviewAssignmentContext(f.wb,order.review_id).model_status,'unknown');}finally{f.wb.close();}}});

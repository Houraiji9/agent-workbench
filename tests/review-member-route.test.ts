import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,setup,event} from './helpers.ts';
import {exportReviewOrder,updateReviewMember} from '../src/core/review-workflow.ts';
const user={role:'user' as const};
function prepared(){const f=fixture(),t=setup(f.wb,f.root);f.wb.event(event(f.root,t.tid,t.rid,1));f.wb.event(event(f.root,t.tid,t.rid,2,'submitted',{result:'隔离合成保存链路：核对成员模型与客户端route同步，不执行模型。'}));const order=exportReviewOrder(f.wb,{run_id:t.rid,expected_revision:f.wb.get('tasks',t.tid).revision,reviewer_id:'grok-build',requested_model:'grok-4.7-build',delivery_mode:'agent',reason:'合成初始审查成员' },user);const member=f.wb.get('review_assignments',order.review_id);member.route={client:'grok',model:'grok-4.7-build',provider:'synthetic-original-provider'};f.wb.put('review_assignments',member,{run_id:t.rid});return {...f,...t,reviewId:order.review_id};}
function replace(f:ReturnType<typeof prepared>,reviewId:string,extra:Record<string,unknown>){return updateReviewMember(f.wb,{run_id:f.rid,review_id:reviewId,expected_revision:f.wb.get('tasks',f.tid).revision,action:'replace',reviewer_id:'grok-build',reason:'用户在任务页调整此审查者与模型',...extra},user) as ReturnType<typeof exportReviewOrder>;}
test('调整同一审查者模型和清空模型同步route，保留provider及交接方式',()=>{
 const f=prepared();try{const changed=replace(f,f.reviewId,{requested_model:'grok-4.7-build-fast'}),member=f.wb.get('review_assignments',changed.review_id);assert.equal(member.requested_model,'grok-4.7-build-fast');assert.deepEqual(member.route,{client:'grok',model:'grok-4.7-build-fast',provider:'synthetic-original-provider'});assert.equal(member.delivery_mode,'agent');assert.deepEqual(changed.context.assignment.route,member.route);assert.equal(f.wb.get('review_assignments',f.reviewId).status,'cancelled');assert.equal(f.wb.get('review_assignments',f.reviewId).requested_model,'grok-4.7-build');
 const cleared=replace(f,changed.review_id,{requested_model:null}),empty=f.wb.get('review_assignments',cleared.review_id);assert.equal(empty.requested_model,null);assert.deepEqual(empty.route,{client:'grok',model:null,provider:'synthetic-original-provider'});assert.equal(f.wb.get('tasks',f.tid).current_run_id,f.rid);assert.equal(f.wb.all('reviews').length,0);
 }finally{f.wb.close();}
});
test('更换审查者不沿用另一客户端provider，省略模型参数保留同成员现有模型',()=>{
 const f=prepared();try{const same=replace(f,f.reviewId,{});assert.equal(f.wb.get('review_assignments',same.review_id).requested_model,'grok-4.7-build');const switched=replace(f,same.review_id,{reviewer_id:'zcode'}),member=f.wb.get('review_assignments',switched.review_id);assert.equal(member.reviewer_id,'zcode');assert.equal(member.requested_model,null);assert.equal(member.route,undefined);assert.equal(member.delivery_mode,'agent');assert.equal(f.wb.get('review_assignments',same.review_id).route.provider,'synthetic-original-provider');
 }finally{f.wb.close();}
});

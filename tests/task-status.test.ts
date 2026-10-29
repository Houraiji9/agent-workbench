import {test} from 'node:test';import assert from 'node:assert/strict';
import {taskStatus} from '../src/core/task-status.ts';
const make=(patch:any={})=>{
 const task={id:'T-test',title:'测试任务',status:'in_review',current_run_id:'R-current',agent_id:'executor',reviewer_id:'reviewer',revision:77,version:3,review_stage:'running',review_route:{client:'cursor',model:'grok-4.7-xhigh-fast'},...patch};
 const detail:any={task,runs:[{id:'R-current',status:'submitted',retry_context:{large:'历史'.repeat(50000)}}],events:Array.from({length:180},(_,i)=>({id:'E-'+i,run_id:'R-current',event_type:'progress',data:{message:'历史'.repeat(5000)}})),reviews:Array.from({length:120},(_,i)=>({id:'RV-'+i,run_id:'R-current',verdict:'passed',findings:'意见'.repeat(10000)})),review_assignments:[],artifacts:[],reply_history:[],sessions:[],review_summary:{counts:{total:3,completed:1}}};
 const wb:any={taskDetail:()=>detail,maybe:()=>null};return {wb,detail};
};
test('task status UTF8 response bounded, histories preserved through full and ID refs',()=>{
 const {wb,detail}=make();const v=taskStatus(wb,'T-test');assert(Buffer.byteLength(JSON.stringify(v))<=20*1024);assert.equal(v.usage.bytes,Buffer.byteLength(JSON.stringify(v)));assert.equal(v.revision,77);assert.equal(v.blocker,'missing_reports');assert.equal(v.effective_route.requested_model,'grok-4.7-xhigh-fast');assert.equal(v.history.events.items.length,2);assert.equal(v.omitted.events.count,178);assert(v.omitted.events.bytes>100000);assert.equal(taskStatus(wb,'T-test',{detail:'full'}),detail);
 const ref=v.history.reviews.items[0].full_ref.arguments;const full=taskStatus(wb,ref.task_id,{section:ref.section,id:ref.id});assert.equal(full.record.findings,detail.reviews[0].findings);
});
test('status pages by task-bound IDs, rejects nonexistent cursor and cross-record IDs',()=>{
 const {wb}=make();const a=taskStatus(wb,'T-test',{section:'reviews',limit:3});assert.deepEqual(a.history.reviews.items.map((r:any)=>r.id),['RV-0','RV-1','RV-2']);const b=taskStatus(wb,'T-test',{section:'reviews',after_id:a.history.reviews.next_after_id,limit:3});assert.equal(b.history.reviews.items[0].id,'RV-3');assert.throws(()=>taskStatus(wb,'T-test',{section:'reviews',after_id:'outside'}),/after_id/);assert.throws(()=>taskStatus(wb,'T-test',{section:'reviews',id:'outside'}),/证据 ID/);
});
test('deployment pending and user trial remain separate states',()=>{
 let f=make({status:'awaiting_confirmation',delivery_target:'runtime',deployment:{verified:false}}),v=taskStatus(f.wb,'T-test');assert.equal(v.blocker,'deployment_pending');assert.equal(v.owner.role,'agent');assert.equal(v.next_action.tool,'get_deployment_context');f=make({status:'awaiting_confirmation',delivery_target:'runtime',deployment:{verified:true}});v=taskStatus(f.wb,'T-test');assert.equal(v.blocker,'user_trial');assert.equal(v.owner.role,'user');assert.equal(v.next_action.tool,null);
});

test('large page stays bounded and retains cursor plus full history references',()=>{const {wb}=make();const v=taskStatus(wb,'T-test',{section:'reviews',limit:25});assert(Buffer.byteLength(JSON.stringify(v))<=20*1024);assert(v.history.reviews.items.length>0);assert(v.history.reviews.next_after_id);assert.equal(v.history.reviews.total,120);});
test('disagreement differs from report wait and tool invocation failure',()=>{const {wb,detail}=make({review_stage:'awaiting_decision',review_can_proceed:false});detail.reviews=[{id:'a',run_id:'R-current',verdict:'passed'},{id:'b',run_id:'R-current',verdict:'changes_requested'}];assert.equal(taskStatus(wb,'T-test').blocker,'review_disagreement');detail.task.review_stage='running';detail.task.automation={job_id:'AJ-1'};wb.maybe=()=>({run_id:'R-current',role:'review',status:'failed',reason:'tool_approval_unavailable'});const v=taskStatus(wb,'T-test');assert.equal(v.blocker,'tool_failure');assert.equal(v.reason,'tool_approval_unavailable');});

test('minimal task compatibility and current Run arrangement override historical route',()=>{
 const {wb,detail}=make();detail.runs[0].execution_contract={agent_id:'frozen-executor',reviewer_id:'old-reviewer',review_route:{client:'cursor',model:'old-model'}};detail.runs[0].review_arrangement={reviewer_id:'current-reviewer',requested_model:'grok-4.7-xhigh-fast',route:{client:'cursor',model:'grok-4.7-xhigh-fast'},reason:'用户本轮安排'};
 const v=taskStatus(wb,'T-test');assert.equal(v.task.version,3);assert.equal(v.task.revision,77);assert.equal(v.task.current_run_id,'R-current');assert.equal(v.owner.id,'current-reviewer');assert.equal(v.effective_route.requested_model,'grok-4.7-xhigh-fast');assert.equal(v.task.scope,undefined);
});

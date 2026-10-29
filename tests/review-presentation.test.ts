import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveredReviewInvocation,reviewSourceLabel,processRecoveryText} from '../src/shared/review-presentation.ts';
import {relayOf} from '../src/web/lib/flow.ts';
import {taskAction,taskDisplayStatus,actionGroups} from '../src/shared/workflow-view.ts';
const recovered={role:'review',status:'failed',reason:'Unexpected token',process_may_be_running:false,recovery_required:false,superseded:{reason:'补登记'},recovery:{kind:'review_report_submission',original_status:'failed',review_id:'V',recovered_at:'2026-10-26',process_end_evidence:'owned_child_exit'}};
test('native report source retains automatic provenance and distinguishes stored output recovery',()=>{assert.equal(reviewSourceLabel({source:'native_client_output'}),'客户端原生回传：');assert.equal(reviewSourceLabel({source:'native_client_output',evidence_level:'stored_launched_client_final_output'}),'客户端原生输出已补登记：');assert.equal(reviewSourceLabel({source:'user_imported_review'}),'已导入审查回执：');assert.equal(reviewSourceLabel({source:'manual'}),'手工登记：');});
test('only confirmed terminal review recovery changes invocation presentation',()=>{assert.equal(recoveredReviewInvocation(recovered),true);for(const patch of [{status:'running'},{role:'execution'},{process_may_be_running:true},{recovery_required:true},{recovery:null},{recovery:{...recovered.recovery,process_end_evidence:'unknown'}}])assert.equal(recoveredReviewInvocation({...recovered,...patch}),false);assert.equal(recovered.status,'failed');assert.equal(recovered.reason,'Unexpected token');});
test('superseded flag cannot hide a still unresolved original process from current action or relay',()=>{const t={status:'submitted',review_stage:'awaiting_decision',agent_id:'author',reviewer_id:'reviewer',automation:{...recovered,process_may_be_running:true,recovery_required:true}};assert.equal(taskAction(t).group,'decision');assert.match(relayOf(t,x=>x).headline,/负责人决定/);const ended={...t,automation:recovered};assert.match(relayOf(ended,x=>x).headline,/负责人决定/);});
test('automatic process verification is displayed as system evidence and never as a review verdict',()=>{
 const automatic={status:'interrupted',role:'review',process_may_be_running:false,recovery_required:false,process_end_evidence:'tracked_process_absent',process_recovery:{actor:'system'}};
 assert.match(processRecoveryText(automatic)!,/工作台已自动核实/);assert.doesNotMatch(processRecoveryText(automatic)!,/用户核实|用户确认/);assert.equal(recoveredReviewInvocation(automatic),false);assert.equal(recoveredReviewInvocation({...recovered,recovery:{...recovered.recovery,process_end_evidence:'tracked_process_absent'}}),false);
 assert.match(processRecoveryText({...automatic,process_end_evidence:'user_attested',process_recovery:{actor:'user'}})!,/用户补充核实/);
 const unresolved={status:'interrupted',process_may_be_running:true,recovery_required:true};assert.match(processRecoveryText(unresolved)!,/未记录可核验的进程编号/);assert.match(processRecoveryText({...unresolved,process_pid:1234})!,/进程编号 1234.*系统尚未核实/);assert.equal(processRecoveryText({status:'running',process_may_be_running:true,process_pid:1234}),null);
});

test('旧多人全通过待决投影提供正常收尾动作而不改任务状态',()=>{
 const task={status:'submitted',review_stage:'awaiting_decision',review_can_proceed:true,agent_id:'author',reviewer_id:'reviewer'};
 assert.equal(actionGroups.decision,'待决定');assert.equal(taskAction(task).group,'arrange');assert.equal(taskDisplayStatus(task),'review_ready_closeout');
 assert.match(relayOf(task,x=>x).headline,/审查已通过.*交回执行者收尾/);assert.match(relayOf(task,x=>x).next,/添加审查者.*你试用确认/);
 assert.equal(task.status,'submitted');assert.equal(task.review_stage,'awaiting_decision');
 assert.equal(taskAction({...task,review_can_proceed:false}).group,'decision');assert.equal(taskDisplayStatus({...task,review_can_proceed:false}),'review_decision');
});

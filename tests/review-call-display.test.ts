import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskAction} from '../src/shared/workflow-view.ts';

const returnedReview={current_run_id:'r1',review_stage:'completed',automation:{role:'review',run_id:'r1',status:'interrupted',process_may_be_running:false,recovery_required:false}};
test('补交审查后按当前收尾与试用阶段显示，原中断记录不改写',()=>{
 const before=JSON.stringify(returnedReview);
 assert.equal(taskAction({...returnedReview,status:'closing'}).label,'正在收尾');
 assert.equal(taskAction({...returnedReview,status:'awaiting_closeout',closeout_delivery:'agent'}).label,'执行者继续收尾');
 assert.equal(taskAction({...returnedReview,status:'awaiting_confirmation',delivery_target:'runtime',deployment:{verified:true}}).group,'trial');
 assert.equal(JSON.stringify(returnedReview),before);
});
test('未交回审查、原进程未结束或调用不属当前执行时保留真实待处理事项',()=>{
 for(const patch of [{review_stage:'running'},{automation:{...returnedReview.automation,process_may_be_running:true}},{automation:{...returnedReview.automation,process_may_be_running:null}},{automation:{...returnedReview.automation,recovery_required:true}},{automation:{...returnedReview.automation,run_id:'other'}}]){
  assert.equal(taskAction({...returnedReview,status:'closing',...patch}).label,'处理客户端调用阻碍');
 }
});
test('审查补交不掩盖后续收尾受阻、待回答或本机未更新',()=>{
 assert.equal(taskAction({...returnedReview,status:'closeout_blocked'}).label,'处理阻碍');
 assert.equal(taskAction({...returnedReview,status:'closeout_waiting_input'}).group,'answer');
 assert.equal(taskAction({...returnedReview,status:'awaiting_confirmation',delivery_target:'runtime',deployment:{verified:false}}).label,'等待本机更新');
});

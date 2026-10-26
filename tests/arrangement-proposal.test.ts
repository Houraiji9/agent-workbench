import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fixture,setup} from './helpers.ts';
import {manage} from '../src/core/management.ts';
import {changeTaskArrangement} from '../src/core/task-arrangement.ts';

test('会话建议只准备安排；页面采用后才生成新版本并保留旧合同',async()=>{
 const f=fixture();try{
  const {tid,rid}=setup(f.wb,f.root),before=f.wb.get('runs',rid),oldContract=JSON.stringify(before.execution_contract);
  const input={request_id:crypto.randomUUID(),user_instruction:'请准备采用GPT6Sol作为后续执行主模型。',change:{action:'propose_arrangement',task_id:tid,data:{revision:f.wb.get('tasks',tid).revision,agent_id:'codex',execution_policy:{main_model:'gpt-6-sol'}}}};
  const receipt=await manage(f.wb,{} as any,'manage_tasks',input);
  assert.equal(receipt.result.applied,false);let t=f.wb.get('tasks',tid);
  assert.equal(t.current_run_id,rid);assert.equal(t.proposed_arrangement.source,'manager_proposal');assert.equal(t.requested_model,null);
  assert.equal(JSON.stringify(f.wb.get('runs',rid).execution_contract),oldContract);
  const again=await manage(f.wb,{} as any,'manage_tasks',input);assert.deepEqual(again,receipt);
  assert.throws(()=>changeTaskArrangement(f.wb,tid,{revision:t.revision-1,execution_policy:{main_model:'gpt-6-sol'}}),/变化/);
  const applied=changeTaskArrangement(f.wb,tid,{revision:t.revision,agent_id:'codex',execution_policy:t.proposed_arrangement.execution_policy});
  assert.notEqual(applied.task.current_run_id,rid);assert.equal(applied.task.requested_model,'gpt-6-sol');assert(!applied.task.proposed_arrangement);
  assert.equal(f.wb.get('runs',rid).status,'cancelled');assert.equal(JSON.stringify(f.wb.get('runs',rid).execution_contract),oldContract);
 }finally{f.wb.close()}
});

test('安排建议验证独立性和当前版本，型号不受目录限制',async()=>{
 const f=fixture();try{
  const {tid}=setup(f.wb,f.root),revision=f.wb.get('tasks',tid).revision;
  const call=(agent_id:string,model:string)=>manage(f.wb,{} as any,'manage_tasks',{request_id:crypto.randomUUID(),user_instruction:'准备后续执行安排，仅作隔离测试。',change:{action:'propose_arrangement',task_id:tid,data:{revision,agent_id,execution_policy:{main_model:model}}}});
  await assert.rejects(call('grok-build','grok-4.7'),/职责|审查/);
  await call('codex','not-a-real-model');
  assert.equal(f.wb.get('tasks',tid).proposed_arrangement.execution_policy.main_model,'not-a-real-model');
  await assert.rejects(call('codex','another-advice'),/变化/);
 }finally{f.wb.close()}
});

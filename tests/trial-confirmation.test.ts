import {test,mock} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,setup,event,finishCloseout} from './helpers.ts';import {reviewCollaboration} from '../src/core/review-workflow.ts';

function trial(){
 const f=fixture(),{wb,root}=f,s=setup(wb,root),file=path.join(root,'AGENTS.md');fs.writeFileSync(file,'本轮原始资料');
 wb.event(event(root,s.tid,s.rid,1));wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付：用户确认结果与源码后续修改分开记录，不代表真实生产审查。',review_files:[file]}));
 wb.review({run_id:s.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',evidence:'隔离合成审查，用于验证用户确认状态，不是真实外部报告。',artifact_hashes:wb.runRows('artifacts',s.rid).filter(a=>a.current).map(a=>a.sha256)});finishCloseout(wb,s.tid);
 const input=()=>({revision:wb.get('tasks',s.tid).revision,artifact_hashes:wb.runRows('artifacts',s.rid).filter(a=>a.current).map(a=>a.sha256),mode:'user_experience',user_checks:[true,true]});
 return {...f,...s,file,input};
}
for(const removed of [false,true])test('旧任务资料'+(removed?'删除':'变化')+'不阻挡用户确认，审查与核验事实不改写',()=>{
 const f=trial();try{
  const before=JSON.stringify(f.wb.runRows('reviews',f.rid));
  if(removed)fs.renameSync(f.file,f.file+'.moved');else fs.appendFileSync(f.file,'\n项目后续功能新增说明');
  const result=f.wb.accept(f.tid,f.input());assert.equal(result.status,'accepted');
  assert.equal(result.acceptance_record.mode,'user_experience');assert.equal(result.acceptance_record.technical_verification.rechecked_on_confirmation,false);
  assert.equal(result.acceptance_record.technical_verification.current_files,'not_rechecked');assert.equal(JSON.stringify(f.wb.runRows('reviews',f.rid)),before);
 }finally{f.wb.close()}
});
test('确认复用已有安装核验，不重扫项目目录；当前归档仍单独核对',()=>{
 const f=trial();try{
  const run=f.wb.get('runs',f.rid),deployment={verified:true,runtime_root:path.join(f.root,'不存在的合成运行目录'),manifest_sha256:'0'.repeat(64),verified_at:'2026-01-01T00:00:00.000Z'};
  run.deployment=deployment;f.wb.put('runs',run,{task_id:f.tid});
  const input=f.input(),read=fs.readFileSync;
  const scan=mock.method(fs,'readdirSync',()=>{throw Error('确认不应遍历项目或安装目录')});
  const reads=mock.method(fs,'readFileSync',((file:any,...args:any[])=>{assert.notEqual(String(file),f.file);assert(!String(file).startsWith(deployment.runtime_root));return (read as any)(file,...args)}) as typeof fs.readFileSync);
  try{const accepted=f.wb.accept(f.tid,input);assert.deepEqual(accepted.acceptance_record.technical_verification.deployment,deployment);assert.equal(accepted.acceptance_record.technical_verification.archived_artifacts_checked,true);}finally{scan.mock.restore();reads.mock.restore()}
 }finally{f.wb.close()}
});
test('最新页面版本、成果引用与用户逐项确认仍被核对',()=>{
 const f=trial();try{
  assert.throws(()=>f.wb.accept(f.tid,{...f.input(),revision:0}),/版本冲突/);
  assert.throws(()=>f.wb.accept(f.tid,{...f.input(),artifact_hashes:['0'.repeat(64)]}),/页面产物版本/);
  assert.throws(()=>f.wb.accept(f.tid,{...f.input(),user_checks:[false,false]}),/确认使用结果/);
  assert.equal(f.wb.get('tasks',f.tid).status,'awaiting_confirmation');
  assert.throws(()=>f.wb.managementContext.run({request_id:'test',tool:'test',user_instruction:'测试',actor:'manager'},()=>f.wb.accept(f.tid,f.input())),/请用户/);
 }finally{f.wb.close()}
});
test('试用只读取当前任务产物；审查汇总使用当前Run行而非全表历史',()=>{
 const f=trial();try{
  const other=setup(f.wb,f.root);f.wb.event(event(f.root,other.tid,other.rid,1));f.wb.event(event(f.root,other.tid,other.rid,2,'submitted',{result:'另一个合成任务的交付，不应进入当前试用的内容。'}));
  const all=mock.method(f.wb,'all',()=>{throw Error('不应扫描全表历史')}),full=mock.method(f.wb,'executionTasks',()=>{throw Error('试用不应生成全项目任务列表')});
  try{const view=f.wb.trialDetail(f.tid);assert.equal(view.task.id,f.tid);assert(view.artifacts.length>0&&view.artifacts.every(a=>a.run_id===f.rid&&a.current));assert.equal(Object.hasOwn(view,'events'),false);assert.equal(Object.hasOwn(view,'sessions'),false);assert.equal(reviewCollaboration(f.wb,f.rid).can_proceed,true);}finally{all.mock.restore();full.mock.restore()}
 }finally{f.wb.close()}
});

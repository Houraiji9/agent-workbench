import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,taskInput,event} from './agent-routing-fixture.ts';
import {exportReviewOrder,startReview,reviewAssignmentContext,submitReviewResult} from '../src/core/review-workflow.ts';
import {createReleaseHandoff,releaseSourceStatus} from '../src/core/release-handoff.ts';

const actor={role:'runner',id:'synthetic-authenticated-executor',source:'scoped_mcp'};
function reviewed(){
 const f=fixture(),q=f.wb.request({project_id:'P-workbench',text:'合成源码交付，不部署'});
 const plan=f.wb.submitPlan({schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:[{...taskInput(f.root),execution_route:{client:'dsh',model:'native-author-fast',provider:'custom-account'},agent_id:'deepseek',requested_model:'native-author-fast',review_route:{client:'grok',model:'grok-4.7-build-fast'},delivery_profile:{schema:1,artifacts:['source'],deployment:{mode:'none',verification:'none'}}}]});
 const tid=plan.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id,file=path.join(f.root,'reviewed-source.ts'),report=path.join(f.root,'source-report.md');fs.writeFileSync(file,'export const reviewed = true;');fs.writeFileSync(report,'合成源码交付报告');
 const send=(seq:number,type:string,extra:any={})=>{const result=f.wb.event(event(f.root,tid,rid,seq,type,{identity:'deepseek',...extra}));assert.equal(result.disposition,'applied',result.error);};send(1,'started');send(2,'submitted',{result:'合成源码已经交付，本轮仅验证来源绑定、独立审查和发布关系，不部署真实程序。',artifacts:[{path:report,label:'合成源码报告'}],review_files:[file]});
 const order=exportReviewOrder(f.wb,{run_id:rid,expected_revision:f.wb.get('tasks',tid).revision,reviewer_id:'grok-build',requested_model:'grok-4.7-build-fast',reason:'合成独立源码审查',delivery_mode:'agent'},{role:'user'});startReview(f.wb,{review_id:order.review_id,identity:'grok-build'});
 const c=reviewAssignmentContext(f.wb,order.review_id);const review=submitReviewResult(f.wb,{task_id:tid,run_id:rid,review_id:order.review_id,review_digest:c.review_digest,verdict:'passed',findings:[],limitations:['合成测试，不代表真实模型或部署'],evidence:['受审源码及归档报告指纹'],report_markdown:'# 合成独立通过报告：仅核验受审源码指纹与独立报告绑定，不代表真实模型执行。'},'reviewer:'+order.review_id);
 const deployment=path.join(f.root,'runtime');fs.mkdirSync(deployment);
 const input={handoff_id:randomUUID(),source_task_id:tid,source_run_id:rid,expected_revision:f.wb.get('tasks',tid).revision,title:'合成部署阶段',goal:'部署已审源码并验证健康与回滚',scope:'仅授权的隔离运行目录与部署脚本',deliverables:['部署证据与回滚记录'],acceptance:['新脚本单独审查并保留旧源码报告引用'],tests:['隔离部署健康与回滚测试'],delivery_profile:{schema:1 as const,artifacts:['source' as const,'software' as const],deployment:{mode:'local' as const,target:deployment,deploy:'执行本阶段新受审脚本',health:'核验隔离健康入口',rollback:'使用隔离备份恢复',verification:'executor_reported' as const}},deployment_authorization:{authorized:true as const,target:deployment,reason:'用户已授权进入本次隔离部署阶段'}};
 return {...f,tid,rid,file,review,input};
}
test('release handoff creates only an explicit successor Task and preserves source contract/reports and native routes',()=>{
 const f=reviewed();try{
  const oldRun=f.wb.get('runs',f.rid),oldReports=f.wb.runRows('reviews',f.rid),before=JSON.stringify({oldRun,oldReports}),runCount=f.wb.all('runs').length;
  const result=createReleaseHandoff(f.wb,f.input,actor),task=f.wb.get('tasks',result.task_id);
  assert.equal(f.wb.all('runs').length,runCount);assert.equal(task.current_run_id,null);assert.equal(task.delivery_group_id,f.tid);assert.equal(f.wb.get('tasks',f.tid).delivery_group_id,f.tid);
  assert.deepEqual(task.execution_route,{client:'dsh',model:'native-author-fast',provider:'custom-account'});assert.equal(task.review_route.model,'grok-4.7-build-fast');assert.equal(task.source_delivery.route_preference_source.source_run_id,f.rid);assert.deepEqual(task.dependencies,[f.tid]);
  assert.equal(task.source_delivery.deployment_authorization.actor.id,actor.id);assert.equal(task.source_delivery.target,f.input.delivery_profile.deployment.target);
  assert.equal(JSON.stringify({oldRun:f.wb.get('runs',f.rid),oldReports:f.wb.runRows('reviews',f.rid)}),before);assert.equal(oldRun.execution_contract.delivery_profile.deployment.mode,'none');
  assert.equal(f.wb.runRows('reviews',task.id).length,0);assert.equal(releaseSourceStatus(f.wb,task.id).valid,true);assert.equal(result.next.tool,'export_execution_order');
  const repeat=createReleaseHandoff(f.wb,f.input,actor);assert.equal(repeat.task_id,task.id);assert.equal(repeat.idempotent,true);assert.throws(()=>createReleaseHandoff(f.wb,{...f.input,goal:'不同payload'},actor),/内容不同/);
  const order=f.wb.exportOrder(task.id,1),nextRun=f.wb.get('runs',order.run_id);assert.equal(nextRun.execution_contract.delivery_profile.deployment.mode,'local');assert.equal(f.wb.runRows('reviews',nextRun.id).length,0);
 }finally{f.wb.close();}
});
test('changed source or revoked review invalidates reuse, and failed handoff writes no partial Task',()=>{
 for(const change of ['source','review','revision','target','profile','paths'] as const){const f=reviewed();try{
  const before=f.wb.all('tasks').length,input=structuredClone(f.input);
  if(change==='source')fs.writeFileSync(f.file,'changed');
  if(change==='review'){const review=f.wb.runRows('reviews',f.rid)[0];f.wb.put('reviews',{...review,revoked_at:new Date().toISOString()},{run_id:f.rid});}
  if(change==='revision')input.expected_revision++;
  if(change==='target')input.deployment_authorization.target+='-different';
  if(change==='profile')input.delivery_profile.deployment.rollback='';
  if(change==='paths')(input as any).allowed_paths=[f.wb.config.dataDir];
  assert.throws(()=>createReleaseHandoff(f.wb,input,actor));assert.equal(f.wb.all('tasks').length,before);assert.equal(f.wb.get('tasks',f.tid).delivery_group_id,undefined);
 }finally{f.wb.close();}}
});
test('new deployment changes never inherit a passed Review and source references revalidate live hashes',()=>{
 const f=reviewed();try{const result=createReleaseHandoff(f.wb,f.input,actor);fs.writeFileSync(f.file,'new unreviewed source');const status=releaseSourceStatus(f.wb,result.task_id);assert.equal(status.valid,false);assert.equal(status.review_status,'source_reference_invalid');assert.equal(status.deployment_review,'required');assert.equal(f.wb.get('tasks',result.task_id).status,'ready');assert.equal(f.wb.runRows('reviews',f.rid).length,1);}finally{f.wb.close();}
});
test('release handoff transaction rolls back late failures and rejects self approval without changing history',()=>{
 const f=reviewed();try{
  const count=f.wb.all('tasks').length,review=f.wb.runRows('reviews',f.rid)[0];
  f.wb.put('reviews',{...review,reviewer_id:'deepseek'},{run_id:f.rid});assert.throws(()=>createReleaseHandoff(f.wb,f.input,actor),/独立通过报告/);f.wb.put('reviews',review,{run_id:f.rid});
  const audit=f.wb.audit;f.wb.audit=()=>{throw Error('synthetic audit write failure');};
  assert.throws(()=>createReleaseHandoff(f.wb,f.input,actor),/synthetic audit write failure/);f.wb.audit=audit;
  assert.equal(f.wb.all('tasks').length,count);assert.equal(f.wb.get('tasks',f.tid).delivery_group_id,undefined);assert.equal(f.wb.get('tasks',f.tid).revision,f.input.expected_revision);
  const result=createReleaseHandoff(f.wb,f.input,actor);assert.equal(result.idempotent,false);assert.equal(releaseSourceStatus(f.wb,result.task_id).valid,true);
 }finally{f.wb.close();}
});
test('registered runtime outside source roots is checked against host authorization without silently expanding task paths',()=>{
 const f=reviewed();try{
  const runtime=fs.mkdtempSync(path.join(path.dirname(f.root),'release-runtime-')),project=f.wb.get('projects','P-workbench');f.wb.config.authorizedRoots.push(runtime);f.wb.put('projects',{...project,runtime_root:runtime});
  const input=structuredClone(f.input);input.delivery_profile.deployment.target=runtime;input.deployment_authorization.target=runtime;
  const result=createReleaseHandoff(f.wb,input,actor);assert.deepEqual(result.task.allowed_paths,[f.root]);assert.equal(result.source_delivery.target,runtime);
  const unregistered=fs.mkdtempSync(path.join(path.dirname(f.root),'unregistered-runtime-')),other={...input,handoff_id:randomUUID(),expected_revision:f.wb.get('tasks',f.tid).revision,delivery_profile:{...input.delivery_profile,deployment:{...input.delivery_profile.deployment,target:unregistered}},deployment_authorization:{...input.deployment_authorization,target:unregistered}};
  assert.throws(()=>createReleaseHandoff(f.wb,other,actor));
 }finally{f.wb.close();}
});

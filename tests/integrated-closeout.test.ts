import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event} from './helpers.ts';
import {completeIntegratedCloseout} from '../src/core/integrated-closeout.ts';
import {sessionCaller,type ManagementCaller} from '../src/core/session-management.ts';
import {hash} from '../src/core/security.ts';

function pair(){
 const f=fixture(),main=setup(f.wb,f.root),contributor=setup(f.wb,f.root),{wb}=f;
 const t=wb.get('tasks',contributor.tid),r=wb.get('runs',contributor.rid);t.agent_id='claude';r.agent_id='claude';wb.put('tasks',t,{project_id:t.project_id});wb.put('runs',r,{task_id:t.id});
 const file=path.join(f.root,'integrated.ts');fs.writeFileSync(file,'export const integrated = true;');
 for(const item of [main,contributor]){
  const identity=item===main?'codex':'claude';
  wb.event(event(f.root,item.tid,item.rid,1,'started',{identity}));
  wb.event(event(f.root,item.tid,item.rid,2,'submitted',{identity,result:'隔离测试正式交付：已有真实归档与源码指纹，用于验证整合负责人办理收尾。',review_files:[file]}));
 }
 return {...f,main,contributor,file,caller:sessionCaller(wb,'runner',main.rid)};
}
function input(f:ReturnType<typeof pair>){return {task_id:f.contributor.tid,run_id:f.contributor.rid,expected_revision:f.wb.get('tasks',f.contributor.tid).revision,source_run_id:f.main.rid,source_expected_revision:f.wb.get('tasks',f.main.tid).revision,result:'Codex整合负责人已核对Claude交付、集成入口和实际检查范围；缺少审查与部署的部分如实保留待核实。',closeout_results:[],coverage_note:'同一文件指纹相同；此处没有声称独立审查通过。'}}
const instruction='请由当前整合负责人把这两项交付一起收尾，保留未验证项，交给我试用验收。';

test('整合负责人一次动作关联并收尾，不伪造协作者事件或审查，缺审查部署保留警告',()=>{
 const f=pair(),{wb}=f;try{
  const mainBefore=JSON.stringify(wb.get('runs',f.main.rid)),sourceTaskBefore=JSON.stringify(wb.get('tasks',f.main.tid)),eventsBefore=wb.all('events').length;
  const result=completeIntegratedCloseout(wb,input(f),f.caller,instruction),closeout=result.closeout;
  assert.equal(result.status,'awaiting_confirmation');assert.equal(closeout.status,'completed');assert.equal(closeout.source,'integration_owner');
  assert.equal(closeout.recorded_by.agent_id,'codex');assert.equal(closeout.integration.target.agent_id,'claude');assert.equal(closeout.integration.source.agent_id,'codex');
  assert.equal(closeout.integration.user_instruction,instruction);assert.equal(closeout.integration.coverage[0].status,'unchanged');
  assert.equal(closeout.integration.coverage[0].current_sha256,hash(fs.readFileSync(f.file)));assert.match(closeout.integration.binding_sha256,/^[a-f0-9]{64}$/);
  assert.match(closeout.verification_warnings.join('\n'),/审查/);assert.match(closeout.verification_warnings.join('\n'),/部署/);
  assert.equal(wb.get('runs',f.contributor.rid).agent_id,'claude');assert.equal(wb.get('runs',f.contributor.rid).status,'submitted');
  assert.equal(wb.all('events').length,eventsBefore);assert.equal(wb.all('reviews').length,0);
  assert.equal(JSON.stringify(wb.get('runs',f.main.rid)),mainBefore);assert.equal(JSON.stringify(wb.get('tasks',f.main.tid)),sourceTaskBefore);
  assert.equal(fs.readFileSync(closeout.report_path,'utf8'),input(f).result);
  assert.equal(wb.get('tasks',f.contributor.tid).acceptance_record,undefined);
  const savedRun=JSON.stringify(wb.get('runs',f.contributor.rid)),savedTask=JSON.stringify(wb.get('tasks',f.contributor.tid));
  const repeated=completeIntegratedCloseout(wb,{...input(f),result:'这是另一次管理请求提供的新报告，不得覆盖当前交付已经保存的整合收尾事实。'},f.caller,instruction);
  assert.equal(repeated.already_completed,true);assert.match(repeated.note!,/append_note/);
  assert.equal(JSON.stringify(wb.get('runs',f.contributor.rid)),savedRun);assert.equal(JSON.stringify(wb.get('tasks',f.contributor.tid)),savedTask);
  assert.equal(fs.readFileSync(closeout.report_path,'utf8'),result.closeout.result);
 }finally{wb.close()}
});

test('manager如实记manager；覆盖变化作为未验证项而非收尾许可',()=>{
 const f=pair(),{wb}=f;try{
  fs.writeFileSync(f.file,'later integrated source');
  const source=wb.get('runs',f.main.rid);source.deployment_evidence={verification:'executor_reported',version:'old-synthetic-version'};wb.put('runs',source,{task_id:source.task_id});
  const caller:ManagementCaller={role:'manager',id:'manager:session'},result=completeIntegratedCloseout(wb,input(f),caller,instruction);
  assert.equal(result.closeout.recorded_by.id,caller.id);assert.equal(result.closeout.recorded_by.agent_id,undefined);
  assert.equal(result.closeout.integration.coverage[0].status,'source_changed');assert.equal(result.status,'awaiting_confirmation');
  assert.match(result.closeout.verification_warnings.join('\n'),/覆盖未核实/);
  assert.equal(result.closeout.integration.deployment_applicability.status,'unverified');
  assert.match(result.closeout.verification_warnings.join('\n'),/已有部署记录的当前适用性未确认/);
 }finally{wb.close()}
});

test('没有受审文件范围仍可真实收尾并说明覆盖未知',()=>{
 const f=pair(),{wb}=f;try{
  const r=wb.get('runs',f.contributor.rid);r.review_files=[];wb.put('runs',r,{task_id:r.task_id});
  const result=completeIntegratedCloseout(wb,input(f),f.caller,instruction);
  assert.equal(result.status,'awaiting_confirmation');assert.equal(result.closeout.integration.coverage.length,0);
  assert.match(result.closeout.verification_warnings.join('\n'),/未列出受审文件/);
 }finally{wb.close()}
});

test('主单通过报告仅作引用事实，不复制成Claude的审查结论',()=>{
 const f=pair(),{wb}=f;try{
  const review=wb.review({run_id:f.main.rid,reviewer_id:'grok-build',performed:true,evidence:'隔离测试审查事实：只审查主Run的当前产物及代码',verdict:'passed',artifact_hashes:wb.runRows('artifacts',f.main.rid).filter(a=>a.current).map(a=>a.sha256)});
  const result=completeIntegratedCloseout(wb,input(f),f.caller,instruction),integration=result.closeout.integration;
  assert.equal(integration.source.review.review_status,'passed');assert.equal(integration.source.review.review_id,review.id);
  assert.equal(integration.target.review.review_status,'unconfirmed');assert.equal(integration.target.review.review_id,null);
  assert.equal(wb.runRows('reviews',f.contributor.rid).length,0);assert.equal(wb.all('reviews').length,1);
 }finally{wb.close()}
});

test('整合收尾校验双方当前版本、已交付和归档真实性，失败不改状态',()=>{
 const f=pair(),{wb}=f;try{
  const initial=JSON.stringify(wb.get('tasks',f.contributor.tid));
  assert.throws(()=>completeIntegratedCloseout(wb,{...input(f),source_expected_revision:1},f.caller,instruction),/已变化/);
  assert.throws(()=>completeIntegratedCloseout(wb,{...input(f),expected_revision:1},f.caller,instruction),/已变化/);
  assert.throws(()=>completeIntegratedCloseout(wb,input(f),{...f.caller,project_id:'wrong',project_ids:['wrong']},instruction),/项目范围/);
  const source=wb.get('runs',f.main.rid);source.status='running';wb.put('runs',source,{task_id:source.task_id});
  assert.throws(()=>completeIntegratedCloseout(wb,input(f),f.caller,instruction),/正式交付/);source.status='submitted';wb.put('runs',source,{task_id:source.task_id});
  const artifact=wb.runRows('artifacts',source.id).find(a=>a.current)!;fs.writeFileSync(artifact.archive_path,'corrupt synthetic archive');
  assert.throws(()=>completeIntegratedCloseout(wb,input(f),f.caller,instruction),/归档产物已变化/);
  assert.equal(JSON.stringify(wb.get('tasks',f.contributor.tid)),initial);assert.equal(wb.get('runs',f.contributor.rid).closeout,undefined);
 }finally{wb.close()}
});

test('显式目标不扩散到其他依赖任务；旧revision重复提交不能覆盖已记录收尾',()=>{
 const f=pair(),{wb}=f;try{
  const extra=setup(wb,f.root),t=wb.get('tasks',f.main.tid);t.dependencies=[f.contributor.tid,extra.tid];wb.put('tasks',t,{project_id:t.project_id});
  const untouched=JSON.stringify(wb.get('tasks',extra.tid)),v=input(f);completeIntegratedCloseout(wb,v,f.caller,instruction);
  assert.equal(JSON.stringify(wb.get('tasks',extra.tid)),untouched);
  assert.throws(()=>completeIntegratedCloseout(wb,v,f.caller,instruction),/已变化/);
 }finally{wb.close()}
});

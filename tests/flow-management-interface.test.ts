import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event,taskInput} from './helpers.ts';
import {createApp} from '../src/server/app.ts';

test('真实MCP管理入口：Codex为Claude补事实并整合收尾，幂等、真实actor和跨项目边界保持',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
 try{
  const main=setup(wb,f.root),target=setup(wb,f.root),targetTask=wb.get('tasks',target.tid),targetRun=wb.get('runs',target.rid);
  targetTask.agent_id='claude';targetRun.agent_id='claude';wb.put('tasks',targetTask,{project_id:targetTask.project_id});wb.put('runs',targetRun,{task_id:target.tid});
  for(const s of [main,target]){
   const identity=s===main?'codex':'claude';
   assert.equal(wb.event(event(f.root,s.tid,s.rid,1,'started',{identity})).disposition,'applied');
   assert.equal(wb.event(event(f.root,s.tid,s.rid,2,'submitted',{identity,result:'合成HTTP集成测试正式交付；验证管理接线与实际凭据身份，不代表生产交付。'})).disposition,'applied');
  }
  const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',main.rid+'.json'),'utf8')).token;
  const call=async(tool:string,payload:any)=>{const res=await app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+token},payload:{run_id:main.rid,...payload}});return {status:res.statusCode,data:res.json()};};
  const envelope=(change:any)=>({request_id:crypto.randomUUID(),user_instruction:'用户明确要求：当前Codex整合负责人给Claude协作单补充事实并统一收尾，保留真实来源，等待用户试用。',change});
  const narrow=await call('get_management_context',{section:'tasks',task_id:target.tid});assert.equal(narrow.status,200);assert.equal(narrow.data.tasks.length,1);assert.equal(narrow.data.tasks[0].id,target.tid);assert.equal(narrow.data.task_detail.task_id,target.tid);assert(narrow.data.task_operations.append_note);
  const noteInput={task_id:target.tid,run_id:target.rid,expected_revision:wb.get('tasks',target.tid).revision,note:'Codex记录：已收到Claude交付，后续整合证据由主Run负责；本备注不是Claude执行回执。',references:[{kind:'run',value:main.rid}]};
  const noteRequest=envelope({action:'append_note',data:noteInput}),eventsBefore=wb.all('events').length,targetStatus=wb.get('tasks',target.tid).status;
  const firstNote=await call('manage_tasks',noteRequest);assert.equal(firstNote.status,200,JSON.stringify(firstNote.data));assert.equal(firstNote.data.status,'completed');
  assert.equal(firstNote.data.result.note.actor,'runner:'+main.rid);assert.equal(wb.get('tasks',target.tid).status,targetStatus);
  const revision=wb.get('tasks',target.tid).revision;
  const replayNote=await call('manage_tasks',noteRequest);assert.equal(replayNote.status,200);assert.deepEqual(replayNote.data.result,firstNote.data.result);
  assert.equal(wb.get('tasks',target.tid).revision,revision);assert.equal(wb.get('runs',target.rid).notes.length,1);
  const conflict=await call('manage_tasks',{...noteRequest,change:{...noteRequest.change,data:{...noteInput,note:'同一请求编号换成不同内容，应当拒绝。'}}});assert.equal(conflict.status,409,JSON.stringify(conflict.data));
  const spoofedNote=await call('manage_tasks',envelope({action:'append_note',data:{...noteInput,expected_revision:revision,actor:'claude'}}));assert.equal(spoofedNote.status,400);
  const sourceBefore=JSON.stringify(wb.get('runs',main.rid)),targetAuthor=wb.get('runs',target.rid).agent_id;
  const integrated=envelope({action:'complete_integrated_closeout',data:{task_id:target.tid,run_id:target.rid,expected_revision:revision,source_run_id:main.rid,source_expected_revision:wb.get('tasks',main.tid).revision,result:'Codex整合负责人已核对Claude交付和补充事实；本次暂无独立审查及部署证据，相关限制如实保留，交由用户试用。',closeout_results:[],limitations:['合成测试没有调用外部审查或实际部署']}});
  const done=await call('manage_tasks',integrated);assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.result.status,'awaiting_confirmation');
  const saved=wb.get('runs',target.rid),closeout=saved.closeout;assert.equal(closeout.source,'integration_owner');assert.equal(closeout.recorded_by.id,'runner:'+main.rid);assert.equal(closeout.recorded_by.agent_id,'codex');
  assert.equal(closeout.integration.target.agent_id,'claude');assert.equal(saved.agent_id,targetAuthor);assert.equal(saved.status,'submitted');
  assert.equal(wb.all('events').length,eventsBefore);assert.equal(wb.all('reviews').length,0);assert.equal(JSON.stringify(wb.get('runs',main.rid)),sourceBefore);
  assert.equal(wb.get('tasks',target.tid).acceptance_record,undefined);assert.match(closeout.verification_warnings.join('\n'),/审查/);
  const savedBytes=fs.readFileSync(closeout.report_path,'utf8'),savedTask=JSON.stringify(wb.get('tasks',target.tid));
  const replayDone=await call('manage_tasks',integrated);assert.equal(replayDone.status,200);assert.deepEqual(replayDone.data.result,done.data.result);assert.equal(JSON.stringify(wb.get('tasks',target.tid)),savedTask);assert.equal(fs.readFileSync(closeout.report_path,'utf8'),savedBytes);
  assert.equal((await call('manage_tasks',{...integrated,change:{...integrated.change,data:{...integrated.change.data,result:'同一个管理请求编号不能换一份收尾报告；需要保留先前报告和实际actor来源。'}}})).status,409);
  const oldApi=await call('complete_run_closeout',{run_id:target.rid,event_id:'http-boundary-'+crypto.randomUUID(),result:'原始执行者收尾入口由Codex凭据绑定，只能回报Codex本人Run，不能假冒Claude目标。',closeout_results:[]});
  assert([401,403].includes(oldApi.status),JSON.stringify(oldApi.data));assert.equal(JSON.stringify(wb.get('runs',target.rid)),JSON.stringify(saved));assert.equal(fs.readFileSync(closeout.report_path,'utf8'),savedBytes);
  const foreignRoot=path.join(f.root,'foreign-project');fs.mkdirSync(foreignRoot);const p=wb.registerProject({name:'隔离跨项目边界',path:foreignRoot}),q=wb.request({project_id:p.id,text:'另一项目的合成任务'});
  const plan=wb.submitPlan({schema_version:1,plan_id:'foreign-'+crypto.randomUUID(),request_id:q.id,expected_version:1,tasks:[taskInput(foreignRoot)]}),foreign=wb.exportOrder(plan.task_ids[0],1),foreignTask=wb.get('tasks',plan.task_ids[0]);
  assert.equal((await call('manage_tasks',envelope({action:'append_note',data:{task_id:foreignTask.id,run_id:foreign.run_id,expected_revision:foreignTask.revision,note:'未授权跨项目备注应拒绝。'}}))).status,403);
  assert.equal((await call('manage_tasks',envelope({action:'complete_integrated_closeout',data:{...integrated.change.data,task_id:foreignTask.id,run_id:foreign.run_id,expected_revision:foreignTask.revision,source_expected_revision:wb.get('tasks',main.tid).revision}}))).status,403);
  assert.equal(wb.get('tasks',foreignTask.id).status,foreignTask.status);assert.equal(wb.get('runs',foreign.run_id).closeout,undefined);
 }finally{await app.close();}
});

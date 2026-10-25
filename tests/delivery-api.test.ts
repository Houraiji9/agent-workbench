import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
import {taskInput,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {chatPlanningContext} from '../src/core/chat-planning.ts';
import {executionContext,dispatchBrief} from '../src/core/execution-context.ts';
import {getCloseoutContext,assertCloseoutComplete} from '../src/core/closeout.ts';

async function fixture(){const output=process.env.WORKBENCH_TEST_OUTPUT_DIR||path.join(ROOT,'.test-tmp','delivery-api');fs.mkdirSync(output,{recursive:true});const root=fs.mkdtempSync(path.join(output,'delivery-api-'));const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'UTC',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};seedTestData(new Workbench(config)).close();return {root,...await createApp(config,{background:false})};}
const profile={schema:1,artifacts:['source','service'],artifact_description:'合成服务交付',deployment:{mode:'remote',target:'测试远程环境',deploy:'安装已审版本',health:'检查合成健康结果',rollback:'保留部署前版本',verification:'executor_reported'}};
function plan(root:string,q:any){return {schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(root),reviewer_id:null,importance:'normal',delivery_profile:profile}]};}
test('remote delivery survives request, chat planning, Run, runner-scoped evidence and closeout without a local runtime',async()=>{
 const f=await fixture();try{
  const q=f.wb.request({project_id:'P-workbench',text:'合成线上机器人交付，不访问真实服务器',importance:'normal',delivery_profile:profile,skip_review:true,review_note:'本隔离协议测试由用户显式免审'});
  const chat=chatPlanningContext(f.wb,q.id);assert.equal(chat.request.delivery_profile.deployment.mode,'remote');assert.equal(chat.plan_template.tasks[0].importance,'normal');
  const brief=dispatchBrief(f.wb.dispatchContext(),'P-workbench');assert.equal(brief.requests.find((r:any)=>r.id===q.id).delivery_profile.deployment.mode,'remote');
  const saved=f.wb.submitPlan(plan(f.root,q)),tid=saved.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;
  const run=f.wb.get('runs',rid);assert.equal(run.execution_contract.delivery_profile.deployment.mode,'remote');assert.equal(run.execution_contract.runtime_root,null);
  const ctx=executionContext(f.wb,{run_id:rid,mode:'brief'});assert.equal(ctx.context.delivery_profile.deployment.target,profile.deployment.target);
  assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');
  const submitted=f.wb.event(event(f.root,tid,rid,2,'submitted',{result:'已交付合成服务版本，仅供协议测试，未访问或更新任何真实线上项目。',delivery_version:'synthetic-v1'}));assert.equal(submitted.disposition,'applied');
  const token=JSON.parse(fs.readFileSync(path.join(f.wb.config.dataDir,'run-keys',rid+'.json'),'utf8')).token;
  const call=(tool:string,payload:any,key=token)=>f.app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:14317',authorization:'Bearer '+key},payload:{run_id:rid,...payload}});
  assert.equal((await call('get_deployment_context',{},f.wb.keys.manager)).statusCode,403);
  const response=await call('get_deployment_context',{});assert.equal(response.statusCode,200,response.body);const template=response.json().report_template;
  const receipt={...template,deployment_evidence:'隔离测试中的版本已部署',health_evidence:'合成健康检查通过',rollback_evidence:'合成旧版本备份可用'};
  assert.equal((await call('report_deployment_evidence',{...receipt,version:'wrong'})).statusCode,409);
  assert.equal((await call('report_deployment_evidence',{...receipt,profile_sha256:'f'.repeat(64)})).statusCode,409);
  assert.equal((await call('report_deployment_evidence',receipt,f.wb.keys.planner)).statusCode,403);
  const recorded=await call('report_deployment_evidence',receipt);assert.equal(recorded.statusCode,200,recorded.body);assert.match(recorded.json().verification_note,/未验证实际部署/);
  const closeout=getCloseoutContext(f.wb,rid);
  const completed=await call('complete_run_closeout',{event_id:'test-closeout',result:'隔离合成任务已逐项完成交付和回执校验，等待用户本人试用确认。',closeout_results:closeout.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试真实核对了对应字段'}))});assert.equal(completed.statusCode,200,completed.body);assert.equal(completed.json().task_status,'awaiting_confirmation');
  assert.doesNotThrow(()=>assertCloseoutComplete(f.wb,f.wb.get('tasks',tid),f.wb.get('runs',rid)));
  assert.equal((await call('report_deployment_evidence',receipt)).statusCode,409);
 }finally{await f.app.close();}
});
test('critical remains independent of size and rejects weakened review or missing model decisions atomically',async()=>{
 const f=await fixture();try{
  const p=f.wb.get('projects','P-workbench');f.wb.editProject(p.id,{version:p.version,changes:{name:p.name,goal:p.goal||'',stage:p.stage||'',next_step:p.next_step||'',importance:'critical',delivery_profile:profile}});
  assert.throws(()=>f.wb.request({project_id:p.id,text:'合成重点需求',workflow_kind:'small',review_mode:'light',review_focus:['合成检查']}),/完整独立审查/);
  const q=f.wb.request({project_id:p.id,text:'合成重点小需求',workflow_kind:'small'});assert.equal(q.importance,'critical');assert.equal(q.workflow_kind,'small');
  const proposal=plan(f.root,q);proposal.tasks[0]={...proposal.tasks[0],importance:'critical',reviewer_id:'grok-build'} as any;
  assert.throws(()=>f.wb.submitPlan(proposal),/明确模型选择/);assert.equal(f.wb.all('tasks').length,0);assert.equal(f.wb.get('requests',q.id).status,'awaiting_planning');
  const choices=[{agent_id:'codex',model:'gpt-6-astra',reason:'仅合成测试的最佳模型声明'},{agent_id:'grok-build',model:'grok-4.7-build-fast',reason:'仅合成测试的独立审查声明'}];
  Object.assign(proposal.tasks[0],{requested_model:choices[0].model,model_selection:{strategy:'best_capability',main:choices[0],review:choices[1],children:[],fallback_policy:'stop_and_replan',evaluation:{criteria:'仅验证模型选择合同，不代表实际能力测评',catalog_as_of:'2026-10-25',considered:choices.map(c=>({...c,reason:undefined,capability_assessment:'best_capability',capability_reason:'合成能力比较依据',availability:'available',availability_reason:'合成隔离测试资源'}))}}});
  for(const c of (proposal.tasks[0] as any).model_selection.evaluation.considered)delete c.reason;
  const saved=f.wb.submitPlan(proposal),tid=saved.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id;
  assert.equal(f.wb.get('runs',rid).execution_contract.model_selection.main.model,'gpt-6-astra');
  assert.match(fs.readFileSync(f.wb.get('runs',rid).order_path,'utf8'),/需求重要程度：重点/);
  const ordinary=f.wb.request({project_id:p.id,text:'用户覆盖为普通',importance:'normal'});assert.equal(ordinary.importance,'normal');assert.equal(ordinary.delivery_profile.deployment.mode,'remote');
 }finally{await f.app.close();}
});

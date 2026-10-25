import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
import {taskInput,event} from './helpers.ts';
import {normalizePolicy,resolvePolicy,runTask,saveTaskPolicy,saveProjectPolicy,registerDelegation,reportDelegation} from '../src/core/workflow-policy.ts';

function isolated(){const base=process.env.PROJECT_MANAGEMENT_TEST_ROOT||path.join(ROOT,'.test-tmp','project-management-boundaries');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'policy-'));const config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};return {root,wb:seedTestData(new Workbench(config))};}
const policy=(patch:Record<string,unknown>={})=>normalizePolicy({main_model:'gpt-6.1-sol',allow_subagents:true,child_models:['gpt-6-luna'],max_calls:6,max_concurrency:4,max_depth:2,...patch});
function planned(wb:Workbench,root:string,p=policy()){
  const q=wb.request({project_id:'P-workbench',text:'隔离策略边界验证，不执行真实客户端'}),result=wb.submitPlan({schema_version:1,plan_id:'test-policy-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(root),execution_policy:p}]});
  const tid=result.task_ids[0];return {tid,order:()=>wb.exportOrder(tid,1)};
}
function running(wb:Workbench,root:string,p=policy()) {const {tid,order}=planned(wb,root,p),rid=order().run_id;assert.equal(wb.event(event(root,tid,rid,1)).disposition,'applied');return {tid,rid};}
function child(root:string,rid:string,patch:Record<string,unknown>={}){return {run_id:rid,request_id:crypto.randomUUID(),model:'gpt-6-luna',goal:'只验证隔离委派授权边界',parent_id:null,required_files:[],allowed_paths:[root],output_dir:root,context_bytes:1024,...patch};}

test('execution policy precedence is user request, planner task, project default, then neutral default',()=>{
  const project={execution_policy:policy({max_calls:1})},task={execution_policy:policy({max_calls:2})},request={execution_policy:policy({max_calls:3})};
  assert.equal(resolvePolicy(project,task,request).policy.max_calls,3);assert.equal(resolvePolicy(project,task,request).source,'user_request');
  assert.equal(resolvePolicy(project,task).policy.max_calls,2);assert.equal(resolvePolicy(project,task).source,'planner');
  assert.equal(resolvePolicy(project,{}).policy.max_calls,1);assert.equal(resolvePolicy(project,{}).source,'project_default');
  assert.equal(resolvePolicy({},{}).policy.allow_subagents,false);assert.equal(resolvePolicy({},{}).source,'default');
});
test('real Run policy is frozen against later mutable Task and project defaults; pre-run user override is honored',()=>{
  const f=isolated();try{const {tid}=planned(f.wb,f.root),task=f.wb.get('tasks',tid),chosen=policy({main_model:'gpt-6-sol',max_calls:2});
    const saved=saveTaskPolicy(f.wb,tid,{revision:task.revision,execution_policy:chosen});assert.equal(saved.policy_source,'user_task');
    const rid=f.wb.exportOrder(tid,1).run_id,run=f.wb.get('runs',rid),digest=run.execution_contract.digest;
    assert.equal(run.requested_model,'gpt-6-sol');assert.equal(run.execution_contract.execution_policy.max_calls,2);
    const mutated=f.wb.get('tasks',tid);f.wb.put('tasks',{...mutated,execution_policy:policy({max_calls:29}),requested_model:'gpt-6-astra'},{project_id:mutated.project_id});
    const project=f.wb.get('projects','P-workbench');saveProjectPolicy(f.wb,project.id,{version:project.version,agent_id:'codex',execution_policy:policy({max_calls:30})});
    const effective=runTask(f.wb.get('tasks',tid),f.wb.get('runs',rid));assert.equal(effective.execution_policy.max_calls,2);assert.equal(effective.requested_model,'gpt-6-sol');assert.equal(f.wb.get('runs',rid).execution_contract.digest,digest);
    assert.throws(()=>saveTaskPolicy(f.wb,tid,{revision:mutated.revision,execution_policy:chosen}),/冻结/);
  }finally{f.wb.close();}
});
test('stale policy revisions are rejected without replacing valid user settings',()=>{
  const f=isolated();try{const {tid}=planned(f.wb,f.root),task=f.wb.get('tasks',tid),valid=policy({max_calls:1});saveTaskPolicy(f.wb,tid,{revision:task.revision,execution_policy:valid});
    assert.throws(()=>saveTaskPolicy(f.wb,tid,{revision:task.revision,execution_policy:policy({max_calls:2})}),/变化/);assert.equal(f.wb.get('tasks',tid).execution_policy.max_calls,1);
    const p=f.wb.get('projects','P-workbench');saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'codex',execution_policy:valid});assert.throws(()=>saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'codex',execution_policy:policy({max_calls:3})}),/变化/);
  }finally{f.wb.close();}
});
test('explicit model override on a new Run keeps its frozen policy consistent and leaves old Run unchanged',()=>{
  const f=isolated();try{const {tid,rid}=running(f.wb,f.root,policy({main_model:'gpt-6.1-sol'})),oldContract=f.wb.get('runs',rid).execution_contract;
    assert.equal(f.wb.event(event(f.root,tid,rid,2,'failed',{message:'隔离测试结束本次执行以检查新的设置'})).disposition,'applied');
    const current=f.wb.get('tasks',tid),next=f.wb.exportOrder(tid,1,true,undefined,current.revision,'gpt-6-sol'),run=f.wb.get('runs',next.run_id);
    assert.notEqual(run.id,rid);assert.equal(run.requested_model,'gpt-6-sol');assert.equal(run.execution_contract.requested_model,'gpt-6-sol');
    assert.equal(run.execution_contract.execution_policy.main_model,'gpt-6-sol','frozen policy must describe the model explicitly chosen for the new Run');assert.deepEqual(f.wb.get('runs',rid).execution_contract,oldContract);
  }finally{f.wb.close();}
});
test('delegations enforce idempotency, live concurrency and lifetime call limits using actual DB rows',()=>{
  const f=isolated();try{const {rid}=running(f.wb,f.root,policy({max_calls:2,max_concurrency:1})),input=child(f.root,rid),first=registerDelegation(f.wb,input);
    assert.equal(registerDelegation(f.wb,input).id,first.id);assert.throws(()=>registerDelegation(f.wb,{...input,goal:'同编号更改内容必须拒绝'}),/冲突/);
    assert.throws(()=>registerDelegation(f.wb,child(f.root,rid)),/并发/);assert.equal(f.wb.all('delegations').length,1);
    const completed=reportDelegation(f.wb,{run_id:rid,delegation_id:first.id,status:'completed',actual_model:'gpt-6-luna',summary:'隔离测试完成'});assert.equal(completed.observed_by,'executor_reported');
    const second=registerDelegation(f.wb,child(f.root,rid));reportDelegation(f.wb,{run_id:rid,delegation_id:second.id,status:'cancelled'});
    assert.throws(()=>registerDelegation(f.wb,child(f.root,rid)),/次数/);assert.equal(f.wb.all('delegations').length,2);
  }finally{f.wb.close();}
});
test('delegation policy rejects disabled delegation, wrong model, excess depth and context',()=>{
  const f=isolated();try{const disabled=running(f.wb,f.root,policy({allow_subagents:false}));assert.throws(()=>registerDelegation(f.wb,child(f.root,disabled.rid)),/未允许/);
    const {rid}=running(f.wb,f.root,policy({max_depth:1,context_bytes:1024}));assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{model:'gpt-6-astra'})),/允许名单/);assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{context_bytes:1025})),/上下文/);
    const parent=registerDelegation(f.wb,child(f.root,rid));assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{parent_id:parent.id})),/层数/);
    assert.equal(f.wb.all('delegations').filter(d=>d.run_id===rid).length,1);
  }finally{f.wb.close();}
});
test('delegation paths cannot escape Task, parent scope, protected data or a junction to the data directory',()=>{
  const f=isolated();try{const {rid}=running(f.wb,f.root),allowed=path.join(f.root,'child');fs.mkdirSync(allowed);const other=path.join(f.root,'other');fs.mkdirSync(other);const required=path.join(other,'context.txt');fs.writeFileSync(required,'synthetic context');
    const parent=registerDelegation(f.wb,child(f.root,rid,{allowed_paths:[allowed],output_dir:allowed}));
    for(const patch of [{allowed_paths:[path.dirname(f.root)],output_dir:path.dirname(f.root)},{allowed_paths:[f.wb.config.dataDir],output_dir:f.wb.config.dataDir},{allowed_paths:[allowed],output_dir:other}])assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,patch)));
    assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{parent_id:parent.id,allowed_paths:[other],output_dir:other})),/路径|授权|范围|目录/);
    assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{parent_id:parent.id,allowed_paths:[allowed],output_dir:allowed,required_files:[required]})),/父委派范围/);
    const link=path.join(f.root,'data-link');fs.symlinkSync(f.wb.config.dataDir,link,'junction');assert.throws(()=>registerDelegation(f.wb,child(f.root,rid,{allowed_paths:[link],output_dir:link})));assert.equal(f.wb.all('delegations').length,1);
  }finally{f.wb.close();}
});
test('cross-Run parent and reports, unauthorized actual model and replacement of terminal report are rejected',()=>{
  const f=isolated();try{const a=running(f.wb,f.root),b=running(f.wb,f.root),first=registerDelegation(f.wb,child(f.root,a.rid));
    assert.throws(()=>registerDelegation(f.wb,child(f.root,b.rid,{parent_id:first.id})),/父委派/);
    assert.throws(()=>reportDelegation(f.wb,{run_id:b.rid,delegation_id:first.id,status:'completed'}),/跨执行/);
    assert.throws(()=>reportDelegation(f.wb,{run_id:a.rid,delegation_id:first.id,status:'running',actual_model:'gpt-6-astra'}),/模型不在授权/);
    const body={run_id:a.rid,delegation_id:first.id,status:'completed',actual_model:'gpt-6-luna',summary:'隔离回执只验证记录'};reportDelegation(f.wb,body);assert.equal(reportDelegation(f.wb,body).status,'completed');assert.throws(()=>reportDelegation(f.wb,{...body,summary:'禁止覆盖已结束回执'}),/已结束/);
  }finally{f.wb.close();}
});
test('a previous Run cannot create new delegations after a replacement Run becomes current',()=>{
  const f=isolated();try{const {tid,rid}=running(f.wb,f.root);assert.equal(f.wb.event(event(f.root,tid,rid,2,'failed')).disposition,'applied');const task=f.wb.get('tasks',tid);f.wb.exportOrder(tid,1,true,undefined,task.revision);
    assert.throws(()=>registerDelegation(f.wb,child(f.root,rid)),/当前正在执行/);assert.equal(f.wb.all('delegations').length,0);
  }finally{f.wb.close();}
});

test('project model defaults are validated per Agent and cannot poison another Agent plan',()=>{
 const f=isolated();try{
  let p=f.wb.get('projects','P-workbench');const z=normalizePolicy({main_model:'GLM-5.3'});
  assert.throws(()=>saveProjectPolicy(f.wb,p.id,{version:p.version,execution_policy:z}),/Agent/);
  assert.throws(()=>saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'claude',execution_policy:z}),/模型列表/);
  assert.throws(()=>saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'codex',execution_policy:normalizePolicy({child_models:['GLM-5.3']})}),/模型列表/);
  assert.equal(f.wb.get('projects',p.id).version,p.version);
  p=saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'zcode',execution_policy:z});
  p=saveProjectPolicy(f.wb,p.id,{version:p.version,agent_id:'codex',execution_policy:policy({max_calls:2})});
  assert.equal(resolvePolicy(p,{agent_id:'zcode'}).policy.main_model,'GLM-5.3');
  assert.equal(resolvePolicy(p,{agent_id:'codex'}).policy.main_model,'gpt-6.1-sol');
  assert.equal(resolvePolicy(p,{agent_id:'claude'}).policy.main_model,null);
  const q=f.wb.request({project_id:p.id,text:'隔离验证其他成员仍可规划，不运行真实Agent'});
  const saved=f.wb.submitPlan({schema_version:1,plan_id:'scope-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(f.root),agent_id:'claude',requested_model:'claude-sonnet-5-5'}]});
  assert.equal(f.wb.get('tasks',saved.task_ids[0]).requested_model,'claude-sonnet-5-5');
  assert.equal(f.wb.get('projects',p.id).execution_policies.zcode.main_model,'GLM-5.3');
 }finally{f.wb.close();}
});
test('legacy unscoped project models are not silently imposed on any Agent; budgets remain',()=>{
 const p={execution_policy:policy({main_model:'GLM-5.3',child_models:['GLM-5.3-Flash'],max_calls:3})};
 const current=resolvePolicy(p,{agent_id:'claude'});assert.equal(current.policy.main_model,null);assert.deepEqual(current.policy.child_models,[]);assert.equal(current.policy.max_calls,3);
});

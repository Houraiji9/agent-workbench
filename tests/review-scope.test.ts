import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,type Config} from '../src/core/config.ts';
import {Workbench} from '../src/core/workbench.ts';
import {seedTestData} from './fixtures.ts';
import {taskInput,event} from './helpers.ts';
import {freezeExecutionContract,normalizePolicy} from '../src/core/workflow-policy.ts';
import {reviewScope} from '../src/core/review-scope.ts';
import {reviewContext} from '../src/core/review-context.ts';
import {exportReviewOrder,reviewAssignmentContext,startReview,submitReviewResult,reviewFeedbackOrder} from '../src/core/review-workflow.ts';
import {createApp} from '../src/server/app.ts';

test('limited review uses the Run frozen focus and keeps an explicit boundary after mutable Task policy changes',()=>{
  const task={id:'T',agent_id:'codex',reviewer_id:'grok-build',review_policy:{mode:'light',focus:['只检查下载链接和访问权限']},acceptance:['全部交互完成','下载链接和访问权限正确'],tests:['完整端到端回归','权限检查']},run={execution_contract:freezeExecutionContract(task,'codex',null)};
  const changed={...task,review_policy:{mode:'light',focus:['后来追加的其他功能']}};const scope=reviewScope(changed,run);assert.deepEqual(scope.focus,['只检查下载链接和访问权限']);assert.deepEqual(scope.acceptance,['只检查下载链接和访问权限']);assert.equal(scope.acceptance.includes('全部交互完成'),false);assert.match(scope.limitation,/不代表其他功能或全部验收标准通过/);
});
test('normal independent review keeps all acceptance criteria and checks without introducing a limited-review claim',()=>{
  const criteria=['支持键盘完成主要操作','拒绝未授权访问','关闭后可恢复记录'],checks=['键盘操作验证','权限边界测试','重启恢复验证'],task={agent_id:'codex',reviewer_id:'grok-build',review_policy:{mode:'required'},acceptance:criteria,tests:checks},run={execution_contract:freezeExecutionContract(task,'codex','gpt-6.1-sol')};
  const scope=reviewScope(task,run);assert.equal(scope.mode,'required');assert.deepEqual(scope.acceptance,criteria);assert.deepEqual(scope.tests,checks);assert.equal(scope.limitation,'');
});
function isolated(){const base=process.env.REVIEW_SCOPE_TEST_ROOT||path.join(ROOT,'.test-tmp','review-scope-boundaries');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'review-')),config:Config={root,dataDir:path.join(root,'data'),port:14317,timezone:'America/Los_Angeles',authorizedRoots:[root],integrations:{tokenMonitor:{baseUrl:''},agentsView:{baseUrl:''}}};return {root,wb:seedTestData(new Workbench(config))};}
test('review context and persisted result retain frozen light scope; automated rework inherits old authorization',()=>{
  const f=isolated();try{const originalPolicy=normalizePolicy({main_model:'gpt-6.1-sol',allow_subagents:true,child_models:['gpt-6-luna'],max_calls:2,max_depth:1}),q=f.wb.request({project_id:'P-workbench',text:'隔离有限审查与返修冻结策略测试',review_mode:'light',review_focus:['只核对本次权限和下载入口'],execution_policy:originalPolicy}),p=f.wb.submitPlan({schema_version:1,plan_id:'scope-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[taskInput(f.root)]}),tid=p.task_ids[0],rid=f.wb.exportOrder(tid,1).run_id,original=f.wb.get('runs',rid).execution_contract;
    assert.equal(f.wb.event(event(f.root,tid,rid,1)).disposition,'applied');assert.equal(f.wb.event(event(f.root,tid,rid,2,'submitted',{result:'隔离协议交付，用于测试有限审查和返修授权，未调用真实客户端或模型。'})).disposition,'applied');
    const task=f.wb.get('tasks',tid);f.wb.put('tasks',{...task,review_policy:{mode:'light',source:'user_requested',focus:['后来变动的Task范围，不应追改既有Run']},execution_policy:normalizePolicy({main_model:'gpt-6-luna',allow_subagents:false,max_calls:0})},{project_id:task.project_id});
    const order=exportReviewOrder(f.wb,{run_id:rid,reviewer_id:'grok-build',expected_revision:task.revision,reason:'隔离测试验证Run冻结范围'},{role:'user'}),base=reviewAssignmentContext(f.wb,order.review_id),context=reviewContext(f.wb,{review_id:order.review_id,mode:'brief'},base);
    assert.deepEqual(context.context.review_scope.focus,['只核对本次权限和下载入口']);assert.deepEqual(context.context.acceptance,['只核对本次权限和下载入口']);startReview(f.wb,{review_id:order.review_id,identity:'grok-build'});
    const receipt=submitReviewResult(f.wb,{review_id:order.review_id,task_id:tid,run_id:rid,review_digest:base.review_digest,verdict:'changes_requested',findings:['隔离测试发现入口权限仍需修改'],limitations:['这是隔离协议测试，不是真实独立审查'],evidence:['测试取得本Run冻结的有限审查上下文'],report_markdown:'# 隔离协议测试\n\n仅验证审查范围和返修授权的数据约束，不代表对真实产品的独立审查。'},'reviewer:'+order.review_id),review=f.wb.get('reviews',receipt.review.id);
    assert.deepEqual(review.review_scope.focus,['只核对本次权限和下载入口']);assert.ok(review.limitations.some((v:string)=>v.includes('不代表其他功能或全部验收标准通过')));
    const next=reviewFeedbackOrder(f.wb,rid,f.wb.get('tasks',tid).revision);assert.ok('run_id' in next,'changes_requested must create a new Run');const nextRun=f.wb.get('runs',next.run_id);assert.notEqual(nextRun.id,rid);assert.equal(nextRun.retry_context.previous_run_id,rid);assert.deepEqual({review_policy:nextRun.execution_contract.review_policy,execution_policy:nextRun.execution_contract.execution_policy},{review_policy:original.review_policy,execution_policy:original.execution_policy},'automatic rework must retain both the previous Run review scope and delegation/model authorization');assert.deepEqual(f.wb.get('runs',rid).execution_contract,original);
  }finally{f.wb.close();}
});
test('explicit page policy override creates a new frozen Run only after execution ends and preserves the old contract',async()=>{
  const f=isolated(),config=f.wb.config;f.wb.close();const server=await createApp(config,{background:false}),wb=server.wb;
  try{const originalPolicy=normalizePolicy({main_model:'gpt-6.1-sol',allow_subagents:false,max_calls:1}),q=wb.request({project_id:'P-workbench',text:'隔离页面显式变更新Run权限',review_mode:'light',review_focus:['只核对本次权限设置'],execution_policy:originalPolicy}),p=wb.submitPlan({schema_version:1,plan_id:'explicit-scope-'+crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[taskInput(f.root)]}),tid=p.task_ids[0],rid=wb.exportOrder(tid,1).run_id;
    assert.equal(wb.event(event(f.root,tid,rid,1)).disposition,'applied');const original=wb.get('runs',rid).execution_contract,host='127.0.0.1:'+config.port,boot=await server.app.inject({url:'/api/bootstrap',headers:{host}}),headers={host,cookie:String(boot.headers['set-cookie']).split(';')[0],'x-workbench-csrf':boot.json().csrf as string},url='/api/tasks/'+tid+'/new-policy-run',nextPolicy=normalizePolicy({main_model:'gpt-6-sol',allow_subagents:true,child_models:['gpt-6-luna'],max_calls:3,max_concurrency:2,max_depth:1}),call=(payload:unknown,auth=headers)=>server.app.inject({method:'POST',url,headers:auth,payload:payload as any});
    const body=()=>({revision:wb.get('tasks',tid).revision,execution_policy:nextPolicy});assert.equal((await call(body())).statusCode,409,'running execution cannot be replaced');assert.equal(wb.all('runs').length,1);assert.equal(wb.get('tasks',tid).current_run_id,rid);assert.deepEqual(wb.get('runs',rid).execution_contract,original);
    assert.equal(wb.event(event(f.root,tid,rid,2,'failed',{message:'隔离测试结束旧执行以选择新权限'})).disposition,'applied');const current=body();
    assert.equal((await server.app.inject({method:'POST',url,headers:{host,authorization:'Bearer '+wb.keys.manager},payload:current})).statusCode,401);assert.equal((await server.app.inject({method:'POST',url,headers:{...headers,authorization:'Bearer '+wb.keys.manager},payload:current})).statusCode,403);assert.equal((await server.app.inject({method:'POST',url,headers:{host,cookie:headers.cookie},payload:current})).statusCode,403);assert.equal((await call({...current,revision:current.revision-1})).statusCode,409);assert.equal(wb.all('runs').length,1);
    const response=await call(current);assert.equal(response.statusCode,200,response.body);const next=wb.get('runs',response.json().run_id);assert.notEqual(next.id,rid);assert.equal(next.requested_model,'gpt-6-sol');assert.deepEqual(next.execution_contract.execution_policy,nextPolicy);assert.equal(next.execution_contract.policy_source,'user_task');assert.deepEqual(next.execution_contract.review_policy,original.review_policy);assert.deepEqual(wb.get('runs',rid).execution_contract,original);assert.equal(wb.all('agent_jobs').length,0);
  }finally{await server.app.close();}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fixture,setup,event} from './helpers.ts';import {createApp} from '../src/server/app.ts';import {exportReviewOrder,startReview,submitReviewResult} from '../src/core/review-workflow.ts';import {runTask} from '../src/core/workflow-policy.ts';import {reviewProceedAuthority} from '../src/core/latest-review.ts';
async function environment(){const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});const s=setup(wb,f.root);wb.event(event(f.root,s.tid,s.rid,1));const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
 const call=async(tool:string,input:any,auth=token)=>{const r=await app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+auth},payload:{run_id:s.rid,...input}});return {status:r.statusCode,data:r.json()};};
 const manage=(tool:string,change:any,auth=token,extra:any={})=>call(tool,{request_id:crypto.randomUUID(),user_instruction:'用户口述：请直接在这个任务修改，保留历史，不再另开关联单。',change,...extra},auth);
 return {...f,app,wb,...s,call,manage,token};}
test('执行者会话在已开工同任务修改审查安排与范围，保留初始合约和操作来源',async()=>{const f=await environment();try{
 const contract=structuredClone(f.wb.get('runs',f.rid).execution_contract),before=f.wb.get('tasks',f.tid);
 const a=await f.manage('manage_reviews',{action:'set_arrangement',data:{run_id:f.rid,expected_revision:before.revision,reviewer_id:'claude',requested_model:'test-review-model',reason:'用户要求更换审查人员及明确模型'}});assert.equal(a.status,200,JSON.stringify(a.data));
 const current=f.wb.get('tasks',f.tid),run=f.wb.get('runs',f.rid);assert.equal(current.current_run_id,f.rid);assert.equal(current.status,'running');assert.deepEqual(run.execution_contract,contract);assert.equal(runTask(current,run).reviewer_id,'claude');
 const b=await f.manage('manage_tasks',{action:'amend',data:{task_id:f.tid,run_id:f.rid,expected_revision:current.revision,reason:'用户在本会话补充了验收内容',changes:{scope:'仍在本项目，补充已开工任务的交互要求',acceptance:['新增明确交互验收要求']}}});assert.equal(b.status,200,JSON.stringify(b.data));
 assert.equal(f.wb.all('tasks').length,1);assert.equal(f.wb.all('runs').length,1);assert.equal(f.wb.get('runs',f.rid).amendments.length,1);
 const audits=f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='amend_task'").all() as any[];assert.equal(audits[0].actor,'runner:'+f.rid);assert.match(JSON.parse(audits[0].data).user_instruction,/用户口述/);
 const detail=await f.call('get_task_detail',{task_id:f.tid});assert.equal(detail.status,200);assert.equal(detail.data.review_arrangement.requested_model,'test-review-model');
}finally{await f.app.close();}});
test('审查者原会话办理项目管理并用简洁报告回传本人结果，重试不重复建报告',async()=>{const f=await environment();try{
 const delivered=f.wb.event(event(f.root,f.tid,f.rid,2,'submitted',{result:'隔离测试交付，供独立审查验证简洁回传和真实身份绑定，不代表生产成果。'}));assert.equal(delivered.disposition,'applied',delivered.error);
 const order=exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:f.wb.get('tasks',f.tid).revision,reason:'独立审查测试入口'},{role:'user'}),reviewer=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',order.review_id+'.json'),'utf8')).token;
 const extra={review_id:order.review_id},context=await f.call('get_management_context',{section:'projects',...extra},reviewer);assert.equal(context.status,200);assert.equal(context.data.projects.length,1);
 const changed=await f.manage('manage_projects',{action:'update',project_id:'P-workbench',data:{version:f.wb.get('projects','P-workbench').version,changes:{stage:'审查者按用户口述更新阶段'}}},reviewer,extra);assert.equal(changed.status,200,JSON.stringify(changed.data));
 startReview(f.wb,{review_id:order.review_id,identity:'claude'});
 const short={...extra,verdict:'passed',findings:[],limitations:['合成账本测试，不代表真实独立审查'],evidence:['实际执行了本测试中的接单和回传接口'],report_markdown:'本报告为合成测试，用于验证简洁回传与身份绑定，不代表生产交付结论。'};
 // Review transport only carries its own assignment; no author-provided report import.
 const post=async()=>{const r=await f.app.inject({method:'POST',url:'/api/mcp/submit_review_report',headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+reviewer},payload:short});return r;};
 const first=await post();assert.equal(first.statusCode,200,first.body);assert.equal((await post()).statusCode,200);assert.equal(f.wb.all('reviews').length,1);assert.equal(f.wb.all('reviews')[0].reviewer_id,'claude');
 assert.equal((await f.call('submit_review_report',short)).status,403);
}finally{await f.app.close();}});
test('本项目会话不能借管理参数跨项目或借另一张审查凭据代填报告',async()=>{const f=await environment();try{
 const folder=path.join(f.root,'other-project');fs.mkdirSync(folder);const p=f.wb.registerProject({name:'另一项目',path:folder});
 const r=await f.manage('manage_projects',{action:'update',project_id:p.id,data:{version:p.version,changes:{stage:'越权测试'}}});assert.equal(r.status,403);
 assert.equal((await f.call('get_management_context',{section:'projects',project_id:p.id})).status,403);
 assert.equal((await f.manage('manage_settings',{action:'authorize_root',path:folder})).status,403);
 const linked=await f.manage('manage_projects',{action:'link_scope',project_id:p.id,reason:'用户明确在当前会话安排另一项目'});assert.equal(linked.status,200,JSON.stringify(linked.data));
 assert.equal((await f.manage('manage_projects',{action:'update',project_id:p.id,data:{version:p.version,changes:{stage:'用户关联后可直接办理'}}})).status,200);
 assert.equal((await f.call('get_management_context',{section:'projects',project_id:p.id})).data.projects[0].id,p.id);
}finally{await f.app.close();}});

test('同一交付可安排四位审查者，追加和移除不会改写其他成员或任务编号',async()=>{const f=await environment();try{
 const delivered=f.wb.event(event(f.root,f.tid,f.rid,2,'submitted',{result:'隔离多人协作测试交付，真实执行了成员安排接口，不代表真实模型审查。'}));assert.equal(delivered.disposition,'applied',delivered.error);
 const ids:string[]=[];for(const reviewer_id of ['claude','zcode','grok-build','deepseek']){const response=await f.manage('manage_reviews',{action:'assign',data:{run_id:f.rid,expected_revision:f.wb.get('tasks',f.tid).revision,reviewer_id,reason:'用户要求多位成员共同独立审查'}});assert.equal(response.status,200,JSON.stringify(response.data));ids.push(response.data.result.review_id);}
 let detail=await f.call('get_task_detail',{task_id:f.tid});assert.equal(detail.data.review_summary.counts.active,4);assert.equal(detail.data.review_summary.members.length,4);
 const remove=await f.manage('manage_reviews',{action:'update_member',data:{action:'remove',run_id:f.rid,review_id:ids[1],expected_revision:f.wb.get('tasks',f.tid).revision,reason:'用户调整其中一位的参与安排'}});assert.equal(remove.status,200,JSON.stringify(remove.data));
 detail=await f.call('get_task_detail',{task_id:f.tid});assert.equal(detail.data.review_summary.counts.active,3);assert.equal(detail.data.review_summary.members.length,4);assert.equal(f.wb.all('tasks').length,1);assert.equal(f.wb.all('runs').length,1);
}finally{await f.app.close();}});
test('范围补充使旧审查需要重新核验，但保留原报告和部署记录',async()=>{const f=await environment();try{
 const delivered=f.wb.event(event(f.root,f.tid,f.rid,2,'submitted',{result:'隔离测试原始交付与独立审查存档，验证修改范围后保留历史的行为，不代表生产成果。'}));assert.equal(delivered.disposition,'applied',delivered.error);
 const order=exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:f.wb.get('tasks',f.tid).revision,reason:'原始合成审查'},{role:'user'});startReview(f.wb,{review_id:order.review_id,identity:'claude'});
 const result=submitReviewResult(f.wb,{...order.context.report_template,verdict:'passed',findings:[],limitations:[],evidence:['合成测试证据'],report_markdown:'合成报告只用于测试历史保存和补充范围后的重新核验。'},'reviewer:'+order.review_id);
 const run=f.wb.get('runs',f.rid);run.deployment={verified:true,example:'synthetic historical record'};f.wb.put('runs',run,{task_id:f.tid});
 const r=await f.manage('manage_tasks',{action:'amend',data:{task_id:f.tid,run_id:f.rid,expected_revision:f.wb.get('tasks',f.tid).revision,reason:'用户要求在原任务补充新验收标准',changes:{acceptance:['补充标准需要重新核验']}}});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal(f.wb.get('reviews',result.review.id).verdict,'passed');assert.deepEqual(f.wb.get('runs',f.rid).deployment,run.deployment);assert.equal(reviewProceedAuthority(f.wb,f.rid).can_proceed,false);
}finally{await f.app.close();}});

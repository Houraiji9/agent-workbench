import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,setup,event,taskInput,finishCloseout} from './helpers.ts';
import {executionContext,finishRunCloseout} from '../src/core/execution-context.ts';
import {readRunContextFile} from '../src/core/execution-context.ts';
import {assertReviewerResources} from '../src/core/reviewer-resources.ts';
import {normalizePolicy,registerDelegation,reportDelegation} from '../src/core/workflow-policy.ts';
import {exportReviewOrder,reviewAssignmentContext,reviewFeedbackOrder} from '../src/core/review-workflow.ts';
import {revokeReview} from '../src/core/review-evidence.ts';
import {submitReviewReport} from '../src/core/review-submission.ts';
import {getCloseoutContext} from '../src/core/closeout.ts';
import {latestReview,reviewProceedAuthority} from '../src/core/latest-review.ts';
import {reportActivity,prepareContinuation} from '../src/core/execution-context.ts';
import {getDeploymentEvidenceContext,reportDeploymentEvidence,verifyDeploymentEvidence} from '../src/core/deployment-evidence.ts';

test('过期订阅、低额度快照和未验收前置是提示，不挡接单',()=>{
 const f=fixture();try{
  const first=setup(f.wb,f.root),q=f.wb.request({project_id:'P-workbench',text:'合成后续任务：前置尚未验收也可接单'});
  f.wb.put('quota_pools',{id:'low',source:'manual',provider:'grok',members:['grok-build'],status:'ok',freshness:'fresh',source_updated_at:new Date().toISOString()});
  f.wb.put('quota_windows',{id:'low-window',pool_id:'low',remaining_percent:0,freshness:'fresh',source_updated_at:new Date().toISOString(),resets_at:new Date(Date.now()+3600000).toISOString()},{pool_id:'low'});
  const resources=assertReviewerResources(f.wb,'grok-build');assert.equal(resources.assignable,true);assert.equal(resources.advisory,true);
  const p=f.wb.submitPlan({schema_version:1,plan_id:crypto.randomUUID(),request_id:q.id,expected_version:q.version,tasks:[{...taskInput(f.root),dependencies:[first.tid]}]});
  const task=f.wb.get('tasks',p.task_ids[0]);assert.equal(f.wb.assertDependencies(task).length,1);
  const run=f.wb.exportOrder(task.id,task.version);assert.equal(f.wb.event(event(f.root,task.id,run.run_id,1)).disposition,'applied');
 }finally{f.wb.close()}
});
test('补读不限建议清单和累计预算，继续保护其他项目与凭据',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid);t.context_contract={required:[],supplemental:[],output_dir:f.root,max_bytes:1024};f.wb.put('tasks',t,{project_id:t.project_id});
  const file=path.join(f.root,'additional.txt');fs.writeFileSync(file,'a'.repeat(1500));const read=readRunContextFile(f.wb,{run_id:s.rid,path:file});assert.equal(read.content.length,1500);assert.equal(read.warnings.length,2);assert.equal(read.usage.token_count,null);
  assert.throws(()=>readRunContextFile(f.wb,{run_id:s.rid,path:path.join(f.root,'..','unrelated.txt')}));
 }finally{f.wb.close()}
});
test('子代理可超规划建议登记，追加真实结果保留旧报告',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),r=f.wb.get('runs',s.rid);r.execution_contract.execution_policy=normalizePolicy({allow_subagents:false,max_calls:0,max_depth:0,context_bytes:1024});f.wb.put('runs',r,{task_id:r.task_id});
  const d=registerDelegation(f.wb,{run_id:r.id,request_id:crypto.randomUUID(),goal:'当前项目内自主委派小任务',required_files:[],allowed_paths:[f.root],output_dir:f.root,context_bytes:2048});assert(d.warnings.length>=3);
  reportDelegation(f.wb,{run_id:r.id,delegation_id:d.id,status:'completed',summary:'初次真实结果'});const updated=reportDelegation(f.wb,{run_id:r.id,delegation_id:d.id,status:'completed',summary:'追加实际核对结果'});assert.equal(updated.report_history[0].summary,'初次真实结果');
 }finally{f.wb.close()}
});
test('简版不重复完整合同，增量仅含变化，原始长要求仍可按需读取',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid);t.goal='长目标'.repeat(3000);t.scope='长范围'.repeat(3000);t.acceptance=Array.from({length:20},(_,i)=>`${i}:`+'长验收'.repeat(500));f.wb.put('tasks',t,{project_id:t.project_id});
  const brief=executionContext(f.wb,{run_id:s.rid}),full=executionContext(f.wb,{run_id:s.rid,mode:'full'});assert(brief.usage.characters<full.usage.characters*.3);assert.equal(full.context.goal,t.goal);assert.equal(brief.context.acceptance_total,20);assert(!brief.context.execution_contract);assert(brief.references.full);
  const delta=executionContext(f.wb,{run_id:s.rid,mode:'delta',known_context_hash:brief.context_hash});assert.deepEqual(delta.context,{});assert.equal(delta.reading.model_reading,'unknown');
 }finally{f.wb.close()}
});
const report={verdict:'passed',findings:[],limitations:[],evidence:['仅本测试合成材料'],report_markdown:'合成独立报告：此处只验证回传与版本归属，不代表真实项目经过独立审查。'};
test('同执行重新交付保留旧产物，晚到原审查可存档但不改变当前状态',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),deliver=(seq:number)=>f.wb.event(event(f.root,s.tid,s.rid,seq,'submitted',{result:'合成版本'+seq+'：直接交付，不依赖先报告 started；保留各次报告。'}));assert.equal(deliver(1).disposition,'applied');
  const a=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'合成审查'},{role:'runner',id:s.rid});
  const old=reviewAssignmentContext(f.wb,a.review_id);assert.equal(deliver(2).disposition,'applied');assert.equal(f.wb.get('runs',s.rid).delivery_history.length,1);assert(f.wb.all('artifacts').some(a=>a.current===false));
  const receipt=submitReviewReport(f.wb,{review_id:a.review_id,...report},'reviewer:'+a.review_id);assert.equal(receipt.review.review_digest,old.review_digest);assert.equal(f.wb.get('tasks',s.tid).status,'submitted');assert.equal(f.wb.get('review_assignments',a.review_id).status,'superseded');
 }finally{f.wb.close()}
});
test('审查期间源码变化允许回传但明确标注未核验变化',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),file=path.join(f.root,'source.ts');fs.writeFileSync(file,'first');f.wb.event(event(f.root,s.tid,s.rid,1,'submitted',{result:'合成源码交付，只验证源码变化不会拒收真实审查报告。',review_files:[file]}));
  const a=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'合成审查'},{role:'runner',id:s.rid});fs.writeFileSync(file,'changed');
  const receipt=submitReviewReport(f.wb,{review_id:a.review_id,...report},'reviewer:'+a.review_id);assert(receipt.review.limitations.some((s:string)=>s.includes('变化')));
 }finally{f.wb.close()}
});
test('收尾可登记未验证项，不冒充用户验收或审查通过',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1,'submitted',{result:'合成测试实际交付报告，用于验证未审查时也能保存收尾事实。'}));
  const c=getCloseoutContext(f.wb,s.rid);assert(c.closeout.id);
  const result=finishRunCloseout(f.wb,{run_id:s.rid,event_id:'EV-'+crypto.randomUUID(),result:'合成收尾：尚未独立审查，保存此事实等待后续核对，不声称用户已验收。',closeout_results:[]});assert.equal(result.disposition,'applied');assert.equal(f.wb.get('tasks',s.tid).status,'awaiting_confirmation');const r=f.wb.get('runs',s.rid);assert(r.closeout.verification_warnings.length);assert(r.closeout.unreported_items.length);assert.equal(f.wb.all('reviews').length,0);
 }finally{f.wb.close()}
});

test('旧版报告晚于新版通过仍只归档，重复回传幂等，不污染收尾依据',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),deliver=(seq:number)=>f.wb.event(event(f.root,s.tid,s.rid,seq,'submitted',{result:'合成版本交付，用于验证历史报告的真实归属与幂等。'+seq}));
  deliver(1);const create=()=>exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'合成审查',new_review:true},{role:'runner',id:s.rid});const old=create();deliver(2);const current=create();
  const passed=submitReviewReport(f.wb,{review_id:current.review_id,...report},'reviewer:'+current.review_id);
  const input={review_id:old.review_id,...report,verdict:'changes_requested',findings:['原版本问题']};const late=submitReviewReport(f.wb,input,'reviewer:'+old.review_id);
  assert.equal(late.review.historical,true);assert.equal(submitReviewReport(f.wb,input,'reviewer:'+old.review_id).review.id,late.review.id);assert.equal(latestReview(f.wb,s.rid)?.id,passed.review.id);assert.equal(reviewProceedAuthority(f.wb,s.rid).can_proceed,true);assert.equal(f.wb.all('reviews').length,2);
  const task=f.wb.get('tasks',s.tid),feedback=reviewFeedbackOrder(f.wb,s.rid,task.revision);assert(!feedback.text.includes('本审查者要求修改'));assert(feedback.text.includes('本审查者报告通过'));
  const closeout=f.wb.get('runs',s.rid).closeout.id;revokeReview(f.wb,late.review.id,{revision:task.revision,run_id:s.rid,reason:'撤回原版本历史意见，不改变当前结论'});assert.equal(f.wb.get('runs',s.rid).closeout.id,closeout);assert.equal(reviewProceedAuthority(f.wb,s.rid).can_proceed,true);
  finishCloseout(f.wb,s.tid);const ready=f.wb.get('tasks',s.tid);const accepted=f.wb.accept(s.tid,{revision:ready.revision,checks:[true]});assert.equal(accepted.acceptance_record.review_id,passed.review.id);
 }finally{f.wb.close()}
});

test('旧Run可补回报且不改当前任务；待试用仍可准备同会话续办',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1,'submitted',{result:'合成旧执行交付，验证晚到报告不会修改当前任务状态。'}));const next=f.wb.exportOrder(s.tid,1,true,undefined,f.wb.get('tasks',s.tid).revision);const before=JSON.stringify(f.wb.get('tasks',s.tid));
  const receipt=reportActivity(f.wb,{run_id:s.rid,event_id:'late-old-run',event_type:'progress',data:{message:'旧执行补充说明'}});assert.equal(receipt.disposition,'applied');assert.equal(JSON.stringify(f.wb.get('tasks',s.tid)),before);assert.equal(f.wb.get('runs',s.rid).seq,2);
  const task=f.wb.get('tasks',s.tid);task.status='awaiting_confirmation';f.wb.put('tasks',task,{project_id:task.project_id});assert.equal(prepareContinuation(f.wb,{task_id:s.tid,revision:task.revision,same_session:true}).run_id,next.run_id);
 }finally{f.wb.close()}
});

test('通用部署在未审查及待试用时均可回报，追加保留原始证据',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),r=f.wb.get('runs',s.rid);r.execution_contract.delivery_profile={schema:1,artifacts:['source','service'],artifact_description:'',deployment:{mode:'remote',target:'synthetic service',deploy:'synthetic upload',health:'synthetic health',rollback:'synthetic rollback',verification:'executor_reported'}};f.wb.put('runs',r,{task_id:s.tid});
  f.wb.event(event(f.root,s.tid,s.rid,1,'submitted',{result:'合成远程部署交付，不实际访问线上服务，只验证回执记录行为。',delivery_version:'test-r1'}));const input=getDeploymentEvidenceContext(f.wb,{run_id:s.rid}).report_template;const first=reportDeploymentEvidence(f.wb,input);assert.equal(first.review_pending,true);
  const task=f.wb.get('tasks',s.tid);task.status='awaiting_confirmation';f.wb.put('tasks',task,{project_id:task.project_id});reportDeploymentEvidence(f.wb,{...input,health_evidence:'追加合成核验记录'});const saved=f.wb.get('runs',s.rid);assert.equal(saved.deployment_evidence_history.length,1);assert.equal(verifyDeploymentEvidence(f.wb,task,saved).health_evidence,'追加合成核验记录');
 }finally{f.wb.close()}
});

test('验收记录绑定当前通过而不是最后到达的历史报告',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),deliver=(seq:number)=>f.wb.event(event(f.root,s.tid,s.rid,seq,'submitted',{result:'合成版本交付，用于验证最终确认记录不会绑定旧版本报告。'+seq}));const arrange=()=>exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'合成审查',new_review:true},{role:'runner',id:s.rid});
  deliver(1);const old=arrange();deliver(2);const current=arrange(),passed=submitReviewReport(f.wb,{review_id:current.review_id,...report},'reviewer:'+current.review_id);submitReviewReport(f.wb,{review_id:old.review_id,...report,verdict:'changes_requested',findings:['旧版问题']},'reviewer:'+old.review_id);finishCloseout(f.wb,s.tid);const task=f.wb.get('tasks',s.tid);assert.equal(f.wb.accept(s.tid,{revision:task.revision,checks:[true]}).acceptance_record.review_id,passed.review.id);
 }finally{f.wb.close()}
});

test('资格提示与越序收尾均留事实记录但不挡操作',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),agent=f.wb.get('agents','grok-build');agent.archived=true;f.wb.put('agents',agent);f.wb.event(event(f.root,s.tid,s.rid,1,'submitted',{result:'合成交付，检查提醒能被保存，不用提醒阻止真实操作。'}));const order=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'提示留存测试'},{role:'runner',id:s.rid});assert(f.wb.get('review_assignments',order.review_id).resource_warnings.some((x:string)=>x.includes('移出团队')));assert(f.wb.db.prepare("SELECT 1 FROM audit WHERE action='agent_eligibility_advice' AND entity_id=?").get(agent.id));
  const c=getCloseoutContext(f.wb,s.rid),done=f.wb.event(event(f.root,s.tid,s.rid,2,'closeout_completed',{closeout_id:c.closeout.id,result:'直接记录已发生的合成收尾事实，未先回报开始，用户尚未验收。',closeout_results:[]}));assert.equal(done.disposition,'applied');const advice=f.wb.db.prepare("SELECT data FROM audit WHERE action='workflow_advisory' AND entity_id=?").all(s.tid) as any[];assert(advice.some(row=>JSON.parse(row.data).event_type==='closeout_completed'));
 }finally{f.wb.close()}
});

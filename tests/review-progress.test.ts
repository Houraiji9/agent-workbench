import {test} from 'node:test';import assert from 'node:assert/strict';
import {reviewProgress,reviewMemberState} from '../src/shared/review-progress.ts';
import {relayOf} from '../src/web/lib/flow.ts';import {taskAction} from '../src/shared/workflow-view.ts';
import {reviewCollaboration,exportReviewOrder} from '../src/core/review-workflow.ts';
import {fixture,setup,event} from './agent-routing-fixture.ts';
const running=(id:string)=>({id,reviewer_id:id,status:'running',invocation:{status:'running'}});
const failed={...running('Grok'),invocation:{status:'failed',reason:'终端命令被客户端拒绝',process_may_be_running:false}};
const task=(members:any[])=>({status:'submitted',current_run_id:'R',review_stage:'running',agent_id:'author',review_members:members,automation:{role:'review',status:'failed',run_id:'R',review_id:'Grok'}});
test('two and three reviewers have independent lanes, failures never replace another running reviewer',()=>{
 for(const members of [[running('A'),running('B')],[running('A'),failed],[running('A'),failed,{id:'C',reviewer_id:'C',status:'awaiting_dispatch'}]]){
  const t=task(members),p=reviewProgress(t),r=relayOf(t,x=>x);assert.equal(p.total,members.length);assert.equal(r.legs[4].members?.length,members.length);assert.equal(r.tone,'review');assert.equal(taskAction(t).group,'working');assert.match(r.headline,/位审查中/);
 }
 assert.equal(reviewMemberState(failed).state,'waiting');assert.equal(reviewMemberState({...failed,invocation:{...failed.invocation,process_may_be_running:true}}).label,'调用状态待核对');
});
test('all missing reports are waiting, reports win over failed invocations, removed assignments do not count',()=>{
 assert.equal(taskAction(task([failed])).group,'arrange');assert.equal(relayOf(task([failed]),x=>x).tone,'you');
 const passed={...failed,status:'completed',result_id:'V',report:{id:'V',verdict:'passed'}};
 const p=reviewProgress(task([passed,{id:'P',status:'awaiting_dispatch'},{...failed,status:'cancelled'}]));assert.equal(p.count,'已回报 1/2');assert.equal(p.members[0].label,'已回报 · 通过');
 const t={...task([passed]),review_stage:'awaiting_decision',automation:{role:'review',status:'running'}};assert.match(taskAction(t).label,/负责人/);assert.match(relayOf(t,x=>x).headline,/负责人/);
 for(const status of ['awaiting_closeout','closing','awaiting_confirmation']){const r=relayOf({...task([passed]),status,review_stage:'completed'},x=>x);assert.notEqual(r.at,4);assert.notEqual(r.tone,'problem');}
});
test('old run and other assignment calls cannot replace current member state',()=>{
 const m={id:'A',status:'running'};
 for(const patch of [{run_id:'old',review_id:'A'},{run_id:'R',review_id:'B'}])assert.equal(reviewMemberState(m,{current_run_id:'R',automation:{role:'review',status:'failed',...patch}}).state,'running');
});
test('backend selects the latest call per assignment in this Run and compact projection omits report bodies',()=>{
 const {wb,root}=fixture();try{const s=setup(wb,root),t=wb.get('tasks',s.tid);t.status='submitted';wb.put('tasks',t,{project_id:t.project_id});
 for(const id of ['A','B'])wb.put('review_assignments',{id,run_id:s.rid,reviewer_id:id,status:'running'},{run_id:s.rid});
 const other=setup(wb,root);
 for(const [id,run_id,review_id,status,at] of [['old',s.rid,'A','failed','1'],['new',s.rid,'A','running','2'],['other',other.rid,'A','failed','3'],['b',s.rid,'B','failed','2']])wb.put('agent_jobs',{id,run_id,review_id,status,created_at:at,role:'review',route:{client:'grok'}},{run_id});
 const summary=reviewCollaboration(wb,s.rid);assert.equal(summary.members[0].invocation?.job_id,'new');assert.equal(summary.members[1].invocation?.job_id,'b');
 wb.put('reviews',{id:'V',run_id:s.rid,review_id:'A',verdict:'passed',report_markdown:'完整合成报告正文不可进入列表'},{run_id:s.rid});const a=wb.get('review_assignments','A');a.status='completed';a.result_id='V';wb.put('review_assignments',a,{run_id:s.rid});
 const projected=wb.executionTasks().find(x=>x.id===s.tid)!;assert.equal(projected.review_members.length,2);assert.equal(projected.review_members[0].invocation.job_id,'new');assert.equal(projected.review_members[0].report.verdict,'passed');assert.equal(projected.review_members[0].report.report_markdown,undefined);
 }finally{wb.close();}
});
test('copying a selected assignment cannot switch to a different order for the same reviewer',()=>{
 const {wb,root}=fixture();try{const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));assert.equal(wb.event(event(root,s.tid,s.rid,2,'submitted',{result:'隔离合成测试验证多审查单精确复制入口，不代表真实模型审查。'})).disposition,'applied');
 const order=(extra:any={})=>exportReviewOrder(wb,{run_id:s.rid,reviewer_id:'grok-build',expected_revision:wb.get('tasks',s.tid).revision,reason:'复制指定合成审查单',...extra},{role:'user'});
 const first=order(),second=order({new_review:true});assert.notEqual(first.review_id,second.review_id);assert.equal(order({review_id:second.review_id}).review_id,second.review_id);assert.equal(wb.runRows('review_assignments',s.rid).length,2);
 }finally{wb.close();}
});

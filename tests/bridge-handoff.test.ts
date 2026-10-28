import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fixture,setup,taskInput} from './helpers.ts';
import {executionContext,readRunContextFile,dispatchBrief} from '../src/core/execution-context.ts';
import {reviewContext} from '../src/core/review-context.ts';
import {compactOrder} from '../src/core/compact-order.ts';
import {chatPlanningContext,chatPlanningCopy,parseChatPlan} from '../src/core/chat-planning.ts';
import {amendTask} from '../src/core/task-amendment.ts';

test('方案和分角色首读/条件补读贯穿执行单、上下文和审查；单项展开不附历史',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid),r=f.wb.get('runs',s.rid);
  for(const name of ['code.ts','diff.txt','extra.ts'])fs.writeFileSync(path.join(f.root,name),'one\ntwo\n');
  t.context_contract={plan:{content:'本轮方案'.repeat(400),path:'plan.md'},required:[{path:'code.ts',roles:['executor'],range:{start_line:1,end_line:1}},{path:'diff.txt',roles:['reviewer'],reason:'从本轮差异开始'}],supplemental:[{path:'extra.ts',reason:'只有关联检查失败时补读'}],output_dir:'out',review_focus:['只验证新分支及直接调用方'],max_bytes:1024};f.wb.put('tasks',t,{project_id:t.project_id});
  const c=executionContext(f.wb,{run_id:r.id});assert.equal(c.context.files.total,3);assert(!c.context.files.suggested.some((x:any)=>x.path==='diff.txt'));assert.equal(c.context.files.suggested[2].reason,'只有关联检查失败时补读');assert(c.context.handoff.plan.content.length<800);
  const plan=executionContext(f.wb,{run_id:r.id,section:'plan'});assert.equal(plan.context.handoff.plan.content,t.context_contract.plan.content);assert(!('project_memory' in plan.context));
  const aid='RA-'+crypto.randomUUID();f.wb.put('review_assignments',{id:aid,run_id:r.id,reviewer_id:'grok-build',review_digest:'digest',status:'running'},{run_id:r.id});
  const review=reviewContext(f.wb,{review_id:aid},{review_id:aid,task_id:t.id,run_id:r.id,review_digest:'digest'});assert.equal(review.context.files.suggested[1].path,'diff.txt');assert.deepEqual(review.context.handoff.review_focus,['只验证新分支及直接调用方']);
  const order=compactOrder(t,f.wb.get('projects',t.project_id),r,f.root);assert.match(order,/只有关联检查失败时补读/);assert.match(order,/context-section plan/);assert.match(fs.readFileSync(s.order.path,'utf8'),/get_project_files.*classify_project_files/);
 }finally{f.wb.close()}
});

test('同会话增量只列变化文件，未列入本角色的正常项目资料仍可按需读取',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid);for(const name of ['a.ts','b.ts'])fs.writeFileSync(path.join(f.root,name),'before');t.context_contract={required:[{path:'a.ts'},{path:'b.ts'}],supplemental:[],output_dir:'out',max_bytes:1024};f.wb.put('tasks',t,{project_id:t.project_id});
  const before=executionContext(f.wb,{run_id:s.rid});fs.writeFileSync(path.join(f.root,'a.ts'),'after');const delta=executionContext(f.wb,{run_id:s.rid,mode:'delta',known_context_hash:before.context_hash});assert.deepEqual(delta.context.files.suggested.map((x:any)=>x.path),['a.ts']);assert(!('handoff' in delta.context));
  fs.writeFileSync(path.join(f.root,'needed.ts'),'dependency');t.context_contract.supplemental=[{path:'../no-longer-in-project.txt',reason:'历史建议已失效'}];f.wb.put('tasks',t,{project_id:t.project_id});assert.equal(readRunContextFile(f.wb,{run_id:s.rid,path:'needed.ts',reason:'调用链需要'}).content,'dependency');assert.throws(()=>readRunContextFile(f.wb,{run_id:s.rid,path:'data/private.txt'}));
 }finally{f.wb.close()}
});

test('长项目默认摘要有界且历史检索可分页定位，无整张旧任务或会话全文',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),t=f.wb.get('tasks',s.tid);for(let i=0;i<80;i++)f.wb.put('tasks',{...t,id:'T-history-'+i,title:'历史'+i,goal:'搜得到的关键字',scope:'不应默认返回'.repeat(2000),status:'accepted',current_run_id:null,updated_at:new Date(2026,0,i+1).toISOString()},{project_id:t.project_id});
  const p=f.wb.projectContext(t.project_id,'brief');assert(JSON.stringify(p).length<8000);assert.equal(p.counts.tasks,81);assert(p.omitted.tasks>70);assert(!JSON.stringify(p).includes('不应默认返回'));
  const d=dispatchBrief(f.wb.dispatchContext(),t.project_id);assert(d.tasks.length<=5);assert(!('quota_windows' in d));assert(!('model_catalog' in d));
  const page=f.wb.history({project_id:t.project_id,kind:'task',query:'搜得到',limit:2});assert.equal(page.items.length,2);assert.equal(page.next_offset,2);assert(!('scope' in page.items[0]));assert.equal(page.items[0].full_ref.tool,'get_task_detail');
  const next=f.wb.history({project_id:t.project_id,kind:'task',query:'搜得到',limit:2,offset:page.next_offset});assert(!next.items.some((x:any)=>page.items.some((y:any)=>x.id===y.id)));assert(f.wb.history({query:page.items[0].id,detail:'full'}).items[0].scope);
 }finally{f.wb.close()}
});

test('简短计划无需凑不相关字段；方案修改在当前任务留痕并进入增量',()=>{
 const f=fixture();try{const q=f.wb.request({project_id:'P-workbench',text:'小改动'}),base=taskInput(f.root);const task={key:base.key,title:base.title,agent_id:base.agent_id,reviewer_id:base.reviewer_id,work_kind:base.work_kind,goal:base.goal,allowed_paths:base.allowed_paths,deliverables:base.deliverables,acceptance:base.acceptance};
  const p=parseChatPlan({text:JSON.stringify({schema_version:1,plan_id:'short',request_id:q.id,expected_version:q.version,tasks:[task]})});assert.deepEqual(p.tasks[0].tests,[]);const saved=f.wb.submitPlan(p),order=f.wb.exportOrder(saved.task_ids[0],1),t=f.wb.get('tasks',saved.task_ids[0]);const before=executionContext(f.wb,{run_id:order.run_id});
  const amended=amendTask(f.wb,{task_id:t.id,run_id:order.run_id,expected_revision:t.revision,reason:'用户补充方案',changes:{context_contract:{plan:{content:'只改当前组件'},required:[],output_dir:f.root,review_focus:['当前组件回归']}}});assert.equal(amended.run_id,order.run_id);assert.equal(executionContext(f.wb,{run_id:order.run_id,mode:'delta',known_context_hash:before.context_hash}).context.handoff.plan.content,'只改当前组件');
 }finally{f.wb.close()}
});

test('聊天复制保留完整需求与方案字段，不重复带模型目录和全量资源',()=>{
 const f=fixture();try{const q=f.wb.request({project_id:'P-workbench',text:'完整原文'.repeat(400)}),c=chatPlanningContext(f.wb,q.id),copy=chatPlanningCopy(c),value=JSON.parse(copy.slice(copy.indexOf('\n')+1));assert.equal(value.request.text,q.text);assert(!('models' in value));assert(!('resources' in value));assert(value.plan_template.tasks[0].context_contract);assert.match(value.instructions,/不是阅读许可/);}finally{f.wb.close()}
});

test('复审问题已交接后不在每次增量重复出现，新增问题仍会送达',()=>{
 const f=fixture();try{const s=setup(f.wb,f.root),r=f.wb.get('runs',s.rid);r.retry_context={reviews:[{id:'review-one',verdict:'changes_requested',findings:['修改按钮标签']}],user_feedback:[{id:'feedback-one',note:'保留当前布局'}]};f.wb.put('runs',r,{task_id:s.tid});
  const first=executionContext(f.wb,{run_id:r.id});assert.equal(first.review_changes.length,1);const same=executionContext(f.wb,{run_id:r.id,mode:'delta',known_context_hash:first.context_hash});assert.deepEqual(same.review_changes,[]);assert.deepEqual(same.user_feedback,[]);
  const updated=f.wb.get('runs',r.id);updated.retry_context.reviews.push({id:'review-two',verdict:'changes_requested',findings:['补充键盘焦点']});f.wb.put('runs',updated,{task_id:s.tid});assert(executionContext(f.wb,{run_id:r.id,mode:'delta',known_context_hash:first.context_hash}).review_changes.some((x:any)=>x.id==='review-two'));
 }finally{f.wb.close()}
});

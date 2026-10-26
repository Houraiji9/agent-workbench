import test from 'node:test';
import assert from 'node:assert/strict';
import type {Workbench} from '../src/core/workbench.ts';
import {planningProjectSummary,planningSummaryLimits} from '../src/core/planning-project-summary.ts';
import {chatPlanningContext} from '../src/core/chat-planning.ts';
import {fixture} from './helpers.ts';

function records(tasks:any[]=[],runs:any[]=[],events:any[]=[],project:any={}){
  const p={id:'P-current',name:'当前项目',goal:'项目真实目标',stage:'待规划',next_step:'旧登记下一步',updated_at:'2026-01-01T00:00:00Z',...project};
  const tables:Record<string,any[]>={tasks,runs,events};
  return {get:(table:string,id:string)=>{assert.equal(table,'projects');assert.equal(id,p.id);return p;},all:(table:string)=>{assert(Object.hasOwn(tables,table),'摘要不得读取文件、会话或其他资料表');return tables[table];}} as unknown as Workbench;
}
const task=(id:string,status:string,extra:any={})=>({id,project_id:'P-current',title:id,status,created_at:'2026-01-01T00:00:00Z',...extra});
const receipt=(id:string,task_id:string,run_id:string,event_type:string,occurred_at:string,data:any={})=>({id,task_id,run_id,event_type,occurred_at,data,seq:1,disposition:'applied'});

test('摘要按真实时间排序，实时任务与登记阶段分开，交付和验收独立记录',()=>{
  const tasks=[task('new','running',{current_run_id:'R-new'}),task('accepted-new','accepted',{current_run_id:'R-accepted-new',acceptance_record:{run_id:'R-accepted-new',confirmed_at:'2026-04-03T01:00:00Z'}}),task('accepted-old','accepted',{current_run_id:'R-accepted-old',acceptance_record:{run_id:'R-accepted-old',confirmed_at:'2026-04-01T01:00:00Z'}}),task('old','running',{updated_at:'2026-03-01T00:00:00Z'}),task('delivery-old','in_review',{current_run_id:'R-delivery-old'}),task('delivery-new','awaiting_confirmation',{current_run_id:'R-delivery-new'})];
  const runs=tasks.filter(t=>t.current_run_id).map(t=>({id:t.current_run_id,task_id:t.id}));
  const events=[receipt('E-new','new','R-new','progress','2026-04-02T09:00:00+08:00',{message:'真实正在处理'}),receipt('E-delivery-new','delivery-new','R-delivery-new','submitted','2026-04-02T01:30:00Z',{result:'已交付但尚未用户验收'}),receipt('E-delivery-old','delivery-old','R-delivery-old','submitted','2026-04-02T08:00:00+08:00',{result:'较早交付'})];
  const s=planningProjectSummary(records(tasks,runs,events),'P-current');
  assert.equal(s.project.recorded_stage,'待规划');assert.equal(s.status_counts.active,4);assert.equal(s.status_counts.by_status.running,2);
  assert.deepEqual(s.active_tasks.map(t=>t.task_id),['delivery-new','new','delivery-old','old']);
  assert.deepEqual(s.recent_deliveries.slice(0,2).map(t=>t.task_id),['delivery-new','delivery-old']);
  assert.deepEqual(s.recent_acceptances.map(t=>t.task_id),['accepted-new','accepted-old']);
  assert(!s.recent_acceptances.some(t=>t.task_id==='delivery-new'));
  assert.equal(s.active_tasks.find(t=>t.task_id==='new')?.source.event_id,'E-new');
  assert.equal(s.recent_acceptances[0].source.occurred_at,'2026-04-03T01:00:00.000Z');assert.match(s.next_step.note,/可能滞后/);
});

test('仅当前项目及匹配当前Run的已应用事实进入摘要，不读取全文或跨项目资料',()=>{
  const tasks=[task('current','blocked',{current_run_id:'R-current'}),task('foreign','running',{project_id:'P-other',title:'不应泄漏的跨项目标题',current_run_id:'R-foreign'})];
  const runs=[{id:'R-current',task_id:'current'},{id:'R-old',task_id:'current'},{id:'R-foreign',task_id:'foreign'}];
  const events=[receipt('E-good','current','R-current','blocked','2026-05-01T00:00:00Z',{message:'当前阻碍，需要现有权限范围内的资料'}),receipt('E-old','current','R-old','progress','2026-06-01T00:00:00Z',{message:'旧Run不能当正在做'}),receipt('E-mismatch','foreign','R-current','progress','2026-07-01T00:00:00Z',{message:'错误任务绑定'}),{...receipt('E-rejected','current','R-current','progress','2026-08-01T00:00:00Z',{message:'拒绝回执不是真实进展'}),disposition:'rejected'},receipt('E-foreign','foreign','R-foreign','progress','2026-09-01T00:00:00Z',{message:'跨项目内容'})];
  const s=planningProjectSummary(records(tasks,runs,events),'P-current'),serialized=JSON.stringify(s);
  assert.equal(s.status_counts.total,1);assert.equal(s.blockers[0].source.event_id,'E-good');assert.match(s.blockers[0].detail,/当前阻碍/);
  for(const text of ['跨项目标题','跨项目内容','旧Run不能','错误任务绑定','拒绝回执'])assert(!serialized.includes(text));
});

test('数量和序列化字符预算有界，截断数量如实保留，源记录不被修改',()=>{
  const huge='"\\\n'.repeat(10000),tasks=Array.from({length:80},(_,i)=>task('T-'+i,i%2?'blocked':'accepted',{title:huge,current_run_id:'R-'+i,acceptance_record:{run_id:'R-'+i,confirmed_at:'2026-05-01T00:00:00Z'}}));
  const runs=tasks.map(t=>({id:t.current_run_id,task_id:t.id})),events=tasks.map(t=>receipt('E-'+t.id,t.id,t.current_run_id,'submitted','2026-04-01T00:00:00Z',{result:huge,message:huge}));
  const before=JSON.stringify({tasks,runs,events}),s=planningProjectSummary(records(tasks,runs,events,{goal:huge,stage:huge,next_step:huge,name:huge}),'P-current');
  assert(JSON.stringify(s).length<=planningSummaryLimits.max_characters);assert(s.active_tasks.length<=5);assert(s.blockers.length<=3);assert(s.recent_acceptances.length<=3);assert(s.recent_deliveries.length<=3);
  assert.equal(s.status_counts.total,80);assert.equal(s.omitted.active_tasks,40-s.active_tasks.length);assert.equal(s.omitted.recent_deliveries,80-s.recent_deliveries.length);assert.equal(s.omitted.recent_acceptances,40-s.recent_acceptances.length);
  assert.equal(JSON.stringify({tasks,runs,events}),before);
});

test('无任务或缺少历史时间不编造进展和验收时间',()=>{
  const empty=planningProjectSummary(records(),'P-current');assert.equal(empty.status_counts.total,0);assert.deepEqual(empty.active_tasks,[]);assert.equal(empty.next_step.current_task,null);
  const unknown=planningProjectSummary(records([task('legacy','accepted',{created_at:'invalid'})]),'P-current');
  assert.equal(unknown.recent_acceptances[0].occurred_at,null);assert.match(unknown.recent_acceptances[0].detail,/缺少当前 Run/);assert.deepEqual(unknown.recent_deliveries,[]);
});

test('排序可使用任务更新时间，回执来源仍保留回执自己的时间',()=>{
  const s=planningProjectSummary(records([task('current','running',{current_run_id:'R-current',updated_at:'2026-06-01T00:00:00Z'})],[{id:'R-current',task_id:'current',updated_at:'2026-05-01T00:00:00Z'}],[receipt('E-current','current','R-current','progress','2026-04-01T00:00:00Z',{message:'已记录进展'})]),'P-current');
  assert.equal(s.active_tasks[0].occurred_at,'2026-06-01T00:00:00.000Z');assert.equal(s.active_tasks[0].source.occurred_at,'2026-04-01T00:00:00.000Z');assert.equal(s.active_tasks[0].source.task_updated_at,'2026-06-01T00:00:00.000Z');
});

test('真实 closing 及其他收尾状态计入当前状态与已交付，不落入 other',()=>{
  const closeout=['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'];
  for(const status of closeout){
    const s=planningProjectSummary(records([task('closeout',status,{current_run_id:'R-closeout'})],[{id:'R-closeout',task_id:'closeout',status:'submitted'}]),'P-current');
    assert.equal(s.status_counts.by_status[status],1);assert.equal(s.status_counts.by_status.other,undefined);assert.equal(s.active_tasks[0].status,status);assert.equal(s.recent_deliveries[0].status,status);assert.deepEqual(s.recent_acceptances,[]);
  }
});

test('搁置项目阻止普通聊天与标准复制入口，恢复后可生成规划资料',()=>{
  const f=fixture();try{
    const q=f.wb.request({project_id:'P-workbench',text:'测试搁置项目规划入口'}),p=f.wb.get('projects',q.project_id);
    f.wb.put('projects',{...p,shelved:true});
    assert.throws(()=>chatPlanningContext(f.wb,q.id),/搁置/);assert.throws(()=>f.wb.planningEntry(q.id),/搁置/);
    f.wb.put('projects',{...p,shelved:false});assert.equal(chatPlanningContext(f.wb,q.id).request.id,q.id);assert.match(f.wb.planningEntry(q.id).text,/expected_version=1/);
  }finally{f.wb.close();}
});

test('普通聊天和标准复制资料包含相同项目摘要，保留新需求与设置来源',()=>{
  const f=fixture();try{
    const q=f.wb.request({project_id:'P-workbench',text:'本轮新增需求：让中途新增功能得到项目背景'});
    f.wb.put('requests',{...q,importance_source:'project',delivery_profile_source:'planner',planning_preferences:{delivery:'planner'}},{project_id:q.project_id});
    const chat=chatPlanningContext(f.wb,q.id),entry=f.wb.planningEntry(q.id);
    const marker='当前项目历史事实摘要（有界；来源与时间见记录）：\n',copied=JSON.parse(entry.text.split(marker)[1].split('\n网页本身')[0]);
    const {as_of:a,...chatSummary}=chat.project_summary,{as_of:b,...copySummary}=copied;
    assert.deepEqual(chatSummary,copySummary);assert.equal(chat.request.text,q.text);assert(!JSON.stringify(chat.project_summary).includes(q.text));
    assert.equal(chat.request.importance_source,'project');assert.equal(chat.request.delivery_profile_source,'planner');assert.deepEqual(chat.request.planning_preferences,{delivery:'planner'});
    assert.match(chat.instructions,/默认或继承值不是用户明确限制/);assert.match(chat.instructions,/source\/none/);assert.match(chat.instructions,/delivery_profile 与 delivery_target 仅为结构示例，必须由模型按本轮需求填写/);assert.match(entry.text,/本轮用户新需求/);assert.match(entry.text,/expected_version=1/);assert.equal(entry.context.project_id,q.project_id);
  }finally{f.wb.close();}
});

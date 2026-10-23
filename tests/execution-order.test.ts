import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fixture,taskInput,event} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {withExecutionOrder,waitingForDependencies,byExecutionOrder} from '../src/shared/execution-order.ts';
import {isYourTurn,relayOf} from '../src/web/lib/flow.ts';
import {rejectAcceptance} from '../src/core/acceptance-feedback.ts';

function plan(wb:Workbench,root:string,items:any[]) {
  const q=wb.request({project_id:'P-workbench',text:'测试：执行顺序与验收解锁'});
  return wb.submitPlan({schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:items.map(t=>({...taskInput(root,t.key),...t}))});
}
function deliver(wb:Workbench,root:string,tid:string) {
  const o=wb.exportOrder(tid,1);wb.event(event(root,tid,o.run_id,1));
  wb.event(event(root,tid,o.run_id,2,'submitted',{result:'隔离测试：已完成测试工作并交付，当前等待独立审查和用户验收。'}));return o;
}
function review(wb:Workbench,tid:string) {
  const t=wb.get('tasks',tid);wb.review({run_id:t.current_run_id,reviewer_id:'grok-build',performed:true,evidence:'隔离测试夹具中的模拟审查，不是真实模型审查',artifact_hashes:wb.all('artifacts').filter(a=>a.run_id===t.current_run_id).map(a=>a.sha256),verdict:'passed'});
}
function accept(wb:Workbench,tid:string){wb.accept(tid,{revision:wb.get('tasks',tid).revision,checks:[true]})}

test('乱序计划按依赖分步骤；同一 Agent 建议队列保留计划顺序，复制不会跳队',()=>{
  const {wb,root}=fixture();try {
    const p=plan(wb,root,[{key:'c',title:'最后集成',dependencies:['b']},{key:'b',title:'接入实现',dependencies:['a']},{key:'a',title:'先设计'},{key:'d',title:'独立整理'}]);
    const [c,b,a,d]=p.task_ids;let tasks=wb.snapshot().tasks;
    assert.deepEqual(tasks.sort(byExecutionOrder).map((t:any)=>t.id),[a,d,b,c]);
    assert.deepEqual(tasks.map((t:any)=>t.execution.step),[1,1,2,3]);
    assert.equal(tasks.find((t:any)=>t.id===a).execution.queue_position,1);
    assert.equal(tasks.find((t:any)=>t.id===d).execution.queue_position,2);
    const blocked=tasks.find((t:any)=>t.id===b);assert(waitingForDependencies(blocked));assert(!isYourTurn(blocked));assert.equal(relayOf(blocked,id=>id).holder,'none');
    assert.throws(()=>wb.exportOrder(b,1),/先设计/);
    const o=wb.exportOrder(a,1);assert.match(o.entry,/项目执行顺序：第 1 步/);
    assert.equal(wb.snapshot().tasks.find((t:any)=>t.id===a).execution.queue_position,1);
    wb.manualAction(a,'dispatch',wb.get('tasks',a).revision);
    const next=wb.taskDetail(d).task.execution;assert.equal(next.queue_position,1);assert.equal(next.active_work[0].id,a);
    assert.equal(wb.get('tasks',a).execution,undefined);
  }finally{wb.close()}
});

test('交付和审查通过均不提前解锁；验收后同步首页、详情与 MCP 上下文，重启可恢复',()=>{
  const f=fixture();let wb=f.wb;try {
    const [a,b]=plan(wb,f.root,[{key:'a',title:'准备资料'},{key:'b',title:'后续实现',dependencies:['a']}]).task_ids;
    const o=deliver(wb,f.root,a),old=fs.readFileSync(o.path);
    assert(waitingForDependencies(wb.taskDetail(b).task));review(wb,a);assert(waitingForDependencies(wb.taskDetail(b).task));accept(wb,a);
    for(const list of [wb.snapshot().tasks,wb.projectContext('P-workbench').tasks,wb.dispatchContext().tasks])assert.equal(list.find((t:any)=>t.id===b).execution.dependencies_ready,true);
    assert(isYourTurn(wb.taskDetail(b).task));assert.equal(wb.taskDetail(b).task.execution.step,2);
    const order=wb.exportOrder(b,1);assert.match(fs.readFileSync(order.path,'utf8'),/准备资料.*已验收/);assert.deepEqual(fs.readFileSync(o.path),old);
    wb.close();wb=new Workbench(f.config);assert.equal(wb.taskDetail(b).task.execution.step,2);assert.equal(wb.exportOrder(b,1).run_id,order.run_id);
  }finally{wb.close()}
});

test('返工等待实际后续任务验收；界面链接与后台依赖判定一致',()=>{
  const {wb,root}=fixture();try {
    const [a,b,repair]=plan(wb,root,[{key:'a',title:'原交付'},{key:'b',title:'依赖原交付',dependencies:['a']},{key:'repair',title:'修复交付'}]).task_ids;
    const o=deliver(wb,root,a);
    rejectAcceptance(wb,a,{revision:wb.get('tasks',a).revision,run_id:o.run_id,note:'测试：后续任务负责修改',artifact_hashes:wb.all('artifacts').filter(x=>x.run_id===o.run_id).map(x=>x.sha256),followup_task_id:repair});
    const dependency=wb.taskDetail(b).task.execution.dependencies[0];assert.equal(dependency.effective_id,repair);assert.equal(dependency.effective_title,'修复交付');assert.equal(dependency.satisfied,false);
    assert.throws(()=>wb.exportOrder(b,1),/前置/);deliver(wb,root,repair);review(wb,repair);accept(wb,repair);
    assert.equal(wb.taskDetail(b).task.execution.dependencies_ready,true);assert.equal(wb.get('tasks',a).status,'rework_linked');assert(wb.exportOrder(b,1));
  }finally{wb.close()}
});

test('历史缺失、取消、循环依赖不显示可执行；独立任务不受影响',()=>{
  const t=(id:string,dependencies:string[]=[],status='ready')=>({id,title:id,agent_id:'codex',status,dependencies});
  const rows=withExecutionOrder([t('missing',['absent']),t('cancelled',[],'cancelled'),t('wait',['cancelled']),t('a',['b']),t('b',['a']),t('ok')],[],[]);
  for(const id of ['missing','wait','a','b'])assert(waitingForDependencies(rows.find(t=>t.id===id)!));
  assert.equal(rows.find(t=>t.id==='ok')!.execution.queue_position,1);
});

test('建议队列按当前 Run 的执行者汇总，历史合并入口归入当前成员',()=>{
  const rows=withExecutionOrder([{id:'a',status:'ready',agent_id:'codex',created_at:'1'},{id:'b',status:'awaiting_dispatch',agent_id:'codex',current_run_id:'r',created_at:'2'},{id:'c',status:'ready',agent_id:'old',created_at:'3'}],[{id:'r',agent_id:'claude'}],[],[{id:'old',merged_into:'claude'}]);
  assert.deepEqual(rows.map(t=>[t.execution.executor_id,t.execution.queue_position]),[['codex',1],['claude',1],['claude',2]]);
});

test('已生成执行单在派发和 started 接单时重新校验前置状态',()=>{
  const {wb,root}=fixture();try {
    const [a,b]=plan(wb,root,[{key:'a'},{key:'b',dependencies:['a']}]).task_ids;
    deliver(wb,root,a);review(wb,a);accept(wb,a);const o=wb.exportOrder(b,1);
    // 模拟旧数据恢复后前置记录状态发生变化；仅在隔离账本内构造。
    const previous=wb.get('tasks',a);wb.put('tasks',{...previous,status:'cancelled'},{project_id:previous.project_id});
    assert.throws(()=>wb.manualAction(b,'dispatch',wb.get('tasks',b).revision),/前置/);
    const result=wb.event(event(root,b,o.run_id,1));assert.equal(result.disposition,'rejected');assert.equal(wb.get('tasks',b).status,'awaiting_dispatch');
  }finally{wb.close()}
});

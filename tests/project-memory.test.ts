import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {fixture,setup} from './helpers.ts';import {projectMemories,taskMemoryContext} from '../src/core/project-memory.ts';import {executionContext} from '../src/core/execution-context.ts';import {scopeManagementInput,sessionCaller} from '../src/core/session-management.ts';import {validateTaskContextContract} from '../src/core/file-context.ts';
test('经验默认只给有限索引，候选/替代有标记，相关全文按需读取并支持逐条增量',()=>{const f=fixture();try{
 const s=setup(f.wb,f.root);const create=(i:number,status='confirmed')=>f.wb.memory({project_id:'P-workbench',kind:'decision',status,content:'经验 '+i+' '+('实际证据'.repeat(150))+' UNIQUE_END_'+i,source_id:s.tid});
 const first=create(0),candidate=create(1,'candidate');for(let i=2;i<18;i++)create(i);
 const index=projectMemories(f.wb,{project_id:'P-workbench'});assert.equal(index.items.length,12);assert.equal(index.total,18);assert.equal(index.next_offset,12);assert(!JSON.stringify(index.items).includes('UNIQUE_END'));assert.equal(index.counts.candidate,1);
 const full=projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:[first.id,candidate.id]});assert.equal(full.items.length,2);assert(full.items[0].content.endsWith('UNIQUE_END_0'));assert.equal(full.items[1].status,'candidate');
 const known=Object.fromEntries(full.items.map((m:any)=>[m.id,m.content_hash]));const repeated=projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:[first.id,candidate.id],known_hashes:known});assert.equal(repeated.items.length,0);assert.deepEqual(repeated.unchanged_ids,[first.id,candidate.id]);
 f.wb.memory({project_id:'P-workbench',kind:'decision',status:'confirmed',content:'更新后的经验与来源',source_id:s.tid,supersedes:first.id});const changed=projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:[first.id],known_hashes:known});assert.equal(changed.items[0].status,'superseded');assert.notEqual(changed.items[0].content_hash,known[first.id]);
 const bounded=projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:[candidate.id],max_bytes:1024});assert.deepEqual(bounded.deferred_ids,[candidate.id]);assert.equal(bounded.items.length,0);
 assert.throws(()=>projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:[]}),/请选择/);
}finally{f.wb.close()}});
test('规划选择的经验进入执行简版，同会话上下文不重发不变条目，导出不会注入全文',()=>{const f=fixture();try{
 const s=setup(f.wb,f.root),m=f.wb.memory({project_id:'P-workbench',kind:'known_issue',status:'confirmed',content:'问题摘要'.repeat(60)+' SECRET_TAIL_OF_LONG_MEMORY',source_id:s.tid});
 const t=f.wb.get('tasks',s.tid);t.context_contract={required:[],supplemental:[],output_dir:f.root,max_bytes:65536,memory_ids:[m.id]};f.wb.put('tasks',t,{project_id:t.project_id});validateTaskContextContract(f.wb,t);
 assert.deepEqual(taskMemoryContext(f.wb,t).selected_ids,[m.id]);const ctx=executionContext(f.wb,{run_id:s.rid});assert.equal(ctx.context.project_memory.selection,'planner_selected');assert(!JSON.stringify(ctx).includes('SECRET_TAIL'));
 assert.deepEqual(executionContext(f.wb,{run_id:s.rid,mode:'delta',known_context_hash:ctx.context_hash}).context,{});
 const q=f.wb.request({project_id:'P-workbench',text:'另一个隔离测试需求'});const plan=f.wb.submitPlan({...s.plan,plan_id:'memory-plan-'+q.id,request_id:q.id});const order=f.wb.exportOrder(plan.task_ids[0],1);const contextFile=fs.readFileSync(path.join(path.dirname(order.path),'CONTEXT.md'),'utf8');assert(!contextFile.includes('SECRET_TAIL'));assert(contextFile.includes('按需'));assert(contextFile.includes('get_project_memories'));
}finally{f.wb.close()}});
test('经验查询限制当前绑定项目；已验收当前会话仍可办理普通项目管理',()=>{const f=fixture();try{
 const s=setup(f.wb,f.root),caller=sessionCaller(f.wb,'runner',s.rid);assert.throws(()=>scopeManagementInput(f.wb,'get_project_memories',{project_id:'P-other'},caller),/尚未关联/);
 const t=f.wb.get('tasks',s.tid);t.status='accepted';f.wb.put('tasks',t,{project_id:t.project_id});assert.equal(sessionCaller(f.wb,'runner',s.rid).project_id,'P-workbench');
 assert.throws(()=>projectMemories(f.wb,{project_id:'P-workbench',mode:'read',memory_ids:['M-foreign']}),/不属于/);
 t.context_contract={required:[],supplemental:[],output_dir:f.root,max_bytes:65536,memory_ids:['M-foreign']};assert.throws(()=>validateTaskContextContract(f.wb,t),/不属于/);
}finally{f.wb.close()}});

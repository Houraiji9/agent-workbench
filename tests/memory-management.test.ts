import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,setup} from './helpers.ts';
import {manageMemory,manageMemoryInput,projectMemoryHistory} from '../src/core/memory-management.ts';
import {projectMemories,taskMemoryContext,memoryOrderContext} from '../src/core/project-memory.ts';
import {executionContext} from '../src/core/execution-context.ts';

test('两种来源及三种状态均可编辑，来源确认信息不可伪造且所有旧版本保留',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root);
  for(const actor of ['user','codex'])for(const state of ['candidate','confirmed','superseded']){
   const m=manageMemory(f.wb,{project_id:'P-workbench',kind:'decision',status:actor==='user'?'confirmed':'candidate',content:'原内容',source_id:s.tid},actor);
   // Synthetic historical states include Agent-confirmed records; edits must preserve their provenance.
   m.status=state;m.confirmation=state==='confirmed'?{basis:'conversation_instruction',recorded_by:actor,request_id:'synthetic-confirmation'}:null;
   f.wb.put('memories',m,{project_id:m.project_id});
   const changed=manageMemory(f.wb,{action:'update',project_id:m.project_id,memory_id:m.id,version:1,kind:'known_issue',content:'编辑内容',scope:'本项目'},'user');
   assert.equal(changed.source,actor);assert.equal(changed.source_id,s.tid);assert.equal(changed.status,state);assert.deepEqual(changed.confirmation,m.confirmation);assert.equal(changed.version,2);
   assert.equal(changed.revisions[0].snapshot.content,'原内容');assert.equal(changed.revisions[0].snapshot.source,actor);assert.equal(changed.updated_by,'user');
   const again=manageMemory(f.wb,{action:'update',project_id:m.project_id,memory_id:m.id,version:2,kind:'handoff',content:'第二次编辑',scope:'project'});
   assert.deepEqual(again.revisions.map((r:any)=>r.version),[1,2]);assert.equal(again.revisions[1].snapshot.content,'编辑内容');
   assert.throws(()=>manageMemoryInput.parse({action:'update',project_id:m.project_id,memory_id:m.id,version:3,kind:'handoff',content:'伪造',source:'user',scope:'project'}));
  }
 }finally{f.wb.close();}
});

test('更新删除恢复均检查项目及版本，旧数据无版本按1处理，冲突不改变历史',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),m=manageMemory(f.wb,{project_id:'P-workbench',kind:'decision',status:'confirmed',content:'旧数据',source_id:s.tid});
  delete m.version;delete m.revisions;f.wb.put('memories',m,{project_id:m.project_id});
  const changed=manageMemory(f.wb,{action:'update',project_id:m.project_id,memory_id:m.id,version:1,kind:'decision',content:'当前版本',scope:'project'});
  assert.equal(changed.version,2);
  for(const action of ['update','delete','restore'])assert.throws(()=>manageMemory(f.wb,{action,project_id:m.project_id,memory_id:m.id,version:1,...(action==='update'?{kind:'decision',content:'过期草稿',scope:'project'}:{})}),/版本冲突/);
  f.wb.put('projects',{...f.wb.get('projects',m.project_id),id:'P-other'});
  assert.throws(()=>manageMemory(f.wb,{action:'delete',project_id:'P-other',memory_id:m.id,version:2}),/不属于/);
  assert.deepEqual(f.wb.get('memories',m.id),changed);
 }finally{f.wb.close();}
});

test('软删除从索引计数全文与导出消失，delta返回无正文墓碑，历史可恢复来源不删除',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),m=manageMemory(f.wb,{project_id:'P-workbench',kind:'known_issue',status:'confirmed',content:'DELETED_SECRET_BODY',source_id:s.tid});
  const before=projectMemories(f.wb,{project_id:m.project_id,mode:'read',memory_ids:[m.id]}),known={[m.id]:before.items[0].content_hash};
  const deleted=manageMemory(f.wb,{action:'delete',project_id:m.project_id,memory_id:m.id,version:1});
  assert(deleted.deleted_at);assert.equal(deleted.status,'confirmed');assert(f.wb.get('tasks',s.tid));assert(f.wb.get('runs',s.rid));
  const index=projectMemories(f.wb,{project_id:m.project_id,include_superseded:true});assert.equal(index.total,0);assert.equal(index.counts.confirmed,0);assert(!JSON.stringify(index).includes('DELETED_SECRET_BODY'));
  const delta=projectMemories(f.wb,{project_id:m.project_id,mode:'read',memory_ids:[m.id],known_hashes:known});assert.deepEqual(delta.deleted_ids,[m.id]);assert.deepEqual(delta.unchanged_ids,[]);assert.equal(delta.items.length,0);assert(!JSON.stringify(delta).includes('DELETED_SECRET_BODY'));assert.notEqual(delta.tombstones[0].version_hash,known[m.id]);
  const t={...f.wb.get('tasks',s.tid),context_contract:{memory_ids:[m.id]}};assert.equal(taskMemoryContext(f.wb,t).items.length,0);assert(!memoryOrderContext(f.wb,m.project_id,t).includes('DELETED_SECRET_BODY'));
  assert(projectMemoryHistory(f.wb,m.project_id).items[0].deleted_at);
  const restored=manageMemory(f.wb,{action:'restore',project_id:m.project_id,memory_id:m.id,version:2});assert.equal(restored.version,3);assert.equal(restored.deleted_at,null);
  const reRead=projectMemories(f.wb,{project_id:m.project_id,mode:'read',memory_ids:[m.id],known_hashes:known});assert.equal(reRead.items[0].content,'DELETED_SECRET_BODY');assert.notEqual(reRead.items[0].content_hash,known[m.id]);assert.equal(projectMemories(f.wb,{project_id:m.project_id}).counts.confirmed,1);
 }finally{f.wb.close();}
});

test('新经验替代会使旧编辑版本失效；删除恢复任意一端不复活旧事实且替代链保留',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),input={project_id:'P-workbench',kind:'decision',status:'confirmed',content:'旧事实',source_id:s.tid};
  const first=manageMemory(f.wb,input),second=manageMemory(f.wb,{...input,content:'新事实',supersedes:first.id});
  assert.equal(f.wb.get('memories',first.id).version,2);assert.throws(()=>manageMemory(f.wb,{action:'update',project_id:first.project_id,memory_id:first.id,version:1,kind:'decision',content:'过期编辑',scope:'project'}),/版本冲突/);
  manageMemory(f.wb,{action:'delete',project_id:first.project_id,memory_id:second.id,version:1});assert.equal(f.wb.get('memories',first.id).status,'superseded');
  manageMemory(f.wb,{action:'delete',project_id:first.project_id,memory_id:first.id,version:2});
  const restoredOld=manageMemory(f.wb,{action:'restore',project_id:first.project_id,memory_id:first.id,version:3});assert.equal(restoredOld.status,'superseded');
  const restoredNew=manageMemory(f.wb,{action:'restore',project_id:first.project_id,memory_id:second.id,version:2});assert.equal(restoredNew.status,'confirmed');assert.equal(restoredNew.supersedes,first.id);assert.equal(projectMemories(f.wb,{project_id:first.project_id}).counts.confirmed,1);
 }finally{f.wb.close();}
});

test('恢复历史异常旧confirmed记录也保守维持替代关系，不因删除后继而出现两个事实',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),input={project_id:'P-workbench',kind:'decision',status:'confirmed',content:'历史事实',source_id:s.tid};
  const old=manageMemory(f.wb,input),replacement=manageMemory(f.wb,{...input,supersedes:old.id});
  const broken={...f.wb.get('memories',old.id),status:'confirmed',deleted_at:new Date().toISOString()};f.wb.put('memories',broken,{project_id:old.project_id});
  manageMemory(f.wb,{action:'delete',project_id:old.project_id,memory_id:replacement.id,version:1});
  const restored=manageMemory(f.wb,{action:'restore',project_id:old.project_id,memory_id:old.id,version:2});assert.equal(restored.status,'superseded');
 }finally{f.wb.close();}
});

test('无action新增接口兼容，不能替代删除项，新增Agent确认仍需要明确用户指示',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),input={project_id:'P-workbench',kind:'handoff',status:'confirmed',content:'兼容新增接口',source_id:s.tid};
  assert.throws(()=>manageMemory(f.wb,input,'codex'),/需要用户确认/);
  const m=manageMemory(f.wb,input);assert.equal(m.version,1);assert.deepEqual(m.revisions,[]);
  manageMemory(f.wb,{action:'delete',project_id:m.project_id,memory_id:m.id,version:1});
  const count=f.wb.all('memories').length;assert.throws(()=>manageMemory(f.wb,{...input,supersedes:m.id}),/已删除/);assert.equal(f.wb.all('memories').length,count);
  assert.throws(()=>manageMemoryInput.parse({...input,confirmation:{basis:'user_page'}}));
 }finally{f.wb.close();}
});

test('删除更新执行上下文hash，历史section增量移除被删经验且不会泄漏旧正文',()=>{
 const f=fixture();try{
  const s=setup(f.wb,f.root),m=manageMemory(f.wb,{project_id:'P-workbench',kind:'decision',status:'candidate',content:'SELECTED_TO_BE_DELETED',source_id:s.tid});
  const t=f.wb.get('tasks',s.tid);t.context_contract={required:[],supplemental:[],output_dir:f.root,max_bytes:65536,memory_ids:[m.id]};f.wb.put('tasks',t,{project_id:t.project_id});
  const before=executionContext(f.wb,{run_id:s.rid,section:'history'});assert.equal(before.context.project_memory.items.length,1);
  manageMemory(f.wb,{action:'delete',project_id:m.project_id,memory_id:m.id,version:1});
  const delta=executionContext(f.wb,{run_id:s.rid,mode:'delta',section:'history',known_context_hash:before.context_hash});
  assert.notEqual(delta.context_hash,before.context_hash);assert.equal(delta.context.project_memory.items.length,0);assert.deepEqual(delta.context.project_memory.deleted_ids,[m.id]);assert(!JSON.stringify(delta.context).includes('SELECTED_TO_BE_DELETED'));
 }finally{f.wb.close();}
});

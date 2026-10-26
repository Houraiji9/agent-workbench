import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {fixture,setup} from './agent-routing-fixture.ts';import {createApp} from '../src/server/app.ts';import {exportReviewOrder} from '../src/core/review-workflow.ts';import {event} from './helpers.ts';
test('管理、规划、执行与审查的经验入口只读相关索引/全文，凭据不能跨项目取内容',async()=>{const raw=fixture();raw.wb.close();const f={...raw,...await createApp(raw.config,{background:false})};try{
 const s=setup(f.wb,f.root),m=f.wb.memory({project_id:'P-workbench',kind:'decision',status:'confirmed',content:'有来源的决定'.repeat(100)+' END_OF_MEMORY',source_id:s.tid});
 f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试用于核验经验读取，不是真实独立审查结果。'}));const order=exportReviewOrder(f.wb,{run_id:s.rid,reviewer_id:'zcode',expected_revision:f.wb.get('tasks',s.tid).revision,reason:'经验上下文权限测试'},{role:'user'});
 const token=(kind:string,id:string)=>JSON.parse(fs.readFileSync(path.join(f.config.dataDir,kind+'-keys',id+'.json'),'utf8')).token;
 for(const actor of [{key:f.wb.keys.manager,binding:{}},{key:f.wb.keys.planner,binding:{}},{key:token('run',s.rid),binding:{run_id:s.rid}},{key:token('review',order.review_id),binding:{review_id:order.review_id}}]){
  const call=(input:any)=>f.app.inject({method:'POST',url:'/api/mcp/get_project_memories',headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+actor.key},payload:{...actor.binding,project_id:'P-workbench',...input}});
  const index=await call({});assert.equal(index.statusCode,200,index.body);assert(!index.body.includes('END_OF_MEMORY'));
  const read=await call({mode:'read',memory_ids:[m.id]});assert.equal(read.statusCode,200,read.body);assert(read.json().items[0].content.endsWith('END_OF_MEMORY'));
  const delta=await call({mode:'read',memory_ids:[m.id],known_hashes:{[m.id]:read.json().items[0].content_hash}});assert.equal(delta.statusCode,200);assert.equal(delta.json().items.length,0);
  if('run_id' in actor.binding||'review_id' in actor.binding)assert.equal((await call({project_id:'P-else'})).statusCode,403);
  if(actor.key!==f.wb.keys.planner){
   const expectedActor='run_id' in actor.binding?'runner:'+s.rid:'review_id' in actor.binding?'reviewer:'+order.review_id:'manager';
   const saved=await f.app.inject({method:'POST',url:'/api/mcp/manage_memories',headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+actor.key},payload:{...actor.binding,request_id:crypto.randomUUID(),user_instruction:'请把这项已说明的项目决定确认为经验，保留由Agent代登记的来源。',change:{project_id:'P-workbench',kind:'decision',status:'confirmed',content:'合成用户明确指示下保存的决定',source_id:s.tid}}});assert.equal(saved.statusCode,200,saved.body);
   const record=saved.json().result;assert.equal(record.source,expectedActor);assert.equal(record.confirmation.basis,'conversation_instruction');assert.equal(record.confirmation.recorded_by,expectedActor);assert(record.confirmation.user_instruction.includes('Agent代登记'));
  }
 }
 const reviewToken=token('review',order.review_id);const context=await f.app.inject({method:'POST',url:'/api/mcp/get_review_assignment',headers:{host:'127.0.0.1:'+f.config.port,authorization:'Bearer '+reviewToken},payload:{review_id:order.review_id}});assert.equal(context.statusCode,200,context.body);assert(context.json().context.project_memory.items.some((x:any)=>x.id===m.id));assert(!context.body.includes('END_OF_MEMORY'));
}finally{await f.app.close()}});

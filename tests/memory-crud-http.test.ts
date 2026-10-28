import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,setup} from './agent-routing-fixture.ts';
import {createApp} from '../src/server/app.ts';

test('真实loopback HTTP：用户与执行者经验CRUD保留来源历史，删除从默认上下文清除并回传delta墓碑',async()=>{
 const raw=fixture();raw.wb.close();raw.config.port=0;const {app,wb}=await createApp(raw.config,{background:false});
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});raw.config.port=Number(new URL(address).port);
  const s=setup(wb,raw.root),token=JSON.parse(fs.readFileSync(path.join(raw.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
  const bootResponse=await fetch(address+'/api/bootstrap'),cookie=bootResponse.headers.get('set-cookie')!.split(';')[0],boot:any=await bootResponse.json();
  const page=async(url:string,body?:unknown,expected=200)=>{
   const r=await fetch(address+'/api'+url,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'content-type':'application/json','x-workbench-csrf':boot.csrf})},body:body===undefined?undefined:JSON.stringify(body)});const data:any=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
  };
  const mcp=async(tool:string,input:any,expected=200)=>{
   const r=await fetch(address+'/api/mcp/'+tool,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({run_id:s.rid,...input})});const data:any=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;
  };
  const manage=async(change:any,expected=200)=>{
   const result=await mcp('manage_memories',{request_id:crypto.randomUUID(),user_instruction:'合成HTTP验证：按本轮用途编辑、收纳或恢复经验，保留原作者与来源。',change},expected);return result.result||result;
  };
  const p=wb.get('projects','P-workbench');wb.put('projects',{...p,id:'P-http-other'});
  for(const origin of ['user','agent']){
   const tail='HTTP_PRIVATE_BODY_'+origin,input={project_id:'P-workbench',kind:'decision',status:'confirmed',content:'合成来源经验'.repeat(70)+tail,source_id:s.tid};
   const created=origin==='user'?await page('/memories',input):await manage(input),originalConfirmation=structuredClone(created.confirmation);
   assert.equal(created.source,origin==='user'?'user':'runner:'+s.rid);assert.equal(created.confirmation.basis,origin==='user'?'user_page':'conversation_instruction');
   const mutation=(change:any,expected=200)=>origin==='user'?page('/memories',change,expected):manage(change,expected);
   const before=await mcp('get_project_memories',{project_id:'P-workbench',mode:'read',memory_ids:[created.id]});assert.equal(before.items[0].content,input.content);
   const known={[created.id]:before.items[0].content_hash};
   const changed=await mutation({action:'update',project_id:'P-workbench',memory_id:created.id,version:1,kind:'known_issue',content:input.content+' UPDATED',scope:'本项目'});
   assert.equal(changed.version,2);assert.equal(changed.source,created.source);assert.equal(changed.source_id,s.tid);assert.deepEqual(changed.confirmation,originalConfirmation);assert.equal(changed.revisions[0].snapshot.content,input.content);
   const editDelta=await mcp('get_project_memories',{project_id:'P-workbench',mode:'read',memory_ids:[created.id],known_hashes:known});assert.equal(editDelta.items.length,1);assert.notEqual(editDelta.items[0].content_hash,known[created.id]);
   await mutation({action:'update',project_id:'P-workbench',memory_id:created.id,version:1,kind:'decision',content:'过期草稿',scope:'project'},409);
   await page('/memories',{action:'update',project_id:'P-workbench',memory_id:created.id,version:2,kind:'decision',content:'伪造作者',scope:'project',source:'user'},400);
   for(const response of [await mcp('get_project_memories',{project_id:'P-workbench'}),await page('/projects/P-workbench/context'),await page('/projects/P-workbench/context?download=1'),await mcp('get_management_context',{section:'memories',project_id:'P-workbench'})])assert(!JSON.stringify(response).includes(tail),'默认上下文只应提供预览，不泄漏正文尾部');
   const deleted=await mutation({action:'delete',project_id:'P-workbench',memory_id:created.id,version:2});assert.equal(deleted.version,3);assert(deleted.deleted_at);
   assert(!(await page('/state')).memories.some((m:any)=>m.id===created.id));
   const index=await mcp('get_project_memories',{project_id:'P-workbench',include_superseded:true});assert(!index.items.some((m:any)=>m.id===created.id));
   const delta=await mcp('get_project_memories',{project_id:'P-workbench',mode:'read',memory_ids:[created.id],known_hashes:known});assert.deepEqual(delta.deleted_ids,[created.id]);assert.equal(delta.items.length,0);assert(!JSON.stringify(delta).includes(tail));assert.notEqual(delta.tombstones[0].version_hash,known[created.id]);
   const history=await page('/projects/P-workbench/memories/history'),record=history.items.find((m:any)=>m.id===created.id);assert(record.deleted_at);assert.equal(record.content,changed.content);assert.equal(record.source,created.source);assert.equal(record.revisions.length,2);
   assert(wb.get('tasks',s.tid));assert(wb.get('runs',s.rid));
   const restored=await mutation({action:'restore',project_id:'P-workbench',memory_id:created.id,version:3});assert.equal(restored.version,4);assert.equal(restored.deleted_at,null);assert.equal(restored.source,created.source);assert.deepEqual(restored.confirmation,originalConfirmation);
   assert((await page('/state')).memories.some((m:any)=>m.id===created.id));assert.equal((await page('/projects/P-workbench/memories/history')).items.find((m:any)=>m.id===created.id).revisions.length,3);
   await mcp('get_project_memories',{project_id:'P-http-other'},403);
   await page('/memories',{action:'delete',project_id:'P-http-other',memory_id:created.id,version:4},403);
  }
  const missingSession=await fetch(address+'/api/projects/P-workbench/memories/history');assert.equal(missingSession.status,401);
  const mixedIdentity=await fetch(address+'/api/projects/P-workbench/memories/history',{headers:{cookie,authorization:'Bearer '+token}});assert.equal(mixedIdentity.status,403);
  const noCsrf=await fetch(address+'/api/memories',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'});assert.equal(noCsrf.status,403);
 }finally{await app.close();}
});

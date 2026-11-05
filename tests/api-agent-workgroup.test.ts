import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createApp} from '../src/server/app.ts';
import type {ExternalVault} from '../src/core/external-vault.ts';
import {fixture} from './helpers.ts';

function vault():ExternalVault{const values=new Map<string,Record<string,string>>();return {available:true,async encrypt(value){const id=crypto.randomUUID();values.set(id,structuredClone(value));return id;},async decrypt(id){assert(values.has(id));return structuredClone(values.get(id)!);}};}
const completion=(message:any)=>new Response(JSON.stringify({model:'synthetic-returned-model',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}),{headers:{'content-type':'application/json'}});
const tool=(name:string,args:object)=>completion({role:'assistant',content:null,tool_calls:[{id:'call_'+crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});

test('API leader dispatches API worker, worker edits a file, same leader session resumes and reads result through authenticated group tools',async t=>{
  const f=fixture();f.wb.close();let memberId='',roomId='',leaderCalls=0,workerCalls=0;
  const output=path.join(f.root,'api-integration-result.json');
  fs.writeFileSync(path.join(f.root,'api-integration-input.json'),'{"a":17,"b":25}');
  const transport:typeof fetch=async(_url,options)=>{
    assert.equal(options?.redirect,'error');const input=JSON.parse(String(options?.body));
    assert(!(options?.body as string).includes('synthetic-secret'));
    if(input.model==='leader-fixture'){
      const round=leaderCalls++;
      if(round===0)return tool('dispatch_workgroup_task',{room_id:roomId,member_id:memberId,request_id:crypto.randomUUID(),instruction:'Read the input and write result.'});
      if(round===1)return completion({role:'assistant',content:'Dispatched a real group job in this isolated synthetic-provider test.'});
      if(round===2){assert(input.messages.some((m:any)=>m.role==='tool'&&String(m.content).includes(memberId)));return tool('read_project_file',{path:output});}
      assert.equal(round,3);assert(input.messages.some((m:any)=>m.role==='tool'&&String(m.content).includes('42')));return completion({role:'assistant',content:'API_LEADER_VERIFIED_42'});
    }
    assert.equal(input.model,'worker-fixture');const round=workerCalls++;
    if(round===0)return tool('read_project_file',{path:'api-integration-input.json'});
    if(round===1)return tool('write_project_file',{path:output,content:'{"sum":42,"by":"api-worker"}',expected_sha256:null});
    assert.equal(round,2);return completion({role:'assistant',content:'API worker wrote the result file.'});
  };
  const r=await createApp(f.config,{background:false,apiAgentVault:vault(),apiAgentFetch:transport});t.after(()=>r.app.close());
  const create=(name:string,model:string)=>r.apiAgents.save({name,model,base_url:'https://fixture.invalid/v1',protocol:'chat_completions',api_key:'synthetic-secret'});
  const leader=await create('API leader','leader-fixture'),worker=await create('API worker','worker-fixture');
  const candidates=await r.workgroups.candidates('P-workbench');assert(candidates.candidates.find(a=>a.agent_id===leader.id)?.available);
  const group=r.workgroups.create({request_id:crypto.randomUUID(),project_id:'P-workbench',name:'API integration',leader_agent_id:leader.id,member_agent_ids:[worker.id],allowed_paths:[f.root],max_followups:2});
  roomId=group.room.id;memberId=group.members.find(m=>m.agent_id===worker.id)!.id;
  const first=r.workgroups.dispatch(roomId,{request_id:crypto.randomUUID(),member_id:group.room.leader_member_id,instruction:'Delegate to API worker and verify its file.'});
  await r.workgroups.drain();await r.workgroups.wait(first.id,15000);
  for(let turn=0;turn<5;turn++){await r.workgroups.drain();const jobs=r.workgroups.detail(roomId).jobs;const active=jobs.filter(j=>['running','queued','launching'].includes(j.status));if(!active.length)break;for(const job of active)if(job.status==='running')await r.workgroups.wait(job.id,15000);}
  const final=r.workgroups.detail(roomId),jobs=final.jobs;
  assert.equal(jobs.length,3);assert(jobs.every(j=>j.status==='completed'&&!j.process_may_be_running&&!j.process_pid));
  const resumed=jobs.find(j=>j.result_of);assert.equal(resumed?.result,'API_LEADER_VERIFIED_42');assert.equal(resumed?.resume_session_id,jobs.find(j=>j.id===first.id)?.session_id);
  assert.equal(leaderCalls,4);assert.equal(workerCalls,3);assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')),{sum:42,by:'api-worker'});
  assert(final.messages.some(m=>m.sender.id===worker.id&&m.kind==='result'));
  assert(!JSON.stringify([final,r.wb.snapshot()]).includes('synthetic-secret'));
  assert.equal(r.wb.db.prepare('SELECT COUNT(*) AS n FROM workgroup_jobs WHERE token_hash IS NOT NULL').get()!.n,0);
});

test('API cancellation stops the in-process HTTP turn without inventing a PID or leaving the member busy',async t=>{
  const f=fixture();f.wb.close();let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
  const r=await createApp(f.config,{background:false,apiAgentVault:vault(),apiAgentFetch:async(_url,options)=>{entered();return new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}});t.after(()=>r.app.close());
  const a=await r.apiAgents.save({name:'API cancellation',base_url:'https://fixture.invalid/v1',protocol:'responses',model:'fixture',api_key:'synthetic-secret'});
  const g=r.workgroups.create({request_id:crypto.randomUUID(),project_id:'P-workbench',name:'cancel',leader_agent_id:a.id,allowed_paths:[f.root]});
  const job=r.workgroups.dispatch(g.room.id,{request_id:crypto.randomUUID(),member_id:g.room.leader_member_id,instruction:'wait for cancellation'});
  await r.workgroups.drain();await started;
  assert.equal(r.workgroups.getJob(g.room.id,job.id).process_phase,'api_request');
  r.workgroups.cancel(g.room.id,job.id);
  const ended=await r.workgroups.wait(job.id,10000);assert.equal(ended.status,'cancelled');assert.equal(ended.process_may_be_running,false);assert.equal(ended.process_pid,null);
  assert.equal(r.workgroups.detail(g.room.id).members[0].status,'idle');
  assert.equal((await r.apiAgents.save({id:a.id,version:1,system_prompt:'Updated only after turn ended'})).version,2);
});

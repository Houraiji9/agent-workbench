import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createApp} from '../src/server/app.ts';
import type {WorkgroupRuntimeInput,WorkgroupRuntimeResult} from '../src/core/workgroup-schema.ts';
import {fixture,setup} from './helpers.ts';
import {ROOT} from '../src/core/config.ts';

async function integration(t:TestContext){
  const f=fixture();f.wb.close();
  const started:WorkgroupRuntimeInput[]=[];
  const finishers=new Map<string,(value:WorkgroupRuntimeResult)=>void>();
  const runtime=await createApp(f.config,{background:false,workgroupRunner:input=>{
    started.push(input);input.onSessionId('isolated-'+input.memberId);
    return new Promise(resolve=>{finishers.set(input.jobId,resolve);input.signal.addEventListener('abort',()=>resolve({status:'cancelled',text:'',exitCode:null,processStopped:true}),{once:true});});
  }});
  t.after(()=>runtime.app.close());
  const host='127.0.0.1:'+f.config.port;
  const boot=await runtime.app.inject({url:'/api/bootstrap',headers:{host}});
  const cookie=String(boot.headers['set-cookie']).split(';')[0],csrf=boot.json().csrf;
  const headers={host,cookie,'x-workbench-csrf':csrf};
  const page=(url:string,body?:object)=>runtime.app.inject({url:'/api'+url,method:body?'POST':'GET',headers,...(body?{payload:body}:{})});
  const mcp=(tool:string,payload:object,token=runtime.wb.keys.manager)=>runtime.app.inject({url:'/api/mcp/'+tool,method:'POST',headers:{host,authorization:'Bearer '+token},payload});
  const create=async(extra:Record<string,unknown>={})=>{
    const result=await mcp('manage_workgroups',{request_id:crypto.randomUUID(),user_instruction:'测试用户明确授权此隔离项目的工作群自动协作',action:'create',data:{project_id:'P-workbench',name:'隔离工作群',leader_agent_id:'codex',member_agent_ids:['claude'],allowed_paths:[f.root],max_followups:0,...extra}});
    assert.equal(result.statusCode,200,result.body);return result.json();
  };
  const start=async(room:any,memberId=room.room.leader_member_id)=>{
    const response=await mcp('dispatch_workgroup_task',{room_id:room.room.id,request_id:crypto.randomUUID(),member_id:memberId,instruction:'隔离运行器验证，不调用模型'});
    assert.equal(response.statusCode,200,response.body);
    await runtime.workgroups.drain();
    const input=started.find(value=>value.jobId===response.json().id);assert(input);
    return {job:response.json(),input};
  };
  const finish=async(jobId:string)=>{finishers.get(jobId)!({status:'completed',text:'隔离运行器回报',exitCode:0,processStopped:true});return runtime.workgroups.wait(jobId);};
  return {...f,...runtime,started,finishers,host,headers,page,mcp,create,start,finish};
}

test('workgroup page routes enforce session/CSRF; manager management records actual instruction and is idempotent',async t=>{
  const f=await integration(t);
  const payload={request_id:crypto.randomUUID(),project_id:'P-workbench',name:'测试',leader_agent_id:'codex'};
  assert.equal((await f.app.inject({url:'/api/workgroups',method:'POST',headers:{host:f.host},payload})).statusCode,401);
  assert.equal((await f.app.inject({url:'/api/workgroups',method:'POST',headers:{host:f.host,cookie:f.headers.cookie},payload})).statusCode,403);
  assert.equal((await f.app.inject({url:'/api/workgroups',headers:{...f.headers,authorization:'Bearer '+f.wb.keys.manager}})).statusCode,403);
  const command={request_id:crypto.randomUUID(),user_instruction:'创建这个测试工作群并启用协作',action:'create',data:{project_id:'P-workbench',name:'Manager创建',leader_agent_id:'claude',member_agent_ids:['codex']}};
  const first=await f.mcp('manage_workgroups',command),again=await f.mcp('manage_workgroups',command);
  assert.equal(first.statusCode,200,first.body);assert.deepEqual(again.json(),first.json());
  assert.equal(f.workgroups.list().rooms.length,1);
  const audit=f.wb.db.prepare("SELECT actor,data FROM audit WHERE action='manage_workgroups'").all() as any[];
  assert(audit.some(row=>row.actor==='manager'&&row.data.includes(command.user_instruction)));
  assert.equal((await f.mcp('manage_workgroups',command,f.wb.keys.planner)).statusCode,403);
  assert.equal((await f.mcp('manage_workgroups',{...command,data:{...command.data,name:'changed'}})).statusCode,409);
});

test('job capability is room/member bound, cannot manage grants or impersonate; terminal token is revoked',async t=>{
  const f=await integration(t),a=await f.create(),b=await f.create();
  const {job,input}=await f.start(a),token=input.mcp.token;
  assert.equal(input.mcp.tools.length,12);
  const list=await f.mcp('list_workgroups',{},token);assert.equal(list.statusCode,200);assert.deepEqual(list.json().rooms.map((r:any)=>r.id),[a.room.id]);
  assert.equal((await f.mcp('get_workgroup_context',{room_id:b.room.id},token)).statusCode,403);
  assert.equal((await f.mcp('manage_workgroups',{request_id:crypto.randomUUID(),user_instruction:'伪造用户允许',action:'create',data:{}},token)).statusCode,403);
  assert.equal((await f.mcp('get_management_context',{},token)).statusCode,403);
  const posted=await f.mcp('post_workgroup_message',{room_id:a.room.id,request_id:crypto.randomUUID(),content:'真实身份的测试发言'},token);
  assert.equal(posted.statusCode,200,posted.body);assert.equal(posted.json().message.sender.id,'codex');
  assert.equal((await f.mcp('post_workgroup_message',{room_id:a.room.id,request_id:crypto.randomUUID(),content:'伪造身份',sender_id:'claude'},token)).statusCode,400);
  assert.equal(f.started.length,1,'ordinary message does not launch another agent');
  await f.finish(job.id);
  assert.equal((await f.mcp('list_workgroups',{},token)).statusCode,401);
  assert(!JSON.stringify(f.workgroups.detail(a.room.id)).includes(token));
});

test('runner management and dispatch stay inside current Run paths and preserve real actor',async t=>{
  const f=await integration(t),run=setup(f.wb,f.root);
  const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',run.rid+'.json'),'utf8')).token;
  const room=await f.mcp('manage_workgroups',{run_id:run.rid,request_id:crypto.randomUUID(),user_instruction:'按本单范围创建测试群',action:'create',data:{project_id:'P-workbench',name:'Runner创建',leader_agent_id:'codex',member_agent_ids:['claude'],allowed_paths:[f.root]}},token);
  assert.equal(room.statusCode,200,room.body);
  assert.equal(room.json().room.authorization.actor,'runner:'+run.rid);
  const dispatch=await f.mcp('dispatch_workgroup_task',{run_id:run.rid,room_id:room.json().room.id,request_id:crypto.randomUUID(),member_id:room.json().members.find((m:any)=>m.agent_id==='claude').id,instruction:'测试真实身份的排队'},token);
  assert.equal(dispatch.statusCode,200,dispatch.body);assert.equal(dispatch.json().actor.id,'codex');
  const another=path.join(f.root,'another');fs.mkdirSync(another);const project=f.wb.registerProject({name:'另一个项目',path:another});
  assert.equal((await f.mcp('manage_workgroups',{run_id:run.rid,request_id:crypto.randomUUID(),user_instruction:'伪造扩展到其他项目',action:'create',data:{project_id:project.id,name:'越界群',leader_agent_id:'codex'}},token)).statusCode,403);
});

test('group external tools preserve Agent/project and narrower file scope across turns',async t=>{
  const f=await integration(t),narrow=path.join(f.root,'narrow');fs.mkdirSync(narrow);
  const room=await f.create({allowed_paths:[narrow]}),{job,input}=await f.start(room);
  const envelope=new Map<string,Record<string,string>>();
  Object.defineProperty(f.externalServices,'vault',{value:{available:true,async encrypt(v:Record<string,string>){const key=crypto.randomUUID();envelope.set(key,v);return key;},async decrypt(key:string){return envelope.get(key)!;}}});
  const requests:any[]=[];
  Object.defineProperty(f.externalServices,'fetcher',{value:async(url:string,init:any)=>{requests.push({url,body:JSON.parse(init.body)});return Response.json({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII='}]});}});
  const saved=await f.externalServices.save({preset_id:'openai-images',name:'隔离图片',base_url:'https://fixture.invalid/v1',enabled:true,model:'fixture',allowed_project_ids:['P-workbench'],allowed_agent_ids:['codex'],allow_paid:true,secrets:{apiKey:'fixture-secret-value'}});
  const visible=await f.mcp('list_external_services',{},input.mcp.token);assert.equal(visible.statusCode,200);assert(visible.json().services.some((s:any)=>s.id===saved.id));
  const invoke=(operation:string,data:object)=>f.mcp('invoke_external_service',{service_id:saved.id,request_id:crypto.randomUUID(),operation,input:data},input.mcp.token);
  const outside=path.join(f.root,'outside.png');fs.writeFileSync(outside,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=','base64'));
  const rejected=await invoke('image.edit',{prompt:'synthetic',images:[outside]});assert.equal(rejected.statusCode,200,rejected.body);
  assert.equal((await f.externalServices.wait(rejected.json().id)).status,'failed');assert.equal(requests.length,0,'outside file never reaches provider');
  const accepted=await invoke('image.generate',{prompt:'synthetic'});assert.equal(accepted.statusCode,200,accepted.body);
  const done=await f.externalServices.wait(accepted.json().id);assert.equal(done.status,'succeeded');assert.equal(requests.length,1);assert.equal(done.agent_id,'codex');assert(done.artifacts[0].path.startsWith(narrow+path.sep));
  await f.finish(job.id);
  const next=await f.start(room);
  const poll=await f.mcp('get_external_invocation',{invocation_id:done.id},next.input.mcp.token);assert.equal(poll.statusCode,200,poll.body);
  const other=await f.start(room,room.members.find((m:any)=>m.agent_id==='claude').id);
  assert.equal((await f.mcp('get_external_invocation',{invocation_id:done.id},other.input.mcp.token)).statusCode,403);
  await f.finish(next.job.id);await f.finish(other.job.id);
});

test('real stdio manager MCP advertises workgroup tools and reaches the same HTTP ledger',async t=>{
  const f=await integration(t);await f.app.listen({host:'127.0.0.1',port:f.config.port});
  const client=new Client({name:'isolated-workgroup-interface',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env:{...Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!/^WORKBENCH_/i.test(key))) as Record<string,string>,WORKBENCH_ROOT:f.root,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port)},stderr:'pipe'});
  t.after(()=>client.close());await client.connect(transport);
  const tools=await client.listTools();assert(tools.tools.some(tool=>tool.name==='manage_workgroups'));assert(tools.tools.some(tool=>tool.name==='dispatch_workgroup_task'));
  const result:any=await client.callTool({name:'manage_workgroups',arguments:{request_id:crypto.randomUUID(),user_instruction:'真实stdio连接创建隔离工作群',action:'create',data:{project_id:'P-workbench',name:'stdio测试',leader_agent_id:'claude',member_agent_ids:['codex']}}});
  assert(!result.isError,JSON.stringify(result));const value=JSON.parse(result.content[0].text);assert.equal(value.room.name,'stdio测试');assert.equal(f.workgroups.list().rooms.length,1);
});

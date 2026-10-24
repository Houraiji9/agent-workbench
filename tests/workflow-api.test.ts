import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fixture,setup,event} from './helpers.ts';import {createApp} from '../src/server/app.ts';

test('新上下文和简洁回报接口保留角色与Run权限边界',async()=>{const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});try{const a=setup(wb,f.root),b=setup(wb,f.root);const key=(rid:string)=>JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',rid+'.json'),'utf8')).token;const call=(tool:string,data:any,token=key(a.rid))=>app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:14317',authorization:'Bearer '+token},payload:data});
 const ctx=await call('get_run_context',{run_id:a.rid});assert.equal(ctx.statusCode,200);const hash=ctx.json().context_hash;
 assert.notEqual((await call('get_run_context',{run_id:b.rid})).statusCode,200);
 assert.equal((await call('ack_run_context',{run_id:a.rid,context_hash:hash,session_id:'test-session'})).statusCode,200);
 assert.equal((await call('report_run_activity',{run_id:a.rid,event_id:'api-start',event_type:'started',data:{message:'测试真实接口接单'}},wb.keys.manager)).statusCode,403);
 const started=await call('report_run_activity',{run_id:a.rid,event_id:'api-start',event_type:'started',data:{message:'测试真实接口接单'}});assert.equal(started.statusCode,200);assert.equal(started.json().disposition,'applied');assert.equal(wb.get('runs',a.rid).seq,1);
 assert.equal((await call('get_project_graph',{run_id:a.rid,project_id:'P-workbench'})).statusCode,403);
 for(const name of ['wait_run_update','complete_run_closeout']){const input=name==='wait_run_update'?{run_id:a.rid,after_revision:0,timeout_ms:0}:{run_id:a.rid,event_id:'finish',result:'隔离测试验证管理连接不能代执行者完成收尾工作。',closeout_results:[]};assert.equal((await call(name,input,wb.keys.manager)).statusCode,name==='wait_run_update'?200:403);assert([401,403].includes((await call(name,{...input,run_id:b.rid})).statusCode));}
 assert.equal((await call('wait_run_update',{run_id:a.rid,after_revision:0,timeout_ms:0})).json().changed,true);
 assert.equal((await call('report_run_activity',{run_id:a.rid,event_id:'spoof',event_type:'progress',data:{identity:'grok-build',message:'伪装身份'}})).statusCode,400);
 const brief=await call('get_dispatch_context',{project_id:'P-workbench'},wb.keys.planner);assert.equal(brief.statusCode,200);assert.equal(brief.json().detail,'brief');assert(!brief.json().tasks[0].scope);
 const full=await call('get_project_context',{project_id:'P-workbench',detail:'full'},wb.keys.planner);assert(full.json().tasks[0].scope);
}finally{await app.close()}});

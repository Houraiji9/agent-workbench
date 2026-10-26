import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,setup,event} from './helpers.ts';
import {Workbench} from '../src/core/workbench.ts';
import {createApp} from '../src/server/app.ts';
import {quotaPercent} from '../src/web/quota.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ROOT} from '../src/core/config.ts';

test('额度：0/100、多窗口、未知、无总额余额及矛盾数据不得误导',()=>{
  assert.equal(quotaPercent({remaining_percent:0}),0);assert.equal(quotaPercent({remaining_percent:100}),100);
  assert.equal(quotaPercent({used_percent:25}),75);assert.equal(quotaPercent({remaining:20,limit:80}),25);
  for(const w of [{},{remaining:200},{remaining:0,limit:0},{remaining:-1,limit:100},{remaining:101,limit:100},{remaining_percent:101},{remaining_percent:NaN},{remaining_percent:80,used_percent:80}])assert.equal(quotaPercent(w),null);
});

test('项目编辑：持久化、版本冲突、字段白名单和审计；目录及权限保留',()=>{
  const f=fixture(),p=f.wb.get('projects','P-workbench');
  const changes={name:'修改后的中文项目',goal:'方便我自己管理',stage:'试用',next_step:'查看新版页面'};
  const after=f.wb.editProject(p.id,{version:p.version,changes});assert.deepEqual(after.paths,p.paths);assert.equal(after.data_policy,p.data_policy);
  assert.throws(()=>f.wb.editProject(p.id,{version:p.version,changes}),/版本冲突/);
  assert.throws(()=>f.wb.editProject(p.id,{version:after.version,changes:{...changes,paths:['C:/']}}));
  assert.throws(()=>f.wb.editProject(p.id,{version:after.version,changes:{...changes,name:'   '}}));
  const audit:any=f.wb.db.prepare("SELECT data FROM audit WHERE action='edit_project'").get();assert.equal(JSON.parse(audit.data).before.name,p.name);
  f.wb.close();const reopened=new Workbench(f.config);assert.equal(reopened.get('projects',p.id).name,changes.name);reopened.close();
});

test('回答绑定真实问题，保存/修改/重复不恢复执行，重启保留且旧问题不串新问题',()=>{
  const f=fixture(),s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));
  const question=f.wb.event(event(f.root,s.tid,s.rid,2,'waiting_input',{message:'希望保留哪些内容？'}));
  const input={run_id:s.rid,question_event_id:question.id,revision:f.wb.get('tasks',s.tid).revision,message:'保留项目和订阅记录'};
  const answer=f.wb.saveReply(s.tid,input);assert.equal(f.wb.saveReply(s.tid,input).id,answer.id);
  assert.equal(f.wb.get('tasks',s.tid).status,'waiting_input');assert.equal(f.wb.get('runs',s.rid).seq,2);
  assert.throws(()=>f.wb.saveReply(s.tid,{...input,message:'过期表单覆盖'}),/版本冲突/);
  const revised=f.wb.saveReply(s.tid,{...input,revision:f.wb.get('tasks',s.tid).revision,message:'也保留历史回答'});
  assert.equal(revised.history[0].message,input.message);assert.equal(revised.delivery,'saved_only');
  assert.throws(()=>f.wb.saveReply(s.tid,{...input,question_event_id:'other'}),/问题已变化/);
  const other=setup(f.wb,f.root);assert.throws(()=>f.wb.saveReply(other.tid,input),/不属于当前执行/);
  f.wb.close();const wb=new Workbench(f.config);assert.equal(wb.runFeedback(s.rid).replies[0].message,'也保留历史回答');
  wb.event(event(f.root,s.tid,s.rid,3));assert.equal(wb.runFeedback(s.rid).current_question,null);
  assert.throws(()=>wb.saveReply(s.tid,input),/不在等待/);
  const q2=wb.event(event(f.root,s.tid,s.rid,4,'waiting_input',{message:'这次使用哪种颜色？'}));
  assert.throws(()=>wb.saveReply(s.tid,{...input,revision:wb.get('tasks',s.tid).revision}),/问题已变化/);
  assert.equal(wb.runFeedback(s.rid).current_question?.id,q2.id);assert.equal(wb.taskDetail(s.tid).reply_history.length,1);
  wb.event(event(f.root,s.tid,s.rid,5,'failed'));wb.exportOrder(s.tid,1,true,'codex',wb.get('tasks',s.tid).revision);
  assert.throws(()=>wb.saveReply(s.tid,input),/不属于当前执行/);assert.equal(wb.taskDetail(s.tid).reply_history.length,1);wb.close();
});

test('回答 HTTP/MCP 权限：CSRF、planner只读、runner限自己，旧执行不能写',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
  try{const host='127.0.0.1:'+f.config.port,s=setup(wb,f.root),other=setup(wb,f.root);wb.event(event(f.root,s.tid,s.rid,1));
  const q=wb.event(event(f.root,s.tid,s.rid,2,'waiting_input',{message:'使用什么名字？'}));
  const key=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
  const input={run_id:s.rid,question_event_id:q.id,revision:wb.get('tasks',s.tid).revision,message:'我的工作台'};
  const boot=await app.inject({url:'/api/bootstrap',headers:{host}}),cookie=String(boot.headers['set-cookie']).split(';')[0];
  assert.equal((await app.inject({url:'/api/tasks/'+s.tid+'/reply',method:'POST',headers:{host,cookie},payload:input})).statusCode,403);
  assert.equal((await app.inject({url:'/api/tasks/'+s.tid+'/reply',method:'POST',headers:{host,cookie,'x-workbench-csrf':boot.json().csrf},payload:input})).statusCode,200);
  for(const token of [key,wb.keys.planner]){const r=await app.inject({url:'/api/mcp/get_run_feedback',method:'POST',headers:{host,authorization:'Bearer '+token},payload:{run_id:s.rid}});assert.equal(r.statusCode,200);assert.equal(r.json().replies[0].message,input.message);}
  assert.equal((await app.inject({url:'/api/mcp/get_run_feedback',method:'POST',headers:{host,authorization:'Bearer '+key},payload:{run_id:other.rid}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/mcp/save_reply',method:'POST',headers:{host,authorization:'Bearer '+wb.keys.planner},payload:input})).statusCode,403);
  assert.equal(wb.get('tasks',s.tid).status,'waiting_input');
  }finally{await app.close();}
});

test('真实 stdio MCP 可查询用户回答；执行者只暴露本 Run 回报、回答查询与可核验的审查回传',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
  const client=new Client({name:'isolated-feedback-test',version:'0.1.0'});
  try{const address=await app.listen({host:'127.0.0.1',port:0});f.config.port=Number(new URL(address).port);
    const s=setup(wb,f.root);wb.event(event(f.root,s.tid,s.rid,1));const q=wb.event(event(f.root,s.tid,s.rid,2,'waiting_input',{message:'测试问题'}));
    wb.saveReply(s.tid,{run_id:s.rid,question_event_id:q.id,revision:wb.get('tasks',s.tid).revision,message:'测试回答'});
    const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
    Object.assign(env,{WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port),WORKBENCH_RUN_ID:s.rid});
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env,stderr:'pipe'}));
    const names=(await client.listTools()).tools.map(t=>t.name);
    for(const name of ['manage_requests','manage_tasks','manage_reviews','get_run_feedback','report_run_activity','recover_native_review'])assert(names.includes(name),name);
    for(const name of ['submit_task_plan','dispatch_run','manage_settings','confirm_user_decision'])assert(!names.includes(name),name);
    const result=await client.callTool({name:'get_run_feedback',arguments:{run_id:s.rid}});assert(!result.isError);
    assert.equal(JSON.parse((result.content as any)[0].text).replies[0].message,'测试回答');
  }finally{await client.close();await app.close();}
});

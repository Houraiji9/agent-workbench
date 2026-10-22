import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture,setup,event,taskInput} from './helpers.ts';
import {ROOT} from '../src/core/config.ts';
import {hash} from '../src/core/security.ts';
import {createApp} from '../src/server/app.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('F01：残缺表格、单独竖线与 HTML 文本均能在有限时间内安全渲染',()=>{
  const code=`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {MarkdownText} from './src/web/ui/TextView.tsx';
    const samples=['普通中文报告','| 列一 | 列二 |','| 列一 | 列二','|','>','<img src=x onerror="alert(1)">'];
    console.log(JSON.stringify(samples.map(text=>renderToStaticMarkup(React.createElement(MarkdownText,{text})))));`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:ROOT,encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(child.error,undefined,'Markdown 渲染不能超时');assert.equal(child.status,0,child.stderr);
  const rendered=JSON.parse(child.stdout);assert.match(rendered[2],/列一.*列二/);assert.match(rendered[3],/\|/);assert.match(rendered[5],/&lt;img/);assert.doesNotMatch(rendered[5],/<img/);
});

test('F02：新 Run 包固化上一轮 Review 和阻碍，旧包逐字不变',()=>{
 const {wb,root}=fixture();try{
  const s=setup(wb,root),oldRun=wb.get('runs',s.rid);
  const oldFiles=['RUN.md','CONTEXT.md','task.json'].map(f=>({file:path.join(oldRun.directory,f),hash:hash(fs.readFileSync(path.join(oldRun.directory,f)))}));
  wb.event(event(root,s.tid,s.rid,1));wb.event(event(root,s.tid,s.rid,2,'blocked',{message:'测试阻碍：目录没有写入权限'}));wb.event(event(root,s.tid,s.rid,3));
  wb.event(event(root,s.tid,s.rid,4,'submitted',{result:'测试交付：已完成临时文件修改，但修复是否正确仍需独立检查。'}));
  const review=wb.review({run_id:s.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',findings:'测试审查：分页必须能够回看第一页',evidence:'隔离夹具，仅测试审查协议，并非真实审查',artifact_hashes:wb.all('artifacts').map(a=>a.sha256)});
  const next=wb.exportOrder(s.tid,1,true,undefined,wb.get('tasks',s.tid).revision);
  const body=fs.readFileSync(next.path,'utf8');for(const text of [s.rid,review.id,'分页必须能够回看第一页','目录没有写入权限'])assert.ok(body.includes(text),text);
  const r=wb.get('runs',next.run_id),snapshot=JSON.stringify(r.retry_context);review.findings='后来的意见不能改变已发包';wb.put('reviews',review,{run_id:s.rid});
  assert.equal(wb.exportOrder(s.tid,1).run_id,next.run_id);assert.equal(JSON.stringify(wb.get('runs',next.run_id).retry_context),snapshot);
  for(const f of oldFiles)assert.equal(hash(fs.readFileSync(f.file)),f.hash);
  assert.throws(()=>wb.event(event(root,s.tid,s.rid,5)),/旧 Run/);
 }finally{wb.close()}
});

test('F03：未生成 Run 且依赖未完成的任务可取消，保留版本与审计',()=>{
 const {wb,root}=fixture();try{
  const q=wb.request({project_id:'P-workbench',text:'测试取消未开始的依赖任务'});
  const p=wb.submitPlan({schema_version:1,plan_id:q.id,request_id:q.id,expected_version:1,tasks:[taskInput(root,'a'),{...taskInput(root,'b'),dependencies:['a']}]});
  const tid=p.task_ids[1];assert.throws(()=>wb.exportOrder(tid,1),/前置任务/);
  assert.throws(()=>wb.manualAction(tid,'cancel',0),/更新/);
  assert.equal(wb.manualAction(tid,'cancel',1).status,'cancelled');assert.equal(wb.all('runs').length,0);
  assert.equal(wb.get('tasks',tid).revision,2);assert.equal(wb.db.prepare("SELECT count(*) AS n FROM audit WHERE action='cancel' AND entity_id=?").get(tid)!.n,1);
 }finally{wb.close()}
});

test('F04：阻塞执行必须先取消，再重试，旧执行不能再回报',()=>{
 const {wb,root}=fixture();try{
  const s=setup(wb,root);wb.event(event(root,s.tid,s.rid,1));wb.event(event(root,s.tid,s.rid,2,'blocked',{message:'测试：需要重新派单'}));
  assert.throws(()=>wb.exportOrder(s.tid,1,true,undefined,wb.get('tasks',s.tid).revision),/先交付/);
  const t=wb.manualAction(s.tid,'cancel',wb.get('tasks',s.tid).revision);const r=wb.exportOrder(s.tid,1,true,undefined,t.revision);
  assert.equal(wb.get('runs',s.rid).status,'cancelled');assert.notEqual(s.rid,r.run_id);assert.match(fs.readFileSync(r.path,'utf8'),/需要重新派单/);
  assert.throws(()=>wb.event(event(root,s.tid,s.rid,3)),/旧 Run/);
 }finally{wb.close()}
});

test('F08：先按类型筛选再限量，101 条较新会话不会挤掉任务',()=>{
 const {wb,root}=fixture();try{
  const s=setup(wb,root);const task=wb.get('tasks',s.tid);task.updated_at='2020-01-01';wb.put('tasks',task,{project_id:task.project_id});
  for(let i=0;i<101;i++)wb.upsertSession({native_id:'test-'+i,agent:'codex',source:'agentsview',source_id:String(i),title:'测试会话'+i,updated_at:'2026-10-20'});
  const tasks=wb.history({kind:'task',limit:100});assert.equal(tasks.items.length,1);assert.equal(tasks.items[0].id,s.tid);assert.equal(tasks.total,1);assert.equal(tasks.has_more,false);
  const sessions=wb.history({kind:'session',limit:100});assert.equal(sessions.items.length,100);assert.equal(sessions.total,101);assert.equal(sessions.has_more,true);
  assert.throws(()=>wb.history({kind:'invalid'}),/类型/);
 }finally{wb.close()}
});

test('F08：真实 stdio MCP 暴露 kind 并按类型返回记录',async()=>{
 const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
 const client=new Client({name:'isolated-history-test',version:'0.1.0'});
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});f.config.port=Number(new URL(address).port);
  const s=setup(wb,f.root);wb.upsertSession({native_id:'mcp-history',agent:'codex',source:'agentsview',source_id:'mcp-history',title:'隔离会话'});
  const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));delete env.WORKBENCH_RUN_ID;
  Object.assign(env,{WORKBENCH_ROOT:f.root,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port)});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env,stderr:'pipe'}));
  const tool=(await client.listTools()).tools.find(t=>t.name==='search_execution_history')!;
  assert.ok(tool.inputSchema.properties?.kind);
  const result=await client.callTool({name:'search_execution_history',arguments:{kind:'task',limit:100}});assert.ok(!result.isError);
  const data=JSON.parse((result.content as any)[0].text);assert.equal(data.total,1);assert.equal(data.items[0].id,s.tid);
 }finally{await client.close();await app.close()}
});

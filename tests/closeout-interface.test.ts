import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,setup,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {ROOT} from '../src/core/config.ts';
import {exportCloseoutOrder,getCloseoutContext} from '../src/core/closeout.ts';
import {exportReviewOrder,startReview,submitReviewResult,reportReviewHandoff} from '../src/core/review-workflow.ts';
import {isYourTurn,isTheirTurn,relayOf} from '../src/web/lib/flow.ts';
function delivered(){const f=fixture(),s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付，验证真实接口的身份和收尾流程，不代表生产交付。'}));return {...f,...s}}
function pass(f:ReturnType<typeof delivered>){return f.wb.review({run_id:f.rid,reviewer_id:'grok-build',performed:true,evidence:'隔离测试模拟独立审查，只验证接口契约',verdict:'passed',artifact_hashes:f.wb.all('artifacts').map(a=>a.sha256)})}

test('手动派审轮到用户；直接调用先由执行者安排，审查者接单才变成正在审查',()=>{
  const f=delivered(),{wb}=f;try{
    let t=wb.get('tasks',f.tid);assert(isYourTurn(t));assert(!isTheirTurn(t));
    const o=exportReviewOrder(wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:t.revision,reason:'隔离测试直接调用 Claude CLI',delivery_mode:'agent'},{role:'runner'});
    t=wb.get('tasks',f.tid);assert(!isYourTurn(t));assert(isTheirTurn(t));assert.equal(relayOf(t,x=>x).holder,'agent');assert.equal(wb.get('review_assignments',o.review_id).status,'awaiting_dispatch');
    startReview(wb,{review_id:o.review_id,identity:'claude'});t=wb.get('tasks',f.tid);assert.equal(relayOf(t,x=>x).holder,'reviewer');
    submitReviewResult(wb,{...o.context.final_response,review_id:o.review_id,verdict:'passed',findings:[],limitations:['隔离测试'],evidence:['接口测试证据'],report_markdown:'隔离测试审查报告，验证直接调用完成后交回执行者收尾。'},'reviewer:'+o.review_id);
    t=wb.get('tasks',f.tid);assert.equal(t.status,'awaiting_closeout');assert.equal(t.closeout_delivery,'agent');assert(isTheirTurn(t));assert(!isYourTurn(t));
  }finally{wb.close()}
});

test('直接调用失败回到轮到用户，撤销旧审查权限；人工重新选人可继续',()=>{
  const f=delivered(),{wb}=f;try{
    const o=exportReviewOrder(wb,{run_id:f.rid,reviewer_id:'claude',expected_revision:wb.get('tasks',f.tid).revision,reason:'测试直接调用',delivery_mode:'agent'},{role:'runner'});startReview(wb,{review_id:o.review_id,identity:'claude'});
    const before=wb.get('tasks',f.tid);reportReviewHandoff(wb,{run_id:f.rid,review_id:o.review_id,expected_revision:before.revision,reason:'Claude CLI 登录过期，需要用户重新登录'});
    const t=wb.get('tasks',f.tid);assert(isYourTurn(t));assert(!isTheirTurn(t));assert.equal(wb.all('reviews').length,0);
    assert.throws(()=>submitReviewResult(wb,{...o.context.final_response,review_id:o.review_id,verdict:'passed',findings:[],limitations:[],evidence:['晚到的回执'],report_markdown:'隔离测试：这份迟到的回执已被失败交接撤销，不能再推进。'},'reviewer:'+o.review_id),/失效/);
    const manual=exportReviewOrder(wb,{run_id:f.rid,reviewer_id:'zcode',expected_revision:t.revision,reason:'由用户手动转发',delivery_mode:'manual'},{role:'user'});assert.notEqual(o.review_id,manual.review_id);assert(isYourTurn(wb.get('tasks',f.tid)));
  }finally{wb.close()}
});

test('收尾的真实 stdio MCP：planner与reviewer不能代回报，runner不能跨Run；上下文与回传一致',async()=>{
  const f=delivered();const assigned=exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id:'grok-build',expected_revision:f.wb.get('tasks',f.tid).revision,reason:'隔离测试审查权限'},{role:'user'});pass(f);const other=setup(f.wb,f.root);f.wb.close();const {app,wb}=await createApp(f.config,{background:false});await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;f.config.port=port;
  const client=new Client({name:'closeout-scoped-test',version:'1'}),env={...process.env,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(port),WORKBENCH_RUN_ID:f.rid};delete (env as any).WORKBENCH_REVIEW_ID;
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env:env as Record<string,string>,stderr:'pipe'}));
    const call=async(name:string,args:any)=>{const r=await client.callTool({name,arguments:args});return {error:r.isError,data:JSON.parse((r.content as any)[0].text)}};
    const ctx=(await call('get_closeout_context',{run_id:f.rid})).data;assert.equal(ctx.closeout.status,'awaiting_dispatch');
    assert.equal((await call('get_closeout_context',{run_id:other.rid})).error,true);
    const e=event(f.root,f.tid,f.rid,ctx.next_seq,'closeout_started',{closeout_id:ctx.closeout.id});
    const denied=await app.inject({method:'POST',url:'/api/mcp/report_run_event',headers:{host:`127.0.0.1:${port}`,authorization:'Bearer '+wb.keys.planner},payload:e});assert.equal(denied.statusCode,403);
    const reviewToken=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',assigned.review_id+'.json'),'utf8')).token;const reviewerDenied=await app.inject({method:'POST',url:'/api/mcp/report_run_event',headers:{host:`127.0.0.1:${port}`,authorization:'Bearer '+reviewToken},payload:{...e,review_id:assigned.review_id}});assert.equal(reviewerDenied.statusCode,403);
    const started=await call('report_run_event',e);assert.equal(started.error,false);assert.equal(started.data.disposition,'applied');assert.equal(wb.get('tasks',f.tid).status,'closing');
  }finally{await client.close();await app.close()}
});

test('并发 HTTP 收尾回报：相同接单幂等，同序号的不同完成结果只能保存一份',async()=>{
  const f=delivered();pass(f);f.wb.close();
  const {app,wb}=await createApp(f.config,{background:false});
  await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;f.config.port=port;
  try{
    const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',f.rid+'.json'),'utf8')).token;
    const post=async(payload:unknown)=>{const res=await fetch(`http://127.0.0.1:${port}/api/mcp/report_run_event`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload)});return {status:res.status,body:await res.json() as any}};
    const ctx=getCloseoutContext(wb,f.rid),started=event(f.root,f.tid,f.rid,ctx.next_seq,'closeout_started',{closeout_id:ctx.closeout.id});
    const starts=await Promise.all(Array.from({length:8},()=>post(started)));
    assert(starts.every(r=>r.status===200&&r.body.disposition==='applied'),JSON.stringify(starts));
    assert.equal(wb.all('events').filter(e=>e.run_id===f.rid&&e.event_type==='closeout_started').length,1);
    assert.equal(wb.get('runs',f.rid).seq,ctx.next_seq);
    const completed=(suffix:string)=>event(f.root,f.tid,f.rid,ctx.next_seq+1,'closeout_completed',{closeout_id:ctx.closeout.id,result:'并发测试实际收尾报告：全部事项已逐项核对；'+suffix,closeout_results:ctx.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离并发测试逐项检查结果'}))});
    const first=completed('报告甲'),second=completed('报告乙');
    const attempts=Array.from({length:8},(_,i)=>i%2?second:first),results=await Promise.all(attempts.map(post));
    assert.equal(results.filter(r=>r.status===200&&r.body.disposition==='applied').length,4);
    assert.equal(results.filter(r=>r.status===409).length,4);
    const saved=wb.all('events').filter(e=>e.run_id===f.rid&&e.event_type==='closeout_completed');assert.equal(saved.length,1);
    assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');
    const closeout=getCloseoutContext(wb,f.rid).closeout;assert.equal(fs.readFileSync(closeout.report_path,'utf8'),saved[0].data.result);
    const winning=first.event_id===saved[0].id?first:second;assert.equal((await post(winning)).body.disposition,'applied');
    assert.equal(fs.readFileSync(closeout.report_path,'utf8'),saved[0].data.result);
  }finally{await app.close()}
});

test('Windows 收尾单原文命令在中文空格目录且无 PATH 时完成接单、上下文、逐项回传',{skip:process.platform!=='win32'},async()=>{
  const f=delivered();pass(f);const o=exportCloseoutOrder(f.wb,{run_id:f.rid,expected_revision:f.wb.get('tasks',f.tid).revision}),body=fs.readFileSync(o.order_path,'utf8');f.wb.close();
  const {app,wb}=await createApp(f.config,{background:false});await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;f.config.port=port;
  try{
    const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(port)};for(const k of Object.keys(env))if(['path','node_path','node_options','workbench_root','workbench_run_id','workbench_review_id'].includes(k.toLowerCase()))delete env[k];env.PATH='';
    const cwd=path.join(f.root,'外部 Agent 目录');fs.mkdirSync(cwd);const lines=body.split(/\r?\n/).filter(x=>x.startsWith('& '));assert.equal(lines.length,3);
    const ps=path.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const run=async(line:string)=>{const script='[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'+line+'\nexit $LASTEXITCODE';const result=await promisify(execFile)(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd,env,windowsHide:true,timeout:30000});return JSON.parse(result.stdout.trim())};
    assert.equal((await run(lines[0])).next_seq,3);assert.equal((await run(lines[1])).disposition,'applied');const ctx=await run(lines[0]);assert.equal(ctx.next_seq,4);
    const e=event(f.root,f.tid,f.rid,ctx.next_seq,'closeout_completed',{closeout_id:o.closeout_id,result:'Windows 原文命令测试的实际收尾报告，逐项检查完毕并提交。',closeout_results:ctx.closeout.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试原文命令实际运行完成'}))});
    fs.writeFileSync(path.join(path.dirname(o.order_path),'result.json'),JSON.stringify(e));assert.equal((await run(lines[2])).disposition,'applied');assert.equal(wb.get('tasks',f.tid).status,'awaiting_confirmation');assert.equal(getCloseoutContext(wb,f.rid).closeout.status,'completed');
  }finally{await app.close()}
});

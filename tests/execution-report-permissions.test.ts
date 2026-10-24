import {Workbench} from '../src/core/workbench.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,setup,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {ROOT} from '../src/core/config.ts';
import {manage} from '../src/core/management.ts';
import {exportReviewOrder,startReview,submitReviewResult} from '../src/core/review-workflow.ts';

const envelope=(receipt:any)=>({request_id:randomUUID(),user_instruction:'隔离测试：调用方自填原话不能获得执行者身份。',change:receipt});
const is403=(e:any)=>e.status===403;
function pass(wb:any,tid:string,rid:string){
  const a=exportReviewOrder(wb,{run_id:rid,reviewer_id:'claude',expected_revision:wb.get('tasks',tid).revision,reason:'隔离测试独立审查'},{role:'planner'});
  startReview(wb,{review_id:a.review_id,identity:'claude'});
  submitReviewResult(wb,{...a.context.final_response,review_id:a.review_id,verdict:'passed',findings:[],limitations:['仅为隔离权限测试'],evidence:['测试专用审查回传'],report_markdown:'隔离权限测试的审查报告，只验证执行者回报通道，不作为生产审查。'},'reviewer:'+a.review_id);
  return a;
}
test('HTTP：manager不能代交全部执行/收尾事件；正确Run凭据和页面导入继续可用',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
  try{
    const s=setup(wb,f.root),other=setup(wb,f.root);
    const token=(rid:string)=>JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',rid+'.json'),'utf8')).token;
    const host='127.0.0.1:'+f.config.port;
    const post=(tool:string,payload:any,auth=wb.keys.manager)=>app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host,authorization:'Bearer '+auth},payload});
    const snapshot=()=>JSON.stringify({task:wb.get('tasks',s.tid),run:wb.get('runs',s.rid),events:wb.all('events'),artifacts:wb.all('artifacts'),reviews:wb.all('reviews')});
    const reject=async(type:string,extra:any={})=>{
      const e=event(f.root,s.tid,s.rid,wb.get('runs',s.rid).seq+1,type,extra),before=snapshot();
      for(const auth of [wb.keys.manager,wb.keys.planner]){
        for(const tool of ['import_execution_receipt','report_run_event','submit_run_result']){
          const response=await post(tool,tool==='import_execution_receipt'?envelope(e):e,auth);assert.equal(response.statusCode,403,type+' '+tool+' '+response.body);
        }
      }
      assert.equal(snapshot(),before,'拒绝不应写事件、占用seq或推进状态');return e;
    };
    const started=await reject('started');let r=await post('report_run_event',started,token(s.rid));assert.equal(r.json().disposition,'applied');
    for(const type of ['progress','waiting_input','blocked','failed'])await reject(type);
    const submitted=await reject('submitted',{result:'隔离测试的完整交付说明：验证管理接口不能代替当前执行者提交成果。'});
    r=await post('submit_run_result',submitted,token(s.rid));assert.equal(r.json().disposition,'applied');assert.equal(r.json().source,'mcp_runner');
    const a=pass(wb,s.tid,s.rid),co=wb.get('runs',s.rid).closeout;
    const closeStart=await reject('closeout_started',{closeout_id:co.id});
    const reviewToken=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',a.review_id+'.json'),'utf8')).token;
    for(const tool of ['import_execution_receipt','report_run_event'])assert.equal((await post(tool,{...(tool==='import_execution_receipt'?envelope(closeStart):closeStart),review_id:a.review_id},reviewToken)).statusCode,403);
    assert([401,403].includes((await post('report_run_event',closeStart,token(other.rid))).statusCode));
    assert.equal(wb.get('tasks',s.tid).status,'awaiting_closeout');
    r=await post('report_run_event',closeStart,token(s.rid));assert.equal(r.json().disposition,'applied');
    for(const type of ['closeout_progress','closeout_waiting_input','closeout_blocked'])await reject(type,{closeout_id:co.id});
    const completed=await reject('closeout_completed',{closeout_id:co.id,result:'隔离测试收尾已逐项完成，使用本Run独立凭据回传实际测试结果。',closeout_results:co.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试逐项检查已完成'}))});
    assert.equal(wb.get('tasks',s.tid).status,'closing');r=await post('report_run_event',completed,token(s.rid));assert.equal(r.json().disposition,'applied');assert.equal(wb.get('tasks',s.tid).status,'awaiting_confirmation');
    // Remote receipts retain the existing user page import and its explicit provenance.
    const remote=event(f.root,other.tid,other.rid,1),url='/api/receipts';
    assert.equal((await app.inject({method:'POST',url,headers:{host,authorization:'Bearer '+wb.keys.manager},payload:remote})).statusCode,401);
    const boot=await app.inject({url:'/api/bootstrap',headers:{host}}),headers={host,cookie:String(boot.headers['set-cookie']).split(';')[0]};
    assert.equal((await app.inject({method:'POST',url,headers,payload:remote})).statusCode,403);
    const imported=await app.inject({method:'POST',url,headers:{...headers,'x-workbench-csrf':boot.json().csrf},payload:remote});assert.equal(imported.statusCode,200);assert.equal(imported.json().source,'user_imported');assert.equal(imported.json().disposition,'applied');
  }finally{await app.close()}
});

test('管理上下文的核心守卫在解析和幂等前拒绝事件；旧工具缓存不能重放',async()=>{
  const f=fixture(),wb=f.wb;try{
    const s=setup(wb,f.root),receipt=event(f.root,s.tid,s.rid,1),context={request_id:randomUUID(),tool:'future_management_path',user_instruction:'自填用户指令'};
    for(const source of ['user_via_agent','user_imported','mcp_runner','file_receipt']){
      assert.throws(()=>wb.managementContext.run(context,()=>wb.event(receipt,s.rid,source)),is403);
    }
    assert.equal(wb.all('events').length,0);assert.equal(wb.get('runs',s.rid).seq,0);
    const saved=wb.event(receipt,s.rid,'mcp_runner');assert.equal(saved.disposition,'applied');
    assert.throws(()=>wb.managementContext.run(context,()=>wb.event(receipt,s.rid,'mcp_runner')),is403);
    const body=envelope(receipt);wb.put('management_calls',{id:body.request_id,status:'completed',result:{status:'completed',result:saved}});
    await assert.rejects(manage(wb,{} as any,'import_execution_receipt',body),is403);assert.equal(wb.all('events').length,1);
  }finally{wb.close()}
});

test('真实stdio与项目CLI不提供代交回执入口，runner仍可独立接单并查询',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false}),clients:Client[]=[];
  try{
    await app.listen({host:'127.0.0.1',port:0});f.config.port=(app.server.address() as any).port;const s=setup(wb,f.root);
    const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
    for(const k of ['WORKBENCH_ROLE','WORKBENCH_ROOT','WORKBENCH_RUN_ID','WORKBENCH_REVIEW_ID'])delete env[k];Object.assign(env,{WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port)});
    const connect=async(extra:Record<string,string>={})=>{const c=new Client({name:'receipt-permission-test',version:'1'});clients.push(c);await c.connect(new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env:{...env,...extra},stderr:'pipe'}));return c};
    const manager=await connect();assert(!(await manager.listTools()).tools.some(t=>t.name==='import_execution_receipt'));
    for(const type of ['started','submitted','closeout_started','closeout_completed']){
      const r=await manager.callTool({name:'import_execution_receipt',arguments:envelope(event(f.root,s.tid,s.rid,1,type))});assert(r.isError,type);
    }
    const cli=await new Promise<{code:number|null;out:string}>(resolve=>{const p=spawn(process.execPath,['--import',import.meta.resolve('tsx'),path.join(ROOT,'scripts/workbench.ts'),'call','import_execution_receipt','-'],{cwd:f.root,env,windowsHide:true});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.once('close',code=>resolve({code,out}));p.stdin.end(JSON.stringify(envelope(event(f.root,s.tid,s.rid,1))))});
    assert.equal(cli.code,1);assert(!cli.out.includes(wb.keys.manager));assert.equal(wb.all('events').length,0);assert.equal(wb.get('runs',s.rid).seq,0);
    const runner=await connect({WORKBENCH_RUN_ID:s.rid}),started=await runner.callTool({name:'report_run_event',arguments:event(f.root,s.tid,s.rid,1)});
    assert(!started.isError,JSON.stringify(started));assert.equal(JSON.parse((started.content as any)[0].text).disposition,'applied');
    const feedback=await runner.callTool({name:'get_run_feedback',arguments:{run_id:s.rid}});assert(!feedback.isError);assert.equal(JSON.parse((feedback.content as any)[0].text).next_seq,2);
  }finally{await Promise.all(clients.map(c=>c.close()));await app.close()}
});


test('升级后旧manager排队回执拒绝且留因；已应用历史保持，真实执行者可继续',()=>{
  const f=fixture();let wb=f.wb;try{
    const s=setup(wb,f.root),started=wb.event(event(f.root,s.tid,s.rid,1),s.rid,'mcp_runner');
    // An explicit old-version fixture, not a new management write.
    const historical:typeof started={...started,source:'user_via_agent'};wb.put('events',historical,{run_id:s.rid,seq:1,digest:historical.digest});
    assert.equal(wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离升级测试完整交付，验证旧队列不能代执行者收尾。'}),s.rid,'mcp_runner').disposition,'applied');
    pass(wb,s.tid,s.rid);const co=wb.get('runs',s.rid).closeout;
    const completed=(seq:number)=>event(f.root,s.tid,s.rid,seq,'closeout_completed',{closeout_id:co.id,result:'隔离测试真实执行者的收尾报告，逐项核对完成后再由用户验收。',closeout_results:co.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试核对已完成'}))});
    const queued=wb.event(completed(4),undefined,'user_via_agent');assert.equal(queued.disposition,'pending');
    wb.close();wb=new Workbench(f.config);wb.scanReceipts();assert.equal(wb.get('events',queued.id).disposition,'pending');
    assert.equal(wb.event(event(f.root,s.tid,s.rid,3,'closeout_started',{closeout_id:co.id}),s.rid,'mcp_runner').disposition,'applied');
    const rejected=wb.get('events',queued.id);assert.equal(rejected.disposition,'rejected');assert.match(rejected.error,/旧版管理连接回执已停用/);
    assert.equal(wb.get('tasks',s.tid).status,'closing');assert.equal(wb.get('runs',s.rid).seq,4);
    assert.deepEqual(wb.get('events',historical.id),historical);
    assert.equal(wb.event(completed(5),s.rid,'mcp_runner').disposition,'applied');assert.equal(wb.get('tasks',s.tid).status,'awaiting_confirmation');
  }finally{wb.close()}
});

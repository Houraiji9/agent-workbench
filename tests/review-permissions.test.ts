import {decideReviewCollaboration} from '../src/core/review-workflow.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,setup,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {ROOT} from '../src/core/config.ts';
import {getReviewContext,type GrokTrace,type TraceReader} from '../src/core/review-evidence.ts';

async function delivered(grokTraceReader?:TraceReader){
  const f=fixture(),s=setup(f.wb,f.root);
  f.wb.event(event(f.root,s.tid,s.rid,1));
  f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试材料：检查审查结论之后改派权限，所有模型结果为测试夹具。'}));
  f.wb.close();const {app,wb}=await createApp(f.config,{background:false,grokTraceReader});
  await app.listen({host:'127.0.0.1',port:0});f.config.port=(app.server.address() as any).port;
  const base='http://127.0.0.1:'+f.config.port;
  const runner=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',s.rid+'.json'),'utf8')).token;
  const post=async(route:string,body:any,headers:Record<string,string>)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any}};
  const http=(body:any,key=runner,tool='export_review_order')=>post('/api/mcp/'+tool,body,{authorization:'Bearer '+key});
  const input=(extra:any={})=>({run_id:s.rid,reviewer_id:'zcode',expected_revision:wb.get('tasks',s.tid).revision,reason:'隔离测试尝试重新安排审查',...extra});
  const clients:Client[]=[];
  const connect=async(role:'runner'|'planner')=>{
    const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port)};
    delete env.WORKBENCH_ROOT;delete env.WORKBENCH_REVIEW_ID;delete env.WORKBENCH_RUN_ID;delete env.WORKBENCH_ROLE;if(role==='runner')env.WORKBENCH_RUN_ID=s.rid;else env.WORKBENCH_ROLE='planner';
    const client=new Client({name:'review-permission-'+role,version:'1'});clients.push(client);
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env:env as Record<string,string>,stderr:'pipe'}));
    return client;
  };
  const user=async(body:any,route='/api/review-orders')=>{const res=await fetch(base+'/api/bootstrap'),boot=await res.json() as any;return post(route,body,{cookie:res.headers.get('set-cookie')!.split(';')[0],'x-workbench-csrf':boot.csrf})};
  const finishReview=async(verdict:'changes_requested'|'passed')=>{
    const o=await http(input({reviewer_id:'claude'}));assert.equal(o.status,200,JSON.stringify(o.data));
    const key=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',o.data.review_id+'.json'),'utf8')).token;
    const review=(tool:string,body:any)=>post('/api/mcp/'+tool,body,{authorization:'Bearer '+key});
    assert.equal((await review('report_review_started',{review_id:o.data.review_id,identity:'claude'})).status,200);
    const report=await review('submit_review_result',{...o.data.context.final_response,review_id:o.data.review_id,verdict,findings:verdict==='passed'?[]:['隔离测试必须返工的问题'],limitations:['仅验证权限'],evidence:['隔离测试程序回执'],report_markdown:'这是隔离测试的独立审查报告，检查权限边界并保存本次结论。'});
    assert.equal(report.status,200,JSON.stringify(report.data));return report.data.review;
  };
  const snapshot=()=>JSON.stringify({task:wb.get('tasks',s.tid),run:wb.get('runs',s.rid),reviews:wb.all('reviews'),assignments:wb.all('review_assignments')});
  const close=async()=>{await Promise.all(clients.map(c=>c.close()));await app.close()};
  return {...f,...s,wb,app,base,runner,http,input,connect,user,finishReview,snapshot,close};
}

test('需修改后 HTTP 和真实 stdio 拒绝执行者/规划者换人或补审，原结论保持；用户仍可决定改派',async()=>{
  const f=await delivered();try{
    // 尚无结论时，初次安排和换人依旧可用。
    assert.equal((await f.http(f.input({reviewer_id:'claude'}))).status,200);
    assert.equal((await f.http(f.input(),f.wb.keys.planner)).status,200);
    const review=await f.finishReview('changes_requested'),before=f.snapshot();
    const runner=await f.connect('runner'),planner=await f.connect('planner');
    for(const body of [f.input(),f.input({reviewer_id:'claude',new_review:true}),f.input({reviewer_id:'claude',delivery_mode:'agent'})]){
      for(const key of [f.runner,f.wb.keys.planner]){const r=await f.http(body,key);assert.equal(r.status,403,JSON.stringify(r.data));assert.match(r.data.error,/用户/);assert.equal(f.snapshot(),before)}
      for(const c of [runner,planner]){const r=await c.callTool({name:'export_review_order',arguments:body});assert.equal(r.isError,true);assert.match(JSON.parse((r.content as any)[0].text).error,/用户/);assert.equal(f.snapshot(),before)}
    }
    assert.equal((await f.http({...f.input(),role:'user'})).status,400);assert.equal(f.snapshot(),before);
    // 手动重新安排必须经正常页面会话和 CSRF。
    const replacement=await f.user(f.input({new_review:true}));assert.equal(replacement.status,200,JSON.stringify(replacement.data));
    assert.equal(f.wb.get('tasks',f.tid).status,'submitted');
    const old=f.wb.get('reviews',review.id);assert.equal(old.verdict,'changes_requested');assert.equal(old.report_markdown,review.report_markdown);assert.equal(old.revoked_at,undefined);
  }finally{await f.close()}
});

test('审查通过后的全部收尾阶段及待验收，HTTP 和 stdio 均拒绝 Agent 撤销结论',async()=>{
  const f=await delivered();try{
    const review=await f.finishReview('passed'),runner=await f.connect('runner'),planner=await f.connect('planner');
    const send=(type:string,extra:any={})=>{const r=f.wb.get('runs',f.rid);const result=f.wb.event(event(f.root,f.tid,f.rid,r.seq+1,type,{closeout_id:r.closeout.id,...extra}));assert.equal(result.disposition,'applied')};
    const deny=async(status:string)=>{assert.equal(f.wb.get('tasks',f.tid).status,status);const before=f.snapshot();for(const body of [f.input(),f.input({reviewer_id:'claude',new_review:true})]){
      for(const key of [f.runner,f.wb.keys.planner])assert.equal((await f.http(body,key)).status,403);
      for(const c of [runner,planner])assert.equal((await c.callTool({name:'export_review_order',arguments:body})).isError,true);
    }assert.equal(f.snapshot(),before);assert.equal(f.wb.get('reviews',review.id).revoked_at,undefined)};
    await deny('awaiting_closeout');send('closeout_started');await deny('closing');
    send('closeout_waiting_input',{message:'隔离测试等待用户回答'});await deny('closeout_waiting_input');
    send('closeout_started');send('closeout_blocked',{message:'隔离测试收尾暂时受阻'});await deny('closeout_blocked');send('closeout_started');
    const co=f.wb.get('runs',f.rid).closeout;
    send('closeout_completed',{result:'隔离测试逐项核对收尾完成，保存报告后进入用户确认阶段。',closeout_results:co.items.map((i:any)=>({item_id:i.id,outcome:'done',evidence:'隔离测试已经逐项核对'}))});
    await deny('awaiting_confirmation');
    const replacement=await f.user(f.input({reviewer_id:'claude',new_review:true}));assert.equal(replacement.status,200);assert.equal(f.wb.get('tasks',f.tid).status,'submitted');assert.equal(f.wb.get('runs',f.rid).closeout,null);
  }finally{await f.close()}
});

test('旧记录缺少当前审查单或阶段标记时，有效审查结论仍阻止 Agent 改派',async()=>{
  const f=await delivered();try{
    const review=await f.finishReview('changes_requested');
    // 隔离夹具模拟只有有效结论、旧版阶段字段缺失的历史记录。
    const t=f.wb.get('tasks',f.tid);t.status='submitted';delete t.review_stage;t.current_review_assignment_id=null;f.wb.put('tasks',t,{project_id:t.project_id});
    const before=f.snapshot();assert.equal((await f.http(f.input())).status,403);assert.equal(f.snapshot(),before);assert.equal(f.wb.get('reviews',review.id).revoked_at,undefined);
  }finally{await f.close()}
});

for(const verdict of ['changes_requested','passed'] as const)test(`Grok ${verdict} 后原回执可重试，HTTP/stdio Agent 均不可导入新结论；用户仍可明确补审`,async()=>{
  const traces=new Map<string,GrokTrace>();
  const f=await delivered(async sid=>{assert(traces.has(sid));return traces.get(sid)!});
  try{
    const context=getReviewContext(f.wb,f.rid);
    const makeTrace=(v:string,request='fixture-request')=>{
      const sid=crypto.randomUUID();const trace:GrokTrace={
        summary:{info:{id:sid,cwd:context.cwd},current_model_id:'grok-test-fixture',request_id:request},
        history:[{type:'assistant',model_id:'grok-test-fixture',content:JSON.stringify({task_id:f.tid,run_id:f.rid,review_digest:context.review_digest,verdict:v,findings:v==='passed'?[]:['隔离夹具要求修改'],limitations:['仅测试回传权限，不是真实模型审查']})}],
        updates:[{timestamp:Date.now()+1000*traces.size,params:{sessionId:sid,update:{sessionUpdate:'turn_completed',stop_reason:'end_turn',prompt_id:request}}}]
      };traces.set(sid,trace);return {run_id:f.rid,session_id:sid};
    };
    const original=makeTrace(verdict),first=await f.http(original,f.runner,'submit_grok_review');assert.equal(first.status,200,JSON.stringify(first.data));
    const before=f.snapshot(),runner=await f.connect('runner'),planner=await f.connect('planner');
    for(const key of [f.runner,f.wb.keys.planner]){const retry=await f.http(original,key,'submit_grok_review');assert.equal(retry.status,200);assert.equal(retry.data.id,first.data.id)}
    for(const c of [runner,planner])assert.equal((await c.callTool({name:'submit_grok_review',arguments:original})).isError,false);
    assert.equal(f.snapshot(),before);
    const newer=makeTrace('passed','newer-request');
    for(const key of [f.runner,f.wb.keys.planner]){const denied=await f.http(newer,key,'submit_grok_review');assert.equal(denied.status,403,JSON.stringify(denied.data));assert.match(denied.data.error,/用户/)}
    for(const c of [runner,planner]){const denied=await c.callTool({name:'submit_grok_review',arguments:newer});assert.equal(denied.isError,true);assert.match(JSON.parse((denied.content as any)[0].text).error,/用户/)}
    // A different request in the same official session is also a new decision.
    const sameSession=structuredClone(traces.get(newer.session_id)!);sameSession.summary.info.id=original.session_id;sameSession.updates[0].params.sessionId=original.session_id;
    traces.set(original.session_id,sameSession);
    assert.equal((await f.http(original,f.runner,'submit_grok_review')).status,403);
    assert.equal(f.snapshot(),before);assert.equal(f.wb.get('reviews',first.data.id).revoked_at,undefined);
    const userResult=await f.user(newer,'/api/reviews/grok');assert.equal(userResult.status,200,JSON.stringify(userResult.data));decideReviewCollaboration(f.wb,{run_id:f.rid,expected_revision:f.wb.get('tasks',f.tid).revision,decision:'continue',reason:'隔离测试用户核对全部审查记录并明确继续'},{role:'user'});assert.equal(f.wb.get('tasks',f.tid).status,'awaiting_closeout');assert.equal(f.wb.get('reviews',first.data.id).verdict,verdict);
  }finally{await f.close()}
});

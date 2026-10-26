import {exportReviewOrder,startReview,submitReviewResult} from '../src/core/review-workflow.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,setup,event} from './helpers.ts';
import {createApp} from '../src/server/app.ts';
import {ROOT} from '../src/core/config.ts';
import {managementTools,managementReadTools} from '../src/core/management.ts';

test('真实 stdio 主会话发现管理工具并直接保存；独立执行和规划连接继续限定职责',async()=>{
  const f=fixture();f.wb.close();const {app,wb}=await createApp(f.config,{background:false});const clients:Client[]=[];
  try{
    await app.listen({host:'127.0.0.1',port:0});f.config.port=(app.server.address() as any).port;
    const s=setup(wb,f.root);
    const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));
    for(const k of ['WORKBENCH_ROOT','WORKBENCH_ROLE','WORKBENCH_RUN_ID','WORKBENCH_REVIEW_ID'])delete env[k];
    Object.assign(env,{WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(f.config.port)});
    const connect=async(extra:NodeJS.ProcessEnv={})=>{const client=new Client({name:'management-interface',version:'1'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',import.meta.resolve('tsx'),path.join(ROOT,'src/mcp/index.ts')],cwd:ROOT,env:{...env,...extra} as Record<string,string>,stderr:'pipe'}));return client};
    const manager=await connect(),names=(await manager.listTools()).tools.map(t=>t.name);
    for(const name of Object.keys({...managementTools,...managementReadTools}))assert(names.includes(name),name);
    const body={request_id:crypto.randomUUID(),user_instruction:'隔离测试：在会话里帮我记个备忘，不打开网页。',change:{action:'create',data:{project_id:'P-workbench',text:'来自真实 stdio 的隔离备忘',status:'draft'}}};
    const response=await manager.callTool({name:'manage_requests',arguments:body});assert(!response.isError,JSON.stringify(response));const q=JSON.parse((response.content as any)[0].text).result;assert.equal(wb.get('requests',q.id).text,body.change.data.text);
    const repeated=await manager.callTool({name:'manage_requests',arguments:body});assert.deepEqual(repeated.content,response.content);
    const context=await manager.callTool({name:'get_management_context',arguments:{section:'requests'}});assert.match((context.content as any)[0].text,/来自真实 stdio/);
    // Actual stdio transport must enforce the same boundary as HTTP.
    assert(!names.includes('import_grok_review_for_user'));assert(!names.includes('confirm_user_decision'));
    wb.event(event(f.root,s.tid,s.rid,1));wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'stdio 隔离交付，验证报告不能由管理连接代写。'}));
    const order=exportReviewOrder(wb,{run_id:s.rid,reviewer_id:'claude',expected_revision:wb.get('tasks',s.tid).revision,reason:'stdio 隔离审查'},{role:'planner'});
    startReview(wb,{review_id:order.review_id,identity:'claude'});
    const report={...order.context.final_response,review_id:order.review_id,verdict:'changes_requested',findings:['测试需修改'],limitations:['测试夹具'],evidence:['真实 stdio 回归'],report_markdown:'隔离 stdio 审查报告，验证管理连接权限不影响独立报告。'};
    const review=submitReviewResult(wb,report,'reviewer:'+order.review_id).review,original=JSON.stringify(review),before=wb.get('tasks',s.tid);
    const changeCall=(tool:string,change:any)=>manager.callTool({name:tool,arguments:{request_id:crypto.randomUUID(),user_instruction:'Agent 自填，不能作为用户确认',change}});
    for(const action of ['record','import_result'])assert((await changeCall('manage_reviews',{action,data:{...report,verdict:'passed'}})).isError);
    assert((await changeCall('import_grok_review_for_user',{run_id:s.rid,session_id:'fake'})).isError);
    assert((await changeCall('manage_tasks',{action:'accept',task_id:s.tid,run_id:s.rid,revision:before.revision})).isError);
    const proposal=await changeCall('manage_reviews',{action:'assign',data:{run_id:s.rid,reviewer_id:'zcode',expected_revision:before.revision,reason:'在当前会话安排独立复审'}});
    assert(!proposal.isError,JSON.stringify(proposal));assert.equal(JSON.parse((proposal.content as any)[0].text).status,'completed');
    assert.equal(JSON.stringify(wb.get('reviews',review.id)),original);assert(wb.get('tasks',s.tid).revision>before.revision);
    assert(wb.all('review_assignments').some(a=>a.run_id===s.rid&&a.reviewer_id==='zcode'));
    for(const extra of [{WORKBENCH_RUN_ID:s.rid},{WORKBENCH_ROLE:'planner'}]){
      const client=await connect(extra),tools=(await client.listTools()).tools;
      const scoped=Boolean(extra.WORKBENCH_RUN_ID);assert.equal(tools.some(t=>t.name==='manage_requests'),scoped);
      const response=await client.callTool({name:'manage_requests',arguments:{...body,request_id:crypto.randomUUID()}});assert.equal(Boolean(response.isError),!scoped);
      if(scoped){const saved=JSON.parse((response.content as any)[0].text).result;assert.equal(wb.get('requests',saved.id).project_id,'P-workbench');}
    }
    for(const extra of [{WORKBENCH_ROLE:'admin'},{WORKBENCH_ROLE:'manager',WORKBENCH_RUN_ID:s.rid},{WORKBENCH_RUN_ID:s.rid,WORKBENCH_REVIEW_ID:'RA-'+crypto.randomUUID()}])await assert.rejects(connect(extra));
    // Execute the documented CLI from an unrelated working directory; no npm/PATH dependency.
    const cli=await new Promise<{code:number|null;out:string;err:string}>(resolve=>{const c=spawn(process.execPath,['--import',import.meta.resolve('tsx'),path.join(ROOT,'scripts/workbench.ts'),'call','manage_requests','-'],{cwd:f.root,env,windowsHide:true});let out='',err='';c.stdout.on('data',d=>out+=d);c.stderr.on('data',d=>err+=d);c.once('close',code=>resolve({code,out,err}));c.stdin.end(JSON.stringify({...body,request_id:crypto.randomUUID(),change:{...body.change,data:{...body.change.data,text:'隔离 CLI 入口保存成功'}}}))});
    assert.equal(cli.code,0,cli.err);assert.equal(JSON.parse(cli.out).result.text,'隔离 CLI 入口保存成功');assert(!cli.out.includes(wb.keys.manager));assert(!cli.err.includes(wb.keys.manager));
  }finally{await Promise.all(clients.map(c=>c.close()));await app.close()}
});

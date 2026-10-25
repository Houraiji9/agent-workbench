import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,setup,event,taskInput} from './helpers.ts';
import {ROOT} from '../src/core/config.ts';
import {createApp} from '../src/server/app.ts';
import {reviewerResources,reviewCandidates} from '../src/core/reviewer-resources.ts';
import {exportReviewOrder,reviewAssignmentContext,startReview,submitReviewResult,reviewFeedbackOrder} from '../src/core/review-workflow.ts';
import {revokeReview} from '../src/core/review-evidence.ts';

function delivered(){const f=fixture(),s=setup(f.wb,f.root);f.wb.event(event(f.root,s.tid,s.rid,1));f.wb.event(event(f.root,s.tid,s.rid,2,'submitted',{result:'隔离测试交付材料。仅用于验证审查流程，不是真实模型审查。'}));return {...f,...s}}
function order(f:ReturnType<typeof delivered>,reviewer='zcode',extra={}){return exportReviewOrder(f.wb,{run_id:f.rid,reviewer_id:reviewer,expected_revision:f.wb.get('tasks',f.tid).revision,reason:'测试更换审查者',...extra},{role:'user'})}
function result(o:ReturnType<typeof exportReviewOrder>,extra={}){return {review_id:o.review_id,task_id:o.context.task_id,run_id:o.run_id,review_digest:o.context.review_digest,verdict:'changes_requested',findings:['修复隔离测试问题'],limitations:['模拟回执，仅验证系统协议'],evidence:['已读取隔离测试报告'],report_markdown:'# 隔离测试报告\n\n检查了测试交付，发现需要修改的问题；这不是实际模型审查。',...extra}}
function pool(f:ReturnType<typeof fixture>,percent:number,extra:any={}){
  const at=new Date().toISOString();f.wb.put('quota_pools',{id:'test-grok',provider:'grok',source:'token_monitor',members:[],status:'ok',freshness:'fresh',source_updated_at:at,...extra});
  f.wb.put('quota_windows',{id:'test-grok-week',pool_id:extra.id||'test-grok',label:'Weekly',remaining_percent:percent,resets_at:new Date(Date.now()+86400000).toISOString(),source_updated_at:at},{pool_id:extra.id||'test-grok'});
}
test('Grok 2% 会拦截规划和派审；空成员关联能正确关联 Grok，未知额度保持未知',()=>{
  const f=fixture();try{pool(f,2);assert.equal(reviewerResources(f.wb,'grok-build').status,'low');assert.equal(reviewerResources(f.wb,'zcode').status,'unknown');
    const q=f.wb.request({project_id:'P-workbench',text:'测试低额度审查规划'});
    assert.throws(()=>f.wb.submitPlan({schema_version:1,plan_id:'low',request_id:q.id,expected_version:1,tasks:[taskInput(f.root)]}),/剩余额度 2%/);
    assert.equal(f.wb.all('tasks').length,0);
  }finally{f.wb.close()}
});
test('规划后耗尽额度需要换人；同类工程成员可审查，作者不能自审',()=>{
  const f=delivered();try{pool(f,2);assert.throws(()=>order(f,'grok-build'),/剩余额度/);
    const claude=f.wb.get('agents','claude');claude.allowed_kinds=claude.allowed_kinds.filter((kind:string)=>kind!=='review');f.wb.put('agents',claude);assert(!claude.allowed_kinds.includes('review'));
    const candidates=reviewCandidates(f.wb,f.tid);assert(candidates.candidates.some(a=>a.agent_id==='claude'));assert(!candidates.candidates.some(a=>a.agent_id==='codex'));
    assert.throws(()=>order(f,'codex'),/独立审查/);const o=order(f,'claude');assert.equal(o.reviewer_id,'claude');
  }finally{f.wb.close()}
});
test('当前新快照覆盖旧低额度；已过重置时间的旧值不会自动变成满额',()=>{
  const f=fixture();try{pool(f,2,{freshness:'stale'});assert.equal(reviewerResources(f.wb,'grok-build').status,'low_cached');
    f.wb.put('quota_pools',{id:'current',provider:'grok',source:'token_monitor',members:[],status:'ok',freshness:'fresh',source_updated_at:new Date().toISOString()});
    f.wb.put('quota_windows',{id:'current-week',pool_id:'current',remaining_percent:80,source_updated_at:new Date().toISOString()},{pool_id:'current'});
    assert.equal(reviewerResources(f.wb,'grok-build').status,'available');
    const current=f.wb.get('quota_windows','current-week');current.resets_at=new Date(Date.now()-1000).toISOString();f.wb.put('quota_windows',current,{pool_id:'current'});assert.equal(reviewerResources(f.wb,'grok-build').status,'unknown');
  }finally{f.wb.close()}
});
test('审查单真实落盘，复制仍待接单，重复生成复用同单且不含凭据',()=>{
  const f=delivered();try{const o=order(f),text=fs.readFileSync(o.order_path,'utf8'),key=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',o.review_id+'.json'),'utf8'));
    assert(text.includes('## 需求与检查清单'));assert(text.includes('scripts'+path.sep+'review.ts'));assert(text.includes('submit'));assert(!text.includes(key.token));assert(!JSON.stringify(o).includes(key.token));
    assert.equal(o.status,'awaiting_dispatch');assert.equal(f.wb.get('tasks',f.tid).status,'submitted');assert.equal(order(f).review_id,o.review_id);
    assert.throws(()=>submitReviewResult(f.wb,result(o),'reviewer:'+o.review_id),/started/);
    startReview(f.wb,{review_id:o.review_id,identity:'zcode'});assert.equal(f.wb.get('tasks',f.tid).review_stage,'running');
  }finally{f.wb.close()}
});
test('报告回传完整保存，结果幂等；一键返回原作者生成带审查意见的新 Run',()=>{
  const f=delivered();try{const o=order(f);startReview(f.wb,{review_id:o.review_id,identity:'zcode'});
    const r=submitReviewResult(f.wb,result(o),'reviewer:'+o.review_id);assert.equal(r.review.independently_verified,false);assert.equal(f.wb.get('tasks',f.tid).status,'changes_requested');assert(r.return_to_executor.includes('修复隔离测试问题'));
    assert.equal(submitReviewResult(f.wb,result(o),'reviewer:'+o.review_id).review.id,r.review.id);
    assert.equal(f.wb.runFeedback(f.rid).review_status.reviews[0].report_markdown,result(o).report_markdown);
    const returned=reviewFeedbackOrder(f.wb,f.rid,f.wb.get('tasks',f.tid).revision);assert('run_id' in returned&&returned.run_id!==f.rid);assert(returned.text.includes('修复隔离测试问题'));
    const run=f.wb.get('runs',f.wb.get('tasks',f.tid).current_run_id);assert.equal(run.agent_id,'codex');assert.equal(run.retry_context.reviews[0].report_markdown,result(o).report_markdown);
    assert.throws(()=>submitReviewResult(f.wb,result(o),'reviewer:'+o.review_id),/失效/);
  }finally{f.wb.close()}
});
test('换人后旧权限失效；错误任务、版本、身份、无修改项与篡改归档不能推进状态',()=>{
  const f=delivered();try{const first=order(f),second=order(f,'claude');assert.throws(()=>startReview(f.wb,{review_id:first.review_id,identity:'zcode'}),/失效/);
    assert.throws(()=>startReview(f.wb,{review_id:second.review_id,identity:'codex'}),/身份/);startReview(f.wb,{review_id:second.review_id,identity:'claude'});
    for(const extra of [{task_id:'other'},{run_id:'other'},{review_digest:'0'.repeat(64)},{findings:[]}])assert.throws(()=>submitReviewResult(f.wb,result(second,extra),'reviewer'));
    fs.appendFileSync(f.wb.all('artifacts')[0].archive_path,'tamper');assert.throws(()=>submitReviewResult(f.wb,result(second),'reviewer'),/变化|更改/);assert.equal(f.wb.all('reviews').length,0);
  }finally{f.wb.close()}
});
test('通过仅进入执行收尾；撤回后的旧结果不能重放，重新审查产生新绑定',()=>{
  const f=delivered();try{const o=order(f);startReview(f.wb,{review_id:o.review_id,identity:'zcode'});const body=result(o,{verdict:'passed',findings:[]}),r=submitReviewResult(f.wb,body,'reviewer');
    assert.equal(f.wb.get('tasks',f.tid).status,'awaiting_closeout');assert.equal(f.wb.get('tasks',f.tid).acceptance_record,undefined);
    revokeReview(f.wb,r.review.id,{run_id:f.rid,revision:f.wb.get('tasks',f.tid).revision,reason:'测试撤回审查结果'});assert.throws(()=>submitReviewResult(f.wb,body,'reviewer'),/失效/);
    const next=order(f);assert.notEqual(next.context.review_digest,o.context.review_digest);
  }finally{f.wb.close()}
});
test('HTTP 审查凭据限本单，执行与规划凭据不能代交报告，手工导入附报告',async()=>{
  const f=delivered(),o=order(f);f.wb.close();const {app,wb}=await createApp(f.config,{background:false});
  try{const token=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'review-keys',o.review_id+'.json'),'utf8')).token,runner=JSON.parse(fs.readFileSync(path.join(f.config.dataDir,'run-keys',f.rid+'.json'),'utf8')).token;
    const post=(tool:string,body:any,key=token)=>app.inject({method:'POST',url:'/api/mcp/'+tool,headers:{host:'127.0.0.1:14317',authorization:'Bearer '+key},payload:body});
    for(const key of [wb.keys.planner,runner])assert.equal((await post('submit_review_result',result(o),key)).statusCode,403);
    assert.equal((await post('get_dispatch_context',{review_id:o.review_id})).statusCode,403);
    assert.equal((await post('get_review_assignment',{review_id:'RA-00000000-0000-0000-0000-000000000000'})).statusCode,401);
    assert.equal((await post('report_review_started',{review_id:o.review_id,identity:'zcode'})).statusCode,200);
    assert.equal((await post('submit_review_result',result(o))).statusCode,200);
    assert.equal(wb.get('tasks',f.tid).status,'changes_requested');
    assert.equal((await app.inject({method:'POST',url:'/api/review-receipts',headers:{host:'127.0.0.1:14317'},payload:result(o)})).statusCode,401);
  }finally{await app.close()}
});
test('真实 CLI 和 stdio MCP 能完成非 Grok 审查，不需要全局 Agent 配置',async()=>{
  const f=delivered(),o=order(f);f.wb.close();const {app,wb}=await createApp(f.config,{background:false});await app.listen({host:'127.0.0.1',port:0});
  const port=(app.server.address() as any).port;f.config.port=port;const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(port),WORKBENCH_REVIEW_ID:o.review_id};delete env.WORKBENCH_RUN_ID;
  const client=new Client({name:'review-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp/index.ts'],cwd:ROOT,env:env as Record<string,string>,stderr:'pipe'});
  try{await client.connect(transport);const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),['ack_review_context','get_review_assignment','read_review_context_file','report_review_started','submit_review_result']);
    assert.equal((await client.callTool({name:'get_review_assignment',arguments:{review_id:o.review_id}})).isError,false);
    const cli=await promisify(execFile)(process.execPath,['--import','tsx','scripts/review.ts',o.review_id,'started','zcode'],{cwd:ROOT,env,windowsHide:true});assert.equal(JSON.parse(cli.stdout).status,'running');
    const response=await client.callTool({name:'submit_review_result',arguments:result(o,{verdict:'passed',findings:[]})});assert.equal(response.isError,false);assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');
  }finally{await client.close();await app.close()}
});

test('Windows 审查单原文命令及 MCP 参数在外部目录、无 PATH 时完成接单和回传',{skip:process.platform!=='win32'},async()=>{
  const f=delivered(),o=order(f),text=fs.readFileSync(o.order_path,'utf8');f.wb.close();
  const {app,wb}=await createApp(f.config,{background:false});
  const client=new Client({name:'generated-review-command-test',version:'1'});
  try{
    await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as any).port;f.config.port=port;
    const cwd=path.join(f.root,'其他 Agent 空目录');fs.mkdirSync(cwd);
    const env:NodeJS.ProcessEnv={...process.env,WORKBENCH_DATA_DIR:f.config.dataDir,WORKBENCH_PORT:String(port)};
    for(const key of Object.keys(env))if(['path','node_path','node_options','workbench_run_id','workbench_review_id','workbench_root'].includes(key.toLowerCase()))delete env[key];
    env.PATH='';
    const commands=text.split(/\r?\n/).filter(line=>line.startsWith('& '));assert.equal(commands.length,3);
    const powershell=path.join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const execute=async(command:string)=>{
      // Execute the generated line verbatim; only set output encoding and propagate the exit code.
      const script='[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'+command+'\nexit $LASTEXITCODE';
      const output=await promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd,env,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
      return JSON.parse(output.stdout.trim());
    };
    assert.equal((await execute(commands[0])).status,'running');
    const context=await execute(commands[1]);assert.equal(context.review_id,o.review_id);assert.equal(context.assignment.status,'running');
    const body=result(o,{verdict:'passed',findings:[]});fs.writeFileSync(path.join(path.dirname(o.order_path),'result.json'),JSON.stringify(body));
    const submitted=await execute(commands[2]);assert.equal(submitted.review.verdict,'passed');
    assert.equal(wb.get('tasks',f.tid).status,'awaiting_closeout');assert.equal(wb.get('tasks',f.tid).acceptance_record,undefined);
    assert.equal(fs.readFileSync(path.join(path.dirname(o.order_path),'REPORT.md'),'utf8'),body.report_markdown);
    const mcp=text.match(/独立 stdio MCP：command=(.+?)，args=\[(.+?)\]，cwd=(.+?)，env WORKBENCH_REVIEW_ID=(RA-[a-f0-9-]{36})/);assert(mcp);
    const args=mcp[2].split(',');assert.equal(args[0],'--import');assert(args[1].startsWith('file:///'));assert.equal(mcp[4],o.review_id);
    await client.connect(new StdioClientTransport({command:mcp[1],args,cwd,env:{...env,WORKBENCH_REVIEW_ID:mcp[4]} as Record<string,string>,stderr:'pipe'}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['ack_review_context','get_review_assignment','read_review_context_file','report_review_started','submit_review_result']);
    const reply=await client.callTool({name:'get_review_assignment',arguments:{review_id:o.review_id}});assert.equal(reply.isError,false);
    assert.equal(JSON.parse((reply.content as any)[0].text).assignment.status,'completed');
  }finally{await client.close();await app.close()}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createServer} from 'node:http';
import {fixture} from './helpers.ts';import {Integrations,normalizeTokenStats} from '../src/integrations/adapters.ts';
import {setTimeout as wait} from 'node:timers/promises';

test('0.70 真实 SSE 信封：snapshot/stats 内层数据可持续刷新',async()=>{
 const {wb}=fixture(),i=new Integrations(wb,10000);let connection:any;
 const message=(remaining:number)=>({type:'stats',reason:'ingest',stats:{limits:{updatedAt:new Date().toISOString(),providers:[{provider:'codex',status:'ok',updatedAt:new Date().toISOString(),windows:[{kind:'weekly',remainingPercent:remaining,currency:null}]}]}}});
 const server=createServer((_req,res)=>{connection=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: snapshot\ndata: '+JSON.stringify(message(87))+'\n\n')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));wb.config.integrations.tokenMonitor.baseUrl='http://127.0.0.1:'+(server.address() as any).port;
 const stream=i.stream();try{for(let n=0;n<30&&!connection;n++)await wait(20);await wait(40);assert.equal(wb.get('integrations','tokenMonitor').status,'connected');connection.write('event: stats\ndata: '+JSON.stringify(message(86))+'\n\n');await wait(80);assert.equal(wb.all('quota_windows')[0].remaining_percent,86)}finally{i.stop();await stream;await new Promise<void>(r=>server.close(()=>r()));wb.close()}
});

test('0.70 实际结构回归：nullable currency、来源陈旧、估算成本、用量白名单',()=>{
 const t=new Date().toISOString();const n=normalizeTokenStats({updatedAt:t,limits:{updatedAt:t,providers:[{provider:'codex',accountKey:'private-account',accountEmail:'private@example.test',status:'ok',stale:true,updatedAt:t,windows:[{kind:'weekly',usedPercent:13,currency:null,label:'Weekly'}]}]},periods:{today:{totalTokens:1000,costUsd:2,cacheReadTokens:900,outputTokens:50,clients:{codex:1000},sessions:{secret:'must-not-propagate'},projects:{private:'must-not-propagate'}}}});
 assert.equal(n.windows[0].remaining_percent,87);assert.equal(n.windows[0].label,'Weekly');assert.equal(n.pools[0].freshness,'stale');assert.equal(n.usage?.totalTokens,1000);
 for(const text of ['private-account','private@example.test','must-not-propagate'])assert(!JSON.stringify(n).includes(text));
});
test('同时间戳来源离线仍会变陈旧，不删除最后已知窗口',()=>{
 const {wb}=fixture(),i=new Integrations(wb),t=new Date().toISOString();const p={provider:'codex',status:'ok',updatedAt:t,windows:[{kind:'weekly',remainingPercent:87}]};
 i.saveToken({limits:{updatedAt:t,providers:[p]}});i.saveToken({limits:{updatedAt:t,providers:[{...p,stale:true,windows:[]}]}});
 assert.equal(wb.all('quota_pools').find(p=>p.source==='token_monitor')?.freshness,'stale');assert.equal(wb.all('quota_windows')[0].remaining_percent,87);wb.close();
});
test('连接凭据只从数据目录读入请求头，缺失时拒绝匿名降级',()=>{
 const {wb}=fixture(),i=new Integrations(wb),f=path.join(wb.config.dataDir,'integration.key');fs.writeFileSync(f,'isolated-fixture-token');
 wb.config.integrations.agentsView={baseUrl:'http://127.0.0.1:9',secretFile:f};assert.equal(i.headers('agentsView').Authorization,'Bearer isolated-fixture-token');assert(!JSON.stringify(wb.snapshot()).includes('isolated-fixture-token'));
 wb.config.integrations.agentsView.secretFile=path.join(wb.config.root,'package.json');assert.throws(()=>i.headers('agentsView'));
 wb.config.integrations.agentsView={baseUrl:'http://127.0.0.1:9',secretEnv:'WORKBENCH_MISSING_TEST_TOKEN'};assert.throws(()=>i.headers('agentsView'),/缺少/);wb.close();
});
test('0.45 分页回归：读完多页、空字段兼容、仅准确路径映射项目、不改任务状态',async()=>{
 const {wb}=fixture(),i=new Integrations(wb),p=wb.all('projects')[0];let calls=0;
 const server=createServer((req,res)=>{calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url?.includes('cursor=page2')?{sessions:[{id:'other',agent:'grok',project:p.name,cwd:path.join(p.paths[0],'unregistered'),first_message:null,started_at:null}],total:2,next_cursor:null}:{sessions:[{id:'first',agent:'codex',project:'wrong-label',cwd:p.paths[0],first_message:'执行记录'}],total:2,next_cursor:'page2'}))});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));wb.config.integrations.agentsView.baseUrl='http://127.0.0.1:'+(server.address() as any).port;
 try{const before=JSON.stringify(wb.all('tasks'));await i.refresh('agentsView');assert.equal(calls,2);assert.equal(wb.get('integrations','agentsView').status,'connected');const rows=wb.all('sessions');assert.equal(rows.find(s=>s.native_id==='first')?.project_id,p.id);assert.equal(rows.find(s=>s.native_id==='other')?.project_id,null);assert.equal(rows[0].run_id,null);assert.equal(JSON.stringify(wb.all('tasks')),before);assert.equal(wb.get('integrations','agentsView').snapshot.imported_count,2)}finally{await new Promise<void>(r=>server.close(()=>r()));wb.close()}
});

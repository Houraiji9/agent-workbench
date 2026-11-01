import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer,type ServerResponse} from 'node:http';import {setTimeout as wait} from 'node:timers/promises';
import {fixture} from './helpers.ts';import {Integrations,integrationError} from '../src/integrations/adapters.ts';import {DomainError} from '../src/core/security.ts';
process.env.WORKBENCH_RETAIN_TEST_DATA='1';
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(server.address() as any).port};
const until=async(check:()=>boolean)=>{for(let n=0;n<100&&!check();n++)await wait(10);assert(check(),'synthetic request did not reach expected state')};
const send=(res:ServerResponse,body:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body))};
const close=async(server:ReturnType<typeof createServer>)=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))};

test('startup, manual and poll share one source refresh; next poll is scheduled from completion',async()=>{
 const {wb}=fixture();let response:ServerResponse|undefined,calls=0,active=0,peak=0;
 const server=createServer((_req,res)=>{calls++;active++;peak=Math.max(peak,active);res.on('finish',()=>active--);response=res});
 const i=new Integrations(wb);try{wb.config.integrations.agentsView.baseUrl=await listen(server);i.start();const pending=i.refresh('agentsView');assert.equal(pending,i.refresh('agentsView'));await until(()=>!!response);i.next.set('agentsView',0);i.poll();i.start();await wait(40);assert.equal(calls,1);assert.equal(peak,1);
 const completedAfter=Date.now();send(response!,{sessions:[],total:0});await pending;assert((i.next.get('agentsView')||0)>=completedAfter+60000);i.poll();await wait(30);assert.equal(calls,1);assert.equal(i.inFlight.size,0);assert.equal(wb.get('integrations','agentsView').status,'connected');
 }finally{i.stop();await close(server);wb.close()}
});

test('blocked source does not suppress the other source; multi-page calls remain single-flight',async()=>{
 const {wb}=fixture();let first:ServerResponse|undefined,second:ServerResponse|undefined,tmCalls=0,avCalls=0;
 const server=createServer((req,res)=>{if(req.url==='/api/stats'){tmCalls++;send(res,{limits:{updatedAt:new Date().toISOString(),providers:[]}})}else{avCalls++;if(avCalls===1)first=res;else second=res}}),i=new Integrations(wb);
 try{const base=await listen(server);wb.config.integrations={tokenMonitor:{baseUrl:base},agentsView:{baseUrl:base}};const pending=i.refresh('agentsView');await until(()=>!!first);await i.refresh('tokenMonitor');assert.equal(tmCalls,1);assert.equal(wb.get('integrations','tokenMonitor').status,'connected');send(first!,{sessions:[],total:0,next_cursor:'next'});await until(()=>!!second);assert.equal(i.refresh('agentsView'),pending);i.poll();await wait(30);assert.equal(avCalls,2);send(second!,{sessions:[],total:0});await pending;assert.equal(wb.get('integrations','agentsView').status,'connected');
 }finally{i.stop();await close(server);wb.close()}
});

test('stop aborts ordinary GET, drains refresh without any reads or writes after workbench closes',async()=>{
 const {wb}=fixture();let entered=false,disconnected=false;const server=createServer((req,_res)=>{entered=true;req.on('close',()=>{disconnected=true})}),i=new Integrations(wb);let closed=false;
 try{wb.config.integrations.agentsView.baseUrl=await listen(server);const pending=i.refresh('agentsView');await until(()=>entered);assert.equal(i.controllers.size,1);i.stop();wb.close();closed=true;const result=await pending;assert.equal(result.status,'stopped');await until(()=>disconnected);assert.equal(i.controllers.size,0);assert.equal(i.inFlight.size,0);assert.deepEqual(await i.refresh('agentsView'),{status:'stopped'});i.poll();i.start();assert.equal(i.timer,undefined);assert.deepEqual(i.saveToken({secret:'never normalized or persisted'}),{status:'stopped'});
 }finally{i.stop();await close(server);if(!closed)wb.close()}
});

test('connection refusal keeps safe underlying code and last snapshot, never a URL or credential',async()=>{
 const {wb}=fixture(),i=new Integrations(wb),server=createServer();try{const base=await listen(server);await close(server);wb.config.integrations.tokenMonitor={baseUrl:base};i.saveToken({limits:{updatedAt:new Date().toISOString(),providers:[]}});const snapshot=JSON.stringify(wb.get('integrations','tokenMonitor').snapshot);await i.refresh('tokenMonitor');const state=wb.get('integrations','tokenMonitor');assert.equal(state.status,'stale');assert.equal(state.error_code,'ECONNREFUSED');assert.equal(state.error_kind,'connection_refused');assert.equal(JSON.stringify(state.snapshot),snapshot);assert(!state.error.includes(base));assert((i.next.get('tokenMonitor')||0)>Date.now());
 const unsafe=new Error('http://private.invalid/session?token=secret-value',{cause:Object.assign(new Error('sensitive'),{code:'ECONNRESET'})});const sanitized=JSON.stringify(integrationError(unsafe));assert.match(sanitized,/ECONNRESET/);for(const word of ['private.invalid','secret-value','sensitive'])assert(!sanitized.includes(word));assert.equal(integrationError(Object.assign(new Error('do not save'),{code:'PRIVATE-CODE-WITH-SECRET'})).error_code,null);
 }finally{i.stop();wb.close()}
});

test('ordinary request deadline reports timeout separately and releases controller',async()=>{
 const {wb}=fixture(),i=new Integrations(wb),server=createServer(()=>{});try{wb.config.integrations.agentsView.baseUrl=await listen(server);await i.refresh('agentsView');const state=wb.get('integrations','agentsView');assert.equal(state.status,'offline');assert.equal(state.error_kind,'timeout');assert.equal(state.error,'数据源请求超时');assert.equal(i.controllers.size,0);assert.equal(i.inFlight.size,0);}finally{i.stop();await close(server);wb.close()}
});

test('late token response restores healthy connection while preserving quota watermark and stale data',()=>{
 const {wb}=fixture(),i=new Integrations(wb),newer=new Date(Date.now()-11*60000).toISOString(),older=new Date(Date.now()-12*60000).toISOString();
 const stats=(at:string,remaining:number)=>({limits:{updatedAt:at,providers:[{provider:'codex',status:'ok',updatedAt:at,windows:[{kind:'weekly',remainingPercent:remaining}]}]}});
 try{i.saveToken(stats(newer,70));const previous=wb.get('integrations','tokenMonitor').snapshot;i.failure('tokenMonitor',Object.assign(new Error('unsafe address'),{code:'ECONNREFUSED'}));i.saveToken(stats(older,3));const state=wb.get('integrations','tokenMonitor');assert.equal(state.status,'connected');assert.equal(state.error,null);assert.equal(state.error_code,null);assert.equal(state.snapshot.source_updated_at,newer);assert.equal(state.snapshot.pools[0].source_updated_at,newer);assert.equal(state.snapshot.windows[0].remaining_percent,70);assert.equal(state.snapshot.pools[0].collected_at,previous.pools[0].collected_at);assert.equal(state.snapshot.data_freshness,'stale');assert.equal(i.failures.get('tokenMonitor'),0);
 }finally{i.stop();wb.close()}
});

test('a newer complete provider list marks missing historical pools; equal and older lists do not invent removal',()=>{
 const {wb}=fixture(),i=new Integrations(wb),baseTime=Date.now()-10000,at=(n:number)=>new Date(baseTime+n*1000).toISOString();
 const p=(provider:string,n:number)=>({provider,accountKey:'fixture-'+provider,status:'ok',updatedAt:at(n),windows:[{kind:'weekly',remainingPercent:70}]});
 try{i.saveToken({limits:{updatedAt:at(0),providers:[p('codex',0),p('cursor',0)]}});i.saveToken({limits:{updatedAt:at(0),providers:[p('codex',0)]}});assert.equal(wb.get('integrations','tokenMonitor').snapshot.missing_pool_count,0);i.saveToken({limits:{updatedAt:at(1),providers:[p('codex',1)]}});const state=wb.get('integrations','tokenMonitor'),missing=state.snapshot.pools.find((p:any)=>p.provider==='cursor');assert.equal(state.status,'connected');assert.equal(state.snapshot.data_freshness,'fresh');assert.equal(state.snapshot.pool_count,2);assert.equal(state.snapshot.source_pool_count,1);assert.equal(state.snapshot.missing_pool_count,1);assert.equal(missing.source_presence,'missing');assert.equal(missing.freshness,'stale');assert.equal(missing.source_updated_at,at(0));assert.equal(wb.all('quota_windows').length,2);const missingSince=missing.source_missing_since;i.saveToken({limits:{updatedAt:at(0),providers:[p('cursor',0)]}});assert.equal(wb.get('integrations','tokenMonitor').snapshot.pools.find((p:any)=>p.provider==='cursor').source_missing_since,missingSince);i.saveToken({limits:{updatedAt:at(2),providers:[p('codex',2),p('cursor',2)]}});assert.equal(wb.get('integrations','tokenMonitor').snapshot.missing_pool_count,0);assert.equal(wb.all('quota_pools').find(p=>p.provider==='cursor')?.source_presence,'present');
 }finally{i.stop();wb.close()}
});

test('page imports reuse the session index and preserve newest duplicate and existing associations',async()=>{
 const {wb}=fixture(),i=new Integrations(wb);let scans=0;const all=wb.all.bind(wb),project=wb.all('projects')[0];
 const prior=wb.upsertSession({agent:'codex',native_id:'existing',source:'run_receipt',source_id:'fixture-receipt',project_id:project.id,title:'existing',updated_at:'2026-01-01T00:00:00Z'});
 const items=[...Array.from({length:50},(_,n)=>({id:'synthetic-'+n,agent:'codex',ended_at:'2026-01-02T00:00:00Z',display_name:'row '+n})),{id:'existing',agent:'codex',ended_at:'2026-01-03T00:00:00Z',display_name:'updated'},{id:'synthetic-0',agent:'codex',ended_at:'2026-01-01T00:00:00Z',display_name:'older duplicate'}];
 i.get=async()=>({sessions:items,total:items.length});wb.all=((table:string)=>{if(table==='sessions')scans++;return all(table)}) as typeof wb.all;
 try{await i.refresh('agentsView');assert.equal(scans,2,'one page index and final imported count; no scan per item');const sessions=all('sessions');assert.equal(sessions.length,51);assert.equal(sessions.find(s=>s.native_id==='synthetic-0')?.title,'row 0');const updated=sessions.find(s=>s.native_id==='existing');assert.equal(updated?.id,prior.id);assert.equal(updated?.project_id,project.id);assert.equal(updated?.sources.length,2);assert.equal(updated?.title,'updated');const defaultUpsert=wb.upsertSession({agent:'codex',native_id:'existing',source:'fixture-later',source_id:'additional',updated_at:'2026-01-04T00:00:00Z'});assert.equal(defaultUpsert.id,prior.id);assert.equal(defaultUpsert.sources.length,3);
 }finally{i.stop();wb.close()}
});

test('HTTP status and invalid JSON report safe categories, including errors after headers arrive',async()=>{
 const {wb}=fixture(),i=new Integrations(wb);let mode='http';const server=createServer((_req,res)=>{if(mode==='http'){res.writeHead(401);res.end('credential text must not appear')}else{res.writeHead(200,{'content-type':'application/json'});res.end('private-address is not JSON')}});
 try{wb.config.integrations.agentsView.baseUrl=await listen(server);await i.refresh('agentsView');assert.equal(wb.get('integrations','agentsView').error_code,'HTTP_401');assert.equal(wb.get('integrations','agentsView').error_kind,'http');mode='json';await i.refresh('agentsView');const state=wb.get('integrations','agentsView');assert.equal(state.error_kind,'contract');assert(!state.error.includes('private-address'));assert.equal(integrationError(new DomainError('外部接口返回 HTTP 503')).error_code,'HTTP_503');
 }finally{i.stop();await close(server);wb.close()}
});

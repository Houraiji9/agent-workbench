import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {runApiAgentTurn,redactApiAgentText,type ApiAgentRuntimeInput,type ApiAgentPrivateState} from '../src/core/api-agent-runtime.ts';
import {normalizeApiAgentEndpoint} from '../src/core/api-agent-schema.ts';
const root=path.resolve('.test-tmp/api-agent-runtime');
const tool={name:'dispatch_workgroup_task',description:'Dispatch within the authorized group',inputSchema:{type:'object',properties:{member_id:{type:'string'}},required:['member_id'],additionalProperties:false}};
function fixture(protocol:ApiAgentRuntimeInput['protocol']='chat_completions'){
 fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'中文 case-')),checkpoints:ApiAgentPrivateState[]=[];
 const input:ApiAgentRuntimeInput={protocol,baseUrl:'https://api.example.test/v1',apiKey:'synthetic-api-secret-'+randomUUID(),model:'configured-model',prompt:'完成授权任务',cwd:dir,allowedRoots:[dir],sessionId:'AS-'+randomUUID(),tools:[tool],callTool:async()=>({ok:true}),signal:new AbortController().signal,onCheckpoint:state=>{checkpoints.push(structuredClone(state));}};
 return {dir,input,checkpoints};
}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
function chat(content:string){return {model:'reported-model',choices:[{finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}};}
function chatCall(name:string,args:unknown,id='call-1',extra={}){return {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,...extra,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]};}
function responses(output:unknown[]){return {model:'reported-responses-model',status:'completed',output};}
function finalMessage(text:string,phase='final_answer'){return {type:'message',id:'message-'+randomUUID(),role:'assistant',phase,content:[{type:'output_text',text}]};}
function responseCall(name:string,args:unknown,id='call-1'){return {type:'function_call',id:'fc-'+id,call_id:id,name,arguments:JSON.stringify(args),status:'completed'};}
function sequence(values:unknown[],requests:Array<{url:string;options:RequestInit;body:any}>=[]){let index=0;return (async(url:URL|RequestInfo,options?:RequestInit)=>{requests.push({url:String(url),options:options!,body:JSON.parse(String(options?.body))});assert(index<values.length,'unexpected additional HTTP request');const value=values[index++];return value instanceof Response?value:json(value);}) as typeof fetch;}
function stateFor(input:ApiAgentRuntimeInput,items:Record<string,unknown>[]=[],pending?:ApiAgentPrivateState['pending']):ApiAgentPrivateState{return {schema_version:1,sessionId:input.sessionId,protocol:input.protocol,model:input.model,endpointHash:createHash('sha256').update(normalizeApiAgentEndpoint(input.baseUrl,input.protocol)).digest('hex'),items,pending};}

test('Chat tool loop dispatches with scoped callback, preserves private reasoning, publishes final only',async()=>{
 const {input,checkpoints}=fixture(),requests:Parameters<typeof sequence>[1]=[],calls:unknown[]=[];input.callTool=async(name,args,ctx)=>{calls.push({name,args,callId:ctx.callId});return {job_id:'WJ-synthetic'};};
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'member-2'},'dispatch-1',{reasoning_content:'PRIVATE_REASONING',content:'intermediate commentary'}),chat('完成派活')],requests)});
 assert.equal(result.status,'completed');assert.equal(result.text,'完成派活');assert.equal(result.actualModel,'reported-model');assert.equal(result.processStopped,true);assert(!JSON.stringify(result).includes('PRIVATE_REASONING'));
 assert.deepEqual(calls,[{name:tool.name,args:{member_id:'member-2'},callId:'dispatch-1'}]);assert.equal(requests![0].url,'https://api.example.test/v1/chat/completions');assert.equal(requests![0].options.redirect,'error');assert.equal(new Headers(requests![0].options.headers).get('authorization'),'Bearer '+input.apiKey);
 assert.equal(requests![1].body.messages[2].reasoning_content,'PRIVATE_REASONING');assert.equal(requests![1].body.messages[3].role,'tool');assert.equal(requests![1].body.messages[3].tool_call_id,'dispatch-1');
 assert(checkpoints.some(s=>s.pending?.[0].phase==='started'));assert(checkpoints.some(s=>s.pending?.[0].phase==='completed'));assert.equal(checkpoints.at(-1)?.pending,undefined);assert(!JSON.stringify(checkpoints).includes(input.apiKey));
});
test('Responses replays opaque reasoning and every protocol item, including after a persisted session resumes',async()=>{
 const {input,checkpoints}=fixture('responses'),requests:Parameters<typeof sequence>[1]=[],reason={type:'reasoning',id:'r-1',encrypted_content:'opaque-encrypted-reasoning',summary:[{type:'summary_text',text:'PRIVATE_REASONING'}]};
 const result=await runApiAgentTurn(input,{fetch:sequence([responses([reason,responseCall(tool.name,{member_id:'x'}),finalMessage('do not publish commentary','commentary')]),responses([finalMessage('最终答复')])],requests)});
 assert.equal(result.text,'最终答复');assert(!JSON.stringify(result).includes('PRIVATE_REASONING'));assert.equal(requests![0].body.store,false);assert.deepEqual(requests![0].body.include,['reasoning.encrypted_content']);assert.equal(requests![0].body.tools[0].name,tool.name);
 assert.deepEqual(requests![1].body.input[2],reason);assert.equal(requests![1].body.input[5].type,'function_call_output');assert.equal(requests![1].body.input[5].call_id,'call-1');
 const resumeRequests:Parameters<typeof sequence>[1]=[];input.state=checkpoints.at(-1);input.prompt='继续';const resumed=await runApiAgentTurn(input,{fetch:sequence([responses([finalMessage('续接完成')])],resumeRequests)});assert.equal(resumed.status,'completed');assert.deepEqual(resumeRequests![0].body.input[2],reason);assert.equal(resumeRequests![0].body.input.at(-1).content,'继续');
});
test('API-only agent executes real scoped read and optimistic write file tools',async()=>{
 const {input,dir}=fixture(),file=path.join(dir,'input.txt');fs.writeFileSync(file,'41');let n=0;
 const result=await runApiAgentTurn(input,{fetch:(async(_url,options)=>{const body=JSON.parse(String(options?.body));if(n++===0)return json(chatCall('read_project_file',{path:'input.txt'},'read'));if(n===2){const read=JSON.parse(body.messages.at(-1).content);assert.equal(read.content,'41');return json(chatCall('write_project_file',{path:'input.txt',content:'42',expected_sha256:read.sha256},'write'));}return json(chat('已写入 42'));}) as typeof fetch});
 assert.equal(result.status,'completed');assert.equal(fs.readFileSync(file,'utf8'),'42');assert.equal(n,3);
});
test('credentials are absent from prompt replay, checkpoint, tool result and public final',async()=>{
 const {input,checkpoints}=fixture(),requests:Parameters<typeof sequence>[1]=[];input.prompt+=' '+input.apiKey;input.callTool=async()=>({echo:input.apiKey,api_key:'sk-proj-abcdefghijklmnopqrst'});
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'},'x'),chat('key '+input.apiKey+' sk-ant-abcdefghijklmnopqrst')],requests)});
 assert.equal(result.status,'completed');assert(!result.text.includes(input.apiKey));assert(!result.text.includes('sk-ant-'));assert(!JSON.stringify(checkpoints).includes(input.apiKey));assert(!requests!.some(r=>JSON.stringify(r.body).includes(input.apiKey)));assert(!JSON.stringify(checkpoints).includes('sk-proj-'));
 assert.equal(redactApiAgentText('Authorization: Bearer abcdefghijkl token?key=hello','unused'),'Authorization: Bearer [REDACTED] token?key=[REDACTED]');
});
test('unknown started tool outcome blocks resume without new HTTP or repeating a side effect',async()=>{
 const {input}=fixture();input.state=stateFor(input,[{role:'user',content:'previous'}],[{id:'x',name:tool.name,arguments:{member_id:'x'},phase:'started'}]);let invoked=false;input.callTool=async()=>{invoked=true;return {};};
 const result=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(result.status,'blocked');assert.equal(result.errorCode,'api_tool_outcome_unknown');assert.equal(invoked,false);
});
test('saved completed tools are not repeated; pending tools start only after durable checkpoint',async()=>{
 const {input,checkpoints}=fixture();let count=0;input.callTool=async()=>{count++;assert.equal(checkpoints.at(-1)?.pending?.[1].phase,'started');return {ok:true};};
 input.state=stateFor(input,[{role:'tool',tool_call_id:'done',content:'{}'}],[{id:'done',name:tool.name,arguments:{},phase:'completed',output:'{}'},{id:'pending',name:tool.name,arguments:{},phase:'pending'}]);
 const result=await runApiAgentTurn(input,{fetch:sequence([chat('完成')])});assert.equal(result.status,'completed');assert.equal(count,1);
});
test('checkpoint failure before tool execution causes no side effect',async()=>{
 const {input}=fixture();let count=0;input.callTool=async()=>{count++;return {};};input.onCheckpoint=s=>{if(s.pending?.[0].phase==='started')throw new Error('storage unavailable');};
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'})])});assert.equal(result.errorCode,'api_checkpoint_failed');assert.equal(count,0);
});
test('checkpoint failure after side effect retains unknown-started evidence and forbids replay',async()=>{
 const {input}=fixture();let saved:ApiAgentPrivateState|undefined,count=0;input.callTool=async()=>{count++;return {created:true};};input.onCheckpoint=s=>{if(s.pending?.[0].phase==='completed')throw new Error('disk full');saved=structuredClone(s);};
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'})])});assert.equal(result.errorCode,'api_checkpoint_failed');assert.equal(count,1);assert.equal(saved?.pending?.[0].phase,'started');
 input.state=saved;const retry=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(retry.errorCode,'api_tool_outcome_unknown');assert.equal(count,1);
});
test('unknown tools and denied tools are returned as safe tool errors, never arbitrary execution',async()=>{
 const {input}=fixture(),requests:Parameters<typeof sequence>[1]=[];let count=0;input.callTool=async()=>{count++;throw Object.assign(new Error('denied '+input.apiKey),{status:403});};
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall('shell',{command:'unsafe'},'a'),chatCall(tool.name,{member_id:'x'},'b'),chat('无法执行该项')],requests)});
 assert.equal(result.status,'completed');assert.equal(count,1);assert.equal(JSON.parse(requests![1].body.messages.at(-1).content).error.code,'api_tool_unavailable');const denied=JSON.parse(requests![2].body.messages.at(-1).content);assert.equal(denied.error.code,'api_tool_denied');assert(!denied.error.message.includes(input.apiKey));
});
for(const [status,expected,state] of [[401,'api_authentication_failed','blocked'],[403,'api_authentication_failed','blocked'],[429,'api_rate_limited','failed'],[402,'api_payment_required','blocked'],[503,'api_provider_failed','failed']] as const)test(`HTTP ${status} is reported honestly without automatic retry`,async()=>{
 const {input}=fixture();const result=await runApiAgentTurn(input,{fetch:sequence([json({error:{message:'provider says '+input.apiKey}},status)])});assert.equal(result.errorCode,expected);assert.equal(result.status,state);assert(!result.errorMessage?.includes(input.apiKey));
});
test('non-JSON authentication failure remains HTTP authentication failure',async()=>{const {input}=fixture();const result=await runApiAgentTurn(input,{fetch:sequence([new Response('unauthorized',{status:401})])});assert.equal(result.errorCode,'api_authentication_failed');});
test('unsupported functions and incomplete generations do not appear as completed',async()=>{
 const {input}=fixture();const unsupported=await runApiAgentTurn(input,{fetch:sequence([json({error:{message:'tool calling is not supported'}},400)])});assert.equal(unsupported.errorCode,'api_tools_unsupported');
 const incomplete=await runApiAgentTurn(input,{fetch:sequence([{choices:[{finish_reason:'length',message:{role:'assistant',content:'partial'}}]}])});assert.equal(incomplete.errorCode,'api_incomplete');assert.equal(incomplete.text,'');
 input.protocol='responses';const pending=await runApiAgentTurn(input,{fetch:sequence([{status:'in_progress',output:[]}])});assert.equal(pending.errorCode,'api_incomplete');
});
test('bounded rounds, total tool count and duplicate call IDs stop further work',async()=>{
 const {input}=fixture();input.maxRounds=1;const rounds=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'})])});assert.equal(rounds.errorCode,'api_round_limit');
 input.maxRounds=3;input.maxToolCalls=1;const calls=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'},'a'),chatCall(tool.name,{member_id:'x'},'b')])});assert.equal(calls.errorCode,'api_tool_limit');
 input.maxToolCalls=3;const dup=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'}),chatCall(tool.name,{member_id:'x'})])});assert.equal(dup.errorCode,'api_duplicate_tool_call');
});
test('response and private-state size limits stop without exposing or silently truncating protocol state',async()=>{
 const {input}=fixture();input.maxResponseBytes=100;const response=await runApiAgentTurn(input,{fetch:sequence([chat('x'.repeat(200))])});assert.equal(response.errorCode,'api_response_limit');
 input.maxResponseBytes=1024*1024;const state=await runApiAgentTurn(input,{fetch:sequence([chat('x'.repeat(520*1024))])});assert.equal(state.errorCode,'api_state_limit');assert.equal(state.text,'');
});
test('pre-abort and request hook failure issue no network request',async()=>{
 const {input}=fixture();input.signal=AbortSignal.abort();const cancelled=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(cancelled.status,'cancelled');
 input.signal=new AbortController().signal;input.onBeforeRequest=()=>{throw new Error('persistence failed');};const failed=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(failed.errorCode,'api_request_persistence_failed');
});
test('cancellation during a tool records unknown side effect and does not checkpoint or request afterward',async()=>{
 const {input,checkpoints}=fixture(),controller=new AbortController();input.signal=controller.signal;input.callTool=async()=>{controller.abort();return new Promise(()=>{});};
 const result=await runApiAgentTurn(input,{fetch:sequence([chatCall(tool.name,{member_id:'x'})])});assert.equal(result.status,'cancelled');assert.equal(checkpoints.at(-1)?.pending?.[0].phase,'started');
});
test('real HTTP redirect is rejected without forwarding the Authorization header',async()=>{
 let destinationCalls=0;const destination=http.createServer((_request,response)=>{destinationCalls++;response.end(JSON.stringify(chat('unexpected')));});destination.listen(0,'127.0.0.1');await once(destination,'listening');
 const address=destination.address() as {port:number};const origin=http.createServer((_request,response)=>{response.writeHead(307,{location:`http://127.0.0.1:${address.port}/target`});response.end();});origin.listen(0,'127.0.0.1');await once(origin,'listening');
 try{const {input}=fixture();input.baseUrl=`http://127.0.0.1:${(origin.address() as {port:number}).port}/v1`;const result=await runApiAgentTurn(input);assert.equal(result.errorCode,'api_redirect_rejected');assert.equal(destinationCalls,0);}finally{origin.closeAllConnections();destination.closeAllConnections();await Promise.all([new Promise<void>(resolve=>origin.close(()=>resolve())),new Promise<void>(resolve=>destination.close(()=>resolve()))]);}
});
test('real HTTP timeout aborts pending request and reports no final output',async()=>{
 const server=http.createServer((_request,_response)=>{});server.listen(0,'127.0.0.1');await once(server,'listening');try{const {input}=fixture();input.baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;input.timeoutMs=30;const result=await runApiAgentTurn(input);assert.equal(result.errorCode,'api_timeout');assert.equal(result.text,'');}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('session bindings reject mismatched models/endpoints before HTTP',async()=>{
 const {input}=fixture();input.state=stateFor(input);input.state.model='different';const result=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(result.errorCode,'api_session_mismatch');assert.equal(result.status,'blocked');
});
test('gateway error echoes containing protocol reasoning stay private',async()=>{
 const {input}=fixture();const result=await runApiAgentTurn(input,{fetch:sequence([json({error:{message:'Bad request: {"reasoning_content":"PRIVATE_REASONING","messages":[{"role":"assistant"}]}'}},400)])});assert.equal(result.errorCode,'api_request_rejected');assert(!JSON.stringify(result).includes('PRIVATE_REASONING'));assert(result.errorMessage?.includes('withheld'));
});
test('exact credential also cannot survive as a private object property name',async()=>{
 const {input,checkpoints}=fixture();const response=chat('public final');Object.assign(response.choices[0].message,{[input.apiKey]:'malformed provider extension'});const result=await runApiAgentTurn(input,{fetch:sequence([response])});assert.equal(result.status,'completed');assert(!JSON.stringify(checkpoints).includes(input.apiKey));
});
test('invalid endpoint and oversized restored state stop before network or tool execution',async()=>{
 const {input}=fixture();input.baseUrl='http://remote.example.test';const invalid=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(invalid.errorCode,'api_invalid_configuration');
 input.baseUrl='https://api.example.test/v1';input.state=stateFor(input,[{role:'user',content:'x'.repeat(513*1024)}],[{id:'not-executed',name:tool.name,arguments:{},phase:'pending'}]);input.callTool=async()=>{assert.fail('oversized state executed a tool');};const oversized=await runApiAgentTurn(input,{fetch:sequence([])});assert.equal(oversized.errorCode,'api_state_limit');
});
test('response stream interruption is reported as transport failure without raw exception text',async()=>{
 const {input}=fixture();const stream=new ReadableStream({start(controller){controller.error(new Error('socket reset '+input.apiKey));}});const result=await runApiAgentTurn(input,{fetch:sequence([new Response(stream)])});assert.equal(result.errorCode,'api_transport_failed');assert(!JSON.stringify(result).includes(input.apiKey));
});

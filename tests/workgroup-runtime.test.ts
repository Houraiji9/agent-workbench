import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn,type SpawnOptions} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once,EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {parseDocument} from 'yaml';
import {prepareWorkgroupInvocation,runWorkgroupTurn,workgroupEnvironment,redactWorkgroupText,safeHarnessProviderConfig,WORKGROUP_BRIDGE_SOURCE,HARNESS_WORKGROUP_READY_SOURCE,type WorkgroupRuntimeInput,type WorkgroupRuntimeDependencies} from '../src/core/workgroup-runtime.ts';
import {createAgentOutputParser} from '../src/core/agent-output.ts';
import type {ClientKind,ClientRecord} from '../src/core/agent-clients.ts';
const root=path.resolve('.test-tmp/workgroup-runtime');
const token='synthetic-workgroup-token-'+randomUUID();
const tool={name:'get_workgroup_context',description:'Synthetic scoped context',inputSchema:{type:'object',properties:{room_id:{type:'string'}},required:['room_id']}};
const syntheticHarnessStartup:NonNullable<WorkgroupRuntimeDependencies['harnessStartupInventory']>=async()=>({id:'headless-runner',inject:['headlessStartup','existingDependency']});
const overlayValue=(text:string)=>parseDocument(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({nativeExpression:value})}]}).toJS();
const syntheticHarnessInventory:NonNullable<WorkgroupRuntimeDependencies['harnessMcpInventory']>=async(_record,_cwd,_env,_signal,overlay)=>overlay?[{id:'workbench-workgroup',name:'@deepseek-ai/dsh-mcp-client',disabled:false}]:[];
async function fixture(){await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'中文 case-'));return {dir,input:{jobId:'WJ-'+randomUUID(),roomId:'WR-'+randomUUID(),memberId:'WM-'+randomUUID(),agentId:'agent-test',dataDir:path.join(dir,'data'),clientId:'codex',cwd:dir,allowedRoots:[dir],artifactDir:path.join(dir,'artifacts'),prompt:'只处理本项目；不要读取凭据。',signal:new AbortController().signal,mcp:{baseUrl:'http://127.0.0.1:45456/',token,tools:[tool]}} as WorkgroupRuntimeInput};}
function record(kind:ClientKind):ClientRecord{return {kind,label:'synthetic',status:'verified',reason:'isolated test',checkedAt:new Date().toISOString(),authentication:'unknown',quota:'unknown',invocation:'unknown',executable:process.execPath,prefixArgs:[],help:'Codex CLI Usage: codex exec resume [SESSION_ID] --permission-mode (choices: "manual", "acceptEdits")',supportedFlags:['--json','--config','--sandbox','--model','--print','--output-format','--verbose','--permission-mode','--resume','--mcp-config','--allowedTools','--strict-mcp-config','--permission-prompts','--profile','--patch','--session-id']};}
async function simulated(input:WorkgroupRuntimeInput,code:string){const script=path.join(input.cwd,randomUUID()+'.mjs');await fs.writeFile(script,code);return runWorkgroupTurn(input,{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,codexMcpInventory:async()=>[],resolveClient:async(_data,kind)=>record(kind),spawn:((_cmd:string,_args:string[],options:SpawnOptions)=>spawn(process.execPath,[script],options)) as unknown as typeof spawn});}
const line=(event:unknown)=>JSON.stringify(event)+'\n';
const codex=(id:string,text:string)=>line({type:'thread.started',thread_id:id})+line({type:'item.completed',item:{type:'agent_message',text}})+line({type:'turn.completed'});

test('Codex startup/resume binds cwd and explicit ID; MCP token is env only',async()=>{
 const {input}=await fixture();input.nativeSessionId=randomUUID();const call=await prepareWorkgroupInvocation(input,record('codex'),{codexMcpInventory:async()=>['agent_workbench','node_repl']});
 assert(call.args.includes('approval_policy="never"'));assert(call.args.includes('sandbox_mode="workspace-write"'));
 assert(call.args.includes('mcp_servers.agent_workbench.enabled=false'));assert(call.args.includes('mcp_servers.node_repl.enabled=false'));assert(call.args.includes('mcp_servers.workbench_workgroup.tools.get_workgroup_context.approval_mode="approve"'));assert(!call.args.some(a=>a.includes('default_tools_approval_mode')));
 assert.deepEqual(call.args.slice(-3),['resume',input.nativeSessionId,'-']);assert(!call.args.some(s=>/bypass|danger-full-access|ignore-rules|--last/.test(s)));
 assert.equal(call.env?.WORKBENCH_WORKGROUP_TOKEN,token);assert(!JSON.stringify(call.args).includes(token));
 for(const file of await fs.readdir(input.artifactDir))assert(!(await fs.readFile(path.join(input.artifactDir,file),'utf8')).includes(token));
});
test('Claude can lead with acceptEdits, exact tools, no blanket permission bypass',async()=>{
 const {input}=await fixture();input.clientId='claude';input.nativeSessionId=randomUUID();const call=await prepareWorkgroupInvocation(input,record('claude'));
 assert.equal(call.args[call.args.indexOf('--permission-mode')+1],'acceptEdits');assert.equal(call.args[call.args.indexOf('--resume')+1],input.nativeSessionId);
 assert.equal(call.args[call.args.indexOf('--allowedTools')+1],'mcp__workbench_workgroup__get_workgroup_context');assert(call.args.includes('--permission-prompts'));
 assert(call.args.includes('--strict-mcp-config'));
 assert(!call.args.some(s=>/bypass|dangerously|skip-permissions/.test(s)));const config=JSON.parse(await fs.readFile(call.args[call.args.indexOf('--mcp-config')+1],'utf8'));assert.equal(config.mcpServers.workbench_workgroup.env.WORKBENCH_WORKGROUP_TOKEN,'${WORKBENCH_WORKGROUP_TOKEN}');
});
test('Codex and Claude pass every authorized additional root; unsupported native scopes block before spawn',async()=>{
 for(const kind of ['codex','claude'] as const){const {input}=await fixture(),other=await fixture();input.clientId=kind;input.allowedRoots.push(other.dir);const client=record(kind);client.supportedFlags!.push('--add-dir');const call=await prepareWorkgroupInvocation(input,client,{codexMcpInventory:async()=>[]});assert.equal(call.args[call.args.indexOf('--add-dir')+1],other.dir);}
 const {input}=await fixture(),other=await fixture();input.clientId='dsh';input.allowedRoots.push(other.dir);const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('dsh')});assert.equal(result.status,'blocked');assert.equal(result.errorCode,'additional_roots_unsupported');assert.equal(result.processStopped,true);
});
test('Harness uses normal headless profile and temporary MCP overlay without credential writes',async()=>{
 const {input}=await fixture();input.clientId='deepseek-harness';input.nativeSessionId=randomUUID();const call=await prepareWorkgroupInvocation(input,record('dsh'),{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:async(_r,_c,_e,_s,overlay)=>overlay?[{id:'workbench-workgroup',name:'@deepseek-ai/dsh-mcp-client',disabled:false}]:[{id:'existing-images',name:'@deepseek-ai/dsh-mcp-client',disabled:false}]});
 const patch=overlayValue(await fs.readFile(call.args[call.args.indexOf('--patch')+1],'utf8'));assert(patch.some((x:any)=>x.id==='authorization'&&x.disabled===false));assert(patch.some((x:any)=>x.insert?.[0]?.config.serverName==='workbench_workgroup'));assert(!JSON.stringify(patch).includes(token));assert.equal(call.args[call.args.indexOf('--session-id')+1],input.nativeSessionId);
 assert(patch.some((x:any)=>x.id==='existing-images'&&x.name==='@deepseek-ai/dsh-mcp-client'&&x.disabled===true));
 assert(patch.some((x:any)=>x.id==='credentials'&&x.disabled===false));
 assert.deepEqual(patch.find((p:any)=>p.name==='@deepseek-ai/dsh-headless').inject,['headlessStartup','existingDependency','workbenchWorkgroupReady']);
 const bridge=patch.flatMap((p:any)=>p.insert||[]).find((p:any)=>p.id==='workbench-workgroup');
 assert.deepEqual(bridge.config.env,{WORKBENCH_WORKGROUP_TOKEN:{nativeExpression:'process.env.WORKBENCH_WORKGROUP_TOKEN'},WORKBENCH_WORKGROUP_BASE_URL:{nativeExpression:'process.env.WORKBENCH_WORKGROUP_BASE_URL'}});
 assert(patch.flatMap((p:any)=>p.insert||[]).some((p:any)=>p.id==='workbench-workgroup-ready'&&p.config.tools.includes('mcp__workbench_workgroup__get_workgroup_context')));
});

test('Harness readiness service waits for the complete scoped tool set before unblocking its native runner',async()=>{
 const expected=['mcp__workbench_workgroup__get_workgroup_context','mcp__workbench_workgroup__dispatch_workgroup_task'];let clock=0,calls=0,provided=false;const writes:string[]=[],exits:number[]=[];
 const module=new Function('process','setTimeout','Date',HARNESS_WORKGROUP_READY_SOURCE.replaceAll('export ','')+';return {apply};')({stdout:{write:(value:string)=>writes.push(value)}},(callback:()=>void,ms:number)=>{clock+=ms;queueMicrotask(callback);},{now:()=>clock});
 await module.apply({tools:{schemas:()=>{calls++;return expected.slice(0,calls<3?1:2).map(name=>({name,parameters:{type:'object'}}));}},effect:()=>{},provide:(name:string,value:boolean)=>{assert.equal(name,'workbenchWorkgroupReady');assert(value);assert(calls>=3);provided=true;},get:(name:string)=>{assert.equal(name,'appExit');return (code:number)=>exits.push(code);}},{tools:expected});
 assert(provided);assert.equal(calls,3);assert.equal(clock,200);assert.deepEqual(writes,[]);assert.deepEqual(exits,[]);
});

test('Harness readiness missing or duplicate tools terminate with a fixed error and never release the runner',async()=>{
 for(const duplicate of [false,true]){const name='mcp__workbench_workgroup__dispatch_workgroup_task';let clock=0,provided=false;const writes:string[]=[],exits:number[]=[];
  const module=new Function('process','setTimeout','Date',HARNESS_WORKGROUP_READY_SOURCE.replaceAll('export ','')+';return {apply};')({stdout:{write:(value:string)=>writes.push(value)}},(callback:()=>void,ms:number)=>{clock+=ms;queueMicrotask(callback);},{now:()=>clock});
  await module.apply({tools:{schemas:()=>duplicate?[{name,private:'PRIVATE_SCHEMA'},{name}]:[{name:'unrelated_private_tool',private:'PRIVATE_SCHEMA'}]},effect:()=>{},provide:()=>{provided=true;},get:()=>((code:number)=>exits.push(code))},{tools:[name]});
  assert.equal(provided,false);assert.deepEqual(exits,[1]);assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0]).type,'error');assert(writes[0].includes('WORKGROUP_MCP_UNAVAILABLE'));assert(!writes[0].includes('PRIVATE_SCHEMA'));assert.equal(clock,duplicate?0:20000);
 }
});

test('Harness conflicting inherited bridge policy is never overwritten',async()=>{
 const {input}=await fixture();input.clientId='deepseek-harness';
 await assert.rejects(prepareWorkgroupInvocation(input,record('dsh'),{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:async()=>[{id:'workbench-workgroup',name:'@deepseek-ai/dsh-mcp-client',disabled:true}]}),/native_mcp_policy_conflict/);
});

test('Harness refuses an unverifiable or incompletely isolated native composition before task spawn',async()=>{
 for(const mode of ['unavailable','still_enabled']){
  const {input}=await fixture();input.clientId='deepseek-harness';let launches=0;
  const inventory:NonNullable<WorkgroupRuntimeDependencies['harnessMcpInventory']>=async(_r,_c,_e,_s,overlay)=>{
   if(mode==='unavailable')throw Error('native_mcp_isolation_unavailable');
   return [{id:'inherited-manager',name:'@deepseek-ai/dsh-mcp-client',disabled:false},...(overlay?[{id:'workbench-workgroup',name:'@deepseek-ai/dsh-mcp-client',disabled:false}]:[])];
  };
  const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('dsh'),harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:inventory,spawn:(()=>{launches++;throw Error('must not run model')}) as typeof spawn});
  assert.equal(result.status,'blocked');assert.equal(result.errorCode,'native_mcp_isolation_unavailable');assert.equal(result.processStopped,true);assert.equal(launches,0);
 }
});

test('explicit Harness desktop model reuses exact provider semantics in a temporary headless overlay',async()=>{
 const {input}=await fixture();input.clientId='deepseek-harness';input.model='configured-model';
 const providerConfig={api:'openai-responses',baseURL:'https://configured.invalid/v1',apiKeyEnv:'EXISTING_PROVIDER_KEY',models:[{id:'configured-model',contextWindow:200000}],modelOverrides:{'configured-model':{maxTokens:4096,compat:{supportsStore:false}}},headers:{'OpenAI-Project':'existing-project'}};
 const client=record('dsh');assert(!client.supportedFlags!.includes('--dump-config'));
 const call=await prepareWorkgroupInvocation(input,client,{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,harnessRouteResolver:async(_r,_c,_e,_s,model)=>({provider:'existing-openai',model,source:'native_desktop_config',adapterId:'llm-pi-ai',providerConfig})});
 const patch=overlayValue(await fs.readFile(call.args[call.args.indexOf('--patch')+1],'utf8'));
 assert.deepEqual(patch.find((p:any)=>p.id==='llm-pi-ai').config,{providers:{'existing-openai':providerConfig}});
 assert.deepEqual(patch.find((p:any)=>p.id==='agent-default-model').config,{provider:'existing-openai',model:'configured-model'});
 assert.equal(call.resolvedRoute?.source,'native_desktop_config');assert.equal(call.args[call.args.indexOf('--profile')+1],'headless');assert(!call.args.includes('--dump-config'));
 assert.equal(patch.filter((p:any)=>p.name==='@deepseek-ai/dsh-llm-pi-ai').length,1);assert(!JSON.stringify(patch).includes('desktop'));
});

test('Harness default route is untouched; explicit existing headless route adds no desktop provider',async()=>{
 for(const explicit of [false,true]){const {input}=await fixture();input.clientId='deepseek-harness';if(explicit)input.model='existing-model';let calls=0;
  const call=await prepareWorkgroupInvocation(input,record('dsh'),{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,harnessRouteResolver:async(_r,_c,_e,_s,model)=>{calls++;return {provider:'existing-provider',model,source:'native_headless_config'};}});
  const patch=overlayValue(await fs.readFile(call.args[call.args.indexOf('--patch')+1],'utf8'));assert.equal(calls,explicit?1:0);assert(!patch.some((p:any)=>p.name==='@deepseek-ai/dsh-llm-pi-ai'));assert.equal(patch.some((p:any)=>p.id==='agent-default-model'),explicit);
 }
});

test('Harness provider copy rejects inline secrets, auth headers, URLs with credentials and dynamic expressions',async()=>{
 const secret='sk-test123456789012345678901234';
 for(const config of [{apiKey:secret},{headers:{Authorization:'Bearer '+secret}},{baseURL:'https://user:pass@configured.invalid/v1'},{baseURL:'https://configured.invalid/v1?token=secret'},{apiKeyEnv:secret},{apiKeyEnv:{__js:'process.env.KEY'}},{modelOverrides:{model:{compat:{__js:'readFileSync(secret)'}}}}]){
  assert.throws(()=>safeHarnessProviderConfig(config),/native_route_configuration_unsafe/);
  const {input}=await fixture();input.clientId='deepseek-harness';input.model='configured-model';
  await assert.rejects(prepareWorkgroupInvocation(input,record('dsh'),{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,harnessRouteResolver:async()=>({provider:'openai',model:'configured-model',source:'native_desktop_config',adapterId:'llm-pi-ai',providerConfig:config})}),/native_route_configuration_unsafe/);
  for(const file of await fs.readdir(input.artifactDir))assert(!(await fs.readFile(path.join(input.artifactDir,file),'utf8')).includes(secret));
 }
});

test('ambiguous or conflicting Harness model routes block without a fresh model process',async()=>{
 for(const errorCode of ['native_model_route_ambiguous','native_route_policy_conflict','native_model_route_unavailable']){
  const {input}=await fixture();input.clientId='deepseek-harness';input.model='configured-model';let launches=0;
  const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('dsh'),harnessRouteResolver:async()=>{throw Error(errorCode)},spawn:(()=>{launches++;throw Error('must not run')}) as typeof spawn});
  assert.equal(result.status,'blocked');assert.equal(result.errorCode,errorCode);assert.equal(launches,0);assert.equal(result.processStopped,true);
 }
});

test('actual readonly Harness route projection handles synthetic profiles without mounting plugins or reading credentials',async()=>{
 const {input,dir}=await fixture();input.clientId='deepseek-harness';input.model='chosen-model';input.mcp=undefined;
 const nativeRoot=path.join(dir,'native-fixture'),home=path.join(nativeRoot,'home'),entry=path.join(nativeRoot,'entry.mjs');
 await fs.mkdir(nativeRoot,{recursive:true});await fs.writeFile(entry,'throw Error("Task entry must never execute in a metadata check");');
 async function pkg(name:string,code:string){const target=path.join(nativeRoot,'node_modules','@deepseek-ai',name);await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'package.json'),JSON.stringify({name:'@deepseek-ai/'+name,type:'module',main:'index.js'}));await fs.writeFile(path.join(target,'index.js'),code);return target;}
 await pkg('dsh-home-paths',`export const resolveDshHome=()=>${JSON.stringify(home)};`);
 await pkg('dsh-app-boot',`import fs from 'node:fs';import path from 'node:path';export const resolveProfileDir=(name,home)=>path.join(home,name);export const loadProfileDirectory=(_bin,dir)=>({layers:[{patches:JSON.parse(fs.readFileSync(path.join(dir,'synthetic-rows.json'),'utf8'))}],patches:[],skippedBundles:[]});export const loadOptionalPatches=()=>[];export const composeEntries=layers=>layers.flat();`);
 const dsh=await pkg('dsh','');await fs.mkdir(path.join(dsh,'lib'));await fs.writeFile(path.join(dsh,'lib','bin.js'),'');
 for(const profile of ['headless','desktop']){await fs.mkdir(path.join(home,profile),{recursive:true});await fs.writeFile(path.join(home,profile,'package.json'),'{}');}
 const client={...record('dsh'),prefixArgs:[entry],env:{ELECTRON_RUN_AS_NODE:'1'}};
 const adapter=(provider:string,model:string)=>({id:'llm-pi-ai',name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:provider?{[provider]:{apiKeyEnv:'EXISTING_KEY_REFERENCE',models:[{id:model}]}}:{}}});
 for(const scenario of ['copy','headless','ambiguous','conflict','dynamic','missing','irrelevant_dynamic']){
  const head:any[]=[adapter(scenario==='conflict'?'openai':'',scenario==='conflict'?'other-model':'')];
  if(scenario==='headless')head.push({id:'agent-default-model',name:'@deepseek-ai/dsh-agent-default-model',config:{provider:'head-provider',model:'chosen-model'}});
  const desktop:any[]=[adapter('openai',scenario==='missing'?'other-model':'chosen-model')];
  if(scenario==='ambiguous')desktop.push({...adapter('another-provider','chosen-model'),id:'second-adapter'});
  if(scenario==='dynamic')desktop[0].disabled={__js:'never evaluate this'};
  if(scenario==='irrelevant_dynamic')desktop.push({id:'desktop-only',name:'desktop-gui',disabled:{__js:'never evaluate this'}});
  await fs.writeFile(path.join(home,'headless','synthetic-rows.json'),JSON.stringify(head));await fs.writeFile(path.join(home,'desktop','synthetic-rows.json'),JSON.stringify(desktop));
  const expected=({ambiguous:'native_model_route_ambiguous',conflict:'native_route_policy_conflict',dynamic:'native_route_configuration_unsafe',missing:'native_model_route_unavailable'} as Record<string,string>)[scenario];
  if(expected)await assert.rejects(prepareWorkgroupInvocation(input,client),new RegExp(expected));
  else {const call=await prepareWorkgroupInvocation(input,client);assert.equal(call.resolvedRoute?.provider,scenario==='headless'?'head-provider':'openai');assert.equal(call.resolvedRoute?.source,scenario==='headless'?'native_headless_config':'native_desktop_config');}
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'headless','synthetic-rows.json'),'utf8')),head);assert.deepEqual(JSON.parse(await fs.readFile(path.join(home,'desktop','synthetic-rows.json'),'utf8')),desktop);
 }
});
test('child environment drops every parent Workbench grant and Node preload; known secrets redacted',()=>{
 const env=workgroupEnvironment({PATH:'good',WORKBENCH_MANAGER_TOKEN:'manager',WORKBENCH_EXECUTION_JOB_TOKEN:'executor',WORKBENCH_REVIEWER_TOKEN:'reviewer',NODE_OPTIONS:'--import secret',CODEX_THREAD_ID:'parent',KEEP:'yes'},{ELECTRON_RUN_AS_NODE:'1',WORKBENCH_RUN_ID:'parent'});
 assert.equal(env.PATH,'good');assert.equal(env.KEEP,'yes');assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(env.NODE_OPTIONS,'');assert(!Object.keys(env).some(k=>k.startsWith('WORKBENCH_')));assert(!('CODEX_THREAD_ID'in env));
 assert(!redactWorkgroupText('key='+token+' Authorization: Bearer synthetic-secret-value sk-ant-12345678901234567890',[token]).includes(token));
});
test('native JSONL publishes only terminal assistant final and persists ID before completion',async()=>{
 const {input}=await fixture(),id=randomUUID(),seen:string[]=[];input.onSessionId=x=>seen.push(x);input.onSpawn=pid=>assert(pid>0);
 const output=line({type:'thread.started',thread_id:id})+line({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_REASONING'}})+line({type:'item.completed',item:{type:'command_execution',aggregated_output:'PRIVATE_TOOL'}})+line({type:'item.completed',item:{type:'agent_message',text:'Final '+token}})+line({type:'turn.completed'});
 const result=await simulated(input,`process.stdout.write(${JSON.stringify(output)});`);assert.equal(result.status,'completed');assert.equal(result.text,'Final [REDACTED]');assert.deepEqual(seen,[id]);assert.equal(result.nativeSessionId,id);assert(result.processStopped);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('failure after known session preserves identity; permission errors have fixed safe codes',async()=>{
 const {input}=await fixture(),id=randomUUID();const result=await simulated(input,`process.stdout.write(${JSON.stringify(line({type:'thread.started',thread_id:id}))});process.stderr.write('EPERM secret-token path-private');process.exitCode=1;`);
 assert.equal(result.status,'blocked');assert.equal(result.errorCode,'native_permission_denied');assert.equal(result.nativeSessionId,id);assert.equal(result.text,'');assert(!JSON.stringify(result).includes('secret-token'));
});
test('nonfatal stderr quota metadata cannot override a real successful assistant final',async()=>{
 const {input}=await fixture(),id=randomUUID();const result=await simulated(input,`process.stderr.write('quota monitor startup: quota_available=true; prior rate limit reached warning\\n');process.stdout.write(${JSON.stringify(codex(id,'Public final'))});`);assert.equal(result.status,'completed');assert.equal(result.text,'Public final');assert.equal(result.errorCode,undefined);
});
test('native Claude 429 keeps only its public reset message, never thinking or raw payload',async()=>{
 const {input}=await fixture();input.clientId='claude';const id=randomUUID(),message="You've hit your session limit · resets 9:50am (America/Los_Angeles)";
 const output=line({type:'system',subtype:'init',session_id:id})+line({type:'assistant',isApiErrorMessage:true,message:{role:'assistant',content:[{type:'thinking',thinking:'PRIVATE_REASONING'},{type:'text',text:message}]},private_key:token})+line({type:'result',subtype:'error_during_execution',is_error:true,session_id:id,errors:[message]});
 const result=await simulated(input,`process.stdout.write(${JSON.stringify(output)});process.exitCode=1;`);assert.equal(result.status,'failed');assert.equal(result.errorCode,'native_quota_exhausted');assert.equal(result.errorMessage,message);assert(!JSON.stringify(result).includes('PRIVATE'));assert(!JSON.stringify(result).includes(token));assert.equal(result.nativeSessionId,id);
});

test('Harness projects its exact terminal error code without publishing unrelated stderr',async()=>{
 for(const newline of [true,false]){
  const {input}=await fixture();input.clientId='deepseek-harness';const id='session-'+randomUUID();
  const output=line({type:'session',sessionId:id})+line({type:'final',text:''});
  const diagnostic='dsh: reasoning:\nPRIVATE_REASONING\ndsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; api_key='+token+(newline?'\n':'');
  const result=await simulated(input,`process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(diagnostic)});process.exitCode=1;`);
  assert.equal(result.status,'failed');assert.equal(result.errorCode,'native_authentication_failed');assert.equal(result.nativeSessionId,id);assert(result.errorMessage?.startsWith('dsh: MISSING_CREDENTIAL:'));assert(!JSON.stringify(result).includes('PRIVATE_REASONING'));assert(!JSON.stringify(result).includes(token));assert.equal(result.text,'');
 }
});
test('existing native same-name MCP policy is never overwritten',async()=>{
 const {input}=await fixture();await assert.rejects(prepareWorkgroupInvocation(input,record('codex'),{codexMcpInventory:async()=>['workbench_workgroup']}),/native_mcp_policy_conflict/);
});
test('partial output / contradictory sessions / nonzero exit never become completed',async()=>{
 for(const mode of ['partial','conflict','nonzero']){const {input}=await fixture(),id=randomUUID();if(mode==='conflict')input.nativeSessionId=randomUUID();const output=mode==='partial'?line({type:'thread.started',thread_id:id})+line({type:'item.completed',item:{type:'agent_message',text:'partial'}}):codex(id,'full');
 const result=await simulated(input,`process.stdout.write(${JSON.stringify(output)});process.exitCode=${mode==='nonzero'?1:0};`);assert.notEqual(result.status,'completed');assert.equal(result.text,'');if(mode==='conflict')assert.equal(result.nativeSessionId,input.nativeSessionId);}
});
test('Claude and Harness final wire events are gated by native exit and never nested tool output',async()=>{
 for(const kind of ['claude','dsh'] as const){const {input}=await fixture();input.clientId=kind;const id=randomUUID();const output=kind==='claude'?line({type:'system',subtype:'init',session_id:id,model:'native-reported-model'})+line({type:'assistant',message:{content:[{type:'thinking',thinking:'PRIVATE'}]}})+line({type:'result',subtype:'success',is_error:false,session_id:id,result:'finished'}):line({type:'session',sessionId:id})+line({type:'tool',text:'PRIVATE'})+line({type:'final',text:'finished'});const result=await simulated(input,`process.stdout.write(${JSON.stringify(output)});`);assert.equal(result.status,'completed');assert.equal(result.text,'finished');assert.equal(result.nativeSessionId,id);}
});
test('callback failure stops safely and preserves known ID without claiming report success',async()=>{
 const {input}=await fixture(),id=randomUUID();input.onSessionId=()=>{throw Error('database failure with secret')};const result=await simulated(input,`process.stdout.write(${JSON.stringify(codex(id,'done'))});`);assert.notEqual(result.status,'completed');assert.equal(result.errorCode,'session_persistence_failed');assert.equal(result.nativeSessionId,id);assert.equal(result.text,'');
});
test('scope escape and Windows junction are rejected before launching',async()=>{
 const {input,dir}=await fixture(),other=await fixture();let launches=0;const deps={harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,codexMcpInventory:async()=>[],resolveClient:async()=>record('codex'),spawn:((..._args:unknown[])=>{launches++;throw Error('must not launch');}) as typeof spawn};
 const outside=await runWorkgroupTurn({...input,cwd:other.dir},deps);assert.equal(outside.errorCode,'outside_scope');
 const alias=path.join(dir,'junction');await fs.symlink(other.dir,alias,process.platform==='win32'?'junction':'dir');const linked=await runWorkgroupTurn({...input,cwd:alias},deps);assert.equal(linked.errorCode,'linked_path');assert.equal(launches,0);
});
test('cancellation waits for owned process tree, does not claim success',async()=>{
 const {input}=await fixture(),controller=new AbortController();input.signal=controller.signal;input.onSpawn=()=>setTimeout(()=>controller.abort(),50);const result=await simulated(input,'setInterval(()=>{},1000);');assert.equal(result.status,'cancelled');assert.equal(result.text,'');assert.equal(result.processStopped,true);
});
test('spawn failure keeps resumed session identity and reports fixed failure without retry',async()=>{
 const {input}=await fixture();input.nativeSessionId=randomUUID();let launches=0;
 const result=await runWorkgroupTurn(input,{harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,codexMcpInventory:async()=>[],resolveClient:async()=>record('codex'),spawn:(()=>{launches++;throw Error('private-path credential');}) as typeof spawn});
 assert.equal(launches,1);assert.equal(result.status,'failed');assert.equal(result.errorCode,'native_spawn_failed');assert.equal(result.nativeSessionId,input.nativeSessionId);assert.equal(result.processStopped,true);assert.equal(result.text,'');assert(!JSON.stringify(result).includes('credential'));
});
test('spawn intent is persisted only after preparation and immediately before native spawn',async()=>{
 const {input}=await fixture(),order:string[]=[],id=randomUUID();
 const script=path.join(input.cwd,'spawn-order.mjs');await fs.writeFile(script,`process.stdout.write(${JSON.stringify(codex(id,'done'))});`);
 input.onBeforeSpawn=()=>{order.push('intent');};input.onSpawn=pid=>{assert(pid>0);order.push('pid');};
 const result=await runWorkgroupTurn(input,{resolveClient:async()=>{order.push('discover');return record('codex');},codexMcpInventory:async(_r,_c,_e,_s,args)=>{order.push(args?'prepared':'prepare');assert(!order.includes('intent'));return [];},spawn:((_cmd:string,_args:string[],options:SpawnOptions)=>{assert.deepEqual(order,['discover','prepare','prepared','intent']);order.push('spawn');return spawn(process.execPath,[script],options);}) as unknown as typeof spawn});
 assert.equal(result.status,'completed');assert.deepEqual(order,['discover','prepare','prepared','intent','spawn','pid']);assert.equal(result.processStopped,true);
});
test('cancellation during preparation never records a spawn intent or launches a process',async()=>{
 const {input}=await fixture(),controller=new AbortController();input.signal=controller.signal;let intents=0,launches=0;
 input.onBeforeSpawn=()=>{intents++;};
 const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('codex'),codexMcpInventory:async()=>{controller.abort();return [];},spawn:(()=>{launches++;throw Error('must not spawn');}) as typeof spawn});
 assert.equal(result.status,'cancelled');assert.equal(result.processStopped,true);assert.equal(intents,0);assert.equal(launches,0);
});
test('spawn-intent persistence failure or synchronous cancellation leaves a known stopped process state',async()=>{
 for(const mode of ['throw','cancel']){const {input}=await fixture(),controller=new AbortController();input.signal=controller.signal;input.nativeSessionId=randomUUID();let launches=0,intents=0;
  input.onBeforeSpawn=()=>{intents++;if(mode==='throw')throw Error('PRIVATE_DATABASE_DETAILS');controller.abort();};
  const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('codex'),codexMcpInventory:async()=>[],spawn:(()=>{launches++;throw Error('must not spawn');}) as typeof spawn});
  assert.equal(result.status,mode==='throw'?'failed':'cancelled');assert.equal(result.errorCode,mode==='throw'?'process_persistence_failed':'cancelled');assert.equal(result.processStopped,true);assert.equal(result.nativeSessionId,input.nativeSessionId);assert.equal(launches,0);assert.equal(intents,1);assert(!JSON.stringify(result).includes('PRIVATE_DATABASE_DETAILS'));
 }
});
test('finished native streams ignore late data while finish still parses the final unterminated line',async()=>{
 const {input}=await fixture();input.clientId='deepseek-harness';const sessions:string[]=[],activities:string[]=[];
 input.onSessionId=id=>{sessions.push(id);};input.onActivity=value=>{activities.push(value);};
 const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),pid:undefined,exitCode:null as number|null,signalCode:null,kill:()=>true});
 const result=await runWorkgroupTurn(input,{resolveClient:async()=>record('dsh'),harnessStartupInventory:syntheticHarnessStartup,harnessMcpInventory:syntheticHarnessInventory,spawn:(()=>{setImmediate(()=>{child.stdout.write(JSON.stringify({type:'final',text:'最后一段'}));child.exitCode=0;child.emit('close',0);});return child;}) as unknown as typeof spawn});
 assert.equal(result.status,'completed');assert.equal(result.text,'最后一段');assert.deepEqual(sessions,[]);assert.deepEqual(activities,['native_turn_finished']);
 const frozen=JSON.stringify(result);
 child.stdout.write(line({type:'session',sessionId:randomUUID()})+line({type:'final',text:'late data must stay private'}));child.stderr.write('Error: late PRIVATE_DIAGNOSTIC\n');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(sessions,[]);assert.deepEqual(activities,['native_turn_finished']);assert.equal(JSON.stringify(result),frozen);
});
test('already-cancelled jobs never discover or spawn a client',async()=>{
 const {input}=await fixture(),ctl=new AbortController();ctl.abort();input.signal=ctl.signal;
 const result=await runWorkgroupTurn(input,{resolveClient:async()=>{throw Error('must not discover')}});assert.equal(result.status,'cancelled');assert.equal(result.processStopped,true);
});
test('real local MCP bridge speaks both framings, scopes calls, redacts token and rejects unknown tools',async()=>{
 const {dir}=await fixture();let calls=0;const server=http.createServer((req,res)=>{calls++;assert.equal(req.url,'/api/mcp/get_workgroup_context');assert.equal(req.headers.authorization,'Bearer '+token);res.setHeader('content-type','application/json');res.end(JSON.stringify({room:'synthetic',accidental:token}));});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const script=path.join(dir,'bridge.mjs'),config=path.join(dir,'tools.json');await fs.writeFile(script,WORKGROUP_BRIDGE_SOURCE);await fs.writeFile(config,JSON.stringify({tools:[tool]}));
 try{for(const framed of [false,true]){const child=spawn(process.execPath,[script,config],{cwd:dir,windowsHide:true,env:{...workgroupEnvironment(process.env),WORKBENCH_WORKGROUP_TOKEN:token,WORKBENCH_WORKGROUP_BASE_URL:`http://127.0.0.1:${port}/`},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);const requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:tool.name,arguments:{room_id:'synthetic'}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'delete_everything',arguments:{}}}];const closed=once(child,'close');for(const q of requests){const s=JSON.stringify(q);child.stdin.write(framed?`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`:s+'\n');}child.stdin.end();const [code]=await closed;assert.equal(code,0,err);assert.equal(err,'');assert(out.includes('tool_not_available'));assert(out.includes('[REDACTED]'));assert(!out.includes(token));assert(out.includes(tool.name));}assert.equal(calls,2);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('Codex parser never treats reasoning or uncompleted assistant output as final',()=>{
 const parser=createAgentOutputParser('codex');assert.equal(parser.push(line({type:'item.completed',item:{type:'reasoning',text:'secret'}})).recognized,false);parser.push(line({type:'thread.started',thread_id:randomUUID()}));assert.equal(parser.push(line({type:'item.completed',item:{type:'agent_message',text:'draft'}})).finalText,undefined);assert.equal(parser.push(line({type:'turn.completed'})).finalText,'draft');
});
test('bridge failure preserves bounded useful backend reason with credential redaction',async()=>{
 const {dir}=await fixture(),server=http.createServer((_req,res)=>{res.statusCode=409;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{message:'预算不足 '+token+' api_key=synthetic-credential-value sk-ant-12345678901234567890',code:'budget_exceeded'},private:'DO_NOT_RETURN'}));});server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const script=path.join(dir,'failure-bridge.mjs'),config=path.join(dir,'tools.json');await fs.writeFile(script,WORKGROUP_BRIDGE_SOURCE);await fs.writeFile(config,JSON.stringify({tools:[tool]}));const child=spawn(process.execPath,[script,config],{cwd:dir,windowsHide:true,env:{...workgroupEnvironment(process.env),WORKBENCH_WORKGROUP_TOKEN:token,WORKBENCH_WORKGROUP_BASE_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}/`},stdio:['pipe','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);const closed=once(child,'close');child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:{room_id:'test'}}})+'\n');assert.equal((await closed)[0],0);const response=JSON.parse(out);assert.equal(response.result.isError,true);const detail=JSON.parse(response.result.content[0].text);assert.equal(detail.code,'budget_exceeded');assert.equal(detail.status,409);assert(detail.message.includes('预算不足'));assert(!out.includes(token));assert(!out.includes('synthetic-credential-value'));assert(!out.includes('DO_NOT_RETURN'));}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

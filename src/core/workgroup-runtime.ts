import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,execFile, type ChildProcess} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {Document,Scalar} from 'yaml';
import {buildAgentInvocation, resolveAgentClient, createAgentOutputParser, type ClientRecord, type ClientKind, type AgentInvocation} from './agent-clients.ts';

export type WorkgroupClientId='codex'|'claude'|'deepseek-harness'|'dsh'|'grok';
export type WorkgroupTool={name:string;description?:string;inputSchema:Record<string,unknown>};
export type WorkgroupRuntimeInput={
  jobId:string;roomId:string;memberId:string;agentId:string;dataDir:string;clientId:WorkgroupClientId;
  cwd:string;allowedRoots:string[];artifactDir:string;prompt:string;nativeSessionId?:string;model?:string;provider?:string;
  signal:AbortSignal;timeoutMs?:number;mcp?:{baseUrl:string;token:string;tools:WorkgroupTool[]};
  onSessionId?:(id:string)=>void;onBeforeSpawn?:()=>void;onSpawn?:(pid:number)=>void;onActivity?:(activity:string)=>void;
};
export type WorkgroupRuntimeResult={status:'completed'|'failed'|'cancelled'|'blocked';text:string;nativeSessionId?:string;actualModel?:string;errorCode?:string;errorMessage?:string;exitCode:number|null;processStopped:boolean};
type CodexMcpServer=string|{name:string;transport:'stdio'|'http'};
type CodexMcpInventory=(record:ClientRecord,cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,configArgs?:string[])=>Promise<CodexMcpServer[]>;
type HarnessMcpEntry={id:string;name:string;disabled:boolean};
type HarnessMcpInventory=(record:ClientRecord,cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,overlay?:string)=>Promise<HarnessMcpEntry[]>;
type HarnessRoute={provider:string;model:string;source:'native_headless_config'|'native_desktop_config';adapterId?:string;providerConfig?:unknown};
type HarnessRouteResolver=(record:ClientRecord,cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,model:string,provider?:string)=>Promise<HarnessRoute>;
type HarnessStartup={id:string;inject:string[]};
type HarnessStartupInventory=(record:ClientRecord,cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal)=>Promise<HarnessStartup>;
export type WorkgroupRuntimeDependencies={resolveClient?:typeof resolveAgentClient;spawn?:typeof spawn;codexMcpInventory?:CodexMcpInventory;harnessMcpInventory?:HarnessMcpInventory;harnessRouteResolver?:HarnessRouteResolver;harnessStartupInventory?:HarnessStartupInventory};
const TOOL_NAMES=new Set(['list_workgroups','get_workgroup_context','post_workgroup_message','dispatch_workgroup_task','get_workgroup_inbox','ack_workgroup_inbox','get_workgroup_job','list_external_services','get_external_calling','invoke_external_service','get_external_invocation','get_external_artifact']);
const MAX_OUTPUT=20*1024*1024,MAX_LINE=2*1024*1024;
const inside=(root:string,target:string)=>{const r=path.relative(root,target);return !r||(r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r));};
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function absolute(value:string){if(!path.isAbsolute(value)||/^(?:\\\\|\/\/)/.test(value)||/[\x00-\x1f]/.test(value))throw Error('invalid_path');return path.resolve(value);}
async function noLinks(value:string,allowMissing=false){
  const full=absolute(value);let current=path.parse(full).root;
  for(const part of path.relative(current,full).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try{const s=await fs.lstat(current);if(s.isSymbolicLink()||!same(await fs.realpath(current),current))throw Error('linked_path');}
    catch(e){if(allowMissing&&(e as NodeJS.ErrnoException).code==='ENOENT')return full;throw e;}
  }
  return full;
}
function identifier(value:string){if(typeof value!=='string'||!value||value.length>512||! /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))throw Error('invalid_identity');return value;}
/** Do not carry a parent manager, execution or review grant into a group member. */
export function workgroupEnvironment(base:NodeJS.ProcessEnv,extra:Record<string,string>={}):NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={};
  for(const [k,v]of Object.entries(base))if(!/^WORKBENCH_/i.test(k)&&! /^(?:NODE_OPTIONS|NODE_PATH|CODEX_THREAD_ID|CODEX_SESSION_ID|CLAUDECODE|CLAUDE_CODE_SESSION_ID)$/i.test(k))env[k]=v;
  for(const [k,v]of Object.entries(extra))if(!/^WORKBENCH_/i.test(k)&&! /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(k))env[k]=v;
  env.NODE_OPTIONS='';env.NODE_PATH='';
  return env;
}
/** Only public final-answer text enters persistence. Exact known secrets and common credential
 * spellings are redacted; raw stdout, stderr, tool payloads and reasoning are never stored here. */
export function redactWorkgroupText(value:string,secrets:string[]=[]){
  let result=value.slice(0,MAX_LINE).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  for(const secret of secrets.filter(s=>s.length>=8).sort((a,b)=>b.length-a.length))result=result.split(secret).join('[REDACTED]');
  return result.replace(/\b(?:sk-(?:proj-|ant-)?|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]')
    .replace(/(\b(?:authorization\s*[:=]\s*bearer|api[_-]?key\s*[:=]|(?:access|refresh|id)[_-]?token\s*[:=])\s*)["']?[^\s"',;}]+/gi,'$1[REDACTED]')
    .replace(/([?&](?:token|api_key|access_token|key)=)[^&#\s]+/gi,'$1[REDACTED]');
}
function classify(value:string):string|undefined{
  if(/permission denied|not permitted|denied by|approval (?:required|unavailable)|EACCES|EPERM|permission_denied/i.test(value))return 'native_permission_denied';
  if(/not logged in|authentication|unauthorized|invalid.api.key|MISSING_CREDENTIAL|no API key|401\b|login required/i.test(value))return 'native_authentication_failed';
  if(/hit your (?:session|usage) limit|usage_limit_reached|insufficient_quota|(?:quota|credits?|usage limit).{0,60}(?:exceeded|exhausted|insufficient|reached)|(?:exceeded|exhausted|insufficient).{0,60}(?:quota|credits?|usage)|rate.?limit.{0,30}(?:exceeded|reached)|\b429\b/i.test(value))return 'native_quota_exhausted';
  if(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network error|connection (?:failed|reset)/i.test(value))return 'native_connection_failed';
  return undefined;
}
/** Project only a native error payload. Do not search assistant thoughts or tool output. */
function errorText(raw:string):string|undefined{
  let value:any;try{value=JSON.parse(raw)}catch{return;}
  if(!value||typeof value!=='object')return;
  if(value.type==='assistant'&&value.isApiErrorMessage===true)return (Array.isArray(value.message?.content)?value.message.content:[]).filter((b:any)=>b?.type==='text'&&typeof b.text==='string').map((b:any)=>b.text).join('\n');
  if(value.type==='result'&&value.is_error===true)return typeof value.result==='string'?value.result:Array.isArray(value.errors)?value.errors.filter((v:any)=>typeof v==='string').join('\n'):undefined;
  if(value.type==='error'||value.type==='turn.failed')return typeof value.error?.message==='string'?value.error.message:typeof value.message==='string'?value.message:typeof value.error==='string'?value.error:undefined;
}
/** Metadata only: never persist or expose the command's transport/env/auth configuration.
 * Native list does not start MCP servers or invoke a model. Empty-table overrides merge in
 * Codex, so enumerate and disable each inherited server for this one invocation instead. */
const nativeCodexMcpInventory:CodexMcpInventory=(record,cwd,env,signal,configArgs=[])=>new Promise((resolve,reject)=>{
  execFile(record.executable!,[...(record.prefixArgs||[]),...configArgs,'mcp','list','--json'],{cwd,env,signal,windowsHide:true,timeout:8000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout)=>{
    if(error){reject(Error('native_mcp_inventory_failed'));return;}
    try{const entries=JSON.parse(stdout);if(!Array.isArray(entries)||entries.length>128||entries.some(e=>!e||typeof e.name!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(e.name)||!['stdio','streamable_http','http'].includes(e.transport?.type)))throw Error();
      if(configArgs.length){if(entries.some(e=>e.enabled!==false&&e.name!=='workbench_workgroup')||!entries.some(e=>e.name==='workbench_workgroup'&&e.enabled===true))throw Error();}
      resolve(entries.map(e=>({name:e.name,transport:e.transport.type==='stdio'?'stdio':'http'})));}
    catch{reject(Error('native_mcp_inventory_failed'));}
  });
});
/** Read the already-installed profile through native composition, with mutation functions
 * disabled before importing it. Unlike CLI --dump-config this does not prepare/rewrite roots.
 * Expressions remain inert nodes. Only MCP identity/disabled metadata leaves the process. */
const HARNESS_READONLY_PREFIX=String.raw`let phase='fs_guard',moduleName='';(async()=>{
    const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{createRequire,syncBuiltinESMExports}=require('node:module'),{pathToFileURL}=require('node:url');
    const deny=()=>{throw Error('readonly_profile_projection')};
    for(const name of ['writeFile','writeFileSync','appendFile','appendFileSync','rename','renameSync','unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','mkdir','mkdirSync','mkdtemp','mkdtempSync','copyFile','copyFileSync','cp','cpSync','truncate','truncateSync','chmod','chmodSync','chown','chownSync','symlink','symlinkSync','link','linkSync','createWriteStream']){if(typeof fs[name]==='function')fs[name]=deny;if(typeof fsp[name]==='function')fsp[name]=deny;}
    const open=fs.openSync;fs.openSync=(p,flags,...rest)=>{if(typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wa+]/.test(flags||''))deny();return open(p,flags,...rest)};syncBuiltinESMExports();
    phase='native_import';const r=createRequire(ENTRY),boot=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-app-boot')).href),homes=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-home-paths')).href);
    const home=homes.resolveDshHome(),dir=boot.resolveProfileDir('headless',home),anchor=path.resolve(path.dirname(r.resolve('@deepseek-ai/dsh/lib/bin.js')),'..','package.json');
    if(!fs.existsSync(path.join(dir,'package.json')))throw Error();
    phase='profile_read';const loaded=boot.loadProfileDirectory('dsh',dir,anchor);if(loaded.skippedBundles.length)throw Error();
    const layers=[...loaded.layers.map(l=>l.patches),loaded.patches,boot.loadOptionalPatches('dsh',path.join(home,'cordis.patch.yml'))||[]];if(OVERLAY)layers.push(boot.loadOverlayPatches('dsh',OVERLAY));
`;
const nativeHarnessMcpInventory:HarnessMcpInventory=(record,cwd,env,signal,overlay)=>new Promise((resolve,reject)=>{
  const entry=record.prefixArgs?.at(-1);
  if(!entry||record.env?.ELECTRON_RUN_AS_NODE!=='1'||!path.isAbsolute(entry)){reject(Error('native_mcp_isolation_unavailable'));return;}
  const script=HARNESS_READONLY_PREFIX+String.raw`
    phase='compose';const rows=boot.composeEntries(layers,()=>{throw Error('profile_patch_mismatch')});let total=0;const entries=[],ids=new Map();
    // This native service owns no transport: it exposes resources registered by the remaining scoped clients.
    const mcpServices=new Set(['@deepseek-ai/dsh-mcp-resources']);
    function visit(rows){if(!Array.isArray(rows))throw Error('entry_shape');for(const row of rows){if(++total>2000||!row||typeof row.name!=='string'&&!row.group)throw Error('entry_shape');const name=typeof row.name==='string'?row.name:'';if(row.id)ids.set(row.id,(ids.get(row.id)||0)+1);if(/include/i.test(name)&&row.disabled!==true)throw Error('dynamic_include_unverified');if(name==='@deepseek-ai/dsh-mcp-client')entries.push({id:row.id,name,disabled:row.disabled===true});else if(/mcp/i.test(name)&&!mcpServices.has(name)&&row.disabled!==true){moduleName=/^(?:@deepseek-ai\/|cordis:)[a-z0-9-]+$/.test(name)?name:'';throw Error('unknown_mcp_adapter');}if(row.group&&Array.isArray(row.config))visit(row.config);}}
    phase='metadata_projection';visit(rows);if(entries.some(e=>typeof e.id!=='string'||!e.id||e.id.length>200||/[\x00-\x1f]/.test(e.id)||ids.get(e.id)!==1))throw Error();
    process.stdout.write(JSON.stringify({ok:true,entries}));
  })().catch(e=>{const reason=['entry_shape','dynamic_include_unverified','unknown_mcp_adapter','readonly_profile_projection','profile_patch_mismatch'].includes(e?.message)?e.message:'unknown';process.stdout.write(JSON.stringify({ok:false,error:'native_mcp_isolation_unavailable',phase,reason,moduleName}));process.exitCode=1;});`;
  const source=`const ENTRY=${JSON.stringify(entry)},OVERLAY=${JSON.stringify(overlay||'')};`+script;
  execFile(record.executable!,['--expose-internals','-e',source],{cwd,env,signal,windowsHide:true,timeout:15000,maxBuffer:262144,encoding:'utf8'},(error,stdout)=>{
    if(error){let phase='unknown',reason='unknown',moduleName='';try{const value=JSON.parse(stdout);if(['fs_guard','native_import','profile_read','compose','metadata_projection'].includes(value.phase))phase=value.phase;if(['entry_shape','dynamic_include_unverified','unknown_mcp_adapter','readonly_profile_projection','profile_patch_mismatch'].includes(value.reason))reason=value.reason;if(typeof value.moduleName==='string'&&/^(?:@deepseek-ai\/|cordis:)[a-z0-9-]+$/.test(value.moduleName))moduleName=value.moduleName;}catch{}reject(Error('native_mcp_isolation_unavailable',{cause:{phase,reason,moduleName}}));return;}
    try{const value=JSON.parse(stdout);if(value.ok!==true||!Array.isArray(value.entries)||value.entries.length>128)throw Error();resolve(value.entries);}catch{reject(Error('native_mcp_isolation_unavailable'));}
  });
});

const nativeHarnessStartupInventory:HarnessStartupInventory=(record,cwd,env,signal)=>new Promise((resolve,reject)=>{
  const entry=record.prefixArgs?.at(-1);if(!entry||record.env?.ELECTRON_RUN_AS_NODE!=='1'||!path.isAbsolute(entry)){reject(Error('native_mcp_isolation_unavailable'));return;}
  const projection=String.raw`
    const rows=boot.composeEntries(layers,()=>{throw Error()});const runners=[],ids=new Map();let count=0;
    function visit(list,disabled=false){for(const row of list){if(++count>2000)throw Error();if(row.id)ids.set(row.id,(ids.get(row.id)||0)+1);if(row.name==='@deepseek-ai/dsh-headless'){if(disabled||row.disabled!==undefined&&row.disabled!==false)throw Error();runners.push(row);}if(row.group&&Array.isArray(row.config))visit(row.config,disabled||row.disabled===true);}}visit(rows);
    if(runners.length!==1)throw Error();const runner=runners[0];if(typeof runner.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(runner.id)||ids.get(runner.id)!==1||!Array.isArray(runner.inject)||runner.inject.length>64||runner.inject.some(v=>typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(v)))throw Error();
    process.stdout.write(JSON.stringify({id:runner.id,inject:runner.inject}));
  })().catch(()=>{process.stdout.write('{"error":"native_mcp_isolation_unavailable"}');process.exitCode=1;});`;
  execFile(record.executable!,['--expose-internals','-e',`const ENTRY=${JSON.stringify(entry)},OVERLAY='';`+HARNESS_READONLY_PREFIX+projection],{cwd,env,signal,windowsHide:true,timeout:15000,maxBuffer:262144,encoding:'utf8'},(error,stdout)=>{
    if(error){reject(Error('native_mcp_isolation_unavailable'));return;}try{const value=JSON.parse(stdout);if(!value.id||!Array.isArray(value.inject))throw Error();resolve(value);}catch{reject(Error('native_mcp_isolation_unavailable'));}
  });
});

/** Native startup dependency: no task can start until exactly this bridge's advertised tools
 * exist in the same tool scope. No schemas, raw failures or credentials are logged. */
export const HARNESS_WORKGROUP_READY_SOURCE=String.raw`export const name='workbench-workgroup-ready';
export const inject=['tools'];
export async function apply(ctx,config){
 let stopped=false;ctx.effect?.(()=>()=>{stopped=true});
 try{
  const names=config?.tools;if(!Array.isArray(names)||!names.length||names.length>12||new Set(names).size!==names.length||names.some(n=>typeof n!=='string'||!/^mcp__workbench_workgroup__[a-z_]+$/.test(n)))throw Error();
  const deadline=Date.now()+20000;
  while(!stopped&&Date.now()<deadline){
   const schemas=ctx.tools.schemas();if(!Array.isArray(schemas)||schemas.length>4096)throw Error();
   const counts=new Map(names.map(n=>[n,0]));for(const schema of schemas){const n=Object.getOwnPropertyDescriptor(schema||{},'name')?.value;if(counts.has(n))counts.set(n,counts.get(n)+1);}
   if([...counts.values()].some(n=>n>1))throw Error();
   if([...counts.values()].every(n=>n===1)){ctx.provide('workbenchWorkgroupReady',true);return;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(stopped)return;throw Error();
 }catch{
  if(stopped)return;
  process.stdout.write(JSON.stringify({type:'error',message:'WORKGROUP_MCP_UNAVAILABLE: Required workgroup tools did not become ready.'})+'\n');
  ctx.get('appExit')(1);
 }
}
`;

/** Preserve native provider semantics, but never persist inline authentication material or
 * executable YAML expressions in a group artifact. Credential names remain native references. */
export function safeHarnessProviderConfig(value:unknown):Record<string,unknown>{
  const fail=()=>{throw Error('native_route_configuration_unsafe');};
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const allowed=new Set(['apiKeyEnv','displayName','api','baseURL','models','modelOverrides','compat','defaultContextWindow','defaultMaxTokens','defaultInput','headers','reasoning','thinkingBudgets','cacheRetention','transport','timeoutMs','websocketConnectTimeoutMs','streamIdleTimeoutMs','maxRequestImageBytes','requestImagePixelBudget','requestImageMaxBytes','retryPolicy']);
  if(Object.keys(value).some(key=>!allowed.has(key)))return fail();
  let count=0;
  const visit=(item:unknown,key='',depth=0):void=>{
    if(++count>10000||depth>12)return fail();
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='number'){if(!Number.isFinite(item))fail();return;}
    if(typeof item==='string'){
      if(item.length>16384||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item)||/\b(?:sk-(?:proj-|ant-)?|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i.test(item))return fail();
      if(key==='apiKeyEnv'&&!/^[A-Za-z_][A-Za-z0-9_.:-]{0,199}$/.test(item))return fail();
      if(key==='baseURL'){let url:URL;try{url=new URL(item)}catch{return fail();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return fail();}
      return;
    }
    if(Array.isArray(item)){if(item.length>1000)return fail();for(const part of item)visit(part,'',depth+1);return;}
    if(!item||typeof item!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(item)))return fail();
    for(const [name,part]of Object.entries(item)){
      if(name.startsWith('__')||['constructor','prototype'].includes(name)||/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization|cookie)$/i.test(name))return fail();
      if(key==='headers'&&!/^(?:accept|content-type|user-agent|openai-organization|openai-project|anthropic-version)$/i.test(name))return fail();
      visit(part,name,depth+1);
    }
  };
  visit(value);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>131072)return fail();
  return JSON.parse(encoded);
}

/** Explicit model only. Reuse exactly one configured desktop route when headless lacks it.
 * No plugins are mounted and no credential store is queried by this projection. */
const nativeHarnessRouteResolver:HarnessRouteResolver=(record,cwd,env,signal,model,provider)=>new Promise((resolve,reject)=>{
  const entry=record.prefixArgs?.at(-1);
  if(!entry||record.env?.ELECTRON_RUN_AS_NODE!=='1'||!path.isAbsolute(entry)){reject(Error('native_model_route_unavailable'));return;}
  const projection=String.raw`
    const flatten=(rows)=>{const out=[];let count=0;function visit(list,uncertain=false){for(const row of list){if(++count>2000)throw Error('native_model_route_unavailable');if(row.disabled===true)continue;const dynamic=uncertain||(row.disabled!==undefined&&row.disabled!==false);if(row.group&&Array.isArray(row.config))visit(row.config,dynamic);else if(['@deepseek-ai/dsh-agent-default-model','@deepseek-ai/dsh-llm-pi-ai'].includes(row.name)){if(dynamic)throw Error('native_route_configuration_unsafe');out.push(row);}}}visit(rows);return out;};
    const head=flatten(boot.composeEntries(layers,()=>{throw Error('native_model_route_unavailable')}));
    const routeMatches=(rows,defaults)=>{const found=[];for(const row of rows){if(defaults&&row.name==='@deepseek-ai/dsh-agent-default-model'&&row.config?.model===MODEL&&(!PROVIDER||row.config?.provider===PROVIDER))found.push({provider:row.config.provider});
      if(row.name==='@deepseek-ai/dsh-llm-pi-ai')for(const [name,config]of Object.entries(row.config?.providers||{}))if((!PROVIDER||name===PROVIDER)&&(config?.models?.some(m=>m?.id===MODEL)||Object.hasOwn(config?.modelOverrides||{},MODEL)))found.push({provider:name,providerConfig:config});}return found;};
    const existing=routeMatches(head,true),providers=[...new Set(existing.map(r=>r.provider))];
    if(providers.length>1)throw Error('native_model_route_ambiguous');
    if(providers.length===1){process.stdout.write(JSON.stringify({provider:providers[0],model:MODEL,source:'native_headless_config'}));return;}
    const desktop=boot.loadProfileDirectory('dsh',boot.resolveProfileDir('desktop',home),anchor);if(desktop.skippedBundles.length)throw Error('native_model_route_unavailable');
    const desk=flatten(boot.composeEntries([...desktop.layers.map(l=>l.patches),desktop.patches,boot.loadOptionalPatches('dsh',path.join(home,'cordis.patch.yml'))||[]],()=>{throw Error('native_model_route_unavailable')}));
    const matches=routeMatches(desk,false);if(matches.length!==1)throw Error(matches.length?'native_model_route_ambiguous':'native_model_route_unavailable');
    const route=matches[0],adapters=head.filter(r=>r.name==='@deepseek-ai/dsh-llm-pi-ai');
    if(adapters.length!==1||typeof adapters[0].id!=='string'||!adapters[0].id||head.filter(r=>r.id===adapters[0].id).length!==1)throw Error('native_model_route_unavailable');
    if(Object.hasOwn(adapters[0].config?.providers||{},route.provider))throw Error('native_route_policy_conflict');
    process.stdout.write(JSON.stringify({...route,model:MODEL,source:'native_desktop_config',adapterId:adapters[0].id}));
  })().catch(e=>{const code=['native_model_route_unavailable','native_model_route_ambiguous','native_route_configuration_unsafe','native_route_policy_conflict'].includes(e?.message)?e.message:'native_model_route_unavailable';process.stdout.write(JSON.stringify({error:code}));process.exitCode=1;});`;
  const source=`const ENTRY=${JSON.stringify(entry)},OVERLAY='',MODEL=${JSON.stringify(model)},PROVIDER=${JSON.stringify(provider||'')};`+HARNESS_READONLY_PREFIX+projection;
  // stdout is an in-memory private pipe. It is validated before any part can enter an artifact;
  // execFile's raw error/stdout/stderr objects are never retained or returned.
  execFile(record.executable!,['--expose-internals','-e',source],{cwd,env,signal,windowsHide:true,timeout:15000,maxBuffer:262144,encoding:'utf8'},(error,stdout)=>{
    let value:any;try{value=JSON.parse(stdout)}catch{reject(Error('native_model_route_unavailable'));return;}
    if(error){reject(Error(['native_model_route_unavailable','native_model_route_ambiguous','native_route_configuration_unsafe','native_route_policy_conflict'].includes(value.error)?value.error:'native_model_route_unavailable'));return;}
    try{if(typeof value.provider!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.provider)||value.model!==model||provider&&value.provider!==provider||!['native_headless_config','native_desktop_config'].includes(value.source))throw Error('native_model_route_unavailable');
      if(value.source==='native_desktop_config'){if(typeof value.adapterId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.adapterId))throw Error('native_model_route_unavailable');value.providerConfig=safeHarnessProviderConfig(value.providerConfig);}
      resolve(value);
    }catch(e){reject(Error((e as Error).message==='native_route_configuration_unsafe'?'native_route_configuration_unsafe':'native_model_route_unavailable'));}
  });
});

// Standalone Node builtins only. Configuration contains schemas, never a credential.
// Accept both official newline JSON and the older Content-Length framing used by Harness.
export const WORKGROUP_BRIDGE_SOURCE=String.raw`import fs from 'node:fs';
import path from 'node:path';
const fail=()=>{process.stderr.write('workgroup_bridge_configuration_invalid\n');process.exit(1)};
if(process.argv.length!==3)fail();
let config;try{const p=process.argv[2];if(!path.isAbsolute(p)||fs.statSync(p).size>262144)fail();config=JSON.parse(fs.readFileSync(p,'utf8'));}catch{fail()}
const token=process.env.WORKBENCH_WORKGROUP_TOKEN||'',base=process.env.WORKBENCH_WORKGROUP_BASE_URL||'';
let u;try{u=new URL(base)}catch{fail()}
if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/'||u.username||u.password||u.search||u.hash||token.length<24||/\s/.test(token))fail();
const names=new Set(['list_workgroups','get_workgroup_context','post_workgroup_message','dispatch_workgroup_task','get_workgroup_inbox','ack_workgroup_inbox','get_workgroup_job','list_external_services','get_external_calling','invoke_external_service','get_external_invocation','get_external_artifact']);
if(!Array.isArray(config.tools)||config.tools.length>12||config.tools.some(t=>!names.has(t.name)||!t.inputSchema))fail();
const tools=new Map(config.tools.map(t=>[t.name,t]));
const clean=s=>String(s).split(token).join('[REDACTED]').replace(/\b(?:sk-(?:proj-|ant-)?|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g,'[REDACTED]').replace(/(\b(?:authorization\s*[:=]\s*bearer|api[_-]?key\s*[:=]|(?:access|refresh|id)[_-]?token\s*[:=])\s*)["']?[^\s"',;}]+/gi,'$1[REDACTED]').replace(/([?&](?:token|api_key|access_token|key)=)[^&#\s]+/gi,'$1[REDACTED]');
let input=Buffer.alloc(0),queue=Promise.resolve(),ending=false;
function send(v,framed){const body=Buffer.from(JSON.stringify(v));process.stdout.write(framed?Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]):Buffer.concat([body,Buffer.from('\n')]));}
async function handle(raw,framed){
 let q;try{q=JSON.parse(raw)}catch{return}
 if(!q||q.jsonrpc!=='2.0'||!(typeof q.id==='string'||typeof q.id==='number'))return;
 const answer=result=>send({jsonrpc:'2.0',id:q.id,result},framed),error=(code,message)=>send({jsonrpc:'2.0',id:q.id,error:{code,message}},framed);
 if(q.method==='initialize')return answer({protocolVersion:typeof q.params?.protocolVersion==='string'?q.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'workbench_workgroup',version:'1.0.0'}});
 if(q.method==='ping')return answer({});
 if(q.method==='tools/list')return answer({tools:[...tools.values()]});
 if(q.method!=='tools/call'||!tools.has(q.params?.name))return error(-32601,'tool_not_available');
 const args=q.params.arguments||{};if(!args||typeof args!=='object'||Array.isArray(args))return error(-32602,'invalid_arguments');
 try{
  const response=await fetch(new URL('/api/mcp/'+q.params.name,u),{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(args),signal:AbortSignal.timeout(120000)});
  let bytes=0,parts=[];for await(const part of response.body){bytes+=part.length;if(bytes>2097152)throw Error();parts.push(part)}
  let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{if(response.ok)throw Error()}
  if(!response.ok){const source=value&&typeof value==='object'?value:{},detail=typeof source.error==='string'?source.error:typeof source.error?.message==='string'?source.error.message:typeof source.message==='string'?source.message:'';
   const message=clean(detail).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,1500),code=source.error?.code||source.code;
   return answer({isError:true,content:[{type:'text',text:JSON.stringify({error:response.status===401||response.status===403?'workgroup_scope_denied':'workgroup_tool_failed',status:response.status,...(message?{message}:{}),...(typeof code==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(code)?{code}:{})})}]});
  }
  answer({content:[{type:'text',text:clean(JSON.stringify(value))}]});
 }catch{return answer({isError:true,content:[{type:'text',text:'{"error":"workgroup_transport_failed"}'}]})}
}
function enqueue(raw,framed){queue=queue.then(()=>handle(raw,framed)).catch(()=>{});}
process.stdin.on('data',chunk=>{
 input=Buffer.concat([input,chunk]);if(input.length>2097152){process.stderr.write('workgroup_bridge_input_limit\n');process.exit(1)}
 while(input.length){
  if(input.subarray(0,15).toString('ascii').toLowerCase().startsWith('content-length:')){
   const end=input.indexOf('\r\n\r\n');if(end<0)return;const m=/^Content-Length: (\d+)\r\n(?:[^\r\n]+\r\n)*\r\n$/i.exec(input.subarray(0,end+4).toString('ascii'));
   if(!m||Number(m[1])>2097152)fail();const size=Number(m[1]);if(input.length<end+4+size)return;enqueue(input.subarray(end+4,end+4+size).toString('utf8'),true);input=input.subarray(end+4+size);
  }else{const n=input.indexOf(10);if(n<0)return;const raw=input.subarray(0,n).toString('utf8').trim();input=input.subarray(n+1);if(raw)enqueue(raw,false);}
 }
});
process.stdin.on('end',()=>{ending=true;if(input.length&&input.toString('utf8').trim())enqueue(input.toString('utf8'),false);void queue.then(()=>{});});
`;

export async function prepareWorkgroupInvocation(input:WorkgroupRuntimeInput,record:ClientRecord,deps:Pick<WorkgroupRuntimeDependencies,'codexMcpInventory'|'harnessMcpInventory'|'harnessRouteResolver'|'harnessStartupInventory'>={}):Promise<AgentInvocation>{
  for(const id of [input.jobId,input.roomId,input.memberId,input.agentId])identifier(id);
  if(input.nativeSessionId)identifier(input.nativeSessionId);
  if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>1024*1024)throw Error('invalid_prompt');
  if(!Array.isArray(input.allowedRoots)||!input.allowedRoots.length||input.allowedRoots.length>32)throw Error('invalid_scope');
  const roots=await Promise.all(input.allowedRoots.map(r=>noLinks(r)));
  if(!(await Promise.all(roots.map(async r=>(await fs.stat(r)).isDirectory()))).every(Boolean))throw Error('invalid_scope');
  const cwd=await noLinks(input.cwd);if(!roots.some(r=>inside(r,cwd))||!(await fs.stat(cwd)).isDirectory())throw Error('outside_scope');
  const dir=await noLinks(input.artifactDir,true);if(!roots.some(r=>inside(r,dir)))throw Error('outside_scope');
  await fs.mkdir(dir,{recursive:true});await noLinks(dir);
  const suffix=randomUUID(),promptFile=path.join(dir,`prompt-${suffix}.txt`);
  const kind:ClientKind=input.clientId==='deepseek-harness'?'dsh':input.clientId;
  if(record.kind!==kind||record.status!=='verified')throw Error('client_not_verified');
  const additionalRoots=[...new Set(roots)].filter(r=>!same(r,cwd));
  if(additionalRoots.length&&(!['codex','claude'].includes(kind)||!record.supportedFlags?.includes('--add-dir')))throw Error('additional_roots_unsupported');
  // Preparation persists user instructions; credentials are not allowed to enter that artifact.
  const secrets=[input.mcp?.token||''];
  await fs.writeFile(promptFile,redactWorkgroupText(input.prompt,secrets),{flag:'wx',mode:0o600});
  let patch:unknown[]|undefined,bridgePath:string|undefined,configPath:string|undefined;
  const env=workgroupEnvironment(process.env,record.env);
  let resolvedHarnessRoute:HarnessRoute|undefined;
  if(kind==='dsh'&&input.model){
    resolvedHarnessRoute=await(deps.harnessRouteResolver||nativeHarnessRouteResolver)(record,cwd,env,input.signal,input.model,input.provider);
    if(resolvedHarnessRoute.model!==input.model||input.provider&&resolvedHarnessRoute.provider!==input.provider||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(resolvedHarnessRoute.provider))throw Error('native_model_route_unavailable');
    if(resolvedHarnessRoute.source==='native_desktop_config'){
      if(!resolvedHarnessRoute.adapterId||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(resolvedHarnessRoute.adapterId))throw Error('native_model_route_unavailable');
      // This turn uses only the selected route; the installed profile and other adapters stay intact.
      patch=[{id:resolvedHarnessRoute.adapterId,name:'@deepseek-ai/dsh-llm-pi-ai',config:{providers:{[resolvedHarnessRoute.provider]:safeHarnessProviderConfig(resolvedHarnessRoute.providerConfig)}}}];
    }
  }
  if(input.mcp){
    const {baseUrl,token,tools}=input.mcp;let url:URL;try{url=new URL(baseUrl)}catch{throw Error('invalid_mcp')}
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.username||url.password||url.search||url.hash||typeof token!=='string'||token.length<24||/\s/.test(token))throw Error('invalid_mcp');
    if(!Array.isArray(tools)||!tools.length||tools.length>12||tools.some(t=>!TOOL_NAMES.has(t.name)||!t.inputSchema)||new Set(tools.map(t=>t.name)).size!==tools.length)throw Error('invalid_mcp_tools');
    const encoded=JSON.stringify({tools});if(Buffer.byteLength(encoded)>262144||encoded.includes(token))throw Error('invalid_mcp_tools');
    bridgePath=path.join(dir,`workgroup-bridge-${suffix}.mjs`);configPath=path.join(dir,`workgroup-tools-${suffix}.json`);
    await fs.writeFile(bridgePath,WORKGROUP_BRIDGE_SOURCE,{flag:'wx',mode:0o600});await fs.writeFile(configPath,encoded,{flag:'wx',mode:0o600});
    env.WORKBENCH_WORKGROUP_TOKEN=token;env.WORKBENCH_WORKGROUP_BASE_URL=url.href;
    if(kind==='dsh'){
      const inherited=await(deps.harnessMcpInventory||nativeHarnessMcpInventory)(record,cwd,env,input.signal);
      if(inherited.some(item=>item.id==='workbench-workgroup'))throw Error('native_mcp_policy_conflict');
      const startup=await(deps.harnessStartupInventory||nativeHarnessStartupInventory)(record,cwd,env,input.signal);
      if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(startup.id)||!Array.isArray(startup.inject)||startup.inject.some(v=>! /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(v)))throw Error('native_mcp_isolation_unavailable');
      const readyPath=path.join(dir,`workgroup-ready-${suffix}.mjs`);await fs.writeFile(readyPath,HARNESS_WORKGROUP_READY_SOURCE,{flag:'wx',mode:0o600});
      patch=[...(patch||[]),...inherited.map(item=>({id:item.id,name:item.name,disabled:true})),{id:startup.id,name:'@deepseek-ai/dsh-headless',inject:[...new Set([...startup.inject,'headlessStartup','workbenchWorkgroupReady'])]},
        {insert:[{id:'workbench-workgroup-ready',name:readyPath,config:{tools:tools.map(t=>'mcp__workbench_workgroup__'+t.name)}}]},
        {insert:[{id:'workbench-workgroup',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'workbench_workgroup',transport:'stdio',command:process.execPath,args:[bridgePath,configPath],cwd,toolCallTimeoutMs:120000,failOnStartupError:true}}]}];
    }
  }
  const invocation=await buildAgentInvocation(record,{role:'execution',cwd,artifactDir:dir,promptFile,sessionId:input.nativeSessionId,model:input.model,provider:resolvedHarnessRoute?.provider||input.provider,imageToolsPatch:patch,resolvedHarnessRoute});
  if(kind==='dsh'&&input.mcp){
    const overlayPath=invocation.args[invocation.args.indexOf('--patch')+1],rows=JSON.parse(await fs.readFile(overlayPath,'utf8'));
    const row=rows.findIndex((p:any)=>p.insert?.some((e:any)=>e.id==='workbench-workgroup')),entry=rows[row]?.insert?.findIndex((e:any)=>e.id==='workbench-workgroup');
    if(row<0||entry<0)throw Error('native_mcp_isolation_unavailable');
    rows[row].insert[entry].config.env={};const document=new Document(rows);
    // These two internal expressions are the only executable YAML generated here. They carry
    // the already-scoped grant across native subprocess scrubbing without serializing its value.
    for(const name of ['WORKBENCH_WORKGROUP_TOKEN','WORKBENCH_WORKGROUP_BASE_URL']){const expression=new Scalar('process.env.'+name);expression.tag='tag:yaml.org,2002:js';document.setIn([row,'insert',entry,'config','env',name],expression);}
    await fs.writeFile(overlayPath,document.toString({lineWidth:0}),{mode:0o600});
    const checked=await(deps.harnessMcpInventory||nativeHarnessMcpInventory)(record,cwd,env,input.signal,overlayPath);if(checked.filter(e=>!e.disabled).length!==1||checked.find(e=>!e.disabled)?.id!=='workbench-workgroup')throw Error('native_mcp_isolation_unavailable');
  }
  if(additionalRoots.length){const extra=additionalRoots.flatMap(r=>['--add-dir',r]);if(kind==='codex')invocation.args.splice((record.prefixArgs||[]).length+1,0,...extra);else invocation.args.push(...extra);}
  if(kind==='claude'){
    const at=invocation.args.indexOf('--permission-mode');invocation.args[at+1]='acceptEdits';
    if(record.supportedFlags?.includes('--permission-prompts'))invocation.args.push('--permission-prompts','none');
    if(input.mcp){
      if(!record.supportedFlags?.includes('--mcp-config')||!record.supportedFlags?.includes('--allowedTools')||!record.supportedFlags?.includes('--strict-mcp-config'))throw Error('unsupported_mcp');
      const nativeConfig=path.join(dir,`claude-mcp-${suffix}.json`);
      // ${VAR} expansion is performed by Claude from this invocation's environment.
      const content={mcpServers:{workbench_workgroup:{type:'stdio',command:process.execPath,args:[bridgePath,configPath],env:{WORKBENCH_WORKGROUP_TOKEN:'${WORKBENCH_WORKGROUP_TOKEN}',WORKBENCH_WORKGROUP_BASE_URL:'${WORKBENCH_WORKGROUP_BASE_URL}'}}}};
      await fs.writeFile(nativeConfig,JSON.stringify(content),{flag:'wx',mode:0o600});
      invocation.args.push('--strict-mcp-config','--mcp-config',nativeConfig,'--allowedTools',input.mcp.tools.map(t=>'mcp__workbench_workgroup__'+t.name).join(','));
    }
  }else if(kind==='codex'&&input.mcp){
    const inventory=deps.codexMcpInventory||nativeCodexMcpInventory;
    const inherited=(await inventory(record,cwd,env,input.signal)).map(item=>typeof item==='string'?{name:item,transport:'stdio' as const}:item);
    if(inherited.some(item=>item.name==='workbench_workgroup'))throw Error('native_mcp_policy_conflict');
    // A previously configured same-name server is rejected, not overwritten. Rules outside
    // this new per-job bridge remain native decisions. Only these scoped tools are approved.
    const settings:Record<string,unknown>={command:process.execPath,args:[bridgePath,configPath],cwd,env_vars:['WORKBENCH_WORKGROUP_TOKEN','WORKBENCH_WORKGROUP_BASE_URL'],required:true,enabled_tools:input.mcp.tools.map(t=>t.name)};
    // Codex lists some builtins that have no source TOML transport table. Give each disabled
    // placeholder a complete inert transport; enabled=false prevents any launch or request.
    const configArgs=[...inherited.flatMap(item=>['-c',`mcp_servers.${item.name}.enabled=false`,'-c',item.transport==='stdio'?`mcp_servers.${item.name}.command=${JSON.stringify(process.execPath)}`:`mcp_servers.${item.name}.url="http://127.0.0.1:1/"`]),...Object.entries(settings).flatMap(([key,value])=>['-c',`mcp_servers.workbench_workgroup.${key}=${JSON.stringify(value)}`]),...input.mcp.tools.flatMap(t=>['-c',`mcp_servers.workbench_workgroup.tools.${t.name}.approval_mode="approve"`])];
    await inventory(record,cwd,env,input.signal,configArgs);
    // Options precede the subcommand / stdin marker, including explicit resume.
    invocation.args.splice((record.prefixArgs||[]).length+1,0,...configArgs);
  }else if(kind==='grok'&&input.mcp)throw Error('unsupported_mcp');
  invocation.env=env as Record<string,string>;
  return invocation;
}

/** Real native process. No raw log file is produced; callbacks receive only fixed activity names,
 * a PID, validated session IDs and the final public answer. A native denial is never retried. */
export async function runWorkgroupTurn(input:WorkgroupRuntimeInput,deps:WorkgroupRuntimeDependencies={}):Promise<WorkgroupRuntimeResult>{
  let nativeSessionId=input.nativeSessionId,actualModel:string|undefined;
  const base=()=>({nativeSessionId,actualModel,exitCode:null,processStopped:true,text:''});
  if(input.signal.aborted)return {...base(),status:'cancelled',errorCode:'cancelled'};
  let invocation:AgentInvocation;const kind:ClientKind=input.clientId==='deepseek-harness'?'dsh':input.clientId;
  try{const record=await(deps.resolveClient||resolveAgentClient)(input.dataDir,kind);invocation=await prepareWorkgroupInvocation(input,record,deps);}
  catch(e){if(input.signal.aborted)return {...base(),status:'cancelled',errorCode:'cancelled'};const code=(e as Error).message;return {...base(),status:'blocked',errorCode:['invalid_path','linked_path','invalid_identity','invalid_prompt','invalid_scope','outside_scope','invalid_mcp','invalid_mcp_tools','unsupported_mcp','additional_roots_unsupported','client_not_verified','native_mcp_inventory_failed','native_mcp_policy_conflict','native_mcp_isolation_unavailable','native_model_route_unavailable','native_model_route_ambiguous','native_route_configuration_unsafe','native_route_policy_conflict'].includes(code)?code:'native_preparation_failed'};}
  if(input.signal.aborted)return {...base(),status:'cancelled',errorCode:'cancelled'};
  const secrets=Object.entries(invocation.env||{}).filter(([k,v])=>v&&/(?:token|secret|password|api.?key)/i.test(k)).map(([,v])=>v);
  return new Promise(resolve=>{
    const parser=createAgentOutputParser(kind),decoder=new StringDecoder('utf8');
    let child:ChildProcess|undefined,pending='',bytes=0,finalText:string|undefined,failure:string|undefined,nativeErrorMessage:string|undefined,stderrDiagnostic:string|undefined,stderrMessage:string|undefined,stderrPending='',terminal=false,finished=false,termination:Promise<boolean>|undefined;
    let timer:NodeJS.Timeout|undefined,stopTimer:NodeJS.Timeout|undefined;
    const stop=()=>{
      if(termination||!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
      const owned=child;
      termination=process.platform==='win32'?new Promise<boolean>(done=>{
        const limit=setTimeout(()=>done(false),5000);limit.unref();
        const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(owned.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.once('error',()=>{clearTimeout(limit);done(false)});killer.once('exit',code=>{clearTimeout(limit);done(code===0)});
      }):Promise.resolve(owned.kill('SIGKILL'));
      stopTimer=setTimeout(()=>finish(null,false),10000);stopTimer.unref();
    };
    const line=(raw:string)=>{
      const message=errorText(raw);if(message){nativeErrorMessage||=redactWorkgroupText(message,secrets).slice(0,1000);}
      const event=parser.push(raw);
      if(!event.recognized)return;
      if(event.sessionId){
        if(nativeSessionId&&nativeSessionId!==event.sessionId){failure='native_session_conflict';stop();return;}
        if(nativeSessionId!==event.sessionId){nativeSessionId=event.sessionId;try{input.onSessionId?.(event.sessionId)}catch{failure='session_persistence_failed';stop();return;}}
      }
      if(event.model)actualModel=event.model;
      if(event.success===false){failure=classify(raw)||'native_turn_failed';finalText=undefined;}
      if(event.toolInterruption?.code){failure=event.toolInterruption.code==='permission_denied'?'native_permission_denied':'native_tool_failed';}
      if(event.terminal)terminal=true;
      if(event.terminal&&event.finalText!==undefined&&event.success!==false)finalText=redactWorkgroupText(event.finalText,secrets);
      try{input.onActivity?.(event.terminal?'native_turn_finished':event.sessionId?'native_session_started':'native_activity')}catch{failure='activity_persistence_failed';stop();}
    };
    const stderrLine=(value:string)=>{
      // Harness --json does not stream reasoning to stderr. Its durable terminal error has
      // this exact code prefix; general diagnostics and arbitrary dsh text stay private.
      if(/^\s*(?:Error:|error:|fatal:)/.test(value)||(kind==='dsh'&&/^dsh: [A-Z][A-Z0-9_]{1,79}: /.test(value))){stderrDiagnostic=classify(value)||stderrDiagnostic;if(!stderrMessage)stderrMessage=redactWorkgroupText(value,secrets).slice(0,1000);}
    };
    const finish=(exitCode:number|null,stopped:boolean)=>{
      if(finished)return;finished=true;clearTimeout(timer);clearTimeout(stopTimer);input.signal.removeEventListener('abort',abort);
      pending+=decoder.end();if(pending.trim()&&pending.length<=MAX_LINE)line(pending);pending='';
      if(stderrPending.length<=8192)stderrLine(stderrPending);stderrPending='';
      void(async()=>{
        const processStopped=stopped&&(termination?await termination:true);
        const code=failure||(!processStopped?'native_process_state_unknown':exitCode!==0?stderrDiagnostic||'native_process_failed':!terminal||finalText===undefined?stderrDiagnostic||'native_final_missing':undefined);
        const status=input.signal.aborted?'cancelled':code==='native_permission_denied'?'blocked':code?'failed':'completed';
        const errorMessage=code?(nativeErrorMessage||stderrMessage):undefined;
        resolve({status,text:status==='completed'?finalText||'':'',nativeSessionId,actualModel,exitCode,processStopped,...(code?{errorCode:code}:status==='cancelled'?{errorCode:'cancelled'}:{}),...(errorMessage?{errorMessage}:{})});
      })();
    };
    const abort=()=>{failure='cancelled';stop();};
    try{
      if(input.signal.aborted){failure='cancelled';finish(null,true);return;}
      try{input.onBeforeSpawn?.()}catch{failure='process_persistence_failed';finish(null,true);return;}
      if(input.signal.aborted){failure='cancelled';finish(null,true);return;}
      child=(deps.spawn||spawn)(invocation.command,invocation.args,{cwd:input.cwd,env:invocation.env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      child.once('error',()=>{failure='native_spawn_failed';finish(null,true)});child.once('close',code=>finish(code,true));
      child.stdout!.on('data',(chunk:Buffer)=>{
        if(finished)return;
        bytes+=chunk.length;if(bytes>MAX_OUTPUT){failure='native_output_limit';stop();return;}
        pending+=decoder.write(chunk);let n:number;while((n=pending.indexOf('\n'))>=0){const raw=pending.slice(0,n);pending=pending.slice(n+1);if(raw.length>MAX_LINE){failure='native_output_limit';stop();return;}line(raw);}
        if(pending.length>MAX_LINE){failure='native_output_limit';pending='';stop();}
      });
      child.stderr!.on('data',(chunk:Buffer)=>{if(finished)return;bytes+=chunk.length;if(bytes>MAX_OUTPUT){failure='native_output_limit';stop();return;}const text=chunk.toString('utf8');stderrDiagnostic=classify(text)||stderrDiagnostic;stderrPending+=text;let n;while((n=stderrPending.indexOf('\n'))>=0){const value=stderrPending.slice(0,n);stderrPending=stderrPending.slice(n+1);stderrLine(value);}if(stderrPending.length>8192)stderrPending='';});
      child.stdin!.on('error',()=>{});
      input.signal.addEventListener('abort',abort,{once:true});
      if(child.pid){try{input.onSpawn?.(child.pid)}catch{failure='process_persistence_failed';stop();}}
      const duration=Math.max(1000,Math.min(input.timeoutMs||600000,3600000));timer=setTimeout(()=>{failure='native_timeout';stop();},duration);timer.unref();
      if(input.signal.aborted)abort();
      child.stdin!.end(failure?'':invocation.stdin||'');
    }catch{failure='native_spawn_failed';finish(null,!child?.pid);}
  });
}

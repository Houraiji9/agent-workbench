import {spawn} from 'node:child_process';
import path from 'node:path';
import type {ClientRecord} from './client-discovery.ts';
import type {HarnessAdapterEvidence} from './agent-route-diagnostics.ts';

export type HarnessModelRoute={provider:string;model:string};
/** Only known native registration shapes are projected; absence never proves an adapter missing. */
export function harnessAdapterEvidence(config:unknown):HarnessAdapterEvidence[]{
 if(!Array.isArray(config))return [];
 const found=new Map<string,HarnessAdapterEvidence>();
 for(const entry of config){
  if(!entry||typeof entry!=='object')continue;
  const providers=entry.name==='@deepseek-ai/dsh-llm-pi-ai'?Object.keys(entry.config?.providers||{}):entry.name==='@deepseek-ai/dsh-deepseek-account-platform'?['deepseek-account']:[];
  for(const provider of providers){if(!valid(provider))continue;const status=entry.disabled===true?'disabled':entry.disabled===false||entry.disabled===undefined?'configured':'unknown';const old=found.get(provider);if(!old||status==='configured')found.set(provider,{provider,status,source:'native_headless_config'});}
 }
 return [...found.values()];
}
const valid=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
/** Accept only model identities. Credentials, URLs, and arbitrary configuration never leave this projection. */
export function harnessModelRoutes(config:unknown):HarnessModelRoute[]{
 const routes:HarnessModelRoute[]=[];
 const add=(provider:unknown,model:unknown)=>{if(valid(provider)&&valid(model)&&!routes.some(r=>r.provider===provider&&r.model===model))routes.push({provider,model});};
 if(!Array.isArray(config))return routes;
 for(const entry of config){
  if(!entry||entry.disabled===true||entry.disabled&&entry.disabled!==false)continue;
  if(entry.name==='@deepseek-ai/dsh-agent-default-model')add(entry.config?.provider,entry.config?.model);
  if(entry.name==='@deepseek-ai/dsh-llm-pi-ai')for(const [provider,value] of Object.entries(entry.config?.providers||{})){
   const p=value as {models?:Array<{id?:unknown}>;modelOverrides?:Record<string,unknown>};
   if(Array.isArray(p?.models))for(const m of p.models)add(provider,m?.id);
   for(const model of Object.keys(p?.modelOverrides||{}))add(provider,model);
  }
 }
 return routes;
}
export function resolveHarnessProvider(model:string,routes:HarnessModelRoute[]):string{
 const providers=[...new Set(routes.filter(r=>r.model===model).map(r=>r.provider))];
 if(providers.length===1)return providers[0];
 throw new Error(providers.length?`Harness 模型 ${model} 对应多个供应商，请在调用安排中选择 provider`:`Harness 当前 headless 配置未找到模型 ${model} 的供应商，请填写 provider，或清空模型使用客户端默认配置`);
}
function capture(command:string,args:string[],env:Record<string,string>|undefined,input?:string):Promise<string>{
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{env:{...process.env,...env},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let output='',bytes=0,failed=false;
  const fail=()=>{if(failed)return;failed=true;child.kill();reject(new Error('无法读取 Harness 当前模型配置，请明确填写 provider'));};
  const timer=setTimeout(fail,15000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>2*1024*1024)fail();else output+=chunk;});
  // Native diagnostics may contain configuration values. Never include them in user reports.
  child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024)fail();});
  child.on('error',fail);child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)fail();else resolve(output);});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
/** Read-only native config dump; never starts an agent, resets profiles, or calls a model. */
export async function readHarnessConfigurationEvidence(record:ClientRecord):Promise<{routes:HarnessModelRoute[];adapters:HarnessAdapterEvidence[]}>{
 const entry=record.prefixArgs?.at(-1);
 if(!record.executable||!entry||!path.isAbsolute(entry)||!/[.]m?js$/i.test(entry)||!record.supportedFlags?.includes('--dump-config'))throw new Error('此 Harness 入口未确认支持读取模型配置，请明确填写 provider');
 const raw=await capture(record.executable,[...(record.prefixArgs||[]),'--profile','headless','--dump-config'],record.env);
 // Parse with the verified native distribution's YAML parser, without evaluating YAML expressions.
 const script=`const fs=require('node:fs');const r=require('node:module').createRequire(${JSON.stringify(entry)});process.stdout.write(JSON.stringify(r('yaml').parse(fs.readFileSync(0,'utf8'))));`;
 const output=await capture(record.executable,[...(record.env?.ELECTRON_RUN_AS_NODE==='1'?['--expose-internals']:[]),'-e',script],record.env,raw);
  const config=JSON.parse(output);return {routes:harnessModelRoutes(config).slice(0,10000),adapters:harnessAdapterEvidence(config).slice(0,10000)};
}
export async function readHarnessModelRoutes(record:ClientRecord):Promise<HarnessModelRoute[]>{return (await readHarnessConfigurationEvidence(record)).routes;}

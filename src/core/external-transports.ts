import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {assert} from './security.ts';
import type {ExternalConnection} from './external-service-schema.ts';

export function validateExternalUrl(value:string,local=false,allowSignedQuery=false){
  const url=new URL(value);assert(!url.username&&!url.password&&!url.hash,'连接地址不能包含凭据或片段');
  assert(allowSignedQuery||![...url.searchParams.keys()].some(k=>/key|token|secret|password|signature/i.test(k)),'地址中的凭据请转入安全凭据字段');
  assert(url.protocol==='https:'||(local&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)),'仅支持HTTPS或明确配置的本机MCP地址');return url;
}
export function validateExternalArgs(args:string[]){assert(!args.some(x=>/(?:^|[=\s])(?:sk-[A-Za-z0-9]{10,}|Bearer\s)|--?(?:api[-_]?key|token|password|secret)(?:=|$)/i.test(x)||/[\x00]/.test(x)),'命令参数不能包含密钥，请使用安全环境变量');}
export function externalEnvironment(secrets:Record<string,string>={}){
  const env:Record<string,string>={};for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP'])if(process.env[key])env[key]=process.env[key]!;
  for(const [k,v]of Object.entries(secrets)){assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k),'CLI环境变量名称无效');assert(!['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','COMSPEC','PATH','PATHEXT','LD_PRELOAD','PYTHONPATH'].includes(k.toUpperCase()),'不允许覆盖运行时注入变量');env[k]=v;}return env;
}
// Resolve standard npm .cmd shims to Node+JS without invoking cmd.exe with user prompts.
export function externalCommand(executable:string,args:string[]){
  assert(path.isAbsolute(executable)&&fs.existsSync(executable),'请配置已安装程序的绝对路径');validateExternalArgs(args);
  if(/\.(?:cmd|bat)$/i.test(executable)){
    const text=fs.readFileSync(executable,'utf8');assert(text.length<16384,'CLI启动器过大');
    const hits=[...text.matchAll(/"%dp0%\\([^"\r\n]+\.(?:js|mjs|cjs))"/gi)];assert(hits.length>0,'此批处理入口无法安全解析，请选择真实exe或Node入口');
    const js=path.resolve(path.dirname(executable),hits[hits.length-1][1]);assert(fs.statSync(js).isFile(),'CLI脚本不存在');
    const localNode=path.join(path.dirname(executable),'node.exe');return {command:fs.existsSync(localNode)?localNode:process.execPath,args:[js,...args]};
  }
  assert(!/\.(?:ps1|vbs|wsf)$/i.test(executable),'请配置原生程序或标准npm启动器');return {command:executable,args};
}
export function externalExec(executable:string,args:string[],cwd:string,env:Record<string,string>,timeout:number,stdin?:string,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();
  const spec=externalCommand(executable,args);
  return new Promise((resolve,reject)=>{
    const child=spawn(spec.command,spec.args,{cwd,env,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let output='',reason='',settled=false;
    const terminate=()=>{if(child.pid&&child.exitCode===null){if(process.platform==='win32')spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());else child.kill('SIGKILL');}};
    const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(output);};
    const abort=()=>{reason='工作台退出，外部调用已停止等待；结果未知，不能自动重发';terminate();done(new Error(reason));};
    const timer=setTimeout(()=>{reason='调用超时，结果可能已受理，请勿重复提交';terminate();done(new Error(reason));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{output+=b.toString();if(Buffer.byteLength(output)>8*1024*1024){reason='CLI结果超过8MiB限制';terminate();done(new Error(reason));}});child.stderr.resume();
    child.once('error',()=>done(new Error('CLI无法启动，请检查路径和运行环境')));child.once('close',code=>done(code===0&&!reason?undefined:new Error(reason||'CLI返回失败，请在客户端检查登录、权限或参数')));
    child.stdin.on('error',()=>{});child.stdin.end(stdin||'');
  });
}
export async function withExternalMcp<T>(c:ExternalConnection,secrets:Record<string,string>,fn:(client:Client)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();
  const client=new Client({name:'agent-workbench-external',version:'1.0.0'});
  const headers:Record<string,string>={};for(const[k,v]of Object.entries(secrets))if(k==='Authorization')headers.Authorization=v;else if(k==='api_key'||k==='apiKey'||k==='token')headers.Authorization='Bearer '+v;else if(k.startsWith('header_'))headers[k.slice(7)]=v;
  const transport=c.mcp_transport==='streamable-http'?new StreamableHTTPClientTransport(validateExternalUrl(c.mcp_url,true),{requestInit:{headers,redirect:'error'},reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}):new StdioClientTransport({...externalCommand(c.executable,c.args),cwd:c.cwd||undefined,env:externalEnvironment(secrets),stderr:'pipe',maxBufferSize:8*1024*1024});
  if('stderr'in transport)(transport.stderr as any)?.resume?.();
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  try{return await Promise.race([(async()=>{await client.connect(transport);return fn(client);})(),new Promise<never>((_,reject)=>{const stop=()=>{void client.close().catch(()=>{});reject(new Error('MCP调用超时或工作台退出，结果未知，不能自动重发'));};timer=setTimeout(stop,c.timeout_ms);abort=stop;signal?.addEventListener('abort',abort,{once:true});})]);}
  finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);await client.close().catch(()=>{});await transport.close().catch(()=>{});}
}

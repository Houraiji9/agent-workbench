import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Workbench } from './workbench.ts';
import { agentClientKind } from './agent-client-kind.ts';
import { resolveAgentClient, supportsCursorPlanMode, type ClientRecord, type ClientKind } from './client-discovery.ts';
import { buildAgentInvocation, createAgentOutputParser, type AgentInvocation } from './agent-clients.ts';
import { readHarnessModelRoutes } from './harness-models.ts';
import { currentMachineId, isOnboardingClaude, recordOnboardingModels, recordOnboardingInvocation } from './onboarding-models.ts';
import { assert } from './security.ts';

export const onboardingDiagnosticInput=z.object({request_id:z.string().uuid(),agent_id:z.string().min(1).max(300),model:z.string().min(1).max(300).nullable().optional(),provider:z.string().min(1).max(300).optional()}).strict();
export const onboardingRefreshInput=z.object({agent_id:z.string().min(1).max(300).optional()}).strict();
type FailureKind='authentication'|'quota'|'model_unavailable'|'workspace_trust'|'permission';
type Capture={stdout:string;exit_code:number|null;timed_out?:boolean;output_limited?:boolean;failure_kind?:FailureKind};
const failureAdvice:Record<FailureKind,string>={workspace_trust:'Cursor要求信任工作区；仅可对工作台新建的空诊断目录使用已验证的 --trust，不信任整个项目或修改全局配置。',permission:'客户端拒绝了当前权限；检查客户端的具体授权状态，不添加 --force 或 --yolo 绕过。',authentication:'客户端登录未生效，请通过该客户端支持的登录入口恢复账号。',quota:'客户端报告额度或速率限制，请核对当前账号额度后再由用户决定是否另开诊断。',model_unavailable:'客户端明确拒绝了请求型号；请核对精确原生ID和当前账号权限，不自动更换型号。'};
export function classifyOnboardingDiagnosticFailure(raw:string):FailureKind|undefined{
  if(/workspace trust required|untrusted workspace|trust (?:the |this )?(?:workspace|directory)/i.test(raw))return 'workspace_trust';
  if(/permission denied|access denied|not permitted|authorization required|权限不足|拒绝访问/i.test(raw))return 'permission';
  if(/unauthenticated|unauthorized|login required|not logged|authentication failed|登录失效/i.test(raw))return 'authentication';
  if(/rate.limit|quota|insufficient.credit|额度|限额/i.test(raw))return 'quota';
  if(/model.{0,40}(?:not found|not available|unsupported)|unknown model/i.test(raw))return 'model_unavailable';
}
function noDiagnosticLinks(target:string){
  const absolute=path.resolve(target),root=path.parse(absolute).root;let current=root;
  for(const segment of path.relative(root,absolute).split(path.sep).filter(Boolean)){current=path.join(current,segment);try{assert(!fs.lstatSync(current).isSymbolicLink(),'诊断目录不能通过链接');}catch(error:any){if(error.code!=='ENOENT')throw error;}}
}
const createdDiagnosticDirectories=new Set<string>();
function createDiagnosticDirectory(wb:Workbench,requestId:string){
  const parent=path.resolve(wb.config.dataDir,'onboarding-diagnostics');noDiagnosticLinks(parent);fs.mkdirSync(parent,{recursive:true});noDiagnosticLinks(parent);
  const dir=path.join(parent,requestId);fs.mkdirSync(dir);noDiagnosticLinks(dir);assert(fs.readdirSync(dir).length===0,'诊断目录必须新建且为空');createdDiagnosticDirectories.add(dir);return dir;
}
/** Cursor trust is scoped to a newly created empty directory, never a normal review workspace. */
export function buildCursorDiagnosticInvocation(record:ClientRecord,dir:string,model:string,prompt:string):AgentInvocation{
  assert(createdDiagnosticDirectories.has(dir),'仅允许本程序创建的诊断目录');
  checkRecord(record);assert(record.kind==='cursor'&&record.status==='verified','诊断需要已验证的Cursor入口');
  assert(record.executable&&path.isAbsolute(record.executable)&&!/[.](?:cmd|bat|ps1)$/i.test(record.executable),'客户端需要已验证的原生执行入口');
  for(const flag of ['--trust','--print','--mode','--output-format','--model','--workspace'])assert(record.supportedFlags?.includes(flag),'Cursor诊断未确认支持 '+flag);
  assert(supportsCursorPlanMode(record.help),'Cursor诊断需要已验证的只读plan模式');
  assert(!isOnboardingClaude(model)&&!/[\x00-\x1f\x7f]/.test(model)&&! /^(?:auto|default)$/i.test(model),'诊断必须明确非Claude原生型号');
  assert(!record.prefixArgs?.some(a=>/^(?:--force|--yolo|-f|--trust)(?:=|$)/i.test(a)),'诊断入口不能预置权限提升参数');
  noDiagnosticLinks(dir);assert(fs.readdirSync(dir).length===0,'只允许信任新建的空诊断目录');
  createdDiagnosticDirectories.delete(dir);
  return {command:record.executable,args:[...(record.prefixArgs||[]),'--print','--mode','plan','--output-format','json','--model',model,'--workspace',dir,'--trust',prompt],...(record.env?{env:record.env}:{})};
}
// Only isolated tests supply these code-level hooks. Never accept hooks from an API request.
export type OnboardingDiagnosticHooks={resolve?:typeof resolveAgentClient;routes?:typeof readHarnessModelRoutes;build?:typeof buildAgentInvocation;run?:(invocation:AgentInvocation,cwd:string)=>Promise<Capture>};
const runs=new Map<string,Promise<any>>();
const FILE='onboarding-diagnostics.json';
function file(wb:Workbench){return path.join(wb.config.dataDir,FILE);}
function read(wb:Workbench):any[]{try{const raw=fs.readFileSync(file(wb),'utf8');assert(Buffer.byteLength(raw)<=4*1024*1024,'诊断记录超过限制');const v=JSON.parse(raw);assert(v.schema_version===1&&Array.isArray(v.records),'诊断记录格式无效');return v.records;}catch(e:any){if(e.code==='ENOENT')return [];throw e;}}
function write(wb:Workbench,records:any[]){fs.mkdirSync(wb.config.dataDir,{recursive:true});const target=file(wb),tmp=target+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({schema_version:1,records},null,2),{mode:0o600,flag:'wx'});fs.renameSync(tmp,target);}
function save(wb:Workbench,record:any){const records=read(wb),i=records.findIndex(r=>r.request_id===record.request_id);if(i<0)records.push(record);else records[i]=record;write(wb,records);return record;}
export function getOnboardingDiagnostics(wb:Workbench){return {machine_id:currentMachineId(),records:read(wb).filter(r=>r.machine_id===currentMachineId())};}
function checkAgent(wb:Workbench,aid:string,model?:string|null,provider?:string){
  assert(!isOnboardingClaude(aid,model,provider),'本次初始化跳过 Claude / Anthropic');
  const agent=wb.get('agents',aid),kind=agentClientKind(agent);
  assert(!isOnboardingClaude(agent.id,agent.name,agent.preset_id,agent.client_id,agent.client,agent.provider,agent.model,kind),'本次初始化跳过 Claude / Anthropic');
  return {agent,kind:kind as ClientKind|null};
}
function checkRecord(record:ClientRecord){assert(!isOnboardingClaude(record.kind,record.label,record.executable,record.candidatePath,...(record.prefixArgs||[])),'本次初始化跳过 Claude 客户端');}
async function capture(invocation:AgentInvocation,cwd:string):Promise<Capture>{
  return new Promise(resolve=>{
    let stdout='',diagnostic='',bytes=0,timed_out=false,output_limited=false,settled=false;
    const child=spawn(invocation.command,invocation.args,{cwd,env:{...process.env,...invocation.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const finish=(exit_code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);const failure_kind=classifyOnboardingDiagnosticFailure(diagnostic);resolve({stdout,exit_code,timed_out,output_limited,...(failure_kind?{failure_kind}:{})});};
    const timer=setTimeout(()=>{timed_out=true;child.kill();finish(null);},45000);
    const chunk=(data:Buffer,keep:boolean)=>{bytes+=data.length;if(bytes>256*1024){output_limited=true;child.kill();finish(null);}else{diagnostic+=data.toString('utf8');if(keep)stdout+=data.toString('utf8');}};
    child.stdout.on('data',d=>chunk(d,true));child.stderr.on('data',d=>chunk(d,false));child.on('error',()=>finish(null));child.on('close',finish);child.stdin.on('error',()=>{});child.stdin.end(invocation.stdin);
  });
}
export function parseOnboardingModelEnumeration(raw:string,kind:ClientKind){
  let items:any[];
  if(kind==='cursor'&&!/^[\s]*[\[{]/.test(raw)){
    const lines=raw.split(/\r?\n/),heading=lines.findIndex(line=>line.trim()==='Available models');assert(heading>=0,'客户端未提供已知模型列表格式');
    items=[];
    for(const line of lines.slice(heading+1)){
      if(line.startsWith('Tip:'))break;
      // Observed Cursor --list-models format only; IDs are not derived from labels or tip examples.
      const match=/^([A-Za-z0-9][A-Za-z0-9._:/-]{0,299}) - (\S.*)$/.exec(line);
      if(match)items.push({id:match[1],name:match[2]});
    }
    assert(items.length>0,'客户端模型列表未披露原生 ID');
  }else{const parsed=JSON.parse(raw);items=Array.isArray(parsed)?parsed:parsed.models;assert(Array.isArray(items),'客户端模型列表未提供可解析数组');}
  return items.map((m:any)=>{assert(m&&typeof m==='object'&&typeof m.id==='string','模型列表未披露原生 ID');return {id:m.id,...(typeof m.name==='string'?{name:m.name}:{}),...(typeof m.provider==='string'?{provider:m.provider}:{}),status:'advertised' as const};}).filter(m=>!isOnboardingClaude(m.id,m.name,m.provider)&&!/^(?:auto|default)$/i.test(m.id)).slice(0,200);
}
export async function refreshOnboardingModels(wb:Workbench,input:unknown,actor:string,hooks:OnboardingDiagnosticHooks={}){
  const v=onboardingRefreshInput.parse(input);assert(actor.trim(),'必须记录实际操作者');
  if(v.agent_id)checkAgent(wb,v.agent_id);
  const agents=v.agent_id?[wb.get('agents',v.agent_id)]:wb.all('agents').filter(a=>!a.archived),results:any[]=[];
  for(const a of agents){
    if(isOnboardingClaude(a.id,a.name,a.preset_id,a.client_id,a.client,a.provider,a.model)){results.push({agent_id:a.id,status:'skipped',reason:'按用户要求跳过 Claude'});continue;}
    const {kind}=checkAgent(wb,a.id);if(!kind){results.push({agent_id:a.id,status:'unknown',reason:'网页或手动入口，无已登记本机自动客户端'});continue;}
    try{
      const record=await (hooks.resolve||resolveAgentClient)(wb.config.dataDir,kind);checkRecord(record);
      if(record.status!=='verified'){results.push({agent_id:a.id,status:'unknown',reason:'客户端尚未验证',client_status:record.status});continue;}
      let models:any[]=[],source:'client_config'|'client_models'='client_models';
      if(kind==='dsh'){source='client_config';models=(await (hooks.routes||readHarnessModelRoutes)(record)).filter(r=>!isOnboardingClaude(r.model,r.provider)).map(r=>({id:r.model,provider:r.provider,status:'configured'}));}
      else if(record.supportedFlags?.includes('--list-models')&&record.executable){const result=await (hooks.run||capture)({command:record.executable,args:[...(record.prefixArgs||[]),'--list-models'],env:record.env},wb.config.dataDir);assert(result.exit_code===0&&!result.timed_out&&!result.output_limited,'原生模型枚举失败或超时');models=parseOnboardingModelEnumeration(result.stdout,kind);}
      const result=recordOnboardingModels(wb,{agent_id:a.id,machine_id:currentMachineId(),client_id:kind,client_version:record.version,observed_at:new Date().toISOString(),source,models,reason:models.length?undefined:'客户端未提供可验证的模型枚举，保持未知'},actor);
      results.push({agent_id:a.id,status:models.length?'recorded':'unknown',model_count:models.length,conflicts:result.conflicts});
    }catch{results.push({agent_id:a.id,status:'unknown',reason:'模型核对失败；未记录可用性，客户端原始配置与输出不展示'});}
  }
  return {machine_id:currentMachineId(),results};
}
export async function executeOnboardingDiagnostic(wb:Workbench,input:unknown,actor:string,hooks:OnboardingDiagnosticHooks={}){
  const v=onboardingDiagnosticInput.parse(input);assert(actor.trim(),'必须记录实际操作者');const {kind}=checkAgent(wb,v.agent_id,v.model,v.provider);
  // Explicit model required even for Cursor; its implicit default may route to Claude.
  if(!v.model||/^(?:auto|default)$/i.test(v.model))return {request_id:v.request_id,agent_id:v.agent_id,status:'needs_model',reason:'请明确选择非 Claude 原生模型 ID，不使用客户端默认型号'};
  if(!kind)return {request_id:v.request_id,agent_id:v.agent_id,status:'manual_only',reason:'没有已登记的自动客户端'};
  const identity=JSON.stringify([v.agent_id,v.model,v.provider??null]),key=file(wb)+':'+v.request_id;
  const existing=read(wb).find(r=>r.request_id===v.request_id);
  if(existing){assert(existing.identity===identity,'诊断 request_id 已用于另一条路由');return existing;}
  if(runs.has(key))return runs.get(key);
  const operation=(async()=>{
    const start={...v,machine_id:currentMachineId(),identity,client_id:kind,actor,status:'started',started_at:new Date().toISOString(),actual_model:'unknown',actual_provider:'unknown',cost:'unknown'};
    save(wb,start);wb.audit(actor,'start_onboarding_diagnostic',v.request_id,{agent_id:v.agent_id,client_id:kind,model:v.model,provider:v.provider??null});
    let result:any={...start},stage='resolve_client';
    try{
      const record=await (hooks.resolve||resolveAgentClient)(wb.config.dataDir,kind);checkRecord(record);assert(record.status==='verified','客户端尚未验证');
      let provider=v.provider;stage='resolve_provider';
      if(kind==='dsh'&&!provider){const routes=(await (hooks.routes||readHarnessModelRoutes)(record)).filter(r=>r.model===v.model&&!isOnboardingClaude(r.model,r.provider));const providers=[...new Set(routes.map(r=>r.provider))];assert(providers.length===1,'Harness 需要明确的非 Claude provider');provider=providers[0];}
      assert(!isOnboardingClaude(provider),'本次初始化跳过 Claude provider');
      stage='create_isolated_directory';const dir=createDiagnosticDirectory(wb,v.request_id),promptFile=path.join(dir,'PROMPT.txt'),nonce='WB_DIAGNOSTIC_'+randomUUID();
      const prompt=`只读连接诊断。不要调用工具、读写任何文件或执行命令。只在最终回复中原样输出这一行，不添加说明：${nonce}\n`;
      if(kind!=='cursor')fs.writeFileSync(promptFile,prompt,{flag:'wx',mode:0o600});
      stage='build_invocation';const invocation=kind==='cursor'?buildCursorDiagnosticInvocation(record,dir,v.model!,prompt):await (hooks.build||buildAgentInvocation)(record,{role:'review',cwd:dir,artifactDir:dir,promptFile,model:v.model,provider});
      assert(!isOnboardingClaude(invocation.command,...invocation.args,invocation.resolvedRoute?.model,invocation.resolvedRoute?.provider),'诊断调用路由包含 Claude');
      stage='invoke_and_parse';const output=await (hooks.run||capture)(invocation,dir),parser=createAgentOutputParser(kind);let terminal:any,actual_model:string|undefined,modelFormat:string|undefined,usage:any,failed=false;const observedModels=new Set<string>();
      for(const line of output.stdout.split(/\r?\n/)){const event=parser.push(line);if(event.model){actual_model=event.model;modelFormat=event.modelFormat;observedModels.add(event.model);}if(event.usage)usage=event.usage;if(event.success===false)failed=true;if(event.terminal)terminal=event;}
      const echo=terminal?.finalText?.trim()===nonce,terminalSuccess=terminal?.success===true||kind==='dsh'&&terminal?.eventType==='final';
      const responded=output.exit_code===0&&!output.timed_out&&!output.output_limited&&!failed&&terminalSuccess&&echo;
      const mismatch=!!actual_model&&(isOnboardingClaude(actual_model)||modelFormat!=='display_name'&&(actual_model!==v.model||observedModels.size>1));
      result={...start,status:output.timed_out?'timeout':output.output_limited?'output_limit':mismatch?'model_mismatch':responded?'success':output.failure_kind||'failed',finished_at:new Date().toISOString(),client_version:record.version??null,requested_provider:provider??null,actual_model:modelFormat==='display_name'?'unknown':actual_model??'unknown',...(modelFormat==='display_name'?{actual_model_label:actual_model}:{}),actual_model_format:modelFormat??'unknown',observed_models:[...observedModels],exit_code:output.exit_code,nonce_echo:echo,parsed_terminal:!!terminal,usage:usage??null,cost:usage?.totalCostUsd??'unknown',reason:mismatch?'实际披露型号与请求 ID 不一致，未提升验证':responded?'固定样例已得到原样最终回复；未披露原生型号仍保持未知':output.failure_kind?failureAdvice[output.failure_kind]:`客户端退出码 ${output.exit_code??'未知'}；未获得匹配的成功终态与样例回复，不据此判断型号不可用`};
      if(responded&&!mismatch&&actual_model===v.model&&modelFormat!=='display_name')recordOnboardingInvocation(wb,{agent_id:v.agent_id,machine_id:currentMachineId(),client_id:kind,client_version:record.version,observed_at:result.finished_at,source:'invocation',models:[{id:v.model,provider,status:'invocation_verified'}]},actor);
    }catch{result={...result,status:'failed',exit_code:null,failure_stage:stage,finished_at:new Date().toISOString(),reason:stage==='build_invocation'?'安全调用条件未满足；核对Cursor --trust/plan等原生能力标记及空诊断目录，不添加force/yolo或全局信任。':'客户端调用或解析失败；原始输出未展示，无重试或降级'};}
    createdDiagnosticDirectories.delete(path.resolve(wb.config.dataDir,'onboarding-diagnostics',v.request_id));
    save(wb,result);wb.audit(actor,'finish_onboarding_diagnostic',v.request_id,result);return result;
  })();
  runs.set(key,operation);try{return await operation;}finally{runs.delete(key);}
}

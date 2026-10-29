import os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Workbench } from './workbench.ts';
import { assert, now } from './security.ts';

// Evidence is supplied by the caller. This module never imports discovery or reads client files.
const exact=z.string().min(1).max(300).refine(v=>v===v.trim(),'原生 ID 不允许前后空格');
export const onboardingModelSchema=z.object({id:exact,name:z.string().min(1).max(300).optional(),provider:exact.optional(),status:z.enum(['advertised','configured','invocation_verified'])}).strict();
export const onboardingModelsInput=z.object({agent_id:exact,machine_id:exact,client_id:exact,client_version:exact.optional(),observed_at:z.string().datetime({offset:true}),source:z.enum(['client_models','client_config','invocation','manual']),models:z.array(onboardingModelSchema).max(200),reason:z.string().max(2000).optional()}).strict();
export type OnboardingModelsInput=z.infer<typeof onboardingModelsInput>;
export function currentMachineId(){return createHash('sha256').update(JSON.stringify([os.hostname(),os.platform(),os.arch(),os.homedir()])).digest('hex');}
export const onboardingMachineId=currentMachineId;
export function isOnboardingClaude(...values:unknown[]){return values.some(v=>typeof v==='string'&&/(claude|anthropic)/i.test(v));}
function excluded(a:any){return isOnboardingClaude(a.id,a.name,a.preset_id,a.client_id,a.client,a.provider,a.model);}
function localHistory(a:any){return Array.isArray(a.local_capabilities?.history)?a.local_capabilities.history:[];}
function currentEvidence(a:any){return localHistory(a).filter((e:any)=>e.machine_id===onboardingMachineId()).sort((a:any,b:any)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));}
function stale(e:any){return !e||!Number.isFinite(Date.parse(e.observed_at))||Date.now()-Date.parse(e.observed_at)>86400000;}
function projectedEvidence(a:any){
  const history=currentEvidence(a),latest=history.at(-1);
  // A diagnostic observes one route, never a replacement capability catalog.
  const catalog=history.findLast((e:any)=>e.source==='client_models'||e.source==='client_config'),catalogIndex=catalog?history.indexOf(catalog):-1;
  const models=new Map<string,any>(),key=(m:any)=>JSON.stringify([m.id,m.provider??null]);
  const project=(m:any,e:any)=>({...m,source:e.source,observed_at:e.observed_at,client_id:e.client_id,client_version:e.client_version??null,evidence_state:stale(e)?'stale':'fresh'});
  for(const m of catalog?.models||[])models.set(key(m),project(m,catalog));
  for(const e of history.slice(catalogIndex+1)){
    if(e.source!=='invocation')continue;
    for(const m of e.models||[]){const previous=models.get(key(m));models.set(key(m),{...project(m,e),name:m.name||previous?.name||m.id});}
  }
  // Manual-only web entries remain useful without claiming client discovery.
  if(!catalog&&!models.size&&latest?.source==='manual')for(const m of latest.models||[])models.set(key(m),project(m,latest));
  return {history,latest,models:[...models.values()]};
}
function registeredModels(a:any,history:any[]){
  return (a.model_group?.models||[]).filter((m:any)=>!isOnboardingClaude(m.id,m.name,m.provider)).map((m:any)=>{
    const invocation=history.findLast((e:any)=>e.source==='invocation'&&e.models?.some((observed:any)=>observed.id===m.id&&(observed.provider??null)===(m.provider??null)&&observed.status==='invocation_verified'));
    const verified=invocation&&!stale(invocation);
    return {...m,source:verified?'invocation':'team_registration',registration_source:'team_registration',status:verified?'invocation_verified':'configured',observed_at:verified?invocation.observed_at:null,registered_at:a.model_group?.registration_updated_at||null,...(invocation?{last_invocation_at:invocation.observed_at}:{}),evidence_state:verified?'fresh':'not_invocation_verified'};
  });
}
export function listOnboardingTeam(wb:Workbench){
  return {machine_id:onboardingMachineId(),agents:wb.all('agents').filter(a=>!a.archived).map(a=>{
    if(excluded(a))return {agent_id:a.id,name:a.name,status:'skipped',reason:'按用户要求跳过 Claude，不读取客户端资料',models:[],registered_models:[]};
    const {history,latest,models}=projectedEvidence(a);
    return {agent_id:a.id,name:a.name,preferred_model:typeof a.model==='string'&&!isOnboardingClaude(a.model)?a.model:null,status:latest?(stale(latest)?'stale':latest.models.length?'recorded':'unknown'):'unknown',reason:latest?.reason||null,client_id:latest?.client_id||null,client_version:latest?.client_version||null,observed_at:latest?.observed_at||null,source:latest?.source||null,
      models,registered_models:registeredModels(a,history),manual_models:(a.model_group?.models||[]).filter((m:any)=>!isOnboardingClaude(m.id,m.name,m.provider)),evidence_count:history.length};
  })};
}
/** Brief planning view prioritizes team registration; advertised catalogs remain references. */
export function compactOnboardingTeam(team:ReturnType<typeof listOnboardingTeam>){
  return {machine_id:team.machine_id,guidance:'优先团队 preferred_model 与明确登记的 models，沿用精确 id/provider及大小写后缀；名称不是调用 ID。team_registration/configured仅代表团队选择，不代表实测成功。原生advertised目录只作参考计数，不能自动灌入任务选项；未知或过期不阻断普通工作流。',agents:team.agents.map(a=>({agent_id:a.agent_id,preferred_model:'preferred_model' in a?a.preferred_model:null,status:a.status,...('reason' in a&&a.reason?{reason:a.reason}:{}),...('client_id' in a?{client_id:a.client_id,client_version:a.client_version,source:a.source,observed_at:a.observed_at}:{}),models:a.registered_models.map((m:any)=>({id:m.id,...(m.name?{name:m.name}:{}),...(m.provider?{provider:m.provider}:{}),status:m.status,source:m.source,observed_at:m.observed_at,registered_at:m.registered_at,evidence_state:m.evidence_state})),advertised_reference_count:a.models.length}))};
}
export function recordOnboardingModels(wb:Workbench,input:unknown,actor:string){return recordModels(wb,input,actor,false);}
// Only the internal diagnostic executor may call this; never expose it as an MCP mutation.
export function recordOnboardingInvocation(wb:Workbench,input:unknown,actor:string){return recordModels(wb,input,actor,true);}
function recordModels(wb:Workbench,input:unknown,actor:string,internalInvocation:boolean){
  const v=onboardingModelsInput.parse(input);assert(typeof actor==='string'&&actor.trim().length>0,'必须记录实际操作者');
  assert(v.machine_id===onboardingMachineId(),'不能把其他机器的证据登记为本机能力');
  assert(Date.parse(v.observed_at)<=Date.now()+60000,'证据时间不能在未来');
  assert(!isOnboardingClaude(v.agent_id,v.client_id,...v.models.flatMap(m=>[m.id,m.name,m.provider])),'本次初始化明确跳过 Claude / Anthropic，不读取或更新模型');
  assert(internalInvocation||v.source!=='invocation'&&!v.models.some(m=>m.status==='invocation_verified'),'真实调用验证只能由内部诊断记录');
  assert(v.models.every(m=>m.status!=='invocation_verified'||v.source==='invocation'),'调用验证必须来自实际调用证据');
  assert(v.models.every(m=>m.status!=='configured'||['client_config','invocation','manual'].includes(v.source)),'配置状态必须来自配置或调用证据');
  const keys=v.models.map(m=>JSON.stringify([m.id,m.provider??null]));assert(new Set(keys).size===keys.length,'重复的原生模型 ID/provider');
  return wb.transaction(()=>{
    const old=wb.get('agents',v.agent_id);assert(!excluded(old),'本次初始化跳过 Claude 成员');
    const at=now(),conflicts:any[]=[],models=[...(old.model_group?.models||[])],added:string[]=[],seen=new Map<string,any>();
    for(const m of v.models){
      const previous=seen.get(m.id);if(previous&&(previous.provider??null)!==(m.provider??null))conflicts.push({id:m.id,existing:previous,observed:m,resolution:'evidence_only_provider_conflict'});seen.set(m.id,m);
      const existing=models.find(x=>x.id===m.id);
      if(existing){if(existing.name!==(m.name||m.id)||(existing.provider??null)!==(m.provider??null))conflicts.push({id:m.id,existing:{name:existing.name,provider:existing.provider??null},observed:{name:m.name||m.id,provider:m.provider??null},resolution:'preserved_existing'});continue;}
      // Enumeration and invocation are evidence, never implicit team model registration.
    }
    const evidence={...v,actor,recorded_at:at,conflicts};
    const row={...old,version:(old.version||0)+1,updated_at:at,local_capabilities:{...(old.local_capabilities||{}),schema_version:1,history:[...localHistory(old),evidence]}};
    wb.put('agents',row);wb.audit(actor,'record_onboarding_models',old.id,{machine_id:v.machine_id,client_id:v.client_id,client_version:v.client_version??null,source:v.source,observed_at:v.observed_at,added,conflicts,evidence});
    return {agent_id:old.id,status:'recorded',added,conflicts,evidence};
  });
}
// Advisory only: never rewrite the requested native ID, provider, case, or suffix.
export function resolveOnboardingModel(wb:Workbench,agent_id:string,requested_model:string,provider?:string){
  const a=wb.get('agents',agent_id),base={agent_id,requested_model,...(provider!==undefined?{provider}:{}),blocking:false};
  if(excluded(a)||isOnboardingClaude(requested_model,provider))return {...base,status:'skipped',candidates:[]};
  const {latest,models,history}=projectedEvidence(a),registered=registeredModels(a,history),candidates=[...registered,...models.filter((m:any)=>!registered.some((r:any)=>r.id===m.id&&(r.provider??null)===(m.provider??null)))].filter((m:any)=>!isOnboardingClaude(m.id,m.name,m.provider));
  if(!registered.length&&stale(latest))return {...base,status:latest?'stale':'unknown',candidates,reason:'没有新鲜的本机证据，候选仅供参考'};
  const exactMatches=candidates.filter((m:any)=>m.id===requested_model);
  if(provider===undefined&&exactMatches.length>1)return {...base,status:'provider_requires_explicit_choice',candidates:exactMatches,reason:'同一原生 ID 有多个 provider，请明确路由'};
  const match=candidates.find((m:any)=>m.id===requested_model&&(provider===undefined||m.provider===provider));
  if(match)return {...base,status:match.source==='team_registration'?'configured':stale(match)?'stale':match.source==='manual'?'manual':match.status,candidates:[match],observed_at:match.observed_at};
  const aliases=candidates.filter((m:any)=>(m.name===requested_model||m.id!==requested_model&&m.id.toLowerCase()===requested_model.toLowerCase())&&(provider===undefined||m.provider===provider));
  return {...base,status:aliases.length?'alias_requires_explicit_id':candidates.length?'not_observed':'unknown',candidates:aliases.length?aliases:candidates,reason:aliases.length?'展示名称或大小写与原生 ID 不同；请明确选择候选 ID':'未有当前本机精确匹配证据；此提示不阻止普通工作流'};
}

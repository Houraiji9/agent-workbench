import path from 'node:path';
import type {Row} from './schema.ts';

export const tokenPeriods=['today','month','allTime'] as const;
export type TokenPeriod=typeof tokenPeriods[number];
const metricFields={total_tokens:'totalTokens',input_tokens:'inputTokens',output_tokens:'outputTokens',cache_read_tokens:'cacheReadTokens',cache_write_tokens:'cacheWriteTokens',reasoning_tokens:'reasoningTokens',cost_usd:'costUsd'} as const;
export type TokenMetrics=Record<keyof typeof metricFields,number|null>;
type Session={key:string;client:string;session_id:string;device_id:string;started_at:string|null;last_used_at:string|null;metrics:TokenMetrics;models:Record<string,number>;model_costs:Record<string,number>;cwd?:string};
type Window={device_id:string;key:string|null;ends_at:string|null;time_zone:string|null;stale:boolean};
type Period={available:boolean;rows:Session[];invalid_sessions:number;truncated_sessions:number;windows:Window[]};
export type TokenMonitorDetails={version:1;updated_at:string|null;projects_incomplete:boolean;periods:Record<TokenPeriod,Period>};
export type TokenMonitorProjectUsage={source:'token_monitor';status:string;updated_at:string|null;note:string;periods:Record<TokenPeriod,{available:boolean;total_sessions:number;matched_sessions:number;unassigned_sessions:number;ambiguous_sessions:number;invalid_sessions:number;summary:TokenMetrics;rows:(Session&{association:string;task_ids:string[]})[];models:Record<string,number>;windows:Window[];note:string}>};
const obj=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=1000&&!/[\x00-\x1f\x7f]/.test(x);
const date=(x:unknown)=>typeof x==='string'&&Number.isFinite(Date.parse(x))?x:null;
const number=(v:unknown,cost=false):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&(cost||Number.isSafeInteger(v));
const empty=():TokenMetrics=>Object.fromEntries(Object.keys(metricFields).map(k=>[k,null])) as TokenMetrics;
const numbers=(input:unknown,cost=false)=>obj(input)?Object.fromEntries(Object.entries(input).filter(([k,v])=>text(k)&&number(v,cost))):{};
const canonical=(client:string,id:string)=>client==='codex'?id.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([a-f0-9-]{36})$/i)?.[1]?.toLowerCase()||id.toLowerCase():id;

/** Keep device/session/period identities; never add the aggregate and per-device copies. */
export function normalizeTokenMonitorDetails(raw:unknown):TokenMonitorDetails {
  const source=obj(raw)?raw:{};
  const make=():Period=>({available:false,rows:[],invalid_sessions:0,truncated_sessions:0,windows:[]});
  const periods:Record<TokenPeriod,Period>={today:make(),month:make(),allTime:make()};
  const devices=Array.isArray(source.devices)&&source.devices.length?source.devices:[{deviceId:'aggregate',periods:source.periods,updatedAt:source.updatedAt}];
  for(const device of devices){
    if(!obj(device)||!text(device.deviceId))continue;
    for(const p of tokenPeriods){
      const period=periods[p],data=device.periods?.[p],window=device.periodWindows?.[p];
      if(!obj(data)||!obj(data.sessions))continue;
      period.windows.push({device_id:device.deviceId,key:text(window?.key)?window.key:null,ends_at:date(window?.endsAt),time_zone:text(device.periodWindows?.timeZone)?device.periodWindows.timeZone:null,stale:device.stale===true});
      // An empty allTime map is a real source limitation, not zero lifetime usage.
      period.available ||= Object.keys(data.sessions).length>0;
      period.truncated_sessions += Math.max(0,Object.keys(data.sessions).length-10000);
      for(const s of Object.values(data.sessions).slice(0,10000)){
        if(!obj(s)||!text(s.client)||!text(s.sessionId)){period.invalid_sessions++;continue;}
        const metrics=empty();let invalid=false;
        for(const [key,field] of Object.entries(metricFields))if(s[field]!=null){if(!number(s[field],key==='cost_usd'))invalid=true;else metrics[key as keyof TokenMetrics]=s[field];}
        if(invalid){period.invalid_sessions++;continue;}
        const native=text(s.nativeSessionId)?s.nativeSessionId:s.sessionId,id=canonical(s.client,native);
        if(text(s.nativeSessionId)&&id!==canonical(s.client,s.sessionId)){period.invalid_sessions++;continue;}
        const row:Session={key:JSON.stringify([device.deviceId,s.client,id]),client:s.client,session_id:id,device_id:device.deviceId,started_at:date(s.startedAt),last_used_at:date(s.lastUsedAt),metrics,models:numbers(s.models),model_costs:numbers(s.modelCosts,true)};
        if(text(s.cwd))row.cwd=s.cwd;
        period.rows.push(row);
      }
    }
  }
  return {version:1,updated_at:date(source.updatedAt)||date(source.generatedAt),projects_incomplete:source.projectsIncomplete===true,periods};
}
const agentClient=(id:unknown,agents:Row[])=>{
  const preset=agents.find(a=>a.id===id)?.preset_id||id;
  return ({codex:'codex',dsh:'dsh',deepseek:'dsh',claude:'claude','claude-code':'claude',cursor:'cursor',grok:'grok','grok-build':'grok'} as Record<string,string>)[String(preset)];
};
const pathKey=(s:string)=>path.resolve(s).replaceAll('\\','/').toLowerCase().replace(/\/$/,'');

/** This is a separate session view. It must not be added to the overlapping Job ledger. */
export function projectTokenMonitorUsage(integration:Row|undefined,projectId:string,context:{sessions:Row[];jobs:Row[];projects:Row[];agents:Row[];delegations?:Row[]},observedAt=Date.now()):TokenMonitorProjectUsage {
  const detail=integration?.snapshot?.usage_details as TokenMonitorDetails|undefined;
  const bindings=new Map<string,{projects:Set<string>;tasks:Set<string>}>();
  const add=(client:string|undefined,id:unknown,projects:unknown[],tasks:unknown[])=>{
    if(!client||!text(id))return;const key=JSON.stringify([client,canonical(client,id)]),b=bindings.get(key)||{projects:new Set<string>(),tasks:new Set<string>()};
    for(const p of projects)if(text(p))b.projects.add(p);for(const t of tasks)if(text(t))b.tasks.add(t);bindings.set(key,b);
  };
  for(const s of context.sessions){const bs=Array.isArray(s.bindings)?s.bindings:[];add(agentClient(s.agent,context.agents),s.native_id,[s.project_id,...(s.project_ids||[]),...bs.map((b:Row)=>b.project_id)],bs.map((b:Row)=>b.task_id));}
  for(const j of context.jobs)add(j.client||j.client_kind||j.route?.client,j.session_id,[j.project_id],[j.task_id]);
  for(const d of context.delegations||[])add(agentClient(d.agent_id,context.agents),d.session_id,[d.project_id],[d.task_id]);
  const periods={} as TokenMonitorProjectUsage['periods'];
  for(const p of tokenPeriods){
    const input=detail?.periods?.[p],summary=empty(),rows:TokenMonitorProjectUsage['periods'][TokenPeriod]['rows']=[],models:Record<string,number>={};
    let ambiguous=0,unassigned=0,expired=0,invalid=input?.invalid_sessions||0;
    const windows=(input?.windows||[]).map(w=>({...w,stale:w.stale||!!w.ends_at&&Date.parse(w.ends_at)<=observedAt}));
    const expiredDevices=new Set((input?.windows||[]).filter(w=>w.ends_at&&Date.parse(w.ends_at)<=observedAt).map(w=>w.device_id));
    const unique=new Map<string,Session>(),conflicts=new Set<string>(),devices=new Map<string,Set<string>>();
    for(const s of input?.rows||[]){
      const prev=unique.get(s.key);if(prev&&JSON.stringify(prev)!==JSON.stringify(s))conflicts.add(s.key);else unique.set(s.key,s);
      const id=JSON.stringify([s.client,s.session_id]),set=devices.get(id)||new Set<string>();set.add(s.device_id);devices.set(id,set);
    }
    for(const s of unique.values()){
      if(conflicts.has(s.key)){invalid++;continue;}
      if(expiredDevices.has(s.device_id)){expired++;continue;}
      const id=JSON.stringify([s.client,s.session_id]);
      if((devices.get(id)?.size||0)>1){ambiguous++;continue;}
      const bound=bindings.get(id);let projectIds=bound?.projects||new Set<string>(),association='exact_registered_session';
      // Only a source-provided literal cwd may be matched; labels and opaque hashes are not paths.
      if(!projectIds.size&&s.cwd){projectIds=new Set(context.projects.filter(x=>[...(x.paths||[]),x.source_root,x.runtime_root].filter(text).some((f:string)=>pathKey(f)===pathKey(s.cwd!))).map(x=>x.id));association='exact_registered_cwd';}
      if(projectIds.size>1){ambiguous++;continue;}
      if(!projectIds.size){unassigned++;continue;}
      if(!projectIds.has(projectId))continue;
      rows.push({...s,association,task_ids:[...(bound?.tasks||[])].sort()});
      for(const metric of Object.keys(metricFields) as (keyof TokenMetrics)[])if(s.metrics[metric]!==null)summary[metric]=(summary[metric]??0)+s.metrics[metric]!;
      for(const [model,value] of Object.entries(s.models))models[model]=(models[model]||0)+value;
    }
    const coverageNote=(expired?` 有 ${expired} 个会话的来源窗口已结束，未计入当前范围。`:'')+(windows.some(w=>w.stale)?' 部分设备数据已过期；保留快照仅供追溯，不代表实时值。':'')+(input?.truncated_sessions?` 来源超过处理上限，另有 ${input.truncated_sessions} 个会话未处理，当前覆盖不完整。`:'');
    periods[p]={available:!!input?.available,total_sessions:unique.size+(input?.truncated_sessions||0),matched_sessions:rows.length,unassigned_sessions:unassigned,ambiguous_sessions:ambiguous,invalid_sessions:invalid,summary,rows,models,windows,note:(!input?.available?'来源未提供此时间范围的会话明细；不能将它解释为用量为零。':'只合计可唯一确认项目归属的会话。每个指标均为已报告小计，未报告的部分仍未知；同会话经手多个任务不会按次数重复累计。')+coverageNote};
  }
  return {source:'token_monitor',status:integration?.status||'not_connected',updated_at:detail?.updated_at||null,periods,note:'会话用量与下方工作台调用记录可能重叠，不能相加。模型名称及数字来自 Token Monitor 报告；API 等价估算不代表实际扣款。'+(detail?.projects_incomplete?' 来源报告项目采集不完整。':'')};
}

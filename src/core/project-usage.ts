import {createHash} from 'node:crypto';
import type {ParsedAgentOutput} from './agent-output.ts';

export const usageMetrics = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','total_tokens','cost_usd'] as const;
export type UsageMetric = typeof usageMetrics[number];
type Counts = Partial<Record<UsageMetric, number>>;
export type UsageEventInput = {
  source: string; job_id: string; event_id: string; project_id?: string; task_id?: string; run_id?: string; agent_id?: string;
  actual_model?: string; requested_model?: string; session_id?: string;
  scope_id: string; epoch: string; sequence: number; mode: 'incremental'|'cumulative';
  occurred_at: string; period_start?: string; scope_kind?: 'job'|'machine';
  parent_scope_id?: string; parent_job_id?: string; includes_children?: boolean;
  /** Same work reported by another source must use the same accounting key. */
  accounting_key?: string;
  identity_quality?: 'source_event_id'|'persisted_ordinal';
  aggregation_status?: 'ready'|'unresolved_scope';
  /** Legacy job summaries prove a known subtotal, never complete metric coverage. */
  coverage_quality?: 'legacy_summary_unknown';
  /** Only declare when the source contract confirms the relationship. Cache/reasoning are never blindly added. */
  total_semantics?: 'input_includes_cache'|'input_excludes_cache';
  usage: Partial<Record<UsageMetric, number|null>>;
};
export type UsageEvent = UsageEventInput & {id:string;schema_version:1;scope_kind:'job'|'machine';usage:Counts};
export type UsageJob = {id:string;project_id?:string;task_id?:string;run_id?:string;role?:string;phase?:string;agent_id?:string;actual_model?:string;requested_model?:string;parent_job_id?:string;started_at?:string;created_at?:string;ended_at?:string;status?:string;process_may_be_running?:boolean;session_id?:string;usage?:{scope?:string;inputTokens?:unknown;outputTokens?:unknown;cacheReadTokens?:unknown;cacheWriteTokens?:unknown;reasoningTokens?:unknown;totalTokens?:unknown;totalCostUsd?:unknown}};
export type UsageFilters = {project_id?:string;task_id?:string;agent_id?:string;model?:string;role?:string;from?:string;to?:string};
const validDate = (v:string) => Number.isFinite(Date.parse(v));
const key = (...values:unknown[]) => JSON.stringify(values);
const text = (v:unknown):v is string => typeof v==='string' && v.length>0 && v.length<=512 && !/[\x00-\x1f\x7f]/.test(v);
const ensure = (condition:unknown, message:string) => {if(!condition) throw new Error(message);};
// Closeout uses the execution client but is a distinct accounting stage. Keep the source fields
// intact: this projection is shared by event selection, coverage and inclusive-parent attribution.
const accountingRole = (job:UsageJob) => job.phase==='closeout'?'closeout':job.role;

/** Creates a whitelisted immutable ledger row. Event IDs must survive replay; never use receipt time. */
export function createUsageEvent(input:UsageEventInput):UsageEvent {
  for(const name of ['source','job_id','event_id','scope_id','epoch'] as const) ensure(text(input[name]),'用量事件缺少稳定标识：'+name);
  ensure(['incremental','cumulative'].includes(input.mode),'用量模式无效');
  ensure(Number.isSafeInteger(input.sequence)&&input.sequence>=0,'用量顺序无效');
  ensure(validDate(input.occurred_at),'用量时间无效');
  if(input.period_start!==undefined)ensure(validDate(input.period_start)&&Date.parse(input.period_start)<=Date.parse(input.occurred_at),'用量区间无效');
  if(input.scope_kind!==undefined)ensure(['job','machine'].includes(input.scope_kind),'用量归属无效');
  if(input.total_semantics!==undefined)ensure(['input_includes_cache','input_excludes_cache'].includes(input.total_semantics),'Token 语义无效');
  if(input.includes_children!==undefined)ensure(typeof input.includes_children==='boolean','父级用量标识无效');
  const usage:Counts={};
  for(const metric of usageMetrics){const value=input.usage?.[metric];if(value==null)continue;ensure(typeof value==='number'&&Number.isFinite(value)&&value>=0&&(metric==='cost_usd'||Number.isSafeInteger(value)),'用量值无效：'+metric);usage[metric]=value;}
  const row:UsageEvent={id:'UE-'+createHash('sha256').update(key(input.source,input.job_id,input.event_id)).digest('hex'),schema_version:1,source:input.source,job_id:input.job_id,event_id:input.event_id,scope_id:input.scope_id,epoch:input.epoch,sequence:input.sequence,mode:input.mode,occurred_at:input.occurred_at,scope_kind:input.scope_kind||'job',usage};
  for(const field of ['project_id','task_id','run_id','agent_id','actual_model','requested_model','session_id','parent_scope_id','parent_job_id','accounting_key'] as const)if(input[field]!==undefined){ensure(text(input[field]),'用量字段无效：'+field);row[field]=input[field];}
  if(input.period_start!==undefined)row.period_start=input.period_start;
  if(input.includes_children!==undefined)row.includes_children=input.includes_children;
  if(input.total_semantics!==undefined)row.total_semantics=input.total_semantics;
  if(input.identity_quality!==undefined){ensure(['source_event_id','persisted_ordinal'].includes(input.identity_quality),'事件标识质量无效');row.identity_quality=input.identity_quality;}
  if(input.aggregation_status!==undefined){ensure(['ready','unresolved_scope'].includes(input.aggregation_status),'用量范围状态无效');row.aggregation_status=input.aggregation_status;}
  if(input.coverage_quality!==undefined){ensure(input.coverage_quality==='legacy_summary_unknown','用量覆盖质量无效');row.coverage_quality=input.coverage_quality;}
  return row;
}
/** Read-time compatibility projection. Any job ledger receipt takes precedence, even if it is
 * invalid, empty or outside the eventual filters. Never backfill individual metrics or persist
 * these virtual rows. Historical summaries cannot prove that every invocation was measured.
 */
export function withLegacyJobUsage(raw:UsageEventInput[],jobs:UsageJob[]):UsageEventInput[] {
  const result=[...raw],metered=new Set(raw.filter(e=>e.scope_kind!=='machine').map(e=>e.job_id));
  for(const job of jobs){
    const summary=job.usage,start=job.started_at||job.created_at,end=job.ended_at;
    if(metered.has(job.id)||!text(job.id)||!text(job.project_id)||!text(job.task_id)||!text(job.run_id)||job.process_may_be_running===true||!['completed','failed','interrupted'].includes(job.status||''))continue;
    if(!summary||!['invocation_steps','reported_total'].includes(summary.scope||'')||!start||!end||!validDate(start)||!validDate(end)||Date.parse(start)>Date.parse(end))continue;
    const usage:Counts={};
    for(const [metric,field] of [['input_tokens','inputTokens'],['output_tokens','outputTokens'],['cache_read_tokens','cacheReadTokens'],['cache_write_tokens','cacheWriteTokens'],['reasoning_tokens','reasoningTokens'],['total_tokens','totalTokens'],['cost_usd','totalCostUsd']] as const){
      const value=summary[field];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&(metric==='cost_usd'||Number.isSafeInteger(value)))usage[metric]=value;
    }
    if(!Object.keys(usage).length)continue;
    const event:UsageEventInput={source:'legacy:job_summary',job_id:job.id,project_id:job.project_id,event_id:'summary',scope_id:'job:'+job.id,epoch:job.id,sequence:0,mode:'cumulative',occurred_at:end,period_start:start,scope_kind:'job',coverage_quality:'legacy_summary_unknown',usage};
    for(const field of ['task_id','run_id','agent_id','actual_model','requested_model','session_id'] as const)if(text(job[field]))event[field]=job[field];
    result.push(createUsageEvent(event));metered.add(job.id);
  }
  return result;
}
export type UsageStore={maybe(table:string,id:string):Record<string,any>|undefined;put(table:string,row:Record<string,any>,refs?:Record<string,any>):unknown};
export function recordUsageEvent(store:UsageStore,input:UsageEventInput){
  const event=createUsageEvent(input),old=store.maybe('usage_events',event.id);
  if(old){ensure(JSON.stringify(createUsageEvent(old as UsageEventInput))===JSON.stringify(event),'相同用量事件标识的内容冲突');return {event:old as UsageEvent,inserted:false};}
  store.put('usage_events',event,event.run_id?{run_id:event.run_id}:{});return {event,inserted:true};
}
/** Persist ordinal together with the launched job. A synthesized ordinal is not a provider event ID:
 * changing ordinals during a replay prevents deduplication. Keep the original at timestamp too.
 * message_delta needs usage_message_id retained from the previous message_start by the caller.
 */
export function usageInputFromOutput(job:UsageJob&{client_kind?:string;client?:string;usage_message_id?:string;session_id?:string},output:ParsedAgentOutput,ordinal:number,at:string):UsageEventInput|null {
  if(!output.recognized||!output.usage)return null;
  const messageId=output.messageId||job.usage_message_id;
  ensure(Number.isSafeInteger(ordinal)&&ordinal>=0,'用量输出序号无效');
  const startOrComplete=output.usage.scope==='message'&&['message_start','message'].includes(output.eventType||'')&&!!output.messageId;
  const usage:UsageEventInput['usage']={};
  for(const [target,from] of [['input_tokens','inputTokens'],['output_tokens','outputTokens'],['cache_read_tokens','cacheReadTokens'],['cache_write_tokens','cacheWriteTokens'],['total_tokens','totalTokens'],['cost_usd','totalCostUsd']] as const){const value=output.usage[from];if(value!==undefined)usage[target]=value;}
  const input:UsageEventInput={source:'client:'+(job.client_kind||job.client||'unknown'),job_id:job.id,event_id:startOrComplete?key(messageId,output.eventType):'ordinal:'+ordinal,identity_quality:startOrComplete?'source_event_id':'persisted_ordinal',aggregation_status:output.usage.scope==='message'&&!messageId?'unresolved_scope':'ready',scope_id:output.usage.scope==='message'?'message:'+(messageId||'unresolved'):'job:'+job.id,epoch:job.id,sequence:ordinal,mode:output.usage.scope==='step'?'incremental':'cumulative',occurred_at:at,usage};
  for(const field of ['project_id','task_id','run_id','agent_id','requested_model'] as const)if(job[field])input[field]=job[field];
  input.actual_model=output.model||job.actual_model;input.session_id=output.sessionId||job.session_id;
  if(output.usage.scope!=='step'&&(job.client_kind==='claude'||job.client==='claude'||output.eventType==='message_start'||output.eventType==='message'||output.eventType==='message_delta'))input.total_semantics='input_excludes_cache';
  return input;
}
function counts(event:UsageEvent):Counts {
  const value={...event.usage};
  if(value.total_tokens===undefined&&value.input_tokens!==undefined&&value.output_tokens!==undefined&&event.total_semantics){
    if(event.total_semantics==='input_includes_cache')value.total_tokens=value.input_tokens+value.output_tokens;
    else if(value.cache_read_tokens!==undefined&&value.cache_write_tokens!==undefined)value.total_tokens=value.input_tokens+value.output_tokens+value.cache_read_tokens+value.cache_write_tokens;
  }
  return value;
}
type Contribution={event:UsageEvent;metric:UsageMetric;value:number;start?:string;end:string};
const sourceRank=(source:string)=>source.startsWith('client:')?0:['job','native'].includes(source)?1:2;
const compareSources=(a:string,b:string)=>sourceRank(a)-sourceRank(b)||(a<b?-1:a>b?1:0);
/** Replay every event before applying date filters so cumulative checkpoints cannot be added twice.
 * A decreasing checkpoint is invalid within an epoch. Start a new explicit epoch after a reset.
 * Bounded reports omit contributions straddling their boundary and expose them as unknown.
 */
export function aggregateProjectUsage(raw:UsageEventInput[],jobs:UsageJob[]=[],filters:UsageFilters={}) {
  for(const field of ['from','to'] as const)if(filters[field])ensure(validDate(filters[field]!),'筛选时间无效');
  ensure(!filters.from||!filters.to||Date.parse(filters.from)<=Date.parse(filters.to),'筛选区间无效');
  const issues:{event_id:string;reason:string}[]=[],dedup=new Map<string,UsageEvent>(),reported:UsageEvent[]=[];
  for(const input of raw){try{const event=createUsageEvent(input),previous=dedup.get(event.id);reported.push(event);if(previous&&JSON.stringify(previous)!==JSON.stringify(event)){issues.push({event_id:event.id,reason:'duplicate_conflict'});dedup.delete(event.id);}else if(!issues.some(i=>i.event_id===event.id&&i.reason==='duplicate_conflict'))dedup.set(event.id,event);}catch{issues.push({event_id:String(input.event_id||''),reason:'invalid_event'});}}
  const jobMap=new Map(jobs.map(j=>[j.id,j])),events=[...dedup.values()],groups=new Map<string,UsageEvent[]>();
  const matches=(j:Omit<UsageJob,'usage'>)=> (!filters.project_id||j.project_id===filters.project_id)&&(!filters.task_id||j.task_id===filters.task_id)&&(!filters.agent_id||j.agent_id===filters.agent_id)&&(!filters.model||j.actual_model===filters.model)&&(!filters.role||accountingRole(j)===filters.role);
  const bindingConflict=(event:UsageEvent)=>{const job=jobMap.get(event.job_id);return !!job&&(['project_id','task_id','agent_id'] as const).some(k=>event[k]&&job[k]&&event[k]!==job[k]);};
  const eligible=(event:UsageEvent)=>event.scope_kind==='job'&&event.aggregation_status!=='unresolved_scope'&&!bindingConflict(event);
  const meteringKey=(event:UsageEvent)=>key(event.job_id,event.accounting_key);
  // An explicit accounting key identifies the same call within a job, even if providers use
  // different scopes, epochs or sequence numbers. Select one whole source before filtering or
  // metric replay. Never fill a primary source's gaps with overlapping secondary measurements.
  // The order is deterministic provenance preference, not a claim that the source is complete.
  const meters=new Map<string,{job_id:string;accounting_key:string;primary_source:string;sources:string[]}>();
  for(const event of reported)if(event.accounting_key&&eligible(event)){const id=meteringKey(event),meter=meters.get(id)||{job_id:event.job_id,accounting_key:event.accounting_key,primary_source:event.source,sources:[]};if(!meter.sources.includes(event.source)){meter.sources.push(event.source);meter.sources.sort(compareSources);meter.primary_source=meter.sources[0];}meters.set(id,meter);}
  const primarySource=(event:UsageEvent)=>event.accounting_key?meters.get(meteringKey(event))?.primary_source||event.source:event.source;
  const isPrimary=(event:UsageEvent)=>event.source===primarySource(event);
  const primaryEvents=events.filter(event=>eligible(event)&&isPrimary(event));
  const from=filters.from?Date.parse(filters.from):-Infinity,to=filters.to?Date.parse(filters.to):Infinity;
  const inPeriod=(j:UsageJob)=>{const start=j.started_at||j.created_at;return (!start||Date.parse(start)<=to)&&(!j.ended_at||Date.parse(j.ended_at)>=from);};
  for(const event of events){const job=jobMap.get(event.job_id);if(event.scope_kind==='machine')continue;
    if(event.aggregation_status==='unresolved_scope'){issues.push({event_id:event.id,reason:'unresolved_message_scope'});continue;}
    if(bindingConflict(event)){issues.push({event_id:event.id,reason:'job_binding_conflict'});continue;}
    const metadata={...job,...event,id:event.job_id};if(!matches(metadata))continue;
    if(!isPrimary(event))issues.push({event_id:event.id,reason:'secondary_usage_source'});
    // Source-local counters must never share sequence/checkpoint state with another source.
    const group=key(event.job_id,event.accounting_key||event.source,event.source,event.scope_id,event.epoch);const list=groups.get(group)||[];list.push(event);groups.set(group,list);
  }
  const contributions:Contribution[]=[],knownJobs=new Set<string>(),selectedJobs=new Map(jobs.filter(j=>matches(j)&&inPeriod(j)).map(j=>[j.id,j]));
  const missing: {job_id:string;metric:UsageMetric;event_id:string}[]=[];
  for(const list of groups.values()){
    list.sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));
    const state:Counts={},lastTime:Partial<Record<UsageMetric,string>>={};const seenSequence=new Set<number>();
    // Sparse cumulative checkpoints update counters within this one source/scope/epoch.
    // Derive from accepted counters after replay, never from a frozen message_start total.
    // Mixed incremental streams retain their per-event derivation: missing increments cannot
    // be repaired by carrying an earlier component forward as if it had stayed unchanged.
    const replayTotals=list.every(e=>e.mode==='cumulative')&&list.some(e=>e.total_semantics);
    const components=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'] as const;
    const componentSemantics:Partial<Record<typeof components[number],UsageEvent['total_semantics']>>={};
    const contributionStart=contributions.length;
    let staleTotal:UsageEvent|undefined;
    for(const event of list){if(seenSequence.has(event.sequence)){issues.push({event_id:event.id,reason:'sequence_conflict'});continue;}seenSequence.add(event.sequence);
      const job=jobMap.get(event.job_id),values=replayTotals?{...event.usage}:counts(event);if(Date.parse(event.occurred_at)>=from&&Date.parse(event.occurred_at)<=to)selectedJobs.set(event.job_id,{...job,...event,usage:job?.usage,id:event.job_id});
      const componentUpdate=components.some(metric=>values[metric]!==undefined);
      let invalidComponent=false;
      for(const metric of usageMetrics){let current=values[metric];
        if(metric==='total_tokens'&&replayTotals){
          if(componentUpdate&&Date.parse(event.occurred_at)<=to)staleTotal=event;
          if(current===undefined&&componentUpdate&&event.total_semantics&&!invalidComponent){
            const required:readonly (typeof components[number])[]=event.total_semantics==='input_includes_cache'?components.slice(0,2):components;
            if(required.every(part=>state[part]!==undefined&&componentSemantics[part]===event.total_semantics)){
              const total=required.reduce<number>((sum,part)=>sum+state[part]!,0);
              if(Number.isSafeInteger(total))current=total;
            }
          }
        }
        if(current===undefined)continue;
        const previous=state[metric]||0;if(event.mode==='cumulative'&&current<previous){issues.push({event_id:event.id,reason:'counter_regression:'+metric});if(components.includes(metric as typeof components[number])){invalidComponent=true;delete componentSemantics[metric as typeof components[number]];}continue;}
        const amount=event.mode==='incremental'?current:current-previous;
        const start=event.period_start||lastTime[metric]||(event.mode==='cumulative'?(job?.started_at||job?.created_at):event.occurred_at);
        if(start&&Date.parse(start)>Date.parse(event.occurred_at)){issues.push({event_id:event.id,reason:'time_regression:'+metric});if(components.includes(metric as typeof components[number])){invalidComponent=true;delete componentSemantics[metric as typeof components[number]];}continue;}
        state[metric]=event.mode==='incremental'?previous+current:current;lastTime[metric]=event.occurred_at;
        if(components.includes(metric as typeof components[number]))componentSemantics[metric as typeof components[number]]=event.total_semantics;
        if(metric==='total_tokens'&&Date.parse(event.occurred_at)<=to)staleTotal=undefined;
        if(Date.parse(event.occurred_at)<from||Date.parse(event.occurred_at)>to)continue;
        if(filters.from&&(!start||Date.parse(start)<from)){issues.push({event_id:event.id,reason:'unknown_time_boundary:'+metric});continue;}
        contributions.push({event,metric,value:amount,start,end:event.occurred_at});
      }
    }
    // A partial update without enough components makes an earlier explicit total stale too.
    // Do not expose that checkpoint as this scope's current total or complete coverage.
    if(staleTotal){for(let i=contributions.length-1;i>=contributionStart;i--)if(contributions[i].metric==='total_tokens')contributions.splice(i,1);if(isPrimary(staleTotal)&&Date.parse(staleTotal.occurred_at)>=from)missing.push({job_id:staleTotal.job_id,metric:'total_tokens',event_id:staleTotal.id});}
    // A later cumulative checkpoint can fill an earlier missing increment, metric by metric.
    if(isPrimary(list[0]))for(const metric of usageMetrics){const checkpoints=list.filter(e=>e.mode==='cumulative'&&counts(e)[metric]!==undefined);const lastCheckpoint=checkpoints.at(-1)?.sequence??-1;
      for(const event of list)if(event.mode==='incremental'&&event.sequence>lastCheckpoint&&counts(event)[metric]===undefined&&Date.parse(event.occurred_at)>=from&&Date.parse(event.occurred_at)<=to)missing.push({job_id:event.job_id,metric,event_id:event.id});
    }
  }
  const trace=contributions.map(c=>({...c,event_id:c.event.id,job_id:c.event.job_id,source:c.event.source,scope_id:c.event.scope_id,epoch:c.event.epoch,accounting_key:c.event.accounting_key||null,primary_source:primarySource(c.event),included:isPrimary(c.event),reason:isPrimary(c.event)?(c.event.coverage_quality==='legacy_summary_unknown'?'legacy_summary_known_subtotal':'known_usage'):'secondary_usage_source'}));
  // An inclusive parent cannot be attributed to one model/task/agent when its explicitly linked
  // child belongs outside the selected filter. Keep the receipt visible but omit that subtotal.
  for(const item of trace)if(item.included&&item.event.includes_children&&primaryEvents.some(e=>e.parent_scope_id===item.scope_id&&(e.parent_job_id||e.job_id)===item.job_id&&e.epoch===item.epoch&&(e.accounting_key||e.source)===(item.event.accounting_key||item.source)&&!matches({...jobMap.get(e.job_id),...e,id:e.job_id}))){item.included=false;item.reason='unattributable_parent_filter';issues.push({event_id:item.event_id,reason:'unattributable_parent_filter:'+item.metric});}
  // Inclusive parent suppresses only the covered metric and interval, never an unrelated scope/epoch.
  for(const item of trace){if(!item.included)continue;let ancestor=item.event.parent_scope_id,ancestorJob=item.event.parent_job_id||item.job_id;const seen=new Set([key(item.job_id,item.scope_id)]);while(ancestor&&!seen.has(key(ancestorJob,ancestor))){seen.add(key(ancestorJob,ancestor));const parent=trace.filter(p=>p.job_id===ancestorJob&&(p.event.accounting_key||p.source)===(item.event.accounting_key||item.source)&&p.epoch===item.epoch&&p.scope_id===ancestor&&p.metric===item.metric&&p.event.includes_children&&p.included&&Date.parse(p.end)>=Date.parse(item.end)&&p.start&&item.start&&Date.parse(p.start)<=Date.parse(item.start));
      if(parent.length){item.included=false;item.reason='included_in_parent';break;}
      const ancestorEvent=primaryEvents.find(e=>e.job_id===ancestorJob&&e.epoch===item.epoch&&e.scope_id===ancestor&&(e.accounting_key||e.source)===(item.event.accounting_key||item.source));ancestor=ancestorEvent?.parent_scope_id;ancestorJob=ancestorEvent?.parent_job_id||ancestorJob;
    }}
  const subtotal:Record<UsageMetric,number|null>=Object.fromEntries(usageMetrics.map(m=>[m,null])) as Record<UsageMetric,number|null>;
  const covered=new Map<UsageMetric,Set<string>>(usageMetrics.map(m=>[m,new Set()]));
  for(const item of trace)if(item.included){subtotal[item.metric]=(subtotal[item.metric]??0)+item.value;covered.get(item.metric)!.add(item.job_id);knownJobs.add(item.job_id);}
  const jobIds=[...selectedJobs.keys()].sort(),coverage=Object.fromEntries(usageMetrics.map(metric=>{const known=covered.get(metric)!,incomplete=new Set([...missing.filter(m=>m.metric===metric).map(m=>m.job_id),...trace.filter(t=>t.included&&t.metric===metric&&t.event.coverage_quality==='legacy_summary_unknown').map(t=>t.job_id)]);const complete=jobIds.filter(id=>known.has(id)&&!incomplete.has(id));return [metric,{known_jobs:known.size,complete_jobs:complete.length,total_jobs:jobIds.length,ratio:jobIds.length?complete.length/jobIds.length:null,missing_job_ids:jobIds.filter(id=>!known.has(id)||incomplete.has(id))}];}));
  const conflictedIds=new Set(issues.filter(i=>i.reason==='duplicate_conflict').map(i=>i.event_id));
  const source_evidence=reported.filter(e=>e.accounting_key&&eligible(e)&&matches({...jobMap.get(e.job_id),...e,id:e.job_id})&&Date.parse(e.occurred_at)>=from&&Date.parse(e.occurred_at)<=to).map(e=>({...e,primary_source:primarySource(e),selected_for_metering:isPrimary(e)&&!conflictedIds.has(e.id),reason:conflictedIds.has(e.id)?'duplicate_conflict':isPrimary(e)?'primary_usage_source':'secondary_usage_source'}));
  const source_selection=[...meters.values()].filter(m=>reported.some(e=>eligible(e)&&meteringKey(e)===key(m.job_id,m.accounting_key)&&matches({...jobMap.get(e.job_id),...e,id:e.job_id}))).sort((a,b)=>key(a.job_id,a.accounting_key)<key(b.job_id,b.accounting_key)?-1:1);
  return {source:'usage_events',filters,subtotal,known_jobs:knownJobs.size,total_jobs:jobIds.length,missing_job_ids:jobIds.filter(id=>!knownJobs.has(id)),coverage,missing,issues,source_selection,source_evidence,trace:trace.map(({event,...item})=>{const job=jobMap.get(item.job_id);return {...item,sequence:event.sequence,mode:event.mode,reported_usage:{...event.usage},...(event.coverage_quality?{coverage_quality:event.coverage_quality}:{}),role:job?accountingRole(job)||null:null,source_role:job?.role||null,source_phase:job?.phase||null,actual_model:event.actual_model||job?.actual_model||null,requested_model:event.requested_model||job?.requested_model||null,session_id:event.session_id||null};}),external_totals:events.filter(e=>e.scope_kind==='machine').map(e=>({...e,additive_with_jobs:false})),note:'已知小计；缺失用量为未知。同调用跨来源只选稳定主来源，其他证据保留但不重复计量。缓存与推理分类不重复加算。全机快照独立展示。'};
}

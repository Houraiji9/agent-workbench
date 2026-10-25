import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateProjectUsage,createUsageEvent,recordUsageEvent,usageInputFromOutput,withLegacyJobUsage,type UsageEventInput,type UsageJob} from '../src/core/project-usage.ts';
import {parseAgentOutput} from '../src/core/agent-output.ts';
const event=(overrides:Partial<UsageEventInput>={}):UsageEventInput=>({source:'native',job_id:'J1',event_id:'e1',project_id:'P1',task_id:'T1',agent_id:'A1',scope_id:'job',epoch:'launch-1',sequence:1,mode:'incremental',occurred_at:'2026-10-25T12:01:00Z',usage:{total_tokens:10},...overrides});
const jobs=[{id:'J1',project_id:'P1',task_id:'T1',agent_id:'A1',actual_model:'actual',requested_model:'requested',started_at:'2026-10-25T12:00:00Z'}, {id:'J2',project_id:'P1',task_id:'T2',agent_id:'A2',started_at:'2026-10-25T12:00:00Z'}];
test('stable source/job/event identity, append once and reject conflicting replay',()=>{
  const rows=new Map<string,any>(),store={maybe:(_t:string,id:string)=>rows.get(id),put:(_t:string,row:any)=>rows.set(row.id,row)};
  assert.equal(recordUsageEvent(store,event()).inserted,true);assert.equal(recordUsageEvent(store,event()).inserted,false);
  assert.throws(()=>recordUsageEvent(store,event({usage:{total_tokens:12}})),/冲突/);
  assert.notEqual(createUsageEvent(event()).id,createUsageEvent(event({job_id:'J2'})).id);
  assert.equal(aggregateProjectUsage([event(),event()],jobs).subtotal.total_tokens,10);
  const conflicts=aggregateProjectUsage([event(),event({usage:{total_tokens:12}})],jobs);assert.equal(conflicts.subtotal.total_tokens,null);assert.equal(conflicts.issues[0].reason,'duplicate_conflict');
});
test('incremental and cumulative checkpoints share one scope; epochs explicitly reset',()=>{
  const summary=aggregateProjectUsage([event({event_id:'3',sequence:3,mode:'cumulative',usage:{total_tokens:40}}),event(),event({event_id:'2',sequence:2,usage:{total_tokens:5}}),event({event_id:'4',sequence:4,usage:{total_tokens:2}}),event({event_id:'5',sequence:1,epoch:'launch-2',mode:'cumulative',usage:{total_tokens:3}})],jobs);
  assert.equal(summary.subtotal.total_tokens,45);assert.equal(summary.coverage.total_tokens.missing_job_ids[0],'J2');assert.equal(summary.subtotal.input_tokens,null);
});
test('counter regression is reported, not silently treated as a reset',()=>{
  const result=aggregateProjectUsage([event({mode:'cumulative'}),event({event_id:'2',sequence:2,mode:'cumulative',usage:{total_tokens:4}})],jobs);
  assert.equal(result.subtotal.total_tokens,10);assert.match(result.issues[0].reason,/counter_regression/);
});
test('inclusive parent suppresses child metric only in covered scope and epoch',()=>{
  const result=aggregateProjectUsage([event({mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({event_id:'child',scope_id:'child',parent_scope_id:'job',usage:{total_tokens:30,output_tokens:5}}),event({event_id:'other',scope_id:'other',usage:{total_tokens:7}})],jobs);
  assert.equal(result.subtotal.total_tokens,107);assert.equal(result.subtotal.output_tokens,5);assert.equal(result.trace.filter(t=>t.reason==='included_in_parent').length,1);
});
test('cache and reasoning are not added to reported total; explicit source semantics govern derivation',()=>{
  assert.equal(aggregateProjectUsage([event({usage:{input_tokens:100,output_tokens:20,cache_read_tokens:80,reasoning_tokens:10,total_tokens:120}})]).subtotal.total_tokens,120);
  assert.equal(aggregateProjectUsage([event({usage:{input_tokens:100,output_tokens:20}})]).subtotal.total_tokens,null);
  assert.equal(aggregateProjectUsage([event({total_semantics:'input_includes_cache',usage:{input_tokens:100,output_tokens:20,cache_read_tokens:80}})]).subtotal.total_tokens,120);
  assert.equal(aggregateProjectUsage([event({total_semantics:'input_excludes_cache',usage:{input_tokens:100,output_tokens:20,cache_read_tokens:80,cache_write_tokens:2,reasoning_tokens:5}})]).subtotal.total_tokens,202);
});
test('model filtering uses actual model, requested model stays distinct; zero is known and absent is unknown',()=>{
  const result=aggregateProjectUsage([event({actual_model:'actual',requested_model:'requested',usage:{total_tokens:0}})],jobs,{project_id:'P1',task_id:'T1',agent_id:'A1',model:'actual'});
  assert.equal(result.subtotal.total_tokens,0);assert.equal(result.coverage.total_tokens.ratio,1);assert.equal(result.trace[0].actual_model,'actual');assert.equal(result.trace[0].requested_model,'requested');
  assert.equal(aggregateProjectUsage([event()],jobs,{model:'requested'}).total_jobs,0);
});
test('date filters replay earlier checkpoints and expose unknown boundary attribution',()=>{
  const data=[event({mode:'cumulative',usage:{total_tokens:100}}),event({event_id:'2',sequence:2,mode:'cumulative',occurred_at:'2026-10-25T12:03:00Z',usage:{total_tokens:150}})];
  assert.equal(aggregateProjectUsage(data,jobs,{from:'2026-10-25T12:01:00Z',to:'2026-10-25T12:04:00Z'}).subtotal.total_tokens,50);
  const uncertain=aggregateProjectUsage(data,jobs,{from:'2026-10-25T12:02:00Z'});assert.equal(uncertain.subtotal.total_tokens,null);assert.ok(uncertain.issues.some(i=>i.reason==='unknown_time_boundary:total_tokens'));
});
test('machine totals stay separate and binding conflicts never enter the project subtotal',()=>{
  const result=aggregateProjectUsage([event(),event({job_id:'machine',event_id:'today',scope_kind:'machine',usage:{total_tokens:1000}}),event({event_id:'wrong',project_id:'P2',sequence:2})],jobs,{project_id:'P1'});
  assert.equal(result.subtotal.total_tokens,10);assert.equal(result.external_totals[0].usage.total_tokens,1000);assert.equal(result.external_totals[0].additive_with_jobs,false);assert.ok(result.issues.some(i=>i.reason==='job_binding_conflict'));
});
test('invalid negative, unsafe and non-finite metrics are rejected without retaining arbitrary fields',()=>{
  for(const value of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>createUsageEvent(event({usage:{total_tokens:value}})));
  const row=createUsageEvent({...event(),secret:'not-retained'} as UsageEventInput);assert.equal((row as any).secret,undefined);
});
test('partial incremental metric coverage remains incomplete until covered by a cumulative checkpoint',()=>{
  const partial=[event({usage:{input_tokens:10,output_tokens:5}}),event({event_id:'2',sequence:2,usage:{output_tokens:2}})];
  const result=aggregateProjectUsage(partial,jobs);assert.equal(result.subtotal.input_tokens,10);assert.equal(result.coverage.input_tokens.complete_jobs,0);assert.equal(result.coverage.output_tokens.complete_jobs,1);
  assert.equal(aggregateProjectUsage([...partial,event({event_id:'3',sequence:3,mode:'cumulative',usage:{input_tokens:20,output_tokens:7}})],jobs).coverage.input_tokens.complete_jobs,1);
});
test('explicit parent job scope includes child job without double counting',()=>{
  const result=aggregateProjectUsage([event({mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({job_id:'J2',task_id:'T2',agent_id:'A2',event_id:'child',scope_id:'child',parent_scope_id:'job',parent_job_id:'J1',usage:{total_tokens:30}})],jobs);
  assert.equal(result.subtotal.total_tokens,100);assert.equal(result.trace.find(t=>t.job_id==='J2')?.reason,'included_in_parent');
});
test('a filtered parent total including another actual model is unknown for that model',()=>{
  const data=[event({actual_model:'parent-model',mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({job_id:'J2',task_id:'T2',agent_id:'A2',actual_model:'child-model',event_id:'child',scope_id:'child',parent_scope_id:'job',parent_job_id:'J1',usage:{total_tokens:30}})];
  const result=aggregateProjectUsage(data,jobs,{model:'parent-model'});assert.equal(result.subtotal.total_tokens,null);assert.ok(result.issues.some(i=>i.reason==='unattributable_parent_filter:total_tokens'));
  assert.equal(aggregateProjectUsage(data,jobs,{model:'child-model'}).subtotal.total_tokens,30);
});
test('output adapter preserves legitimate repeated steps with persisted ordinals and only writes run_id ref',()=>{
  const output=parseAgentOutput('dsh',JSON.stringify({type:'status',phase:'step_end',usage:{inputTokens:10,outputTokens:2,totalTokens:12}}));
  const job={...jobs[0],run_id:'R1',client_kind:'dsh'},a=usageInputFromOutput(job,output,1,'2026-10-25T12:01:00Z')!,b=usageInputFromOutput(job,output,2,'2026-10-25T12:02:00Z')!;
  assert.notEqual(a.event_id,b.event_id);assert.equal(a.identity_quality,'persisted_ordinal');assert.equal(aggregateProjectUsage([a,b],jobs).subtotal.total_tokens,24);
  let refs:unknown;recordUsageEvent({maybe:()=>undefined,put:(_t,_r,r)=>{refs=r;}},a);assert.deepEqual(refs,{run_id:'R1'});
});
test('message usage adapter shares source message scope and retains unresolved raw counts with a diagnostic',()=>{
  const job={...jobs[0],client_kind:'grok'};
  const start=parseAgentOutput('grok',JSON.stringify({type:'message_start',message:{type:'message',id:'m1',role:'assistant',model:'grok-real',usage:{input_tokens:20,output_tokens:1}}}));
  const delta=parseAgentOutput('grok',JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:30}}));
  const a=usageInputFromOutput(job,start,1,'2026-10-25T12:01:00Z')!,b=usageInputFromOutput({...job,usage_message_id:'m1'},delta,2,'2026-10-25T12:02:00Z')!;
  assert.equal(a.identity_quality,'source_event_id');assert.equal(a.scope_id,b.scope_id);assert.equal(aggregateProjectUsage([a,b]).subtotal.output_tokens,30);
  const unresolved=usageInputFromOutput(job,delta,2,'2026-10-25T12:02:00Z')!;assert.equal(unresolved.usage.output_tokens,30);assert.equal(aggregateProjectUsage([unresolved],jobs).issues[0].reason,'unresolved_message_scope');
});
const messageCheckpoint=(overrides:Partial<UsageEventInput>={}):UsageEventInput=>event({source:'client:grok',scope_id:'message:m1',epoch:'J1',mode:'cumulative',total_semantics:'input_excludes_cache',usage:{input_tokens:20,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0},...overrides});
const outputCheckpoint=(overrides:Partial<UsageEventInput>={}):UsageEventInput=>messageCheckpoint({event_id:'delta',sequence:2,occurred_at:'2026-10-25T12:02:00Z',usage:{output_tokens:30},...overrides});

test('F1: real streamed message usage recomputes total after cumulative output updates',()=>{
  const job={...jobs[0],client_kind:'grok'},start=parseAgentOutput('grok',JSON.stringify({type:'message_start',message:{type:'message',id:'m1',role:'assistant',usage:{input_tokens:20,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}}})),delta=parseAgentOutput('grok',JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:30}}));
  const a=usageInputFromOutput(job,start,1,'2026-10-25T12:01:00Z')!,b=usageInputFromOutput({...job,usage_message_id:'m1'},delta,2,'2026-10-25T12:02:00Z')!,before=JSON.stringify([a,b]);
  const result=aggregateProjectUsage([b,a,a,b],[job]);assert.equal(result.subtotal.total_tokens,50);assert.equal(result.subtotal.output_tokens,30);assert.deepEqual(result.trace.filter(t=>t.metric==='total_tokens').map(t=>t.value),[21,29]);assert.equal(JSON.stringify([a,b]),before);assert.equal(b.usage.total_tokens,undefined);
});
test('cumulative total replay retains real cache counts and repeated checkpoints add zero',()=>{
  const start=messageCheckpoint({usage:{input_tokens:20,output_tokens:1,cache_read_tokens:7,cache_write_tokens:3}}),delta=outputCheckpoint(),repeat=outputCheckpoint({event_id:'repeat',sequence:3,occurred_at:'2026-10-25T12:03:00Z'});
  for(const rows of [[start,delta,repeat],[repeat,delta,start,repeat,delta]]){const result=aggregateProjectUsage(rows,jobs);assert.equal(result.subtotal.total_tokens,60);assert.equal(result.subtotal.cache_read_tokens,7);assert.equal(result.subtotal.cache_write_tokens,3);assert.deepEqual(result.trace.filter(t=>t.metric==='total_tokens').map(t=>t.value),[31,29,0]);}
});
test('missing cache never becomes zero and a partial update invalidates a stale explicit total',()=>{
  for(const omitted of ['cache_read_tokens','cache_write_tokens'] as const){
    const usage={input_tokens:20,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0,total_tokens:21};delete (usage as Partial<typeof usage>)[omitted];
    for(const explicit of [true,false]){const start=messageCheckpoint({usage:explicit?usage:{...usage,total_tokens:undefined}}),result=aggregateProjectUsage([start,outputCheckpoint()],jobs);assert.equal(result.subtotal.total_tokens,null);assert.equal(result.subtotal.output_tokens,30);assert.equal(result.subtotal[omitted],null);assert.equal(result.coverage.total_tokens.complete_jobs,0);assert.ok(result.missing.some(m=>m.metric==='total_tokens'&&m.job_id==='J1'));}
  }
});
test('incomplete message counters stay unknown until every required cumulative component is observed',()=>{
  for(const usage of [{input_tokens:20},{output_tokens:1},{input_tokens:20,output_tokens:1,cache_read_tokens:0}])assert.equal(aggregateProjectUsage([messageCheckpoint({usage}),outputCheckpoint()],jobs).subtotal.total_tokens,null);
  assert.equal(aggregateProjectUsage([outputCheckpoint()],jobs).subtotal.total_tokens,null);
  const result=aggregateProjectUsage([messageCheckpoint({usage:{input_tokens:20,output_tokens:1}}),outputCheckpoint({usage:{output_tokens:30,cache_read_tokens:0,cache_write_tokens:0}})],jobs);assert.equal(result.subtotal.total_tokens,50);
});
test('an explicit completed message total and final job reported total remain authoritative',()=>{
  const job={...jobs[0],client_kind:'grok'},complete=parseAgentOutput('grok',JSON.stringify({type:'message',id:'m1',role:'assistant',stop_reason:'end_turn',content:[],usage:{input_tokens:20,output_tokens:30,total_tokens:50}})),final=usageInputFromOutput(job,complete,3,'2026-10-25T12:03:00Z')!;
  const result=aggregateProjectUsage([messageCheckpoint({usage:{input_tokens:20,output_tokens:1,total_tokens:21}}),outputCheckpoint(),final],jobs);assert.equal(result.subtotal.total_tokens,50);assert.equal(result.subtotal.output_tokens,30);assert.equal(final.usage.total_tokens,50);
  const reported=usageInputFromOutput({...jobs[0],client_kind:'claude'},parseAgentOutput('claude',JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'s1',result:'done',usage:{total_tokens:50}})),1,'2026-10-25T12:03:00Z')!;assert.equal(aggregateProjectUsage([reported],jobs).subtotal.total_tokens,50);
});
test('replay never fills a total with components from another source, scope, epoch or job',()=>{
  const start=messageCheckpoint({usage:{input_tokens:20,cache_read_tokens:0,cache_write_tokens:0}});
  for(const changed of [{scope_id:'message:m2'},{epoch:'other'},{source:'client:other'},{job_id:'J2',task_id:'T2',agent_id:'A2'},{accounting_key:'another-call'}]){const result=aggregateProjectUsage([start,outputCheckpoint(changed)],jobs);assert.equal(result.subtotal.total_tokens,null);assert.equal(result.subtotal.output_tokens,30);}
});
test('derived streaming totals keep checkpoint date boundaries and never prorate unknown intervals',()=>{
  const rows=[messageCheckpoint(),outputCheckpoint()];
  assert.equal(aggregateProjectUsage(rows,jobs,{from:'2026-10-25T12:00:00Z',to:'2026-10-25T12:02:00Z'}).subtotal.total_tokens,50);
  assert.equal(aggregateProjectUsage(rows,jobs,{to:'2026-10-25T12:01:00Z'}).subtotal.total_tokens,21);
  const exact=aggregateProjectUsage(rows,jobs,{from:'2026-10-25T12:01:00Z',to:'2026-10-25T12:02:00Z'});assert.equal(exact.subtotal.total_tokens,29);assert.equal(exact.subtotal.output_tokens,29);assert.equal(exact.subtotal.input_tokens,null);
  for(const from of ['2026-10-25T12:01:30Z','2026-10-25T12:02:00Z']){const cut=aggregateProjectUsage(rows,jobs,{from});assert.equal(cut.subtotal.total_tokens,null);assert.ok(cut.issues.some(i=>i.reason==='unknown_time_boundary:total_tokens'));}
  const stale=[messageCheckpoint({usage:{input_tokens:20,output_tokens:1,total_tokens:21}}),outputCheckpoint()];assert.equal(aggregateProjectUsage(stale,jobs,{to:'2026-10-25T12:01:00Z'}).subtotal.total_tokens,21);assert.equal(aggregateProjectUsage(stale,jobs).subtotal.total_tokens,null);
});
test('regressing components cannot create a replacement total until a valid checkpoint repairs them',()=>{
  const bad=outputCheckpoint({usage:{input_tokens:10,output_tokens:30}}),later=outputCheckpoint({event_id:'later',sequence:3,occurred_at:'2026-10-25T12:03:00Z',usage:{output_tokens:35}}),rows=[messageCheckpoint(),bad,later];
  const result=aggregateProjectUsage(rows,jobs);assert.equal(result.subtotal.total_tokens,null);assert.equal(result.subtotal.input_tokens,20);assert.equal(result.subtotal.output_tokens,35);assert.ok(result.issues.some(i=>i.reason==='counter_regression:input_tokens'));
  const repaired=aggregateProjectUsage([...rows,outputCheckpoint({event_id:'repair',sequence:4,occurred_at:'2026-10-25T12:04:00Z',usage:{input_tokens:20}})],jobs);assert.equal(repaired.subtotal.total_tokens,55);
});
test('component time regression and incompatible total semantics cannot certify a derived total',()=>{
  const reversed=aggregateProjectUsage([messageCheckpoint(),outputCheckpoint({occurred_at:'2026-10-25T12:00:30Z'})],jobs);assert.equal(reversed.subtotal.total_tokens,null);assert.ok(reversed.issues.some(i=>i.reason==='time_regression:output_tokens'));
  const semantics=aggregateProjectUsage([messageCheckpoint(),outputCheckpoint({total_semantics:'input_includes_cache'})],jobs);assert.equal(semantics.subtotal.total_tokens,null);
  assert.equal(aggregateProjectUsage([messageCheckpoint({total_semantics:'input_includes_cache',usage:{input_tokens:20,output_tokens:1}}),outputCheckpoint({total_semantics:'input_includes_cache'})],jobs).subtotal.total_tokens,50);
});
test('derived totals cannot exceed the safe integer range even when individual counters are valid',()=>{
  const result=aggregateProjectUsage([messageCheckpoint({usage:{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:1,cache_read_tokens:0,cache_write_tokens:0}})],jobs);assert.equal(result.subtotal.total_tokens,null);assert.equal(result.subtotal.input_tokens,Number.MAX_SAFE_INTEGER);
});
test('closeout phase is a distinct accounting role while raw execution role and phase remain traceable',()=>{
  const roleJobs=[{...jobs[0],id:'execution',role:'execution',phase:'execution'},{...jobs[0],id:'review',role:'review',phase:'review'},{...jobs[0],id:'closeout',role:'execution',phase:'closeout'}],data=[event({job_id:'execution',usage:{total_tokens:100}}),event({job_id:'review',usage:{total_tokens:20}}),event({job_id:'closeout',usage:{total_tokens:30}})],before=JSON.stringify({roleJobs,data});
  const execution=aggregateProjectUsage(data,roleJobs,{role:'execution'}),review=aggregateProjectUsage(data,roleJobs,{role:'review'}),closeout=aggregateProjectUsage(data,roleJobs,{role:'closeout'}),all=aggregateProjectUsage(data,roleJobs);
  assert.equal(execution.subtotal.total_tokens,100);assert.equal(review.subtotal.total_tokens,20);assert.equal(closeout.subtotal.total_tokens,30);assert.equal(all.subtotal.total_tokens,150);assert.equal(all.total_jobs,3);assert.equal(closeout.total_jobs,1);assert.equal(closeout.coverage.total_tokens.ratio,1);
  assert.deepEqual(all.trace.filter(t=>t.included).map(t=>t.job_id).sort(),['closeout','execution','review']);assert.equal(closeout.trace[0].role,'closeout');assert.equal(closeout.trace[0].source_role,'execution');assert.equal(closeout.trace[0].source_phase,'closeout');assert.equal(JSON.stringify({roleJobs,data}),before,'projection must not rewrite raw job or ledger fields');
});
test('closeout coverage includes unmetered closeout jobs and does not include normal execution',()=>{
  const roleJobs=[{...jobs[0],id:'normal',role:'execution',phase:'execution'},{...jobs[0],id:'measured-closeout',role:'execution',phase:'closeout'},{...jobs[0],id:'unknown-closeout',role:'execution',phase:'closeout'}],data=[event({job_id:'normal',usage:{total_tokens:100}}),event({job_id:'measured-closeout',usage:{total_tokens:0}})];
  const result=aggregateProjectUsage(data,roleJobs,{project_id:'P1',role:'closeout'});assert.equal(result.subtotal.total_tokens,0);assert.equal(result.total_jobs,2);assert.equal(result.coverage.total_tokens.complete_jobs,1);assert.equal(result.coverage.total_tokens.ratio,0.5);assert.deepEqual(result.coverage.total_tokens.missing_job_ids,['unknown-closeout']);assert.deepEqual(result.missing_job_ids,['unknown-closeout']);assert.equal(result.trace.some(t=>t.job_id==='normal'),false);
});
test('role-filtered inclusive parent totals cannot charge child closeout usage to ordinary execution',()=>{
  const roleJobs=[{...jobs[0],id:'parent',role:'execution',phase:'execution'},{...jobs[0],id:'child',role:'execution',phase:'closeout'}],data=[event({job_id:'parent',mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({job_id:'child',scope_id:'child',parent_scope_id:'job',parent_job_id:'parent',usage:{total_tokens:30}})];
  const execution=aggregateProjectUsage(data,roleJobs,{role:'execution'}),closeout=aggregateProjectUsage(data,roleJobs,{role:'closeout'}),all=aggregateProjectUsage(data,roleJobs);assert.equal(execution.subtotal.total_tokens,null);assert.ok(execution.issues.some(i=>i.reason==='unattributable_parent_filter:total_tokens'));assert.equal(closeout.subtotal.total_tokens,30);assert.equal(all.subtotal.total_tokens,100);
});
test('F2: two sources for the same explicit call choose one stable meter and retain the excluded raw evidence',()=>{
  const data=[event({source:'job',event_id:'job-1',accounting_key:'CALL-1'}),event({source:'external',event_id:'external-1',accounting_key:'CALL-1'})],before=JSON.stringify(data);
  for(const input of [data,[...data].reverse()]){const result=aggregateProjectUsage(input,jobs);assert.equal(result.subtotal.total_tokens,10);assert.equal(result.source_selection[0].primary_source,'job');assert.equal(result.trace.find(t=>t.source==='external')?.included,false);assert.equal(result.trace.find(t=>t.source==='external')?.reason,'secondary_usage_source');assert.ok(result.issues.some(i=>i.reason==='secondary_usage_source'));assert.equal(result.issues.some(i=>i.reason==='sequence_conflict'),false);assert.deepEqual(result.source_evidence.map(e=>e.usage.total_tokens),[10,10]);assert.equal(result.source_evidence.filter(e=>e.selected_for_metering).length,1);}
  assert.equal(JSON.stringify(data),before,'source selection must not modify the append-only input evidence');
});
test('primary source retains every legitimate increment, scope and epoch even when a secondary aggregate uses different boundaries',()=>{
  const primary=[event({source:'job',accounting_key:'CALL-1',event_id:'a',usage:{total_tokens:4}}),event({source:'job',accounting_key:'CALL-1',event_id:'b',sequence:2,usage:{total_tokens:6}}),event({source:'job',accounting_key:'CALL-1',event_id:'c',scope_id:'other-step',usage:{total_tokens:3}}),event({source:'job',accounting_key:'CALL-1',event_id:'d',epoch:'launch-2',usage:{total_tokens:2}})],secondary=event({source:'external',accounting_key:'CALL-1',event_id:'external',scope_id:'provider-aggregate',epoch:'provider-epoch',mode:'cumulative',usage:{total_tokens:15}});
  const result=aggregateProjectUsage([secondary,...primary].reverse(),jobs);assert.equal(result.subtotal.total_tokens,15);assert.equal(result.trace.filter(t=>t.included).length,4);assert.equal(result.trace.filter(t=>t.reason==='secondary_usage_source').length,1);assert.equal(result.coverage.total_tokens.complete_jobs,1);
});
test('mixed incremental and cumulative counters replay only within their source, independent of arrival order and repeated events',()=>{
  const data=[event({source:'job',accounting_key:'CALL-1',event_id:'j1',usage:{total_tokens:10}}),event({source:'job',accounting_key:'CALL-1',event_id:'j2',sequence:2,usage:{total_tokens:5}}),event({source:'job',accounting_key:'CALL-1',event_id:'j3',sequence:3,mode:'cumulative',usage:{total_tokens:30}}),event({source:'external',accounting_key:'CALL-1',event_id:'x1',usage:{total_tokens:20}}),event({source:'external',accounting_key:'CALL-1',event_id:'x2',sequence:2,usage:{total_tokens:10}}),event({source:'external',accounting_key:'CALL-1',event_id:'x3',sequence:3,usage:{total_tokens:10}})];
  for(const input of [data,[...data].reverse(),[data[5],data[2],data[0],data[4],data[1],data[3],data[0],data[3]]]){const result=aggregateProjectUsage(input,jobs);assert.equal(result.subtotal.total_tokens,30);assert.deepEqual(result.trace.filter(t=>t.included).map(t=>t.value),[10,5,15]);assert.equal(result.issues.some(i=>i.reason==='sequence_conflict'),false);}
});
test('secondary metrics never fill a chosen primary meter gap, and missing secondary metrics do not reduce primary coverage',()=>{
  const data=[event({source:'client:dsh',accounting_key:'CALL-1',event_id:'main',usage:{total_tokens:0,input_tokens:4}}),event({source:'job',accounting_key:'CALL-1',event_id:'other-native',usage:{total_tokens:10,output_tokens:8}}),event({source:'external',accounting_key:'CALL-1',event_id:'incomplete',usage:{output_tokens:8}})];
  const result=aggregateProjectUsage(data,jobs);assert.equal(result.source_selection[0].primary_source,'client:dsh');assert.equal(result.subtotal.total_tokens,0);assert.equal(result.subtotal.input_tokens,4);assert.equal(result.subtotal.output_tokens,null);assert.equal(result.coverage.total_tokens.complete_jobs,1);assert.ok(result.coverage.output_tokens.missing_job_ids.includes('J1'));assert.equal(result.missing.some(m=>m.event_id===createUsageEvent(data[2]).id),false);
});
test('time filtering cannot promote a secondary source or hide a cumulative boundary uncertainty',()=>{
  const data=[event({source:'job',accounting_key:'CALL-1',event_id:'j1',mode:'cumulative',usage:{total_tokens:100}}),event({source:'job',accounting_key:'CALL-1',event_id:'j2',sequence:2,mode:'cumulative',occurred_at:'2026-10-25T12:03:00Z',usage:{total_tokens:150}}),event({source:'external',accounting_key:'CALL-1',event_id:'x1',occurred_at:'2026-10-25T12:03:00Z',usage:{total_tokens:50}})];
  const known=aggregateProjectUsage(data,jobs,{from:'2026-10-25T12:01:00Z',to:'2026-10-25T12:04:00Z'});assert.equal(known.subtotal.total_tokens,50);assert.equal(known.source_selection[0].primary_source,'job');assert.equal(known.trace.find(t=>t.source==='external')?.included,false);
  const boundary=aggregateProjectUsage(data,jobs,{from:'2026-10-25T12:02:00Z'});assert.equal(boundary.subtotal.total_tokens,null);assert.ok(boundary.issues.some(i=>i.reason==='unknown_time_boundary:total_tokens'));assert.equal(boundary.source_evidence.find(e=>e.source==='external')?.selected_for_metering,false);
  const noPrimaryInside=aggregateProjectUsage([data[0],data[2]],jobs,{from:'2026-10-25T12:02:00Z'});assert.equal(noPrimaryInside.subtotal.total_tokens,null);assert.equal(noPrimaryInside.source_selection[0].primary_source,'job');
});
test('parent-inclusive suppression uses the selected source and cannot overwrite the secondary-source explanation',()=>{
  const data=[event({source:'job',accounting_key:'CALL-1',event_id:'parent',mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({source:'job',accounting_key:'CALL-1',event_id:'child',scope_id:'child',parent_scope_id:'job',usage:{total_tokens:30}}),event({source:'external',accounting_key:'CALL-1',event_id:'parent-copy',mode:'cumulative',includes_children:true,period_start:'2026-10-25T12:00:00Z',usage:{total_tokens:100}}),event({source:'external',accounting_key:'CALL-1',event_id:'child-copy',scope_id:'child',parent_scope_id:'job',actual_model:'other-model',usage:{total_tokens:30}})];
  const result=aggregateProjectUsage(data,jobs);assert.equal(result.subtotal.total_tokens,100);assert.equal(result.trace.find(t=>t.source==='job'&&t.scope_id==='child')?.reason,'included_in_parent');assert.ok(result.trace.filter(t=>t.source==='external').every(t=>t.reason==='secondary_usage_source'&&!t.included));assert.equal(aggregateProjectUsage(data,jobs,{model:'actual'}).subtotal.total_tokens,100);
});
test('a conflicting primary event cannot silently promote a secondary source, and excluded regressing evidence stays available',()=>{
  const primary=event({source:'job',accounting_key:'CALL-1'}),secondary=event({source:'external',accounting_key:'CALL-1',event_id:'x1'}),conflict=aggregateProjectUsage([primary,{...primary,usage:{total_tokens:11}},secondary],jobs);assert.equal(conflict.subtotal.total_tokens,null);assert.equal(conflict.source_selection[0].primary_source,'job');assert.equal(conflict.source_evidence.filter(e=>e.reason==='duplicate_conflict').length,2);assert.ok(conflict.trace.every(t=>!t.included));
  const result=aggregateProjectUsage([primary,{...secondary,mode:'cumulative',usage:{total_tokens:100}},{...secondary,event_id:'x2',sequence:2,mode:'cumulative',usage:{total_tokens:90}}],jobs);assert.equal(result.subtotal.total_tokens,10);assert.ok(result.issues.some(i=>i.reason==='counter_regression:total_tokens'));assert.equal(result.source_evidence.find(e=>e.event_id==='x2')?.usage.total_tokens,90);assert.equal(result.source_evidence.find(e=>e.event_id==='x2')?.reason,'secondary_usage_source');
});
test('source preference is deterministic while absent accounting keys and separate job identities remain independent',()=>{
  const a=event({source:'z-provider',accounting_key:'CALL-1'}),b=event({source:'a-provider',accounting_key:'CALL-1'});assert.equal(aggregateProjectUsage([a,b],jobs).source_selection[0].primary_source,'a-provider');assert.equal(aggregateProjectUsage([b,a],jobs).source_selection[0].primary_source,'a-provider');
  assert.equal(aggregateProjectUsage([event({source:'job'}),event({source:'external'})],jobs).subtotal.total_tokens,20);
  assert.equal(aggregateProjectUsage([event({source:'job',accounting_key:'CALL-1'}),event({source:'external',accounting_key:'CALL-1',job_id:'J2',task_id:'T2',agent_id:'A2'})],jobs).subtotal.total_tokens,20);
});

const legacyJob=(overrides:Partial<UsageJob>={}):UsageJob=>({...jobs[0],run_id:'R1',role:'execution',status:'completed',ended_at:'2026-10-25T12:03:00Z',usage:{scope:'invocation_steps',inputTokens:10,outputTokens:2,totalTokens:12},...overrides});

test('legacy projection is stable, idempotent, immutable and preserves the historical interval',()=>{
  const legacy=legacyJob(),raw:UsageEventInput[]=[],before=JSON.stringify({legacy,raw});
  Object.freeze(raw);Object.freeze(legacy.usage);Object.freeze(legacy);
  const a=withLegacyJobUsage(raw,[legacy]),b=withLegacyJobUsage(raw,[legacy]);
  assert.notEqual(a,raw);assert.deepEqual(a,b);assert.deepEqual(withLegacyJobUsage(a,[legacy]),a);
  assert.equal(a.length,1);assert.equal(a[0].source,'legacy:job_summary');assert.equal(a[0].mode,'cumulative');assert.equal(a[0].occurred_at,legacy.ended_at);assert.equal(a[0].period_start,legacy.started_at);assert.equal(a[0].coverage_quality,'legacy_summary_unknown');
  assert.equal(JSON.stringify({legacy,raw}),before);assert.equal(aggregateProjectUsage([...a,...a],[legacy]).subtotal.total_tokens,12);
});

test('legacy step and reported totals remain known subtotals with explicitly unknown completeness',()=>{
  for(const scope of ['invocation_steps','reported_total']){
    const legacy=legacyJob({usage:{scope,totalTokens:12}}),result=aggregateProjectUsage(withLegacyJobUsage([],[legacy]),[legacy]);
    assert.equal(result.subtotal.total_tokens,12);assert.equal(result.known_jobs,1);assert.equal(result.coverage.total_tokens.known_jobs,1);assert.equal(result.coverage.total_tokens.complete_jobs,0);assert.equal(result.coverage.total_tokens.ratio,0);assert.deepEqual(result.coverage.total_tokens.missing_job_ids,['J1']);
    assert.equal(result.trace[0].coverage_quality,'legacy_summary_unknown');assert.equal(result.trace[0].reason,'legacy_summary_known_subtotal');
  }
});

test('legacy last-message usage, individual steps and unknown scopes cannot impersonate invocation totals',()=>{
  for(const scope of ['message','step','unknown',''])assert.deepEqual(withLegacyJobUsage([],[legacyJob({usage:{scope,totalTokens:12}})]),[]);
  assert.deepEqual(withLegacyJobUsage([],[legacyJob({usage:undefined})]),[]);
});

test('any existing job ledger blocks legacy fallback, including zero, empty, invalid and out-of-filter receipts',()=>{
  const legacy=legacyJob();
  for(const receipt of [event({usage:{total_tokens:0}}),event({usage:{}}),event({usage:{total_tokens:-1}}),event({occurred_at:'bad'}),event({actual_model:'another',project_id:'another',occurred_at:'2020-01-01T00:00:00Z'})]){
    assert.deepEqual(withLegacyJobUsage([receipt],[legacy]),[receipt]);
  }
  const partial=event({usage:{input_tokens:4}}),result=aggregateProjectUsage(withLegacyJobUsage([partial],[legacy]),[legacy]);
  assert.equal(result.subtotal.input_tokens,4);assert.equal(result.subtotal.output_tokens,null);assert.equal(result.subtotal.total_tokens,null);
});

test('other jobs and machine-wide receipts do not block a missing job ledger',()=>{
  const legacy=legacyJob(),raw=[event({job_id:'other'}),event({scope_kind:'machine'})],rows=withLegacyJobUsage(raw,[legacy]);
  assert.equal(rows.length,3);assert.equal(rows[2].source,'legacy:job_summary');assert.equal(rows[0],raw[0]);assert.equal(rows[1],raw[1]);
});

test('legacy metrics retain explicit zero and decimals for cost while absent and invalid fields stay unknown',()=>{
  const legacy=legacyJob({usage:{scope:'reported_total',inputTokens:0,outputTokens:2,totalCostUsd:0,cacheReadTokens:-1,cacheWriteTokens:Infinity,reasoningTokens:1.5,totalTokens:NaN}}),rows=withLegacyJobUsage([],[legacy]);
  assert.deepEqual(rows[0].usage,{input_tokens:0,output_tokens:2,cost_usd:0});
  const result=aggregateProjectUsage(rows,[legacy]);assert.equal(result.subtotal.input_tokens,0);assert.equal(result.subtotal.total_tokens,null);assert.equal(result.subtotal.cache_read_tokens,null);assert.equal(result.subtotal.reasoning_tokens,null);
  const cost=withLegacyJobUsage([],[legacyJob({usage:{scope:'reported_total',totalCostUsd:0.125}})]);assert.deepEqual(cost[0].usage,{cost_usd:0.125});
  assert.deepEqual(withLegacyJobUsage([],[legacyJob({usage:{scope:'reported_total',totalTokens:Number.MAX_SAFE_INTEGER+1}})]),[]);
});

test('legacy interval filters include only fully contained usage and never prorate a cut boundary',()=>{
  const legacy=legacyJob(),rows=withLegacyJobUsage([],[legacy]);
  assert.equal(aggregateProjectUsage(rows,[legacy],{from:legacy.started_at,to:legacy.ended_at}).subtotal.total_tokens,12);
  const cut=aggregateProjectUsage(rows,[legacy],{from:'2026-10-25T12:01:00Z',to:'2026-10-25T12:04:00Z'});assert.equal(cut.subtotal.total_tokens,null);assert.ok(cut.issues.some(i=>i.reason==='unknown_time_boundary:total_tokens'));assert.equal(cut.coverage.total_tokens.complete_jobs,0);
  const beforeEnd=aggregateProjectUsage(rows,[legacy],{to:'2026-10-25T12:02:00Z'});assert.equal(beforeEnd.subtotal.total_tokens,null);assert.equal(beforeEnd.known_jobs,0);
  assert.equal(aggregateProjectUsage(rows,[legacy],{from:'2026-10-25T12:04:00Z'}).subtotal.total_tokens,null);
});

test('only explicitly ended terminal jobs qualify, including failed and interrupted work with real usage',()=>{
  for(const status of ['completed','failed','interrupted'])assert.equal(withLegacyJobUsage([],[legacyJob({status})]).length,1);
  for(const status of ['queued','launching','running','cancelled',''])assert.equal(withLegacyJobUsage([],[legacyJob({status})]).length,0);
  assert.equal(withLegacyJobUsage([],[legacyJob({status:undefined})]).length,0);
  assert.equal(withLegacyJobUsage([],[legacyJob({process_may_be_running:true})]).length,0);
  assert.equal(withLegacyJobUsage([],[legacyJob({ended_at:undefined})]).length,0);
});

test('legacy usage needs a valid complete historical interval and stable project, task and run ownership',()=>{
  for(const overrides of [{started_at:undefined,created_at:undefined},{started_at:'bad'},{ended_at:'bad'},{started_at:'2026-10-25T12:04:00Z'},{id:''},{project_id:''},{task_id:undefined},{run_id:undefined},{project_id:'bad\nproject'}])assert.deepEqual(withLegacyJobUsage([],[legacyJob(overrides)]),[]);
  const created=legacyJob({started_at:undefined,created_at:'2026-10-25T11:59:00Z'});assert.equal(withLegacyJobUsage([],[created])[0].period_start,created.created_at);
});

test('legacy role and actual-model filters preserve closeout attribution and reported model identity',()=>{
  const legacy=legacyJob({phase:'closeout',requested_model:'requested',actual_model:'actual',session_id:'session-1'}),rows=withLegacyJobUsage([],[legacy]);
  const result=aggregateProjectUsage(rows,[legacy],{project_id:'P1',task_id:'T1',agent_id:'A1',role:'closeout',model:'actual'});
  assert.equal(result.subtotal.total_tokens,12);assert.equal(result.trace[0].role,'closeout');assert.equal(result.trace[0].source_role,'execution');assert.equal(result.trace[0].actual_model,'actual');assert.equal(result.trace[0].requested_model,'requested');assert.equal(result.trace[0].session_id,'session-1');
  for(const filters of [{model:'requested'},{role:'execution'},{project_id:'other'},{task_id:'other'},{agent_id:'other'}])assert.equal(aggregateProjectUsage(rows,[legacy],filters).subtotal.total_tokens,null);
});

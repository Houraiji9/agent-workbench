import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeTokenMonitorDetails,projectTokenMonitorUsage} from '../src/core/token-monitor-usage.ts';
import {normalizeTokenStats,latestTokenUsage} from '../src/integrations/adapters.ts';
const native='01a16d00-c265-7c41-839a-48eb813dba50',rollout='rollout-2026-10-24T01-22-08-'+native;
const usage={client:'codex',sessionId:rollout,nativeSessionId:native,totalTokens:110,inputTokens:5,outputTokens:5,cacheReadTokens:100,cacheWriteTokens:0,models:{'source-model':110},costUsd:0.01,startedAt:'2026-10-24T08:22:08Z',lastUsedAt:'2026-10-25T12:23:00Z',projectLabel:'misleading-name',projectId:'sha256:opaque'};
const raw=(ss:any={'codex:x':usage})=>({updatedAt:'2026-10-25T12:30:00Z',limits:{providers:[]},periods:{today:{sessions:ss},month:{sessions:ss},allTime:{sessions:{}}}});
const context=(sessions:any[]=[{agent:'codex',native_id:native,project_id:'P',bindings:[{project_id:'P',task_id:'T1'},{project_id:'P',task_id:'T2'}]}],jobs:any[]=[])=>({sessions,jobs,projects:[{id:'P',paths:['G:/project'],source_root:'G:/project/source'}],agents:[]});
const report=(source:any=raw(),c=context())=>projectTokenMonitorUsage({status:'connected',snapshot:{usage_details:normalizeTokenMonitorDetails(source)}},'P',c);

test('preserves real period/session metrics and exact native ID despite unrelated directory label',()=>{
  const p=report().periods.month;assert.equal(p.matched_sessions,1);assert.equal(p.summary.total_tokens,110);assert.equal(p.summary.input_tokens,5);assert.equal(p.summary.cache_read_tokens,100);assert.equal(p.summary.reasoning_tokens,null);assert.deepEqual(p.rows[0].task_ids,['T1','T2']);assert.equal(p.rows[0].session_id,native);assert.equal(p.summary.total_tokens,110,'one session reused by two tasks counts once');
});
test('normal adapter preserves usage_details without requiring credential or machine totals',()=>{const normalized=normalizeTokenStats(raw());assert.equal(normalized.usage_details.periods.month.rows[0].metrics.total_tokens,110);});
test('period totals are independent and empty allTime is unknown rather than zero',()=>{const x=raw();x.periods.today.sessions={'codex:x':{...usage,totalTokens:20} as any};const p=report(x).periods;assert.equal(p.today.summary.total_tokens,20);assert.equal(p.month.summary.total_tokens,110);assert.equal(p.allTime.available,false);assert.equal(p.allTime.summary.total_tokens,null);});
test('exact repeated device session is counted once, different contents conflict and do not count',()=>{
  const ss={'codex:x':usage,'codex:alias':{...usage}};assert.equal(report(raw(ss)).periods.today.summary.total_tokens,110);
  ss['codex:alias']={...usage,totalTokens:111};const p=report(raw(ss)).periods.today;assert.equal(p.summary.total_tokens,null);assert.equal(p.invalid_sessions,1);
});
test('device periods take precedence over aggregate copies; ambiguous cross-device IDs excluded',()=>{
  const input={...raw(),devices:[{deviceId:'device1',periods:raw().periods,periodWindows:{month:{key:'2026-10'},timeZone:'America/Los_Angeles'}}]};let p=report(input).periods.month;assert.equal(p.summary.total_tokens,110);assert.equal(p.windows[0].key,'2026-10');
  input.devices.push({...input.devices[0],deviceId:'device2'});p=report(input).periods.month;assert.equal(p.summary.total_tokens,null);assert.equal(p.ambiguous_sessions,2);
});
test('workbench job native session binds resumed review once without adding job summaries',()=>{
  const u={...usage,client:'dsh',sessionId:'session-real',nativeSessionId:undefined};const c=context([],['J1','J2'].map(id=>({id,route:{client:'dsh'},session_id:'session-real',project_id:'P',task_id:'T',usage:{totalTokens:999}})));const p=report(raw({'dsh:session-real':u}),c).periods.month;assert.equal(p.summary.total_tokens,110);assert.equal(p.matched_sessions,1);
});
test('cross-project native session is ambiguous, not assigned to the first project',()=>{
  const c=context([{agent:'codex',native_id:native,project_id:'P',bindings:[{project_id:'P'},{project_id:'OTHER'}]}]);const p=report(raw(),c).periods.month;assert.equal(p.summary.total_tokens,null);assert.equal(p.ambiguous_sessions,1);
});
test('client identity separates equal session IDs; names and opaque project hashes never associate',()=>{
  const c=context([{agent:'claude',native_id:native,project_id:'P'}]);const p=report(raw(),c).periods.month;assert.equal(p.summary.total_tokens,null);assert.equal(p.unassigned_sessions,1);
});
test('unique literal cwd can associate; duplicate registered roots remain ambiguous',()=>{
  const c=context([]),source=raw({'codex:x':{...usage,cwd:'G:/project/source'}});assert.equal(report(source,c).periods.month.matched_sessions,1);c.projects.push({id:'P2',paths:['G:/project/source'],source_root:'G:/else'});assert.equal(report(source,c).periods.month.ambiguous_sessions,1);
});
test('invalid numeric records excluded; missing versus explicit zero remain distinct',()=>{
  for(const value of [-1,NaN,Infinity,0.1]){const p=report(raw({'codex:x':{...usage,totalTokens:value}})).periods.month;assert.equal(p.summary.total_tokens,null);assert.equal(p.invalid_sessions,1);}
  const p=report(raw({'codex:x':{...usage,totalTokens:undefined,outputTokens:0}})).periods.month;assert.equal(p.summary.total_tokens,null);assert.equal(p.summary.output_tokens,0);assert.equal(p.summary.input_tokens,5);
});
test('offline snapshot keeps source timestamp and known data; missing adapter contract is explicit',()=>{
  const p=projectTokenMonitorUsage({status:'stale',snapshot:{usage_details:normalizeTokenMonitorDetails(raw())}},'P',context());assert.equal(p.status,'stale');assert.equal(p.updated_at,'2026-10-25T12:30:00Z');assert.equal(p.periods.month.summary.total_tokens,110);assert.equal(projectTokenMonitorUsage(undefined,'P',context()).periods.month.available,false);
});
test('read-only projection neither modifies source nor bindings and repeat reads are stable',()=>{const r=raw(),c=context(),before=JSON.stringify({r,c});assert.deepEqual(report(r,c),report(r,c));assert.equal(JSON.stringify({r,c}),before);});
test('late usage snapshot cannot replace newer session counters when quota clock is unchanged',()=>{const current=normalizeTokenStats(raw()),older=normalizeTokenStats({...raw(),updatedAt:'2026-10-25T11:30:00Z'});const accepted=latestTokenUsage(older,current);assert.equal(accepted.usage_details.updated_at,current.usage_details.updated_at);assert.equal(accepted.usage_updated_at,current.usage_updated_at);assert.equal(latestTokenUsage(current,older).usage_details.updated_at,current.usage_details.updated_at);});
test('expired source windows are excluded from current totals and stale devices explicitly disclosed',()=>{
  const detail=normalizeTokenMonitorDetails({...raw(),devices:[{deviceId:'old',stale:true,periods:raw().periods,periodWindows:{today:{endsAt:'2026-10-25T07:00:00Z'}}}]});const p=projectTokenMonitorUsage({status:'connected',snapshot:{usage_details:detail}},'P',context(),Date.parse('2026-10-25T12:00:00Z')).periods;
  assert.equal(p.today.summary.total_tokens,null);assert.match(p.today.note,/窗口已结束/);assert.equal(p.month.summary.total_tokens,110);assert.match(p.month.note,/不代表实时值/);
});
test('large source session list reports truncation rather than silently claiming complete coverage',()=>{const ss=Object.fromEntries(Array.from({length:10001},(_,i)=>['s'+i,{...usage,sessionId:'s'+i,nativeSessionId:undefined}]));const p=report(raw(ss),context([])).periods.month;assert.equal(p.total_sessions,10001);assert.match(p.note,/1 个会话未处理/);});
test('contradictory native/session identity is rejected',()=>{const p=report(raw({'s':{...usage,nativeSessionId:'different-id'}})).periods.month;assert.equal(p.invalid_sessions,1);assert.equal(p.summary.total_tokens,null);});

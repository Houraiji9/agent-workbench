import {managedQuotaView} from './resource-management.ts';
import { z } from 'zod';
import type { Workbench } from './workbench.ts';
import type { Row } from './schema.ts';
import { assert, now } from './security.ts';
import {antigravityGroup} from '../shared/quota-groups.ts';
import {monthlyPointsSchema} from './points-schema.ts';

export const cachedProviders = ['antigravity', 'claude'] as const;
const names: Record<string,string> = { antigravity: 'Antigravity', claude: 'Claude' };
const time = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
const numeric = (w: Row) => typeof w.remaining_percent === 'number' && Number.isFinite(w.remaining_percent) && w.remaining_percent >= 0 && w.remaining_percent <= 100;
export const quotaCacheInput = z.object({
  version: z.number().int().nonnegative(),
  group:z.enum(['gemini','argon','claude-gpt']).optional(),
  windows: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['session','weekly','billing','custom']),
    remaining_percent: z.number().min(0).max(100).nullable(),
    resets_at: z.string().datetime({offset:true}).nullable(),
  }).strict()).min(1).max(20).refine(ws => ws.some(w => w.remaining_percent !== null), '请填写至少一项剩余额度'),
}).strict();

// 只接纳有数值的成功采集；空响应、同一份旧数据均保留当前缓存。
export function syncQuotaCache(wb: Workbench, pools: Row[], windows: Row[]) {
  for (const provider of cachedProviders) {
    const candidates = pools.filter(p => p.provider === provider && p.status === 'ok' && time(p.source_updated_at) > 0 && time(p.source_updated_at) <= Date.now() + 300000 && windows.some(w => w.pool_id === p.id && numeric(w))).sort((a,b) => time(b.source_updated_at)-time(a.source_updated_at));
    const p = candidates[0], old = wb.maybe('quota_cache', provider);
    if (!p || time(p.source_updated_at) <= Math.max(time(old?.source_updated_at),time(old?.upstream_watermark))) continue;
    const row = { id: provider, version: (old?.version || 0)+1, source: 'token_monitor', source_updated_at: p.source_updated_at, account_ref: p.account_ref, pool_id: p.id,
      windows: windows.filter(w => w.pool_id === p.id).map(w => ({...w,source:'token_monitor',source_updated_at:w.source_updated_at||p.source_updated_at})), saved_at: now() };
    wb.put('quota_cache', row);
    if (old?.source === 'user_entered') wb.audit('token_monitor','refresh_manual_quota',provider,{before:old,after:row});
  }
}

export function editQuotaCache(wb: Workbench, provider: string, input: unknown) {
  assert(cachedProviders.includes(provider as any), '此工具的额度由 Token Monitor 更新', 403);
  const v = quotaCacheInput.parse(input);
  assert(!v.group||provider==='antigravity'&&v.windows.every(w=>antigravityGroup(w)===v.group),'额度分组与窗口不一致');
  return wb.transaction(() => {
    const old = wb.maybe('quota_cache', provider);
    assert(v.version === (old?.version || 0), '额度已更新，请重新打开后编辑', 409);
    const at = now();
    const watermark = new Date(Math.max(time(at),time(old?.source_updated_at),time(old?.upstream_watermark),...wb.all('quota_pools').filter(p=>p.provider===provider).map(p=>time(p.source_updated_at)))).toISOString();
    const windows=[...(v.group?(old?.windows||[]).filter((w:Row)=>antigravityGroup(w)!==v.group).map((w:Row)=>({...w,source:w.source||old?.source,source_updated_at:w.source_updated_at||old?.source_updated_at})):[]),...v.windows.map(w => ({...w,used_percent:w.remaining_percent === null ? null : 100-w.remaining_percent,unit:'percent',source:'user_entered',source_updated_at:at}))];
    assert(windows.length<=20,'额度窗口过多');
    const row = { id: provider, version: v.version+1, source: 'user_entered', source_updated_at: at, upstream_watermark:watermark, saved_at: at, account_ref: old?.account_ref || null, pool_id: old?.pool_id || null,windows };
    wb.put('quota_cache',row);wb.audit('user','edit_quota_cache',provider,{before:old||null,after:row});return row;
  });
}

const manualPointsInput=z.object({version:z.number().int().nonnegative(),remaining:z.number().finite().min(0).max(1000000000).multipleOf(0.001).nullable(),monthly:monthlyPointsSchema.nullable().optional(),resets_at:z.string().datetime({offset:true}).nullable().optional()}).strict();
export {manualPointsInput};
export function editWorkBuddyPoints(wb:Workbench,input:unknown){
  const v=manualPointsInput.parse(input);
  return wb.transaction(()=>{
    const old=wb.maybe('quota_cache','workbuddy-points');
    assert(v.version===(old?.version||0),'积分已更新，请重新打开后编辑',409);
    const monthly=structuredClone(v.monthly===undefined?old?.monthly||null:v.monthly);
    if(monthly&&v.remaining===null)monthly.remaining=null;
    assert(!monthly||monthly.remaining===null||v.remaining===null||monthly.remaining<=v.remaining,'月度积分包含在总积分内，请核对数量');
    const row={id:'workbuddy-points',version:v.version+1,remaining:v.remaining,monthly,resets_at:v.resets_at===undefined?old?.resets_at||null:v.resets_at,source:'user_entered',source_updated_at:now()};
    wb.put('quota_cache',row);wb.audit('user',v.remaining===null?'clear_workbuddy_points':'edit_workbuddy_points',row.id,{before:old||null,after:row});return row;
  });
}

// 展示与规划共用同一投影，原采集记录仍在账本中，避免重复计算。
export function baseQuotaView(wb: Workbench) {
  const raw = wb.all('quota_pools'), rawWindows = wb.all('quota_windows');
  let pools:Row[] = raw.filter(p => !p.archived && p.status !== 'planned' && !cachedProviders.includes(p.provider) && !(p.provider==='workbuddy'&&p.status==='notConfigured')).map((p):Row => ({...p,balance:p.provider==='zai'?null:p.balance}));
  pools = pools.filter(p => p.status !== 'notConfigured' || (!pools.some(q => q.provider===p.provider&&q.status==='ok') && pools.filter(q=>q.provider===p.provider&&q.status==='notConfigured').sort((a,b)=>time(b.source_updated_at)-time(a.source_updated_at)||a.id.localeCompare(b.id))[0].id===p.id));
  const windows = rawWindows.filter(w => {
    const p = pools.find(p => p.id === w.pool_id);if(!p)return false;
    const money = w.kind==='billing' && (w.label?.toLowerCase()==='balance' || /^[A-Z]{3}$/.test(w.unit || ''));
    return !(p.provider==='zai'&&money) && !(money && p.balance?.amount != null && w.remaining===p.balance.amount && w.unit===p.balance.currency);
  });
  for (const provider of cachedProviders) {
    const c = wb.maybe('quota_cache',provider), id = 'CACHE-'+provider;
    if(!c&&!wb.all('agents').some(a=>!a.archived&&(a.id===provider||a.preset_id===provider)))continue;
    const observed = raw.find(p=>p.id===c?.pool_id);
    const connected=wb.get('integrations','tokenMonitor').status==='connected';
    const projected:Row[]=(c?.windows||[]).map((w:Row,i:number)=>{
      const source=w.source||c!.source,at=w.source_updated_at||c!.source_updated_at;
      const live=source==='token_monitor'&&observed?.status==='ok'&&observed.freshness==='fresh'&&time(observed.source_updated_at)===time(at)&&Date.now()-time(at)<=600000&&connected;
      const manual=source==='user_entered',fresh=live||manual&&Date.now()-time(at)<=600000;
      return {...w,id:id+':'+i,pool_id:id,source,source_updated_at:at,display_state:manual?'manual':live?'live':'cached',freshness:fresh?'fresh':'stale'};
    });
    const sources=[...new Set(projected.map(w=>w.source))],states=[...new Set(projected.map(w=>w.display_state))];
    pools.push({id,provider,name:names[provider],source:sources.length>1?'mixed':sources[0]||'token_monitor',balance:null,status:c?'ok':'notConfigured',freshness:projected.length&&projected.every(w=>w.freshness==='fresh')?'fresh':'stale',source_updated_at:c?.source_updated_at||null,cache_editable:true,cache_version:c?.version||0,display_state:!projected.length?'empty':states.length>1?'mixed':states[0],account_ref:c?.account_ref||null} as Row);
    windows.push(...projected);
  }
  const points=wb.maybe('quota_cache','workbuddy-points'),hasPoints=typeof points?.remaining==='number',pointsId='MANUAL-workbuddy-points';
  const pointsAt=points?.source_updated_at||null,pointsFresh=hasPoints&&Date.now()-time(pointsAt)<=600000?'fresh':'stale';
  if(points||wb.all('agents').some(a=>!a.archived&&(a.id==='workbuddy'||a.preset_id==='workbuddy')))pools.push({id:pointsId,provider:'workbuddy',name:'WorkBuddy',source:'user_entered',status:hasPoints?'ok':'notConfigured',balance:null,points_editable:true,points_amount:hasPoints?points!.remaining:null,points_monthly:points?.monthly||null,points_resets_at:points?.resets_at||null,points_version:points?.version||0,source_updated_at:hasPoints?pointsAt:null,display_state:hasPoints?'manual':'empty',freshness:pointsFresh,members:['workbuddy']});
  if(hasPoints)windows.push({id:pointsId+':remaining',pool_id:pointsId,kind:'custom',metric:'points',label:'剩余积分',remaining:points!.remaining,remaining_percent:null,limit:null,monthly:points?.monthly||null,resets_at:points?.resets_at||null,unit:'积分',source:'user_entered',source_updated_at:pointsAt,display_state:'manual',freshness:pointsFresh});
  return {pools,windows};
}

export function quotaView(wb:Workbench){const {pools,windows}=baseQuotaView(wb);return managedQuotaView(wb,pools,windows)}


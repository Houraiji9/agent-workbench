// 额度与订阅：额度窗口逐个显示、不相加；订阅计划按日期排；数据连接可测试与续读。
import React from 'react';
import { RefreshCw, PencilLine, CalendarCheck, ChevronsDown, Plus, Trash2, Settings2, RotateCcw } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import type { R } from '../lib/flow.js';
import { quotaPercent } from '../quota.js';
import { relative, fullDate, daysUntil, dayCountText, plainDay, subscriptionPrice, bigNumber, num } from '../lib/format.js';
import {QuotaGrid} from '../ui/QuotaGrid.js';
import { AgentIcon } from '../ui/AgentIcon.js';
import { Tabs, Pill, Empty, Section, Notice } from '../ui/kit.js';
import { windowLabel } from './Today.js';
import { antigravityGroups, antigravityGroup } from '../../shared/quota-groups.js';
import {otherPoints} from '../../shared/points.js';

export function Resources() {
  const s = useStore();
  const tab = s.route.tab || 'quota';
  return <div className="page-wrap">
    <header className="page-head"><div><h1>额度与订阅</h1><p>查看各工具的剩余额度、订阅和接下来的安排。</p></div></header>
    <Tabs label="资源" value={tab} onChange={t => s.go({ page: 'resources', tab: t })} tabs={[['quota', '额度'], ['plans', '订阅与日程'], ['connections', '数据连接']]} />
    {tab === 'quota' && <Quota />}
    {tab === 'plans' && <Plans />}
    {tab === 'connections' && <Connections />}
  </div>;
}

function Quota() {
  const s = useStore();
  const { data } = s;
  const tm = (data.integrations as R[]).find(i => i.id === 'tokenMonitor');
  const connected = tm?.status === 'connected';
  const live = (data.quota_pools as R[]).filter(p => (p.source === 'token_monitor' || p.cache_editable || p.points_editable || p.custom_quota) && p.status !== 'planned');
  const balancePair=live.filter(p=>p.points_editable||p.provider==='deepseek'&&p.status!=='notConfigured');
  const unconfigured = live.filter(p => p.status === 'notConfigured' && !p.cache_editable && !p.points_editable&&!p.custom_quota);
  const stalePool=(p:R)=>!p.cache_editable&&!p.points_editable&&!p.custom_quota&&p.status!=='notConfigured'&&p.freshness==='stale';
  const old = live.filter(p => stalePool(p) && !balancePair.includes(p));
  const lowest = (p: R) => Math.min(100, ...(data.quota_windows as R[]).filter(w => w.pool_id === p.id).map(w => quotaPercent(w) ?? 101));
  const fresh = live.filter(p => !unconfigured.includes(p) && !stalePool(p) && !balancePair.includes(p)).sort((a, b) => lowest(a) - lowest(b));
  const hasLive = live.some(p => p.cache_editable ? (data.quota_windows as R[]).some(w=>w.pool_id===p.id&&w.display_state==='live') : p.source==='token_monitor'&&p.status==='ok'&&p.freshness==='fresh');
  // 全部过期时（例如 Token Monitor 一段时间没更新），把最近一天内的上次记录放在前面，标记为上次记录。
  const freshSignal=live.filter(p=>!unconfigured.includes(p)&&!stalePool(p)&&!p.points_editable&&!p.custom_quota);
  const recent = freshSignal.some(p => !p.cache_editable) ? [] : old.filter(p => Date.now() - Date.parse(p.source_updated_at || '') < 86400000).sort((a, b) => lowest(a) - lowest(b));
  const current = [...fresh, ...recent];
  const older = old.filter(p => !recent.includes(p));
  const lastUpdate = (data.quota_windows as R[]).filter(w => (w.source || live.find(p => p.id === w.pool_id)?.source) === 'token_monitor').map(w => String(w.source_updated_at || '')).filter(Boolean).sort().pop() || tm?.last_success;
  const usage = tm?.snapshot?.usage;
  const cards=[...current,...balancePair].flatMap(p=>p.provider==='antigravity'?antigravityGroups.map(g=>{
    const ws=(data.quota_windows as R[]).filter(w=>w.pool_id===p.id&&antigravityGroup(w)===g.id),manual=ws.some(w=>w.source==='user_entered');
    return <PoolCard key={p.id+g.id} p={{...p,name:p.name+' · '+g.name,quota_group:g.id,display_state:!ws.length?'empty':manual?'manual':ws.every(w=>w.display_state==='live')?'live':'cached',freshness:ws.length&&ws.every(w=>w.freshness==='fresh')?'fresh':'stale',source_updated_at:ws.map(w=>w.source_updated_at||'').sort().pop()||null}} stale={!connected||!fresh.length}/>;
  }):[<PoolCard key={p.id} p={p} stale={!connected||!fresh.length}/>]);
  return <>
    <div className={'source-line' + (connected && fresh.length ? '' : ' warn')}>
      <span className={'dot c-' + (tm?.status || 'not_connected')} />
      {connected && !hasLive ? <>上次更新于 {relative(lastUpdate, s.tz)} · 等待 Token Monitor 刷新</>
        : connected ? <>来自 Token Monitor · {relative(tm.last_success, s.tz)}读取</> : tm?.last_success ? <>Token Monitor 离线 · 显示 {relative(tm.last_success, s.tz)}的记录</> : <>Token Monitor 尚未连接</>}
      <button className="link" onClick={() => s.go({ page: 'resources', tab: 'connections' })}>连接设置</button>
      <button className="btn small" onClick={()=>s.openDialog('quota-manage')}><Plus size={15}/>添加额度</button>
    </div>
    {cards.length ? <QuotaGrid>{cards}</QuotaGrid>
      : <Empty title="暂时没有可显示的额度">{connected ? '连接正常，但还没有读到可计算的额度窗口。' : '连接 Token Monitor 后，这里会显示每个工具的剩余额度。'}</Empty>}

    {usage && <Section title="今天的实际用量" label="今天的实际用量">
      <div className="usage">
        <p className="usage-total"><b>{bigNumber(usage.totalTokens)}</b> Token<small>（含缓存读取 {bigNumber(usage.cacheReadTokens)}{usage.outputTokens != null && `，输出 ${bigNumber(usage.outputTokens)}`}）</small></p>
        <UsageBars clients={usage.clients || {}} />
        <p className="muted small">按 Token Monitor 的统计日计算 · 更新于 {relative(tm.snapshot.usage_updated_at, s.tz)}。{usage.costUsd != null && `按 API 价格估算约 $${num(usage.costUsd, 2)}。`}</p>
      </div>
    </Section>}

    {older.length > 0 && <details className="fold section"><summary>较早的记录（{older.length}）</summary><QuotaGrid>{older.map(p => <PoolCard key={p.id} p={p} stale />)}</QuotaGrid></details>}
    {unconfigured.length > 0 && <details className="fold section"><summary>还没在 Token Monitor 里配置的工具（{unconfigured.length}）</summary><p className="muted small">{unconfigured.map(p => p.name).join('、')}。配置后这里会显示它们的额度。</p></details>}
    {(data.quota_definitions||[]).some((d:R)=>d.archived)&&<details className="fold section"><summary>已移除的额度</summary><div className="row-list">{data.quota_definitions.filter((d:R)=>d.archived).map((d:R)=><div className="restore-row" key={d.id}><strong>{d.name}</strong><button className="btn small" disabled={s.busy} onClick={()=>void s.act(()=>api('/quotas/'+d.id+'/restore',{version:d.version}),'额度已恢复')}><RotateCcw size={14}/>恢复</button></div>)}</div></details>}
    <p className="muted small legend"><span className="legend-bar" /> 条越长剩得越多　<span className="legend-bar unknown" /> 斜纹表示暂无数据</p>
  </>;
}

function PoolCard({ p, stale }: { p: R; stale?: boolean }) {
  const s = useStore();
  const allWindows = (s.data.quota_windows as R[]).filter(w => w.pool_id === p.id);
  const windows = p.quota_group ? allWindows.filter(w=>antigravityGroup(w)===p.quota_group) : allWindows;
  const isStale = p.display_state !== 'manual' && p.display_state !== 'empty' && (p.display_state === 'cached' || stale || p.freshness === 'stale');
  const stateText = p.display_state === 'manual' ? '手动记录' : p.display_state === 'empty' ? '待填写' : isStale ? '上次记录' : p.status === 'ok' ? '实时' : '暂不可用';
  const original=(s.data.quota_pools as R[]).find(q=>q.id===p.id)||p;
  return <article className={'pool' + (isStale ? ' stale' : '') + (!windows.length && !p.balance ? ' is-empty' : '')} aria-label={p.name + ' 额度'}>
    <header><span className="pool-name"><PoolIcon p={p}/>{String(p.name).includes(' · ') ? <span className="pool-title"><strong>{String(p.name).split(' · ').slice(1).join(' · ')}</strong><small>{String(p.name).split(' · ')[0]}</small></span> : <strong>{p.name}</strong>}</span><div className="pool-tools"><span title={p.source_updated_at?`更新于 ${fullDate(p.source_updated_at,s.tz)}`:undefined} className={'pool-state' + (isStale ? ' old' : p.display_state === 'empty' ? '' : p.status === 'ok' ? ' ok' : '')}>{stateText}</span><button className="icon-btn" title="管理额度" aria-label={'管理 '+p.name+' 额度'} onClick={()=>s.openDialog('quota-manage',{pool:original})}><Settings2 size={14}/></button></div></header>
    {!windows.length && !p.balance && <div className="win-empty"><b>{p.points_editable ? '还没有填写积分' : '还没有额度记录'}</b><small>{p.points_editable ? '点下方“填写积分”记一次当前积分。' : p.cache_editable || p.custom_quota ? '点下方“编辑额度”记一次，之后这里会一直显示。' : 'Token Monitor 读到数据后会显示在这里。'}</small></div>}
    {windows.map((w: R) => {
      const v = quotaPercent(w);
      const level = v === null ? 'unknown' : v <= 15 ? 'low' : v <= 35 ? 'mid' : 'ok';
      const label = windowLabel(w);
      if(w.monthly){const other=otherPoints(w as any);return <div className={'win w-'+level} key={w.id}>
        <div className="win-top"><span>总剩余积分</span><b>{w.remaining===null?'待填写':num(w.remaining,3)+' 积分'}</b></div>
        <div className="win-top"><span>月度基础积分</span><b>{v===null?'待填写':`剩 ${Math.round(v)}%`}</b></div>
        <div className="bar" role="progressbar" aria-label={p.name+' 月度基础积分'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v??undefined} aria-valuetext={v===null?'未知':`剩余 ${Math.round(v)}%（手动记录）`}>{v!==null&&<i style={{width:v+'%'}}/>}</div>
        <div className="win-foot"><small>{w.monthly.remaining===null?'待填写':num(w.monthly.remaining,3)} / {num(w.monthly.allowance,3)} 积分</small><small>{w.resets_at?(Date.parse(w.resets_at)>Date.now()?relative(w.resets_at,s.tz)+'刷新':'待更新本月积分'):'每月刷新'}</small></div>
        <div className="win-top"><span>其他积分</span><b>{other===null?'待填写':num(other,3)+' 积分'}</b></div>
      </div>}
      if (v === null && (w.remaining != null||w.metric&&w.metric!=='percent')) return <div key={w.id} className="win w-amount">
        <div className="win-top"><span>{label}</span><b>{w.remaining==null?'待填写':`剩 ${num(w.remaining,3)} ${w.unit && w.unit !== 'unknown' && w.unit !== 'percent' ? w.unit : ''}`}</b></div>
        {(w.unit==='unknown'||w.resets_at)&&<div className="win-foot">{w.unit==='unknown'&&<small>单位未知，余额记录</small>}{w.resets_at&&<small>{Date.parse(w.resets_at) > Date.now() ? relative(w.resets_at, s.tz) + '重置' : '等待刷新'}</small>}</div>}
      </div>;
      return <div key={w.id} className={'win w-' + level}>
        <div className="win-top"><span>{label}</span><b>{v === null ? '暂无数据' : `剩 ${Math.round(v)}%`}</b></div>
        <div className="bar" role="progressbar" aria-label={`${p.name} ${label} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} aria-valuetext={v === null ? '未知' : `剩余 ${Math.round(v)}%${p.display_state === 'manual' ? '（手动记录）' : isStale ? '（上次记录）' : ''}`}>{v !== null && <i style={{ width: v + '%' }} />}</div>
        <div className="win-foot"><small>{v === null ? (w.remaining != null ? `剩 ${num(w.remaining)} ${w.unit && w.unit !== 'unknown' ? w.unit : '（单位未知）'}，总量未知` : '等待更新') : `已用 ${Math.round(100 - v)}%`}</small><small>{w.resets_at ? `${Date.parse(w.resets_at) > Date.now() ? relative(w.resets_at, s.tz) + '重置' : '重置时间已过，等待刷新'}` : '重置时间未知'}</small></div>
      </div>;
    })}
    {p.balance && <div className="balance"><span>账户余额</span><b>{p.balance.amount ?? '未知'} {p.balance.currency}</b></div>}
    {p.members?.length>1&&<small className="muted">{p.members.map((a:string)=>s.name(a)).join(' · ')} 共用</small>}
    <footer className="pool-footer"><span>{p.source_updated_at ? `更新于 ${relative(p.source_updated_at, s.tz)}` : '等待首次同步'}</span>{p.cache_editable && <button className="link" onClick={() => s.openDialog('quota-edit', { pool: p, windows:allWindows })}><PencilLine size={13} />编辑额度</button>}{p.points_editable&&<button className="link" onClick={()=>s.openDialog('workbuddy-points',{pool:p})}><PencilLine size={13}/>{p.points_amount==null?'填写积分':'修改积分'}</button>}{p.custom_quota&&<button className="link" onClick={()=>s.openDialog('quota-manage',{pool:p})}><PencilLine size={13}/>编辑额度</button>}</footer>
  </article>;
}

/** 额度卡左上角的工具图标：优先用共用这份额度的团队成员图标，其次按服务商。 */
function PoolIcon({ p }: { p: R }) {
  const s = useStore();
  const agent = (s.data.agents as R[]).find(a => (p.members || []).includes(a.id));
  // 没有关联成员时按名称或服务商认出常见工具，例如“智谱 / Zcode”“Grok”
  const text = (String(p.name || '') + ' ' + String(p.provider || '')).toLowerCase();
  const known = ([['zcode', 'zcode'], ['智谱', 'zcode'], ['glm', 'zcode'], ['grok', 'grok-build'], ['codex', 'codex'], ['antigravity', 'antigravity'], ['claude', 'claude'], ['kimi', 'kimi'], ['deepseek', 'deepseek'], ['gemini', 'gemini'], ['workbuddy', 'workbuddy']] as const).find(([k]) => text.includes(k))?.[1];
  const id = agent ? (agent.icon_key && agent.icon_key !== 'auto' ? agent.icon_key : agent.id) : known || String(p.provider || '').toLowerCase();
  return <AgentIcon name={String(agent?.name || p.name)} id={id || 'x'} size={26} />;
}

function UsageBars({ clients }: { clients: Record<string, number> }) {
  const names: R = { dsh: 'DeepSeek', codex: 'Codex', kimi: 'Kimi', antigravity: 'Antigravity', zcode: 'Zcode', workbuddy: 'WorkBuddy', claude: 'Claude', gemini: 'Gemini' };
  const rows = Object.entries(clients).filter(([, n]) => typeof n === 'number').sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(r => r[1]));
  if (!rows.length) return null;
  return <div className="usage-bars">{rows.map(([k, n]) => <div key={k} className="ub-row">
    <span>{names[k] || k}</span>
    <span className="ub-track"><i style={{ width: (n / max * 100) + '%' }} /></span>
    <b>{bigNumber(n)}</b>
  </div>)}</div>;
}

function Plans() {
  const s = useStore();
  const subs = s.data.subscriptions as R[];
  const planned = subs.filter(x => x.status === 'planned' && x.source !== 'token_monitor').sort((a, b) => String(a.planned_date || '9999').localeCompare(String(b.planned_date || '9999')));
  const mine = subs.filter(x => x.status !== 'planned' && x.source !== 'token_monitor');
  const accountName = (id: string) => (s.data.accounts as R[]).find(a => a.id === id)?.name;
  return <>
    <Section title="接下来的安排" label="订阅计划" aside={<button className="btn small" onClick={() => s.openDialog('subscription-add', { kind: 'plan' })}><Plus size={15} />添加安排</button>}>
      <p className="muted small">用“添加安排”记录计划，完成后点“记录已发生”。</p>
      {planned.length ? <ol className="plan-line">{planned.map(x => {
        const d = daysUntil(x.planned_date, s.tz);
        return <li key={x.id} className={x.confirmed_at ? 'confirmed' : d !== null && d < 0 ? 'overdue' : d !== null && d <= 30 ? 'soon' : ''}>
          <div className="pl-when"><b>{plainDay(x.planned_date)}</b><small>{x.confirmed_at ? '已记录发生' : dayCountText(d)}</small></div>
          <div className="pl-what">
            <strong>{x.title}</strong>
            <p>{x.note || '计划事件，发生后再记录确认。'}</p>
            <small>{subscriptionPrice(x)}{accountName(x.account_id) ? ` · ${accountName(x.account_id)}` : ''}{x.confirmed_at ? ` · 发生于 ${fullDate(x.confirmed_at, s.tz)}` : ' · 计划中'}</small>
            <div className="pl-actions">
              <button className="btn small" onClick={() => s.openDialog('subscription-edit', { subscription: x })}><PencilLine size={14} />编辑计划</button>
              {!x.confirmed_at && <button className="btn small" onClick={() => s.openDialog('subscription-confirm', { subscription: x })}><CalendarCheck size={14} />记录已发生</button>}
              <button className="btn small ghost" onClick={() => s.openDialog('subscription-delete', { subscription: x })}><Trash2 size={14} />删除安排</button>
            </div>
          </div>
        </li>;
      })}</ol> : <Empty title="没有订阅计划" />}
    </Section>

    <Section title="你登记的订阅" label="你登记的订阅" aside={<button className="btn small" onClick={() => s.openDialog('subscription-add', { kind: 'subscription' })}><Plus size={15} />添加订阅</button>}>
      {!mine.length && <Empty title="还没有登记订阅">点“添加订阅”，记下你正在使用或已经到期的订阅。</Empty>}
      <div className="sub-table" role="table" aria-label="你登记的订阅">
        {mine.map(x => <div role="row" key={x.id} className="sub-row">
          <span role="cell" className="sr-name"><b>{x.title}</b>{accountName(x.account_id) && accountName(x.account_id) !== x.title && <small>{accountName(x.account_id)}</small>}</span>
          <span role="cell"><Pill tone={x.status.includes('active') ? (x.source === 'user_confirmed' ? 'done' : 'working') : 'quiet'}>{x.status === 'user_confirmed_active' ? '已确认生效' : x.status === 'user_reported_active' ? '你报告有效' : x.status === 'user_reported_expired' ? '已过期' : x.status}</Pill></span>
          <span role="cell">{subscriptionPrice(x)}</span>
          <span role="cell">{x.end_date ? `${plainDay(x.end_date)}到期` : '到期日未知'}{x.auto_renew === false ? ' · 不续费' : x.auto_renew === true ? ' · 打算续费' : ''}{x.estimated_points != null ? ` · 约 ${x.estimated_points} 积分（估算）` : ''}</span>
          <span role="cell" className="sub-actions"><button className="btn small ghost" onClick={() => s.openDialog('subscription-edit', { subscription: x })}><PencilLine size={14} />编辑</button><button className="icon-btn" title="删除订阅" aria-label={`删除 ${x.title}`} onClick={() => s.openDialog('subscription-delete', { subscription: x })}><Trash2 size={15} /></button></span>
        </div>)}
      </div>
    </Section>

  </>;
}

function Connections() {
  const s = useStore();
  return <div className="conn-grid">
    {(s.data.integrations as R[]).map(i => <article key={i.id} className={'conn-card c-' + i.status}>
      <header><span className="dot" /><strong>{i.name}</strong><span className="muted">{i.status === 'connected' ? '已连接' : i.status === 'not_connected' ? '未连接' : '连接中断'}</span></header>
      <p>{i.id === 'tokenMonitor' ? '同步各工具的额度和用量。' : '查找各 Agent 的历史会话。'}</p>
      {i.error && <Notice tone="warn">{i.error}</Notice>}
      
      <dl className="facts compact">
        <dt>最近成功</dt><dd>{i.last_success ? fullDate(i.last_success, s.tz) : '还没有'}</dd>
        <dt>最近尝试</dt><dd>{i.last_attempt ? fullDate(i.last_attempt, s.tz) : '还没有'}</dd>
      </dl>
      <div className="tool-row">
        <button className="btn small" disabled={s.busy} onClick={() => void s.act(() => api('/integrations/' + i.id + '/refresh', {}), '检查完成')}><RefreshCw size={15} />测试连接并刷新</button>
        {i.snapshot?.next_cursor && <button className="btn small ghost" disabled={s.busy} onClick={() => void s.act(() => api('/integrations/' + i.id + '/refresh', { cursor: i.snapshot.next_cursor }), '已读取后续会话')}><ChevronsDown size={15} />读取更早的会话</button>}
      </div>
    </article>)}
    <p className="muted small">两个数据服务由桌面版自动启动；关闭工作台时一起退出（Token Monitor 自己的采集程序保留）。</p>
  </div>;
}

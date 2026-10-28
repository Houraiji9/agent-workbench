import {taskAction,actionGroups,type ActionGroup} from '../../shared/workflow-view.js';
import {UserDecision,pendingDecisions} from '../ui/UserDecision.js';
// 今天：接力棒在你手里的事放最前面，其次是 Agent 正在做的，再是最近完成。右侧是日程、额度与连接。
import React,{useState} from 'react';
import { Copy, ArrowRight, MessageCircleQuestion, CircleCheckBig, LifeBuoy, ClipboardPaste, Sparkles, CalendarClock, Gauge, PlugZap, Folder } from 'lucide-react';
import { useStore } from '../app/store.js';
import { type R, relayOf, requestRelay, byUrgency, isYourTurn, isTheirTurn, reviewSkippedTask } from '../lib/flow.js';
import { greeting, todayLine, relative, daysUntil, dayCountText, plainDay } from '../lib/format.js';
import { quotaPercent } from '../quota.js';
import { Pill, RelayTrack, ReviewLanes, Empty, Section } from '../ui/kit.js';
import { AgentIcon } from '../ui/AgentIcon.js';
import { copyOrder, copyPlanning, copyRework, markDispatched, continueTask, openTrial, copyReviewHandoff } from './actions.js';
import {TaskQuickActions} from '../ui/TaskQuickActions.js';
import {waitingForDependencies} from '../../shared/execution-order.js';
import {ExecutionList,OrderStep} from '../ui/ExecutionOrder.js';
import {RequestPreview} from '../ui/RequestPreview.js';
import {RequestMoreActions,requestStatusText} from '../ui/RequestActions.js';

export function Today() {
  const s = useStore();
  const { data } = s;
  const [projectFilter,setProjectFilter]=useState(''),[ownerFilter,setOwnerFilter]=useState(''),[search,setSearch]=useState(''),[limit,setLimit]=useState(20),[groupFilter,setGroupFilter]=useState('all'),[sort,setSort]=useState('recent');
  const visible=(id:string)=>!data.projects.some((p:R)=>p.id===id&&(p.shelved||p.archived));
  const tasks=data.tasks.filter((t:R)=>visible(t.project_id));
  const heldJobs=(data.agent_jobs||[]).filter((j:R)=>['running','launching'].includes(j.status)&&data.tasks.some((t:R)=>t.id===j.task_id&&!visible(t.project_id)));
  const match=(t:R)=>(!projectFilter||t.project_id===projectFilter)&&(!ownerFilter||s.executorOf(t)===ownerFilter)&&(!search||t.title.toLowerCase().includes(search.toLowerCase()));
  const requests = data.requests.filter((q: R) => q.status === 'awaiting_planning'&&visible(q.project_id))
    .sort((a: R, b: R) => String(b.created_at).localeCompare(String(a.created_at)));
  const decisions=pendingDecisions(data),needsDecision=new Set(decisions.map(d=>d.task_id));
  const yours = tasks.filter((t:R)=>!needsDecision.has(t.id)&&isYourTurn(t)&&match(t)).sort((a:R,b:R)=>sort==='oldest'?String(a.updated_at||'').localeCompare(String(b.updated_at||'')):byUrgency(a,b));
  const theirs = tasks.filter((t:R)=>!needsDecision.has(t.id)&&isTheirTurn(t)).sort(byUrgency);
  const waiting = tasks.filter(waitingForDependencies);
  const done = tasks.filter((t: R) => t.status === 'accepted')
    .sort((a: R, b: R) => String(b.acceptance_record?.confirmed_at || b.updated_at).localeCompare(String(a.acceptance_record?.confirmed_at || a.updated_at))).slice(0, 4);
  const visibleRequests=requests.filter((q:R)=>(!projectFilter||q.project_id===projectFilter)&&!ownerFilter&&(!search||q.text.toLowerCase().includes(search.toLowerCase())));
  const visibleDecisions=decisions.filter(d=>data.tasks.some((t:R)=>t.id===d.task_id&&match(t)));
  const yourCount = yours.length + visibleRequests.length + visibleDecisions.length;
  const empty = !data.tasks.length && !data.requests.length;

  const summary = yourCount
    ? `有 ${yourCount} 件事在等你${theirs.length ? `，另有 ${theirs.length} 件正由 Agent 处理` : ''}。`
    : theirs.length ? `现在没有要你动手的事，${theirs.length} 件正由 Agent 处理。` : '现在没有要你动手的事。';

  return <div className="today">
    <header className="hero">
      <p className="hero-date">{todayLine(s.tz)}</p>
      <h1>{greeting(s.tz)}，{summary}</h1>
    </header>

    <div className="today-grid">
      <div className="today-main">
        {heldJobs.length>0&&<div className="banner quiet"><div><strong>已收纳项目还有 {heldJobs.length} 次调用在运行</strong><p>收纳只暂停新安排，运行中的调用不会自动停止。</p>{heldJobs.map((j:R)=><button key={j.id} className="btn small" onClick={()=>s.openTask(j.task_id)}>查看运行中的任务</button>)}</div></div>}
        {empty && <Welcome />}

        {!empty && <Section title={<>轮到你了 {yourCount > 0 && <span className="count">{yourCount}</span>}</>} label="轮到你了">
          {/* 先按“要做的动作”分流，再用搜索和下拉细筛；没有事项的动作不占位置。 */}
          <div className="attention-kinds" role="group" aria-label="按动作筛选待办">{[['all','全部'],['answer','待回答'],['trial','待试用'],['decision','异常需决定'],['arrange','待安排']].map(([key,label])=>{const count=key==='all'?yourCount:yours.filter((t:R)=>taskAction(t).group===key).length+(key==='arrange'?visibleRequests.length:0)+(key==='decision'?visibleDecisions.length:0);if(!count&&key!=='all'&&groupFilter!==key)return null;return <button key={key} className={'chip'+(groupFilter===key?' on':'')} aria-pressed={groupFilter===key} onClick={()=>{setGroupFilter(key);setLimit(20)}}>{label}（{count}）</button>})}</div>
          <div className="attention-filters">
            <input aria-label="搜索待办" placeholder="搜索要处理的事项" value={search} onChange={e=>{setSearch(e.target.value);setLimit(20)}}/>
            <select aria-label="按项目筛选待办" value={projectFilter} onChange={e=>{setProjectFilter(e.target.value);setLimit(20)}}><option value="">全部项目</option>{data.projects.map((p:R)=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <select aria-label="按负责人筛选待办" value={ownerFilter} onChange={e=>{setOwnerFilter(e.target.value);setLimit(20)}}><option value="">全部负责人</option>{data.agents.map((a:R)=><option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <select aria-label="待办排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="recent">按优先级排序</option><option value="oldest">最久未更新在前</option></select>
          </div>
          {yourCount===0&&<Empty title={waiting.length?'后续任务正在等待前序':'当前筛选下没有待办'}/>}
          {(['answer','trial','decision','arrange'] as ActionGroup[]).map(group=>{
            const rows=yours.filter((t:R)=>taskAction(t).group===group),extras=group==='arrange'?visibleRequests:[],cards=group==='decision'?visibleDecisions:[];
            const count=rows.length+extras.length+cards.length;if(!count||(groupFilter!=='all'&&groupFilter!==group))return null;
            // 待安排多为“复制后交给执行者”的例行动作，用紧凑行显示，免得淹没需要思考的事项。
            const compact=group==='arrange';
            const content=<><div className={'turn-list'+(compact?' compact-list':'')}>{cards.slice(0,limit).map(d=><UserDecision key={d.id} decision={d}/>)}{extras.slice(0,limit).map((q:R)=><RequestTurn key={q.id} q={q}/>)}{rows.slice(0,limit).map((t:R)=><TaskTurn key={t.id} t={t} compact={compact}/>)}</div>{count>limit&&<button className="btn ghost" onClick={()=>setLimit(n=>n+20)}>显示更多{actionGroups[group]}</button>}</>;
            return <section className={'attention-group'+(group==='arrange'?' arrange-group':'')} aria-label={actionGroups[group]} key={group}><h3>{actionGroups[group]} <span className="count">{count}</span></h3>{content}</section>;
          })}
        </Section>}

        {theirs.length > 0 && <Section title={<>正在由 Agent 处理 <span className="count">{theirs.length}</span></>} label="正在由 Agent 处理">
          <div className="row-list">
            {theirs.map((t: R) => {
              const who = s.executorOf(t), relay = relayOf(t, s.name, who);
              const holder = who;
              const project = s.pname(t.project_id);
              return <div key={t.id} className="quick-action-row"><button className="row active-task" onClick={() => s.openTask(t.id)}>
                <AgentIcon name={s.name(holder)} id={s.agentIconId(holder)} />
                <span className="row-main">
                  <ProjectTag name={project} />
                  <strong title={t.title}>{t.title}</strong>
                  <small title={relay.headline}>{relay.headline}</small>{['submitted','in_review'].includes(t.status)&&<ReviewLanes relay={relay}/>}
                </span>
                <span className="row-side"><Pill task={t} /><small>{relative(t.updated_at, s.tz)}更新</small></span>
              </button><TaskQuickActions task={t} trial={false}/></div>;
            })}
          </div>
        </Section>}


        {waiting.length>0&&<details className="fold waiting-orders"><summary>等待前序的任务（{waiting.length}）</summary><ExecutionList tasks={waiting}/></details>}
      </div>

      <aside className="today-side" aria-label="概况">
        <Upcoming />
        <QuotaGlance />
        <Connections />
      </aside>
    </div>
        {done.length > 0 && <Section title="最近完成" aside={<button className="link" onClick={() => s.go({ page: 'records' })}>全部记录<ArrowRight size={15} /></button>}>
          <div className="done-grid">
            {done.map((t: R) => {
              const runIds = data.runs.filter((r: R) => r.task_id === t.id).map((r: R) => r.id);
              const files = data.artifacts.filter((a: R) => runIds.includes(a.run_id) && a.current).length;
              return <button key={t.id} className="done-card" onClick={() => s.openTask(t.id)}>
                <CircleCheckBig size={18} className="ok-ico" />
                <strong>{t.title}</strong>
                <small>{s.name(s.executorOf(t))} · {files} 个成果文件 · {relative(t.acceptance_record?.confirmed_at || t.updated_at, s.tz)}</small>
              </button>;
            })}
          </div>
        </Section>}
  </div>;
}

function Welcome() {
  const s = useStore();
  return <section className="welcome">
    <Sparkles size={26} className="welcome-ico" />
    <h2>从一句话开始</h2>
    <ol className="welcome-steps">
      <li><b>说出你想做的事</b>不用选模型、难度或执行者。</li>
      <li><b>交给规划 Agent 规划</b>复制规划请求给规划 Agent，它会拆成任务并选好执行者。</li>
      <li><b>把执行单发给 Agent</b>做完后，成果会回到这里，由你试用确认。</li>
    </ol>
    <button className="btn primary" onClick={() => s.openDialog('request')}>提第一个需求</button>
  </section>;
}

function ProjectTag({ name }: { name: string }) {
  return <span className="active-project" title={name}><Folder size={13} aria-hidden="true" /><span>{name}</span></span>;
}

function TurnContext({ projectId, agentId, role }: { projectId: string; agentId: string; role: '执行' | '规划' | '审查' }) {
  const s = useStore();
  return <div className="turn-context">
    <ProjectTag name={s.pname(projectId)} />
    <span className="turn-agent" title={`${role}：${s.name(agentId)}`}>
      <AgentIcon name={s.name(agentId)} id={s.agentIconId(agentId)} size={24} />
      <span><span className="turn-agent-role">{role}</span>{s.name(agentId)}</span>
    </span>
  </div>;
}

function TaskTurn({ t, compact }: { t: R; compact?: boolean }) {
  const s = useStore();
  const who = s.executorOf(t);
  const relay = relayOf(t, s.name, who);
  const handingToReviewer = t.status === 'submitted' && !reviewSkippedTask(t) && !!t.reviewer_id;
  const open = () => s.openTask(t.id);
  let actions: React.ReactNode;
  if (t.status === 'ready') actions = <button className="btn primary" disabled={s.busy} onClick={() => void copyOrder(s, t)}><Copy size={16} />生成并复制执行单</button>;
  else if (t.status === 'awaiting_dispatch') actions = <>
    <button className="btn primary" disabled={s.busy} onClick={() => void copyOrder(s, t)}><Copy size={16} />复制执行单</button>
  </>;
  else if (t.status==='changes_requested') actions=<button className="btn primary" disabled={s.busy} onClick={()=>void continueTask(s,t)}>原会话继续返修</button>;
  else if (['waiting_input','closeout_waiting_input'].includes(t.status)&&t.question_answered)actions=<button className="btn primary" disabled={s.busy} onClick={()=>void continueTask(s,t)}>把答复交回原会话</button>;
  else if (['waiting_input','closeout_waiting_input'].includes(t.status)) actions = <button className="btn primary" onClick={open}><MessageCircleQuestion size={16} />去回答</button>;
  else if(['submitted','in_review'].includes(t.status)&&!['completed','awaiting_decision'].includes(t.review_stage)&&!reviewSkippedTask(t))actions=<button className="btn primary" disabled={s.busy} onClick={()=>void copyReviewHandoff(s,t)}><Copy size={16}/>交给审查者</button>;
  else if(['submitted','in_review'].includes(t.status)&&t.review_stage==='awaiting_decision')actions=<button className="btn primary" onClick={open}>查看审查意见</button>;
  else if(['in_review','awaiting_closeout'].includes(t.status))actions=<button className="btn primary" disabled={s.busy} onClick={()=>void continueTask(s,t)}><Copy size={16}/>原会话继续收尾</button>;
  else if(t.status==='submitted')actions=<button className="btn primary" disabled={s.busy} onClick={()=>void continueTask(s,t)}>继续收尾</button>;
  else if(t.status==='acceptance_rejected')actions=<button className="btn primary" disabled={s.busy} onClick={()=>void copyRework(s,t)}><Copy size={16}/>复制返工要求</button>;
  else if (['awaiting_confirmation'].includes(t.status)) actions = <button className="btn primary" disabled={s.busy} onClick={()=>void openTrial(s,t)}><CircleCheckBig size={16} />去试用确认</button>;
  else actions = <button className="btn primary" onClick={open}><LifeBuoy size={16} />看看怎么处理</button>;

  return <article className={'turn clickable t-' + relay.tone + (compact ? ' compact' : '')} aria-label={t.title} onClick={e => { if (!(e.target as HTMLElement).closest('button')) open(); }}>
    <div className="turn-heading">
      <TurnContext projectId={t.project_id} agentId={handingToReviewer ? t.reviewer_id : who} role={handingToReviewer ? '审查' : '执行'} />
      <div className="turn-top">
        <Pill task={t} />
        <OrderStep task={t}/>

      </div>
    </div>
    <button className="turn-title" onClick={open}>{t.title}</button>
    <p className="turn-next">{relay.next}</p><ReviewLanes relay={relay}/>
    <div className="turn-actions">{actions}{!['ready','awaiting_dispatch'].includes(t.status)&&<TaskQuickActions task={t} trial={false} review={false}/>}</div>
  </article>;
}

function RequestTurn({ q }: { q: R }) {
  const s = useStore();
  const relay = requestRelay();
  return <article className="turn t-you" aria-label={q.text}>
    <div className="turn-heading">
      <TurnContext projectId={q.project_id} agentId="codex" role="规划" />
      <div className="turn-top">
        <Pill tone="you">{requestStatusText.awaiting_planning}</Pill>
        <span className="turn-meta">{relative(q.created_at, s.tz)}提出</span>
      </div>
    </div>
    <RequestPreview request={q} className="turn-title as-text"/>
    <p className="turn-next">{relay.next}</p>
    <div className="turn-actions">
      <button className="btn primary" disabled={s.busy} onClick={() => void copyPlanning(s, q)}><Copy size={16} />复制规划请求</button>
      <button className="btn" onClick={() => s.openDialog('import-plan')}><ClipboardPaste size={16} />粘贴规划 Agent 的计划</button>
      <RequestMoreActions q={q}/>
    </div>
  </article>;
}

/** 接下来的订阅节点：计划事件与已知到期日，按日期排序；按计划显示提醒。 */
export function upcomingItems(data: R, tz: string) {
  const items: { id: string; date: string; title: string; kind: string; days: number | null }[] = [];
  for (const sub of data.subscriptions as R[]) {
    if (sub.source === 'token_monitor') continue;
    if (sub.status === 'planned' && !sub.confirmed_at && sub.planned_date) items.push({ id: sub.id, date: sub.planned_date, title: sub.title, kind: '计划', days: daysUntil(sub.planned_date, tz) });
    else if (['user_reported_active', 'user_confirmed_active'].includes(sub.status) && sub.end_date) items.push({ id: sub.id + ':end', date: sub.end_date, title: sub.title + ' 到期', kind: '到期', days: daysUntil(sub.end_date, tz) });
  }
  return items.filter(i => i.days === null || i.days > -30).sort((a, b) => a.date.localeCompare(b.date));
}

function Upcoming() {
  const s = useStore();
  const items = upcomingItems(s.data, s.tz).slice(0, 4);
  return <section className="side-card" aria-label="接下来的日程">
    <div className="side-card-head"><CalendarClock size={17} /><h2>接下来的日程</h2><button className="link" onClick={() => s.go({ page: 'resources', tab: 'plans' })}>全部</button></div>
    {items.length ? <ul className="agenda">
      {items.map(i => <li key={i.id} className={i.days !== null && i.days < 0 ? 'overdue' : i.days !== null && i.days <= 14 ? 'soon' : ''}>
        <span className="agenda-when"><b>{dayCountText(i.days)}</b><small>{plainDay(i.date)}</small></span>
        <span className="agenda-what">{i.title}<small>{i.kind === '计划' ? '你的计划，尚未确认发生' : '你登记的到期日'}</small></span>
      </li>)}
    </ul> : <p className="muted small">没有登记日期的订阅计划。</p>}
  </section>;
}

function QuotaGlance() {
  const s = useStore();
  const { data } = s;
  const tm = data.integrations.find((i: R) => i.id === 'tokenMonitor');
  const connected = tm?.status === 'connected';
  const rows: { id: string; name: string; label: string; value: number; stale: boolean; recent: boolean; sourceLabel:string }[] = [];
  const dayAgo = Date.now() - 86400000;
  for (const p of data.quota_pools as R[]) {
    if ((p.source !== 'token_monitor' && !p.cache_editable&&!p.custom_quota&&!p.points_editable) || p.status === 'notConfigured' || p.status === 'planned') continue;
    for (const w of (data.quota_windows as R[]).filter(w => w.pool_id === p.id)) {
      const v = quotaPercent(w);
      const source=w.source||p.source,stale=(w.freshness||p.freshness)==='stale'||source==='token_monitor'&&!connected;
      if (v !== null) rows.push({ id: w.id, name: p.name, label: windowLabel(w), value: v, stale, recent: p.cache_editable || p.custom_quota || Date.parse(w.source_updated_at||p.source_updated_at||'')>dayAgo, sourceLabel:source==='user_entered'?'手动记录':stale?'上次记录':'' });
    }
  }
  const freshRows = rows.filter(r => !r.stale);
  const showingOld = !freshRows.length;
  const fresh = (showingOld ? rows.filter(r => r.recent) : freshRows).sort((a, b) => a.value - b.value).slice(0, 4);
  const balances = (data.quota_pools as R[]).filter(p => p.balance && p.source === 'token_monitor' && !['planned','notConfigured'].includes(p.status) && (showingOld ? Date.parse(p.source_updated_at || '') > dayAgo : p.freshness !== 'stale')).slice(0, 2);
  return <section className="side-card" aria-label="额度概况">
    <div className="side-card-head"><Gauge size={17} /><h2>额度概况</h2><button className="link" onClick={() => s.go({ page: 'resources' })}>全部</button></div>
    {fresh.length ? <div className="glance">
      {fresh.map(r => <div key={r.id} className="glance-row">
        <span>{r.name}<small>{r.label}{r.sourceLabel && ` · ${r.sourceLabel}`}</small></span>
        <span className={'meter m-' + (r.value <= 15 ? 'low' : r.value <= 35 ? 'mid' : 'ok') + (r.stale ? ' old' : '')} role="img" aria-label={`${r.name}${r.label}剩余 ${Math.round(r.value)}%`}><i style={{ width: r.value + '%' }} /></span>
        <b>{Math.round(r.value)}%</b>
      </div>)}
      {balances.map(p => <div key={p.id} className="glance-row bal"><span>{p.name}<small>账户余额</small></span><b>{p.balance.amount ?? '未知'} {p.balance.currency}</b></div>)}
    </div> : <p className="muted small">{connected ? '暂时没有可计算的额度窗口。' : 'Token Monitor 未连接，暂无额度数据。'}</p>}
  </section>;
}

function Connections() {
  const s = useStore();
  return <section className="side-card" aria-label="数据连接">
    <div className="side-card-head"><PlugZap size={17} /><h2>数据连接</h2><button className="link" onClick={() => s.go({ page: 'resources', tab: 'connections' })}>管理</button></div>
    <ul className="conn-list">
      {s.data.integrations.map((i: R) => <li key={i.id} className={'c-' + i.status}>
        <i /><span>{i.name}<small>{i.status === 'connected' ? `已连接 · ${relative(i.last_success, s.tz)}读取` : i.status === 'not_connected' ? '未连接' : i.last_success ? `连接中断 · 最近成功 ${relative(i.last_success, s.tz)}` : '连接中断'}</small></span>
      </li>)}
    </ul>
  </section>;
}

export function windowLabel(w: R): string {
  if(w.monthly)return '月度基础积分';
  if (w.label) return String(w.label).replace(/5-hour/gi, '5 小时').replace(/weekly/gi, '每周').replace(/monthly/gi, '每月').replace(/daily/gi, '每日').replace(/balance/gi, '余额').replace(/session/gi, '会话');
  return ({ session: '会话窗口', weekly: '每周', billing: '计费周期' } as R)[w.kind] || '额度';
}

// 团队：每位 Agent 擅长什么、手里有什么、最近一次能观测到的会话活动。
import React,{useState} from 'react';
import { Copy, PencilLine, ArrowLeft, Plus, Trash2, RotateCcw, Search } from 'lucide-react';
import {api} from '../api.js';
import { useStore } from '../app/store.js';
import { type R, isTheirTurn, isYourTurn, byUrgency } from '../lib/flow.js';
import { relative } from '../lib/format.js';
import { Empty, Section, Notice, Tabs } from '../ui/kit.js';
import { AgentIcon } from '../ui/AgentIcon.js';
import { TaskRow } from './Projects.js';
import { isModelRetired } from '../../shared/model-policy.js';
import {ExecutionList} from '../ui/ExecutionOrder.js';
import {waitingForDependencies} from '../../shared/execution-order.js';

function agentStats(s: ReturnType<typeof useStore>, a: R) {
  const tasks = (s.data.tasks as R[]).filter(t=>!s.data.projects.some((p:R)=>p.id===t.project_id&&(p.shelved||p.archived)));
  const member = (id: string) => (s.data.agents as R[]).find(x => x.id === id)?.merged_into || id;
  const mine = tasks.filter(t => member(s.executorOf(t)) === a.id);
  const sessions = (s.data.sessions as R[]).filter(x => member(x.agent) === a.id);
  const last = sessions.map(x => String(x.updated_at || '')).sort().pop();
  return {
    mine,
    doing: mine.filter(t => isTheirTurn(t) && t.status !== 'submitted'),
    waiting: mine.filter(t=>isYourTurn(t)&&!['ready','awaiting_dispatch'].includes(t.status)).sort(byUrgency),
    queue:mine.filter(t=>['ready','awaiting_dispatch'].includes(t.status)&&!waitingForDependencies(t)&&!isTheirTurn(t)),
    later:mine.filter(waitingForDependencies),
    delivered: mine.filter(t => t.status === 'submitted' && !isYourTurn(t)),
    toReview: tasks.filter(t => member(t.reviewer_id) === a.id && ['submitted', 'changes_requested'].includes(t.status)),
    done: mine.filter(t => t.status === 'accepted'),
    sessions: sessions.length,
    last,
  };
}

export function Team() {
  const s = useStore();
  const agents = (s.data.agents as R[]).filter(a => !a.archived);
  const routeId = (s.data.agents as R[]).find(a => a.id === s.route.id)?.merged_into || s.route.id;
  const selected = agents.find(a => a.id === routeId);
  return <div className="page-wrap">
    <header className="page-head"><div><h1>团队</h1><p>谁擅长什么、手里有什么。规划 Agent 会按这些分工选人。</p></div><button className="btn primary" onClick={()=>s.openDialog('agent-add')}><Plus size={16}/>新增团队</button></header>
    <Tabs label="团队管理" value={s.route.tab||'mine'} onChange={tab=>s.go({page:'team',tab})} tabs={[[ 'mine','我的团队'],['presets','预设库'],['removed','已移除']]}/>
    {s.route.tab==='presets'?<PresetLibrary/>:s.route.tab==='removed'?<RemovedAgents/>:<>
    <div className={'team' + (selected ? ' has-pick' : '')}>
      <div className="agent-grid" role="list" aria-label="Agent 列表">
        {agents.map(a => {
          const st = agentStats(s, a);
          return <button role="listitem" key={a.id} className={'agent-card' + (selected?.id === a.id ? ' on' : '')} onClick={() => s.go({ page: 'team', id: a.id })} aria-label={a.name}>
            <AgentIcon name={a.name} id={a.icon_key||a.id} size={40} />
            <span className="ac-body">
              <strong>{a.name}</strong>
              <small className="ac-scope">{a.scope}</small>
              <span className="ac-stats">
                {st.doing.length > 0 && <span className="t-working">在做 {st.doing.length}</span>}
                {st.waiting.length > 0 && <span className="t-you">等你 {st.waiting.length}</span>}
                {st.queue.length>0&&<span className="t-you">待执行 {st.queue.length}</span>}
                {st.later.length>0&&<span className="quiet">等前序 {st.later.length}</span>}
                {st.toReview.length > 0 && <span className="t-review">待审 {st.toReview.length}</span>}
                <span className="quiet">完成 {st.done.length}</span>
              </span>
              <small className="ac-last">{st.last ? `最近会话 ${relative(st.last, s.tz)}` : '暂无会话记录'}</small>
            </span>
          </button>;
        })}
      </div>
      {selected ? <AgentPanel a={selected} /> : <aside className="agent-panel placeholder"><Empty title="选一位成员">看看它的分工、手里的任务和审查安排。</Empty></aside>}
    </div>
    </>}
  </div>;
}

function AgentPanel({ a }: { a: R }) {
  const s = useStore();
  const st = agentStats(s, a);
  const accounts = (a.account_ids || []).map((id: string) => (s.data.accounts as R[]).find(x => x.id === id)?.name || id);
  const catalog = (s.data.model_catalog || []).find((g:R) => g.agent_id === a.id);
  return <aside className="agent-panel" aria-label={a.name + ' 详情'}>
    <button className="crumb team-back" onClick={() => s.go({ page: 'team' })}><ArrowLeft size={15} />全部成员</button>
    <div className="ap-head">
      <AgentIcon name={a.name} id={a.icon_key||a.id} size={52} />
      <div><h2>{a.name}</h2><p className="muted">分工与模型</p></div>
      <button className="btn small" onClick={() => s.openDialog('agent-edit', { agent: a })}><PencilLine size={15} />编辑分工</button>
      <button className="icon-btn" title="删除成员" aria-label={'删除 '+a.name} onClick={()=>s.openDialog('resource-remove',{kind:'agent',item:a})}><Trash2 size={15}/></button>
    </div>
    <dl className="facts">
      <dt>适合做</dt><dd>{a.scope}</dd>
      <dt>使用的账号</dt><dd>{accounts.join('、') || '未登记'}</dd>
      <dt>最近会话</dt><dd>{st.last ? `${relative(st.last, s.tz)} · 共 ${st.sessions} 个` : '暂无记录'}</dd>
    </dl>
    <button className="btn" onClick={() => void s.copy(`请使用工作台 MCP 的 get_dispatch_context，查看 ${a.name} 的分工、任务队列、额度和模型列表，判断它现在适合接什么工作。`, `评估请求已复制，发给规划 Agent 即可`)}><Copy size={16} />问规划 Agent：它现在适合接什么</button>
    {catalog && <Section title="模型与建议用途" aside={<button className="link" onClick={()=>s.openDialog('agent-edit',{agent:a,modelsOpen:true})}><PencilLine size={14}/>编辑模型</button>}>
      <div className="model-list">{catalog.models.map((m:R) => {
        const retired = isModelRetired(m,s.tz);
        return <div className="model-row" key={m.id}><div><strong>{m.name}{m.kind === 'mode' && <small> · 模式</small>}</strong><p>{m.purpose}</p>{m.access && <small className="muted">{retired ? '已下线' : m.access}</small>}</div>
          <button className="icon-btn" disabled={!!retired} title={`复制 ${m.name} 派单要求`} aria-label={`复制 ${m.name} 派单要求`} onClick={() => void s.copy(`请使用工作台 MCP 规划我的下一项需求。执行者：${a.name}（${a.id}）；指定${m.kind === 'mode' ? '模式' : '模型'}：${m.name}；submit_task_plan 的 requested_model 填写 ${JSON.stringify(m.id)}。先读取 get_dispatch_context 和项目上下文，再结合任务、职责和资源规划。`, '派单要求已复制，发给规划 Agent 并补充需求即可')}><Copy size={15}/></button></div>;
      })}</div>
      {!catalog.models.length&&<p className="muted small">由执行者选择。你也可以添加常用模型。</p>}
      {!!catalog.sources.length&&<details className="model-source"><summary>资料来源 · {catalog.as_of} 更新</summary>{catalog.sources.map((url:string,i:number)=><a key={url} href={url} target="_blank" rel="noreferrer">官方资料 {i+1}</a>)}</details>}
    </Section>}

    {st.queue.length>0&&<Section title="执行队列" label="执行队列"><ExecutionList tasks={st.queue} queue/></Section>}
    {st.later.length>0&&<Section title="等待前序" label="等待前序"><ExecutionList tasks={st.later} queue/></Section>}
    {st.waiting.length > 0 && <Section title="等你处理"><div className="row-list">{st.waiting.map(t => <TaskRow key={t.id} t={t} />)}</div></Section>}
    {st.doing.length > 0 && <Section title="正在做"><div className="row-list">{st.doing.map(t => <TaskRow key={t.id} t={t} />)}</div></Section>}
    {st.delivered.length > 0 && <Section title="已交付，等审查"><div className="row-list">{st.delivered.map(t => <TaskRow key={t.id} t={t} />)}</div></Section>}
    {st.toReview.length > 0 && <Section title="等它审查别人的成果"><div className="row-list">{st.toReview.map(t => <TaskRow key={t.id} t={t} />)}</div></Section>}
    {st.mine.filter(t => ['accepted', 'cancelled', 'rework_linked'].includes(t.status)).length > 0 && <Section title="已经结束">
      <div className="row-list">{st.mine.filter(t => ['accepted', 'cancelled', 'rework_linked'].includes(t.status)).sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at))).slice(0, 8).map(t => <TaskRow key={t.id} t={t} />)}</div>
    </Section>}
    {!st.mine.length && !st.toReview.length && <Notice>还没有分配给 {a.name} 的任务。</Notice>}
  </aside>;
}

function PresetLibrary(){
 const s=useStore(),[query,setQuery]=useState(''),[region,setRegion]=useState('全部'),[category,setCategory]=useState('全部');
 const all=s.data.agent_presets||[],mine=(s.data.agents as R[]).filter(a=>!a.archived),removed=(s.data.agents as R[]).filter(a=>a.archived&&a.managed_archived);
 const items=all.filter((p:R)=>(region==='全部'||p.region===region)&&(category==='全部'||p.category===category)&&[p.name,p.scope,p.id].join(' ').toLowerCase().includes(query.toLowerCase().trim()));
 return <section aria-label="Agent 预设库"><div className="library-tools"><label className="library-search"><Search size={16}/><input aria-label="搜索预设" placeholder="搜索工具或用途" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="预设地区" value={region} onChange={e=>setRegion(e.target.value)}>{['全部','国内','国际'].map(v=><option key={v} value={v}>{v==='全部'?'所有地区':v}</option>)}</select><select aria-label="预设用途" value={category} onChange={e=>setCategory(e.target.value)}>{['全部','开发','办公'].map(v=><option key={v} value={v}>{v==='全部'?'所有用途':v}</option>)}</select></div>
 <p className="muted small">{all.length} 个常用工具 · 选好后加入你的团队，分工和模型都可以再调整。</p>
 <div className="preset-grid">{items.map((p:R)=>{const added=mine.some(a=>a.preset_id===p.id||a.id===p.existing_id),prior=removed.find(a=>a.preset_id===p.id||a.id===p.existing_id);return <article className="preset-card" key={p.id}><header><AgentIcon name={p.name} id={p.icon_key} size={36}/><div><strong>{p.name}</strong><small>{p.region} · {p.category}</small></div></header><p>{p.scope}</p><footer><a href={p.sources[0]} target="_blank" rel="noreferrer">官方介绍</a><button className="btn small" disabled={added||s.busy} onClick={()=>prior?void s.act(()=>api('/agents/'+prior.id+'/restore',{version:prior.version}),'已恢复成员'):s.openDialog('agent-add',{preset:p})}>{added?'已在团队':prior?'恢复到团队':'添加到团队'}</button></footer></article>})}</div>{!items.length&&<Empty title="没有找到这个工具">可以点右上角“新增团队”添加。</Empty>}</section>;
}
function RemovedAgents(){
 const s=useStore(),items=(s.data.agents as R[]).filter(a=>a.archived&&a.managed_archived);
 return <section aria-label="已移除成员">{!items.length?<Empty title="暂无已移除成员">从团队里移除的成员会放在这里，他们的历史任务都保留，随时可以恢复。</Empty>:<div className="preset-grid">{items.map(a=><article className="preset-card" key={a.id} aria-label={a.name}>
   <header><AgentIcon name={a.name} id={a.icon_key||a.id} size={36}/><div><strong>{a.name}</strong><small>已移除</small></div></header>
   <p>{a.scope}</p>
   <footer><span/><button disabled={s.busy} className="btn small" onClick={()=>void s.act(()=>api('/agents/'+a.id+'/restore',{version:a.version}),'已恢复成员')}><RotateCcw size={14}/>恢复到团队</button></footer>
 </article>)}</div>}</section>;
}

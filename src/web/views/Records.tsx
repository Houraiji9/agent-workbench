// 记录：在任务与 Agent 会话里找东西；需要时再去 AgentsView 搜完整对话内容。
import React, { useEffect, useRef, useState } from 'react';
import { Search, X, FileSearch } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { type R, statusText } from '../lib/flow.js';
import { relative } from '../lib/format.js';
import { Pill, Empty, Section, Notice } from '../ui/kit.js';
import { agentLabel } from './dialogs/ResourceDialogs.js';

const statusOptions = ['ready', 'awaiting_dispatch', 'dispatched', 'running', 'waiting_input', 'blocked', 'changes_requested', 'acceptance_rejected', 'rework_linked', 'submitted', 'awaiting_confirmation', 'in_review','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked', 'accepted', 'failed', 'cancelled'];

export function Records() {
  const s = useStore();
  const { data } = s;
  const [query, setQuery] = useState(() => (s.route.id === 'q' ? s.route.tab || '' : data.sessions.find((x:R)=>x.id===s.route.id)?.native_id||''));
  const [kind, setKind] = useState<'all' | 'task' | 'session'>('all');
  const [filters, setFilters] = useState<R>({});
  const [items, setItems] = useState<R[] | null>(null);
  const [localError, setLocalError] = useState('');
  const [loadedCondition, setLoadedCondition] = useState('');
  const [total, setTotal] = useState(0);
  const [reload, setReload] = useState(0);
  const [visible, setVisible] = useState(30);
  const [external, setExternal] = useState<R | null>(null);
  const [extError, setExtError] = useState('');
  const [extBusy, setExtBusy] = useState(false);
  const seq = useRef(0), extSeq = useRef(0);
  const condition = JSON.stringify({ query, filters, kind });
  const conditionRef = useRef(condition);
  conditionRef.current = condition;

  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      api('/history?' + new URLSearchParams({ ...filters, query, kind, limit: '100' })).then(r => {
        if (n === seq.current) { setItems(r.items); setTotal(r.total ?? r.items.length); setLocalError(''); setLoadedCondition(condition); }
      }).catch(e => {
        if (n === seq.current) { setItems([]); setLocalError((e as Error).message); setLoadedCondition(condition); }
      });
    }, 180);
    return () => { clearTimeout(t); seq.current++; };
  }, [condition, data, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    extSeq.current++; setExternal(null); setExtError(''); setExtBusy(false); setVisible(30);
    return () => { extSeq.current++; };
  }, [condition]);

  const searchExternal = async (cursor?: number) => {
    const n = ++extSeq.current, at = conditionRef.current;
    setExtBusy(true); setExtError('');
    try {
      const r = await api('/history/external?' + new URLSearchParams({ query, agent: filters.agent || '', from: filters.from || '', to: filters.to || '', ...(cursor != null ? { cursor: String(cursor) } : {}) }));
      if (n === extSeq.current && at === conditionRef.current) setExternal(r);
    } catch (e) {
      const msg = (e as Error).message;
      if (n === extSeq.current && at === conditionRef.current) setExtError(/未连接/.test(msg) ? 'AgentsView 没有连接，暂时不能搜索完整对话（上面的任务和会话摘要仍可正常查找）。可以到“额度与订阅 › 数据连接”检查。' : msg);
    }
    finally { if (n === extSeq.current) setExtBusy(false); }
  };

  const set = (k: string, v: string) => setFilters(f => { const n = { ...f }; if (v) n[k] = v; else delete n[k]; return n; });
  const externalAgents = [...new Set<string>((data.sessions as R[]).map(x => x.agent))].filter(id => !(data.agents as R[]).some(a => a.id === id));
  const shown = items || [];
  const active = Object.keys(filters).length > 0 || query;

  return <div className="page-wrap">
    <header className="page-head"><div><h1>记录</h1><p>所有任务和收录的 Agent 会话都能在这里找到，每条都标着出处。</p></div></header>
    <div className="search-panel">
      <div className="search-big">
        <Search size={19} />
        <input id="records-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="输入关键词：任务名、会话标题、编号都可以" aria-label="搜索记录" />
        {query && <button className="icon-btn" aria-label="清空搜索" onClick={() => setQuery('')}><X size={17} /></button>}
      </div>
      <div className="filter-row">
        <div className="seg small" role="radiogroup" aria-label="记录类型">
          {([['all', '全部'], ['task', '任务'], ['session', '会话']] as const).map(([k, l]) => <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        <select aria-label="按项目" value={filters.project_id || ''} onChange={e => set('project_id', e.target.value)}>
          <option value="">所有项目</option>{(data.projects as R[]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label="按成员" value={filters.agent || ''} onChange={e => set('agent', e.target.value)}>
          <option value="">所有成员</option>{(data.agents as R[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          {externalAgents.map(id => <option key={id} value={id}>{agentLabel(s.name, id)}（外部会话）</option>)}
        </select>
        <select aria-label="按状态" value={filters.status || ''} onChange={e => set('status', e.target.value)}>
          <option value="">所有状态</option>{statusOptions.map(k => <option key={k} value={k}>{k==='submitted'?'已交付（待审 / 审查中）':statusText[k]}</option>)}
        </select>
        <label className="date-pick"><span>从</span><input type="date" aria-label="开始日期" value={filters.from || ''} onChange={e => set('from', e.target.value)} /></label>
        <label className="date-pick"><span>到</span><input type="date" aria-label="结束日期" value={filters.to || ''} onChange={e => set('to', e.target.value)} /></label>
        {active && <button className="link" onClick={() => { setFilters({}); setQuery(''); }}>清除条件</button>}
      </div>
    </div>

    <section aria-label="记录列表">
      {items === null || loadedCondition !== condition ? <p className="muted">正在查找…</p> : localError ? <Notice tone="error">当前条件的记录没有读取成功：{localError}
        <span className="notice-actions"><button className="btn small" onClick={() => { setItems(null); setReload(n => n + 1); }}>重新查找</button></span>
      </Notice> : shown.length ? <>
        <p className="muted small result-count">找到 {total} 条{total > shown.length ? '（先显示最近 100 条，可以加条件缩小范围）' : ''}</p>
        <div className="row-list">{shown.slice(0, visible).map(r => <button key={r.kind + r.id} className="row" onClick={() => r.kind === 'task' ? s.openTask(r.id) : s.openDialog('session', { session: r })}>
          <span className={'kind-tag k-' + r.kind}>{r.kind === 'task' ? '任务' : '会话'}</span>
          <span className="row-main"><strong>{r.title}</strong><small>{agentLabel(s.name, r.agent)} · {r.project_id ? s.pname(r.project_id) : r.source_project ? r.source_project + '（未登记）' : '未关联项目'} · {relative(r.updated_at || r.created_at, s.tz)}</small></span>
          <span className="row-side">{r.kind === 'task' ? <Pill task={s.data.tasks.find((t:R)=>t.id===r.id)||r} /> : <Pill tone="quiet">{r.association === 'pending_confirmation' ? '仅摘要' : '已关联'}</Pill>}</span>
        </button>)}</div>
        {shown.length > visible && <button className="btn ghost more-btn" onClick={() => setVisible(v => v + 30)}>再显示 {Math.min(30, shown.length - visible)} 条</button>}
      </> : <Empty icon={<FileSearch size={28} />} title="没有找到匹配的记录">{active ? '换个关键词或去掉一些条件试试。' : '任务和收录的会话会出现在这里。'}</Empty>}
    </section>

    <Section title="在完整对话里搜索" label="在完整对话里搜索">
      <p className="muted small">上面只搜任务内容和会话开头摘要。要找对话中间说过的话，可以去 AgentsView 搜索全文。</p>
      <div className="now-actions">
        <button className="btn" disabled={!query.trim() || extBusy} onClick={() => void searchExternal()}><Search size={16} />{extBusy ? '正在搜索…' : query.trim() ? `在 AgentsView 里搜“${query.trim().slice(0, 20)}”` : '先在上面输入关键词'}</button>
      </div>
      {extError && <Notice tone="error">{extError}</Notice>}
      {external && <div className="snippets">
        {external.items.length ? external.items.map((m: R, i: number) => <article key={i} className="snippet">
          <strong>{m.title}</strong><p>{m.snippet}</p><small>{m.source_project || '未知项目'} · 第 {m.ordinal} 条消息 · <code>{m.native_id}</code></small>
        </article>) : <p className="muted">AgentsView 里没有找到。</p>}
        {external.next_cursor != null && <button className="btn ghost" disabled={extBusy} onClick={() => void searchExternal(external.next_cursor)}>下一页结果</button>}
      </div>}
    </Section>
  </div>;
}

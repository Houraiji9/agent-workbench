// Agent 手册、订阅编辑、订阅实际发生，以及外部会话（AgentsView）详情。
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useStore } from '../../app/store.js';
import { type R, statusText } from '../../lib/flow.js';
import { fullDate, relative } from '../../lib/format.js';
import { Dialog, Field, Notice } from '../../ui/kit.js';
import { useSubmit } from './useSubmit.js';

const Foot = ({ onClose, saving, label }: { onClose(): void; saving: boolean; label: string }) => <footer className="dialog-foot inline">
  <button type="button" className="btn ghost" onClick={onClose}>取消</button>
  <button type="submit" className="btn primary" disabled={saving}>{saving ? '正在保存…' : label}</button>
</footer>;

export function AgentEditDialog({ agent, onClose }: { agent: R; onClose(): void }) {
  const [a] = useState(agent);
  const [scope, setScope] = useState(a.scope);
  const [restriction, setRestriction] = useState(a.restriction);
  const [model, setModel] = useState(a.model || '');
  const { error, saving, run } = useSubmit();
  return <Dialog title={`编辑 ${a.name} 的分工`} sub="规划者派活时会读这些说明。" onClose={onClose} label="编辑分工">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/baseline/agents/' + a.id, { version: a.version, changes: { scope, restriction, model: model.trim() || null } }), '分工说明已更新'); }}>
      <Field label="适合做什么"><textarea data-autofocus required rows={3} maxLength={10000} value={scope} onChange={e => setScope(e.target.value)} /></Field>
      <Field label="分工备注"><textarea required rows={3} maxLength={10000} value={restriction} onChange={e => setRestriction(e.target.value)} /></Field>
      <Field label="常用模型备注（可选）"><input maxLength={200} value={model} onChange={e => setModel(e.target.value)} /></Field>
      
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="保存" />
    </form>
  </Dialog>;
}

export function SubscriptionEditDialog({ subscription, kind, onClose }: { subscription?: R; kind?: string; onClose(): void }) {
  const s = useStore();
  const [sub] = useState(subscription || { status: kind === 'plan' ? 'planned' : 'user_reported_active' });
  const creating = !sub.id;
  const planned = sub.status === 'planned';
  const [v, setV] = useState({
    title: sub.title || '', note: sub.note || '', end_date: sub.end_date || '', planned_date: sub.planned_date || '',
    amount: sub.amount ?? '', currency: sub.currency || '', interval: sub.interval || '',
    auto_renew: sub.auto_renew == null ? '' : String(sub.auto_renew), estimated_points: sub.estimated_points ?? '',
    status: sub.status, account_id: sub.account_id || '',
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const { error, saving, run } = useSubmit();
  const title = creating ? (planned ? '添加安排' : '添加订阅') : (planned ? '编辑订阅计划' : '编辑订阅记录');
  return <Dialog title={title} sub="记录订阅信息和接下来的安排。" onClose={onClose} label="编辑订阅">
    <form className="form subscription-form" onSubmit={e => { e.preventDefault();
      const changes = {
        title: v.title, note: v.note, end_date: v.end_date || null, planned_date: v.planned_date || null,
        amount: v.amount === '' ? null : Number(v.amount), currency: v.currency || null, interval: v.interval || null,
        auto_renew: v.auto_renew === '' ? null : v.auto_renew === 'true',
        estimated_points: v.estimated_points === '' ? null : Number(v.estimated_points),
        ...(!planned && v.status !== sub.status ? { status: v.status } : {}),
      };
      void run(() => creating ? api('/subscriptions', { ...changes, status: v.status, account_id: v.account_id || null }) : api('/baseline/subscriptions/' + sub.id, { version: sub.version, changes }), creating ? (planned ? '安排已添加' : '订阅已添加') : planned ? '计划已更新' : '订阅记录已更新'); }}>
      <Field label="名称"><input data-autofocus required maxLength={200} value={v.title} onChange={set('title')} /></Field>
      {creating && <Field label="关联账号（可选）"><select value={v.account_id} onChange={set('account_id')}><option value="">暂不关联</option>{(s.data.accounts as R[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
      {!planned && <Field label="当前状态"><select value={v.status} onChange={set('status')}>{sub.status === 'user_confirmed_active' && <option value="user_confirmed_active">已确认生效</option>}<option value="user_reported_active">正在使用</option><option value="user_reported_expired">已过期 / 已停用</option></select></Field>}
      <div className="grid-2">
        <Field label={planned ? '计划日期' : '结束日期'}>
          {planned ? <input type="date" value={v.planned_date} onChange={set('planned_date')} /> : <input type="date" value={v.end_date} onChange={set('end_date')} />}
        </Field>
        <Field label="续费安排"><select value={v.auto_renew} onChange={set('auto_renew')}><option value="">还没决定 / 不清楚</option><option value="true">打算续费</option><option value="false">不续费</option></select></Field>
        <Field label="金额"><input type="number" min="0" max="1000000000" step="0.01" value={v.amount} onChange={set('amount')} placeholder="不知道就留空" /></Field>
        <Field label="币种"><input placeholder="如 USD、CNY" maxLength={3} pattern="[A-Z]{3}" value={v.currency} onChange={e => setV({ ...v, currency: e.target.value.toUpperCase() })} /></Field>
        <Field label="计费周期"><select value={v.interval} onChange={set('interval')}><option value="">不清楚</option><option value="month">每月</option><option value="year">每年</option><option value="once">一次性</option></select></Field>
        <Field label="估算剩余积分"><input placeholder="个人估算，可留空" type="number" min="0" step="1" value={v.estimated_points} onChange={set('estimated_points')} /></Field>
      </div>
      <Field label="备注"><textarea rows={3} maxLength={10000} value={v.note} onChange={set('note')} /></Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label={creating ? '添加' : '保存'} />
    </form>
  </Dialog>;
}

export function SubscriptionDeleteDialog({ subscription, onClose }: { subscription: R; onClose(): void }) {
  const [sub] = useState(subscription);
  const planned = sub.status === 'planned';
  const { error, saving, run } = useSubmit();
  return <Dialog title={planned ? '删除这项安排？' : '删除这条订阅？'} sub={sub.title} onClose={onClose}>
    <p>将删除工作台里的这条{planned ? '安排' : '订阅登记'}。{planned && sub.confirmed_at ? '已经记录的实际发生情况会保留。' : ''}</p>
    {error && <Notice tone="error">{error}</Notice>}
    <footer className="dialog-foot inline"><button className="btn ghost" onClick={onClose}>取消</button><button className="btn danger" disabled={saving} onClick={() => void run(() => api('/subscriptions/' + sub.id + '/delete', { version: sub.version }), planned ? '安排已删除' : '订阅登记已删除')}>{saving ? '正在删除…' : '确认删除'}</button></footer>
  </Dialog>;
}

function localIso(): string {
  const d = new Date(), off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SubscriptionConfirmDialog({ subscription, onClose }: { subscription: R; onClose(): void }) {
  const [sub] = useState(subscription);
  const [when, setWhen] = useState(localIso());
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const { error, saving, run } = useSubmit();
  return <Dialog title="记录：这件事已经发生" sub={sub.title} onClose={onClose} label="记录实际发生">
    <form className="form" onSubmit={e => { e.preventDefault(); void run(() => api('/subscriptions/' + sub.id + '/confirm', {
      version: sub.version, occurred_at: new Date(when).toISOString(), end_date: end || null, note,
    }), '已记录实际发生，原计划保留'); }}>
      <Notice>填写实际发生时间和确认依据。</Notice>
      <div className="grid-2">
        <Field label="实际发生的时间"><input type="datetime-local" required value={when} max={localIso()} onChange={e => setWhen(e.target.value)} /></Field>
        <Field label="新的到期日（不知道就留空）"><input type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="你是怎么核实的" hint="例如：在账号页看到已生效、收到扣款邮件。至少 5 个字。"><textarea required minLength={5} rows={3} value={note} onChange={e => setNote(e.target.value)} /></Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Foot onClose={onClose} saving={saving} label="记录" />
    </form>
  </Dialog>;
}

const sourceNames: R = { grok: 'Grok', qoder: 'Qoder', antigravity: 'Antigravity', 'kimi-work': 'Kimi Work' };
export const agentLabel = (name: (id: string) => string, id: string) => sourceNames[id] || name(id);

/** 外部会话：关联到某次执行、逐页读取正文；切换会话后旧请求的结果不会回填。 */
export function SessionDialog({ session: initial, onClose }: { session: R; onClose(): void }) {
  const s = useStore();
  const [session, setSession] = useState(initial);
  const [page, setPage] = useState<R | null>(null);
  const [cursors, setCursors] = useState<number[]>([0]);
  const [pageIndex, setPageIndex] = useState(-1);
  const [linkRun, setLinkRun] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => () => { seq.current++; }, []);
  const runs = (s.data.runs as R[]).filter(r => r.agent_id === session.agent && (!session.project_id || (s.data.tasks as R[]).find(t => t.id === r.task_id)?.project_id === session.project_id));
  const read = async (back = false) => {
    if (loading) return;
    const index = back ? pageIndex - 1 : pageIndex + 1;
    const from = back ? cursors[index] : page?.next_from ?? 0;
    const n = ++seq.current; setLoading(true); setError('');
    try {
      const r = await api('/sessions/' + session.id + '/messages?from=' + from);
      if (n === seq.current) {
        // 正文每次只保留一页，上一页按已知游标读取；空末页保留当前内容。
        if (r.messages.length || !page) {
          setPage(r); setPageIndex(index);
          setCursors(prev => [...prev.slice(0, index), from]);
        } else if (!back) setPage(prev => prev ? { ...prev, next_from: null } : r);
        else setError('上一页暂时没有返回内容，请稍后重试');
      }
    } catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setLoading(false); }
  };
  const link = async () => {
    setError('');
    try { const r = await api('/sessions/' + session.id + '/link', { run_id: linkRun }); setSession(r); await s.refresh(); s.toast('已确认关联'); }
    catch (e) { setError((e as Error).message); }
  };
  const ended = !!page && page.next_from == null;
  return <Dialog wide title={session.title || session.native_id} sub={`${agentLabel(s.name, session.agent)} · ${relative(session.updated_at, s.tz)}更新${session.message_count != null ? ` · ${session.message_count} 条消息` : ''}`} onClose={onClose} label="会话记录">
    <dl className="facts compact">
      <dt>所属项目</dt><dd>{session.project_id ? s.pname(session.project_id) : session.source_project ? `${session.source_project}（来源里的名称，尚未对应到登记的项目）` : '未关联'}</dd>
      {session.source_cwd && <><dt>工作文件夹</dt><dd><code>{session.source_cwd}</code></dd></>}
      <dt>和任务的关系</dt><dd>{session.association === 'pending_confirmation' ? '还没确认对应哪次执行' : session.association === 'exact_run_receipt' ? '由执行回执准确关联' : session.association === 'user_confirmed' ? '你确认过的关联' : session.association}</dd>
      <dt>原始标识</dt><dd><code>{session.native_id}</code></dd>
      <dt>来源</dt><dd>{(session.sources || []).map((x: R) => <span key={x.source + x.source_id}>{x.source}{x.web_url && /^https?:\/\//.test(x.web_url) && <> · <a href={x.web_url} target="_blank" rel="noreferrer">打开原始记录</a></>}</span>)}</dd>
    </dl>
    {session.summary && <><h3>开头摘要</h3><p className="summary-text">{session.summary}</p><p className="muted small">这里只保存了摘要，完整对话按页从 AgentsView 读取。</p></>}
    {!session.run_id && runs.length > 0 && <div className="inline-form">
      <select aria-label="关联到哪次执行" value={linkRun} onChange={e => setLinkRun(e.target.value)}>
        <option value="">关联到哪次执行…</option>
        {runs.map(r => { const t = (s.data.tasks as R[]).find(x => x.id === r.task_id); return <option key={r.id} value={r.id}>{t?.title || r.task_id} · {statusText[r.status] || r.status} · {fullDate(r.created_at, s.tz)}</option>; })}
      </select>
      <button className="btn small" disabled={!linkRun} onClick={() => void link()}>确认关联</button>
    </div>}
    <div className="now-actions">
      {pageIndex > 0 && <button className="btn" disabled={loading} onClick={() => void read(true)}>读取上一页正文</button>}
      <button className="btn" disabled={loading || ended} onClick={() => void read()}>{ended ? '已经是最后一页' : loading ? '正在读取…' : page ? '读取下一页正文' : '读取第一页正文'}</button>
      <span className="muted small">{pageIndex >= 0 ? `第 ${pageIndex + 1} 页 · ` : ''}每页最多 30 条</span>
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {page && <div className="messages">{page.messages.map((m: R) => <article key={m.ordinal} className={'msg r-' + m.role}><b>{m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Agent' : m.role} · 第 {m.ordinal} 条</b><pre>{m.content}</pre></article>)}</div>}
  </Dialog>;
}

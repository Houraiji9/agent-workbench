import {UserDecision,pendingDecisions} from '../ui/UserDecision.js';
// 任务抽屉：接力线 → 现在要做什么 → 成果 → 要求 → 过程 → 更多信息。整页不跳转，关掉就回到原处。
import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, Send, CircleCheckBig, FileText, Image as ImageIcon, Globe, Repeat, Ban, ClipboardCheck, FileInput, MessageCircleQuestion, ChevronDown, FolderOpen } from 'lucide-react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import { type R, relayOf, eventText, dispositionText, reviewSkippedTask } from '../lib/flow.js';
import { relative, fullDate, bytes } from '../lib/format.js';
import { Drawer, RelayTrack, Pill, Notice } from '../ui/kit.js';
import { AgentIcon } from '../ui/AgentIcon.js';
import { copyOrder, copyRework, markDispatched, copyReviewOrder, copyReviewFeedback, copyCloseoutOrder, continueTask } from './actions.js';
import { userAcceptanceItems } from '../../core/acceptance.js';
import {ArtifactLocation} from '../ui/ArtifactLocation.js';
import {TaskOrder,OrderStatus} from '../ui/ExecutionOrder.js';
import {waitingForDependencies} from '../../shared/execution-order.js';

export function TaskDrawer({ id }: { id: string }) {
  const s = useStore();
  const [detail, setDetail] = useState<R | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    api('/tasks/' + id).then(v => { if (n === seq.current) { setDetail(v); setError(''); } })
      .catch(e => { if (n === seq.current) setError((e as Error).message); });
  }, [id, s.changeTick]);

  return <Drawer onClose={s.closeTask} label="任务详情">
    {!detail ? <div className="drawer-body">
      <div className="drawer-top"><span /><button className="icon-btn" aria-label="关闭任务" onClick={s.closeTask}><X size={20} /></button></div>
      {error ? <Notice tone="error">{error === '记录不存在' ? '找不到这项任务，可能链接已过期。' : error}</Notice> : <p className="muted">正在读取…</p>}
    </div> : <TaskBody detail={detail} />}
  </Drawer>;
}

function TaskBody({ detail }: { detail: R }) {
  const s = useStore();
  const t = detail.task;
  const run = detail.runs.find((r: R) => r.id === t.current_run_id);
  const who = run?.agent_id || t.agent_id;
  const relay = relayOf(t, s.name, who);
  const current = detail.artifacts.filter((a: R) => a.run_id === t.current_run_id && a.current);
  const older = detail.artifacts.filter((a: R) => !current.includes(a));
  const events = [...detail.events].sort((a: R, b: R) => String(a.received_at).localeCompare(String(b.received_at)));
  const lastMessage = [...events].reverse().find((e: R) => e.run_id === t.current_run_id && e.disposition === 'applied')?.data?.message;

  return <div className="drawer-body">
    <div className="drawer-top">
      <button className="crumb" onClick={() => s.go({ page: 'projects', id: t.project_id })}>{s.pname(t.project_id)}</button>
      <button className="icon-btn" aria-label="关闭任务" onClick={s.closeTask}><X size={20} /></button>
    </div>
    <h1 className="task-title">{t.title}</h1>
    <div className="task-people">
      <OrderStatus task={t}/>
      <span><AgentIcon name={s.name(who)} id={s.agentIconId(who)} size={22} /><span>执行：{s.name(who)}{who !== t.agent_id && <small>（原计划 {s.name(t.agent_id)}）</small>}</span></span>
      <span>{!reviewSkippedTask(t) && <AgentIcon name={s.name(t.reviewer_id)} id={s.agentIconId(t.reviewer_id)} size={22} />}<span>审查：{reviewSkippedTask(t) ? '本次不安排' : s.name(t.reviewer_id)}</span></span>
      <span className="muted">{relative(t.updated_at, s.tz)}更新</span>
    </div>

    <details className="fold"><summary>完整执行流程</summary><RelayTrack relay={relay}/></details>
    {run&&<div className="tool-row"><button className="btn small" disabled={s.busy||['accepted','cancelled','rework_linked','awaiting_confirmation'].includes(t.status)} onClick={()=>void continueTask(s,t)}>同会话继续</button><button className="btn small ghost" disabled={s.busy||['accepted','cancelled','rework_linked','awaiting_confirmation'].includes(t.status)} onClick={()=>void continueTask(s,t,false)}>新会话接手</button></div>}
    {t.delivery_target==='runtime'&&<Notice tone={run?.deployment?.verified?'info':'warn'}>{run?.deployment?.verified?'本机安装已校验，可在运行目录试用。':'交付目标是本机程序；尚未校验安装，不能把候选当作已可试用。'}</Notice>}
    <details className="fold"><summary>上下文与客户端状态</summary>{run?.context_usage?<p>接口已提供 {run.context_usage.requests} 次上下文，共 {run.context_usage.characters} 字符，其中增量 {run.context_usage.delta||0} 次。字符数不等于模型计费 token。</p>:<p>当前执行尚无简版接口的上下文统计；不把缺失数据当作零消耗。</p>}<p>同会话增量可用；自动客户端投递尚未连接。复制简讯不会被标为已发送或已接单。</p></details>

    {pendingDecisions(s.data).some(d=>d.task_id===t.id)?pendingDecisions(s.data).filter(d=>d.task_id===t.id).map(d=><UserDecision key={d.id} decision={d}/>):<NowCard detail={detail} relay={relay} run={run} who={who} current={current} lastMessage={lastMessage} />}
    <TaskOrder task={t}/>
    {run?.closeout?.result&&<section className="block" aria-label="收尾结果"><h2>执行者收尾结果</h2><ul className="plain-list">{run.closeout.items.map((item:R)=><li key={item.id}><strong>{item.text}</strong><p>{run.closeout.results.find((x:R)=>x.item_id===item.id)?.evidence}</p></li>)}</ul><details className="fold"><summary>完整收尾报告</summary><pre className="pre">{run.closeout.result}</pre></details></section>}

    <section className="block" aria-label="成果">
      <h2>成果 {detail.artifacts.length > 0 && <span className="count">{detail.artifacts.length}</span>}</h2>
      {current.length ? <ArtifactList list={current} /> : <p className="muted">{t.status === 'accepted' ? '这次没有归档文件。' : '交付后，执行者提交的文件会出现在这里，可以直接打开查看。'}</p>}
      {older.length > 0 && <details className="fold"><summary>之前几次执行的成果（{older.length}）</summary><ArtifactList list={older} /></details>}
    </section>

    <section className="block" aria-label="这项任务要做什么">
      <h2>这项任务要做什么</h2>
      <p>{t.goal}</p>
      {t.deliverables?.length > 0 && <><h3>要交付的东西</h3><ul className="plain-list">{t.deliverables.map((d: string, i: number) => <li key={i}>{d}</li>)}</ul></>}
      <h3>最后由你确认的事</h3>
      <ul className="check-list">{(t.acceptance_record?.mode === 'user_experience' ? t.acceptance_record.items : userAcceptanceItems(t)).map((a: string, i: number) =>
        <li key={i} className={t.acceptance_record?.mode === 'user_experience' ? 'ok' : ''}>{a}</li>)}</ul>
      {t.status === 'accepted' && t.acceptance_record?.mode !== 'user_experience' && <p className="muted small">旧版验收记录。</p>}
      <details className="fold"><summary>技术检查要求</summary>
        
        <ul className="plain-list">{t.acceptance.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
        {t.tests?.length > 0 && <><h4>测试方法</h4><ul className="plain-list">{t.tests.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></>}
      </details>
    </section>

    <section className="block" aria-label="过程">
      <h2>过程</h2>
      <Timeline detail={detail} events={events} />
    </section>

    {!!t.acceptance_feedback?.length&&<section className="block" aria-label="你的验收意见"><h2>你的验收意见</h2>{t.acceptance_feedback.map((f:R)=><div className="review-item bad" key={f.id}><strong>不通过</strong><span className="muted small">{fullDate(f.created_at,s.tz)}</span><p>{f.note}</p>{f.followup_task_id&&<button className="link" onClick={()=>s.openTask(f.followup_task_id)}>查看后续修改任务</button>}</div>)}</section>}
    {detail.reviews.length > 0 && <section className="block" aria-label="审查记录">
      <h2>审查记录</h2>
      {detail.reviews.map((r: R) => <div key={r.id} className={'review-item ' + (r.verdict === 'passed' ? 'ok' : 'bad')}>
        <strong>{s.name(r.reviewer_id)}：{r.revoked_at ? '已撤回' : r.verdict === 'passed' ? '通过' : '需要修改'}</strong>
        <span className="muted small">{r.run_id === t.current_run_id ? '针对本次交付' : '历史交付'} · {relative(r.created_at, s.tz)}</span>
        {r.findings && <p>{r.findings}</p>}
        <p className="muted small">{r.source==='grok_session_import'?'Grok 会话已核验：':r.source==='reviewer_submission'?'审查者已回传：':r.source==='user_imported_review'?'已导入审查回执：':'手工登记：'}{r.evidence}</p>
        {r.report_markdown&&<details className="fold"><summary>查看完整审查报告</summary><pre className="pre">{r.report_markdown}</pre><a className="link" href={'/api/reviews/'+r.id+'/report'} download>下载报告</a></details>}
        {!!r.limitations?.length&&<details className="fold"><summary>审查范围与未验证项</summary><ul>{r.limitations.map((x:string,i:number)=><li key={i}>{x}</li>)}</ul></details>}
        {r.revoked_at?<p className="muted small">撤回原因：{r.revocation_reason} · {fullDate(r.revoked_at,s.tz)}</p>:r.run_id===t.current_run_id&&['submitted','in_review','changes_requested','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked','awaiting_confirmation'].includes(t.status)&&<button className="link" onClick={()=>s.openDialog('revoke-review',{detail,review:r})}>撤回误登记</button>}
      </div>)}
    </section>}

    <MoreInfo detail={detail} run={run} />
  </div>;
}

function NowCard({ detail, relay, run, who, current, lastMessage }: { detail: R; relay: ReturnType<typeof relayOf>; run?: R; who: string; current: R[]; lastMessage?: string }) {
  const s = useStore();
  const t = detail.task;
  const noReview = reviewSkippedTask(t);
  const steps = (items: React.ReactNode[]) => <ol className="steps">{items.map((x, i) => <li key={i}><span>{x}</span></li>)}</ol>;
  let body: React.ReactNode = null;

  if(waitingForDependencies(t))return <section className="now-card t-quiet" aria-label="现在要做什么"><p className="now-headline">等待前序任务完成</p><p className="now-next">前序任务验收后，这一单会自动变为可执行。</p><button className="btn" disabled>等待前序</button></section>;

  switch (t.status) {
    case 'ready':
      body = <>{steps([<>点下面的按钮，生成执行单并复制</>, <>打开 <b>{s.name(who)}</b>，把内容粘贴进去发送</>, <>回到这里点“我已经发给它”</>])}
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={() => void copyOrder(s, t)}><Copy size={16} />生成并复制执行单</button></div></>;
      break;
    case 'awaiting_dispatch':
      body = <>{steps([<>复制执行单</>, <>打开 <b>{s.name(who)}</b>，粘贴并发送</>, <>发完回来点“我已经发给它”</>])}
        <div className="now-actions">
          <button className="btn primary" disabled={s.busy} onClick={() => void copyOrder(s, t)}><Copy size={16} />复制执行单</button>
          <button className="btn" disabled={s.busy} onClick={() => void markDispatched(s, t)}><Send size={16} />我已经发给它</button>
        </div>
        <p className="muted small">等待 {s.name(who)} 回报“开始”。</p></>;
      break;
    case 'dispatched': case 'running':
      body = <>{lastMessage && <blockquote className="agent-says"><b>{s.name(who)} 最近说：</b>{lastMessage}</blockquote>}
        <p className="muted small">执行单还在 {s.name(who)} 那里。需要重发时可以 <button className="link inline" disabled={s.busy} onClick={() => void copyOrder(s, t)}>再复制一次执行单</button>。</p></>;
      break;
    case 'waiting_input': case 'closeout_waiting_input':
      body = <Question key={`${detail.feedback?.current_question?.id}:${detail.feedback?.replies?.find((r: R) => r.question_event_id === detail.feedback?.current_question?.id)?.version || 0}`} detail={detail} />;
      break;
    case 'blocked': case 'failed':
      body = <>{lastMessage && <blockquote className="agent-says"><b>{s.name(who)} 说：</b>{lastMessage}</blockquote>}
        <div className="now-actions">
          <button className="btn primary" onClick={() => void s.copy(`任务“${t.title}”（Task ${t.id} / Run ${t.current_run_id}）${t.status === 'blocked' ? '遇到阻碍' : '没有完成'}。执行者 ${s.name(who)} 的说明：${lastMessage || '未填写'}。\n请用工作台 MCP 查看这项任务的上下文，判断怎么继续：协助解除阻碍，或建议换一位执行者重做。`, '求助说明已复制，粘贴给 Codex 即可')}><Copy size={16} />复制给 Codex 求助</button>
          <button className="btn" onClick={() => s.openDialog('retry', { detail })}><Repeat size={16} />换人或重新做一次</button>
        </div></>;
      break;
    case 'submitted':
      body = noReview ? null : <>
        {t.review_handoff_issue&&<blockquote className="agent-says">{t.review_handoff_issue}</blockquote>}
        <p>{t.review_stage==='running'?s.name(t.reviewer_id)+' 已接单，正在审查。':t.review_delivery==='agent'?s.name(who)+' 正在调用审查工具。':'把审查单发给 '+s.name(t.reviewer_id)+'，它会按单回传报告。'}</p>
        <div className="now-actions">
          <button className="btn primary" disabled={s.busy} onClick={()=>void copyReviewOrder(s,detail)}><Copy size={16}/>复制审查单</button>
          <button className="btn" onClick={()=>s.openDialog('review-order',{detail})}>更换审查者</button>
          <button className="btn" onClick={()=>s.openDialog('review-receipt',{detail})}>导入审查回执</button>
          {t.reviewer_id==='grok-build'&&<button className="btn" onClick={()=>s.openDialog('grok-review',{detail})}>读取 Grok 审查</button>}
          <button className="btn ghost" disabled={!current.length} onClick={()=>s.openDialog('review',{detail})}>登记审查结果</button>
        </div></>;
      break;
    case 'changes_requested': {
      const last = detail.reviews.filter((r: R) => r.run_id === t.current_run_id&&!r.revoked_at).slice(-1)[0];
      body = <>{last?.findings && <blockquote className="agent-says"><b>{s.name(last.reviewer_id)} 的意见：</b>{last.findings}</blockquote>}
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={()=>void copyReviewFeedback(s,t)}><Copy size={16}/>复制修改意见给执行者</button><button className="btn" onClick={()=>s.openDialog('review-order',{detail})}>重新安排审查</button></div></>;
      break;
    }
    case 'in_review': case 'awaiting_closeout': case 'closing': case 'closeout_blocked':
      body = <>{lastMessage && t.status === 'closeout_blocked' && <blockquote className="agent-says">{lastMessage}</blockquote>}
        <ul className="check-list">{run?.closeout?.items?.map((item:R)=><li key={item.id}>{item.text}</li>)}</ul>
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={()=>void copyCloseoutOrder(s,t)}><Copy size={16}/>复制收尾单给执行者</button>
        <button className="btn" onClick={()=>s.openDialog('receipt',{taskId:t.id})}>导入收尾回执</button>
        {t.status==='closeout_blocked'&&<button className="btn" onClick={()=>s.openDialog('retry',{detail})}>新开执行处理修改</button>}</div></>;
      break;
    case 'awaiting_confirmation':
      body = <>{steps([<>打开下面的成果看一看、试一试</>, <>符合需求就确认完成；有问题可以退回修改</>])}
        <div className="now-actions"><button className="btn primary" disabled={!current.length} onClick={() => s.openDialog('accept', { detail })}><CircleCheckBig size={16} />试用后确认完成</button><button className="btn danger" disabled={!current.length} onClick={()=>s.openDialog('reject',{detail})}>不通过，退回修改</button></div>
        {!noReview&&<button className="link" disabled={s.busy} onClick={()=>void copyReviewFeedback(s,t)}>复制审查反馈给执行者</button>}
        {noReview && <p className="muted small">本次审查：未安排。</p>}</>;
      break;
    case 'acceptance_rejected':
      body=<><blockquote className="agent-says">{t.acceptance_feedback?.at(-1)?.note}</blockquote><button className="btn primary" disabled={s.busy} onClick={()=>void copyRework(s,t)}><Copy size={16}/>复制返工要求</button></>;break;
    case 'rework_linked':
      body=<><blockquote className="agent-says">{t.acceptance_feedback?.at(-1)?.note}</blockquote><button className="btn" onClick={()=>s.openTask(t.rework_task_id)}>查看后续修改任务</button></>;break;
    case 'accepted':
      body = t.acceptance_record?.confirmed_at ? <p className="muted">你在 {fullDate(t.acceptance_record.confirmed_at, s.tz)} 确认了结果。</p> : null;
      break;
  }

  return <section className={'now-card t-' + relay.tone} aria-label="现在要做什么">
    <p className="now-headline">{relay.headline}</p>
    <p className="now-next">{relay.next}</p>
    {body}
  </section>;
}

function Question({ detail }: { detail: R }) {
  const s = useStore();
  const t = detail.task;
  const question = detail.feedback?.current_question;
  const reply = detail.feedback?.replies?.find((r: R) => r.question_event_id === question?.id);
  const [revision] = useState(t.revision);
  const [text, setText] = useState(reply?.message || '');
  const [error, setError] = useState('');
  if (!question) return <p className="muted">{s.name(s.executorOf(t))} 在等待回答，但没有写具体问题，请到它的原会话查看。</p>;
  const dirty = text.trim() !== (reply?.message || '');
  const copyText = (msg: string) => `请查看我对你问题的回答。\n任务 ${t.id}\n执行 ${t.current_run_id}\n问题编号 ${question.id}\n你的问题：${question.data?.message || '（未填写）'}\n我的回答：${msg}\n可以继续时，请按${t.status==='closeout_waiting_input'?'收尾单回报 closeout_started':'执行单回报 started'} 恢复。`;
  const save = async () => {
    setError('');
    const r = await s.act(async () => {
      try { return await api('/tasks/' + t.id + '/reply', { run_id: t.current_run_id, question_event_id: question.id, revision, message: text }); }
      catch (e) { setError((e as Error).message); throw e; }
    }, '回答已保存');
    if (r) await s.copy(copyText(text.trim()), '回答已保存并复制，粘贴回它的对话即可');
  };
  return <div className="question">
    <blockquote className="agent-says ask"><MessageCircleQuestion size={18} /><span>{question.data?.message || '没有填写具体问题，请到原会话查看。'}</span></blockquote>
    <label className="field"><span className="field-label">你的回答</span>
      <textarea rows={4} value={text} maxLength={10000} onChange={e => setText(e.target.value)} placeholder="像平常说话一样回答就行。" />
    </label>
    {error && <Notice tone="error">{error}</Notice>}
    <div className="now-actions">
      <button className="btn primary" disabled={s.busy || !text.trim() || !dirty} onClick={() => void save()}><Send size={16} />{reply ? '保存修改并复制' : '保存并复制回答'}</button>
      {reply && !dirty && <button className="btn" onClick={() => void s.copy(copyText(reply.message), '回答已复制')}><Copy size={16} />再复制一次</button>}
    </div>
    {reply && <p className="muted small">已保存（{relative(reply.saved_at, s.tz)}）。把回答粘贴给它后，等它回报继续工作。</p>}
  </div>;
}

function ArtifactList({ list }: { list: R[] }) {
  const s = useStore();
  const icon = (ext: string) => ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? <ImageIcon size={18} /> : ['.html', '.htm'].includes(ext) ? <Globe size={18} /> : <FileText size={18} />;
  return <div className="file-list">
    {list.map(a => <div key={a.id} className="artifact-row"><button className="file" onClick={() => s.openDialog('artifact', { artifact: a })}>
      {icon(a.extension)}
      <span><strong>{a.label}</strong><small>{bytes(a.size)} · {relative(a.created_at, s.tz)}</small></span>
    </button><ArtifactLocation artifact={a} compact/></div>)}
  </div>;
}

function Timeline({ detail, events }: { detail: R; events: R[] }) {
  const s = useStore();
  const t = detail.task;
  const runs = [...detail.runs].sort((a: R, b: R) => String(a.created_at).localeCompare(String(b.created_at)));
  return <ol className="timeline">
    <li className="tl-quiet"><span className="tl-dot" /><div><b>任务由 Codex 规划创建</b><small>{fullDate(t.created_at, s.tz)}</small></div></li>
    {runs.map((r: R, n: number) => <React.Fragment key={r.id}>
      <li className="tl-quiet"><span className="tl-dot" /><div><b>{n === 0 ? '生成执行单' : `第 ${n + 1} 次执行：重新生成执行单`}，交给 {s.name(r.agent_id)}</b><small>{fullDate(r.created_at, s.tz)}</small></div></li>
      {events.filter(e => e.run_id === r.id).map(e => <li key={e.id} className={'tl-' + e.event_type + (e.disposition !== 'applied' ? ' tl-off' : '')}>
        <span className="tl-dot" />
        <div>
          <b>{eventText(e, s.name(r.agent_id))}{dispositionText(e.disposition)}</b>
          {e.data?.message && <p>{e.data.message}</p>}
          {e.disposition === 'rejected' && e.error && <p className="muted small">原因：{e.error}</p>}
          <small>{fullDate(e.occurred_at, s.tz)}</small>
        </div>
      </li>)}
    </React.Fragment>)}
    {t.acceptance_record?.confirmed_at && <li className="tl-accepted"><span className="tl-dot" /><div><b>你确认完成</b><small>{fullDate(t.acceptance_record.confirmed_at, s.tz)}</small></div></li>}
    {t.status === 'cancelled' && <li className="tl-off"><span className="tl-dot" /><div><b>任务已取消</b><small>{fullDate(t.updated_at, s.tz)}</small></div></li>}
  </ol>;
}

function MoreInfo({ detail, run }: { detail: R; run?: R }) {
  const s = useStore();
  const t = detail.task;
  const [open, setOpen] = useState(false);
  const noReview = reviewSkippedTask(t);
  return <section className="block more" aria-label="更多信息与操作">
    <button className="more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={17} className={open ? 'rot' : ''} />更多信息与操作</button>
    {open && <div className="more-body">
      <div className="tool-row">
        {t.current_run_id && <button className="btn small" onClick={() => s.openDialog('receipt', { taskId: t.id })}><FileInput size={15} />导入回执</button>}
        {!noReview && ['submitted', 'in_review', 'changes_requested'].includes(t.status) && <button className="btn small" onClick={() => s.openDialog('review', { detail })}><ClipboardCheck size={15} />登记审查结果</button>}
        {!noReview&&t.reviewer_id==='grok-build'&&['submitted','in_review','changes_requested','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked','awaiting_confirmation'].includes(t.status)&&<button className="btn small" onClick={()=>s.openDialog('grok-review',{detail})}>读取 Grok 审查</button>}
        {!t.request_withdrawn&&['awaiting_closeout','closing','closeout_waiting_input','closeout_blocked','submitted', 'awaiting_confirmation', 'failed', 'cancelled', 'in_review', 'changes_requested', 'acceptance_rejected', 'blocked'].includes(t.status) && <button className="btn small" onClick={() => s.openDialog('retry', { detail })}><Repeat size={15} />换人或重新做一次</button>}
        {run?.directory && <button className="btn small" onClick={() => void s.copy(run.directory, '执行文件夹路径已复制')}><FolderOpen size={15} />复制执行文件夹路径</button>}
        {!['accepted', 'cancelled', 'rework_linked'].includes(t.status) && <button className="btn small danger" onClick={() => s.openDialog('cancel', { detail })}><Ban size={15} />取消这项任务</button>}
      </div>
      <dl className="facts">
        <dt>为什么选 {s.name(t.agent_id)}</dt><dd>{t.rationale}</dd>
        <dt>工作范围</dt><dd>{t.scope}</dd>
        {t.non_goals?.length > 0 && <><dt>不做的事</dt><dd>{t.non_goals.join('；')}</dd></>}
        <dt>允许修改的位置</dt><dd>{t.allowed_paths.map((p: string) => <code key={p}>{p}</code>)}</dd>
        {run?.requested_model && <><dt>指定模型 / 模式</dt><dd>{run.requested_model}</dd></>}
        {run?.actual_model && <><dt>执行回报模型</dt><dd>{run.actual_model}</dd></>}
        <dt>资源安排</dt><dd>{t.resource_expectation}</dd>
        <dt>原始需求</dt><dd>{t.original_request}</dd>
        <dt>任务编号</dt><dd><code>{t.id}</code> <button className="link inline" onClick={() => void s.copy(t.id, '任务编号已复制')}>复制</button></dd>
      </dl>
      <h3>执行记录（{detail.runs.length} 次）</h3>
      <ul className="run-list">{detail.runs.map((r: R) => <li key={r.id}>
        <span><b>{s.name(r.agent_id)}</b> · {r.id === t.current_run_id ? '当前这次' : '之前'} · <Pill task={r.id===t.current_run_id?t:undefined} status={r.status} /></span>
        <code>{r.id}</code>
        {r.result && <details className="fold"><summary>执行者写的结果报告</summary><pre className="pre">{r.result}</pre></details>}
      </li>)}</ul>
      {detail.sessions?.length > 0 && <><h3>关联的原始会话</h3><ul className="run-list">{detail.sessions.map((x: R) => <li key={x.id}><span>{x.title}</span><code>{x.native_id}</code></li>)}</ul></>}
    </div>}
  </section>;
}

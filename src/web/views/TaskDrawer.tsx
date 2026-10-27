import {reviewSourceLabel,recoveredReviewInvocation} from '../../shared/review-presentation.js';
import {ReviewCollaboration} from '../ui/ReviewCollaboration.js';
import {hasSameSessionContinuation} from '../../shared/workflow-view.js';
import {planningOriginLabel} from '../../shared/planning-origin.js';
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
import { copyOrder, copyRework, markDispatched, copyReviewOrder, copyReviewFeedback, copyCloseoutOrder, continueTask, dispatchTask, openTrial } from './actions.js';
import {TaskQuickActions} from '../ui/TaskQuickActions.js';
import { userAcceptanceItems } from '../../core/acceptance.js';
import {ArtifactLocation} from '../ui/ArtifactLocation.js';
import {TaskOrder,OrderStatus} from '../ui/ExecutionOrder.js';
import {waitingForDependencies} from '../../shared/execution-order.js';
import { AgentAutomationStatus, automationActive } from '../ui/AgentAutomationStatus.js';
import { AgentAutomationControls } from '../ui/AgentAutomationControls.js';
import { TaskExecutionPolicy } from '../ui/TaskExecutionPolicy.js';
import { deliverySummary } from '../ui/DeliveryProfileFields.js';

const executionContinuationStates = new Set(['ready', 'awaiting_dispatch', 'dispatched', 'waiting_input', 'blocked', 'changes_requested', 'awaiting_closeout', 'closing', 'closeout_waiting_input', 'closeout_blocked']);

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

  const active = automationActive(detail?.task?.automation);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    const timer = setInterval(() => {
      if (loading) return;
      loading = true;
      void api('/tasks/' + id, undefined, controller.signal).then(setDetail).catch(e => {
        if (!controller.signal.aborted) setError((e as Error).message);
      }).finally(() => { loading = false; });
    }, 2500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [id, active]);

  return <Drawer onClose={s.closeTask} label="任务详情">
    {!detail ? <div className="drawer-body">
      <div className="drawer-top"><span /><button className="icon-btn" aria-label="关闭任务" onClick={s.closeTask}><X size={20} /></button></div>
      {error ? <Notice tone="error">{error === '记录不存在' ? '找不到这项任务，可能链接已过期。' : error}</Notice> : <p className="muted">正在读取…</p>}
    </div> : <>{error&&<Notice tone="error">任务状态暂未更新：{error}</Notice>}<TaskBody detail={detail} /></>}
  </Drawer>;
}

function TaskBody({ detail }: { detail: R }) {
  const s = useStore();
  const t = detail.task;
  const run = detail.runs.find((r: R) => r.id === t.current_run_id);
  const deliveryProfile = t.delivery_profile || run?.delivery_profile || run?.execution_contract?.delivery_profile;
  const portableVerified = deliveryProfile?.deployment?.verification === 'portable_manifest' && !!run?.deployment?.verified;
  const who = run?.agent_id || t.agent_id;
  const relay = relayOf({...t,active_reviewers:detail.review_summary?.members||t.active_reviewers,review_report_counts:detail.review_summary?.counts,review_decision:detail.review_summary?.decision,closeout:run?.closeout}, s.name, who);
  const current = detail.artifacts.filter((a: R) => a.run_id === t.current_run_id && a.current);
  const older = detail.artifacts.filter((a: R) => !current.includes(a));
  const events = [...detail.events].sort((a: R, b: R) => String(a.received_at).localeCompare(String(b.received_at)));
  const lastMessage = [...events].reverse().find((e: R) => e.run_id === t.current_run_id && e.disposition === 'applied')?.data?.message;
  const continuationDisabled = s.busy || automationActive(t.automation) || (t.execution_route
    ? !executionContinuationStates.has(t.status)
    : ['accepted', 'cancelled', 'rework_linked', 'awaiting_confirmation'].includes(t.status));
  const stoppedExecution = t.status === 'running' && t.execution_route && t.automation?.role === 'execution'
    && !automationActive(t.automation) && !t.automation.superseded && (['failed', 'interrupted'].includes(t.automation.status) || t.automation.cancel_requested);
  const recoveryRequired = t.automation?.recovery_required || detail.agent_jobs?.some((job: R) => job.recovery_required);
  const restartDisabled = s.busy || recoveryRequired || detail.agent_jobs?.some((job: R) => automationActive(job));

  return <div className="drawer-body">
    <div className="drawer-top">
      <button className="crumb" onClick={() => s.go({ page: 'projects', id: t.project_id })}>{s.pname(t.project_id)}</button>
      <button className="icon-btn" aria-label="关闭任务" onClick={s.closeTask}><X size={20} /></button>
    </div>
    <h1 className="task-title">{t.title}</h1>
    <TaskQuickActions task={t} trial={false} copy={!['ready','awaiting_dispatch'].includes(t.status)||hasSameSessionContinuation(t)}/>
    <div className="task-people">
      <OrderStatus task={t}/>
      <span><AgentIcon name={s.name(who)} id={s.agentIconId(who)} size={22} /><span>执行：{s.name(who)}{who !== t.agent_id && <small>（原计划 {s.name(t.agent_id)}）</small>}</span></span>
      <span>{!reviewSkippedTask(t) && <AgentIcon name={s.name(t.reviewer_id)} id={s.agentIconId(t.reviewer_id)} size={22} />}<span>审查：{reviewSkippedTask(t) ? '本次不安排' : s.name(t.reviewer_id)}</span></span>
      <span className="muted">{relative(t.updated_at, s.tz)}更新</span>
    </div>

    <details className="fold"><summary>完整执行流程</summary><RelayTrack relay={relay}/></details>
    {run&&<div className="tool-row"><button className="btn small" disabled={continuationDisabled} onClick={()=>void continueTask(s,t)}>同会话继续</button><button className="btn small ghost" disabled={stoppedExecution ? restartDisabled : continuationDisabled} onClick={()=>void continueTask(s,t,false)}>{stoppedExecution ? '停止后重新开始' : '新会话接手'}</button></div>}
    {stoppedExecution && <p className="muted small">{recoveryRequired ? '仍有调用尚未核实结束，请先展开下方“高级恢复”核实原调用，再重新开始。' : '使用新会话重新开始，原会话与已有回执保留。'}</p>}
    <AgentAutomationStatus job={t.automation}/>
    <AgentAutomationControls key={t.id} task={t} jobs={detail.agent_jobs}/>
    {portableVerified&&<Notice tone="info">本机便携清单已核验。</Notice>}
    {run?.deployment_evidence&&<details className="fold"><summary>部署证据与来源</summary><p className="muted small">{portableVerified?'便携清单由工作台核验；健康和回退说明来自执行者报告。':'执行者报告，工作台未主动验证线上。'}</p><pre className="pre">{typeof run.deployment_evidence==='string'?run.deployment_evidence:JSON.stringify(run.deployment_evidence,null,2)}</pre></details>}
    <details className="fold"><summary>上下文与客户端状态</summary>{run?.context_usage?<p>接口已提供 {run.context_usage.requests} 次上下文，共 {run.context_usage.characters} 字符，其中增量 {run.context_usage.delta||0} 次。字符数不等于模型计费 token。</p>:<p>当前执行尚无简版接口的上下文统计；不把缺失数据当作零消耗。</p>}<p>{hasSameSessionContinuation(t)?'原执行会话直接读取本轮增量，接单后更新状态，无需重发执行单。':t.execution_route?'本任务已指定客户端；续作会尝试连接原会话，能否恢复以实际调用结果为准。':'本任务未配置自动调用路线；继续操作会准备可复制的兼容入口。'}</p><button className="link" onClick={()=>s.go({page:'settings'})}>查看本机客户端</button></details>
    <TaskExecutionPolicy key={(run?.id||t.id)+':'+(t.pending_arrangement?.saved_at||'')} task={t} run={run} runs={detail.runs} jobs={detail.agent_jobs||[]}/>
    {(run?.execution_contract?.review_policy||t.review_policy)?.mode==='light'&&<Notice>本次为有限审查，只检查：{((run?.execution_contract?.review_policy||t.review_policy)?.focus||[]).join('；')}。其他范围仍需另行验证，不代表完整审查通过。</Notice>}

    {pendingDecisions(s.data,true).some(d=>d.task_id===t.id)?pendingDecisions(s.data,true).filter(d=>d.task_id===t.id).map(d=><UserDecision key={d.id} decision={d}/>):<NowCard detail={detail} relay={relay} run={run} who={who} current={current} lastMessage={lastMessage} />}
    <ReviewCollaboration key={t.id+':'+t.revision} detail={detail}/>
    <TaskOrder task={t}/>
    {run?.closeout?.result&&<section className="block" aria-label="收尾结果"><h2>执行者收尾结果</h2><ul className="plain-list">{run.closeout.items.map((item:R)=><li key={item.id}><strong>{item.text}</strong><p>{run.closeout.results.find((x:R)=>x.item_id===item.id)?.evidence}</p></li>)}</ul><details className="fold"><summary>完整收尾报告</summary><pre className="pre">{run.closeout.result}</pre></details></section>}

    <section className="block" aria-label="成果">
      <h2>成果 {detail.artifacts.length > 0 && <span className="count">{detail.artifacts.length}</span>}</h2>
      {current.length ? <ArtifactList list={current} /> : <p className="muted">{t.status === 'accepted' ? '这次没有归档文件。' : '交付后，执行者提交的文件会出现在这里，可以直接打开查看。'}</p>}
      {older.length > 0 && <details className="fold"><summary>之前几次执行的成果（{older.length}）</summary><ArtifactList list={older} /></details>}
    </section>

    <section className="block" aria-label="这项任务要做什么">
      <h2>这项任务要做什么</h2>
      <p>冻结的重要程度：{t.importance==='critical'?'重点':'普通'}</p>
      {deliveryProfile&&<p>冻结的交付方案：{deliverySummary(deliveryProfile)}</p>}
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
        <p className="muted small">{reviewSourceLabel(r)}{r.evidence}</p>
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
  const reviewInvocationFailed = t.automation?.role === 'review' && !recoveredReviewInvocation(t.automation) && (!t.automation.superseded||t.automation.recovery_required||t.automation.process_may_be_running===true) && ['failed', 'interrupted'].includes(t.automation.status);
  const steps = (items: React.ReactNode[]) => <ol className="steps">{items.map((x, i) => <li key={i}><span>{x}</span></li>)}</ol>;
  let body: React.ReactNode = null;

  if(waitingForDependencies(t))return <section className="now-card t-quiet" aria-label="现在要做什么"><p className="now-headline">等待前序任务完成</p><p className="now-next">前序任务验收后，这一单会自动变为可执行。</p><button className="btn" disabled>等待前序</button></section>;

  if(hasSameSessionContinuation(t)&&relay.holder==='agent')return <section className={'now-card t-'+relay.tone} aria-label="现在要做什么"><p className="now-headline">{relay.headline}</p><p className="now-next">{relay.next}</p>{t.status==='awaiting_closeout'&&<ul className="check-list">{run?.closeout?.items?.map((item:R)=><li key={item.id}>{item.text}</li>)}</ul>}{lastMessage&&<blockquote className="agent-says"><b>{s.name(who)} 最近说：</b>{lastMessage}</blockquote>}</section>;

  switch (t.status) {
    case 'ready':
      if(t.execution_route){body=<><p>按计划调用 {s.name(who)}，执行者接单后会回报进度。</p><button className="btn primary" disabled={s.busy||automationActive(t.automation)} onClick={()=>void dispatchTask(s,t)}>开始执行</button></>;break;}
      body = <>{steps([<>点下面的按钮，生成执行单并复制</>, <>打开 <b>{s.name(who)}</b>，把内容粘贴进去发送</>, <>回到这里点“我已经发给它”</>])}
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={() => void copyOrder(s, t)}><Copy size={16} />生成并复制执行单</button></div></>;
      break;
    case 'awaiting_dispatch':
      if(t.execution_route){const retry=['failed','interrupted'].includes(t.automation?.status);body=<><p>{retry?'先核对原客户端已结束，再重新调用，避免重复执行。':'执行单已准备好，调用成功后等待执行者回报接单。'}</p><button className="btn primary" disabled={s.busy||automationActive(t.automation)} onClick={()=>void dispatchTask(s,t,false,retry)}>{retry?'原会话已结束，重试调用':'开始执行'}</button></>;break;}
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
          <button className="btn primary" onClick={() => void s.copy(`任务“${t.title}”（Task ${t.id} / Run ${t.current_run_id}）${t.status === 'blocked' ? '遇到阻碍' : '没有完成'}。执行者 ${s.name(who)} 的说明：${lastMessage || '未填写'}。\n请用工作台 MCP 查看这项任务的上下文，判断怎么继续：协助解除阻碍，或建议换一位执行者重做。`, '求助说明已复制，粘贴给规划 Agent 即可')}><Copy size={16} />复制给规划 Agent 求助</button>
          <button className="btn" onClick={() => s.openDialog('retry', { detail })}><Repeat size={16} />换人或重新做一次</button>
        </div></>;
      break;
    case 'submitted':
      if(t.review_stage==='awaiting_decision'){body=<p>审查报告已齐，请在下方查看各方意见并记录负责人决定。</p>;break;}
      body = noReview ? null : <>
        {t.review_handoff_issue&&<blockquote className="agent-says">{t.review_handoff_issue}</blockquote>}
        {reviewInvocationFailed&&<p>审查调用已停止更新，请查看失败原因；原接单记录保留。</p>}
        <div className="now-actions">
          {t.review_route&&!automationActive(t.automation)&&(t.review_stage!=='running'||reviewInvocationFailed)&&(!t.automation_policy?.auto_review||reviewInvocationFailed)&&<button className="btn primary" disabled={s.busy} onClick={()=>void dispatchTask(s,t,true,reviewInvocationFailed)}>{reviewInvocationFailed?'原会话已结束，重试审查':'开始独立审查'}</button>}
        </div>
        {reviewInvocationFailed&&<p className="muted small">重试前请先核对原审查客户端已结束。工作台也会检查旧进程；仍在运行或无法确认时会拒绝重复启动并说明原因。</p>}
        <details className="fold"><summary>手动转发或导入审查</summary><p className="muted small">仅在使用无法连接本机的客户端，或你明确选择手动处理时使用。</p><div className="now-actions">
          <button className="btn" disabled={automationActive(t.automation)} onClick={()=>s.openDialog('review-order',{detail})}>更换审查者</button>
          <button className="btn" disabled={s.busy||automationActive(t.automation)} onClick={()=>void copyReviewOrder(s,detail)}><Copy size={16}/>复制审查单</button>
          <button className="btn" onClick={()=>s.openDialog('review-receipt',{detail})}>导入审查回执</button>
          {t.reviewer_id==='grok-build'&&<button className="btn" onClick={()=>s.openDialog('grok-review',{detail})}>读取 Grok 审查</button>}
          <button className="btn ghost" disabled={!current.length} onClick={()=>s.openDialog('review',{detail})}>登记审查结果</button>
        </div></details></>;
      break;
    case 'changes_requested': {
      const last = detail.reviews.filter((r: R) => r.run_id === t.current_run_id&&!r.revoked_at).slice(-1)[0];
      if(t.execution_route){body=<>{last?.findings&&<blockquote className="agent-says"><b>{s.name(last.reviewer_id)} 的意见：</b>{last.findings}</blockquote>}<p>{t.automation_policy?.auto_rework?'工作台按已登记的返工策略继续；超过轮次或调用受阻时交回规划者。':'由规划者按本轮意见安排返修，也可继续原会话处理。'}</p><button className="btn" disabled={s.busy||automationActive(t.automation)} onClick={()=>void continueTask(s,t)}>继续返修</button></>;break;}
      body = <>{last?.findings && <blockquote className="agent-says"><b>{s.name(last.reviewer_id)} 的意见：</b>{last.findings}</blockquote>}
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={()=>void copyReviewFeedback(s,t)}><Copy size={16}/>复制修改意见给执行者</button><button className="btn" onClick={()=>s.openDialog('review-order',{detail})}>重新安排审查</button></div></>;
      break;
    }
    case 'in_review':
      body=<><p>独立审查仍在进行，等待尚未完成的审查者回传报告。</p><p className="muted small">已收到的意见保留在下方独立审查列表；全部回报后，由负责人决定继续、修改或追加审查。</p></>;
      break;
    case 'awaiting_closeout': case 'closing': case 'closeout_blocked':
      if(t.execution_route){body=<>{lastMessage&&t.status==='closeout_blocked'&&<blockquote className="agent-says">{lastMessage}</blockquote>}<ul className="check-list">{run?.closeout?.items?.map((item:R)=><li key={item.id}>{item.text}</li>)}</ul><p className="muted small">由原执行者完成剩余事项，收尾回执通过后再交你试用。</p>{!automationActive(t.automation)&&t.status!=='closing'&&<button className="btn" disabled={s.busy} onClick={()=>void continueTask(s,t)}>继续执行者收尾</button>}</>;break;}
      body = <>{lastMessage && t.status === 'closeout_blocked' && <blockquote className="agent-says">{lastMessage}</blockquote>}
        <ul className="check-list">{run?.closeout?.items?.map((item:R)=><li key={item.id}>{item.text}</li>)}</ul>
        <div className="now-actions"><button className="btn primary" disabled={s.busy} onClick={()=>void copyCloseoutOrder(s,t)}><Copy size={16}/>复制收尾单给执行者</button>
        <button className="btn" onClick={()=>s.openDialog('receipt',{taskId:t.id})}>导入收尾回执</button>
        {t.status==='closeout_blocked'&&<button className="btn" onClick={()=>s.openDialog('retry',{detail})}>新开执行处理修改</button>}</div></>;
      break;
    case 'awaiting_confirmation':
      body = <>{steps([<>打开下面的成果看一看、试一试</>, <>符合需求就确认完成；有问题可以退回修改</>])}
        <div className="now-actions"><button className="btn primary" disabled={s.busy||!current.length} onClick={() => void openTrial(s,t)}><CircleCheckBig size={16} />试用后确认完成</button><button className="btn danger" disabled={s.busy||!current.length} onClick={()=>void openTrial(s,t,true)}>不通过，退回修改</button></div>
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
    <li className="tl-quiet"><span className="tl-dot" /><div><b>规划来源：{planningOriginLabel(t)}</b><p>规划模型：{t.planning_origin?.reported_model?`${t.planning_origin.reported_model}（规划者自述，未独立核验）`:'未知，未补造'}</p><small>{fullDate(t.created_at, s.tz)}</small></div></li>
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
        {run?.requested_model && <><dt>建议模型 / 模式</dt><dd>{run.requested_model}</dd></>}
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

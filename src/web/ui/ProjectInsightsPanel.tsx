import React,{useEffect,useMemo,useState} from 'react';
import {useLiveResource} from './useLiveResource.js';
import {useStore} from '../app/store.js';
import {statusText} from '../lib/flow.js';
import {Empty,Field,Notice,Pill,Section} from './kit.js';
import type {aggregateProjectUsage,UsageMetric} from '../../core/project-usage.ts';
import type {TokenMonitorProjectUsage} from '../../core/token-monitor-usage.ts';
import type {projectTimelineGraph} from '../../shared/project-timeline.ts';
import {TokenMonitorUsagePanel} from './TokenMonitorUsagePanel.js';
import {RelationRecords,queueRelationSelection} from './RelationRecords.js';
import './project-insights.css';

type Insights={usage:ReturnType<typeof aggregateProjectUsage>;graph:ReturnType<typeof projectTimelineGraph>;unmetered_runs:number;budget_alerts:{run_id:string;task_id:string;known_tokens:number;budget:number;note:string}[];token_monitor?:TokenMonitorProjectUsage};
const metrics:Record<UsageMetric,string>={total_tokens:'总 Token',input_tokens:'输入 Token',output_tokens:'输出 Token',cache_read_tokens:'缓存读取',cache_write_tokens:'缓存写入',reasoning_tokens:'推理 Token',cost_usd:'API 等价估算价（美元）'};
const format=(value:number|null|undefined)=>value==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(value);
const issueText=(reason:string)=>{
  const code=reason.split(':')[0];return ({secondary_usage_source:'同一调用已有主计量来源，当前证据保留但不重复计入。',duplicate_conflict:'同一事件编号出现不同内容，已排除冲突记录。',invalid_event:'来源记录格式或数值无效，未计入。',job_binding_conflict:'记录的项目、任务或执行者与调用不一致，已排除。',sequence_conflict:'同一用量范围的事件顺序冲突，需核对原记录。',counter_regression:'累计计数下降；来源尚未声明新的计数周期，未将其当成新消耗。',time_regression:'事件时间倒退，无法确认对应区间。',unknown_time_boundary:'累计量跨过筛选时间边界，无法准确分摊，暂列未知。',unresolved_message_scope:'来源没有明确消息编号，原始记录已保留，暂不加入小计。',unattributable_parent_filter:'父调用总量包含筛选范围之外的子调用，无法可靠分配给当前模型或执行者。'} as Record<string,string>)[code]||'来源存在未解决的用量问题，详情保留原始原因。';
};
const reasonText=(reason:string)=>({known_usage:'计入已知小计',legacy_summary_known_subtotal:'历史调用摘要：计入已知小计，覆盖完整度未知',secondary_usage_source:'同一调用已有主计量来源，此来源保留追溯但不重复计入',included_in_parent:'已包含在父调用中，不重复计入',unattributable_parent_filter:'父级范围无法分摊，暂列未知'} as Record<string,string>)[reason]||reason;


export function ProjectInsightsPanel({projectId}:{projectId:string}){
  const s=useStore(),[agent,setAgent]=useState(''),[model,setModel]=useState(''),[role,setRole]=useState(''),[task,setTask]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[history,setHistory]=useState(false);
  const [rosterModels,setRosterModels]=useState<string[]>([]);
  useEffect(()=>{setAgent('');setModel('');setRole('');setTask('');setFrom('');setTo('');setRosterModels([]);},[projectId]);
  const invalidRange=!!from&&!!to&&from>to;
  const params=new URLSearchParams({history:String(history)});if(agent)params.set('agent_id',agent);if(model)params.set('model',model);if(role)params.set('role',role);if(task)params.set('task_id',task);if(from)params.set('from',new Date(from+'T00:00:00').toISOString());if(to)params.set('to',new Date(to+'T23:59:59.999').toISOString());
  const {data,error,loading}=useLiveResource<Insights>(invalidRange?null:`/projects/${encodeURIComponent(projectId)}/insights?${params}`,s.changeTick);
  useEffect(()=>{if(data)setRosterModels(old=>[...new Set([...old,...data.graph.nodes.map(n=>n.actual_model).filter((v):v is string=>!!v),...data.usage.trace.map(t=>t.actual_model).filter((v):v is string=>!!v)])]);},[data]);

  const roster=(s.data.agents||[]) as {id:string;name?:string}[],projectTasks=((s.data.tasks||[]) as {id:string;project_id:string;title:string}[]).filter(t=>t.project_id===projectId);
  const traceJobs=useMemo(()=>{const groups=new Map<string,NonNullable<Insights['usage']>['trace']>();for(const item of data?.usage.trace||[]){const list=groups.get(item.job_id)||[];list.push(item);groups.set(item.job_id,list);}for(const id of data?.usage.missing_job_ids||[])if(!groups.has(id))groups.set(id,[]);return [...groups];},[data]);
  const showRelations=()=>{queueRelationSelection(projectId,{taskId:task||undefined});s.go({page:'projects',id:projectId,tab:'diagrams'});};
  const u=data?.usage,totalCoverage=u?.coverage.total_tokens,missingTotal=totalCoverage?.missing_job_ids?.length;
  return <div className="project-insights">
    <TokenMonitorUsagePanel usage={data?.token_monitor} onTask={s.openTask}/>
    <Section title="工作台调用用量与追溯" aside={<Pill tone="quiet">工作台调用账本</Pill>}>
      <form className="pi-filters" onSubmit={e=>e.preventDefault()}>
        <Field label="Agent"><select value={agent} onChange={e=>setAgent(e.target.value)}><option value="">全部 Agent</option>{roster.map(a=><option key={a.id} value={a.id}>{s.name(a.id)}</option>)}</select></Field>
        <Field label="实际模型"><select value={model} onChange={e=>setModel(e.target.value)}><option value="">全部实际模型</option>{rosterModels.map(m=><option key={m} value={m}>{m}</option>)}</select></Field>
        <Field label="阶段"><select value={role} onChange={e=>setRole(e.target.value)}><option value="">全部阶段</option><option value="execution">执行</option><option value="review">独立审查</option><option value="closeout">收尾</option></select></Field><Field label="任务"><select value={task} onChange={e=>setTask(e.target.value)}><option value="">全部任务</option>{projectTasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <Field label="开始日期"><input type="date" value={from} max={to||undefined} onChange={e=>setFrom(e.target.value)}/></Field>
        <Field label="结束日期"><input type="date" value={to} min={from||undefined} onChange={e=>setTo(e.target.value)}/></Field>
      </form>
      <p className="muted small">按当前设备的本地日期筛选用量。实际模型来自客户端报告，请求模型另行保留。日期与 Agent 筛选用于调用用量；完整流程和关系来源集中在关系图页。</p>
      {invalidRange&&<Notice tone="error">结束日期需要晚于或等于开始日期。</Notice>}{error&&<Notice tone="error">读取项目用量失败：{error}</Notice>}
      {loading&&<p role="status">正在读取项目记录…</p>}
      {!loading&&!invalidRange&&u&&<>
        <div className="pi-metrics"><article><span>调用已知 Token 小计</span><strong>{format(u.subtotal.total_tokens)}</strong><small>只含可以确认的用量</small></article><article><span>已知输入 / 输出</span><strong>{format(u.subtotal.input_tokens)} / {format(u.subtotal.output_tokens)}</strong><small>缓存与推理不重复加算</small></article><article><span>调用用量覆盖</span><strong>{totalCoverage?.ratio==null?'—':new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(totalCoverage.ratio)}</strong><small>{format(totalCoverage?.complete_jobs)} / {format(totalCoverage?.total_jobs)} 次调用的总量完整</small></article><article><span>总量缺失或不完整</span><strong>{format(missingTotal)}</strong><small>缺失代表未知，不能当成 0</small></article></div>
        <Notice>这些数字是已知小计，不是完整账单，也不代表订阅实际扣费。缓存和推理可能已包含在总量中。TokenMonitor 全机统计是会话视角，本节是工作台调用账本；两种视角不能相加。</Notice>
        {!!data?.unmetered_runs&&<Notice tone="warn">整个项目另有 {data.unmetered_runs} 次执行没有工作台客户端调用用量，包括手动或外部执行。上方覆盖比例仅针对已登记的客户端调用，不能代表整个项目。</Notice>}
        {!!data?.budget_alerts?.length&&<details className="pi-details"><summary>执行用量提醒（{data.budget_alerts.length} 项）</summary><RelationRecords items={data.budget_alerts} label="用量提醒" searchText={b=>JSON.stringify(b)} render={b=><Notice key={b.run_id} tone="warn">本轮已知 Token {format(b.known_tokens)} 已达到提醒预算 {format(b.budget)}。当前调用继续；负责人可决定是否停止。<button className="btn small" onClick={()=>s.openTask(b.task_id)}>查看任务</button><button className="btn small" onClick={()=>{queueRelationSelection(projectId,{taskId:b.task_id,runId:b.run_id});s.go({page:'projects',id:projectId,tab:'diagrams'});}}>定位本轮执行关系</button></Notice>}/></details>}
        {!!u.issues.length&&<details className="pi-details"><summary>有 {u.issues.length} 条来源说明需要留意</summary><RelationRecords items={u.issues} label="来源说明" searchText={issue=>issueText(issue.reason)+' '+JSON.stringify(issue)} render={(issue,i)=><article className="pi-source-record" key={issue.event_id+issue.reason+i}>{issueText(issue.reason)}<details><summary>原始记录编号与原因</summary><code>{issue.event_id} · {issue.reason}</code></details></article>}/></details>}
        <details className="pi-details"><summary>逐项追溯调用（{traceJobs.length} 项）</summary><RelationRecords items={traceJobs} label="调用记录" searchText={item=>JSON.stringify(item)} render={([id,items])=><details className="pi-trace-job" key={id}><summary>调用 {id}{!items.length?' · 用量未知':totalCoverage?.missing_job_ids.includes(id)?' · 总量未知或不完整':''}</summary>{!!u.missing.filter(m=>m.job_id===id).length&&<p>本次调用仍有缺失指标：{[...new Set(u.missing.filter(m=>m.job_id===id).map(m=>metrics[m.metric]))].join('、')}。已有小计保留，缺失部分未按 0 处理。</p>}{!items.length?<p>尚未收到可确认的用量事件。</p>:<RelationRecords items={items} label="调用用量事件" searchText={item=>JSON.stringify(item)} render={(item,i)=><article className="pi-source-record" key={item.event_id+item.metric+i}><strong>{metrics[item.metric]}：{format(item.value)}</strong><span>{reasonText(item.reason)}</span><span>实际模型：{item.actual_model||'未知'} · 请求模型：{item.requested_model||'未指定'}</span><span>来源：{item.source} · {item.end}</span><code>事件 {item.event_id} · 范围 {item.scope_id} · 周期 {item.epoch}</code></article>}/>}</details>}/></details>
        {!!u.external_totals.length&&<details className="pi-details"><summary>独立的全机来源快照（{u.external_totals.length} 项，未加入项目小计）</summary><RelationRecords items={u.external_totals} label="全机快照" searchText={e=>JSON.stringify(e)} render={e=><p key={e.id}>来源 {e.source} · {e.occurred_at} · 全机总 Token {format(e.usage.total_tokens)}</p>}/></details>}
      </>}
    </Section>
    <Section title="真实流程与交接" aside={<div className="pi-flow-tools"><label><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>显示已结束任务</label><button className="btn small" onClick={showRelations}>查看完整关系图</button></div>}>
      <p className="muted small">这里显示当前交接、已交付内容和下一步。任务依赖、返修、会话、子代理及完整来源可在关系图中查看{task?'，已选任务会随本次跳转定位':''}。</p>
      {data?<RelationRecords items={data.graph.handoffs.filter(card=>!task||card.task_id===task)} label="任务交接" searchText={card=>JSON.stringify(card)} className="pi-handoff-records" render={card=><article key={card.task_id} className="pi-handoff"><div className="pi-handoff-head"><button className="link" onClick={()=>s.openTask(card.task_id)}>{card.title}</button><Pill tone="quiet">{statusText[card.display_status]||card.display_status}</Pill></div><dl><div><dt>现在由谁接手</dt><dd>{card.owner?s.name(card.owner):'尚未安排'} · {card.actual_model?card.actual_model+'（实际回报）':card.requested_model?card.requested_model+'（计划）':'模型未登记'}</dd></div><div><dt>已交付</dt><dd>{card.outputs.length?<details><summary>本轮归档成果（{card.outputs.length} 项）</summary><RelationRecords items={card.outputs} label="交付产物" searchText={a=>JSON.stringify(a)} render={a=><a key={a.id} href={'/api/artifacts/'+encodeURIComponent(a.id)+'/content?download=1'} download>{a.label}</a>}/></details>:'尚无本轮归档成果'}</dd></div><div><dt>{card.user_action?'需要你做':'下一步'}</dt><dd>{card.next_step}</dd></div></dl><button className="btn small" onClick={()=>{queueRelationSelection(projectId,{taskId:card.task_id});s.go({page:'projects',id:projectId,tab:'diagrams'});}}>定位任务关系</button></article>}/>:!loading?<Empty title="暂时没有可显示的流程"/>:<p>正在读取流程…</p>}
    </Section>
  </div>;
}

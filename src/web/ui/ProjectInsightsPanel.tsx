import React,{useEffect,useId,useMemo,useState} from 'react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import {statusText} from '../lib/flow.js';
import {Empty,Field,Notice,Pill,Section} from './kit.js';
import type {aggregateProjectUsage,UsageMetric} from '../../core/project-usage.ts';
import type {TokenMonitorProjectUsage} from '../../core/token-monitor-usage.ts';
import type {projectTimelineGraph,TimelineNode} from '../../shared/project-timeline.ts';
import {TokenMonitorUsagePanel} from './TokenMonitorUsagePanel.js';
import './project-insights.css';

type Insights={usage:ReturnType<typeof aggregateProjectUsage>;graph:ReturnType<typeof projectTimelineGraph>;unmetered_runs:number;budget_alerts:{run_id:string;task_id:string;known_tokens:number;budget:number;note:string}[];token_monitor?:TokenMonitorProjectUsage};
const metrics:Record<UsageMetric,string>={total_tokens:'总 Token',input_tokens:'输入 Token',output_tokens:'输出 Token',cache_read_tokens:'缓存读取',cache_write_tokens:'缓存写入',reasoning_tokens:'推理 Token',cost_usd:'API 等价估算价（美元）'};
const kinds:Record<string,string>={request:'原始需求',plan:'模型计划',task:'任务',run:'执行',job:'客户端调用',session:'会话',delegation:'报告的子代理',artifact:'归档产物',review_assignment:'审查安排',review:'审查回执',closeout:'执行者收尾',closeout_event:'收尾回执',acceptance:'用户验收'};
const phases=['需求与计划','任务与前置','执行与返修','客户端与子代理','交付产物','独立审查','收尾与验收'];
const phase:Record<string,number>={request:0,plan:0,task:1,run:2,job:3,session:3,delegation:3,artifact:4,review_assignment:5,review:5,closeout:6,closeout_event:6,acceptance:6};
const format=(value:number|null|undefined)=>value==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(value);
const issueText=(reason:string)=>{
  const code=reason.split(':')[0];return ({secondary_usage_source:'同一调用已有主计量来源，当前证据保留但不重复计入。',duplicate_conflict:'同一事件编号出现不同内容，已排除冲突记录。',invalid_event:'来源记录格式或数值无效，未计入。',job_binding_conflict:'记录的项目、任务或执行者与调用不一致，已排除。',sequence_conflict:'同一用量范围的事件顺序冲突，需核对原记录。',counter_regression:'累计计数下降；来源尚未声明新的计数周期，未将其当成新消耗。',time_regression:'事件时间倒退，无法确认对应区间。',unknown_time_boundary:'累计量跨过筛选时间边界，无法准确分摊，暂列未知。',unresolved_message_scope:'来源没有明确消息编号，原始记录已保留，暂不加入小计。',unattributable_parent_filter:'父调用总量包含筛选范围之外的子调用，无法可靠分配给当前模型或执行者。'} as Record<string,string>)[code]||'来源存在未解决的用量问题，详情保留原始原因。';
};
const reasonText=(reason:string)=>({known_usage:'计入已知小计',legacy_summary_known_subtotal:'历史调用摘要：计入已知小计，覆盖完整度未知',secondary_usage_source:'同一调用已有主计量来源，此来源保留追溯但不重复计入',included_in_parent:'已包含在父调用中，不重复计入',unattributable_parent_filter:'父级范围无法分摊，暂列未知'} as Record<string,string>)[reason]||reason;

function FlowCanvas({graph,childrenVisible,onTask,name}:{graph:Insights['graph'];childrenVisible:boolean;onTask:(id:string)=>void;name:(id?:string|null)=>string}){
  const marker=useId().replace(/:/g,''),nodes=graph.nodes.filter(n=>childrenVisible||n.kind!=='delegation'&&!graph.edges.some(e=>e.kind==='parent_child'&&e.to===n.id));
  const ids=new Set(nodes.map(n=>n.id)),edges=graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
  const lanes=[...new Set(nodes.map(n=>n.agent||''))],positions=new Map<string,{x:number;y:number}>();
  const laneRows:{agent:string;y:number;height:number}[]=[];let height=70;
  for(const agent of lanes){const counts=new Map<number,number>();for(const n of nodes.filter(n=>(n.agent||'')===agent)){const column=phase[n.kind]??2,index=counts.get(column)||0;counts.set(column,index+1);positions.set(n.id,{x:160+column*300,y:height+38+index*118});}const laneHeight=Math.max(160,...[...counts.values()].map(v=>v*118+60));laneRows.push({agent,y:height,height:laneHeight});height+=laneHeight;}
  const width=2270,byId=new Map(nodes.map(n=>[n.id,n]));
  const open=(node:TimelineNode)=>{if(node.kind==='task')onTask(node.record_id);else if(node.task_id)onTask(node.task_id);};
  if(!nodes.length)return <Empty title="还没有可显示的项目流程">真实任务、执行和交付记录形成后，会在这里连成流程。</Empty>;
  return <>
    <p className="muted small">从左向右查看阶段，每条横带代表记录中的 Agent。箭头说明已登记关系；同一列的位置不代表先后，未登记依赖也不等于已确认并行。</p>
    <div className="pi-flow-viewport" tabIndex={0} aria-label="项目流程画布，可横向滚动；下方另有文字流程">
      <svg width={width} height={height+16} viewBox={`0 0 ${width} ${height+16}`} role="group" aria-label="项目阶段与 Agent 泳道">
        <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="currentColor"/></marker></defs>
        {phases.map((label,i)=><g key={label}><text className="pi-phase" x={170+i*300} y={35}>{label}</text><line className="pi-column-line" x1={150+i*300} y1={50} x2={150+i*300} y2={height}/></g>)}
        {laneRows.map(l=><g key={l.agent}><rect className="pi-lane" x={8} y={l.y} width={width-20} height={l.height} rx={12}/><foreignObject x={18} y={l.y+16} width={126} height={l.height-20}><div className="pi-lane-name">{l.agent?name(l.agent):'未登记执行者'}</div></foreignObject></g>)}
        {edges.map((edge,i)=>{const a=positions.get(edge.from)!,b=positions.get(edge.to)!,same=a.x===b.x,back=b.x<a.x;const x=a.x+252,y=a.y+42,tx=b.x+(same||back?252:0),ty=b.y+42,mid=same||back?Math.max(x,tx)+28+(i%3)*14:(x+tx)/2;return <g key={edge.from+edge.to+edge.kind} className={'pi-edge pi-edge-'+edge.kind}><path d={`M${x},${y} C${mid},${y} ${mid},${ty} ${tx},${ty}`} markerEnd={`url(#${marker})`}/><text x={mid} y={(y+ty)/2-7} textAnchor="middle">{edge.kind==='parent_child'||edge.kind==='fork'?'父子分支':edge.kind==='retry'||edge.kind==='rework'?'返修 / 续接':edge.kind==='parallel'?'已登记并行':edge.kind==='dependency'?'前置依赖':edge.label}</text><title>{byId.get(edge.from)?.label} → {byId.get(edge.to)?.label}：{edge.label}</title></g>;})}
        {nodes.map(n=>{const p=positions.get(n.id)!,clickable=n.kind==='task'||!!n.task_id;return <g key={n.id} transform={`translate(${p.x},${p.y})`} className={'pi-node pi-kind-'+n.kind}>
          <rect width={252} height={88} rx={10}/><foreignObject x={9} y={8} width={234} height={72}><div className="pi-node-inner">{clickable?<button className="pi-node-button" onClick={()=>open(n)} title={n.label}>{n.label}</button>:n.kind==='artifact'?<a className="pi-node-button" href={'/api/artifacts/'+encodeURIComponent(n.record_id)+'/content?download=1'} download title={n.label}>{n.label}</a>:<strong title={n.label}>{n.label}</strong>}<span>{kinds[n.kind]||'已登记记录'} · {statusText[n.status||'']||n.status||'已关联'}</span>{n.source==='executor_reported'&&<span>执行者报告 · 仅指令约束</span>}</div></foreignObject><title>{n.label}（{n.record_id}）</title>
        </g>;})}
      </svg>
    </div>
    {!!graph.unresolved.length&&<Notice tone="warn">{graph.unresolved.length} 条明确关联暂时找不到对应节点，未推测补全。隐藏历史时也可能看不到关联目标。</Notice>}
    <details className="pi-details"><summary>文字流程与来源记录（{nodes.length} 项）</summary><ol className="pi-text-flow">{nodes.map(n=><li key={n.id}><strong>{kinds[n.kind]||n.kind}：{n.label}</strong>{(n.kind==='task'||n.task_id)&&<button className="btn small" onClick={()=>open(n)}>查看任务</button>}<span>{n.agent?name(n.agent):'未登记执行者'} · {statusText[n.status||'']||n.status||'已关联'}</span><code>{n.record_id}</code>{<span>模型来源：{n.source==='planner_reported'?'规划者自述（'+(n.planning_channel||'未知连接')+'）':n.source==='executor_reported'?'执行者报告':n.source==='unknown'?'未知':'登记的客户端 / 执行回执'}；实际报告：{n.actual_model||(n.reported_model? n.reported_model+'（自述，未核验）':'未知')}；计划：{n.requested_model||'未指定'}。未提供独立核验时，不视为身份验证。</span>}{n.artifact_paths?.map(path=><span key={path}>报告的产物路径（未核验）：{path}</span>)}{edges.filter(e=>e.from===n.id).map(e=><span key={e.to+e.kind}>→ {e.label}：{byId.get(e.to)?.label}</span>)}</li>)}</ol>{!!graph.unresolved.length&&<ul>{graph.unresolved.map((e,i)=><li key={i}>{e.label}：{e.from} → {e.to}（目标尚未解析）</li>)}</ul>}</details>
  </>;
}

export function ProjectInsightsPanel({projectId}:{projectId:string}){
  const s=useStore(),[data,setData]=useState<Insights|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[agent,setAgent]=useState(''),[model,setModel]=useState(''),[role,setRole]=useState(''),[task,setTask]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[history,setHistory]=useState(true),[children,setChildren]=useState(true);
  const [rosterModels,setRosterModels]=useState<string[]>([]);
  useEffect(()=>{setAgent('');setModel('');setRole('');setTask('');setFrom('');setTo('');setData(null);setRosterModels([]);},[projectId]);
  const invalidRange=!!from&&!!to&&from>to;
  useEffect(()=>{if(invalidRange)return;const controller=new AbortController();setLoading(true);setError('');const params=new URLSearchParams({history:String(history)});if(agent)params.set('agent_id',agent);if(model)params.set('model',model);if(role)params.set('role',role);if(task)params.set('task_id',task);if(from)params.set('from',new Date(from+'T00:00:00').toISOString());if(to)params.set('to',new Date(to+'T23:59:59.999').toISOString());api(`/projects/${encodeURIComponent(projectId)}/insights?${params}`,undefined,controller.signal).then((result:Insights)=>{if(controller.signal.aborted)return;setData(result);setRosterModels(old=>[...new Set([...old,...result.graph.nodes.map(n=>n.actual_model).filter((v):v is string=>!!v),...result.usage.trace.map(t=>t.actual_model).filter((v):v is string=>!!v)])]);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[projectId,agent,model,role,task,from,to,history,s.changeTick,invalidRange]);
  const roster=(s.data.agents||[]) as {id:string;name?:string}[],projectTasks=((s.data.tasks||[]) as {id:string;project_id:string;title:string}[]).filter(t=>t.project_id===projectId);
  const traceJobs=useMemo(()=>{const groups=new Map<string,NonNullable<Insights['usage']>['trace']>();for(const item of data?.usage.trace||[]){const list=groups.get(item.job_id)||[];list.push(item);groups.set(item.job_id,list);}for(const id of data?.usage.missing_job_ids||[])if(!groups.has(id))groups.set(id,[]);return [...groups];},[data]);
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
      <p className="muted small">按当前设备的本地日期筛选用量。实际模型来自客户端报告，请求模型另行保留。下方流程保留项目全貌，日期与 Agent 筛选用于用量。</p>
      {invalidRange&&<Notice tone="error">结束日期需要晚于或等于开始日期。</Notice>}{error&&<Notice tone="error">读取项目用量失败：{error}</Notice>}
      {loading&&<p role="status">正在读取项目记录…</p>}
      {!loading&&!error&&!invalidRange&&u&&<>
        <div className="pi-metrics"><article><span>调用已知 Token 小计</span><strong>{format(u.subtotal.total_tokens)}</strong><small>只含可以确认的用量</small></article><article><span>已知输入 / 输出</span><strong>{format(u.subtotal.input_tokens)} / {format(u.subtotal.output_tokens)}</strong><small>缓存与推理不重复加算</small></article><article><span>调用用量覆盖</span><strong>{totalCoverage?.ratio==null?'—':new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(totalCoverage.ratio)}</strong><small>{format(totalCoverage?.complete_jobs)} / {format(totalCoverage?.total_jobs)} 次调用的总量完整</small></article><article><span>总量缺失或不完整</span><strong>{format(missingTotal)}</strong><small>缺失代表未知，不能当成 0</small></article></div>
        <Notice>这些数字是已知小计，不是完整账单，也不代表订阅实际扣费。缓存和推理可能已包含在总量中。TokenMonitor 全机统计是会话视角，本节是工作台调用账本；两种视角不能相加。</Notice>
        {!!data?.unmetered_runs&&<Notice tone="warn">整个项目另有 {data.unmetered_runs} 次执行没有工作台客户端调用用量，包括手动或外部执行。上方覆盖比例仅针对已登记的客户端调用，不能代表整个项目。</Notice>}
        {data?.budget_alerts?.map(b=><Notice key={b.run_id} tone="warn">本轮已知 Token {format(b.known_tokens)} 已达到提醒预算 {format(b.budget)}。当前调用继续；负责人可决定是否停止。<button className="btn small" onClick={()=>s.openTask(b.task_id)}>查看任务</button></Notice>)}
        {!!u.issues.length&&<details className="pi-details"><summary>有 {u.issues.length} 条来源说明需要留意</summary><ul>{u.issues.map((issue,i)=><li key={issue.event_id+issue.reason+i}>{issueText(issue.reason)}<details><summary>原始记录编号与原因</summary><code>{issue.event_id} · {issue.reason}</code></details></li>)}</ul></details>}
        <details className="pi-details"><summary>逐项追溯调用（{traceJobs.length} 项）</summary>{!traceJobs.length?<Empty title="当前范围还没有可追溯的调用用量"/>:traceJobs.map(([id,items])=><details className="pi-trace-job" key={id}><summary>调用 {id}{!items.length?' · 用量未知':totalCoverage?.missing_job_ids.includes(id)?' · 总量未知或不完整':''}</summary>{!!u.missing.filter(m=>m.job_id===id).length&&<p>本次调用仍有缺失指标：{[...new Set(u.missing.filter(m=>m.job_id===id).map(m=>metrics[m.metric]))].join('、')}。已有小计保留，缺失部分未按 0 处理。</p>}{!items.length?<p>尚未收到可确认的用量事件。</p>:<ul>{items.map((item,i)=><li key={item.event_id+item.metric+i}><strong>{metrics[item.metric]}：{format(item.value)}</strong><span>{reasonText(item.reason)}</span><span>实际模型：{item.actual_model||'未知'} · 请求模型：{item.requested_model||'未指定'}</span><span>来源：{item.source} · {item.end}</span><code>事件 {item.event_id} · 范围 {item.scope_id} · 周期 {item.epoch}</code></li>)}</ul>}</details>)}</details>
        {!!u.external_totals.length&&<details className="pi-details"><summary>独立的全机来源快照（{u.external_totals.length} 项，未加入项目小计）</summary>{u.external_totals.map(e=><p key={e.id}>来源 {e.source} · {e.occurred_at} · 全机总 Token {format(e.usage.total_tokens)}</p>)}</details>}
      </>}
    </Section>
    <Section title="真实流程与交接" aside={<div className="pi-flow-tools"><label><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>显示已结束任务</label><label><input type="checkbox" checked={children} onChange={e=>setChildren(e.target.checked)}/>展开子代理与分支</label></div>}>
      {data?<FlowCanvas graph={data.graph} childrenVisible={children} onTask={s.openTask} name={s.name}/>:!loading?<Empty title="暂时没有可显示的流程"/>:<p>正在读取流程…</p>}
    </Section>
  </div>;
}

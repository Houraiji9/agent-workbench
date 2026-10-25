import React,{useState} from 'react';
import type {TokenMonitorProjectUsage} from '../../core/token-monitor-usage.ts';
import {Empty,Field,Notice,Pill,Section} from './kit.js';

type PeriodKey='today'|'month'|'allTime';
const periodLabels:Record<PeriodKey,string>={today:'今日',month:'本月',allTime:'全部历史'};
const format=(value:number|null|undefined)=>value==null?'—':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(value);
const formatCost=(value:number|null|undefined)=>value==null?'—':new Intl.NumberFormat('zh-CN',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(value);
const formatTime=(value:string|null|undefined,timeZone?:string)=>{
  if(!value)return '未知';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return value;
  try{return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',...(timeZone?{timeZone}:{})}).format(date);}
  catch{return date.toISOString()+'（UTC；来源时区无效）';}
};
const associationText=(value:string)=>({exact_registered_session:'已登记的会话关联',exact_registered_cwd:'精确工作目录关联',unassigned:'未归属',ambiguous:'归属有歧义',invalid:'无效记录'} as Record<string,string>)[value]||value;

export function TokenMonitorUsagePanel({usage,onTask}:{usage?:TokenMonitorProjectUsage;onTask:(id:string)=>void}){
  const [period,setPeriod]=useState<PeriodKey>('month');
  const selected=usage?.periods[period];
  return <Section title="Token Monitor · 项目会话用量" aside={<Pill tone="quiet">会话来源</Pill>}>
    <div className="tm-usage-controls">
      <Field label="统计范围"><select aria-label="Token Monitor 会话统计范围" value={period} onChange={e=>setPeriod(e.target.value as PeriodKey)}>
        {(Object.keys(periodLabels) as PeriodKey[]).map(key=><option key={key} value={key}>{periodLabels[key]}</option>)}
      </select></Field>
      <p className="muted small">按 TokenMonitor 会话的来源时间统计。此范围独立于下方工作台调用任务与日期筛选。</p>
    </div>
    {!usage?<Empty title="当前没有可用的会话用量数据">当前后端尚未提供 TokenMonitor 会话数据，因此不显示为 0。更新后端或稍后刷新即可查看。</Empty>:<>
      <p className="tm-source-meta">来源：{usage.source} · 来源更新时间（本机时间）：{formatTime(usage.updated_at)}</p>
      {usage.status!=='connected'&&<Notice tone="warn">来源当前未连接或已过期；有数据时保留最后有效快照，请留意更新时间。</Notice>}
      {usage.note&&<Notice>{usage.note}</Notice>}
      {!selected?.available?<Empty title="此统计范围没有可确认的项目会话用量">{selected?.note||usage.note||'来源未提供此范围的会话明细；缺少数据不代表用量为 0。'}</Empty>:<>
        <div className="pi-metrics tm-usage-metrics">
          <article><span>总 Token（含缓存）</span><strong>{format(selected.summary.total_tokens)}</strong><small>按来源总量展示；缓存不重复加算</small></article>
          <article><span>新输入 / 输出</span><strong>{format(selected.summary.input_tokens)} / {format(selected.summary.output_tokens)}</strong><small>按来源字段分别展示，不重复加算</small></article>
          <article><span>缓存读取 / 写入</span><strong>{format(selected.summary.cache_read_tokens)} / {format(selected.summary.cache_write_tokens)}</strong><small>来源报告的缓存 Token</small></article>
          <article><span>API 等价估价</span><strong>{formatCost(selected.summary.cost_usd)}</strong><small>仅估价，不是实际扣款</small></article>
        </div>
        <p className="tm-usage-counts"><strong>{format(selected.matched_sessions)}</strong> 个已关联会话 / 来源共 <strong>{format(selected.total_sessions)}</strong> 个会话</p>
        {(selected.unassigned_sessions>0||selected.ambiguous_sessions>0||selected.invalid_sessions>0)&&<Notice tone="warn">来源中有 {format(selected.unassigned_sessions)} 个未归属、{format(selected.ambiguous_sessions)} 个归属有歧义、{format(selected.invalid_sessions)} 个无效会话；这些记录不会被算作已关联到本项目。</Notice>}
        {!!selected.note&&<p className="muted small">{selected.note}</p>}
        {!!selected.windows.length&&<details className="pi-details tm-windows"><summary>来源统计窗口（{selected.windows.length} 项）</summary><ul>{selected.windows.map((window,index)=><li key={window.device_id+window.key+index}><span>设备 {window.device_id||'未知'} · {window.key||'未命名窗口'}</span><span>结束时间：{formatTime(window.ends_at,window.time_zone||'UTC')} · 来源时区：{window.time_zone||'未知（按 UTC 显示）'}{window.stale?' · 数据可能已过期':''}</span></li>)}</ul></details>}
        <details className="pi-details tm-sessions"><summary>已关联会话详情（{selected.rows.length} 项）</summary>{!selected.rows.length?<Empty title="此范围没有已关联的会话明细">来源汇总可用，但没有可逐项查看的已关联会话记录。</Empty>:selected.rows.map(row=><details className="pi-trace-job tm-session" key={row.key}>
          <summary>{row.client||'未知客户端'} · {row.session_id||'未知会话'} · {associationText(row.association)}</summary>
          <div className="tm-session-meta"><span>客户端：{row.client||'未知'}</span><span>会话：<code>{row.session_id||'未知'}</code></span><span>设备：<code>{row.device_id||'未知'}</code></span><span>开始（本机时间）：{formatTime(row.started_at)} · 最近使用（本机时间）：{formatTime(row.last_used_at)}</span></div>
          <div className="tm-models"><strong>模型 Token</strong>{Object.keys(row.models).length?<ul>{Object.entries(row.models).map(([model,tokens])=><li key={model}><span>{model}：{format(tokens)} Token</span><span>API 等价估价：{formatCost(row.model_costs[model])}</span></li>)}</ul>:<p className="muted small">来源没有提供逐模型 Token 明细。</p>}</div>
          {!!row.task_ids.length&&<div className="tm-session-tasks"><span>关联任务：</span>{row.task_ids.map(id=><button className="btn small" key={id} onClick={()=>onTask(id)}>打开任务 {id}</button>)}</div>}
        </details>)}</details>
      </>}
    </>}
  </Section>;
}

import React from 'react';
import {Copy, ArrowRight} from 'lucide-react';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {byExecutionOrder, waitingForDependencies} from '../../shared/execution-order.js';
import {Pill} from './kit.js';
import {copyOrder} from '../views/actions.js';

export function OrderStep({task}: {task:R}) {
  return task.execution ? <span className="order-step">{task.execution.step ? `第 ${task.execution.step} 步` : '顺序待核对'}</span> : null;
}

export function OrderStatus({task}: {task:R}) {
  return waitingForDependencies(task) ? <Pill tone="quiet">等待前序</Pill>
    : ['ready','awaiting_dispatch'].includes(task.status) ? <Pill tone="you">可执行</Pill> : <Pill task={task}/>;
}

export function ExecutionList({tasks, queue=false}: {tasks:R[];queue?:boolean}) {
  const s=useStore();
  const list=[...tasks].sort(queue
    ? (a,b)=>(a.execution?.queue_position??Infinity)-(b.execution?.queue_position??Infinity)||byExecutionOrder(a,b)
    : byExecutionOrder);
  return <div className="order-list">{list.map(t=>{
    const waiting=waitingForDependencies(t), next=t.execution?.dependencies.filter((d:R)=>!d.satisfied)||[];
    const ready=['ready','awaiting_dispatch'].includes(t.status)&&!waiting;
    return <article className={'order-row'+(waiting?' is-waiting':'')} key={t.id} aria-label={t.title}>
      <div className="order-position">{queue&&t.execution?.queue_position?<span className="order-step">建议第 {t.execution.queue_position} 单</span>:<OrderStep task={t}/>}</div>
      <div className="order-body">
        <button className="order-title" onClick={()=>s.openTask(t.id)}>{t.title}</button>
        <div className="order-meta"><span>{queue?s.pname(t.project_id):s.name(s.executorOf(t))}</span><OrderStatus task={t}/></div>
        {waiting&&<div className="order-dependencies">先完成{next.map((d:R)=><button className="link" key={d.id} onClick={()=>s.openTask(d.effective_id)}>{d.effective_title}</button>)}{!next.length&&<span>顺序核对</span>}</div>}
      </div>
      {!queue&&ready&&<button className="btn small" disabled={s.busy} onClick={()=>void copyOrder(s,t)}><Copy size={14}/>复制执行单</button>}
    </article>;
  })}</div>;
}

/** Dependency names link to the actual prerequisite (including its replacement). */
export function TaskOrder({task}: {task:R}) {
  const s=useStore(), e=task.execution;
  if(!e)return null;
  const following=e.unlocks.filter((t:R)=>!['accepted','cancelled','rework_linked'].includes(t.status));
  return <section className="block task-order" aria-label="执行顺序">
    <div className="order-heading"><h2>执行顺序</h2><OrderStep task={task}/></div>
    {e.queue_position&&<p className="order-queue">{s.name(e.executor_id)} · 建议第 {e.queue_position} 单{e.ahead&&<>，先处理 <button className="link inline" onClick={()=>s.openTask(e.ahead.id)}>{e.ahead.title}</button></>}</p>}
    {!!e.active_work.length&&<div className="order-dependencies">手头正在处理：{e.active_work.map((t:R)=><button className="link" key={t.id} onClick={()=>s.openTask(t.id)}>{t.title}</button>)}</div>}
    {!!e.dependencies.length&&<div className="order-dependency-list">{e.dependencies.map((d:R)=><div key={d.id}><span>{d.satisfied?'已完成':'先完成'}</span><button className="link" onClick={()=>s.openTask(d.effective_id)}>{d.effective_title}</button><Pill task={s.data.tasks.find((t:R)=>t.id===d.effective_id)||d}/></div>)}</div>}
    {!!following.length&&<details className="fold"><summary>完成后可继续的任务（{following.length}）</summary><div className="order-dependencies">{following.map((t:R)=><button className="link" key={t.id} onClick={()=>s.openTask(t.id)}><ArrowRight size={14}/>{t.title}</button>)}</div></details>}
  </section>;
}

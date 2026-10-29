import React,{useState} from 'react';
import {Folder,Check,X} from 'lucide-react';
import {useStore} from '../app/store.js';
import {api} from '../api.js';
import {Pill} from './kit.js';
import type {R} from '../lib/flow.js';

export const pendingDecisions=(data:R,includeShelved=false):R[]=>(data.user_decisions||[]).filter((d:R)=>['pending','expired'].includes(d.status)&&(includeShelved||!data.projects.some((p:R)=>p.id===d.project_id&&(p.shelved||p.archived))));
export function UserDecision({decision:d}:{decision:R}){
  const s=useStore(),expired=d.status==='expired'||Date.parse(d.expires_at)<=Date.now();
  const resolve=(choice:'confirm'|'cancel')=>s.act(()=>api(`/user-decisions/${d.id}/${choice}`,{}),choice==='confirm'?'已确认':'已取消');
  return <article className="turn t-you" aria-label={d.title+'：'+d.task_title}>
    <div className="turn-heading"><span className="active-project"><Folder size={13}/>{s.pname(d.project_id)}</span><div className="turn-top"><Pill tone="you">等你确认</Pill></div></div>
    <button className="turn-title" onClick={()=>s.openTask(d.task_id)}>{d.task_title}</button>
    <div>
    {d.details.map((line:string,i:number)=><p className="turn-next" key={i}>{line}</p>)}
    {d.checks.length>0&&<ul className="plain-list">{d.checks.map((line:string,i:number)=><li key={i}>{line}</li>)}</ul>}
    </div>
    <div className="turn-actions">
      {expired?<button className="btn primary" disabled={s.busy} onClick={()=>void s.act(()=>api(`/user-decisions/${d.id}/refresh`,{}),'确认卡已刷新')} >刷新确认事项</button>:<button className="btn primary" disabled={s.busy} onClick={()=>void resolve('confirm')}><Check size={16}/>{d.title}</button>}
      <button className="btn" disabled={s.busy} onClick={()=>void resolve('cancel')}><X size={16}/>取消这项确认</button>
    </div>
  </article>;
}

export function groupedDecisions(cards:R[],data:R):R[]{
  const output:R[]=[],groups=new Map<string,R>();
  for(const card of cards){const task=data.tasks.find((t:R)=>t.id===card.task_id),key=card.action==='accept'?task?.delivery_group_id:null;
    if(!key){output.push(card);continue;}
    let group=groups.get(key);if(!group){group={id:'group-'+key,delivery_group_id:key,project_id:card.project_id,cards:[]};groups.set(key,group);output.push(group);}group.cards.push(card);
  }
  return output.map(item=>item.cards?.length===1?item.cards[0]:item);
}
export function DecisionGroup({group}:{group:R}){
  const s=useStore(),[selected,setSelected]=useState<string[]>([]);
  const cards:R[]=group.cards,ready=cards.filter(d=>d.status==='pending'&&Date.parse(d.expires_at)>Date.now());
  const chosen=ready.filter(d=>selected.includes(d.id)).map(d=>d.id);
  return <article className="turn t-you" aria-label="关联交付验收"><div className="turn-heading"><strong>关联交付 · {cards.length} 个阶段</strong></div>
    <p>按实际试用结果勾选本次验收的阶段，每个阶段保留各自的审查与收尾记录。</p>
    {cards.map(d=><div key={d.id}><label><input type="checkbox" checked={selected.includes(d.id)} disabled={!ready.some(r=>r.id===d.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,d.id]:old.filter(id=>id!==d.id))}/>{d.task_title}</label>
      <ul className="plain-list">{d.checks.map((c:string,i:number)=><li key={i}>{c}</li>)}</ul>
      {!ready.some(r=>r.id===d.id)&&<button className="btn small" disabled={s.busy} onClick={()=>void s.act(()=>api(`/user-decisions/${d.id}/refresh`,{}),'确认卡已刷新')}>刷新这项确认</button>}
      <button className="btn ghost small" onClick={()=>s.openTask(d.task_id)}>查看阶段记录</button></div>)}
    <button className="btn primary" disabled={s.busy||!chosen.length} onClick={()=>void s.act(()=>api('/user-decision-groups/confirm',{decision_ids:chosen}),'已验收选中的阶段')}>验收选中的 {chosen.length} 个阶段</button>
  </article>;
}

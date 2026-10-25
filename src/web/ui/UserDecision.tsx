import React from 'react';
import {Folder,Check,X} from 'lucide-react';
import {useStore} from '../app/store.js';
import {api} from '../api.js';
import {Pill} from './kit.js';
import type {R} from '../lib/flow.js';

export const pendingDecisions=(data:R,includeShelved=false):R[]=>(data.user_decisions||[]).filter((d:R)=>d.status==='pending'&&Date.parse(d.expires_at)>Date.now()&&(includeShelved||!data.projects.some((p:R)=>p.id===d.project_id&&(p.shelved||p.archived))));
export function UserDecision({decision:d}:{decision:R}){
  const s=useStore();
  const resolve=(choice:'confirm'|'cancel')=>s.act(()=>api(`/user-decisions/${d.id}/${choice}`,{}),choice==='confirm'?'已确认':'已取消');
  return <article className="turn t-you" aria-label={d.title+'：'+d.task_title}>
    <div className="turn-heading"><span className="active-project"><Folder size={13}/>{s.pname(d.project_id)}</span><div className="turn-top"><Pill tone="you">等你确认</Pill></div></div>
    <button className="turn-title" onClick={()=>s.openTask(d.task_id)}>{d.task_title}</button>
    <div>
    {d.details.map((line:string,i:number)=><p className="turn-next" key={i}>{line}</p>)}
    {d.checks.length>0&&<ul className="plain-list">{d.checks.map((line:string,i:number)=><li key={i}>{line}</li>)}</ul>}
    </div>
    <div className="turn-actions">
      <button className="btn primary" disabled={s.busy} onClick={()=>void resolve('confirm')}><Check size={16}/>{d.title}</button>
      <button className="btn" disabled={s.busy} onClick={()=>void resolve('cancel')}><X size={16}/>取消这项确认</button>
    </div>
  </article>;
}

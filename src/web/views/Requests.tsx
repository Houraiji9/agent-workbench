import {RequestPreview} from '../ui/RequestPreview.js';
import {RequestMoreActions,requestMeta,requestStatusText} from '../ui/RequestActions.js';
import React,{useState} from 'react';import {Copy,MessagesSquare,X} from 'lucide-react';import {useStore} from '../app/store.js';import {Tabs,Empty,Pill} from '../ui/kit.js';import type {R} from '../lib/flow.js';import {relative} from '../lib/format.js';import {canEditRequest} from '../../shared/request-policy.js';import {copyPlanning,startPlanning} from './actions.js';import {ChatPlanningDialog} from '../ui/ChatPlanningDialog.js';
const tabStatus:Record<string,string>={drafts:'draft',waiting:'awaiting_planning',planned:'planned'};
// 需求箱：管理需求从记下、规划到生成计划的过程。项目筛选只来自地址（#/requests/项目），侧栏返回、前进后退和刷新都一致。
export function Requests(){
 const s=useStore(),[query,setQuery]=useState(''),[chatRequest,setChatRequest]=useState(''),tab=s.route.tab||'drafts';
 const projectById=new Map((s.data.projects as R[]).map(p=>[p.id,p]));
 const project=s.route.id&&projectById.has(s.route.id)?s.route.id:'';
 const setProject=(id:string)=>s.go({page:'requests',id:id||undefined,tab:s.route.tab});
 const scoped=(s.data.requests as R[]).filter(q=>(project?q.project_id===project:!projectById.get(q.project_id)?.shelved)&&[q.text,s.pname(q.project_id)].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
 const count=(key:string)=>scoped.filter(q=>q.status===tabStatus[key]).length;
 const items=scoped.filter(q=>q.status===(tabStatus[tab]||'draft')).sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at)));
 return <div className="page-wrap"><header className="page-head"><div><h1>需求箱</h1><p>记下想法，开始规划，查看生成的计划。</p></div></header>
   <Tabs label="需求状态" value={tab} onChange={s.setTab} tabs={[[ 'drafts','待开始',count('drafts')],['waiting','待规划',count('waiting')],['planned','已生成计划',count('planned')]]}/>
   <div className="library-tools"><input className="filter-input" aria-label="搜索需求" placeholder="搜索内容或项目" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="筛选需求项目" value={project} onChange={e=>setProject(e.target.value)}><option value="">全部项目</option>{s.data.projects.map((p:R)=><option key={p.id} value={p.id}>{p.name}{p.archived?' · 已归档':''}</option>)}</select>
     {project&&<button className="btn small ghost" onClick={()=>setProject('')}><X size={14}/>看全部项目</button>}</div>
   {!items.length?<Empty title={query||project?'没有符合筛选的需求':'这里还没有内容'}>{query||project?'换个关键词或项目试试。':tab==='drafts'?'点右上角“提需求”记下一个想法。':tab==='waiting'?'提需求时点“现在开始”，需求就会出现在这里。':'规划 Agent 提交计划后，可以在这里查看。'}</Empty>:<div className="request-list">{items.map(q=>{const projectRecord=projectById.get(q.project_id)||{},archived=projectRecord.archived,editable=!archived&&canEditRequest(q,s.data.tasks,s.data.runs);return <article className="request-card" key={q.id} aria-label={q.text}>
     <div className="request-card-head">
       <div className="turn-top"><Pill tone={q.status==='awaiting_planning'?'you':'quiet'}>{requestStatusText[q.status]}</Pill><small>{s.pname(q.project_id)}{archived?' · 已归档':''} · {relative(q.updated_at||q.created_at,s.tz)}</small></div>
       <div className="now-actions">
         {!archived&&q.status==='draft'&&<button className="btn small primary" disabled={s.busy} onClick={()=>void startPlanning(s,q)}>现在开始</button>}
         {!archived&&q.status==='awaiting_planning'&&<><button className="btn small primary" disabled={s.busy} onClick={()=>void copyPlanning(s,q)}><Copy size={14}/>复制规划请求</button><button className="btn small" onClick={()=>setChatRequest(q.id)}><MessagesSquare size={14}/>在聊天里规划</button></>}
         {q.status==='planned'&&<button className="btn small" onClick={()=>s.go({page:'projects',id:q.project_id})}>查看执行顺序</button>}
       </div>
     </div>
     <RequestPreview request={q}/>
     <div className="request-card-foot">
       <span className="muted small">{requestMeta(q,projectRecord)}</span>
       <span className="request-card-links">{q.status!=='planned'&&<button className="link" onClick={()=>s.go({page:'projects',id:q.project_id})}>查看项目</button>}{!archived&&<RequestMoreActions q={q} editable={editable}/>}</span>
     </div>
   </article>})}</div>}
 {chatRequest&&<ChatPlanningDialog requestId={chatRequest} onClose={()=>setChatRequest('')}/>}
 </div>
}

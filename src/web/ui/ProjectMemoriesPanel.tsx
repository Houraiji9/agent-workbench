import React,{useEffect,useState} from 'react';
import {Lightbulb,Plus,PencilLine,Trash2,RotateCcw,History} from 'lucide-react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {relative,fullDate} from '../lib/format.js';
import {Dialog,Empty,Field,Notice,Pill} from './kit.js';
import './project-memories.css';

const kinds:R={decision:'决定',known_issue:'已知问题',failed_attempt:'走过的弯路',handoff:'接着做的入口'};
const statuses:R={confirmed:'已确认',candidate:'候选',superseded:'已被取代'};
const actions:R={update:'编辑',delete:'删除',restore:'恢复',supersede:'被新经验取代'};
export function ProjectMemoriesPanel({project,memories}:{project:R;memories:R[]}){
 const s=useStore(),[history,setHistory]=useState(false),[historyRows,setHistoryRows]=useState<R[]>([]),[loading,setLoading]=useState(false),[historyError,setHistoryError]=useState('');
 const [edit,setEdit]=useState<R|null>(null),[draft,setDraft]=useState<R>({}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState('');
 const active=memories.filter(m=>!m.deleted_at);
 const sorted=[...(history?historyRows:active)].sort((a,b)=>Number(!!a.deleted_at)-Number(!!b.deleted_at)||Number(a.status==='superseded')-Number(b.status==='superseded')||String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at)));
 useEffect(()=>{
  if(!history)return;const abort=new AbortController();setLoading(true);setHistoryError('');
  api(`/projects/${encodeURIComponent(project.id)}/memories/history`,undefined,abort.signal).then(v=>setHistoryRows(v.items)).catch(e=>{if(!abort.signal.aborted)setHistoryError(String(e.message||e));}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  return()=>abort.abort();
 },[history,project.id,s.changeTick]);
 const source=(id:string)=>(s.data.tasks as R[]).find(t=>t.id===id)?.title||(s.data.sessions as R[]).find(x=>x.id===id)?.title||id;
 const author=(actor:string)=>actor==='user'?'用户':s.name(actor)||actor;
 const openEdit=(m:R)=>{setEdit({...m});setDraft({kind:m.kind,content:m.content,scope:m.scope||'project'});setError('');};
 const save=async()=>{
  if(!edit||saving)return;setSaving(true);setError('');
  try{await api('/memories',{action:'update',project_id:project.id,memory_id:edit.id,version:edit.version||1,...draft});setEdit(null);s.toast('经验已保存，原作者与版本历史保留');await s.refresh();}
  catch(e){setError(String((e as Error).message||e));}finally{setSaving(false);}
 };
 const mutate=async(m:R,action:'delete'|'restore')=>{
  if(pending)return;setPending(m.id);
  try{await api('/memories',{action,project_id:project.id,memory_id:m.id,version:m.version||1});s.toast(action==='delete'?'已删除，可在“历史与已删除”中恢复':'经验已恢复，替代关系保留');await s.refresh();}
  catch(e){s.toast(String((e as Error).message||e),'error');}finally{setPending('');}
 };
 const latest=edit?memories.find(m=>m.id===edit.id):null;
 const conflict=!!edit&&(!latest||(latest.version||1)!==(edit.version||1));
 return <section className="project-memories" aria-label="项目经验">
  <div className="banner quiet"><Lightbulb size={22} aria-hidden="true"/><div><strong>项目经验</strong><p>决定、问题和下次继续的位置。</p></div><button className="btn" onClick={()=>s.openDialog('memory',{projectId:project.id})}><Plus size={16} aria-hidden="true"/>记一条</button></div>
  <div className="tool-row"><button className="btn small" aria-pressed={history} onClick={()=>setHistory(!history)}><History size={16} aria-hidden="true"/>{history?'返回当前经验':'历史与已删除'}</button><span className="muted small">当前 {active.length} 条{history?' · 含已删除条目和修订记录':''}</span></div>
  {history&&<Notice>删除仅收纳这条经验，来源任务与会话保留。恢复会保留已被取代的状态。</Notice>}
  {loading&&<p role="status">正在读取历史…</p>}
  {historyError&&<p role="alert">{historyError}</p>}
  {sorted.length?<div className="memory-list">{sorted.map(m=><article key={m.id} className={'memory m-'+(m.deleted_at?'deleted':m.status)}>
   <div className="memory-top"><b>{kinds[m.kind]||m.kind}</b><Pill tone={m.deleted_at?'quiet':m.status==='confirmed'?'done':m.status==='candidate'?'review':'quiet'}>{m.deleted_at?'已删除':statuses[m.status]||m.status}</Pill>{m.deleted_at&&<span className="muted small">原状态：{statuses[m.status]}</span>}</div>
   <p>{m.content}</p><small>原作者：{author(m.source)} · 来自：{source(m.source_id)} · {relative(m.created_at,s.tz)} · 版本 {m.version||1}</small>
   {m.supersedes&&<p className="muted small">取代：{m.supersedes}</p>}
   {m.deleted_at&&<p className="muted small">{fullDate(m.deleted_at,s.tz)} 由 {author(m.deleted_by)} 删除</p>}
   <div className="tool-row">{m.deleted_at?<button className="btn small" disabled={!!pending} onClick={()=>void mutate(m,'restore')}><RotateCcw size={15} aria-hidden="true"/>{pending===m.id?'正在恢复…':'恢复'}</button>:<><button className="btn small" disabled={!!pending} onClick={()=>openEdit(m)}><PencilLine size={15} aria-hidden="true"/>编辑</button><button className="btn small ghost" disabled={!!pending} onClick={()=>void mutate(m,'delete')}><Trash2 size={15} aria-hidden="true"/>{pending===m.id?'正在删除…':'删除'}</button></>}</div>
   {history&&<details className="fold"><summary>修订历史（{(m.revisions||[]).length}）</summary>{(m.revisions||[]).length?(m.revisions as R[]).slice().reverse().map(r=><div className="memory" key={r.version}><b>版本 {r.version}</b><p className="muted small">{fullDate(r.recorded_at,s.tz)} · {author(r.recorded_by)} {actions[r.action]||r.action}前 · {statuses[r.snapshot.status]}</p><p>{r.snapshot.content}</p><small>类型：{kinds[r.snapshot.kind]} · 范围：{r.snapshot.scope} · 原作者：{author(r.snapshot.source)}</small></div>):<p className="muted">尚无修订，当前为原始版本。</p>}</details>}
  </article>)}</div>:!loading&&<Empty title={history?'没有历史记录':'还没有记录'}>完成任务后，记一条经验，下次接着做会轻松很多。</Empty>}
  {edit&&<Dialog title="编辑项目经验" sub={`原作者：${author(edit.source)} · ${statuses[edit.status]} · 版本 ${edit.version||1}`} onClose={()=>{if(!saving)setEdit(null);}}>
   <form className="form" onSubmit={e=>{e.preventDefault();void save();}}>
    <Field label="经验类型"><select aria-label="经验类型" value={draft.kind} disabled={saving} onChange={e=>setDraft({...draft,kind:e.target.value})}>{Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label as string}</option>)}</select></Field>
    <Field label="经验内容"><textarea aria-label="经验内容" rows={8} maxLength={20000} required value={draft.content} disabled={saving} onChange={e=>setDraft({...draft,content:e.target.value})}/></Field>
    <Field label="适用范围"><input aria-label="适用范围" maxLength={100} required value={draft.scope} disabled={saving} onChange={e=>setDraft({...draft,scope:e.target.value})}/></Field>
    <p className="muted small">保留原作者、来源、确认依据和替代关系。本次修改另记操作者与版本。</p>
    {conflict&&<Notice tone="warn">这条经验已发生变化。你的草稿保留；保存时会检查版本，请复制需要保留的文字后取消并重新打开。</Notice>}
    {error&&<p role="alert">{error}</p>}
    <div className="tool-row"><button className="btn primary" disabled={saving||!String(draft.content||'').trim()||!String(draft.scope||'').trim()}>{saving?'正在保存…':'保存'}</button><button className="btn" type="button" disabled={saving} onClick={()=>setEdit(null)}>取消</button></div>
   </form>
  </Dialog>}
 </section>;
}

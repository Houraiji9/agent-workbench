import React,{useMemo,useState} from 'react';

/** Rendering stays bounded even when the backing evidence contains a long history. */
export function RelationRecords<T>({items,label,searchText,render,className=''}:{items:T[];label:string;searchText:(item:T)=>string;render:(item:T,index:number)=>React.ReactNode;className?:string}){
  const [query,setQuery]=useState(''),[page,setPage]=useState(0),size=20;
  const filtered=useMemo(()=>{const q=query.trim().toLocaleLowerCase();return q?items.filter(item=>searchText(item).toLocaleLowerCase().includes(q)):items;},[items,query,searchText]);
  const pages=Math.max(1,Math.ceil(filtered.length/size)),current=Math.min(page,pages-1),start=current*size;
  return <div className={'pi-records '+className} role="group" aria-label={label}>
    <div className="pi-record-tools"><label>搜索{label}<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setPage(0)}}/></label><span role="status">共 {items.length} 项{query?` · 匹配 ${filtered.length} 项`:''} · 每页 {size} 项</span></div>
    <div className="pi-record-window" key={current+query} tabIndex={0} aria-label={label+'，可滚动查看本页'}>{filtered.length?filtered.slice(start,start+size).map((item,index)=>render(item,start+index)):<p className="muted">{query?'没有匹配记录。':'当前范围暂无记录。'}</p>}</div>
    <div className="pi-pagination" aria-label={label+'分页'}><button className="btn small" disabled={current===0} onClick={()=>setPage(current-1)}>上一页</button><span>第 {current+1} / {pages} 页{filtered.length?` · ${start+1}–${Math.min(start+size,filtered.length)} 项`:''}</span><button className="btn small" disabled={current>=pages-1} onClick={()=>setPage(current+1)}>下一页</button></div>
  </div>;
}

export type RelationSelection={taskId?:string;runId?:string};
// One pending selection per project, consumed once on arrival. Nothing is persisted.
const pending=new Map<string,RelationSelection>();
export function queueRelationSelection(projectId:string,selection:RelationSelection){pending.delete(projectId);pending.set(projectId,selection);while(pending.size>20)pending.delete(pending.keys().next().value!);}
export function takeRelationSelection(projectId:string){const selection=pending.get(projectId);pending.delete(projectId);return selection;}

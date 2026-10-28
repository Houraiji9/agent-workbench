import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {useLiveResource} from './useLiveResource.js';import {useStore} from '../app/store.js';
import {layoutRelationships,type GraphNode,type GraphEdge} from '../../shared/workflow-view.js';
import type {projectTimelineGraph} from '../../shared/project-timeline.ts';
import {statusText} from '../lib/flow.js';import {Notice,Empty,Field} from './kit.js';
import {TimelineRelations} from './TimelineRelations.js';
import {RelationRecords,takeRelationSelection,type RelationSelection} from './RelationRecords.js';
import './project-insights.css';
type Graph={nodes:GraphNode[];edges:GraphEdge[];hidden_tasks:number;hidden_edges:number;total_tasks:number};
type Timeline=ReturnType<typeof projectTimelineGraph>;

/** Keep explicit linked context, but never traverse through another task's records. */
function taskTimeline(graph:Timeline,taskId:string,runId:string){
  if(!taskId&&!runId)return graph;
  const allowed=(n:Timeline['nodes'][number])=>(!taskId||(n.kind!=='task'||n.record_id===taskId)&&(!n.task_id||n.task_id===taskId))&&(!runId||n.kind!=='run'||n.record_id===runId);
  const byId=new Map(graph.nodes.map(n=>[n.id,n])),adjacent=new Map<string,Timeline['edges']>();
  for(const edge of graph.edges)for(const id of [edge.from,edge.to]){const list=adjacent.get(id)||[];list.push(edge);adjacent.set(id,list);}
  const seeds=graph.nodes.filter(n=>runId?n.kind==='run'&&n.record_id===runId:n.kind==='task'&&n.record_id===taskId||n.task_id===taskId).map(n=>n.id),ids=new Set(seeds),queue=[...seeds];
  for(let i=0;i<queue.length;i++)for(const edge of adjacent.get(queue[i])||[])for(const id of [edge.from,edge.to]){const node=byId.get(id);if(ids.has(id)||!node)continue;if(allowed(node)){ids.add(id);queue.push(id);}else if(node.kind==='task'&&['dependency','rework'].includes(edge.kind)){ids.add(id);}}

  return {...graph,nodes:graph.nodes.filter(n=>ids.has(n.id)),edges:graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),unresolved:graph.unresolved.filter(e=>ids.has(e.from)||ids.has(e.to))};
}

export function RelationshipGraph({projectId}:{projectId:string}){
  const s=useStore(),[selection,setSelection]=useState<RelationSelection>({}),[view,setView]=useState('timeline'),[history,setHistory]=useState(false),[scale,setScale]=useState(1),box=useRef<HTMLDivElement>(null),marker=useId().replace(/:/g,'');
  const task=selection.taskId||'',run=selection.runId||'';
  useEffect(()=>{setSelection(takeRelationSelection(projectId)||{});},[projectId]);
  const url=view==='timeline'?`/projects/${encodeURIComponent(projectId)}/insights?history=${history}`:`/projects/${encodeURIComponent(projectId)}/relations?view=${view}&history=${history}`;
  const {data,error,loading}=useLiveResource<Graph&{graph:Timeline}>(url,s.changeTick);
  const graph=view==='timeline'?null:data,timeline=view==='timeline'?data?.graph||null:null,scopeKey=url+':'+task+':'+run;

  const tasks=((s.data.tasks||[]) as {id:string;project_id:string;title:string}[]).filter(t=>t.project_id===projectId);
  const visible=useMemo(()=>{if(!graph)return null;if(!task&&!run)return graph;const ids=new Set(graph.nodes.filter(n=>(!task||n.task_id===task)&&(!run||n.id===run||n.kind==='task'&&n.id===task)).map(n=>n.id)),seeds=new Set(ids);for(const e of graph.edges){if(seeds.has(e.to)&&graph.nodes.some(n=>n.id===e.from&&n.kind==='session'))ids.add(e.from);if(['dependency','rework'].includes(e.kind)){if(seeds.has(e.from))ids.add(e.to);if(seeds.has(e.to))ids.add(e.from);}}return {...graph,nodes:graph.nodes.filter(n=>ids.has(n.id)),edges:graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to))};},[graph,task,run]);
  const filteredTimeline=useMemo(()=>timeline?taskTimeline(timeline,task,run):null,[timeline,task,run]);
  const layout=useMemo(()=>layoutRelationships(visible?.nodes||[],visible?.edges||[]),[visible]),byId=new Map(layout.nodes.map(n=>[n.id,n]));
  const fit=()=>setScale(Math.max(.15,Math.min(1,((box.current?.clientWidth||900)-24)/layout.width)));
  const hasNodes=!!visible?.nodes.length;
  useEffect(()=>{if(hasNodes){fit();box.current?.scrollTo({top:0,left:0});}},[scopeKey,hasNodes]);
  const open=(n:GraphNode)=>n.task_id?s.openTask(n.task_id):s.go({page:'records',id:n.session_id});
  return <section className="relationship-panel project-relations" aria-label="项目关系图">
    <div className="relationship-tools pi-relation-filters"><Field label="关系图类型"><select value={view} onChange={e=>setView(e.target.value)}><option value="timeline">完整流程与证据</option><option value="tasks">任务依赖</option><option value="execution">执行与返修</option><option value="sessions">会话关联</option></select></Field><Field label="定位任务"><select value={task} onChange={e=>setSelection({taskId:e.target.value||undefined})}><option value="">全部任务</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></Field><label className="pi-history"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>显示已结束任务</label>{(task||run)&&<button className="btn small" onClick={()=>setSelection({})}>清除定位</button>}</div>
    <p className="muted small">完整流程保留需求计划、调用、子代理、产物和审查来源；其余视图保留任务依赖、执行返修及会话绑定。仅展示已登记关系，位置不表示先后。任务定位仅在本次页面会话生效。</p>
    {run&&<p className="muted small">当前执行定位：{run}</p>}
    {error&&<Notice tone="error">读取关系失败：{error}</Notice>}{loading&&<p role="status">正在读取关系…</p>}
    {!loading&&view==='timeline'&&filteredTimeline&&<><p className="muted small">当前范围 {filteredTimeline.nodes.length} / {timeline!.nodes.length} 个节点 · {filteredTimeline.edges.length} 条已登记关系{timeline!.hidden_tasks?` · 隐藏 ${timeline!.hidden_tasks} 项历史任务`:''}</p><TimelineRelations scopeKey={scopeKey} graph={filteredTimeline} onTask={s.openTask} name={s.name}/></>}
    {!loading&&view!=='timeline'&&visible&&<>
      <div className="relationship-tools"><span className="graph-zoom"><button className="btn small" aria-label="缩小关系图" onClick={()=>setScale(v=>Math.max(.15,v-.15))}>−</button><button className="btn small" onClick={fit}>适应画布</button><button className="btn small" aria-label="放大关系图" onClick={()=>setScale(v=>Math.min(2,v+.15))}>＋</button><span>{Math.round(scale*100)}%</span></span><button className="btn small" onClick={()=>box.current?.scrollTo({top:box.current.scrollHeight})}>到画布末尾</button><button className="btn small" onClick={()=>box.current?.scrollTo({top:0,left:0})}>回到画布起点</button></div>
      <p className="muted small">当前范围 {visible.nodes.length} / {graph!.nodes.length} 个节点 · {visible.edges.length} 条已登记关系{graph!.hidden_tasks?` · 隐藏 ${graph!.hidden_tasks} 项历史任务`:''}{graph!.hidden_edges?` · ${graph!.hidden_edges} 条关系指向当前隐藏的节点`:''}。实线表示前置或执行，虚线表示返修与会话；点击节点查看详情。</p>
      {!visible.nodes.length?<Empty title="当前范围没有可显示的任务关系">可以清除定位或显示已结束任务。</Empty>:<div className="relationship-canvas" ref={box} tabIndex={0} aria-label="任务关系画布，可横向与纵向滚动">
        <svg role="group" aria-label="真实任务关系" width={layout.width*scale} height={layout.height*scale} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>
          {visible.edges.map((edge,i)=>{const a=byId.get(edge.from),b=byId.get(edge.to);if(!a||!b)return null;const x=a.x+240,y=a.y+36,tx=b.x,ty=b.y+36,mid=(x+tx)/2;return <g key={i} className={'graph-edge edge-'+edge.kind}><path d={`M${x},${y} C${mid},${y} ${mid},${ty} ${tx},${ty}`} markerEnd={`url(#${marker})`}/><text x={mid} y={(y+ty)/2-7} textAnchor="middle">{edge.label}</text></g>})}
          {layout.nodes.map(n=><g key={n.id} role="button" tabIndex={0} aria-label={n.label} className={'graph-node kind-'+n.kind} transform={`translate(${n.x},${n.y})`} onClick={()=>open(n)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(n)}}}><rect width="240" height="76" rx="10"/><foreignObject x="10" y="7" width="220" height="62"><div className="graph-node-content"><strong>{n.label}</strong><small>{n.kind==='task'?'任务':n.kind==='run'?'执行':n.kind==='review'?'审查':'会话'} · {statusText[n.status||'']||n.status||'已关联'}</small></div></foreignObject><title>{n.label}</title></g>)}
        </svg>
      </div>}
      {!!layout.cycle_nodes.length&&<Notice tone="warn">部分关系形成回路，已保留原关联；不将回路当作可执行顺序。</Notice>}
      {!visible.edges.length&&!!visible.nodes.length&&<p className="muted">尚未登记这些节点之间的关联，位置不表示执行先后。</p>}
      <details className="pi-details"><summary>本视图的文字关系与来源（{visible.nodes.length} 项）</summary><RelationRecords items={visible.nodes} label="关系节点" searchText={n=>JSON.stringify(n)} render={n=><article className="pi-source-record" key={n.id}><button className="link" onClick={()=>open(n)}>{n.label}</button><code>{n.id}</code><span>类型：{n.kind} · {statusText[n.status||'']||n.status||'已关联'} · {n.agent?s.name(n.agent):'未登记执行者'}</span><details><summary>已登记的关联（{visible.edges.filter(e=>e.from===n.id||e.to===n.id).length}）</summary><RelationRecords items={visible.edges.filter(e=>e.from===n.id||e.to===n.id)} label="节点关联" searchText={e=>JSON.stringify(e)} render={(e,i)=><p key={i}>{byId.get(e.from)?.label} → {e.label}：{byId.get(e.to)?.label}</p>}/></details></article>}/></details>
    </>}
  </section>;
}

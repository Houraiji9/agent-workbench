import React,{useEffect,useRef,useState} from 'react';import {api} from '../api.js';import {useStore} from '../app/store.js';import {layoutRelationships,type GraphNode,type GraphEdge} from '../../shared/workflow-view.js';import {statusText} from '../lib/flow.js';import {Notice,Empty} from './kit.js';
type Graph={nodes:GraphNode[];edges:GraphEdge[];hidden_tasks:number;hidden_edges:number;total_tasks:number};
export function RelationshipGraph({projectId}:{projectId:string}){
  const s=useStore(),[view,setView]=useState('tasks'),[history,setHistory]=useState(true),[graph,setGraph]=useState<Graph|null>(null),[error,setError]=useState(''),[scale,setScale]=useState(1),box=useRef<HTMLDivElement>(null);
  useEffect(()=>{let live=true;api(`/projects/${projectId}/relations?view=${view}&history=${history}`).then(g=>{if(live){setGraph(g);setError('')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false};},[projectId,view,history,s.changeTick]);
  const layout=layoutRelationships(graph?.nodes||[],graph?.edges||[]),byId=new Map(layout.nodes.map(n=>[n.id,n]));
  const fit=()=>setScale(Math.max(.15,Math.min(1,((box.current?.clientWidth||900)-24)/layout.width)));
  useEffect(()=>{if(graph)fit();},[graph?.nodes.length,view,history]);
  const open=(n:GraphNode)=>n.task_id?s.openTask(n.task_id):s.go({page:'records',id:n.session_id});
  return <section className="relationship-panel" aria-label="项目关系图">
    <div className="relationship-tools"><select aria-label="关系图类型" value={view} onChange={e=>setView(e.target.value)}><option value="tasks">任务依赖</option><option value="execution">执行与返修</option><option value="sessions">会话关联</option></select><label><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/>显示已结束任务</label><span className="graph-zoom"><button className="btn small" aria-label="缩小关系图" onClick={()=>setScale(v=>Math.max(.15,v-.15))}>−</button><button className="btn small" onClick={fit}>适应画布</button><button className="btn small" aria-label="放大关系图" onClick={()=>setScale(v=>Math.min(2,v+.15))}>＋</button></span></div>
    {error&&<Notice tone="error">{error}</Notice>}
    {graph&&<p className="muted small">{graph.nodes.length} 个节点 · {graph.edges.length} 条已登记关系{graph.hidden_tasks?` · 隐藏 ${graph.hidden_tasks} 项历史任务`:''}{graph.hidden_edges?` · ${graph.hidden_edges} 条关系指向当前隐藏的节点`:''}。实线表示前置或执行，虚线表示返修与会话；点击节点查看详情。</p>}
    {!graph&&!error&&<p>正在读取关系…</p>}
    {graph&&!graph.nodes.length?<Empty title="还没有可显示的任务关系"/>:<div className="relationship-canvas" ref={box}>
      <svg role="group" aria-label="真实任务关系" width={layout.width*scale} height={layout.height*scale} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <defs><marker id="relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs>
        {(graph?.edges||[]).map((edge,i)=>{const a=byId.get(edge.from),b=byId.get(edge.to);if(!a||!b)return null;const x=a.x+240,y=a.y+36,tx=b.x,ty=b.y+36,mid=(x+tx)/2;return <g key={i} className={'graph-edge edge-'+edge.kind}><path d={`M${x},${y} C${mid},${y} ${mid},${ty} ${tx},${ty}`} markerEnd="url(#relation-arrow)"/><text x={mid} y={(y+ty)/2-7} textAnchor="middle">{edge.label}</text></g>})}
        {layout.nodes.map(n=><g key={n.id} role="button" tabIndex={0} aria-label={n.label} className={'graph-node kind-'+n.kind} transform={`translate(${n.x},${n.y})`} onClick={()=>open(n)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(n)}}}><rect width="240" height="76" rx="10"/><foreignObject x="10" y="7" width="220" height="62"><div className="graph-node-content"><strong>{n.label}</strong><small>{n.kind==='task'?'任务':n.kind==='run'?'执行':n.kind==='review'?'审查':'会话'} · {statusText[n.status||'']||n.status||'已关联'}</small></div></foreignObject><title>{n.label}</title></g>)}
      </svg>
    </div>}
    {!!layout.cycle_nodes.length&&<Notice tone="warn">部分关系形成回路，已保留原关联；不将回路当作可执行顺序。</Notice>}
    {graph&&!graph.edges.length&&!!graph.nodes.length&&<p className="muted">尚未登记这些节点之间的关联，位置不表示执行先后。</p>}
  </section>;
}

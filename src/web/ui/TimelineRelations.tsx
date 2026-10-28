import React,{useEffect,useId,useRef,useState} from 'react';
import type {projectTimelineGraph,TimelineNode} from '../../shared/project-timeline.ts';
import {statusText} from '../lib/flow.js';
import {Empty,Notice} from './kit.js';
import {RelationRecords} from './RelationRecords.js';
const kinds:Record<string,string>={request:'原始需求',plan:'模型计划',task:'任务',run:'执行',job:'客户端调用',session:'会话',delegation:'报告的子代理',artifact:'归档产物',review_assignment:'审查安排',review:'审查回执',closeout:'执行者收尾',closeout_event:'收尾回执',acceptance:'用户验收'};
const phases=['需求与计划','任务与前置','执行与返修','客户端与子代理','交付产物','独立审查','收尾与验收'];
const phase:Record<string,number>={request:0,plan:0,task:1,run:2,job:3,session:3,delegation:3,artifact:4,review_assignment:5,review:5,closeout:6,closeout_event:6,acceptance:6};
export function TimelineRelations({graph,onTask,name,scopeKey}:{scopeKey:string;graph:ReturnType<typeof projectTimelineGraph>;onTask:(id:string)=>void;name:(id?:string|null)=>string}){
  const [childrenVisible,setChildrenVisible]=useState(true),[scale,setScale]=useState(1),box=useRef<HTMLDivElement>(null);
  const marker=useId().replace(/:/g,''),nodes=graph.nodes.filter(n=>childrenVisible||n.kind!=='delegation'&&!graph.edges.some(e=>e.kind==='parent_child'&&e.to===n.id));
  const ids=new Set(nodes.map(n=>n.id)),edges=graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
  const lanes=[...new Set(nodes.map(n=>n.agent||''))],positions=new Map<string,{x:number;y:number}>();
  const laneRows:{agent:string;y:number;height:number}[]=[];let height=70;
  for(const agent of lanes){const counts=new Map<number,number>();for(const n of nodes.filter(n=>(n.agent||'')===agent)){const column=phase[n.kind]??2,index=counts.get(column)||0;counts.set(column,index+1);positions.set(n.id,{x:160+column*300,y:height+38+index*118});}const laneHeight=Math.max(160,...[...counts.values()].map(v=>v*118+60));laneRows.push({agent,y:height,height:laneHeight});height+=laneHeight;}
  const width=2270,byId=new Map(nodes.map(n=>[n.id,n]));
  const open=(node:TimelineNode)=>{if(node.kind==='task')onTask(node.record_id);else if(node.task_id)onTask(node.task_id);};
  const fit=()=>setScale(Math.max(.15,Math.min(1,((box.current?.clientWidth||900)-24)/width)));
  const hasNodes=!!nodes.length;
  useEffect(()=>{fit();if(box.current){box.current.scrollTop=0;box.current.scrollLeft=0;}},[scopeKey,childrenVisible,hasNodes]);
  if(!nodes.length)return <Empty title="还没有可显示的项目流程">真实任务、执行和交付记录形成后，会在这里连成流程。</Empty>;
  return <>
    <div className="pi-flow-tools"><label><input type="checkbox" checked={childrenVisible} onChange={e=>setChildrenVisible(e.target.checked)}/>展开子代理与分支</label><span className="graph-zoom"><button className="btn small" aria-label="缩小完整流程" onClick={()=>setScale(v=>Math.max(.15,v-.15))}>−</button><button className="btn small" onClick={fit}>适应画布</button><button className="btn small" aria-label="放大完整流程" onClick={()=>setScale(v=>Math.min(2,v+.15))}>＋</button><span>{Math.round(scale*100)}%</span></span><button className="btn small" onClick={()=>box.current?.scrollTo({top:box.current.scrollHeight})}>到画布末尾</button><button className="btn small" onClick={()=>box.current?.scrollTo({top:0,left:0})}>回到画布起点</button></div>
    <p className="muted small">从左向右查看阶段，每条横带代表记录中的 Agent。箭头说明已登记关系；同一列的位置不代表先后，未登记依赖也不等于已确认并行。</p>
    <div className="pi-flow-viewport" ref={box} tabIndex={0} aria-label="项目流程画布，可横向滚动；下方另有文字流程">
      <svg width={width*scale} height={(height+16)*scale} viewBox={`0 0 ${width} ${height+16}`} role="group" aria-label="项目阶段与 Agent 泳道">
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
    <details className="pi-details"><summary>文字流程与来源记录（{nodes.length} 项）</summary><RelationRecords items={nodes} label="流程来源" searchText={n=>JSON.stringify(n)+' '+(n.agent?name(n.agent):'')} render={n=><article className="pi-source-record" key={n.id}><strong>{kinds[n.kind]||n.kind}：{n.label}</strong>{(n.kind==='task'||n.task_id)&&<button className="btn small" onClick={()=>open(n)}>查看任务</button>}<span>{n.agent?name(n.agent):'未登记执行者'} · {statusText[n.status||'']||n.status||'已关联'}</span><code>{n.record_id}</code><span>模型来源：{n.source==='planner_reported'?'规划者自述（'+(n.planning_channel||'未知连接')+'）':n.source==='executor_reported'?'执行者报告':n.source==='unknown'?'未知':'登记的客户端 / 执行回执'}；实际报告：{n.actual_model||(n.reported_model?n.reported_model+'（自述，未核验）':'未知')}；计划：{n.requested_model||'未指定'}。未提供独立核验时，不视为身份验证。</span>{n.sha256&&<code>产物 SHA256：{n.sha256}</code>}{n.artifact_paths?.map(path=><span key={path}>报告的产物路径（未核验）：{path}</span>)}<details><summary>已登记的关联（{edges.filter(e=>e.from===n.id||e.to===n.id).length}）</summary><RelationRecords items={edges.filter(e=>e.from===n.id||e.to===n.id)} label="节点关联" searchText={e=>JSON.stringify(e)} render={(e,i)=><p key={i}>{byId.get(e.from)?.label} → {e.label}：{byId.get(e.to)?.label}</p>}/></details></article>}/></details>
    {!!graph.unresolved.length&&<details className="pi-details"><summary>未解析关系（{graph.unresolved.length} 项）</summary><RelationRecords items={graph.unresolved} label="未解析关系" searchText={e=>JSON.stringify(e)} render={(e,i)=><p key={i}>{e.label}：{e.from} → {e.to}（目标尚未解析）</p>}/></details>}
  </>;
}


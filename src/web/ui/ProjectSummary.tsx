import React,{useState,useRef,useLayoutEffect} from 'react';
/** 项目说明：默认三行，可展开原文；没写目标时只占一行，并给出补充入口。 */
export function ProjectSummary({text,onAdd,children}:{text:string;onAdd?:()=>void;children?:React.ReactNode}){
  const [expanded,setExpanded]=useState(false),[overflow,setOverflow]=useState(false),ref=useRef<HTMLParagraphElement>(null);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return;const measure=()=>{if(!expanded)setOverflow(el.scrollHeight>el.clientHeight+1)};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();},[text,expanded]);
  return <section className={'project-summary'+(text?'':' is-empty')} aria-label="项目说明">
    <div className="project-goal-line"><p ref={ref} className={'project-goal'+(expanded?'':' is-preview')}>{text||'还没写项目目标'}</p>{!text&&onAdd&&<button className="link" onClick={onAdd}>补充目标</button>}</div>
    {(overflow||expanded)&&<button className="link" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起说明':'展开完整说明'}</button>}
    {children}
  </section>;
}

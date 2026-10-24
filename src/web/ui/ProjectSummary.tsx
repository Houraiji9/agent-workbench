import React,{useState,useRef,useLayoutEffect} from 'react';
export function ProjectSummary({text}:{text:string}){
  const [expanded,setExpanded]=useState(false),[overflow,setOverflow]=useState(false),ref=useRef<HTMLParagraphElement>(null);
  useLayoutEffect(()=>{const el=ref.current;if(!el)return;const measure=()=>{if(!expanded)setOverflow(el.scrollHeight>el.clientHeight+1)};measure();const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();},[text,expanded]);
  return <section className="project-summary" aria-label="项目说明"><p ref={ref} className={'project-goal'+(expanded?'':' is-preview')}>{text||'还没写项目目标'}</p>{(overflow||expanded)&&<button className="link" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起说明':'展开完整说明'}</button>}</section>;
}

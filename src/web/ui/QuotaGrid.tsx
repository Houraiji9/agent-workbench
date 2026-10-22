import React,{useLayoutEffect,useRef,useState} from 'react';
/** Sort by content size, while CSS Grid keeps every row aligned. */
export function QuotaGrid({children}:{children:React.ReactElement[]}){
 const root=useRef<HTMLDivElement>(null),[sizes,setSizes]=useState<Record<string,number>>({}),signature=children.map(c=>String(c.key)).join('|');
 useLayoutEffect(()=>{
   const node=root.current!;let frame=0;
   const measure=()=>{const next:Record<string,number>={};for(const cell of node.querySelectorAll<HTMLElement>(':scope > .quota-cell')){
     const card=cell.firstElementChild as HTMLElement,style=getComputedStyle(card),parts=[...card.children];
     // Ignore stretched row space when measuring the content size.
     // 还没有数据的卡片排在有数据的卡片后面
     if(card.classList.contains('is-empty')){next[cell.dataset.card!]=0;continue}
     next[cell.dataset.card!]=Math.round(parts.reduce((n,p)=>n+p.getBoundingClientRect().height,0)+(parseFloat(style.rowGap)||0)*Math.max(0,parts.length-1)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom));
   }setSizes(old=>Object.keys(next).length===Object.keys(old).length&&Object.keys(next).every(k=>old[k]===next[k])?old:next)};
   const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)});observer.observe(node);node.querySelectorAll('.quota-cell > .pool > *').forEach(el=>observer.observe(el));measure();
   return()=>{observer.disconnect();cancelAnimationFrame(frame)};
 },[signature,children]);
 const sorted=children.map((child,index)=>({child,index,key:String(child.key)})).sort((a,b)=>(sizes[b.key]||0)-(sizes[a.key]||0)||a.index-b.index);
 return <div className="quota-grid quota-rows" ref={root}>{sorted.map(({child,key})=><div className="quota-cell" data-card={key} key={key}>{child}</div>)}</div>;
}

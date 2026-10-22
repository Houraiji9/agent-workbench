import React,{useState,useRef,useEffect,useLayoutEffect,useId} from 'react';import {ChevronDown,Search} from 'lucide-react';import type {R} from '../lib/flow.js';
export function ProjectPicker({projects,value,onChange}:{projects:R[];value:string;onChange(id:string):void}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[limit,setLimit]=useState(30);const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),listId=useId();
 const close=(focus=false)=>{setOpen(false);if(focus)trigger.current?.focus()};
 useLayoutEffect(()=>{
   if(!open||!panel.current||!trigger.current)return;
   const node=panel.current,button=trigger.current;
   // The top layer escapes the scrolling dialog without moving its form.
   const position=()=>{const r=button.getBoundingClientRect(),gap=6,margin=8,below=innerHeight-r.bottom-gap-margin,above=r.top-gap-margin,down=below>=220||below>=above;
     const height=Math.max(80,Math.min(330,down?below:above)),width=Math.min(r.width,innerWidth-2*margin);
     Object.assign(node.style,{width:width+'px',maxHeight:height+'px',left:Math.max(margin,Math.min(r.left,innerWidth-width-margin))+'px',top:(down?Math.max(margin,r.bottom+gap):Math.max(margin,r.top-gap-height))+'px'});
   };
   position();node.showPopover();node.querySelector('input')?.focus({preventScroll:true});
   const resize=new ResizeObserver(position);resize.observe(button);window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
   return()=>{resize.disconnect();window.removeEventListener('resize',position);window.removeEventListener('scroll',position,true);if(node.matches(':popover-open'))node.hidePopover()};
 },[open]);
 useEffect(()=>{const close=(e:MouseEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false)};document.addEventListener('click',close);return()=>document.removeEventListener('click',close)},[]);
 const selected=projects.find(p=>p.id===value),items=projects.filter(p=>(p.name+' '+(p.paths||[]).join(' ')).toLowerCase().includes(query.trim().toLowerCase()));
 return <div className="project-picker" ref={root} onKeyDownCapture={e=>{if(e.key==='Escape'&&open){e.stopPropagation();e.preventDefault();close(true)}}}>
   <span className="field-label">属于哪个项目</span>
   <button ref={trigger} type="button" className="project-select" role="combobox" aria-label="属于哪个项目" aria-expanded={open} aria-controls={listId} onClick={()=>{setOpen(!open);setQuery('');setLimit(30)}}><span>{selected?.name||'选择项目'}</span><ChevronDown size={16}/></button>
   {open&&<div ref={panel} popover="manual" className="project-options"><label className="library-search"><Search size={16}/><input aria-label="搜索项目" placeholder="输入项目名称或文件夹" value={query} onChange={e=>{setQuery(e.target.value);setLimit(30)}}/></label><div id={listId} role="listbox" aria-label="项目选项">
     {items.slice(0,limit).map(p=><button type="button" role="option" aria-selected={p.id===value} key={p.id} onClick={()=>{onChange(p.id);close(true)}}><strong>{p.name}</strong><small>{p.paths?.[0]}</small></button>)}
     {!items.length&&<p className="muted small">没有找到这个项目</p>}
   </div>{items.length>limit&&<button type="button" className="link" onClick={()=>setLimit(limit+30)}>显示更多（共 {items.length} 个）</button>}</div>}
 </div>
}

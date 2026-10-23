import React,{useLayoutEffect,useRef,useState} from 'react';
import {Copy} from 'lucide-react';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {Dialog} from './kit.js';

export function RequestPreview({request,className='request-text'}:{request:R;className?:string}){
  const s=useStore(),ref=useRef<HTMLParagraphElement>(null),[overflow,setOverflow]=useState(false);
  useLayoutEffect(()=>{
    const node=ref.current!;
    const measure=()=>setOverflow(node.scrollHeight>node.clientHeight+1);
    const observer=new ResizeObserver(measure);observer.observe(node);measure();
    return()=>observer.disconnect();
  },[request.text]);
  return <div className="request-preview"><p ref={ref} className={className+' request-preview-text'}>{request.text}</p>
    {overflow&&<button className="link request-read-more" onClick={()=>s.openDialog('request-content',{request})}>查看全文</button>}
  </div>;
}

export function RequestContentDialog({request,onClose}:{request:R;onClose():void}){
  const s=useStore();
  return <Dialog title="需求全文" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>关闭</button><button className="btn" onClick={()=>void s.copy(request.text,'完整需求已复制')}><Copy size={15}/>复制全文</button></>}>
    <div className="request-full-text">{request.text}</div>
  </Dialog>;
}

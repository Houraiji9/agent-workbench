import React,{useEffect,useRef} from 'react';
import {Ellipsis} from 'lucide-react';

/**
 * 次要操作菜单：点击菜单外、按 Esc 或选择动作后收起；键盘可用 Enter/空格展开。
 * 收起时焦点回到可见的“更多”按钮：动作若打开对话框，对话框会记下这个按钮，取消后也回到这里。
 */
export function MoreMenu({label='更多',children}:{label?:string;children:React.ReactNode}){
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(e:Event)=>{const node=ref.current;if(node?.open&&!(e.target instanceof Node&&node.contains(e.target)))node.open=false};
    document.addEventListener('mousedown',close);
    return()=>document.removeEventListener('mousedown',close);
  },[]);
  const collapse=()=>{const node=ref.current;if(!node)return;node.open=false;node.querySelector('summary')?.focus({preventScroll:true});};
  return <details className="more-menu" ref={ref} onKeyDown={e=>{if(e.key==='Escape'&&ref.current?.open){e.stopPropagation();collapse()}}}>
    <summary className="btn"><Ellipsis size={16} aria-hidden="true"/>{label}</summary>
    <div className="more-menu-list" onClick={e=>{if((e.target as HTMLElement).closest('button,a'))collapse()}}>{children}</div>
  </details>;
}

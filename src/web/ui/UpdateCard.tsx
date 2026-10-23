import React, {useEffect, useState} from 'react';
import {Download, FolderOpen, RefreshCw, RotateCw} from 'lucide-react';
import {Section, Dialog} from './kit.js';

interface UpdateState {
  status: 'idle'|'checking'|'available'|'current'|'downloading'|'preparing'|'downloaded'|'installing'|'error';
  currentVersion:string;canInstall:boolean;latestVersion:string|null;progress:number;message:string;releaseUrl:string;notes:string;
}
interface Updates {status():Promise<UpdateState>;check():Promise<UpdateState>;download():Promise<UpdateState>;install():Promise<UpdateState>;openDownload():Promise<UpdateState>}
declare global {interface Window {workbenchUpdates?:Updates}}

export function UpdateCard() {
  const bridge=window.workbenchUpdates;
  const [state,setState]=useState<UpdateState|null>(null),[pending,setPending]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!bridge)return;let active=true;
    const poll=()=>void bridge.status().then(s=>{if(active)setState(s)}).catch(()=>{if(active)setError('更新入口暂时不可用，请重新打开工作台')});
    poll();const timer=setInterval(poll,700);return()=>{active=false;clearInterval(timer)};
  },[bridge]);
  const action=async(kind:Exclude<keyof Updates,'status'>)=>{
    if(!bridge||pending)return;setPending(true);setError('');
    try{setState(await bridge[kind]());}catch{setError('更新未完成，请稍后重试');}finally{setPending(false);}
  };
  const busy=pending||!!state&&['checking','downloading','preparing','installing'].includes(state.status);
  return <Section title="软件更新" label="软件更新" aside={state&&<span className="pill t-quiet">v{state.currentVersion}</span>}>
    {!bridge?<p>请在桌面工作台中检查更新。</p>:<>
      <p className={state?.status==='error'||error?'update-error':undefined} role="status">{error||state?.message||'检查是否有新版本可用。'}</p>
      {state&&!state.canInstall&&<p className="muted small">开发版可下载便携包；当前工程由开发流程更新。</p>}
      {state&&['downloading','preparing'].includes(state.status)&&<div className="update-progress"><progress value={state.progress} max={100} aria-label="更新下载进度"/><span>{state.progress}%</span></div>}
      <div className="tool-row">
        <button className="btn small" disabled={busy||!state} onClick={()=>void action('check')}><RefreshCw size={15}/>检查更新</button>
        {state?.status==='available'&&<button className="btn primary small" disabled={busy} onClick={()=>void action('download')}><Download size={15}/>下载新版</button>}
        {state?.status==='downloaded'&&<button className="btn primary small" disabled={busy} onClick={()=>state.canInstall?setConfirm(true):void action('openDownload')}>{state.canInstall?<><RotateCw size={15}/>重启并更新</>:<><FolderOpen size={15}/>打开下载文件夹</>}</button>}
      </div>
      {state?.latestVersion&&<details className="fold update-notes"><summary>v{state.latestVersion} 更新内容</summary><p>{state.notes||'本次更新内容见发布页面。'}</p><a className="link" href={state.releaseUrl} target="_blank" rel="noreferrer">查看发布页面</a></details>}
    </>}
    {confirm&&<Dialog title="安装新版工作台" onClose={()=>setConfirm(false)} footer={<><button className="btn" onClick={()=>setConfirm(false)}>稍后</button><button className="btn primary" onClick={()=>{setConfirm(false);void action('install')}}>现在重启更新</button></>}>
      <p>工作台将暂时退出，安装完成后重新打开。</p><p>项目、任务、执行包和本地设置会保留。请先保存正在填写的内容。</p>
    </Dialog>}
  </Section>;
}

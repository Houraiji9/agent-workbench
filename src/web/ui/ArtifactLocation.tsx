import React,{useRef,useState} from 'react';
import {Copy,FolderOpen} from 'lucide-react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {CopyBox,Notice} from './kit.js';

export function ArtifactLocation({artifact:a,compact=false}:{artifact:R;compact?:boolean}){
  const s=useStore(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[fallback,setFallback]=useState('');
  const opening=useRef(false);
  const [archiveOffered,setArchiveOffered]=useState(false);
  const original=typeof a.original_path==='string'&&!!a.original_path;
  const file=String((original?a.original_path:a.archive_path)||'');
  const folder=file.slice(0,Math.max(file.lastIndexOf('\\'),file.lastIndexOf('/')));
  const open=async(target:'original'|'archive')=>{
    if(opening.current)return;
    opening.current=true;
    setBusy(true);setError('');
    try{await api('/artifacts/'+a.id+'/open-folder',{target});s.toast('已在文件夹中定位文件')}
    catch(e){setError((e as Error).message);if(target==='original')setArchiveOffered(true)}finally{opening.current=false;setBusy(false)}
  };
  return <div className={'artifact-location'+(compact?' compact':'')}>
    <div className="artifact-folder"><span>{original?'文件夹':'归档文件夹'}</span><code title={folder}><span dir="ltr">{folder||'未记录位置'}</span></code></div>
    <div className="inline artifact-location-actions">
      <button className="btn small ghost" disabled={!file} aria-disabled={busy} onClick={()=>void open(original?'original':'archive')}><FolderOpen size={14}/>打开文件夹</button>
      <button className="btn small ghost" disabled={!folder} onClick={async()=>{setFallback(await s.copy(folder,'文件夹路径已复制')?'':folder)}}><Copy size={14}/>复制路径</button>
      {original&&(!compact||archiveOffered)&&<button className="btn small ghost" aria-disabled={busy} onClick={()=>void open('archive')}>打开归档文件夹</button>}
    </div>
    {error&&<Notice tone="error">{error}</Notice>}
    {fallback&&<CopyBox text={fallback} label="手动复制文件夹路径"/>}
  </div>;
}

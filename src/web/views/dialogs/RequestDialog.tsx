import React,{useState} from 'react';import {Copy,ArrowRight} from 'lucide-react';import {useStore} from '../../app/store.js';import {api} from '../../api.js';import type {R} from '../../lib/flow.js';import {Dialog,Field,Notice,CopyBox} from '../../ui/kit.js';import {ProjectPicker} from '../../ui/ProjectPicker.js';import {useSubmit} from './useSubmit.js';
export function RequestDialog({projectId,request:q,onClose}:{projectId?:string;request?:R;onClose():void}){
 const s=useStore(),projects=(s.data.projects as R[]).filter(p=>!p.archived).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
 const [project,setProject]=useState(q?.project_id||projectId||(s.route.page==='projects'?projects.find(p=>p.id===s.route.id)?.id:null)||projects[0]?.id||'');
 const [text,setText]=useState(q?.text||''),[skip,setSkip]=useState(q?.review_policy?.mode==='not_requested'),[note,setNote]=useState(q?.review_policy?.note||''),[replan,setReplan]=useState(false),[saved,setSaved]=useState<R|null>(null);
 const {error,saving,run}=useSubmit();const planned=q?.status==='planned';
 const waiting=q?.status==='awaiting_planning';
 const save=(status:'draft'|'awaiting_planning')=>void run(async()=>{const result=await api(q?'/requests/'+q.id+'/edit':'/requests',{project_id:project,text,status,kind:q?.kind||'idea',skip_review:skip,review_note:note,...(q?{version:q.version,replan}:{})});s.go({page:'requests',tab:status==='draft'?'drafts':'waiting'});if(status==='awaiting_planning'&&!waiting)setSaved(result);return result},status==='draft'?'已记在待开始':waiting?'需求已更新':undefined,status==='draft'||waiting);
 if(saved)return <RequestHandoffDialog request={saved} onClose={onClose}/>;
 return <Dialog title={q?'编辑需求':'提一个需求'} sub="写下要做的事，现在开始或留待以后。" onClose={onClose} label={q?'编辑需求':'提需求'}><form className="form" onSubmit={e=>{e.preventDefault();save('awaiting_planning')}}>
   <ProjectPicker projects={projects} value={project} onChange={setProject}/>
   {!projects.length&&<Notice>先在项目页添加或恢复一个项目。</Notice>}
   <Field label="你想完成什么？"><textarea data-autofocus required rows={7} maxLength={20000} placeholder="需求、未来打算或随手记下的想法都可以。" value={text} onChange={e=>setText(e.target.value)}/></Field>
   {planned&&<label className="check"><input type="checkbox" checked={replan} onChange={e=>setReplan(e.target.checked)}/>撤回尚未派发的原计划，按本次修改保存</label>}
   <details className="fold"><summary>特殊安排（一般不用改）</summary><label className="check"><input type="checkbox" checked={skip} onChange={e=>setSkip(e.target.checked)}/>这次不安排其他 Agent 审查，交付后我自己试用确认</label>{skip&&<Field label="说明一下原因"><input maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} placeholder="例如：小改动，我自己看效果就行"/></Field>}</details>
   {error&&<Notice tone="error">{error}</Notice>}
   <footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button type="button" onClick={()=>save('draft')} className="btn" disabled={saving||!text.trim()||!project||planned&&!replan}>{waiting?'暂时不做':q?'保存，稍后再做':'先记下来'}</button><button type="submit" className="btn primary" disabled={saving||!text.trim()||!project||planned&&!replan}>{saving?'正在保存…':waiting?'保存修改':'现在开始'}{!waiting&&<ArrowRight size={15}/>}</button></footer>
 </form></Dialog>
}

export function RequestActionDialog({request:q,action,onClose}:{request:R;action:'recall'|'delete';onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit();
 const title=action==='recall'?'暂时不做':'删除需求';
 const submit=()=>void run(async()=>{
   if(action==='delete')return api('/requests/'+q.id+'/delete',{version:q.version});
   const result=await api('/requests/'+q.id+'/edit',{project_id:q.project_id,text:q.text,status:'draft',kind:q.kind||'idea',version:q.version,skip_review:q.review_policy?.mode==='not_requested',review_note:q.review_policy?.note||''});
   s.go({page:'requests',tab:'drafts'});return result;
 },action==='delete'?'需求已删除':'已移回待开始');
 return <Dialog title={title} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>取消</button><button className={'btn '+(action==='delete'?'danger':'primary')} disabled={saving} onClick={submit}>{saving?'正在保存…':action==='delete'?'确认删除':title}</button></>}>
   <p className="request-text">{q.text}</p><p className="muted">{action==='recall'?'移回“待开始”，以后想做时再开始。':q.status==='planned'?'删除这项需求，并撤回尚未派发的计划。已有记录保留在项目历史中。':'从需求箱和待规划列表中移除这项需求。'}</p>{error&&<Notice tone="error">{error}</Notice>}
 </Dialog>;
}

export function RequestHandoffDialog({request:q,fallbackText='',onClose}:{request:R;fallbackText?:string;onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit(),[fallback,setFallback]=useState(fallbackText),[copied,setCopied]=useState(false);
 const copy=()=>void run(async()=>{const r=await api('/requests/'+q.id+'/entry');const ok=await s.copy(r.text,'已复制，粘贴给 Codex 即可');setCopied(ok);setFallback(ok?'':r.text);return r},undefined,false);
 return <Dialog title="下一步：发给 Codex" onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}><p className="lead">让 Codex 读取项目资料，拆分任务并选好执行者。</p><p className="request-text">{q.text}</p><button className="btn primary" disabled={saving} onClick={copy}><Copy size={16}/>{saving?'正在准备…':copied?'再次复制':'复制给 Codex'}</button>{copied&&<p className="muted small">已复制。切换到 Codex 会话，粘贴后发送。</p>}{fallback&&<CopyBox text={fallback} label="手动复制给 Codex"/>}{error&&<Notice tone="error">{error}</Notice>}</Dialog>;
}

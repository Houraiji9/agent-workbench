import React,{useRef,useState} from 'react';import {Copy,ArrowRight} from 'lucide-react';import {useStore} from '../../app/store.js';import {api} from '../../api.js';import type {R} from '../../lib/flow.js';import {Dialog,Field,Notice,CopyBox} from '../../ui/kit.js';import {ProjectPicker} from '../../ui/ProjectPicker.js';import {useSubmit} from './useSubmit.js';import {ChatPlanningDialog} from '../../ui/ChatPlanningDialog.js';import {DeliveryProfileFields,ImportanceField,deliverySummary} from '../../ui/DeliveryProfileFields.js';import type {DeliveryProfile} from '../../../core/delivery-profile.ts';import {deliveryForView} from '../../../shared/delivery-view.js';
export function RequestDialog({projectId,request:q,onClose}:{projectId?:string;request?:R;onClose():void}){
 const s=useStore(),projects=(s.data.projects as R[]).filter(p=>!p.archived).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
 const [project,setProject]=useState(q?.project_id||projectId||(s.route.page==='projects'?projects.find(p=>p.id===s.route.id)?.id:null)||projects[0]?.id||'');
 const selectedProject=projects.find((p:R)=>p.id===project)||{} as R;
 const initialImportance=(q?.importance||selectedProject.importance||'normal') as 'normal'|'critical';
 const [importance,setImportance]=useState<'normal'|'critical'>(initialImportance);
 const [profile,setProfile]=useState<DeliveryProfile>(()=>deliveryForView(q||{},selectedProject));
 const [text,setText]=useState(q?.text||''),[workflowKind,setWorkflowKind]=useState(q?.workflow_kind||'standard'),[desiredOutput,setDesiredOutput]=useState(q?.desired_output||''),[successCriteria,setSuccessCriteria]=useState(q?.success_criteria||''),[reviewMode,setReviewMode]=useState(initialImportance==='critical'?'required':q?.review_policy?.mode||'required'),[reviewFocus,setReviewFocus]=useState<string>(((q?.review_policy?.focus||[]) as string[]).join('\n')),[note,setNote]=useState(q?.review_policy?.note||''),[replan,setReplan]=useState(false),[saved,setSaved]=useState<R|null>(null);
 const [planningOpen,setPlanningOpen]=useState(Boolean(q?.workflow_kind==='small'||q?.review_policy&&q.review_policy.mode!=='required'));
 const [extrasOpen,setExtrasOpen]=useState(Boolean(q?.desired_output||q?.success_criteria));
 const [reviewError,setReviewError]=useState('');
 const projectDrafts=useRef(new Map<string,{profile:DeliveryProfile;importance:'normal'|'critical';reviewMode:string;reviewFocus:string;note:string}>());
 const changeProject=(id:string)=>{
   projectDrafts.current.set(project,{profile,importance,reviewMode,reviewFocus,note});
   const next=projects.find((p:R)=>p.id===id)||{} as R,draft=projectDrafts.current.get(id);
   setProject(id);setProfile(draft?.profile||deliveryForView({},next));setImportance(draft?.importance||(next.importance||'normal') as 'normal'|'critical');
   setReviewMode(draft?.reviewMode||'required');setReviewFocus(draft?.reviewFocus||'');setNote(draft?.note||'');setReviewError('');
 };
 const {error,saving,run}=useSubmit();const planned=q?.status==='planned';
 const waiting=q?.status==='awaiting_planning';
 const focusItems=reviewFocus.split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean);
 const invalidFocus=!focusItems.length||focusItems.length>12||focusItems.some(x=>x.length<2||x.length>500);
 const save=(status:'draft'|'awaiting_planning')=>{
   const validation=importance==='normal'&&reviewMode==='light'&&invalidFocus?'请填写 1–12 项审查范围，每项 2–500 字。':importance==='normal'&&reviewMode==='not_requested'&&status==='awaiting_planning'&&note.trim().length<5?'请用至少 5 个字说明不安排审查的原因。':'';
   if(validation){setPlanningOpen(true);setReviewError(validation);return;}
   setReviewError('');void run(async()=>{const result=await api(q?'/requests/'+q.id+'/edit':'/requests',{project_id:project,importance,delivery_profile:profile,text,status,kind:q?.kind||'idea',workflow_kind:workflowKind,desired_output:desiredOutput,success_criteria:successCriteria,review_mode:importance==='critical'?'required':reviewMode,review_focus:importance==='normal'&&reviewMode==='light'?focusItems:[],skip_review:importance==='critical'?false:reviewMode==='not_requested',review_note:note,...(q?{version:q.version,replan}:{})});s.go({page:'requests',tab:status==='draft'?'drafts':'waiting'});if(status==='awaiting_planning'&&!waiting)setSaved(result);return result},status==='draft'?'已记在待开始':waiting?'需求已更新':undefined,status==='draft'||waiting);
 };
 if(saved)return saved.workflow_kind==='small'?<ChatPlanningDialog requestId={saved.id} onClose={onClose}/>:<RequestHandoffDialog request={saved} onClose={onClose}/>;
 return <Dialog title={q?'编辑需求':'提一个需求'} sub="写下要做的事，现在开始或留待以后。" onClose={onClose} label={q?'编辑需求':'提需求'}><form className="form delivery-form" onInvalidCapture={e=>{
   let ancestor=(e.target as HTMLElement).parentElement;
   while(ancestor&&ancestor!==e.currentTarget){if(ancestor instanceof HTMLDetailsElement)ancestor.open=true;ancestor=ancestor.parentElement;}
 }} onSubmit={e=>{e.preventDefault();save('awaiting_planning')}}>
   <ProjectPicker projects={projects} value={project} onChange={changeProject}/>
   {!projects.length&&<Notice>先在项目页添加或恢复一个项目。</Notice>}
   <Field label="你想完成什么？"><textarea data-autofocus required rows={4} maxLength={20000} placeholder="需求、未来打算或随手记下的想法都可以。" value={text} onChange={e=>setText(e.target.value)}/></Field>
   <ImportanceField value={importance} onChange={value=>{setImportance(value);setReviewError('')}}/>
   <div className="delivery-brief"><p title={deliverySummary(profile)}>{JSON.stringify(profile)===JSON.stringify(deliveryForView({},selectedProject))?'项目交付':'本需求交付'}：{deliverySummary(profile)}</p></div>
   <details key={project} className="fold"><summary>修改交付</summary><DeliveryProfileFields key={project} value={profile} onChange={setProfile}/></details>
   <details className="fold" open={extrasOpen} onToggle={e=>setExtrasOpen(e.currentTarget.open)}><summary>补充要求（可选）</summary>
     <Field label="期望结果"><textarea rows={2} maxLength={2000} value={desiredOutput} onChange={e=>setDesiredOutput(e.target.value)} placeholder="还有哪些描述中没写到的要求？"/></Field>
     <Field label="完成标准"><textarea rows={2} maxLength={2000} value={successCriteria} onChange={e=>setSuccessCriteria(e.target.value)} placeholder="你会怎样判断结果符合预期？"/></Field>
   </details>
   {planned&&<label className="check"><input type="checkbox" checked={replan} onChange={e=>setReplan(e.target.checked)}/>撤回尚未派发的原计划，按本次修改保存</label>}
   <details className="fold" open={planningOpen} onToggle={e=>setPlanningOpen(e.currentTarget.open)}><summary>规划与审查{workflowKind==='small'?' · GPT 聊天规划':''}{importance==='normal'&&reviewMode!=='required'?' · 已自定义审查':''}</summary>
     <Field label="规划方式"><select value={workflowKind} onChange={e=>setWorkflowKind(e.target.value)}><option value="standard">交给 Codex 规划</option><option value="small">使用 GPT 聊天规划</option></select></Field>
     {importance==='critical'?<p className="muted small">完整独立审查；资源不足时停止并重新规划。</p>:<>
       <Field label="交付后的审查"><select value={reviewMode} onChange={e=>{setReviewMode(e.target.value);setReviewError('')}}><option value="required">完整独立审查</option><option value="light">有限审查</option><option value="not_requested">不安排审查</option></select></Field>
       {reviewMode==='light'&&<Field label="有限审查范围（每行一项）" hint="1–12 项，每项 2–500 字。"><textarea rows={3} maxLength={6011} value={reviewFocus} onChange={e=>{setReviewFocus(e.target.value);setReviewError('')}} placeholder="写明要检查的具体方面"/></Field>}
       {reviewMode==='not_requested'&&<Field label="不安排审查的原因" hint="现在开始前至少写 5 个字；可以先保存草稿。"><input maxLength={2000} value={note} onChange={e=>{setNote(e.target.value);setReviewError('')}}/></Field>}
     </>}
     {reviewError&&<Notice tone="error">{reviewError}</Notice>}
   </details>
   {error&&<Notice tone="error">{error}</Notice>}
   <footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button type="button" onClick={()=>save('draft')} className="btn" disabled={saving||!text.trim()||!project||planned&&!replan}>{waiting?'暂时不做':q?'保存，稍后再做':'先记下来'}</button><button type="submit" className="btn primary" disabled={saving||!text.trim()||!project||planned&&!replan}>{saving?'正在保存…':waiting?'保存修改':'现在开始'}{!waiting&&<ArrowRight size={15}/>}</button></footer>
 </form></Dialog>
}

export function RequestActionDialog({request:q,action,onClose}:{request:R;action:'recall'|'delete';onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit();
 const title=action==='recall'?'暂时不做':'删除需求';
 const submit=()=>void run(async()=>{
   if(action==='delete')return api('/requests/'+q.id+'/delete',{version:q.version});
   const result=await api('/requests/'+q.id+'/edit',{project_id:q.project_id,text:q.text,status:'draft',kind:q.kind||'idea',version:q.version,workflow_kind:q.workflow_kind||'standard',importance:q.importance||'normal',delivery_profile:q.delivery_profile,desired_output:q.desired_output||'',success_criteria:q.success_criteria||'',review_mode:q.importance==='critical'?'required':q.review_policy?.mode||'required',review_focus:q.importance==='critical'?[]:q.review_policy?.focus||[],skip_review:q.importance==='critical'?false:q.review_policy?.mode==='not_requested',review_note:q.review_policy?.note||''});
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

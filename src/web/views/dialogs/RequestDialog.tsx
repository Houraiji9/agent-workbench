import React,{useId,useRef,useState} from 'react';import {Copy,ArrowRight} from 'lucide-react';import {useStore} from '../../app/store.js';import {api} from '../../api.js';import type {R} from '../../lib/flow.js';import {Dialog,Field,Notice,CopyBox} from '../../ui/kit.js';import {ProjectPicker} from '../../ui/ProjectPicker.js';import {useSubmit} from './useSubmit.js';import {ChatPlanningDialog} from '../../ui/ChatPlanningDialog.js';import {DeliveryProfileFields,ImportanceField,deliverySummary} from '../../ui/DeliveryProfileFields.js';import type {DeliveryProfile} from '../../../core/delivery-profile.ts';import {deliveryForView} from '../../../shared/delivery-view.js';
import {requestProjects,defaultRequestProject} from '../../../shared/request-projects.js';
import {AgentSelectionFields,cleanAgentSelection,type RequestAgentSelection} from '../../ui/AgentSelectionFields.js';
import '../../ui/request-form.css';
type DeliveryChoice='project'|'planner'|'custom';
const defaultDeliveryChoice=(q:R|undefined,p:R):DeliveryChoice=>q?.planning_preferences?.delivery||(q?.delivery_profile_source==='user_selected'||q?.delivery_target_source==='user_selected'?'custom':q||p.delivery_profile||p.delivery_target==='runtime'?'project':'planner');
export function RequestDialog({projectId,request:q,onClose}:{projectId?:string;request?:R;onClose():void}){
 const s=useStore(),formId=useId(),projects=requestProjects(s.data.projects,s.data.requests,s.recentProjects);
 const [project,setProject]=useState(q?.project_id||defaultRequestProject(projects,projectId,s.route,s.data.tasks));
 const selectedProject=projects.find((p:R)=>p.id===project)||{} as R;
 const initialImportance=(q?.importance||selectedProject.importance||'normal') as 'normal'|'critical';
 const [importance,setImportance]=useState<'normal'|'critical'>(initialImportance);
 const [importanceChanged,setImportanceChanged]=useState(false);
 const [profile,setProfile]=useState<DeliveryProfile>(()=>deliveryForView(q||{},selectedProject));
 const [deliveryChoice,setDeliveryChoice]=useState<DeliveryChoice>(()=>defaultDeliveryChoice(q,selectedProject));
 const [text,setText]=useState(q?.text||''),[workflowKind,setWorkflowKind]=useState(q?.workflow_kind||'standard'),[desiredOutput,setDesiredOutput]=useState(q?.desired_output||''),[successCriteria,setSuccessCriteria]=useState(q?.success_criteria||''),[reviewMode,setReviewMode]=useState(initialImportance==='critical'?'required':q?.review_policy?.mode||'required'),[reviewFocus,setReviewFocus]=useState<string>(((q?.review_policy?.focus||[]) as string[]).join('\n')),[note,setNote]=useState(q?.review_policy?.note||''),[replan,setReplan]=useState(false),[saved,setSaved]=useState<R|null>(null);
 const [reviewError,setReviewError]=useState('');
 const [agentSelection,setAgentSelection]=useState<RequestAgentSelection>(()=>cleanAgentSelection(q?.agent_selection,initialImportance==='critical'||q?.review_policy?.mode!=='not_requested'));
 const projectDrafts=useRef(new Map<string,{profile:DeliveryProfile;deliveryChoice:DeliveryChoice;importance:'normal'|'critical';importanceChanged:boolean;reviewMode:string;reviewFocus:string;note:string;agentSelection:RequestAgentSelection}>());
 const changeProject=(id:string)=>{
   projectDrafts.current.set(project,{profile,deliveryChoice,importance,importanceChanged,reviewMode,reviewFocus,note,agentSelection});
   const next=projects.find((p:R)=>p.id===id)||{} as R,draft=projectDrafts.current.get(id);
   setProject(id);setProfile(draft?.profile||deliveryForView({},next));setImportance(draft?.importance||(next.importance||'normal') as 'normal'|'critical');
   setDeliveryChoice(draft?.deliveryChoice||defaultDeliveryChoice(undefined,next));setImportanceChanged(draft?.importanceChanged||false);s.rememberProject(id);
   setReviewMode(draft?.reviewMode||'required');setReviewFocus(draft?.reviewFocus||'');setNote(draft?.note||'');setReviewError('');
   setAgentSelection(draft?.agentSelection||{});
 };
 const {error,saving,run}=useSubmit();const planned=q?.status==='planned';
 const waiting=q?.status==='awaiting_planning';
 const focusItems=reviewFocus.split(/\r?\n/).map((x:string)=>x.trim()).filter(Boolean);
 const invalidFocus=!focusItems.length||focusItems.length>12||focusItems.some(x=>x.length<2||x.length>500);
 const save=(status:'draft'|'awaiting_planning')=>{
   const validation=importance==='normal'&&reviewMode==='light'&&invalidFocus?'请填写 1–12 项审查范围，每项 2–500 字。':importance==='normal'&&reviewMode==='not_requested'&&status==='awaiting_planning'&&note.trim().length<5?'请用至少 5 个字说明不安排审查的原因。':'';
   if(validation){setReviewError(validation);return;}
   setReviewError('');void run(async()=>{const result=await api(q?'/requests/'+q.id+'/edit':'/requests',{project_id:project,...(importanceChanged?{importance}:{}),planning_preferences:{delivery:deliveryChoice},agent_selection:cleanAgentSelection(agentSelection,importance==='critical'||reviewMode!=='not_requested'),...(deliveryChoice==='custom'?{delivery_profile:profile}:{}),text,status,kind:q?.kind||'idea',workflow_kind:workflowKind,desired_output:desiredOutput,success_criteria:successCriteria,review_mode:importance==='critical'?'required':reviewMode,review_focus:importance==='normal'&&reviewMode==='light'?focusItems:[],skip_review:importance==='critical'?false:reviewMode==='not_requested',review_note:note,...(q?{version:q.version,replan}:{})});s.rememberProject(project);s.go({page:'requests',tab:status==='draft'?'drafts':'waiting'});if(status==='awaiting_planning'&&!waiting)setSaved(result);return result},status==='draft'?'已记在待开始':waiting?'需求已更新':undefined,status==='draft'||waiting);
 };
 if(saved)return saved.workflow_kind==='small'?<ChatPlanningDialog requestId={saved.id} onClose={onClose}/>:<RequestHandoffDialog request={saved} onClose={onClose}/>;
 return <Dialog title={q?'编辑需求':'提一个需求'} sub="描述一次想做的事，下面的安排随时可改。" onClose={onClose} label={q?'编辑需求':'提需求'} footer={<><button type="button" className="btn ghost" onClick={onClose}>取消</button><button type="button" onClick={()=>save('draft')} className="btn" disabled={saving||!text.trim()||!selectedProject.id||planned&&!replan}>{waiting?'暂时不做':q?'保存，稍后再做':'先记下来'}</button><button type="submit" form={formId} className="btn primary" disabled={saving||!text.trim()||!selectedProject.id||planned&&!replan}>{saving?'正在保存…':waiting?'保存修改':'现在开始'}{!waiting&&<ArrowRight size={15}/>}</button></>}><form id={formId} className="form delivery-form request-form" onInvalidCapture={e=>{
   let ancestor=(e.target as HTMLElement).parentElement;
   while(ancestor&&ancestor!==e.currentTarget){if(ancestor instanceof HTMLDetailsElement)ancestor.open=true;ancestor=ancestor.parentElement;}
 }} onSubmit={e=>{e.preventDefault();save('awaiting_planning')}}>
   <ProjectPicker projects={projects} value={project} onChange={changeProject}/>
   {!projects.length&&<Notice>先在项目页添加或恢复一个项目。</Notice>}
   {project&&!selectedProject.id&&<Notice>原项目已收纳或归档。请选择正在进行的项目，或先在项目页恢复它。</Notice>}
   <Field label="你想完成什么？"><textarea data-autofocus required rows={4} maxLength={20000} placeholder="想改什么、最后怎么用？对模型、审查或成果有要求，也写在这里。" value={text} onChange={e=>setText(e.target.value)}/></Field>
   <div className="request-options">
    <ImportanceField value={importance} onChange={value=>{setImportance(value);setImportanceChanged(true);setReviewError('')}}/>
    <Field label="交给谁规划"><select value={workflowKind} onChange={e=>setWorkflowKind(e.target.value)}><option value="standard">已连接工作台的 Agent</option><option value="small">普通聊天（无需连接）</option></select></Field>
   </div>
   <Field label="成果与使用位置"><select value={deliveryChoice} onChange={e=>setDeliveryChoice(e.target.value as DeliveryChoice)}><option value="project">沿用项目设置</option><option value="planner">根据这次需求，由大脑安排</option><option value="custom">这次由我指定</option></select></Field>
   {deliveryChoice==='project'&&<p className="request-delivery-summary">{deliverySummary(deliveryForView({},selectedProject))}</p>}
   {deliveryChoice==='planner'&&<p className="muted small request-choice-note">大脑根据上面的描述提出成果和使用方案。</p>}
   {deliveryChoice==='custom'&&<DeliveryProfileFields key={project} value={profile} onChange={setProfile}/>}
   <Field label="交付后的审查"><select disabled={importance==='critical'} value={importance==='critical'?'required':reviewMode} onChange={e=>{setReviewMode(e.target.value);setReviewError('');if(e.target.value==='not_requested'){setAgentSelection(value=>cleanAgentSelection(value,false));if(!note)setNote('本次由我自行试用，不安排独立审查')}}}><option value="required">完整独立审查</option><option value="light">只检查我指定的部分</option><option value="not_requested">我自行试用，不安排审查</option></select></Field>
   {importance==='normal'&&reviewMode==='light'&&<Field label="有限审查范围（每行一项）" hint="写下要检查的具体方面。"><textarea rows={2} maxLength={6011} value={reviewFocus} onChange={e=>{setReviewFocus(e.target.value);setReviewError('')}}/></Field>}
   {importance==='normal'&&reviewMode==='not_requested'&&<Field label="不安排审查的原因"><input maxLength={2000} value={note} onChange={e=>{setNote(e.target.value);setReviewError('')}}/></Field>}
   <AgentSelectionFields value={agentSelection} onChange={setAgentSelection} reviewEnabled={importance==='critical'||reviewMode!=='not_requested'}/>
   {q?.desired_output&&<Field label="此前填写的期望结果"><textarea rows={2} maxLength={2000} value={desiredOutput} onChange={e=>setDesiredOutput(e.target.value)}/></Field>}
   {q?.success_criteria&&<Field label="此前填写的完成标准"><textarea rows={2} maxLength={2000} value={successCriteria} onChange={e=>setSuccessCriteria(e.target.value)}/></Field>}
   {planned&&<label className="check"><input type="checkbox" checked={replan} onChange={e=>setReplan(e.target.checked)}/>撤回尚未派发的原计划，按本次修改保存</label>}
   {reviewError&&<Notice tone="error">{reviewError}</Notice>}
   {error&&<Notice tone="error">{error}</Notice>}
 </form></Dialog>
}

export function RequestActionDialog({request:q,action,onClose}:{request:R;action:'recall'|'delete';onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit();
 const title=action==='recall'?'暂时不做':'删除需求';
 const submit=()=>void run(async()=>{
   if(action==='delete')return api('/requests/'+q.id+'/delete',{version:q.version});
   const result=await api('/requests/'+q.id+'/edit',{project_id:q.project_id,text:q.text,status:'draft',kind:q.kind||'idea',version:q.version,workflow_kind:q.workflow_kind||'standard',desired_output:q.desired_output||'',success_criteria:q.success_criteria||'',review_mode:q.importance==='critical'?'required':q.review_policy?.mode||'required',review_focus:q.importance==='critical'?[]:q.review_policy?.focus||[],skip_review:q.importance==='critical'?false:q.review_policy?.mode==='not_requested',review_note:q.review_policy?.note||''});
   s.go({page:'requests',tab:'drafts'});return result;
 },action==='delete'?'需求已删除':'已移回待开始');
 return <Dialog title={title} onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>取消</button><button className={'btn '+(action==='delete'?'danger':'primary')} disabled={saving} onClick={submit}>{saving?'正在保存…':action==='delete'?'确认删除':title}</button></>}>
   <p className="request-text">{q.text}</p><p className="muted">{action==='recall'?'移回“待开始”，以后想做时再开始。':q.status==='planned'?'删除这项需求，并撤回尚未派发的计划。已有记录保留在项目历史中。':'从需求箱和待规划列表中移除这项需求。'}</p>{error&&<Notice tone="error">{error}</Notice>}
 </Dialog>;
}

export function RequestHandoffDialog({request:q,fallbackText='',onClose}:{request:R;fallbackText?:string;onClose():void}){
 const s=useStore(),{error,saving,run}=useSubmit(),[fallback,setFallback]=useState(fallbackText),[copied,setCopied]=useState(false);
 const copy=()=>void run(async()=>{const r=await api('/requests/'+q.id+'/entry');const ok=await s.copy(r.text,'已复制，粘贴给规划 Agent 即可');setCopied(ok);setFallback(ok?'':r.text);return r},undefined,false);
 return <Dialog title="下一步：发给规划 Agent" onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}><p className="lead">让规划 Agent 读取项目资料，拆分任务并选好执行者。</p><p className="request-text">{q.text}</p><button className="btn primary" disabled={saving} onClick={copy}><Copy size={16}/>{saving?'正在准备…':copied?'再次复制':'复制给规划 Agent'}</button>{copied&&<p className="muted small">已复制。切换到你选用的 Agent 会话，粘贴后发送。</p>}{fallback&&<CopyBox text={fallback} label="手动复制给规划 Agent"/>}{error&&<Notice tone="error">{error}</Notice>}</Dialog>;
}

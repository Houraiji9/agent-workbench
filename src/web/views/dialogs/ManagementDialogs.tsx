import React,{useState} from 'react';
import {Plus,Trash2,ChevronUp,ChevronDown} from 'lucide-react';
import {api} from '../../api.js';
import {useStore} from '../../app/store.js';
import type {R} from '../../lib/flow.js';
import {Dialog,Field,Notice} from '../../ui/kit.js';
import {useSubmit} from './useSubmit.js';
import {workKinds,quotaMetrics,agentIconKeys} from '../../../shared/resource-options.js';

function FormFoot({onClose,saving,label='保存'}:{onClose():void;saving:boolean;label?:string}){return <footer className="dialog-foot inline"><button type="button" className="btn ghost" onClick={onClose}>取消</button><button className="btn primary" disabled={saving}>{saving?'正在保存…':label}</button></footer>}

export function AgentManageDialog({agent,preset,modelsOpen,onClose}:{agent?:R;preset?:R;modelsOpen?:boolean;onClose():void}){
 const s=useStore();
 const [a]=useState(agent),[p]=useState(preset);
 const [form,setForm]=useState({name:a?.name||p?.name||'',scope:a?.scope||p?.scope||'',restriction:a?.restriction||'',model:a?.model||'',icon_key:a?.icon_key||p?.icon_key||(agentIconKeys.includes(a?.id as any)?a?.id:'auto'),allowed_kinds:a?.allowed_kinds||p?.allowed_kinds||['research','operations']});
 const [models,setModels]=useState<R[]>(()=>structuredClone(a?(s.data.model_catalog||[]).find((g:R)=>g.agent_id===a.id)?.models||[]:p?.models||[]));
 const {error,saving,run}=useSubmit();
 const set=(k:string,v:any)=>setForm({...form,[k]:v});
 const change=(i:number,k:string,v:string)=>setModels(models.map((m,j)=>i===j?{...m,[k]:v}:m));
 const move=(i:number,d:number)=>{const next=[...models];[next[i],next[i+d]]=[next[i+d],next[i]];setModels(next)};
 return <Dialog title={a?`编辑 ${a.name}`:p?`添加 ${p.name}`:'新增团队'} onClose={onClose} label={a?'编辑分工':undefined}>
  <form className="form" onSubmit={e=>{e.preventDefault();void run(()=>api(a?'/agents/'+a.id+'/edit':'/agents',{version:a?.version||0,preset_id:a?.preset_id||p?.id||null,...form,model:form.model||null,models:models.map(m=>({...m,id:m.id.trim()||m.name.trim()}))}),a?'成员资料已保存':'已加入团队')}}>
   <div className="grid-2"><Field label="成员名称"><input data-autofocus required maxLength={100} value={form.name} onChange={e=>set('name',e.target.value)}/></Field><Field label="图标"><select value={form.icon_key} onChange={e=>set('icon_key',e.target.value)}>{agentIconKeys.map(k=><option key={k} value={k}>{k==='auto'?'名称缩写':s.data.agents.find((x:R)=>x.id===k)?.name||k}</option>)}</select></Field></div>
   <Field label="适合做什么"><textarea required rows={2} maxLength={10000} placeholder="例如：整理资料、制作文档、开发网站" value={form.scope} onChange={e=>set('scope',e.target.value)}/></Field>
   <fieldset className="choice-set"><legend>可以分配的工作</legend><div className="choice-list">{workKinds.map(([key,label])=><label key={key}><input type="checkbox" checked={form.allowed_kinds.includes(key)} onChange={e=>set('allowed_kinds',e.target.checked?[...form.allowed_kinds,key]:form.allowed_kinds.filter((k:string)=>k!==key))}/>{label}</label>)}</div></fieldset>
   <Field label="分工备注"><textarea rows={2} maxLength={10000} placeholder="可选，填写特别偏好或使用范围" value={form.restriction} onChange={e=>set('restriction',e.target.value)}/></Field>
   <Field label="常用模型备注（可选）"><input maxLength={200} value={form.model} onChange={e=>set('model',e.target.value)}/></Field>
   <details className="fold model-editor" open={modelsOpen||undefined}><summary>模型列表（{models.length}）</summary>
    {models.map((m,i)=><fieldset className="editable-row" key={i}><legend>模型 {i+1}</legend><div className="grid-2"><Field label="模型名称"><input required maxLength={100} value={m.name} onChange={e=>change(i,'name',e.target.value)}/></Field><Field label="型号（选填）"><input maxLength={100} placeholder="留空使用模型名称" value={m.id} onChange={e=>change(i,'id',e.target.value)}/></Field></div><Field label="建议用途"><input maxLength={500} value={m.purpose} onChange={e=>change(i,'purpose',e.target.value)}/></Field><div className="tool-row"><button type="button" className="icon-btn" aria-label={`上移模型 ${i+1}`} disabled={i===0} onClick={()=>move(i,-1)}><ChevronUp size={15}/></button><button type="button" className="icon-btn" aria-label={`下移模型 ${i+1}`} disabled={i===models.length-1} onClick={()=>move(i,1)}><ChevronDown size={15}/></button><button type="button" className="link" onClick={()=>setModels(models.filter((_,j)=>j!==i))}><Trash2 size={14}/>删除模型 {i+1}</button></div></fieldset>)}
    {!models.length&&<p className="muted small">可先留空，派单时由执行者选择。</p>}<button type="button" className="btn small" disabled={models.length>=60} onClick={()=>setModels([...models,{id:'',name:'',purpose:''}])}><Plus size={14}/>添加模型</button>
   </details>
   {error&&<Notice tone="error">{error}</Notice>}<FormFoot onClose={onClose} saving={saving} label={a?'保存':'加入团队'}/>
  </form>
 </Dialog>;
}

const emptyWindow=()=>({label:'剩余额度',metric:'percent',remaining:'',limit:'',currency:'CNY',unit:'次',resets_at:'',monthly_enabled:false,monthly_allowance:'',monthly_remaining:''});
function localTime(value:string){if(!value)return '';const d=new Date(value);return Number.isNaN(+d)?'':new Date(+d-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}
export function QuotaManageDialog({pool,onClose}:{pool?:R;onClose():void}){
 const s=useStore();const [p]=useState(pool),[d]=useState((s.data.quota_definitions||[]).find((d:R)=>d.id===pool?.management_id));
 const [name,setName]=useState(d?.name||p?.name||''),[members,setMembers]=useState<string[]>(()=> (d?.members||p?.members||[]).filter((id:string)=>s.data.agents.some((a:R)=>a.id===id&&!a.archived))),[source,setSource]=useState(d?.source_ref||(p&&!p.custom_quota?p.id:''));
 const [windows,setWindows]=useState<R[]>(()=>d?.windows?.length?d.windows.map((w:R)=>({...w,remaining:w.remaining??'',limit:w.limit??'',currency:w.currency||'CNY',resets_at:localTime(w.resets_at),monthly_enabled:!!w.monthly,monthly_allowance:w.monthly?.allowance??'',monthly_remaining:w.monthly?.remaining??''})):[emptyWindow()]);
 const {error,saving,run}=useSubmit();const set=(i:number,key:string,value:any)=>setWindows(windows.map((w,j)=>i===j?{...w,[key]:value}:w));
 const sources=(s.data.quota_sources||[]).filter((q:R)=>q.status!=='notConfigured'||q.cache_editable||q.points_editable).filter((q:R)=>!(s.data.quota_definitions||[]).some((x:R)=>x.source_ref===q.id&&x.id!==d?.id));
 const selectedSource=sources.find((q:R)=>q.id===source);
 return <Dialog title={p?'管理 '+p.name:'添加额度'} onClose={onClose}>
  <form className="form subscription-form" onSubmit={e=>{e.preventDefault();void run(()=>api(d?'/quotas/'+d.id+'/edit':'/quotas',{version:d?.version||0,source_ref:source||null,name,members,windows:source?[]:windows.map(w=>({label:w.label,metric:w.metric,remaining:w.remaining===''?null:Number(w.remaining),limit:w.metric==='percent'||w.limit===''||w.metric==='points'&&w.monthly_enabled?null:Number(w.limit),currency:w.metric==='currency'?w.currency:null,unit:w.metric==='count'?w.unit:'',resets_at:w.resets_at?new Date(w.resets_at).toISOString():null,monthly:w.metric==='points'&&w.monthly_enabled?{allowance:Number(w.monthly_allowance),remaining:w.monthly_remaining===''?null:Number(w.monthly_remaining)}:null}))}),'额度已保存')}}>
   <div className="grid-2"><Field label="额度名称"><input required data-autofocus maxLength={100} placeholder="例如：我的编程积分" value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="数据来源"><select disabled={!!p||!!d} value={source} onChange={e=>{setSource(e.target.value);const q=sources.find((q:R)=>q.id===e.target.value);if(q){setName(q.name);setMembers(q.members||[])}}}><option value="">手动填写</option>{sources.map((q:R)=><option key={q.id} value={q.id}>{q.name}{q.points_editable?' · 手动积分':q.cache_editable?' · 缓存与手填':' · Token Monitor'}</option>)}</select></Field></div>
   <fieldset className="choice-set"><legend>哪些成员共用这份额度</legend><div className="choice-list">{(s.data.agents as R[]).filter(a=>!a.archived).map(a=><label key={a.id}><input type="checkbox" checked={members.includes(a.id)} onChange={e=>setMembers(e.target.checked?[...members,a.id]:members.filter(id=>id!==a.id))}/>{a.name}</label>)}</div></fieldset>
   {source?<p className="muted small">{selectedSource?.points_editable?'积分在卡片上的“填写积分”或“修改积分”中更新。':selectedSource?.cache_editable?'数值在卡片上的“编辑额度”中更新，也会接收 Token Monitor 的新记录。':'数值跟随 Token Monitor 更新。'}</p>:<>
   {windows.map((w,i)=><fieldset className="editable-row" key={i}><legend>额度 {i+1}</legend><div className="grid-2"><Field label="类型"><select value={w.metric} onChange={e=>set(i,'metric',e.target.value)}>{quotaMetrics.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="窗口名称"><input required maxLength={100} value={w.label} onChange={e=>set(i,'label',e.target.value)} placeholder="例如：每周、5 小时"/></Field></div>
    <div className="grid-2"><Field label={w.metric==='percent'?'剩余（%）':w.metric==='points'&&w.monthly_enabled?'总剩余积分':'剩余数量'}><input type="number" min="0" max={w.metric==='percent'?100:1e12} step="any" value={w.remaining} onChange={e=>set(i,'remaining',e.target.value)} placeholder="暂不清楚可留空"/></Field>{w.metric!=='percent'&&!(w.metric==='points'&&w.monthly_enabled)?<Field label="总量（选填）"><input type="number" min="0.001" max={1e12} step="any" value={w.limit} onChange={e=>set(i,'limit',e.target.value)} placeholder="填写后显示进度条"/></Field>:w.metric==='percent'?<Field label="重置时间（选填）"><input type="datetime-local" value={w.resets_at} onChange={e=>set(i,'resets_at',e.target.value)}/></Field>:null}</div>
    {w.metric==='points'&&<><label className="check"><input type="checkbox" checked={w.monthly_enabled} onChange={e=>set(i,'monthly_enabled',e.target.checked)}/>包含每月刷新的基础积分</label>{w.monthly_enabled&&<div className="grid-2"><Field label="每月基础积分"><input required type="number" min="0.001" max={1e12} step="any" value={w.monthly_allowance} onChange={e=>set(i,'monthly_allowance',e.target.value)}/></Field><Field label="本月剩余积分"><input type="number" min="0" max={w.monthly_allowance||1e12} step="any" placeholder="暂不清楚可留空" value={w.monthly_remaining} onChange={e=>set(i,'monthly_remaining',e.target.value)}/></Field></div>}</>}
    {w.metric!=='percent'&&<div className="grid-2">{w.metric==='currency'?<Field label="币种"><select value={w.currency} onChange={e=>set(i,'currency',e.target.value)}>{['CNY','USD','EUR','HKD','JPY','GBP'].map(c=><option key={c}>{c}</option>)}</select></Field>:w.metric==='count'?<Field label="单位"><input maxLength={20} value={w.unit} onChange={e=>set(i,'unit',e.target.value)} placeholder="次、条、Token"/></Field>:<span/>}<Field label="重置时间（选填）"><input type="datetime-local" value={w.resets_at} onChange={e=>set(i,'resets_at',e.target.value)}/></Field></div>}
    {windows.length>1&&<button className="link" type="button" onClick={()=>setWindows(windows.filter((_,j)=>j!==i))}><Trash2 size={14}/>删除额度 {i+1}</button>}
   </fieldset>)}<button type="button" className="btn small" disabled={windows.length>=20} onClick={()=>setWindows([...windows,emptyWindow()])}><Plus size={14}/>添加额度窗口</button></>}
   {p&&<button type="button" className="link" onClick={()=>s.openDialog('resource-remove',{kind:'quota',item:p})}><Trash2 size={14}/>删除额度</button>}
   {error&&<Notice tone="error">{error}</Notice>}<FormFoot onClose={onClose} saving={saving}/>
  </form>
 </Dialog>;
}

export function RemoveResourceDialog({kind,item,onClose}:{kind:'agent'|'quota';item:R;onClose():void}){
 const [value]=useState(item);const {error,saving,run}=useSubmit();
 const remove=()=>kind==='agent'?api('/agents/'+value.id+'/delete',{version:value.version}):value.management_id?api('/quotas/'+value.management_id+'/delete',{version:value.management_version}):api('/quotas/hide-source',{version:0,source_ref:value.id,name:value.name,members:value.members||[],windows:[]});
 return <Dialog title={'删除 '+value.name} onClose={onClose}><p>删除后可在“已移除”中恢复。已有任务和记录会继续保留。</p>{error&&<Notice tone="error">{error}</Notice>}<footer className="dialog-foot inline"><button className="btn ghost" onClick={onClose}>取消</button><button className="btn danger" disabled={saving} onClick={()=>void run(remove,'已移除')}>确认删除</button></footer></Dialog>;
}

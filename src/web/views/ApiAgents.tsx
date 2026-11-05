import React, {useCallback, useEffect, useRef, useState} from 'react';
import {KeyRound, PencilLine, Plug, Plus, RefreshCw, ShieldCheck} from 'lucide-react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import {Dialog, Empty, Field, Notice, Pill} from '../ui/kit.js';
import type {Tone} from '../lib/flow.js';
import './api-agents.css';

interface ApiAgent {
  id:string;agent_id:string;name:string;base_url:string;model:string;protocol:'chat_completions'|'responses';
  system_prompt:string;enabled:boolean;has_key:boolean;version:number;status:string;
}
interface Catalog {agents:ApiAgent[];vault:{available:boolean;reason?:string}}
interface CheckResult {status:string;ready:boolean;message:string;checked_at:string}
const message=(error:unknown)=>error instanceof Error?error.message:'操作未完成，请重试。';
const statusLabel=(agent:ApiAgent)=>!agent.enabled?'已停用':!agent.has_key?'待填写密钥':({ready:'配置就绪，尚未验证调用',configured:'已配置，尚未验证调用',configuration_checked:'本机配置已核对',vault_unavailable:'本机凭据库不可用',missing_key:'待填写密钥',disabled:'已停用',invalid:'配置需要调整',unavailable:'暂不可调用'}[agent.status]||'配置待核对');
const statusTone=(agent:ApiAgent):Tone=>!agent.enabled?'quiet':!agent.has_key||['vault_unavailable','invalid','unavailable'].includes(agent.status)?'problem':'review';
const fields=(agent:ApiAgent)=>({id:agent.id,version:agent.version,name:agent.name,base_url:agent.base_url,model:agent.model,protocol:agent.protocol,system_prompt:agent.system_prompt,enabled:agent.enabled});

export function ApiAgents({createRequested,onCreateHandled}:{createRequested:boolean;onCreateHandled:()=>void}){
  const s=useStore(),[catalog,setCatalog]=useState<Catalog|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[notice,setNotice]=useState('');
  const [editing,setEditing]=useState<{agent?:ApiAgent}|null>(null),[revoke,setRevoke]=useState<ApiAgent|null>(null),[checks,setChecks]=useState<Record<string,CheckResult>>({});
  const seq=useRef(0),openedRoute=useRef('');
  const load=useCallback(async(signal?:AbortSignal)=>{const current=++seq.current;setLoading(true);try{const value:Catalog=await api('/api-agents',undefined,signal);if(current===seq.current&&!signal?.aborted){setCatalog(value);setError('');}}catch(err){if(current===seq.current&&!signal?.aborted)setError(message(err));}finally{if(current===seq.current&&!signal?.aborted)setLoading(false);}},[]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[load,s.changeTick]);
  useEffect(()=>{if(createRequested&&catalog){setEditing({});onCreateHandled();}},[createRequested,catalog,onCreateHandled]);
  useEffect(()=>{if(!s.route.id){openedRoute.current='';return;}const agent=catalog?.agents.find(a=>a.id===s.route.id);if(agent&&openedRoute.current!==agent.id){openedRoute.current=agent.id;setEditing({agent});}},[s.route.id,catalog]);
  const closeEditor=()=>{setEditing(null);if(s.route.id)s.go({page:'team',tab:'api'});};
  const perform=async(id:string,action:()=>Promise<void>)=>{if(busy)return;setBusy(id);setError('');setNotice('');try{await action();}catch(err){setError(message(err));}finally{setBusy('');}};
  return <section className="api-agents" aria-label="API 型 Agent 配置">
    <div className="api-agent-intro"><div><h2>用 API 加入协作</h2><p>配置服务地址、密钥和模型后，即可在工作群选择它执行任务或担任负责人。</p></div><button className="btn" disabled={loading||!!busy} onClick={()=>void load()}><RefreshCw size={15} aria-hidden="true"/>{loading?'读取中…':'刷新配置'}</button></div>
    {error&&<Notice tone="error">{error} <button className="link" onClick={()=>void load()}>重新读取</button></Notice>}{notice&&<Notice>{notice}</Notice>}
    {catalog&&!catalog.vault.available&&<Notice tone="warn">本机凭据库暂不可用。{catalog.vault.reason||'可以查看配置，恢复后再保存或更换密钥。'}</Notice>}
    {loading&&!catalog?<Empty title="正在读取 API 型 Agent…"/>:catalog&&!catalog.agents.length?<Empty icon={<Plug size={28}/>} title="添加一位 API 型 Agent" action={<button className="btn primary" onClick={()=>setEditing({})}><Plus size={16} aria-hidden="true"/>添加第一位 API Agent</button>}>填入你已有的 API 配置，不需要安装 CLI。保存不会调用模型。</Empty>:catalog&&<div className="api-agent-grid">{catalog.agents.map(agent=><article className="api-agent-card" aria-label={agent.name} key={agent.id}>
      <header><span className="api-agent-symbol"><Plug size={21} aria-hidden="true"/></span><div><h3>{agent.name}</h3><span className="api-agent-kind">API 型 Agent</span></div><Pill tone={statusTone(agent)}>{statusLabel(agent)}</Pill></header>
      <dl><div><dt>调用配置模型</dt><dd>{agent.model}</dd></div><div><dt>服务地址</dt><dd>{agent.base_url}</dd></div><div><dt>本机密钥</dt><dd><KeyRound size={13} aria-hidden="true"/>{agent.has_key?'已保存，不回显':'尚未配置'}</dd></div></dl>
      {checks[agent.id]&&<p className={'api-agent-check'+(checks[agent.id].ready?'':' needs-attention')} role="status">{checks[agent.id].message}<small>仅核对本机配置，未向模型服务发送请求。</small></p>}
      <footer><button className="btn small" disabled={!!busy} onClick={()=>setEditing({agent})}><PencilLine size={14} aria-hidden="true"/>编辑配置</button><button className="btn small" disabled={!!busy} onClick={()=>void perform(agent.id,async()=>{const value:CheckResult=await api('/api-agents/'+encodeURIComponent(agent.id)+'/check',{});setChecks(previous=>({...previous,[agent.id]:value}));})}><ShieldCheck size={14} aria-hidden="true"/>{busy===agent.id?'正在检查…':'本机配置检查'}</button><button className="link api-agent-revoke" disabled={!!busy||!agent.has_key} onClick={()=>setRevoke(agent)}>撤销密钥</button></footer>
    </article>)}</div>}
    <p className="api-agent-note">保存和本机检查不会调用模型。加入工作群后的实际执行可能消耗服务商额度；实际模型以调用回传为准。</p>
    {editing&&catalog&&<ApiAgentEditor key={editing.agent?.id||'new'} agent={editing.agent} vaultAvailable={catalog.vault.available} onClose={closeEditor} onSaved={async()=>{closeEditor();setChecks({});await Promise.all([load(),s.refresh()]);setNotice('API 型 Agent 已保存。可在工作群选择配置就绪的成员；本次未发起模型调用。');}}/>}
    {revoke&&<Dialog title="撤销本机密钥" onClose={()=>{if(!busy)setRevoke(null);}}><p>撤销“{revoke.name}”在本机保存的 API Key 并停用此 Agent。名称、地址、模型和历史记录会保留；服务商签发的 Key 不受影响。</p>{error&&<Notice tone="error">{error}</Notice>}<div className="api-agent-actions"><button className="btn" disabled={!!busy} onClick={()=>setRevoke(null)}>取消</button><button className="btn danger" disabled={!!busy} onClick={()=>void perform('revoke',async()=>{await api('/api-agents/save',{...fields(revoke),enabled:false,wipe_key:true});setRevoke(null);setChecks({});await Promise.all([load(),s.refresh()]);setNotice('本机密钥已撤销，此 API 型 Agent 已停用。');})}>{busy?'正在处理…':'撤销并停用'}</button></div></Dialog>}
  </section>;
}

function addressError(value:string){
  try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol))return '请填写 HTTP 或 HTTPS 服务地址。';if(url.username||url.password||url.search||url.hash||/[\\\x00-\x20?#]/.test(value))return '服务地址不能包含用户名、密码、查询参数、片段或空白；密钥请填写到 API Key。';if(url.protocol==='http:'&&!['localhost','[::1]'].includes(url.hostname)&&!/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname))return '远程服务需要使用 HTTPS；HTTP 仅可用于本机地址。';return '';}catch{return '请填写完整的服务地址，例如 https://api.example.com/v1。';}
}

function ApiAgentEditor({agent,vaultAvailable,onClose,onSaved}:{agent?:ApiAgent;vaultAvailable:boolean;onClose:()=>void;onSaved:()=>Promise<void>}){
  const [form,setForm]=useState({name:agent?.name||'',base_url:agent?.base_url||'',model:agent?.model||'',protocol:agent?.protocol||'chat_completions',system_prompt:agent?.system_prompt||'',enabled:agent?.enabled??true});
  const [key,setKey]=useState(''),[error,setError]=useState(''),[saving,setSaving]=useState(false),[urlError,setUrlError]=useState('');
  const errorRef=useRef<HTMLDivElement>(null);
  const set=<K extends keyof typeof form>(name:K,value:(typeof form)[K])=>setForm(previous=>({...previous,[name]:value}));
  const close=()=>{if(!saving){setKey('');onClose();}};
  const submit=async(event:React.FormEvent)=>{event.preventDefault();if(saving)return;const invalid=addressError(form.base_url.trim());setUrlError(invalid);if(invalid)return;if(key&&!vaultAvailable){setError('本机凭据库不可用，暂不能保存密钥。');return;}setSaving(true);setError('');try{await api('/api-agents/save',{...(agent?{id:agent.id,version:agent.version}:{}),...form,name:form.name.trim(),base_url:form.base_url.trim(),model:form.model.trim(),...(key?{api_key:key}:{})});setKey('');await onSaved();}catch(err){const text=message(err);setError(key?text.replaceAll(key,'[密钥已隐藏]'):text);requestAnimationFrame(()=>errorRef.current?.focus());}finally{setSaving(false);}};
  return <Dialog title={agent?'编辑 API 型 Agent':'添加 API 型 Agent'} onClose={close} wide><form className="api-agent-form" onSubmit={submit} autoComplete="off">
    <Field label="名称"><input aria-label="名称" required maxLength={100} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="例如：我的设计助手"/></Field>
    <Field label="API 地址" hint="填写服务商提供的 API 基址，也可填写对应协议的完整接口地址。"><input aria-label="API 地址" type="url" required maxLength={2048} value={form.base_url} onChange={e=>{set('base_url',e.target.value);setUrlError('');}} placeholder="https://api.example.com/v1" spellCheck={false} aria-invalid={!!urlError} aria-describedby={urlError?'api-agent-url-error':undefined}/></Field>
    {urlError&&<p id="api-agent-url-error" className="api-agent-field-error" role="alert">{urlError}</p>}
    <Field label="API Key" hint={agent?.has_key?'已保存在本机。留空保留原密钥；填写新值会替换。':'仅发送到本机工作台，由本机凭据库存储。可以先留空保存配置。'}><input aria-label="API Key" type="password" maxLength={32768} autoComplete="new-password" spellCheck={false} value={key} onChange={e=>setKey(e.target.value)} disabled={!vaultAvailable} placeholder={agent?.has_key?'留空保留已保存的密钥':'填写 API Key'}/></Field>
    {!vaultAvailable&&<Notice tone="warn">本机凭据库暂不可用，无法输入或更换密钥。</Notice>}
    <Field label="模型" hint="填写服务商给出的模型 ID。这里保存调用配置，实际模型以回传为准。"><input aria-label="模型" required maxLength={200} value={form.model} onChange={e=>set('model',e.target.value)} placeholder="服务商的模型 ID" spellCheck={false}/></Field>
    <details className="fold"><summary>高级设置</summary><div className="api-agent-advanced"><Field label="API 协议"><select aria-label="API 协议" value={form.protocol} onChange={e=>set('protocol',e.target.value as typeof form.protocol)}><option value="chat_completions">Chat Completions 兼容</option><option value="responses">Responses 兼容</option></select></Field><Field label="系统提示词（可选）"><textarea aria-label="系统提示词（可选）" rows={4} maxLength={20000} value={form.system_prompt} onChange={e=>set('system_prompt',e.target.value)} placeholder="为这位 Agent 补充长期职责或表达偏好"/></Field><label className="api-agent-enabled"><input type="checkbox" checked={form.enabled} onChange={e=>set('enabled',e.target.checked)}/>允许在工作群调用</label></div></details>
    <p className="api-agent-note">保存不发送模型请求。配置就绪后可作为工作群成员或负责人；实际执行可能消耗服务商额度。</p>
    {error&&<div ref={errorRef} tabIndex={-1}><Notice tone="error">{error}</Notice></div>}<div className="api-agent-actions"><button className="btn" type="button" disabled={saving} onClick={close}>取消</button><button className="btn primary" disabled={saving||!form.name.trim()||!form.base_url.trim()||!form.model.trim()}>{saving?'正在保存…':agent?'保存配置':'添加到团队'}</button></div>
  </form></Dialog>;
}

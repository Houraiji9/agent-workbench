import React,{useEffect,useState} from 'react';
import {api} from '../api.js';import {useStore} from '../app/store.js';import type {R} from '../lib/flow.js';
import {Dialog,Notice,Field,CopyBox} from './kit.js';
import {deliverySummary} from './DeliveryProfileFields.js';
export function ChatPlanningDialog({requestId,onClose}:{requestId:string;onClose():void}){
  const s=useStore(),[context,setContext]=useState<R|null>(null),[text,setText]=useState(''),[preview,setPreview]=useState<R|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState<R|null>(null);
  const [fallback,setFallback]=useState('');
  useEffect(()=>{const ctl=new AbortController();api('/requests/'+requestId+'/chat-context',undefined,ctl.signal).then(setContext).catch(e=>{if(!ctl.signal.aborted)setError(e.message)});return()=>ctl.abort()},[requestId]);
  async function check(){setBusy(true);setError('');try{setPreview(await api('/plans/chat-preview',{text}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  async function save(){setBusy(true);setError('');try{const result=await api('/plans/chat-import',{text});setSaved(result);await s.refresh()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  return <Dialog title="在聊天里规划" sub="规划 Agent 负责理解和分工，工作台保存计划、安排执行并记录结果。" onClose={onClose} label="聊天规划">
    {error&&<Notice tone="error">{error}</Notice>}
    {saved?<><Notice>计划已保存，尚未启动执行。</Notice>{saved.task_ids.map((id:string)=><button key={id} className="btn" onClick={()=>{onClose();s.openTask(id)}}>查看任务与下一步</button>)}</>:<>
      <p>聊天已经连接工作台 MCP 时，让规划 Agent 读取本需求并提交计划即可。没有连接时，用下面两步完成。</p>
      <section className="form"><h3>1. 把需求资料交给规划 Agent</h3><p className="muted small">包含本次需求、项目当前进展、团队和资源摘要。</p>
        <button className="btn" disabled={!context} onClick={async()=>{const content=context!.copy_text;const copied=await s.copy(content,'需求资料已复制');setFallback(copied?'':content)}}>复制给规划 Agent</button>
        {fallback&&<CopyBox text={fallback} label="手动复制给规划 Agent" rows={8}/>}
        <h3>2. 粘贴规划 Agent 返回的计划</h3><Field label="规划 Agent 的完整回复"><textarea rows={7} value={text} maxLength={300000} placeholder="把规划 Agent 给你的计划直接粘贴到这里，不需要自己修改格式。" onChange={e=>{setText(e.target.value);setPreview(null)}}/></Field>
        <button className="btn" disabled={busy||!text.trim()} onClick={()=>void check()}>{busy?'正在核对…':'查看分工预览'}</button>
      </section>
      {preview&&<section aria-label="计划预览"><h3>这次准备怎么做</h3>
        <p>需求重要程度：{preview.importance==='critical'?'重点':'普通'}</p>
        {preview.delivery_profile&&<p>{deliverySummary(preview.delivery_profile)}</p>}
        {preview.tasks.map((t:R,i:number)=><article className="request-card" key={i}><strong>{i+1}. {t.title}</strong><p>{t.goal}</p><p>负责人：{s.name(t.agent_id)} · 模型：{t.model||'按执行设置'} · {t.reviewer_id?'审查：'+s.name(t.reviewer_id):'用户明确不审查'}</p><p>{t.review_policy.mode==='light'?'只检查：'+(t.review_policy.focus||[]).join('；'):t.review_policy.mode==='not_requested'?'未审查，交付后由你试用':'标准独立审查'}</p>{t.delivery_profile&&<p>{deliverySummary(t.delivery_profile)}</p>}<ul>{t.deliverables.map((x:string)=><li key={x}>{x}</li>)}</ul></article>)}<button className="btn primary" disabled={busy} onClick={()=>void save()}>保存这份计划</button></section>}
      <details className="fold"><summary>本机 MCP 连接说明</summary><p>使用工作台现有本机 MCP 配置，并将 WORKBENCH_ROLE 设置为 chat_planner。这个连接只提供需求规划包和提交计划，不能执行、修改文件或验收。配置仍由你在客户端选择，不会自动改全局设置。</p><p className="muted small">并非所有普通聊天模式都支持本机 MCP；连接尚未确认时请使用上面的复制回传。</p></details>
    </>}
  </Dialog>;
}

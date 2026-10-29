import React,{useId,useState} from 'react';
import {api} from '../api.js';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {agentClientKind} from '../../core/agent-client-kind.js';
import {Field,Notice} from './kit.js';

export function TaskReviewArrangement({task,run}:{task:R;run?:R|null}){
  const s=useStore(),id=useId(),arrangement=run?.review_arrangement||(run?run.execution_contract?.review_arrangement:task.review_arrangement),contract=run?.execution_contract;
  // An explicit null is the user's cleared model, and must not revive an older route.
  const currentReviewer=arrangement?.reviewer_id||(run?contract?.reviewer_id:task.reviewer_id)||task.reviewer_id||'';
  const currentRoute=arrangement?arrangement.route:run?contract?.review_route:task.review_route;
  const currentModel=arrangement?arrangement.requested_model??null:run?contract?.model_selection?.review?.model??contract?.review_route?.model??contract?.agent_selection?.review?.model??null:task.model_selection?.review?.model??task.review_route?.model??task.agent_selection?.review?.model??null;
  const currentProvider=currentRoute?.provider||'',executor=run?.agent_id||task.agent_id;
  const agents=(s.data.agents||[]).filter((a:R)=>!a.archived&&a.id!==executor&&a.allowed_kinds?.includes('review'));
  const closed=['accepted','cancelled','rework_linked'].includes(task.status),notRequested=(contract?.review_policy||task.review_policy)?.mode==='not_requested';
  const [editing,setEditing]=useState(false),[reviewer,setReviewer]=useState(''),[model,setModel]=useState(''),[provider,setProvider]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const [replacementMode,setReplacementMode]=useState('stop_then_replace');
  const selected=agents.find((a:R)=>a.id===reviewer),client=selected?agentClientKind(selected):null,harness=client==='dsh';
  const models=(s.data.model_catalog||[]).filter((catalog:R)=>catalog.agent_id===reviewer).flatMap((catalog:R)=>catalog.models||[]);
  const begin=()=>{const eligible=agents.some((a:R)=>a.id===currentReviewer);setReviewer(eligible?currentReviewer:'');setModel(eligible?currentModel||'':'');setProvider(eligible?currentProvider:'');setReplacementMode('stop_then_replace');setError('');setEditing(true);};
  const save=async()=>{
    if(!selected||closed||notRequested)return;setSaving(true);setError('');
    const requested=model.trim()||null,route=client?{client,model:requested,...(harness&&provider.trim()?{provider:provider.trim()}:{})}:undefined;
    try{const result=await s.act(()=>api('/tasks/'+encodeURIComponent(task.id)+'/review-arrangement',{expected_revision:task.revision,reviewer_id:reviewer,requested_model:requested,reason:'用户在任务页调整审查安排',...(run?{replacement_mode:replacementMode}:{}),...(route?{route}:{})}));if(['pending','needs_choice'].includes(result?.status)){setError(result.next||'原调用处理尚未完成，安排没有保存；核对所选方式后重试。');}else if(result){s.toast('审查安排已保存，历史报告保留');setEditing(false);}else setError('没有保存，请查看提示后重试。');}catch(e){setError((e as Error).message)}finally{setSaving(false)}
  };
  return <section className="arrangement-block task-review-arrangement" aria-label="审查安排">
    <h3>审查安排</h3>
    {notRequested?<p className="muted small">本次明确不安排独立审查，审查安排只读。</p>:<>
      <dl className="arrangement-facts"><div><dt>审查者</dt><dd>{currentReviewer?s.name(currentReviewer):'尚未指定'}</dd></div><div><dt>模型建议</dt><dd>{currentModel||'由审查 Agent 决定'}</dd></div>{currentProvider&&<div><dt>供应商</dt><dd>{currentProvider}</dd></div>}</dl>
      <p className="muted small">{run?'正在运行的客户端不会被热切换；后续派审采用保存的安排，已有审查报告保留。':'后续执行单与首次派审使用该安排。'}</p>
      {closed?<p className="muted small">任务已结束，审查安排只读。</p>:!editing?<button className="btn small" disabled={s.busy} onClick={begin}>修改审查安排</button>:<section className="arrangement-block edit" aria-label="修改审查安排">
        <Field label="审查者"><select aria-label="审查者" value={reviewer} disabled={saving} onChange={e=>{setReviewer(e.target.value);setModel('');setProvider('');setError('')}}><option value="">请选择审查者</option>{agents.map((a:R)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="审查模型（可选）" hint="留空后由审查 Agent 决定，也可填写列表之外的模型。"><input aria-label="审查模型（可选）" value={model} maxLength={100} disabled={saving} list={id+'-review-models'} placeholder="填写或选择模型" onChange={e=>setModel(e.target.value)}/><datalist id={id+'-review-models'}>{models.map((m:string|R)=><option key={typeof m==='string'?m:m.id} value={typeof m==='string'?m:m.id}>{typeof m==='string'?m:m.name}</option>)}</datalist></Field>
        {harness&&<Field label="审查供应商（可选）" hint="使用 Harness 时可指定供应商。"><input aria-label="审查供应商（可选）" value={provider} maxLength={100} disabled={saving} placeholder="填写供应商名称" onChange={e=>setProvider(e.target.value)}/></Field>}
        {run&&<Field label="原调用处理"><select aria-label="原调用处理" value={replacementMode} disabled={saving} onChange={e=>setReplacementMode(e.target.value)}><option value="stop_then_replace">结束旧调用后替换</option><option value="retain_parallel">保留原审查并追加</option></select></Field>}
        {!agents.length&&<Notice tone="warn">当前没有可选的独立审查成员，可先在团队中安排另一位具有审查职责的 Agent。</Notice>}
        {error&&<Notice tone="error">{error}</Notice>}
        <div className="tool-row"><button className="btn small primary" disabled={saving||s.busy||!selected} onClick={()=>void save()}>{saving?'正在保存…':'保存审查安排'}</button><button className="btn small ghost" disabled={saving} onClick={()=>{setEditing(false);setError('')}}>取消</button></div>
      </section>}
    </>}
  </section>;
}

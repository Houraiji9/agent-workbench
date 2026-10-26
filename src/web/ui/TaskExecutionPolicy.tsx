// 执行安排：看清本轮实际用谁、什么模型和子代理；在同一任务里改，按阶段说明何时生效，旧执行单与成果保留。
import React,{useState} from 'react';import {api} from '../api.js';import {useStore} from '../app/store.js';import type {R} from '../lib/flow.js';import {ExecutionPolicyFields} from './ExecutionPolicyFields.js';import {Notice,Field} from './kit.js';
import {arrangementPhase,arrangementEffect,arrangementSave} from '../../shared/arrangement.js';
import {taskDisplayStatus} from '../../shared/workflow-view.js';

const sourceText=(c:R|undefined|null)=>c?.model_selection?.user_decision||c?.policy_source==='user_task'?'你的选择':c?.policy_source==='user_request'?'你的需求设置':c?.policy_source==='project_default'?'项目默认':'规划建议';
const runStatusText:R={awaiting_dispatch:'待交给执行者',dispatched:'已转发待接单',running:'执行中',submitted:'已交付',failed:'失败',cancelled:'已作废或取消'};

function Summary({s,agent,model,policy}:{s:R;agent:string;model?:string|null;policy?:R}){
  const children=policy?.allow_subagents?(policy.child_models||[]).join('、')||'未指定':'不使用';
  return <dl className="arrangement-facts"><div><dt>执行者</dt><dd>{s.name(agent)}</dd></div><div><dt>主模型</dt><dd>{model||'未指定'}</dd></div><div><dt>子代理</dt><dd>{children}</dd></div></dl>;
}

export function TaskExecutionPolicy({task,run,runs=[],jobs=[]}:{task:R;run?:R|null;runs?:R[];jobs?:R[]}){
  const s=useStore(),contract=run?.execution_contract,phase=arrangementPhase(task,run,jobs),pending=task.pending_arrangement;
  const currentAgent=run?.agent_id||task.agent_id,currentModel=run?run.requested_model:task.requested_model;
  const [editing,setEditing]=useState(false),[agent,setAgent]=useState<string>(pending?.agent_id||currentAgent);
  const [value,setValue]=useState<R>({...(pending?.execution_policy||contract?.execution_policy||task.execution_policy||{}),main_model:pending?.requested_model??currentModel??null});
  const [error,setError]=useState(''),[savingControl,setSavingControl]=useState<boolean|null>(null);
  const saveControl=async(automatic:boolean)=>{setSavingControl(automatic);try{await s.act(()=>api('/tasks/'+task.id+'/main-execution-control',{expected_revision:task.revision,main_execution_control:automatic?'automatic':'user'}),'启动方式已保存')}finally{setSavingControl(null)}};
  const models=s.data.model_catalog.find((c:R)=>c.agent_id===agent)?.models||[];
  const agents=s.data.agents.filter((a:R)=>!a.archived&&a.allowed_kinds?.includes(task.work_kind)&&a.id!==task.reviewer_id);
  const ordered=[...runs].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))),index=run?ordered.findIndex(r=>r.id===run.id)+1:0;
  const managed=!!task.execution_route&&jobs.some(j=>j.task_id===task.id&&['queued','launching','running'].includes(j.status));
  const save=async(body:R,ok:string)=>{setError('');const r=await s.act(()=>api('/tasks/'+task.id+'/arrangement',{revision:task.revision,...body}),ok);if(r)setEditing(false);else setError('没有保存，请看上方提示后重试');};
  const submit=()=>void save({agent_id:agent,execution_policy:value},phase==='pending'?'已保存为下一版安排；当前这轮不受影响':phase==='direct'?'执行安排已保存':'已按新安排生成执行单；旧执行单和记录保留，尚未启动');
  const proposal=task.proposed_arrangement;
  return <details className="fold arrangement" open={!!pending||!!proposal||undefined}>
    <summary>执行安排{index?` · 第 ${index} 版执行单`:''}{pending?' · 有待生效的调整':''}</summary>
    <section aria-label="当前执行安排" className="arrangement-block">
      <h3>{run?'本轮实际安排':'当前安排'}<small>来源：{sourceText(contract||task)}</small></h3>
      <Summary s={s} agent={currentAgent} model={currentModel} policy={contract?.execution_policy||task.execution_policy}/>
      {run&&phase==='pending'&&<p className="muted small">正在运行的客户端不会被热切换；{managed?'如需马上换，可先停止当前调用，再用“停止后重新开始”，会按下一版安排生成新执行单。':'手工启动的会话无法由工作台停止，本轮交付、失败或返修后再采用新安排。'}</p>}
    </section>
    {task.execution_route&&phase!=='closed'&&<details className="fold"><summary>启动方式 · {task.main_execution_control==='automatic'?'允许自动续作':'由我启动'}</summary>
      <label className="check"><input type="checkbox" checked={savingControl??task.main_execution_control==='automatic'} disabled={s.busy||savingControl!==null} onChange={e=>void saveControl(e.target.checked)}/>允许工作台按任务计划自动返修和收尾</label>
      <p className="muted small">首次执行由你启动。独立审查和已授权的子代理可由执行者直接调用。</p>
    </details>}
    {proposal&&phase!=='closed'&&<section aria-label="会话中的安排建议" className="arrangement-block next">
      <h3>会话中的安排建议<small>尚未采用</small></h3>
      <Summary s={s} agent={proposal.agent_id} model={proposal.requested_model} policy={proposal.execution_policy}/>
      <button className="btn small" disabled={s.busy} onClick={()=>{setAgent(proposal.agent_id);setValue({...proposal.execution_policy});setEditing(true)}}>查看并调整建议</button>
    </section>}
    {pending&&<section aria-label="待生效的下一版安排" className="arrangement-block next">
      <h3>下一版安排（待生效）<small>{new Date(pending.saved_at).toLocaleString()} 保存</small></h3>
      <Summary s={s} agent={pending.agent_id} model={pending.requested_model} policy={pending.execution_policy}/>
      <p className="muted small">下一次生成执行单时采用（返修、重试或停止后重新开始）。</p>
      <button className="btn small ghost" disabled={s.busy} onClick={()=>void save({clear_pending:true},'已撤回下一版安排')}>撤回这次调整</button>
    </section>}
    {phase==='closed'?<p className="muted small">{arrangementEffect.closed}</p>:!editing?<div className="tool-row"><button className="btn small" onClick={()=>setEditing(true)}>{pending?'重新调整':'修改执行安排'}</button></div>:<section aria-label="修改执行安排" className="arrangement-block edit">
      <Notice tone={phase==='replace_unstarted'||phase==='next_version'?'warn':'info'}>{arrangementEffect[phase]}</Notice>
      <Field label="执行负责人"><select value={agent} onChange={e=>{const next=e.target.value;setAgent(next);setValue({...value,main_model:next===currentAgent?currentModel??null:null,child_models:[]})}}>{agents.map((a:R)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <ExecutionPolicyFields value={value} onChange={setValue} models={models} emptyLabel={agent===currentAgent&&currentModel?`沿用当前（${currentModel}）`:'请选择主模型'}/>
      {error&&<Notice tone="error">{error}</Notice>}
      <div className="tool-row"><button className="btn small primary" disabled={s.busy} onClick={submit}>{arrangementSave[phase]}</button><button className="btn small ghost" onClick={()=>setEditing(false)}>取消</button></div>
      <p className="muted small">你的选择优先于规划建议；审查者、任务范围和验收权限不随之改变。</p>
    </section>}
    {ordered.length>1&&<details className="fold"><summary>历次执行单（{ordered.length}）</summary><ol className="arrangement-history">{ordered.map((r,i)=><li key={r.id}><b>第 {i+1} 版</b> {s.name(r.agent_id)} · {r.requested_model||'未指定模型'} · {r.execution_contract?.execution_policy?.allow_subagents?'子代理：'+(r.execution_contract.execution_policy.child_models||[]).join('、'):'不用子代理'} · {r.id===task.current_run_id&&taskDisplayStatus(task)==='continuation_pending'?'原会话待续接':runStatusText[r.status]||r.status}{r.arrangement?` · ${r.arrangement.source==='user_pending'?'采用你保存的下一版安排':'你修改了安排'}`:''}{r.id===run?.id?' · 当前':''}</li>)}</ol></details>}
  </details>;
}

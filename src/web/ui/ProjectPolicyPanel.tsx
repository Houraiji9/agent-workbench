import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../app/store.js';
import type { R } from '../lib/flow.js';
import { ExecutionPolicyFields } from './ExecutionPolicyFields.js';
import { Notice, Field } from './kit.js';

export function ProjectPolicyPanel({ project }: { project: R }) {
  const s = useStore();
  const [agent, setAgent] = useState('');
  const general = {...project.execution_policy,main_model:null,child_models:[]};
  const [value, setValue] = useState<R>(general);
  useEffect(()=>setValue(agent?project.execution_policies?.[agent]||general:general),[project.id,project.version,agent]);
  const models = (s.data.model_catalog as R[]).find(c=>c.agent_id===agent)?.models||[];
  const save = async () => {
    const result = await s.act(() => api(`/projects/${project.id}/execution-policy`, {
      version: project.version,
      agent_id: agent || null,
      execution_policy: value,
    }), '项目默认策略已保存');
    if (result) await s.refresh();
  };
  return <details className="fold">
    <summary>项目默认模型与子代理设置</summary>
    <p className="muted small">按 Agent 保存默认模型；新任务只参考其负责人的设置，已开始的任务保留原有设置。</p>
    <Field label="这份默认设置适用于"><select value={agent} disabled={s.busy||!!project.archived} onChange={e=>setAgent(e.target.value)}><option value="">通用默认（不固定模型）</option>{s.data.agents.filter((a:R)=>!a.archived).map((a:R)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
    {!agent&&<Notice>先选 Agent 再指定主模型和子模型。通用默认只保存预算、上下文等安排。</Notice>}
    {!!agent&&!models.length && <Notice>尚未取得该 Agent 的可选模型，不能选择其他客户端的模型代替。</Notice>}
    {!!project.execution_policy?.main_model&&<Notice tone="warn">旧的通用设置曾固定模型，请选择对应 Agent 后重新保存；旧设置不会套用到其他 Agent。</Notice>}
    <ExecutionPolicyFields value={value} onChange={setValue} models={models} disabled={s.busy || !!project.archived} />
    {project.archived ? <p className="muted small">归档项目不能修改默认策略。</p> : <button className="btn small" disabled={s.busy} onClick={() => void save()}>保存项目默认策略</button>}
  </details>;
}

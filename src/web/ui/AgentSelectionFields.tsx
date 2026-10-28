import React,{useId} from 'react';
import {useStore} from '../app/store.js';
import type {R} from '../lib/flow.js';
import {Field} from './kit.js';
import {agentClientKind} from '../../core/agent-client-kind.js';

type AgentChoice={agent_id?:string|null;model?:string|null;provider?:string|null};
export type RequestAgentSelection={execution?:AgentChoice;review?:AgentChoice};
export function cleanAgentSelection(value:RequestAgentSelection|null|undefined={},reviewEnabled=true):RequestAgentSelection{
  const result:RequestAgentSelection={};
  for(const role of ['execution','review'] as const){
    if(role==='review'&&!reviewEnabled)continue;
    const choice:AgentChoice={};
    for(const field of ['agent_id','model','provider'] as const){const text=value?.[role]?.[field]?.trim();if(text)choice[field]=text;}
    if(Object.keys(choice).length)result[role]=choice;
  }
  return result;
}

export function AgentSelectionFields({value,onChange,reviewEnabled}:{value:RequestAgentSelection;onChange(value:RequestAgentSelection):void;reviewEnabled:boolean}){
  const s=useStore(),id=useId();
  return <section className="request-agent-selection" aria-label="执行与审查预选">
    <h3>执行与审查预选（可选）</h3>
    <p className="muted small">留空的部分由大脑安排，已填写的选择随需求保留。</p>
    {(['execution','review'] as const).filter(role=>role==='execution'||reviewEnabled).map(role=>{
      const title=role==='execution'?'执行':'审查',pick=value[role]||{},other=value[role==='execution'?'review':'execution']?.agent_id;
      const agents=s.data.agents.filter((a:R)=>!a.archived&&(role!=='review'||a.allowed_kinds?.includes('review')));
      const agent=agents.find((a:R)=>a.id===pick.agent_id),harness=agent&&agentClientKind(agent)==='dsh';
      const groups=s.data.model_catalog.filter((c:R)=>!pick.agent_id||c.agent_id===pick.agent_id);
      const models=new Map<string,string>();
      for(const group of groups)for(const model of group.models||[])models.set(typeof model==='string'?model:model.id,typeof model==='string'?model:model.name);
      const update=(field:'model'|'provider',text:string)=>onChange({...value,[role]:{...pick,[field]:text}});
      return <div className="request-agent-role" key={role}>
        <Field label={title+'者（可选）'}><select aria-label={title+'者（可选）'} value={pick.agent_id||''} onChange={e=>onChange({...value,[role]:e.target.value?{agent_id:e.target.value}:{}})}>
          <option value="">由大脑安排</option>
          {pick.agent_id&&!agent&&<option value={pick.agent_id}>{s.name(pick.agent_id)}（请重新选择）</option>}
          {agents.map((a:R)=><option key={a.id} value={a.id} disabled={a.id===other}>{a.name}</option>)}
        </select></Field>
        <Field label={title+'模型（可选）'}><input aria-label={title+'模型（可选）'} value={pick.model||''} maxLength={100} list={id+'-'+role} placeholder="由大脑安排，也可填写模型" onChange={e=>update('model',e.target.value)}/><datalist id={id+'-'+role}>{[...models].map(([model,name])=><option key={model} value={model}>{name}</option>)}</datalist></Field>
        {harness&&<Field label={title+'供应商（可选）'} hint="使用 Harness 时可指定供应商，留空交给大脑安排。"><input aria-label={title+'供应商（可选）'} value={pick.provider||''} maxLength={100} placeholder="填写供应商名称" onChange={e=>update('provider',e.target.value)}/></Field>}
      </div>;
    })}
  </section>;
}

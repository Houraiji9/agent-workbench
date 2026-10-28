import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert} from './security.ts';
import {agentClientKind} from './agent-client-kind.ts';
import {sameAgent} from './reviewer-resources.ts';

const optionalChoice=z.string().trim().max(100).transform(value=>value||null).nullable().optional();
const choice=z.object({agent_id:optionalChoice,model:optionalChoice,provider:optionalChoice}).strict();
export const requestAgentSelectionSchema=z.object({execution:choice.optional(),review:choice.optional()}).strict();
export function validateRequestAgentSelection(wb:Workbench,value:unknown,reviewMode:string){
 const selection=requestAgentSelectionSchema.parse(value||{});
 if(reviewMode==='not_requested')selection.review={};
 for(const [role,entry] of Object.entries(selection)){
  if(entry.agent_id){const a=wb.get('agents',entry.agent_id);assert(!a.archived,'所选 Agent 已移除，请重新选择');assert(role!=='review'||a.allowed_kinds?.includes('review'),'所选 Agent 不承担独立审查');}
  if(entry.provider)assert(!entry.agent_id||agentClientKind(wb.get('agents',entry.agent_id))==='dsh','供应商只适用于 Harness 客户端');
 }
 if(selection.execution?.agent_id&&selection.review?.agent_id)assert(!sameAgent(wb.get('agents',selection.execution.agent_id),wb.get('agents',selection.review.agent_id)),'执行与独立审查请选择不同 Agent');
 return selection;
}
/** User-selected fields win; omitted fields remain the planner's decision. */
export function applyRequestAgentSelection<T extends Row>(wb:Workbench,request:Row,task:T):T{
 const selections=validateRequestAgentSelection(wb,request.agent_selection,request.review_policy?.mode||'required');
 const next:Row={...task};
 for(const role of ['execution','review'] as const){
  const pick=selections[role];if(!pick||!Object.values(pick).some(Boolean))continue;
  const agentKey=role==='execution'?'agent_id':'reviewer_id',routeKey=role+'_route';
  const oldAgent=next[agentKey];if(pick.agent_id)next[agentKey]=pick.agent_id;
  const agentChanged=oldAgent!==next[agentKey];
  const client=next[agentKey]?agentClientKind(wb.get('agents',next[agentKey])):null;
  if(pick.provider)assert(client==='dsh','所选供应商需要规划者选择 Harness 团队成员');
  let route=next[routeKey];
  if(agentChanged||route&&route.client!==client)route=undefined;
  if(client)route={...route,client,...(pick.model?{model:pick.model}:{}),...(pick.provider?{provider:pick.provider}:{})};
  next[routeKey]=route;
  if(role==='execution'){
   // Another member's task policy must not shadow the new member's project defaults.
   if(agentChanged){next.requested_model=null;delete next.execution_policy;}
   if(pick.model){next.requested_model=pick.model;if(next.execution_policy)next.execution_policy={...next.execution_policy,main_model:pick.model};}
  }
  if(next.model_selection&&(agentChanged||pick.model)){
   const model=pick.model||null,reason='需求预选的成员与模型；留空模型由新成员结合任务选择';
   const current={agent_id:next[agentKey],model,reason,decided_by:'user'};
   next.model_selection=role==='execution'
    ?{...next.model_selection,main:current,...(agentChanged?{children:[]}:{}),fallback_policy:'agent_decides'}
    :{...next.model_selection,review:next[agentKey]?current:null,fallback_policy:'agent_decides'};
  }
 }
 next.agent_selection=selections;
 return next as T;
}

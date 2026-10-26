import {z} from 'zod';
import {DomainError} from './security.ts';

/** Importance is independent of workflow size. These are planner declarations, not a model ranking. */
export const importanceSchema=z.enum(['normal','critical']);
export type Importance=z.infer<typeof importanceSchema>;
const explanation=z.string().trim().min(5).max(2000);
const identifier=z.string().trim().min(1).max(100);
const choiceSchema=z.object({agent_id:identifier,model:identifier.nullable(),reason:explanation}).strict();
const candidateSchema=z.object({
  agent_id:identifier,model:identifier,
  capability_assessment:z.enum(['best_capability','adequate','insufficient','unknown']),
  capability_reason:explanation,
  availability:z.enum(['available','unavailable','unknown']),availability_reason:explanation,
}).strict();
export const modelSelectionSchema=z.object({
  strategy:z.enum(['adequate_economical','best_capability']),
  main:choiceSchema,review:choiceSchema.nullable(),children:z.array(choiceSchema).max(12),
  evaluation:z.object({
    criteria:explanation,catalog_as_of:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    considered:z.array(candidateSchema).max(120),
  }).strict(),
  fallback_policy:z.enum(['agent_decides','stop_and_replan']).default('agent_decides'),upgrade_reason:explanation.optional(),
}).strict();
/** Alias for consumers that group all priority-related schemas together. */
export const prioritySelectionSchema=modelSelectionSchema;
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
/** Stored form: only the user page (userModelSelection) adds decided_by=user; planner plans keep the strict schema above. */
const storedChoiceSchema=choiceSchema.extend({decided_by:z.enum(['planner','user']).optional()}).strict();
export const storedModelSelectionSchema=modelSelectionSchema.extend({
  main:storedChoiceSchema,review:storedChoiceSchema.nullable(),children:z.array(storedChoiceSchema).max(12),
  user_decision:z.object({source:z.literal('user_page'),decided_at:z.string().min(1).max(40),task_revision:z.number().int().positive(),
    previous_main:z.object({agent_id:identifier,model:identifier.nullable()}).nullable(),previous_children:z.array(identifier).max(12),
    previous_assessments:z.array(candidateSchema).max(13).optional()}).strict().optional(),
}).strict();
export type StoredModelSelection=z.infer<typeof storedModelSelectionSchema>;

/** Model choices are optional advice. Saving intent never claims verified access. */
export function userModelSelection(previous:unknown,input:{agent_id:string;model:string|null;child_models:string[];allow_subagents:boolean;revision:number;at:string}):StoredModelSelection|null{
  if(previous==null)return null;
  const base=storedModelSelectionSchema.parse(previous),children=input.allow_subagents?input.child_models:[];
  if(base.main.agent_id===input.agent_id&&base.main.model===input.model&&base.children.length===children.length&&base.children.every(c=>c.agent_id===input.agent_id&&c.model!==null&&children.includes(c.model)))return base;
  const pick=(model:string|null)=>({agent_id:input.agent_id,model,reason:'用户选择的模型建议，由Agent结合客户端能力决定',decided_by:'user' as const});
  const considered=[...base.evaluation.considered];for(const model of [input.model,...children])if(model&&!considered.some(c=>c.agent_id===input.agent_id&&c.model===model))considered.push({agent_id:input.agent_id,model,capability_assessment:'unknown',capability_reason:'用户选择建议，工作台未测评能力',availability:'unknown',availability_reason:'模型建议不代表实际可用性'});
  return {...base,evaluation:{...base.evaluation,considered},main:pick(input.model),children:children.map(pick),fallback_policy:'agent_decides',
    user_decision:{source:'user_page',decided_at:input.at,task_revision:input.revision,
      previous_main:base.user_decision?.previous_main??{agent_id:base.main.agent_id,model:base.main.model},
      previous_children:base.user_decision?.previous_children??base.children.flatMap(c=>c.model?[c.model]:[])}};
}
type Task=Record<string,any>;
type ReviewPolicy={mode?:string}|null|undefined;

function requirePolicy(condition:unknown,message:string):asserts condition {
  if(!condition)throw new DomainError(message,400);
}
/** Importance controls review coverage, never model identity or model availability. */
export function validatePriorityPlan(task:Task,importance:Importance='normal',reviewPolicy:ReviewPolicy=task.review_policy):void {
  if(importanceSchema.parse(importance)==='critical')requirePolicy((reviewPolicy?.mode||'required')==='required','重点需求必须安排完整独立审查，不能使用轻审查或跳过审查');
  if(task.model_selection!=null)storedModelSelectionSchema.parse(task.model_selection);
}

export const modelAdvice='模型、档位和子模型均为可选建议，由Agent按自身客户端规则与任务需要自主选择。无需自报或证明模型身份；未披露记为未知，型号不同不影响接单、交付或审查回传。旧执行单中的模型白名单、冻结型号和停止重规划要求不再生效。';
export function priorityInstructions(task:Task,importance:Importance='normal',role:'execution'|'review'|'delegation'='execution'):string {
  const lines=[importance==='critical'?'需求重要程度：重点。按约定完成独立审查。':'需求重要程度：普通。建议优先经济且胜任的模型。',modelAdvice];
  if(task.model_selection){const s=storedModelSelectionSchema.parse(task.model_selection),choices=role==='review'?(s.review?[s.review]:[]):role==='delegation'?s.children:[s.main];
    for(const c of choices)lines.push('模型建议：'+c.agent_id+' / '+(c.model||'由Agent决定')+'；'+c.reason);
  }
  return lines.join('\n');
}

/** Authorized review arrangement overlays preserve original planner evaluations and unknown live access. */
export function userReviewSelection(previous:unknown,input:{reviewer_id:string;requested_model:string|null;reason:string;decided_by?:'user'|'planner'}){
 if(previous==null)return null;
 const base=storedModelSelectionSchema.parse(previous);
 const review={agent_id:input.reviewer_id,model:input.requested_model,reason:((input.decided_by==='planner'?'审查安排：':'用户授权审查安排：')+input.reason).slice(0,2000),decided_by:input.decided_by||'user' as const};
 const considered=[...base.evaluation.considered];
 if(review.model&&!considered.some(c=>c.agent_id===review.agent_id&&c.model===review.model))considered.push({agent_id:review.agent_id,model:review.model,capability_assessment:'unknown',capability_reason:'用户明确选择审查模型；工作台没有能力排名证据',availability:'unknown',availability_reason:'用户授权选择；可用性未核验；型号信息可不披露'});
 return {...base,review,evaluation:{...base.evaluation,considered}};
}

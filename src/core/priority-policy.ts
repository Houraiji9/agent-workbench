import {z} from 'zod';
import {DomainError} from './security.ts';

/** Importance is independent of workflow size. These are planner declarations, not a model ranking. */
export const importanceSchema=z.enum(['normal','critical']);
export type Importance=z.infer<typeof importanceSchema>;
const explanation=z.string().trim().min(5).max(2000);
const identifier=z.string().trim().min(1).max(100);
const choiceSchema=z.object({agent_id:identifier,model:identifier,reason:explanation}).strict();
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
    considered:z.array(candidateSchema).min(1).max(120),
  }).strict(),
  fallback_policy:z.literal('stop_and_replan'),upgrade_reason:explanation.optional(),
}).strict();
/** Alias for consumers that group all priority-related schemas together. */
export const prioritySelectionSchema=modelSelectionSchema;
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
/** Stored form: only the user page (userModelSelection) adds decided_by=user; planner plans keep the strict schema above. */
const storedChoiceSchema=choiceSchema.extend({decided_by:z.enum(['planner','user']).optional()}).strict();
export const storedModelSelectionSchema=modelSelectionSchema.extend({
  main:storedChoiceSchema,children:z.array(storedChoiceSchema).max(12),
  user_decision:z.object({source:z.literal('user_page'),decided_at:z.string().min(1).max(40),task_revision:z.number().int().positive(),
    previous_main:z.object({agent_id:identifier,model:identifier}).nullable(),previous_children:z.array(identifier).max(12),
    previous_assessments:z.array(candidateSchema).max(13).optional()}).strict().optional(),
}).strict();
export type StoredModelSelection=z.infer<typeof storedModelSelectionSchema>;

/**
 * The user's explicit change of executor, main model or child models replaces the planner's choice in a new
 * selection version. Review choice, strategy and evaluation history stay; availability only states what the
 * catalogue shows, never that the account call was verified.
 * Callers must have validated every chosen model against the current catalogue (validateModel) first: that check,
 * not the planner's older snapshot, is the current resource basis. A planner assessment that marked a chosen model
 * unavailable/unknown is replaced and kept in user_decision.previous_assessments.
 */
export function userModelSelection(previous:unknown,input:{agent_id:string;model:string|null;child_models:string[];allow_subagents:boolean;revision:number;at:string}):StoredModelSelection|null{
  if(previous==null)return null;
  const base=storedModelSelectionSchema.parse(previous);
  requirePolicy(!!input.model,'修改已有模型选择时必须明确主模型，不能交给客户端默认');
  const children=input.allow_subagents?input.child_models:[];
  const same=base.main.agent_id===input.agent_id&&base.main.model===input.model&&base.children.length===children.length&&base.children.every(c=>c.agent_id===input.agent_id&&children.includes(c.model));
  if(same)return base;
  const reason='用户在任务中明确选择，覆盖规划建议';
  const pick=(model:string)=>({agent_id:input.agent_id,model,reason,decided_by:'user' as const});
  const keep=(model:string)=>base.children.find(c=>c.agent_id===input.agent_id&&c.model===model);
  const chosen=[[input.agent_id,input.model!],...children.map(m=>[input.agent_id,m])];
  const current=(agent_id:string,model:string,earlier?:{availability:string;availability_reason:string})=>({agent_id,model,
    capability_assessment:'unknown' as const,capability_reason:'用户直接选择；工作台未对此型号做能力排名',
    availability:'available' as const,availability_reason:`${input.at} 用户选择时工作台模型目录列出且未下线；账号实际访问和使用身份在调用时核验${earlier?`（规划时记录为 ${earlier.availability}：${earlier.availability_reason}）`:''}`.slice(0,2000)});
  const considered=[...base.evaluation.considered],replaced=[...(base.user_decision?.previous_assessments||[])];
  for(const [agent_id,model] of chosen){
    const i=considered.findIndex(c=>c.agent_id===agent_id&&c.model===model);
    if(i<0)considered.push(current(agent_id,model));
    else if(considered[i].availability!=='available'){replaced.push(considered[i]);considered[i]=current(agent_id,model,considered[i]);}
  }
  const mainSame=base.main.agent_id===input.agent_id&&base.main.model===input.model;
  return {...base,main:mainSame?base.main:pick(input.model!),children:children.map(m=>keep(m)||pick(m)),
    evaluation:{...base.evaluation,considered:considered.slice(0,120)},
    user_decision:{source:'user_page',decided_at:input.at,task_revision:input.revision,
      previous_main:base.user_decision?.previous_main??{agent_id:base.main.agent_id,model:base.main.model},
      previous_children:base.user_decision?.previous_children??base.children.map(c=>c.model),
      ...(replaced.length?{previous_assessments:replaced.slice(-13)}:{})}};
}
type Task=Record<string,any>;
type ReviewPolicy={mode?:string}|null|undefined;

function requirePolicy(condition:unknown,message:string):asserts condition {
  if(!condition)throw new DomainError(message,400);
}
const identity=(entry:{agent_id:string;model:string})=>JSON.stringify([entry.agent_id,entry.model]);

/** Validate a frozen selection contract. Current catalogue/quota validation belongs to the caller. */
export function validatePriorityPlan(task:Task,importance:Importance='normal',reviewPolicy:ReviewPolicy=task.review_policy):void {
  const priority=importanceSchema.parse(importance);
  const mode=reviewPolicy?.mode||'required';
  if(priority==='critical') {
    requirePolicy(mode==='required','重点需求必须安排完整独立审查，不能使用轻审查或跳过审查');
    requirePolicy(task.model_selection!=null,'重点需求必须提交完整的明确模型选择与候选评估');
  }
  if(task.model_selection==null)return; // Existing ordinary tasks remain valid without a selection contract.
  const selection=storedModelSelectionSchema.parse(task.model_selection);
  if(priority==='critical')requirePolicy(selection.strategy==='best_capability','重点需求的执行、审查和子代理必须使用规划者明确选定的最佳能力模型');
  if(priority==='normal'&&selection.strategy==='best_capability')requirePolicy(!!selection.upgrade_reason,'普通需求升级最佳能力模型必须说明复杂度或能力升级理由');
  const policy=task.execution_policy||{};
  requirePolicy(selection.main.agent_id===task.agent_id,'主模型选择与任务执行者不一致');
  const mainModels=[task.requested_model,policy.main_model].filter((v):v is string=>typeof v==='string'&&v.trim().length>0);
  requirePolicy(mainModels.length>0,'必须明确任务主模型，禁止依赖客户端默认模型');
  requirePolicy(mainModels.every(model=>model===selection.main.model),'主模型选择与任务或执行策略不一致');
  if(task.execution_route)requirePolicy(task.execution_route.model===selection.main.model,'执行路线必须明确使用所选主模型，禁止隐式回退');

  const needsReview=mode!=='not_requested';
  if(needsReview) {
    requirePolicy(!!selection.review&&!!task.reviewer_id,'模型选择必须明确独立审查者和审查模型');
    requirePolicy(selection.review.agent_id===task.reviewer_id&&task.reviewer_id!==task.agent_id,'审查模型选择与独立审查者不一致');
    if(task.review_route)requirePolicy(task.review_route.model===selection.review.model,'审查路线必须明确使用所选审查模型，禁止隐式回退');
  }else requirePolicy(selection.review===null&&!task.reviewer_id&&!task.review_route,'跳过审查时不能保留审查模型、审查者或审查路线');

  const childModels=policy.child_models||[];
  requirePolicy(Array.isArray(childModels)&&childModels.every((model:unknown)=>typeof model==='string'&&model.trim().length>0),'子模型允许名单格式无效');
  requirePolicy(new Set(childModels).size===childModels.length,'子模型允许名单不能重复');
  requirePolicy(policy.allow_subagents===true||selection.children.length===0,'未授权子代理时不能选择子模型');
  requirePolicy(policy.allow_subagents===true||childModels.length===0,'未授权子代理时不能保留子模型允许名单');
  requirePolicy(policy.allow_subagents!==true||selection.children.length>0,'允许子代理时必须明确子模型选择');
  requirePolicy(selection.children.length===childModels.length&&selection.children.every(child=>child.agent_id===task.agent_id&&childModels.includes(child.model)),'子模型选择必须与执行者及允许名单精确一致');
  requirePolicy(new Set(selection.children.map(identity)).size===selection.children.length,'子模型选择不能重复');

  const candidates=selection.evaluation.considered;
  requirePolicy(new Set(candidates.map(identity)).size===candidates.length,'候选模型评估不能重复或自相矛盾');
  for(const choice of [selection.main,...(selection.review?[selection.review]:[]),...selection.children]) {
    const candidate=candidates.find(item=>identity(item)===identity(choice));
    requirePolicy(candidate,'每个所选模型都必须有对应的能力比较与可用性依据');
    requirePolicy(candidate.availability==='available','所选模型资源不可用或尚未确认；停止并重新规划，禁止隐式降级');
    // The user's own choice is final; it is not graded against the planner's capability declaration.
    if('decided_by' in choice&&choice.decided_by==='user')continue;
    requirePolicy(candidate.capability_assessment==='best_capability'||selection.strategy==='adequate_economical'&&candidate.capability_assessment==='adequate','所选模型能力评估必须符合明确的选择策略；资源不足不能改用较低能力档');
  }
}

/** Instructions report the planner's declared choice without claiming it is objectively strongest. */
export function priorityInstructions(task:Task,importance:Importance='normal',role:'execution'|'review'|'delegation'='execution'):string {
  validatePriorityPlan(task,importance,task.review_policy);
  const critical=importance==='critical';
  const lines=[critical?'需求重要程度：重点（与任务大小无关）。必须执行完整独立审查。':'需求重要程度：普通（与任务大小无关）。优先选择能力足够且经济的模型；复杂任务升级须说明理由。'];
  if(!task.model_selection)return lines.join('\n');
  const selection=storedModelSelectionSchema.parse(task.model_selection);
  const choices=role==='review'?(selection.review?[selection.review]:[]):role==='delegation'?selection.children:[selection.main];
  lines.push(`规划者选择策略：${selection.strategy}。这是明确的规划决策，工作台未用型号排名证明模型客观最强。`);
  for(const choice of choices)lines.push(`明确模型：${choice.agent_id} / ${choice.model}${'decided_by' in choice&&choice.decided_by==='user'?'（用户选择，覆盖规划建议）':''}；选型理由：${choice.reason}`);
  const decision=selection.user_decision;
  if(decision)lines.push(`用户于 ${decision.decided_at} 修改了执行安排（原规划主模型：${decision.previous_main?decision.previous_main.agent_id+' / '+decision.previous_main.model:'未指定'}）。以用户选择为准，不得自行改回、升档或降档。`);
  if(selection.upgrade_reason)lines.push(`普通需求能力升级理由：${selection.upgrade_reason}`);
  lines.push(`能力比较依据：${selection.evaluation.criteria}；模型目录日期：${selection.evaluation.catalog_as_of}。`,
    '只能使用冻结合约明确选择的模型。模型、资源或客户端不可用时停止并回报具体阻碍，重新规划；禁止隐式回退、自动降级或换用默认模型。',
    '每个子代理与审查者都必须遵守同一重要程度及对应模型选择；原生客户端内的模型实际使用情况须如实报告。');
  return lines.join('\n');
}

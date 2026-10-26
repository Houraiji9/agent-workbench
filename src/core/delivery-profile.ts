import crypto from 'node:crypto';
import {z} from 'zod';
import {DomainError} from './security.ts';

const description=z.string().trim().max(4000).default('');
const sha256=z.string().regex(/^[a-f0-9]{64}$/);
const identifier=z.string().trim().min(1).max(200);
export const artifactTypes=['source','software','service','document','media','other'] as const;

/** Project/request settings may omit the details the planning model will supply. */
export const deliveryProfileSchema=z.object({
  schema:z.literal(1),
  artifacts:z.array(z.enum(artifactTypes)).min(1).max(artifactTypes.length),
  artifact_description:description,
  deployment:z.object({
    mode:z.enum(['none','local','remote','other']),
    target:description,
    deploy:description,
    health:description,
    rollback:description,
    verification:z.enum(['none','portable_manifest','executor_reported']),
  }).strict(),
}).strict().superRefine((profile,ctx)=>{
  if(new Set(profile.artifacts).size!==profile.artifacts.length)
    ctx.addIssue({code:'custom',path:['artifacts'],message:'成果类型不能重复'});
  const {mode,verification}=profile.deployment;
  if((mode==='none')!==(verification==='none'))
    ctx.addIssue({code:'custom',path:['deployment','verification'],message:'无部署须使用 none 验证方式；实际部署须明确验证方式'});
  if(verification==='portable_manifest'&&mode!=='local')
    ctx.addIssue({code:'custom',path:['deployment','verification'],message:'便携清单验证仅支持本机部署'});
});

export type DeliveryProfile=z.infer<typeof deliveryProfileSchema>;
type DeliverySettings={delivery_profile?:unknown;delivery_target?:unknown;runtime_root?:unknown};

function fail(message:string):never{throw new DomainError(message,409)}

export function validatePlannedDelivery(input:unknown):DeliveryProfile{
  const profile=deliveryProfileSchema.parse(input);
  if(profile.deployment.mode!=='none')
    for(const key of ['target','deploy','health','rollback'] as const)
      if(!profile.deployment[key])fail('任务计划须补齐部署目标、部署方法、健康检查与回滚说明：'+key);
  return profile;
}

function legacyProfile(settings:DeliverySettings,fallback?:DeliverySettings):DeliveryProfile{
  if(settings.delivery_target==='runtime')return deliveryProfileSchema.parse({schema:1,artifacts:['source','software'],deployment:{
    mode:'local',target:settings.runtime_root||fallback?.runtime_root||'',
    deploy:'按工作台便携安装流程安装当前受审产物',health:'核对当前便携版本、清单与全部受管程序文件',
    rollback:'保留并使用安装前的便携程序备份回滚',verification:'portable_manifest',
  }});
  return deliveryProfileSchema.parse({schema:1,artifacts:['source'],deployment:{mode:'none',verification:'none'}});
}

/** An existing task's legacy choice is its own choice, ahead of new project defaults. */
export function resolveDeliveryProfile(task:DeliverySettings,project?:DeliverySettings):DeliveryProfile{
  if(task.delivery_profile!==undefined&&task.delivery_profile!==null)return deliveryProfileSchema.parse(task.delivery_profile);
  if(task.delivery_target==='source'||task.delivery_target==='runtime')return legacyProfile(task,project);
  if(project?.delivery_profile!==undefined&&project.delivery_profile!==null)return deliveryProfileSchema.parse(project.delivery_profile);
  return legacyProfile(project||{});
}

/** Planning can fill blank methods, but cannot change the user's delivery selection. */
export function assertDeliverySelection(selected:unknown,planned:unknown):DeliveryProfile{
  const before=deliveryProfileSchema.parse(selected),after=validatePlannedDelivery(planned);
  if(JSON.stringify([...before.artifacts].sort())!==JSON.stringify([...after.artifacts].sort())||
    before.deployment.mode!==after.deployment.mode||
    (before.deployment.target!==''&&before.deployment.target!==after.deployment.target)||
    before.deployment.verification!==after.deployment.verification)
    fail('任务计划不能静默改变已选择的成果、部署位置、目标或验证方式');
  if(before.artifact_description&&before.artifact_description!==after.artifact_description)
    fail('任务计划不能静默改写已指定的成果说明');
  for(const key of ['deploy','health','rollback'] as const)
    if(before.deployment[key]&&before.deployment[key]!==after.deployment[key])fail('任务计划不能静默改写已指定的部署说明：'+key);
  return after;
}

/** Hash only a complete frozen task profile; selection order does not change identity. */
export function deliveryProfileDigest(input:unknown):string{
  const profile=validatePlannedDelivery(input),d=profile.deployment;
  return crypto.createHash('sha256').update(JSON.stringify({schema:1,artifacts:[...profile.artifacts].sort(),artifact_description:profile.artifact_description,deployment:{
    mode:d.mode,target:d.target,deploy:d.deploy,health:d.health,rollback:d.rollback,verification:d.verification,
  }})).digest('hex');
}

export const executorVerificationNote='执行者报告；服务端仅核对回执绑定和完整性，未验证实际部署、健康或回滚。';
export const deploymentReceiptInput=z.object({
  run_id:identifier,
  profile_sha256:sha256,
  version:identifier,
  artifact_hashes:z.array(sha256).min(1).max(500),
  review_id:identifier.nullable(),
  review_decision_id:identifier.optional(),
  reported_by:identifier,
  reported_at:z.string().datetime({offset:true}),
  deployment_evidence:z.string().trim().min(1).max(20000),
  health_evidence:z.string().trim().min(1).max(20000),
  rollback_evidence:z.string().trim().min(1).max(20000),
  verification:z.literal('executor_reported'),
}).strict();
export const deploymentReceiptSchema=deploymentReceiptInput.extend({verification_note:z.literal(executorVerificationNote),review_pending:z.boolean().optional()}).strict();
export type DeploymentReceipt=z.infer<typeof deploymentReceiptSchema>;
export type DeploymentReceiptContext={
  run_id:string;
  current_run_id:string;
  agent_id:string;
  profile:unknown;
  version:string;
  artifact_hashes:string[];
  review_id:string|null;
  review_decision_id?:string;
  review_skipped:boolean;
  review_pending?:boolean;
};

function canonicalHashes(input:string[],label:string):string[]{
  const hashes=z.array(sha256).min(1).max(500).parse(input);
  if(new Set(hashes).size!==hashes.length)fail(label+'产物哈希不能重复');
  return [...hashes].sort();
}

function validateReceipt(context:DeploymentReceiptContext,input:unknown){
  const receipt=deploymentReceiptInput.parse(input),profile=validatePlannedDelivery(context.profile);
  if(profile.deployment.mode==='none'||profile.deployment.verification!=='executor_reported')
    fail('无部署或便携清单交付不能使用执行者部署回执');
  if(context.run_id!==context.current_run_id||receipt.run_id!==context.run_id)fail('部署回执必须绑定当前 Run');
  if(receipt.reported_by!==identifier.parse(context.agent_id))fail('部署回执执行者与当前 Run 不匹配');
  if(receipt.profile_sha256!==deliveryProfileDigest(profile))fail('部署目标或完整任务档案已改变');
  if(receipt.version!==identifier.parse(context.version))fail('部署回执版本与当前受审版本不匹配');
  if(context.review_skipped&&context.review_id!==null)fail('免审标记与实际审查绑定冲突');

  if(receipt.review_decision_id!==context.review_decision_id)fail('部署回执与当前审查决定不匹配');
  if(receipt.review_id!==context.review_id)fail('部署回执与当前审查不匹配');
  const expected=canonicalHashes(context.artifact_hashes,'当前受审'),actual=canonicalHashes(receipt.artifact_hashes,'回执');
  if(JSON.stringify(expected)!==JSON.stringify(actual))fail('部署回执须绑定全部当前受审产物');
  return {...receipt,artifact_hashes:actual};
}

/** Does not contact a deployment target or prove it is healthy. */
export function bindDeploymentReceipt(context:DeploymentReceiptContext,input:unknown):DeploymentReceipt{
  return {...validateReceipt(context,input),verification_note:executorVerificationNote,review_pending:!!context.review_pending};
}

/** Recheck a stored receipt at closeout/acceptance against the current frozen Run. */
export function assertDeploymentReceipt(context:DeploymentReceiptContext,input:unknown):DeploymentReceipt{
  const {verification_note,review_pending,...receipt}=deploymentReceiptSchema.parse(input);
  // A receipt recorded before review remains evidence for the same version/artifacts afterwards.
  // Its original review snapshot stays unchanged; it does not claim an approval at deployment time.
  const binding=review_pending?{...context,review_id:receipt.review_id,review_decision_id:receipt.review_decision_id}:context;
  return {...validateReceipt(binding,receipt),verification_note,review_pending:!!review_pending};
}

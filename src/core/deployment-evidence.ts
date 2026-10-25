import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {assert,now} from './security.ts';
import {runTask} from './workflow-policy.ts';
import {reviewSkipped} from './acceptance.ts';
import {resolveDeliveryProfile,deliveryProfileDigest,bindDeploymentReceipt,assertDeploymentReceipt,deploymentReceiptInput,type DeploymentReceiptContext} from './delivery-profile.ts';
import {latestReview} from './latest-review.ts';

export const deploymentContextInput=z.object({run_id:z.string().min(1)}).strict();
export {deploymentReceiptInput};
export function deploymentEvidenceContext(wb:Workbench,r:Row,t:Row):DeploymentReceiptContext{
  const task=runTask(t,r),profile=resolveDeliveryProfile(task,wb.get('projects',t.project_id));
  assert(t.current_run_id===r.id&&['submitted','awaiting_closeout','closing','closeout_blocked','awaiting_confirmation'].includes(t.status),'当前执行不允许读取部署回执上下文',409);
  assert(profile.deployment.verification==='executor_reported','此任务不使用通用部署回执；便携版本请使用正式清单核验',409);
  assert(typeof r.delivery_version==='string'&&r.delivery_version.trim(),'交付报告缺少受审版本；请新Run在submitted时提交delivery_version',409);
  const review=latestReview(wb,r.id),skipped=reviewSkipped(task);
  assert(skipped||review?.verdict==='passed','当前受审交付尚未通过独立审查',409);
  const artifacts=wb.all('artifacts').filter(a=>a.run_id===r.id&&a.current),hashes=artifacts.map(a=>a.sha256).sort();
  assert(hashes.length,'没有当前受审产物',409);
  assert(skipped||JSON.stringify(hashes)===JSON.stringify([...(review?.artifact_hashes||[])].sort()),'部署与审查产物集合不一致',409);
  return {run_id:r.id,current_run_id:t.current_run_id,agent_id:r.agent_id,profile,version:r.delivery_version,artifact_hashes:[...new Set(hashes)],review_id:skipped?null:review!.id,review_skipped:skipped};
}
export function getDeploymentEvidenceContext(wb:Workbench,input:unknown){const v=deploymentContextInput.parse(input),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id),context=deploymentEvidenceContext(wb,r,t);return {...context,profile_sha256:deliveryProfileDigest(context.profile),report_template:{run_id:r.id,profile_sha256:deliveryProfileDigest(context.profile),version:context.version,artifact_hashes:context.artifact_hashes,review_id:context.review_id,reported_by:r.agent_id,reported_at:now(),verification:'executor_reported',deployment_evidence:'填写实际部署及版本结果',health_evidence:'填写实际健康核验结果',rollback_evidence:'填写实际回滚材料及使用方式'}};}
export function reportDeploymentEvidence(wb:Workbench,input:unknown){const v=deploymentReceiptInput.parse(input),r=wb.get('runs',v.run_id),t=wb.get('tasks',r.task_id);assert(t.status!=='awaiting_confirmation','收尾已结束，不能覆盖部署回执',409);const receipt=bindDeploymentReceipt(deploymentEvidenceContext(wb,r,t),v);wb.transaction(()=>{wb.put('runs',{...r,deployment_evidence:receipt},{task_id:t.id});wb.audit('run:'+r.id,'deployment_evidence_reported',t.id,{profile_sha256:receipt.profile_sha256,version:receipt.version,verification:'executor_reported'});});return receipt;}
export function verifyDeploymentEvidence(wb:Workbench,t:Row,r:Row){assert(r.deployment_evidence,'尚未提交与本轮受审版本绑定的部署和运行核验回执',409);return assertDeploymentReceipt(deploymentEvidenceContext(wb,r,t),r.deployment_evidence);}

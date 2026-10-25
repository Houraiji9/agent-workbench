import path from 'node:path';
import type {Workbench} from './workbench.ts';
import type {Row} from './schema.ts';
import {hash,readBounded,safePath} from './security.ts';
import {runTask} from './workflow-policy.ts';
import {resolveDeliveryProfile,assertDeploymentReceipt,type DeliveryProfile} from './delivery-profile.ts';
import {latestReview} from './latest-review.ts';

const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const sorted=(values:string[])=>JSON.stringify([...values].sort());
export type SuccessorEvidence={task_id:string;run_id:string;review_id:string;verification:'portable_manifest'|'executor_reported';manifest_sha256?:string;verified_at?:string;reported_at?:string;version?:string;profile_sha256?:string;artifact_hashes?:string[];verification_note?:string};

function frozenProfile(wb:Workbench,t:Row,r:Row):DeliveryProfile{
  const task=runTask(t,r);
  // Historical portable receipts predate delivery_profile and sometimes delivery_target.
  if(!task.delivery_profile&&r.deployment)return resolveDeliveryProfile({delivery_target:'runtime',runtime_root:r.deployment.runtime_root});
  return resolveDeliveryProfile(task,wb.get('projects',t.project_id));
}
function sameDeployment(before:DeliveryProfile,after:DeliveryProfile){
  const a=before.deployment,b=after.deployment;
  return a.mode!=='none'&&a.mode===b.mode&&a.verification===b.verification&&
    (a.verification==='portable_manifest'?samePath(a.target,b.target):a.target===b.target);
}

/** Only subsequent, independently approved releases with valid deployment evidence qualify.
 * A historical portable release remains eligible only while its reviewed manifest is installed.
 * Executor-reported deployments still require the task's current run.
 * This is evidence lookup, never a rewrite of the earlier review or deployment receipt.
 * The caller must still verify every current runtime file before completing closeout/acceptance.
 */
function successors(wb:Workbench,t:Row,r:Row){
  const original=frozenProfile(wb,t,r);
  if(original.deployment.mode==='none')return [];
  return wb.all('runs').filter(next=>next.id!==r.id&&Date.parse(next.created_at)>Date.parse(r.created_at))
    .sort((a,b)=>b.created_at.localeCompare(a.created_at)).flatMap(next=>{
      try{
        const task=wb.maybe('tasks',next.task_id);
        if(!task||task.project_id!==t.project_id||!['submitted','accepted'].includes(next.status)||!samePath(next.cwd,r.cwd))return [];
        const profile=frozenProfile(wb,task,next);
        if(!sameDeployment(original,profile)||(task.current_run_id!==next.id&&profile.deployment.verification!=='portable_manifest'))return [];
        const review=latestReview(wb,next.id);
        if(!review||review.verdict!=='passed'||!review.reviewer_id||review.reviewer_id===next.agent_id||review.reviewer_id===r.agent_id||!Number.isFinite(Date.parse(review.created_at))||Date.parse(review.created_at)<Date.parse(next.created_at))return [];
        const artifacts=wb.all('artifacts').filter(a=>a.run_id===next.id&&a.current);
        if(!artifacts.length||sorted(artifacts.map(a=>a.sha256))!==sorted(review.artifact_hashes||[]))return [];
        for(const a of artifacts)if(hash(readBounded(safePath(a.archive_path,[path.join(wb.config.dataDir,'artifacts')]),20*1024*1024))!==a.sha256)return [];
        const identity={task_id:task.id,run_id:next.id,review_id:review.id};
        if(profile.deployment.verification==='executor_reported'){
          const receipt=assertDeploymentReceipt({run_id:next.id,current_run_id:task.current_run_id,agent_id:next.agent_id,profile,version:next.delivery_version,artifact_hashes:[...new Set(artifacts.map(a=>a.sha256))],review_id:review.id,review_skipped:false},next.deployment_evidence);
          if(Date.parse(receipt.reported_at)<Date.parse(review.created_at)||Date.parse(receipt.reported_at)>Date.now())return [];
          return [{run:next,evidence:{...identity,verification:'executor_reported',reported_at:receipt.reported_at,version:receipt.version,profile_sha256:receipt.profile_sha256,artifact_hashes:receipt.artifact_hashes,verification_note:receipt.verification_note} as SuccessorEvidence}];
        }
        const deployment=next.deployment,root=r.deployment?.runtime_root||original.deployment.target;
        if(!deployment?.verified||deployment.review_id!==review.id||!samePath(deployment.runtime_root,root)||!samePath(deployment.runtime_root,profile.deployment.target)||!Number.isFinite(Date.parse(deployment.verified_at))||Date.parse(deployment.verified_at)<Date.parse(review.created_at)||Date.parse(deployment.verified_at)>Date.now()||!artifacts.some(a=>a.sha256===deployment.manifest_sha256))return [];
        const runtime=safePath(root,wb.roots(wb.get('projects',t.project_id)));
        if(hash(readBounded(path.join(runtime,'update-manifest.json'),8*1024*1024))!==deployment.manifest_sha256)return [];
        return [{run:next,evidence:{...identity,verification:'portable_manifest',manifest_sha256:deployment.manifest_sha256,verified_at:deployment.verified_at} as SuccessorEvidence}];
      }catch{return [];}
    });
}
export function reviewedSourceSuccessor(wb:Workbench,t:Row,r:Row,file:string,currentHash:string):SuccessorEvidence|null{
  for(const candidate of successors(wb,t,r)){
    if((candidate.run.review_files||[]).some((f:Row)=>samePath(f.path,file)&&f.sha256===currentHash))return candidate.evidence;
  }
  return null;
}
export function deployedSuccessor(wb:Workbench,t:Row,r:Row,currentManifestHash:string):{deployment:Row;evidence:SuccessorEvidence}|null{
  const candidate=successors(wb,t,r).find(c=>c.evidence.verification==='portable_manifest'&&c.evidence.manifest_sha256===currentManifestHash);
  return candidate?{deployment:candidate.run.deployment,evidence:candidate.evidence}:null;
}

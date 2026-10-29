import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {preflightEvidence} from './evidence-preflight.ts';
export const evidencePreflightInput=z.object({task_id:z.string(),artifacts:z.array(z.object({path:z.string(),label:z.string().optional()}).strict()).max(1000).default([]),review_files:z.array(z.string()).max(2000).default([])}).strict();
export function runEvidencePreflight(wb:Workbench,input:unknown){
  const v=evidencePreflightInput.parse(input),t=wb.get('tasks',v.task_id),r=t.current_run_id?wb.get('runs',t.current_run_id):null;
  return preflightEvidence({allowedRoots:t.allowed_paths,protectedRoots:[wb.config.dataDir],protectedExceptions:r?[r.directory]:[],files:[
    ...v.artifacts.map(a=>({...a,kind:'artifact' as const,allowedRoots:[...t.allowed_paths,...(r?[r.directory]:[])]})),
    ...v.review_files.map(path=>({path,kind:'review_file' as const,allowedRoots:t.allowed_paths}))]});
}

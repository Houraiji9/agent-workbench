import {z} from 'zod';
import type {Workbench} from './workbench.ts';
import {reviewAssignmentContext,reviewResultInput,submitReviewResult} from './review-workflow.ts';
/** Short-form report: identity and delivery binding come from the authenticated assignment. */
export const reviewReportInput=reviewResultInput.omit({task_id:true,run_id:true,review_digest:true}).extend({review_digest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export function submitReviewReport(wb:Workbench,input:unknown,actor:string){
 const v=reviewReportInput.parse(input),context=reviewAssignmentContext(wb,v.review_id);
 return submitReviewResult(wb,{...context.report_template,...v,task_id:context.task_id,run_id:context.run_id},actor);
}

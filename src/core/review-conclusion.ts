import {z} from 'zod';

// Keep the shared schema independent of workflow/evidence module evaluation order.
export const reviewConclusion=z.object({
  task_id:z.string(),run_id:z.string(),review_digest:z.string().regex(/^[a-f0-9]{64}$/),
  verdict:z.enum(['passed','changes_requested']),findings:z.array(z.string().max(10000)).max(100),
  limitations:z.array(z.string().max(10000)).max(100),
}).strict();

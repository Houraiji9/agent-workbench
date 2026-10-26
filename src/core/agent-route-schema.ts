import {z} from 'zod';

export const clientKindSchema=z.enum(['dsh','claude','cursor','grok']);
export const agentRouteSchema=z.object({
  client:clientKindSchema,
  model:z.string().trim().min(1).max(100).nullable().optional(),
  provider:z.string().trim().min(1).max(100).optional(),
}).strict();
export const automationPolicySchema=z.object({
  auto_review:z.boolean().default(true),
  auto_rework:z.boolean().default(false),
  continue_after_review:z.boolean().default(true),
  max_rework_rounds:z.number().int().min(1).max(5).default(2),
}).strict();
export const agentDispatchInput=z.object({
  run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),
  request_id:z.string().uuid(),
  expected_revision:z.number().int().positive(),
  fresh_session:z.boolean().optional(),
  instructions:z.string().trim().max(4000).optional(),
  review_id:z.string().regex(/^RA-[a-f0-9-]{36}$/).optional(),
}).strict();
export const agentJobInput=z.object({
  run_id:z.string().regex(/^R-[a-f0-9-]{36}$/),
  job_id:z.string().regex(/^AJ-[a-f0-9-]{36}$/),
  after_revision:z.number().int().min(0).optional(),
  timeout_ms:z.number().int().min(0).max(30000).default(0),
}).strict();
export const agentControlInput=z.object({job_id:z.string().regex(/^AJ-[a-f0-9-]{36}$/),expected_revision:z.number().int().positive(),reason:z.string().trim().min(5).max(2000)}).strict();
export const agentRecoveryInput=agentControlInput.extend({confirmed:z.literal(true)}).strict();
export const mainExecutionControlInput=z.object({expected_revision:z.number().int().positive(),main_execution_control:z.enum(['user','automatic'])}).strict();
export type AgentRoute=z.infer<typeof agentRouteSchema>;

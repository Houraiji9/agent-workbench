import {z} from 'zod';
import {importanceSchema} from './priority-policy.ts';
import {deliveryProfileSchema} from './delivery-profile.ts';

export const projectEditSchema = z.object({
  version: z.number().int().positive(),
  changes: z.object({
    importance: importanceSchema.optional(),
    delivery_profile: deliveryProfileSchema.optional(),
    source_root: z.string().trim().max(1000).nullable().optional(),
    runtime_root: z.string().trim().max(1000).nullable().optional(),
    delivery_target: z.enum(['source','runtime']).optional(),
    workflow_mode: z.enum(['compact','full']).optional(),
    name: z.string().trim().min(1).max(199).optional(),
    goal: z.string().trim().max(5000).optional(),
    stage: z.string().trim().max(200).optional(),
    next_step: z.string().trim().max(2000).optional(),
  }).strict().refine(v=>Object.keys(v).length>0,'请提供至少一项修改'),
}).strict();

export const replySchema = z.object({
  run_id: z.string().min(1),
  question_event_id: z.string().min(1),
  revision: z.number().int().positive(),
  message: z.string().trim().min(1).max(10000),
}).strict();

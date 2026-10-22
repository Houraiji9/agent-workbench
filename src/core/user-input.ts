import {z} from 'zod';

export const projectEditSchema = z.object({
  version: z.number().int().positive(),
  changes: z.object({
    name: z.string().trim().min(1).max(199),
    goal: z.string().trim().max(5000),
    stage: z.string().trim().max(200),
    next_step: z.string().trim().max(2000),
  }).strict(),
}).strict();

export const replySchema = z.object({
  run_id: z.string().min(1),
  question_event_id: z.string().min(1),
  revision: z.number().int().positive(),
  message: z.string().trim().min(1).max(10000),
}).strict();

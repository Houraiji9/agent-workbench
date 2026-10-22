import {z} from 'zod';
export const monthlyPointsSchema=z.object({allowance:z.number().finite().positive().max(1e12),remaining:z.number().finite().min(0).max(1e12).nullable()}).strict().superRefine((m,c)=>{if(m.remaining!==null&&m.remaining>m.allowance)c.addIssue({code:'custom',message:'月度剩余超过每月基础积分'})});

import {z} from 'zod';

const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD').refine(v=>{
  const time=Date.parse(v);return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===v;
},'日期不存在');
export const subscriptionChangesSchema=z.object({
  title:z.string().trim().min(1,'名称不能为空').max(200).optional(),
  note:z.string().max(10000).nullable().optional(),
  end_date:date.nullable().optional(),
  planned_date:date.nullable().optional(),
  amount:z.number().finite().min(0).max(1e9).nullable().optional(),
  currency:z.string().regex(/^[A-Z]{3}$/,'币种请填三个大写字母，例如 USD 或 CNY').nullable().optional(),
  interval:z.enum(['month','year','once']).nullable().optional(),
  auto_renew:z.boolean().nullable().optional(),
  estimated_points:z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  status:z.enum(['user_reported_active','user_reported_expired']).optional(),
}).strict();

export const subscriptionCreateSchema=subscriptionChangesSchema.extend({
  title:z.string().trim().min(1,'名称不能为空').max(200),
  status:z.enum(['planned','user_reported_active','user_reported_expired']),
  account_id:z.string().min(1).max(200).nullable().optional(),
}).strict();
export const subscriptionDeleteSchema=z.object({version:z.number().int().positive()}).strict();

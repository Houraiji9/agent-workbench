// Each window is independent. Missing or contradictory values must never look available.
import {monthlyPercent,type MonthlyPoints} from '../shared/points.js';
export interface QuotaValue { remaining_percent?: number | null; used_percent?: number | null; remaining?: number | null; limit?: number | null; monthly?:MonthlyPoints|null }
const percent = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
export function quotaPercent(w: QuotaValue): number | null {
  if(w.monthly)return monthlyPercent(w);
  if (percent(w.remaining_percent) && percent(w.used_percent) && Math.abs(w.remaining_percent + w.used_percent - 100) > 1) return null;
  if (w.remaining_percent != null) return percent(w.remaining_percent) ? w.remaining_percent : null;
  if (w.used_percent != null) return percent(w.used_percent) ? 100 - w.used_percent : null;
  if (typeof w.remaining === 'number' && Number.isFinite(w.remaining) && typeof w.limit === 'number' && Number.isFinite(w.limit) && w.limit > 0 && w.remaining >= 0 && w.remaining <= w.limit) return w.remaining / w.limit * 100;
  return null;
}

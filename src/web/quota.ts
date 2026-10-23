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

export interface WeeklyQuotaWindow extends QuotaValue {
  kind?: string;
  metric?: string;
  label?: string;
  resets_at?: string | null;
}

/** Remaining weekly quota to use per day before reset; shared windows are never summed. */
export function weeklyQuotaPriority(windows: WeeklyQuotaWindow[], now: number): number {
  return Math.max(0, ...windows.map(w => {
    // Token Monitor labels Grok's weekly window as kind=billing, label=Weekly.
    const weekly = w.kind === 'weekly' || ((!w.kind || w.kind === 'custom' || w.kind === 'billing') && /每周|周额度|周限额|\bweekly\b|\b7[ -]days?\b/i.test(w.label || ''));
    if (!weekly || w.monthly || w.metric === 'currency' || !w.resets_at) return 0;
    const remaining = quotaPercent(w), untilReset = Date.parse(w.resets_at) - now;
    // Low quota (the same 15% threshold as the card) and expired records get no boost.
    if (remaining === null || remaining <= 15 || !Number.isFinite(untilReset) || untilReset <= 0) return 0;
    // A one-day floor prevents a nearly elapsed timer from outweighing available quota.
    return remaining / Math.max(1, untilReset / 86_400_000);
  }));
}

// 时间、金额与数字的中文呈现。未知值一律显示“未知”，不补成 0 或当前时间。
const valid = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function fullDate(v: unknown, tz: string): string {
  if (!valid(v)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v));
}

export function shortDate(v: unknown, tz: string): string {
  if (!valid(v)) return '时间未知';
  const d = new Date(v), now = new Date();
  const sameYear = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(d) === new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(now);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, ...(sameYear ? {} : { year: 'numeric' }), month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** “3 分钟前 / 2 小时后”。超过 7 天回到日期，避免模糊。 */
export function relative(v: unknown, tz: string, nowMs = Date.now()): string {
  if (!valid(v)) return '时间未知';
  const diff = Date.parse(v) - nowMs, abs = Math.abs(diff), future = diff > 0;
  const m = 60000, h = 60 * m, d = 24 * h;
  if (abs < m) return future ? '马上' : '刚刚';
  const say = (n: number, unit: string) => `${n} ${unit}${future ? '后' : '前'}`;
  if (abs < h) return say(Math.round(abs / m), '分钟');
  if (abs < d) return say(Math.round(abs / h), '小时');
  if (abs < 7 * d) return say(Math.round(abs / d), '天');
  return shortDate(v, tz);
}

/** 只有日期精度的计划（YYYY-MM-DD）：按显示时区的“今天”计算还剩几天。 */
export function daysUntil(date: unknown, tz: string, nowMs = Date.now()): number | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(nowMs));
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
}

export function dayCountText(n: number | null): string {
  if (n === null) return '日期未知';
  if (n === 0) return '就是今天';
  if (n === 1) return '明天';
  if (n > 0) return `还有 ${n} 天`;
  return `已过 ${-n} 天，请核对`;
}

export function plainDay(date: unknown, nowMs = Date.now()): string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '日期未知';
  const [y, m, d] = date.split('-').map(Number);
  return y === new Date(nowMs).getFullYear() ? `${m} 月 ${d} 日` : `${y} 年 ${m} 月 ${d} 日`;
}

export const num = (n: number, digits = 1) => n.toLocaleString('zh-CN', { maximumFractionDigits: digits });

/** 大数字：7590 万。仅用于展示，不参与计算。 */
export function bigNumber(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '未知';
  if (Math.abs(n) >= 1e8) return num(n / 1e8, 2) + ' 亿';
  if (Math.abs(n) >= 1e4) return num(n / 1e4, 1) + ' 万';
  return num(n, 0);
}

const symbols: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', JPY: '¥', GBP: '£', HKD: 'HK$' };
const intervals: Record<string, string> = { month: ' / 月', year: ' / 年', once: '（一次性）' };

export function money(amount: unknown, currency: unknown, interval?: unknown): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '金额未知';
  const c = typeof currency === 'string' ? currency : '';
  const s = symbols[c];
  const body = s ? `${s}${amount.toLocaleString('zh-CN', { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}` : `${num(amount, 2)} ${c || '（币种未知）'}`;
  return body + (typeof interval === 'string' ? intervals[interval] || '' : '');
}

/** 订阅价格：用户记录用 amount；Token Monitor 记录用 amount_minor（最小货币单位）。 */
export function subscriptionPrice(s: Record<string, any>): string {
  if (typeof s.amount === 'number') return money(s.amount, s.currency, s.interval);
  if (typeof s.amount_minor === 'number') return money(s.amount_minor / 100, s.currency, s.interval);
  return '金额未知';
}

export function bytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return num(n / 1024) + ' KB';
  return num(n / 1024 / 1024) + ' MB';
}

export function greeting(tz: string, nowMs = Date.now()): string {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date(nowMs))) % 24;
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export function todayLine(tz: string, nowMs = Date.now()): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(nowMs));
}

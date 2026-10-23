import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weeklyQuotaPriority, type WeeklyQuotaWindow} from '../src/web/quota.ts';

const now = Date.parse('2026-10-23T12:00:00Z');
const week = (remaining: number, days: number): WeeklyQuotaWindow => ({kind:'weekly', remaining_percent:remaining, resets_at:new Date(now + days * 86_400_000).toISOString()});
const priority = (...windows: WeeklyQuotaWindow[]) => weeklyQuotaPriority(windows, now);

test('同一天重置时余量多的优先；同余量时重置早的优先', () => {
  assert(priority(week(80, 1)) > priority(week(20, 1)));
  assert(priority(week(80, 1)) > priority(week(80, 5)));
});

test('综合余量与时间：后重置但余量充足可以超过快重置但余量少的', () => {
  assert(priority(week(80, 2)) > priority(week(20, 0.25)));
  assert(priority(week(80, 5)) > priority(week(1, 1 / 24)));
  for (const remaining of [0, 1, 15]) assert.equal(priority(week(remaining, 0.001)), 0);
  assert(priority(week(16, 1)) > 0);
});

test('不足一天按一天判断，临近最后几分钟不会压过余量更多的卡片', () => {
  assert(priority(week(90, 0.9)) > priority(week(20, 1 / 1440)));
});

test('过期、缺日期、非法日期和非法余量均不获得优先权', () => {
  for (const resets_at of [null, '', 'invalid', new Date(now).toISOString(), new Date(now - 1).toISOString()]) {
    assert.equal(priority({...week(80, 1), resets_at}), 0);
  }
  for (const remaining_percent of [null, -1, 101, NaN, Infinity]) assert.equal(priority({...week(80, 1), remaining_percent}), 0);
  assert.equal(priority({...week(80, 1), used_percent:80}), 0);
});

test('只评估周额度；余额、月度积分、短时额度均不混入', () => {
  for (const kind of ['session', 'daily']) assert.equal(priority({...week(100, 1), kind, label:'每周'}), 0);
  assert.equal(priority({...week(100, 1), kind:'billing', label:'Monthly'}), 0);
  assert.equal(priority({...week(100, 1), metric:'currency'}), 0);
  assert.equal(priority({...week(100, 1), monthly:{allowance:500, remaining:500}}), 0);
  assert.equal(priority({...week(100, 1), kind:'custom', label:'总剩余积分'}), 0);
});

test('自定义或旧记录的明确周标签可参与，但不根据重置天数猜周期', () => {
  for (const label of ['每周', '周额度', '周限额', 'Gemini weekly', '7-day', '7 days']) {
    assert(priority({...week(80, 1), kind:'custom', label}) > 0);
    assert(priority({...week(80, 1), kind:undefined, label}) > 0);
  }
  assert.equal(priority({...week(80, 7), kind:undefined}), 0);
  assert.equal(priority({...week(80, 1), kind:'billing', label:'Weekly'}), priority(week(80, 1)));
});

test('共享窗口取最需使用的一项，不重复相加；输入记录保留原样', () => {
  const windows = [week(80, 2), week(90, 5)], before = structuredClone(windows);
  assert.equal(priority(...windows, ...windows), priority(windows[0]));
  assert.deepEqual(windows, before);
  assert.equal(priority(), 0);
});

test('剩余额度可从使用比例或已知总量获得，并在时间推进后重新判断', () => {
  assert.equal(priority({...week(80, 1), remaining_percent:undefined, used_percent:20}), priority(week(80, 1)));
  assert.equal(priority({...week(80, 1), remaining_percent:undefined, remaining:400, limit:500}), priority(week(80, 1)));
  assert.equal(weeklyQuotaPriority([week(80, 1)], now + 86_400_000), 0);
});

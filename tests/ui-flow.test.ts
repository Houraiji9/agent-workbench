// 新界面的“接力”翻译与时间呈现：只是展示层，但必须与后台状态语义一致，不能把未知或计划说成事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import { relayOf, isYourTurn, isTheirTurn, byUrgency, folderSuggestions, statusText, reviewSkippedTask } from '../src/web/lib/flow.ts';
import { relative, daysUntil, dayCountText, money, subscriptionPrice, bigNumber } from '../src/web/lib/format.ts';
import { parseHash, routeHash } from '../src/web/app/store.tsx';

const name = (id: string) => ({ codex: 'Codex', zcode: 'Zcode', 'grok-build': 'Grok Build', claude: 'Claude' } as Record<string, string>)[id] || id;
const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'T-x', status, agent_id: 'zcode', reviewer_id: 'grok-build', review_policy: { mode: 'required' }, ...extra });

test('每个后台状态都映射到明确的一棒、持棒人和下一步', () => {
  const all = ['ready', 'awaiting_dispatch', 'dispatched', 'running', 'waiting_input', 'blocked', 'failed', 'submitted', 'changes_requested', 'in_review', 'awaiting_confirmation', 'accepted', 'cancelled','awaiting_closeout','closing','closeout_waiting_input','closeout_blocked'];
  for (const s of all) {
    const r = relayOf(task(s), name);
    assert.ok(statusText[s], s + ' 有中文名称');
    assert.ok(r.headline.length > 3 && r.next.length > 3, s + ' 有现在/下一步说明');
    assert.equal(r.legs.length, 7);
  }
  assert.equal(relayOf(task('awaiting_dispatch'), name).at, 2);
  assert.equal(relayOf(task('awaiting_dispatch'), name).holder, 'you');
  assert.equal(relayOf(task('running'), name).holder, 'agent');
  assert.equal(relayOf(task('submitted', {review_stage:'running'}), name).holder, 'reviewer');
  assert.equal(relayOf(task('in_review'), name).at, 5);
  assert.equal(relayOf(task('accepted'), name).at, 7);
  assert.equal(relayOf(task('cancelled'), name).at, -1);
});

test('改派后接力线显示当前执行者，而不是原计划执行者', () => {
  const r = relayOf(task('running'), name, 'codex');
  assert.equal(r.legs[3].who, 'Codex');
  assert.match(r.headline, /Codex/);
});

test('用户明确不审查：交付后由执行者收尾，完成后轮到用户；规划者单方面置空审查者不算', () => {
  const skip = task('awaiting_confirmation', { reviewer_id: null, review_policy: { mode: 'not_requested', source: 'user_requested' } });
  assert.equal(reviewSkippedTask(skip), true);
  assert.equal(relayOf(skip, name).legs[4].who, '本次不审查');
  assert.equal(isYourTurn(skip), true);
  const closeout={...skip,status:'awaiting_closeout',closeout_delivery:'agent'};
  assert.equal(relayOf(closeout,name).next,'Zcode 交付后继续完成剩余事项');
  assert.equal(isTheirTurn(closeout),true);
  assert.equal(isYourTurn(closeout),false);
  assert.equal(relayOf(task('awaiting_closeout',{closeout_delivery:'agent'}),name).next,'Zcode 收到审查结果后继续完成剩余事项');
  const forged = task('submitted', { reviewer_id: null, review_policy: { mode: 'not_requested', source: 'planner' } });
  assert.equal(reviewSkippedTask(forged), false);
  assert.equal(isYourTurn(forged), true);
  assert.equal(isTheirTurn(forged), false);
});

test('轮到你 / 正在处理 互不重叠，结束的任务不出现在任何一边', () => {
  for (const s of Object.keys(statusText)) {
    const t = task(s);
    assert.ok(!(isYourTurn(t) && isTheirTurn(t)), s + ' 不能同时出现在两边');
    if (['accepted', 'cancelled'].includes(s)) assert.ok(!isYourTurn(t) && !isTheirTurn(t));
  }
  const sorted = [task('ready'), task('waiting_input'), task('blocked')].sort(byUrgency).map(t => t.status);
  assert.deepEqual(sorted, ['waiting_input', 'blocked', 'ready']);
});

test('文件夹建议只来自真实会话目录，排除已登记项目，不猜测路径', () => {
  const sessions = [
    { agent: 'codex', source_cwd: 'E:\\项目\\记账APP', updated_at: '2026-10-20T01:00:00Z', source_project: '记账APP' },
    { agent: 'zcode', source_cwd: 'E:\\项目\\记账APP\\', updated_at: '2026-10-21T01:00:00Z' },
    { agent: 'codex', source_cwd: 'C:\\Projects\\Workbench', updated_at: '2026-10-21T02:00:00Z' },
    { agent: 'codex', source_cwd: null },
    { agent: 'codex', source_cwd: 'relative\\path' },
    { agent: 'codex', source_cwd: 'C:\\' },
  ];
  const r = folderSuggestions(sessions, [{ paths: ['C:\\Projects\\Workbench'] }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].path, 'E:\\项目\\记账APP');
  assert.equal(r[0].count, 2);
  assert.deepEqual(r[0].agents.sort(), ['codex', 'zcode']);
  assert.equal(r[0].name, '记账APP');
});

test('时间与金额：未知就说未知，计划日期按天计算', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(relative(null, 'UTC', now), '时间未知');
  assert.equal(relative('2026-10-21T11:00:00Z', 'UTC', now), '1 小时前');
  assert.equal(relative('2026-10-21T15:00:00Z', 'UTC', now), '3 小时后');
  assert.equal(daysUntil('2026-12-17', 'UTC', now), 57);
  assert.equal(daysUntil('2026-10-20', 'UTC', now), -1);
  assert.equal(daysUntil(null, 'UTC', now), null);
  assert.equal(dayCountText(-1), '已过 1 天，请核对');
  assert.equal(money(null, 'USD'), '金额未知');
  assert.equal(money(30, 'USD', 'month'), '$30 / 月');
  assert.equal(subscriptionPrice({ amount_minor: 82000, currency: 'CNY', interval: 'month' }), '¥820 / 月');
  assert.equal(subscriptionPrice({}), '金额未知');
  assert.equal(bigNumber(75900683), '7,590.1 万');
  assert.equal(bigNumber(undefined), '未知');
});

test('页面地址：刷新后仍回到同一页面、页签和任务', () => {
  const r = { page: 'projects', id: 'P-1', tab: 'files', task: 'T-9' };
  assert.deepEqual(parseHash(routeHash(r)), r);
  assert.deepEqual(parseHash(routeHash({ page: 'resources', tab: 'plans' })), { page: 'resources', id: undefined, tab: 'plans', task: undefined });
  assert.equal(parseHash('#/unknown').page, 'today');
  assert.equal(parseHash('').page, 'today');
});

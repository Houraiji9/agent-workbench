import { test, expect, type Page } from '@playwright/test';
import { api, shot, noHorizontalScroll } from './support.ts';

async function openPlans(page: Page) {
  await page.goto('/#/resources?tab=plans');
  await expect(page.getByRole('heading', { name: '接下来的安排' })).toBeVisible();
}
const planItem = (page: Page, text: string) => page.locator('.plan-line li').filter({ hasText: text });

test('编辑订阅计划：金额和周期保存，刷新后保留；计划仍是计划，没有变成购买', async ({ page }) => {
  const { get } = await api(page);
  await openPlans(page);
  await planItem(page, '测试计划A').getByRole('button', { name: '编辑计划' }).click();
  const d = page.getByRole('dialog', { name: '编辑订阅计划' });
  await expect(d.getByText('记录订阅信息和接下来的安排。')).toBeVisible();
  await d.getByLabel('金额').fill('21.5');
  await d.getByLabel('计费周期').selectOption('year');
  await d.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(planItem(page, '测试计划A')).toContainText('$21.50 / 年');
  const sub = (await get('/state')).subscriptions.find((s: any) => s.id === 'test-plan-price');
  expect(sub.status).toBe('planned');
  expect(sub.confirmed_at).toBeNull();
  expect((await get('/state')).subscriptions.filter((s: any) => s.plan_id === 'test-plan-price')).toHaveLength(0);
});

test('打开的表单冻结版本：别处先改了，旧表单保存会被拦下，不覆盖新内容', async ({ page }) => {
  const { post, get } = await api(page);
  await openPlans(page);
  await planItem(page, '测试计划B').getByRole('button', { name: '编辑计划' }).click();
  const d = page.getByRole('dialog', { name: '编辑订阅计划' });
  const current = (await get('/state')).subscriptions.find((s: any) => s.id === 'test-plan-shared');
  await post('/baseline/subscriptions/test-plan-shared', { version: current.version, changes: { note: '别处更新的备注' } });
  await d.getByLabel('备注').fill('旧表单想写的备注');
  await d.getByRole('button', { name: '保存' }).click();
  await expect(d.getByRole('alert')).toContainText('版本冲突');
  const after = (await get('/state')).subscriptions.find((s: any) => s.id === 'test-plan-shared');
  expect(after.note).toBe('别处更新的备注');
});

test('记录“已经发生”：取消不留记录；填写后计划与实际分开保存', async ({ page }) => {
  const { get } = await api(page);
  await openPlans(page);
  const item = planItem(page, '测试计划C');
  await item.getByRole('button', { name: '记录已发生' }).click();
  const d = page.getByRole('dialog', { name: '记录：这件事已经发生' });
  await expect(d.getByText('填写实际发生时间和确认依据。')).toBeVisible();
  await d.getByRole('button', { name: '取消' }).click();
  expect((await get('/state')).subscriptions.filter((s: any) => s.plan_id === 'test-plan-codex')).toHaveLength(0);
  await item.getByRole('button', { name: '记录已发生' }).click();
  await page.getByRole('dialog', { name: '记录：这件事已经发生' }).getByLabel('你是怎么核实的').fill('测试：在账号页面看到已生效');
  await page.getByRole('dialog', { name: '记录：这件事已经发生' }).getByRole('button', { name: '记录' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(planItem(page, '测试计划C')).toContainText('已记录发生');
  const subs = (await get('/state')).subscriptions;
  expect(subs.find((s: any) => s.id === 'test-plan-codex').status).toBe('planned');
  expect(subs.filter((s: any) => s.plan_id === 'test-plan-codex')).toHaveLength(1);
});

test('额度窗口逐个显示：0%、100%、未知、陈旧各自如实呈现，计划中的共享池不算可用', async ({ page }) => {
  const now = new Date().toISOString();
  const pools = [
    { id: 'TM-a', name: '测试 A', status: 'ok', source: 'token_monitor', freshness: 'fresh', source_updated_at: now, balance: null },
    { id: 'TM-b', name: '测试 B', status: 'ok', source: 'token_monitor', freshness: 'fresh', source_updated_at: now, balance: { amount: 12.5, currency: 'CNY' } },
    { id: 'TM-old', name: '测试旧记录', status: 'ok', source: 'token_monitor', freshness: 'stale', source_updated_at: now },
    { id: 'TM-nc', name: '测试未配置', status: 'notConfigured', source: 'token_monitor', freshness: 'fresh', source_updated_at: now },
  ];
  const windows = [
    { id: 'w1', pool_id: 'TM-a', label: '5-hour', remaining_percent: 0, used_percent: 100, resets_at: new Date(Date.now() + 3600e3).toISOString() },
    { id: 'w2', pool_id: 'TM-a', label: 'Weekly', remaining_percent: 100, used_percent: 0, resets_at: null },
    { id: 'w3', pool_id: 'TM-b', label: 'Monthly', remaining_percent: null, used_percent: null, remaining: 5, unit: 'unknown' },
    { id: 'w5', pool_id: 'TM-b', label: 'Weekly', remaining_percent: null, used_percent: null, remaining: null },
    { id: 'w4', pool_id: 'TM-old', label: 'Weekly', remaining_percent: 40, used_percent: 60 },
  ];
  const patch = async (route: any) => { const r = await route.fetch(); const j = await r.json(); j.quota_pools = [...j.quota_pools.filter((p: any) => p.source !== 'token_monitor'), ...pools]; j.quota_windows = windows; j.integrations = j.integrations.map((i: any) => i.id === 'tokenMonitor' ? { ...i, status: 'connected', last_success: now } : i); await route.fulfill({ response: r, json: j }); };
  await page.route('**/api/bootstrap', patch);
  await page.route('**/api/state', patch);
  await page.goto('/#/resources');
  await expect(page.getByRole('progressbar', { name: '测试 A 5 小时 剩余额度' })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('progressbar', { name: '测试 A 每周 剩余额度' })).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('progressbar', { name: '测试 B 每月 剩余额度' })).toHaveCount(0); // 只有剩余数值、没有总额：不画进度条
  await expect(page.getByRole('article', { name: '测试 B 额度' })).toContainText('单位未知，余额记录');
  await expect(page.getByRole('progressbar', { name: '测试 B 每周 剩余额度' })).toHaveAttribute('aria-valuetext', '未知');
  await expect(page.getByText('12.5 CNY')).toBeVisible();
  await expect(page.getByRole('article', { name: '测试旧记录 额度' })).toBeHidden();
  await page.getByText(/较早的记录（1）/).click();
  await expect(page.getByRole('article', { name: '测试旧记录 额度' })).toContainText('上次记录');
  await page.getByText(/还没在 Token Monitor 里配置的工具（1）/).click();
  await expect(page.getByText('测试未配置。配置后这里会显示它们的额度。')).toBeVisible();
  await expect(page.getByText('计划中的共享额度（不算进可用额度）')).toHaveCount(0);
  await expect(page.getByText(/X 共享额度池（计划）/)).toHaveCount(0);
  await shot(page, '新版-额度窗口');
  await page.setViewportSize({ width: 430, height: 900 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('region', { name: '额度概况' }).getByText('测试 A')).toHaveCount(2);
});

test('额度全部过期时：显示一天内的上次记录并明确说明不是实时，而不是“没有数据”', async ({ page }) => {
  const recent = new Date(Date.now() - 15 * 60000).toISOString(), ancient = new Date(Date.now() - 3 * 86400000).toISOString();
  const pools = [
    { id: 'TM-r', name: '测试近期', status: 'ok', source: 'token_monitor', freshness: 'stale', source_updated_at: recent },
    { id: 'TM-o', name: '测试很旧', status: 'ok', source: 'token_monitor', freshness: 'stale', source_updated_at: ancient },
  ];
  const windows = [
    { id: 'r1', pool_id: 'TM-r', label: 'Weekly', remaining_percent: 30, used_percent: 70 },
    { id: 'o1', pool_id: 'TM-o', label: 'Weekly', remaining_percent: 80, used_percent: 20 },
  ];
  const patch = async (route: any) => { const r = await route.fetch(); const j = await r.json(); j.quota_pools = [...j.quota_pools.filter((p: any) => p.source !== 'token_monitor'), ...pools]; j.quota_windows = windows; j.integrations = j.integrations.map((i: any) => i.id === 'tokenMonitor' ? { ...i, status: 'connected', last_success: new Date().toISOString() } : i); await route.fulfill({ response: r, json: j }); };
  await page.route('**/api/bootstrap', patch);
  await page.route('**/api/state', patch);
  await page.goto('/');
  const glance = page.getByRole('region', { name: '额度概况' });
  await expect(glance.getByText('测试近期')).toBeVisible();
  await expect(glance.getByText('测试很旧')).toHaveCount(0);
  await expect(glance).toContainText('上次记录');
  await page.goto('/#/resources');
  await expect(page.getByText(/上次更新于.*等待 Token Monitor 刷新/)).toBeVisible();
  await expect(page.getByRole('article', { name: '测试近期 额度' })).toContainText('上次记录');
  await expect(page.getByRole('article', { name: '测试很旧 额度' })).toBeHidden();
  await expect(page.getByText(/较早的记录（1）/)).toBeVisible();
});

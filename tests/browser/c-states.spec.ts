import { test, expect } from '@playwright/test';
import { makeTask, drawer, nav, shot } from './support.ts';

test('用户不安排审查：交付后直接待你试用，没有“登记审查”，也不生成审查记录', async ({ page }) => {
  const m = await makeTask(page, { title: '不审查测试', skipReview: true, agent: 'claude', stage: 'submitted' });
  expect((await m.get('/tasks/' + m.tid)).task.status).toBe('awaiting_confirmation');
  await page.goto('/');
  const card = page.getByRole('article', { name: '不审查测试' });
  await expect(card.getByText('已交付，待你试用')).toBeVisible();
  await card.getByRole('button', { name: '去试用确认' }).click();
  const d = drawer(page);
  await expect(d.getByText('审查：本次不安排')).toBeVisible();
  await expect(d.getByRole('list', { name: '任务进度' })).toContainText('本次不审查');
  await expect(d.getByText('本次审查：未安排。')).toBeVisible();
  await d.getByRole('button', { name: '更多信息与操作' }).click();
  await expect(d.getByRole('button', { name: '登记审查结果' })).toHaveCount(0);
  await d.getByRole('button', { name: '试用后确认完成' }).click();
  const dlg = page.getByRole('dialog', { name: '试用后确认完成' });
  await dlg.getByLabel('我能看懂测试结果').check();
  await dlg.getByLabel('结果符合测试需求').check();
  await dlg.getByRole('button', { name: '确认结果符合需求' }).click();
  await expect(d.getByText('已完成').first()).toBeVisible();
  const after = await m.get('/tasks/' + m.tid);
  expect(after.reviews).toHaveLength(0);
  expect(after.task.acceptance_record.review_id).toBeNull();
  expect(after.task.acceptance_record.review_policy.mode).toBe('not_requested');
});

test('Agent 提问：保存回答、修改、刷新仍在；恢复执行后历史回答保留', async ({ page }) => {
  const m = await makeTask(page, { title: '提问测试', stage: 'running' });
  await m.report('waiting_input', { message: '测试问题：按钮用蓝色还是绿色？' });
  await page.goto('/');
  await page.getByRole('article', { name: '提问测试' }).getByRole('button', { name: '去回答' }).click();
  const d = drawer(page);
  await expect(d.getByRole('region', { name: '现在要做什么' }).getByText('测试问题：按钮用蓝色还是绿色？')).toBeVisible();
  await d.getByLabel('你的回答').fill('用蓝色');
  await d.getByRole('button', { name: '保存并复制回答' }).click();
  await expect(d.getByText(/已保存/)).toBeVisible();
  await expect(d.getByRole('button', { name: '再复制一次' })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('我的回答：用蓝色');
  expect(clip).toContain('回报 started 恢复');
  await d.getByLabel('你的回答').fill('用蓝色，深一点');
  await d.getByRole('button', { name: '保存修改并复制' }).click();
  await expect(d.getByRole('button', { name: '再复制一次' })).toBeVisible();
  await page.reload();
  await expect(drawer(page).getByLabel('你的回答')).toHaveValue('用蓝色，深一点');
  expect((await m.get('/tasks/' + m.tid)).task.status).toBe('waiting_input'); // 保存回答不等于恢复执行
  await m.report('started', { message: '收到回答，继续' });
  await expect(drawer(page).getByText('正在执行').first()).toBeVisible();
  const detail = await m.get('/tasks/' + m.tid);
  expect(detail.reply_history[0].message).toBe('用蓝色，深一点');
  expect(detail.reply_history[0].history[0].message).toBe('用蓝色');
});

test('改派：新开一次执行交给其他成员，原记录保留；团队页按当前执行者归属', async ({ page }) => {
  const m = await makeTask(page, { title: '改派测试', stage: 'running' });
  await m.report('failed', { message: '测试：这次没做完' });
  await page.goto('/#/today?task=' + m.tid);
  const d = drawer(page);
  await expect(d.getByText('测试：这次没做完').first()).toBeVisible();
  await d.getByRole('region', { name: '现在要做什么' }).getByRole('button', { name: '换人或重新做一次' }).click();
  const dlg = page.getByRole('dialog', { name: '换人或重新做一次' });
  await expect(dlg.getByText('Grok Build')).toHaveCount(0); // 审查者不能改派成执行者
  await dlg.getByText('Zcode', { exact: true }).click();
  await dlg.getByRole('button', { name: '新开一次并复制执行单' }).click();
  await expect(page.getByRole('dialog', { name: '换人或重新做一次' })).toHaveCount(0);
  await expect(d.getByText('执行：Zcode')).toBeVisible();
  await expect(d.getByText('（原计划 Codex）')).toBeVisible();
  const detail = await m.get('/tasks/' + m.tid);
  expect(detail.runs).toHaveLength(2);
  await d.getByRole('button', { name: '更多信息与操作' }).click();
  await expect(d.getByText('当前这次')).toBeVisible();
  await expect(d.getByText('之前', { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await nav(page, '团队');
  await page.getByRole('listitem', { name: 'Zcode' }).click();
  await expect(page.getByRole('complementary', { name: 'Zcode 详情' }).getByText('改派测试', { exact: true })).toBeVisible();
  await page.getByRole('listitem', { name: 'Codex' }).click();
  await expect(page.getByRole('complementary', { name: 'Codex 详情' }).getByText('改派测试', { exact: true })).toHaveCount(0);
});

test('取消任务需要确认；取消后记录保留，显示为已取消', async ({ page }) => {
  const m = await makeTask(page, { title: '取消测试', stage: 'order' });
  await page.goto('/#/today?task=' + m.tid);
  const d = drawer(page);
  await d.getByRole('button', { name: '更多信息与操作' }).click();
  await d.getByRole('button', { name: '取消这项任务' }).click();
  await page.getByRole('dialog', { name: '取消这项任务？' }).getByRole('button', { name: '不取消' }).click();
  expect((await m.get('/tasks/' + m.tid)).task.status).toBe('awaiting_dispatch');
  await d.getByRole('button', { name: '取消这项任务' }).click();
  await page.getByRole('button', { name: '确认取消任务' }).click();
  await expect(d.getByText('这项任务已取消')).toBeVisible();
  expect((await m.get('/tasks/' + m.tid)).runs).toHaveLength(1);
});

test('旧版验收记录：不把技术条目显示为你已确认，并明确说明', async ({ page }) => {
  const m = await makeTask(page, { title: '旧协议验收测试', stage: 'reviewed', userAcceptance: null });
  const t = (await m.get('/tasks/' + m.tid)).task;
  await m.post('/tasks/' + m.tid + '/accept', { revision: t.revision, checks: [true] });
  await page.goto('/#/today?task=' + m.tid);
  const d = drawer(page);
  await expect(d.getByText('旧版验收记录。')).toBeVisible();
  await expect(d.locator('.check-list li.ok')).toHaveCount(0);
});

test('审查要求修改：旧的通过审查不能套用到新交付', async ({ page }) => {
  const m = await makeTask(page, { title: '返工测试', stage: 'submitted' });
  const d0 = await m.get('/tasks/' + m.tid);
  await m.post('/reviews', { run_id: m.rid, reviewer_id: 'grok-build', performed: true, verdict: 'changes_requested', evidence: '测试夹具：模拟审查要求修改', findings: '测试意见：标题太小', artifact_hashes: d0.artifacts.map((a: any) => a.sha256) });
  await page.goto('/#/today?task=' + m.tid);
  const d = drawer(page);
  await expect(d.getByText('审查要求修改').first()).toBeVisible();
  await expect(d.getByText('测试意见：标题太小').first()).toBeVisible();
  await d.getByRole('region', { name: '现在要做什么' }).getByRole('button', { name: '复制修改意见给执行者' }).click();
  await expect.poll(async () => (await m.get('/tasks/' + m.tid)).task.current_run_id).not.toBe(m.rid);
  await expect(d.getByText('历史交付')).toBeVisible();
  await shot(page, '新版-返工后的审查标注');
});

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskInput } from '../helpers.ts';
import { api, drawer, shot } from './support.ts';

test('完整闭环：粘贴计划 → 生成执行单 → 确认已发出 → 回执推进 → 查看成果 → 登记审查 → 试用确认', async ({ page }) => {
  const { post, get, root: base } = await api(page);
  const root = path.join(base, '闭环-' + randomUUID().slice(0, 6)); fs.mkdirSync(root, { recursive: true });
  const project = await post('/projects', { name: '闭环测试项目', path: root });
  const req = await post('/requests', { project_id: project.id, text: '测试：完整界面闭环' });
  await page.goto('/');
  const reqCard = page.getByRole('article', { name: '测试：完整界面闭环' });
  await reqCard.getByRole('button', { name: '粘贴 Codex 的计划' }).click();
  const planDialog = page.getByRole('dialog', { name: '粘贴 Codex 的计划' });
  await planDialog.getByLabel('计划内容（JSON）').fill('这不是 JSON');
  await planDialog.getByRole('button', { name: '导入计划' }).click();
  await expect(planDialog.getByRole('alert')).toContainText('不是完整的 JSON');
  await planDialog.getByLabel('计划内容（JSON）').fill(JSON.stringify({ schema_version: 1, plan_id: 'browser-loop-' + randomUUID(), request_id: req.id, expected_version: 1, tasks: [{ ...taskInput(root), title: '闭环测试交付', user_acceptance: ['我能打开测试成果', '结果符合测试需求'] }] }));
  await planDialog.getByRole('button', { name: '导入计划' }).click();
  await expect(page.getByRole('dialog', { name: '粘贴 Codex 的计划' })).toHaveCount(0);

  const card = page.getByRole('article', { name: '闭环测试交付' });
  await expect(card.getByText('待生成执行单')).toBeVisible();
  await card.getByRole('button', { name: '生成并复制执行单' }).click();
  await expect(card.getByText('待交给执行者')).toBeVisible();
  const state = await get('/state');
  const task = state.tasks.find((t: any) => t.title === '闭环测试交付');
  const run = state.runs.find((r: any) => r.id === task.current_run_id);
  expect(fs.existsSync(run.order_path)).toBe(true);
  expect(task.status).toBe('awaiting_dispatch'); // 复制不等于已派发

  await card.getByRole('button', { name: '详情' }).count().then(n => expect(n).toBe(0));
  await card.getByRole('button', { name: '闭环测试交付' }).click();
  const d = drawer(page);
  await expect(d.getByRole('list', { name: '任务进度' }).locator('[aria-current="step"]')).toContainText('交给执行者');
  await d.getByRole('button', { name: '我已经发给它' }).click();
  await expect(d.getByText('已发出，待接单')).toBeVisible();
  await expect(d.getByRole('list', { name: '任务进度' }).locator('[aria-current="step"]')).toContainText('执行');

  let seq = 0;
  const receipt = async (type: string, extra: Record<string, unknown> = {}) => {
    if (!(await d.getByRole('button', { name: '导入回执' }).isVisible())) await d.getByRole('button', { name: '更多信息与操作' }).click();
    await d.getByRole('button', { name: '导入回执' }).click();
    const r = page.getByRole('dialog', { name: '导入回执' });
    await r.getByLabel('回执内容（JSON）').fill(JSON.stringify({ schema_version: 1, event_id: 'browser-' + randomUUID(), task_id: task.id, run_id: task.current_run_id, task_version: 1, seq: ++seq, event_type: type, occurred_at: new Date().toISOString(), data: { identity: 'codex', cwd: root, message: '测试回执：' + type, ...(type === 'submitted' ? { result: '## 完成内容\n浏览器测试专用结果：隔离数据，不构成真实审查或验收证据。\n\n- 第一项\n- 第二项' } : {}), ...extra } }));
    await r.getByRole('button', { name: '导入回执' }).click();
    await expect(page.getByRole('dialog', { name: '导入回执' })).toHaveCount(0);
  };
  await receipt('started');
  await expect(d.getByText('正在执行').first()).toBeVisible();
  await receipt('blocked', { message: '测试：缺少一个授权' });
  await expect(d.getByText('遇到阻碍').first()).toBeVisible();
  await expect(d.getByText('测试：缺少一个授权').first()).toBeVisible();
  await receipt('started');
  await receipt('submitted');
  await expect(d.getByText('已交付，待审查').first()).toBeVisible();
  await expect(d.getByRole('button', { name: '复制审查请求' })).toBeVisible();

  await d.getByRole('button', { name: /RESULT\.md/ }).click();
  const viewer = page.getByRole('dialog', { name: 'RESULT.md' });
  await expect(viewer.getByRole('heading', { name: '完成内容' })).toBeVisible();
  await expect(viewer.getByText('第一项')).toBeVisible();
  await viewer.getByRole('button', { name: '显示原文' }).click();
  await expect(viewer.getByText('## 完成内容')).toBeVisible();
  await viewer.getByRole('button', { name: '关闭' }).first().click();

  const now = d.getByRole('region', { name: '现在要做什么' });
  await now.getByRole('button', { name: '登记审查结果' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '登记审查结果' })).toHaveCount(0);
  await expect(d).toBeVisible();
  await now.getByRole('button', { name: '登记审查结果' }).click();
  const rv = page.getByRole('dialog', { name: '登记审查结果' });
  await rv.getByText('通过', { exact: true }).click();
  await rv.getByLabel('审查依据').fill('测试夹具：模拟审查结果，仅验证登记界面。');
  await rv.getByLabel('我已完成本次审查').check();
  const reviewReq = page.waitForRequest(r => r.url().endsWith('/api/reviews') && r.method() === 'POST');
  await rv.getByRole('button', { name: '登记结果' }).click();
  const reviewPayload = (await reviewReq).postDataJSON();
  expect(reviewPayload.reviewer_id).toBe('grok-build');
  const saved = await get('/tasks/' + task.id);
  expect([...reviewPayload.artifact_hashes].sort()).toEqual(saved.artifacts.map((a: any) => a.sha256).sort());
  await expect(d.getByText('审查通过，待你确认').first()).toBeVisible();

  await d.getByRole('button', { name: '试用后确认完成' }).click();
  const ok = page.getByRole('dialog', { name: '试用后确认完成' });
  await expect(ok.getByRole('checkbox')).toHaveCount(2);
  await expect(ok.getByText('真实测试通过', { exact: true })).toHaveCount(0); // 技术检查项不出现在确认里
  await expect(ok.getByRole('button', { name: '确认结果符合需求' })).toBeDisabled();
  await ok.getByRole('button', { name: '稍后再说' }).click();
  expect((await get('/tasks/' + task.id)).task.status).toBe('in_review');
  await d.getByRole('button', { name: '试用后确认完成' }).click();
  await shot(page, '新版-试用确认');
  await page.getByRole('dialog', { name: '试用后确认完成' }).getByLabel('我能打开测试成果').check();
  await page.getByRole('dialog', { name: '试用后确认完成' }).getByLabel('结果符合测试需求').check();
  const acceptReq = page.waitForRequest(r => r.url().endsWith('/accept') && r.method() === 'POST');
  await page.getByRole('button', { name: '确认结果符合需求' }).click();
  const payload = (await acceptReq).postDataJSON();
  expect(payload.mode).toBe('user_experience');
  expect(payload.user_checks).toEqual([true, true]);
  expect(payload.checks).toBeUndefined();
  expect([...payload.artifact_hashes].sort()).toEqual([...reviewPayload.artifact_hashes].sort());
  await expect(d.getByText('已完成').first()).toBeVisible();
  await expect(d.getByText('你确认完成')).toBeVisible();
  await shot(page, '新版-任务完成');
  await page.reload();
  await expect(drawer(page).getByText('已完成').first()).toBeVisible();
});

test('作者回执不能直接把任务设为完成；非法转换被拒绝但留档', async ({ page }) => {
  const { post, get, root: base } = await api(page);
  const root = path.join(base, '越权-' + randomUUID().slice(0, 6)); fs.mkdirSync(root, { recursive: true });
  const project = await post('/projects', { name: '越权测试', path: root });
  const q = await post('/requests', { project_id: project.id, text: '测试：越权回执' });
  const plan = await post('/plans', { schema_version: 1, plan_id: 'p-' + randomUUID(), request_id: q.id, expected_version: 1, tasks: [{ ...taskInput(root), title: '越权测试任务' }] });
  const tid = plan.task_ids[0];
  const order = await post('/tasks/' + tid + '/export', { version: 1 });
  await page.goto('/#/today?task=' + tid);
  const d = drawer(page);
  await d.getByRole('button', { name: '更多信息与操作' }).click();
  await d.getByRole('button', { name: '导入回执' }).click();
  const r = page.getByRole('dialog', { name: '导入回执' });
  await r.getByLabel('回执内容（JSON）').fill(JSON.stringify({ schema_version: 1, event_id: 'bad-' + randomUUID(), task_id: tid, run_id: order.run_id, task_version: 1, seq: 1, event_type: 'accepted', occurred_at: new Date().toISOString(), data: { identity: 'codex', cwd: root } }));
  await r.getByRole('button', { name: '导入回执' }).click();
  await expect(r.getByRole('alert')).toContainText('schema');
  await r.getByLabel('回执内容（JSON）').fill(JSON.stringify({ schema_version: 1, event_id: 'bad2-' + randomUUID(), task_id: tid, run_id: order.run_id, task_version: 1, seq: 1, event_type: 'submitted', occurred_at: new Date().toISOString(), data: { identity: 'codex', cwd: root, result: '测试：未开始就交付，应该被拒绝的非法转换' } }));
  await r.getByRole('button', { name: '导入回执' }).click();
  await expect(r.getByRole('alert')).toContainText('没有改变状态');
  expect((await get('/tasks/' + tid)).task.status).toBe('awaiting_dispatch');
});

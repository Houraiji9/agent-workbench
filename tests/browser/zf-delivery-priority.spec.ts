import { test, expect, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { api } from './support.ts';

async function makeProject(ctx: Awaited<ReturnType<typeof api>>, label: string) {
  const name = label + '-' + randomUUID().slice(0, 8);
  const projectPath = path.join(ctx.root, name);
  fs.mkdirSync(projectPath, { recursive: true });
  return ctx.post('/projects', { name, path: projectPath });
}
async function chooseProject(dialog: Locator, name: string) {
  await dialog.getByRole('combobox', { name: '属于哪个项目' }).click();
  await dialog.getByLabel('搜索项目').fill(name);
  await dialog.locator('.project-options').getByRole('option', { name: new RegExp(name) }).click();
}
const remoteProfile = () => ({
  schema: 1, artifacts: ['source', 'service'], artifact_description: '需要保留的自定义成果说明',
  deployment: { mode: 'remote', target: '隔离远程环境', deploy: '需要保留的安装说明', health: '需要保留的检查说明', rollback: '需要保留的恢复说明', verification: 'executor_reported' },
});

test('默认表单紧凑，重点聊天规划保存重开后仍完整独审', async ({ page }, testInfo) => {
  const ctx = await api(page), project = await makeProject(ctx, '紧凑需求'), profile = remoteProfile();
  await ctx.post('/projects/' + project.id + '/edit', { version: project.version, changes: { name: project.name, goal: '', stage: '', next_step: '', importance: 'critical', delivery_profile: profile } });
  await page.goto('/#/requests');
  await page.getByRole('button', { name: '提需求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提一个需求' });
  await chooseProject(dialog, project.name);
  await expect(dialog.getByRole('combobox')).toHaveCount(2);
  await expect(dialog.locator('textarea:visible')).toHaveCount(1);
  await expect(dialog.getByLabel('规划方式')).not.toBeVisible();
  await expect(dialog.getByLabel('交付后在哪里使用')).not.toBeVisible();
  await expect(dialog.getByLabel('成果补充说明（可选）')).not.toBeVisible();
  await expect(dialog.getByLabel('期望结果')).not.toBeVisible();
  await expect(dialog.getByLabel('需求重要程度')).toHaveValue('critical');
  await expect(dialog.getByText('使用当前最佳能力，固定完整独立审查。')).toBeVisible();
  await expect(dialog.locator('.delivery-brief')).toHaveText('项目交付：源码、服务或接口 · 部署到远程环境（隔离远程环境）');
  await expect(dialog.locator('.delivery-brief')).not.toContainText('需要保留');
  const text = '重点聊天规划仍完整独审 ' + project.id;
  await dialog.getByLabel('你想完成什么？').fill(text);
  await page.screenshot({ path: testInfo.outputPath('compact-request.png'), animations: 'disabled' });
  await dialog.getByText('修改交付', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '服务或接口', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('交付后在哪里使用')).toHaveValue('remote');
  await dialog.getByText('修改交付', { exact: true }).click();
  await dialog.locator('summary').filter({ hasText: '规划与审查' }).click();
  await dialog.getByLabel('规划方式').selectOption('small');
  await expect(dialog.getByLabel('交付后的审查')).toHaveCount(0);
  await dialog.getByRole('button', { name: '先记下来', exact: true }).click();
  let request = (await ctx.get('/state')).requests.find((q: any) => q.text === text);
  expect(request).toMatchObject({ workflow_kind: 'small', importance: 'critical', delivery_profile: profile, review_policy: null });
  await page.getByRole('article', { name: text }).getByRole('button', { name: '继续编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑需求' });
  await expect(edit.getByLabel('规划方式')).toBeVisible();
  await expect(edit.getByLabel('规划方式')).toHaveValue('small');
  await edit.getByLabel('需求重要程度').selectOption('normal');
  await edit.getByLabel('交付后的审查').selectOption('not_requested');
  await expect(edit.getByLabel('不安排审查的原因')).toBeVisible();
  await edit.getByLabel('需求重要程度').selectOption('critical');
  await expect(edit.getByLabel('交付后的审查')).toHaveCount(0);
  await expect(edit.getByLabel('不安排审查的原因')).toHaveCount(0);
  await edit.getByRole('button', { name: '保存，稍后再做', exact: true }).click();
  request = (await ctx.get('/state')).requests.find((q: any) => q.id === request.id);
  expect(request).toMatchObject({ importance: 'critical', workflow_kind: 'small', delivery_profile: profile, review_policy: null });
});

test('已有自定义交付不被项目默认覆盖，跨项目隔离，展开编辑保存重开完整保留', async ({ page }, testInfo) => {
  const ctx = await api(page), first = await makeProject(ctx, '自定义交付'), second = await makeProject(ctx, '另一项目默认');
  const text = '保存已有自定义交付 ' + first.id, custom = remoteProfile();
  const request = await ctx.post('/requests', { project_id: first.id, text, status: 'draft', importance: 'normal', workflow_kind: 'small', delivery_profile: custom, desired_output: '旧期望结果', success_criteria: '旧完成标准', review_mode: 'light', review_focus: ['核对交互与回填'], review_note: '保留已有自定义审查' });
  await page.goto('/#/requests?tab=drafts');
  await page.getByRole('article', { name: text }).getByRole('button', { name: '继续编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑需求' });
  await expect(edit.locator('.delivery-brief')).toContainText('本需求交付：源码、服务或接口');
  await expect(edit.getByLabel('有限审查范围（每行一项）')).toBeVisible();
  await expect(edit.getByLabel('有限审查范围（每行一项）')).toHaveValue('核对交互与回填');
  await expect(edit.getByLabel('期望结果')).toHaveValue('旧期望结果');
  await chooseProject(edit, second.name);
  await expect(edit.locator('.delivery-brief')).toHaveText('项目交付：源码 · 不需要部署');
  await expect(edit.getByLabel('需求重要程度')).toHaveValue('normal');
  await expect(edit.getByLabel('交付后的审查')).toHaveValue('required');
  await chooseProject(edit, first.name);
  await expect(edit.getByLabel('交付后的审查')).toHaveValue('light');
  await edit.getByText('修改交付', { exact: true }).click();
  await expect(edit.getByLabel('使用位置补充说明（可选）')).toHaveValue(custom.deployment.target);
  await edit.getByText('成果与使用说明（可选）', { exact: true }).click();
  await expect(edit.getByLabel('部署或安装方式（可选）')).toHaveValue(custom.deployment.deploy);
  await edit.getByLabel('成果补充说明（可选）').fill('本次修改的成果说明');
  await edit.getByLabel('怎样确认运行正常（可选）').fill('本次修改的运行检查');
  await edit.getByRole('button', { name: '保存，稍后再做', exact: true }).click();
  const expected = { ...custom, artifact_description: '本次修改的成果说明', deployment: { ...custom.deployment, health: '本次修改的运行检查' } };
  const stored = (await ctx.get('/state')).requests.find((q: any) => q.id === request.id);
  expect(stored).toMatchObject({ project_id: first.id, delivery_profile: expected, review_policy: { mode: 'light', focus: ['核对交互与回填'], note: '保留已有自定义审查' }, desired_output: '旧期望结果', success_criteria: '旧完成标准' });
  await page.getByRole('article', { name: text }).getByRole('button', { name: '继续编辑' }).click();
  await expect(edit.getByLabel('有限审查范围（每行一项）')).toBeVisible();
  await edit.getByText('修改交付', { exact: true }).click();
  await edit.getByText('成果与使用说明（可选）', { exact: true }).click();
  await expect(edit.getByLabel('成果补充说明（可选）')).toHaveValue(expected.artifact_description);
  await expect(edit.getByLabel('怎样确认运行正常（可选）')).toHaveValue(expected.deployment.health);
  await page.screenshot({ path: testInfo.outputPath('custom-request-reopened.png'), fullPage: true, animations: 'disabled' });
});

test('收起的审查条件会展开并说明错误，已保存免审原因编辑可见', async ({ page }) => {
  const ctx = await api(page), project = await makeProject(ctx, '审查条件提示');
  await page.goto('/#/requests');
  await page.getByRole('button', { name: '提需求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提一个需求' });
  await chooseProject(dialog, project.name);
  const text = '隐藏条件不能静默卡提交 ' + project.id;
  await dialog.getByLabel('你想完成什么？').fill(text);
  const planning = dialog.locator('summary').filter({ hasText: '规划与审查' });
  await planning.click();
  await dialog.getByLabel('交付后的审查').selectOption('light');
  await planning.click();
  await dialog.getByRole('button', { name: '先记下来', exact: true }).click();
  await expect(dialog.getByLabel('有限审查范围（每行一项）')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('1–12 项');
  await dialog.getByLabel('交付后的审查').selectOption('not_requested');
  await planning.click();
  await dialog.getByRole('button', { name: '现在开始', exact: true }).click();
  await expect(dialog.getByLabel('不安排审查的原因')).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText('至少 5 个字');
  expect((await ctx.get('/state')).requests.some((q: any) => q.text === text)).toBe(false);
  await dialog.getByRole('button', { name: '先记下来', exact: true }).click();
  await page.getByRole('article', { name: text }).getByRole('button', { name: '继续编辑' }).click();
  const edit = page.getByRole('dialog', { name: '编辑需求' });
  await expect(edit.getByLabel('不安排审查的原因')).toBeVisible();
  await edit.getByLabel('不安排审查的原因').fill('这次由我自己试用确认');
  await edit.getByRole('button', { name: '现在开始', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '下一步：发给 Codex' })).toBeVisible();
  expect((await ctx.get('/state')).requests.find((q: any) => q.text === text)).toMatchObject({ status: 'awaiting_planning', review_policy: { mode: 'not_requested', note: '这次由我自己试用确认' } });
});

test('便携项目远程目标编辑不污染本机目标，保存重开保留核验和运行目录', async ({ page }, testInfo) => {
  const ctx = await api(page), project = await makeProject(ctx, '便携目标往返');
  const runtimeRoot = path.join(project.paths[0], 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const profile = { schema: 1, artifacts: ['source', 'software'], artifact_description: '隔离测试用便携软件', deployment: { mode: 'local', target: runtimeRoot, deploy: '测试安装说明', health: '测试运行检查', rollback: '测试恢复说明', verification: 'portable_manifest' } };
  await ctx.post('/projects/' + project.id + '/edit', { version: project.version, changes: { name: project.name, goal: '', stage: '', next_step: '', source_root: project.paths[0], runtime_root: runtimeRoot, workflow_mode: 'compact', importance: 'normal', delivery_profile: profile } });
  await page.goto('/#/projects/' + project.id);
  await page.getByRole('button', { name: '编辑资料' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目资料' });
  await expect(dialog.getByLabel('交付后在哪里使用')).not.toBeVisible();
  await expect(dialog.getByLabel('需求重要程度')).toBeVisible();
  await expect(dialog.locator('.delivery-brief')).toContainText(runtimeRoot);
  await page.screenshot({ path: testInfo.outputPath('compact-project.png'), animations: 'disabled' });
  await dialog.getByText('修改默认交付', { exact: true }).click();
  const mode = dialog.getByLabel('交付后在哪里使用');
  await expect(mode).toHaveValue('local');
  await expect(dialog.getByLabel('本机运行目录')).toHaveValue(runtimeRoot);
  await mode.selectOption('remote');
  await expect(dialog.getByLabel('本机运行目录')).toHaveCount(0);
  await dialog.getByLabel('使用位置补充说明（可选）').fill('只用于测试的远程目标');
  await mode.selectOption('local');
  await expect(dialog.getByLabel('本机运行目录')).toHaveValue(runtimeRoot);
  await mode.selectOption('remote');
  await expect(dialog.getByLabel('使用位置补充说明（可选）')).toHaveValue('只用于测试的远程目标');
  await mode.selectOption('local');
  await dialog.getByText('成果与使用说明（可选）', { exact: true }).click();
  await dialog.getByLabel('成果补充说明（可选）').fill('更新后的便携成果说明');
  await dialog.getByText('修改默认交付', { exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const stored = (await ctx.get('/state')).projects.find((p: any) => p.id === project.id);
  expect(stored.runtime_root).toBe(runtimeRoot);
  expect(stored.delivery_profile).toEqual({ ...profile, artifact_description: '更新后的便携成果说明' });
  await page.getByRole('button', { name: '编辑资料' }).click();
  await dialog.getByText('修改默认交付', { exact: true }).click();
  await expect(dialog.getByLabel('交付后在哪里使用')).toHaveValue('local');
  await expect(dialog.getByLabel('本机运行目录')).toHaveValue(runtimeRoot);
  await dialog.getByText('成果与使用说明（可选）', { exact: true }).click();
  await expect(dialog.getByLabel('成果补充说明（可选）')).toHaveValue('更新后的便携成果说明');
});

test('便携运行目录必填校验展开分组，不会在收起时静默卡住保存', async ({ page }) => {
  const ctx = await api(page), project = await makeProject(ctx, '便携校验展开');
  const runtimeRoot = path.join(project.paths[0], 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  await ctx.post('/projects/' + project.id + '/edit', { version: project.version, changes: { name: project.name, goal: '', stage: '', next_step: '', runtime_root: runtimeRoot, delivery_profile: { schema: 1, artifacts: ['software'], artifact_description: '', deployment: { mode: 'local', target: runtimeRoot, deploy: '', health: '', rollback: '', verification: 'portable_manifest' } } } });
  await page.goto('/#/projects/' + project.id);
  await page.getByRole('button', { name: '编辑资料' }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目资料' });
  await dialog.getByText('修改默认交付', { exact: true }).click();
  await dialog.getByLabel('本机运行目录').fill('');
  await dialog.getByText('修改默认交付', { exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByLabel('本机运行目录')).toBeVisible();
  await expect(dialog.getByLabel('本机运行目录')).toBeFocused();
  expect((await ctx.get('/state')).projects.find((p: any) => p.id === project.id).runtime_root).toBe(runtimeRoot);
});

test('需求中的便携位置清空后收起也能展开校验，不写入无效需求', async ({ page }) => {
  const ctx = await api(page), project = await makeProject(ctx, '需求便携校验');
  const runtimeRoot = path.join(project.paths[0], 'runtime'); fs.mkdirSync(runtimeRoot, { recursive: true });
  await ctx.post('/projects/' + project.id + '/edit', { version: project.version, changes: { name: project.name, goal: '', stage: '', next_step: '', runtime_root: runtimeRoot, delivery_profile: { schema: 1, artifacts: ['software'], artifact_description: '', deployment: { mode: 'local', target: runtimeRoot, deploy: '', health: '', rollback: '', verification: 'portable_manifest' } } } });
  await page.goto('/#/requests'); await page.getByRole('button', { name: '提需求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提一个需求' }), text = '需求便携校验 ' + project.id;
  await chooseProject(dialog, project.name); await dialog.getByLabel('你想完成什么？').fill(text);
  await dialog.getByText('修改交付', { exact: true }).click(); await dialog.getByLabel('本机运行目录').fill('');
  await dialog.getByText('修改交付', { exact: true }).click(); await dialog.getByRole('button', { name: '现在开始', exact: true }).click();
  await expect(dialog.getByLabel('本机运行目录')).toBeVisible(); await expect(dialog.getByLabel('本机运行目录')).toBeFocused();
  expect((await ctx.get('/state')).requests.some((q: any) => q.text === text)).toBe(false);
});

import fs from 'node:fs';
import path from 'node:path';
import {test, expect, type Page, type Locator} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {api, makeTask, drawer, shot, noHorizontalScroll} from './support.ts';

// 任务和回执通过隔离后台创建；只过滤页面快照，避免别的测试任务挤满截图。
async function showTasks(page: Page, ids: string[], edit?: (state: any) => void) {
  const filter = async (route: any) => {
    const response = await route.fetch(), state = await response.json();
    state.tasks = state.tasks.filter((t: any) => ids.includes(t.id));
    state.requests = [];
    edit?.(state);
    await route.fulfill({response, json: state});
  };
  await page.route('**/api/bootstrap', filter);
  await page.route('**/api/state', filter);
}
const active = (page: Page) => page.getByRole('region', {name: '正在由 Agent 处理'});
async function loadedIcon(row: Locator) {
  const img = row.locator('.agent-icon img');
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
  await expect(row.locator('.avatar')).toHaveCount(0);
  return img.getAttribute('src');
}

test('执行中的两个项目有独立项目标签、软件图标，明暗宽窄窗口不挤压且能打开详情', async ({page}) => {
  const a = await makeTask(page, {title: '测试：整理工作台的任务信息', stage: 'running'});
  const b = await makeTask(page, {title: '测试：海外项目_' + '长期计划与执行效果追踪'.repeat(7), stage: 'running', agent: 'zcode'});
  await showTasks(page, [a.tid, b.tid]);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#/today');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', {name: '切换到深色外观'}).click();
    for (const width of [900, 1440, 1920, 480]) {
      await page.setViewportSize({width, height: 1000});
      for (const t of [a, b]) {
        const row = active(page).getByRole('button').filter({hasText: t.title});
        await loadedIcon(row);
        await expect(row.locator('.active-project')).toHaveText(t.project.name);
        await expect(row.locator('.active-project')).toHaveAttribute('title', t.project.name);
        const layout = await row.evaluate(el => {
          const main = el.querySelector('.row-main')!.getBoundingClientRect(), side = el.querySelector('.row-side')!.getBoundingClientRect();
          const title = el.querySelector('strong')!;
          return {separate: main.right <= side.left + 1 || main.bottom <= side.top + 1, titleHeight: title.clientHeight, line: parseFloat(getComputedStyle(title).lineHeight)};
        });
        expect(layout.separate).toBe(true);
        expect(layout.titleHeight).toBeLessThanOrEqual(layout.line * 2 + 2);
      }
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, `执行任务-隔离测试-${theme}-${width}`);
    }
  }
  await page.setViewportSize({width: 900, height: 1000});
  await active(page).getByRole('button').filter({hasText: a.title}).click();
  await expect(drawer(page).getByRole('heading', {level: 1})).toHaveText(a.title);
  await expect(drawer(page).locator('.crumb')).toHaveText(a.project.name);
  await loadedIcon(drawer(page).locator('.task-people > span').filter({hasText: '执行：'}));
  await loadedIcon(drawer(page).locator('.task-people > span').filter({hasText: '审查：'}));
  await drawer(page).getByRole('button', {name: '再复制一次执行单'}).click();
  expect((await a.get('/tasks/' + a.tid)).task.status).toBe('running');
  await drawer(page).locator('.crumb').click();
  await expect(page).toHaveURL(new RegExp(a.project.id));
  await expect(drawer(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('改派使用当前 Run 的图标与名字，审查者接单后切换为 Grok 审查图标', async ({page}) => {
  const t = await makeTask(page, {title: '测试：当前执行者与审查接力', stage: 'order'});
  let d = await t.get('/tasks/' + t.tid);
  await t.post('/tasks/' + t.tid + '/action', {action: 'cancel', revision: d.task.revision});
  d = await t.get('/tasks/' + t.tid);
  const order = await t.post('/tasks/' + t.tid + '/export', {version: 1, new_run: true, agent_id: 'zcode', expected_revision: d.task.revision});
  await t.report('started', {identity: 'zcode'});
  await showTasks(page, [t.tid]); await page.goto('/#/today');
  const row = active(page).getByRole('button').filter({hasText: t.title});
  const zcode = await loadedIcon(row);
  await expect(row).toContainText('Zcode 正在做');
  await row.click();
  const executor = drawer(page).locator('.task-people > span').filter({hasText: '执行：'});
  await expect(executor).toContainText('执行：Zcode（原计划 Codex）');
  expect(await loadedIcon(executor)).toBe(zcode);
  const grok = await loadedIcon(drawer(page).locator('.task-people > span').filter({hasText: '审查：'}));
  await page.keyboard.press('Escape');
  await t.report('submitted', {identity: 'zcode'});
  await expect(row).toHaveCount(0);
  const h=await api(page),before=await t.get('/tasks/'+t.tid);const review=await t.post('/review-orders',{run_id:order.run_id,reviewer_id:'grok-build',expected_revision:before.task.revision,reason:'测试手动转发审查'});
  const token=JSON.parse(fs.readFileSync(path.join(h.root,'data/review-keys',review.review_id+'.json'),'utf8')).token;const response=await fetch('http://127.0.0.1:14318/api/mcp/report_review_started',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({review_id:review.review_id,identity:'grok-build'})});expect(response.ok).toBe(true);
  await expect(row).toContainText('Grok Build 正在独立审查');
  await expect(row.locator('.pill')).toHaveText('审查中');
  await expect(row.locator('.agent-icon img')).toHaveAttribute('src', grok!);
  expect(grok).not.toBe(zcode);
  d = await t.get('/tasks/' + t.tid);
  expect(d.task.current_run_id).toBe(order.run_id);
  expect(d.task.agent_id).toBe('codex');
  expect(d.task.status).toBe('submitted');
  expect(d.reviews).toHaveLength(0);
  await shot(page, '执行任务-隔离测试-审查接力');
  await row.click();await expect(drawer(page).locator('.task-people .pill').first()).toHaveText('审查中');await page.keyboard.press('Escape');
  await page.goto('/#/projects/'+t.project.id);
  await expect(page.getByRole('region',{name:'执行顺序'}).getByRole('article',{name:t.title}).locator('.pill')).toHaveText('审查中');
  await page.getByRole('tab',{name:'关系图'}).click();await expect(page.locator('.graph-node')).toContainText('审查中');
});

test('自定义成员沿用品牌设置和预设映射；未知品牌、图片加载失败仍显示可读身份', async ({page}) => {
  const h = await api(page);
  const input = {version: 0, name: '测试 Cline ' + randomUUID().slice(0, 5), preset_id: 'cline', scope: '隔离测试工程', restriction: '', model: null, icon_key: 'cline', allowed_kinds: ['engineering'], models: []};
  const custom = await h.post('/agents', input);
  const unknown = await h.post('/agents', {...input, name: '测试自定义助理', preset_id: null, icon_key: 'auto'});
  const a = await makeTask(page, {title: '测试：自定义品牌映射', agent: custom.id, stage: 'running'});
  const b = await makeTask(page, {title: '测试：未知品牌兜底', agent: unknown.id, stage: 'running'});
  const c = await makeTask(page, {title: '测试：图片加载失败', stage: 'running'});
  let legacy = false;
  await showTasks(page, [a.tid, b.tid, c.tid], state => {
    // 兼容只有 preset_id、没有 icon_key 的旧页面资料；正式成员数据保持原样。
    if (legacy) delete state.agents.find((x: any) => x.id === custom.id).icon_key;
  });
  await page.goto('/#/today');
  const row = active(page).getByRole('button').filter({hasText: a.title});
  const src = await loadedIcon(row);
  await expect(row).toContainText(custom.name + ' 正在做');
  legacy = true; await page.reload();
  expect(await loadedIcon(row)).toBe(src);
  await row.click();
  expect(await loadedIcon(drawer(page).locator('.task-people > span').filter({hasText: '执行：'}))).toBe(src);
  await page.keyboard.press('Escape');
  const unbranded = active(page).getByRole('button').filter({hasText: b.title});
  await expect(unbranded.locator('.avatar')).not.toBeEmpty();
  await expect(unbranded).toContainText(unknown.name + ' 正在做');
  const broken = active(page).getByRole('button').filter({hasText: c.title});
  await loadedIcon(broken);
  // 故意指向不存在的图片，触发真实 img error（也覆盖被打包为 data URL 的小图标）。
  await broken.locator('img').evaluate((img: HTMLImageElement) => {img.src = '/missing-agent-icon-for-test.png';});
  await expect(broken.locator('.avatar')).not.toBeEmpty();
  await expect(broken.locator('img')).toHaveCount(0);
  await expect(broken).toContainText('Codex 正在做');
  await broken.click(); await expect(drawer(page).getByRole('heading', {level: 1})).toHaveText(c.title);
});

import {test, expect, type Page} from '@playwright/test';
import {api, makeTask, drawer, shot, noHorizontalScroll} from './support.ts';

async function focusCards(page: Page, tasks: string[], requestId?: string) {
  const filter = async (route: any) => {
    const r = await route.fetch(), s = await r.json();
    s.tasks = s.tasks.filter((t: any) => tasks.includes(t.id));
    s.requests = s.requests.filter((q: any) => q.id === requestId);
    await route.fulfill({response: r, json: s});
  };
  await page.route('**/api/bootstrap', filter); await page.route('**/api/state', filter);
}

test('轮到你了分开展示项目、执行者和规划者；长名称与明暗宽窄布局保持清晰', async ({page}) => {
  const a = await makeTask(page, {title: '测试：工作台界面调整'});
  const b = await makeTask(page, {title: '测试：海外项目季度计划与前端展示效果', stage: 'reviewed', agent: 'zcode'});
  const h = await api(page);
  const custom = await h.post('/agents', {version: 0, name: '测试' + '品牌设计与前端团队'.repeat(5), preset_id: null, icon_key: 'claude', scope: '隔离测试前端任务', restriction: '', model: null, allowed_kinds: ['engineering'], models: []});
  const c = await makeTask(page, {title: '测试：' + '长期项目规划与素材整理'.repeat(6), stage: 'running', agent: custom.id});
  await c.report('waiting_input', {message: '测试问题：选择哪种外观？'});
  const q = await h.post('/requests', {project_id: a.project.id, text: '测试：还没有分配执行者的后续需求'});
  await focusCards(page, [a.tid, b.tid, c.tid], q.id);
  await page.goto('/#/today');
  await expect(page.locator('.arrange-group .turn').first()).toBeVisible();
  const section = page.getByRole('region', {name: '轮到你了'});
  for (const [t, who] of [[a, 'Codex'], [b, 'Zcode'], [c, custom.name]] as const) {
    const card = section.getByRole('article', {name: t.title, exact: true});
    await expect(card.locator('.active-project')).toHaveText(t.project.name);
    await expect(card.locator('.turn-agent')).toHaveAttribute('title', '执行：' + who);
    await expect(card.locator('.turn-agent-role')).toHaveText('执行');
    await expect.poll(() => card.locator('.turn-agent img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
  const planning = section.getByRole('article', {name: q.text, exact: true});
  await expect(planning.locator('.active-project')).toHaveText(a.project.name);
  await expect(planning.locator('.turn-agent')).toHaveAttribute('title', '规划：Codex');
  await expect(planning.locator('.turn-agent-role')).toHaveText('规划');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', {name: '切换到深色外观'}).click();
    for (const width of [900, 1440, 1920, 480]) {
      await page.setViewportSize({width, height: 1000});
      expect(await noHorizontalScroll(page)).toBe(true);
      const fit = await section.locator('.turn').evaluateAll(cards => cards.every(card => {
        const heading = card.querySelector('.turn-heading')!.getBoundingClientRect();
        const actions = card.querySelector('.turn-actions')!.getBoundingClientRect();
        const box = card.getBoundingClientRect();
        return (heading.right <= actions.left + 1 || heading.bottom <= actions.top + 1) &&
          [...card.querySelectorAll('.active-project,.turn-agent,.turn-actions')].every(el => {
            const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right + 1;
          });
      }));
      expect(fit).toBe(true);
      await shot(page, `轮到你了-隔离测试-${theme}-${width}`);
    }
  }
  await page.setViewportSize({width: 1440, height: 1000});
  await section.getByRole('article', {name: b.title, exact: true}).getByRole('button', {name: '去试用确认'}).click();
  await expect(drawer(page).getByRole('heading', {level: 1})).toHaveText(b.title);
  await expect(drawer(page).locator('.task-people')).toContainText('执行：Zcode');
});

test('轮到你了改派后显示当前执行者，复制执行单后仍等待交接', async ({page}) => {
  const t = await makeTask(page, {title: '测试：轮到你了当前执行者', stage: 'order'});
  let d = await t.get('/tasks/' + t.tid);
  await t.post('/tasks/' + t.tid + '/action', {action: 'cancel', revision: d.task.revision});
  d = await t.get('/tasks/' + t.tid);
  await t.post('/tasks/' + t.tid + '/export', {version: 1, new_run: true, agent_id: 'zcode', expected_revision: d.task.revision});
  await focusCards(page, [t.tid]); await page.goto('/#/today');
  await expect(page.getByRole('article',{name:t.title,exact:true})).toBeVisible();
  await page.getByRole('button',{name:/^待安排（/}).click();
  const card = page.getByRole('article', {name: t.title, exact: true});
  await expect(card.locator('.turn-agent')).toHaveAttribute('title', '执行：Zcode');
  await expect(card.locator('.turn-agent img')).toHaveAttribute('src', /zcode/);
  await card.getByRole('button', {name: '复制执行单', exact: true}).click();
  expect((await t.get('/tasks/' + t.tid)).task.status).toBe('awaiting_dispatch');
  await card.locator('.turn-title').click();
  await expect(drawer(page).locator('.task-people')).toContainText('执行：Zcode（原计划 Codex）');
});

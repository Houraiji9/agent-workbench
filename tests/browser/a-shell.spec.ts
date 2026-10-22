import { test, expect } from '@playwright/test';
import { nav, shot, noHorizontalScroll, api } from './support.ts';

test('首次打开：欢迎引导、六个主页面都能进入、没有脚本错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '从一句话开始' })).toBeVisible();
  await expect(page.getByText('现在没有要你动手的事。')).toBeVisible();
  await shot(page, '新版-今天-空账本');
  for (const [label, heading] of [['项目', '项目'], ['团队', '团队'], ['额度与订阅', '额度与订阅'], ['记录', '记录'], ['设置', '设置'], ['今天', '']] as const) {
    await nav(page, label);
    if (heading) await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    await expect(page.locator('nav').getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await nav(page, '额度与订阅');
  await page.getByRole('tab', { name: '数据连接' }).click();
  await expect(page.getByText('未连接', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '测试连接并刷新' }).first().click();
  await expect(page.getByText('未连接', { exact: true })).toHaveCount(2);
  await page.getByRole('tab', { name: '额度' }).click();
  await expect(page.getByText('Token Monitor 尚未连接')).toBeVisible();
  expect(errors).toEqual([]);
});

test('刷新后回到同一页面与页签；深色外观可切换并保留', async ({ page }) => {
  await page.goto('/#/resources?tab=plans');
  await expect(page.getByRole('tab', { name: '订阅与日程' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: '订阅与日程' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '切换到深色外观' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(page, '新版-订阅与日程-深色');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '切换到浅色外观' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('键盘：N 提需求、Ctrl+K 快速跳转、Esc 关闭；跳转能直达页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog',{name:'提一个需求'})).toBeVisible();
  await expect(page.getByLabel('你想完成什么？')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  const box = page.getByRole('dialog', { name: '快速跳转' });
  await expect(box).toBeVisible();
  await page.keyboard.type('订阅');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: '订阅与日程' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('窄窗口：菜单可打开、无横向滚动；中等窗口侧栏收成图标且仍可访问', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto('/');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByRole('button', { name: '打开菜单' }).click();
  await page.locator('nav').getByRole('button', { name: '项目', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '项目', exact: true })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, '新版-窄窗口-项目');
  await page.setViewportSize({ width: 960, height: 700 });
  await expect(page.locator('nav').getByRole('button', { name: '团队', exact: true })).toBeVisible();
  await nav(page, '团队');
  await expect(page.getByRole('heading', { level: 1, name: '团队' })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('提需求：保存后给出下一步，刷新后仍在“待开始”；不用选模型或执行者', async ({ page }) => {
  const { post } = await api(page);
  await page.goto('/');
  await page.getByRole('button', { name: '提需求', exact: true }).click();
  const d = page.getByRole('dialog', { name: '提一个需求' });
  await expect(d.getByLabel('执行者',{exact:true})).toHaveCount(0); // 仍由 Codex 选人和选模型
  await expect(d.getByRole('combobox',{name:'属于哪个项目'})).toHaveCount(1);
  await d.getByLabel('你想完成什么？').fill('浏览器测试需求：中文录入和刷新保留');
  await d.getByRole('button', { name: '先记下来' }).click();
  await expect(d).toHaveCount(0);
  const card = page.getByRole('article', { name: '浏览器测试需求：中文录入和刷新保留' });
  await expect(card).toBeVisible();
  await expect(card.getByText('待开始',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('article', { name: '浏览器测试需求：中文录入和刷新保留' })).toBeVisible();
  const state = await (await page.request.get('/api/state')).json();
  const q = state.requests.find((r: any) => r.text === '浏览器测试需求：中文录入和刷新保留');
  expect(q.status).toBe('draft');
  expect(q.review_policy).toBeNull();
  void post;
});

test('提需求时选择“这次不安排审查”：原因必填并记录在需求里', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '提需求', exact: true }).click();
  const d = page.getByRole('dialog', { name: '提一个需求' });
  await d.getByLabel('你想完成什么？').fill('浏览器测试：不审查的小改动');
  await d.getByText('特殊安排（一般不用改）').click();
  await d.getByLabel('这次不安排其他 Agent 审查，交付后我自己试用确认').check();
  await d.getByLabel('说明一下原因').fill('测试：小改动我自己看');
  await d.getByRole('button', { name: '先记下来' }).click();
  // 保存后对话框关闭（原断言“仍可见”只在保存请求尚未返回的瞬间成立，属于时序巧合）
  await expect(page.getByRole('dialog', { name: '提一个需求' })).toHaveCount(0);
  const state = await (await page.request.get('/api/state')).json();
  const q = state.requests.find((r: any) => r.text === '浏览器测试：不审查的小改动');
  expect(q.review_policy).toMatchObject({ mode: 'not_requested', source: 'user_requested', note: '测试：小改动我自己看' });
});

test('宽屏适配：内容在窗口中居中、待办排成两列；常见尺寸都没有横向滚动', async ({ page }) => {
  const { makeTask } = await import('./support.ts');
  await makeTask(page, { title: '宽屏测试一' });
  await makeTask(page, { title: '宽屏测试二' });
  for (const [w, h] of [[2560, 1440], [3840, 2160], [1920, 1080], [1366, 768], [1024, 700]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await noHorizontalScroll(page), `${w} 宽时不应横向滚动`).toBe(true);
    const m = await page.evaluate(() => {
      const main = document.querySelector('.main-col')!.getBoundingClientRect();
      const box = document.querySelector('.today')!.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.turn')].map(c => Math.round(c.getBoundingClientRect().left));
      return { left: box.left - main.left, right: main.right - box.right, width: box.width, columns: new Set(cards).size };
    });
    if (w >= 1920) {
      expect(Math.abs(m.left - m.right), `${w} 宽时左右留白应相等`).toBeLessThan(4);
      expect(m.columns, `${w} 宽时待办应排成两列`).toBe(2);
    } else expect(m.columns).toBe(1);
    if (w === 2560) await shot(page, '新版-宽屏2560-今天', false);
  }
});

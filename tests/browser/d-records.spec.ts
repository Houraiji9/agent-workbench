import { test, expect } from '@playwright/test';
import { nav, makeTask, drawer } from './support.ts';

const session = (id: string, title: string) => ({ id, kind: 'session', title, native_id: 'native-' + id, agent: 'codex', sources: [{ source: 'fixture', source_id: id }], status: 'summary_only', source_label: 'fixture', association: 'pending_confirmation', updated_at: new Date().toISOString() });

test('会话正文：逐页读取，空的最后一页保留已显示的正文', async ({ page }) => {
  await page.route('**/api/history?*', r => r.fulfill({ json: { items: [session('last', '隔离末页会话')] } }));
  await page.route('**/api/sessions/last/messages?*', r => { const first = new URL(r.request().url()).searchParams.get('from') === '0'; return r.fulfill({ json: { messages: first ? [{ ordinal: 0, role: 'assistant', content: '末页仍需保留的正文' }] : [], next_from: first ? 1 : null } }); });
  await page.goto('/');
  await nav(page, '记录');
  await page.getByRole('button', { name: /隔离末页会话/ }).click();
  const d = page.getByRole('dialog', { name: '隔离末页会话' });
  await d.getByRole('button', { name: '读取第一页正文' }).click();
  await expect(d.getByText('末页仍需保留的正文')).toBeVisible();
  await d.getByRole('button', { name: '读取下一页正文' }).click();
  await expect(d.getByRole('button', { name: '已经是最后一页' })).toBeDisabled();
  await expect(d.getByText('末页仍需保留的正文')).toBeVisible();
});

test('竞态：会话 A 的慢正文不能出现在会话 B 里', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(r => (release = r));
  await page.route('**/api/history?*', r => r.fulfill({ json: { items: [session('A', '隔离会话 A'), session('B', '隔离会话 B')] } }));
  await page.route('**/api/sessions/A/messages?*', async r => { await gate; await r.fulfill({ json: { messages: [{ ordinal: 1, role: 'assistant', content: '不应显示在 B 的旧正文' }], next_from: null } }); });
  await page.goto('/#/records');
  await page.getByRole('button', { name: /隔离会话 A/ }).click();
  const req = page.waitForRequest(r => r.url().includes('/sessions/A/messages'));
  await page.getByRole('dialog', { name: '隔离会话 A' }).getByRole('button', { name: '读取第一页正文' }).click();
  await req;
  await page.getByRole('dialog', { name: '隔离会话 A' }).getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: /隔离会话 B/ }).click();
  const resp = page.waitForResponse(r => r.url().includes('/sessions/A/messages'));
  release(); await resp;
  await expect(page.getByRole('dialog', { name: '隔离会话 B' })).toBeVisible();
  await expect(page.getByText('不应显示在 B 的旧正文')).toHaveCount(0);
});

test('竞态：旧的全文搜索结果不能显示在新的搜索条件下', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(r => (release = r));
  await page.route('**/api/history/external?*', async r => { await gate; await r.fulfill({ json: { items: [{ title: '过期搜索内容', snippet: '不应回填', source: 'fixture', native_id: 'x', ordinal: 0, location: 'message' }], next_cursor: null } }); });
  await page.goto('/#/records');
  const input = page.getByLabel('搜索记录');
  await input.fill('旧条件');
  const req = page.waitForRequest(r => r.url().includes('/history/external?'));
  await page.getByRole('button', { name: /在 AgentsView 里搜/ }).click();
  await req;
  await input.fill('新条件');
  const resp = page.waitForResponse(r => r.url().includes('/history/external?'));
  release(); await resp;
  await page.waitForTimeout(300);
  await expect(page.getByText('过期搜索内容')).toHaveCount(0);
});

test('AgentsView 未连接：全文搜索如实说明，本地记录照常可查，任务可从记录打开', async ({ page }) => {
  const m = await makeTask(page, { title: '记录检索测试' });
  await page.goto('/#/records');
  await page.getByLabel('搜索记录').fill('记录检索测试');
  await expect(page.getByRole('button', { name: /记录检索测试/ })).toBeVisible();
  await page.getByRole('button', { name: /在 AgentsView 里搜/ }).click();
  await expect(page.getByRole('alert')).toContainText('AgentsView 没有连接');
  await page.getByLabel('搜索记录').fill('不存在的关键词xyz');
  await expect(page.getByText('没有找到匹配的记录')).toBeVisible();
  await page.getByLabel('搜索记录').fill(m.tid);
  await page.getByRole('button', { name: /记录检索测试/ }).click();
  await expect(drawer(page).getByRole('heading', { name: '记录检索测试' })).toBeVisible();
});

test('快速跳转搜索词会带到记录页', async ({ page }) => {
  await makeTask(page, { title: '跳转搜索测试' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('完全找不到的词abc');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('搜索记录')).toHaveValue('完全找不到的词abc');
});

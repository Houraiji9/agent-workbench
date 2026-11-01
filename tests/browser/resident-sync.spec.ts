import {test, expect} from '@playwright/test';
import {makeTask} from './support.ts';
import fs from 'node:fs';
import path from 'node:path';

async function silentStream(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const streams: any[] = []; (window as any).__residentStreams = streams;
    class SilentEvents extends EventTarget {
      onerror: any = null; closed = false;
      constructor() { super(); streams.push(this); }
      close() { this.closed = true; }
    }
    (window as any).EventSource = SilentEvents;
  });
}

test('驻留返回：过期 cookie 自动续期，静默 SSE 重连，项目编辑草稿和页面节点保留', async ({page, context}) => {
  const m = await makeTask(page, {title: '合成驻留恢复'}); await silentStream(page);
  let bootstraps = 0, states = 0, loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/bootstrap', async route => { bootstraps++; await route.continue(); });
  await page.route('**/api/state', async route => { states++; await route.continue(); });
  await page.goto('/#/projects/' + m.project.id);
  await page.getByRole('button', {name: '编辑资料', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '编辑项目资料'});
  const name = dialog.getByLabel('项目名称', {exact: true});
  await name.fill('尚未保存的驻留草稿');
  await dialog.evaluate(element => { (window as any).__residentDialog = element; element.scrollTop = 80; });
  await context.clearCookies(); // 实际 HTTP 401，等同 12h 后浏览器移除过期 cookie。
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => bootstraps).toBe(2);
  await expect.poll(() => states).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => (window as any).__residentStreams.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__residentStreams[0].closed)).toBe(true);
  expect(await page.evaluate(() => (window as any).__residentDialog.isConnected)).toBe(true);
  await expect(name).toHaveValue('尚未保存的驻留草稿'); expect(loads).toBe(1);
  await dialog.getByRole('button', {name: '保存', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', {name: '尚未保存的驻留草稿', exact: true})).toBeVisible();
  if (process.env.WORKBENCH_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.WORKBENCH_EVIDENCE_DIR, {recursive: true});
    await page.goto('/#/settings'); await expect(page.getByRole('heading', {name: '设置', exact: true})).toBeVisible();
    await page.screenshot({path: path.join(process.env.WORKBENCH_EVIDENCE_DIR, 'ui-before-settings-1440.png'), fullPage: true, animations: 'disabled'});
    await page.setViewportSize({width: 900, height: 1000});
    await page.getByRole('button', {name: '提需求', exact: true}).click();
    await expect(page.getByRole('dialog', {name: '提一个需求'})).toBeVisible();
    await page.getByLabel('你想完成什么？').fill('合成界面基线：检查需求文字区、按钮大小与间距，保留输入内容。');
    await page.screenshot({path: path.join(process.env.WORKBENCH_EVIDENCE_DIR, 'ui-before-request-900.png'), fullPage: true, animations: 'disabled'});
  }
});

test('首次 bootstrap 失败无需重载可恢复', async ({page}) => {
  let calls = 0;
  await page.route('**/api/bootstrap', async route => {
    if (++calls === 1) return route.fulfill({status: 503, json: {error: '合成启动暂不可用'}});
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('合成启动暂不可用')).toBeVisible();
  await expect(page.getByRole('button', {name: '提需求', exact: true})).toBeVisible({timeout: 10000});
  await expect(page.getByText('合成启动暂不可用')).toHaveCount(0);
  expect(calls).toBe(2);
});

test('静默 SSE 不发事件仍轮询新快照，休眠长暂停后重建连接', async ({page}) => {
  await silentStream(page);
  await page.clock.install();
  let states = 0;
  await page.route('**/api/state', async route => { states++; await route.continue(); });
  await page.goto('/'); await expect(page.getByRole('button', {name: '提需求', exact: true})).toBeVisible();
  await page.clock.fastForward(31000); await expect.poll(() => states).toBeGreaterThanOrEqual(1);
  const before = states;
  await page.clock.fastForward(13 * 3600000);
  await expect.poll(() => states).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => (window as any).__residentStreams.length)).toBe(2);
});

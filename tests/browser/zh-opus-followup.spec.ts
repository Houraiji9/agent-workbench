import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,makeTask,noHorizontalScroll,shot} from './support.ts';

// Opus 接续：需求箱筛选与地址同步、“更多”菜单回焦（复用前序审查 4 条探针）、执行安排修改入口、今天紧凑待安排。隔离合成账本。
async function twoProjects(page:Page){
  const a=await api(page),projects=[];
  for(const label of ['A','B']){const folder=path.join(a.root,'接续合成-'+label+'-'+randomUUID().slice(0,8));fs.mkdirSync(folder);const p=await a.post('/projects',{name:'接续合成项目'+label,path:folder});await a.post('/requests',{project_id:p.id,text:'接续合成需求'+label,status:'draft'});projects.push(p);}
  return projects;
}
const filter=(page:Page)=>page.getByLabel('筛选需求项目');

test('需求箱：深链进入后点侧栏回到全部项目，前进后退一致',async({page})=>{
  const [a]=await twoProjects(page);
  await page.goto('/#/requests/'+a.id+'?tab=drafts');await expect(filter(page)).toHaveValue(a.id);
  await expect(page.getByRole('article',{name:'接续合成需求B'})).toHaveCount(0);
  await page.locator('nav').getByRole('button',{name:'需求箱',exact:true}).click();
  await expect(page).toHaveURL(/#\/requests$/);await expect(filter(page)).toHaveValue('');
  await expect(page.getByRole('article',{name:'接续合成需求B'})).toBeVisible();
  await page.goBack();await expect(filter(page)).toHaveValue(a.id);
  await page.goForward();await expect(filter(page)).toHaveValue('');
});

test('需求箱：切换项目写入地址，刷新后保持，“看全部项目”清除筛选',async({page})=>{
  const [a,b]=await twoProjects(page);
  await page.goto('/#/requests/'+a.id+'?tab=drafts');await filter(page).selectOption(b.id);
  await expect(page).toHaveURL(new RegExp('#/requests/'+b.id+'\\?tab=drafts$'));
  await page.reload();await expect(filter(page)).toHaveValue(b.id);await expect(page.getByRole('article',{name:'接续合成需求B'})).toBeVisible();
  await page.getByRole('button',{name:'看全部项目'}).click();await expect(filter(page)).toHaveValue('');await expect(page).toHaveURL(/#\/requests\?tab=drafts$/);
});

test('项目“更多”：键盘收纳后焦点回到可见的“更多”',async({page})=>{
  const [a]=await twoProjects(page);await page.goto('/#/projects/'+a.id);
  const summary=page.locator('.more-menu > summary');await summary.focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'收纳并暂缓新安排'})).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.locator('.more-menu')).not.toHaveAttribute('open','');await expect(summary).toBeFocused();
  await expect(page.getByText('当前调用继续；后续新派发已暂停')).toBeVisible();
});

test('项目“更多”：归档对话框按 Esc 或取消后焦点回到“更多”，对话框自身先拿到焦点',async({page})=>{
  const [a]=await twoProjects(page);await page.goto('/#/projects/'+a.id);
  const summary=page.locator('.more-menu > summary');
  for(const close of ['Escape','cancel']){
    await summary.focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    await expect(page.getByRole('button',{name:'归档项目',exact:true})).toBeFocused();await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
    if(close==='Escape')await page.keyboard.press('Escape');else await dialog.getByRole('button',{name:/取消|关闭/}).first().click();
    await expect(dialog).toHaveCount(0);await expect(summary).toBeFocused();
  }
});

test('执行安排：运行中保存为下一版，当前轮不变，可撤回',async({page})=>{
  const m=await makeTask(page,{title:'接续合成运行中安排',stage:'running'});
  await page.goto('/#/today?task='+m.tid);
  const panel=page.locator('details.arrangement');await panel.locator('summary').click();
  await expect(panel.getByRole('region',{name:'当前执行安排'})).toContainText('Codex');
  await panel.getByRole('button',{name:'修改执行安排'}).click();
  await expect(panel.getByText('正在运行的客户端不能热切换模型')).toBeVisible();
  await panel.getByLabel('主模型').selectOption('gpt-6-sol');
  await panel.getByRole('button',{name:'保存为下一版安排'}).click();
  const next=page.getByRole('region',{name:'待生效的下一版安排'});await expect(next).toContainText('gpt-6-sol');await shot(page,'after-执行安排-运行中保存下一版',false);
  await expect(page.getByRole('region',{name:'当前执行安排'})).not.toContainText('gpt-6-sol');
  const detail=await m.get('/tasks/'+m.tid);expect(detail.task.pending_arrangement.requested_model).toBe('gpt-6-sol');
  expect(detail.runs.find((r:any)=>r.id===detail.task.current_run_id).requested_model??null).toBe(null);
  await next.getByRole('button',{name:'撤回这次调整'}).click();await expect(page.getByRole('region',{name:'待生效的下一版安排'})).toHaveCount(0);
});

test('执行安排：未开始的执行单按新安排重新生成，旧执行单留档',async({page})=>{
  const m=await makeTask(page,{title:'接续合成未开始安排',stage:'order'});
  await page.goto('/#/today?task='+m.tid);
  const panel=page.locator('details.arrangement');await panel.locator('summary').click();
  await panel.getByRole('button',{name:'修改执行安排'}).click();
  await expect(panel.getByText('作废这张未开始的执行单')).toBeVisible();await shot(page,'after-执行安排-未开始重新生成',false);
  await panel.getByLabel('主模型').selectOption('gpt-6-sol');
  await panel.getByRole('button',{name:'作废未开始的执行单并重新生成'}).click();
  await expect(page.locator('details.arrangement > summary')).toContainText('第 2 版执行单');
  const detail=await m.get('/tasks/'+m.tid),old=detail.runs.find((r:any)=>r.id===m.rid),current=detail.runs.find((r:any)=>r.id===detail.task.current_run_id);
  expect(old.status).toBe('cancelled');expect(current.requested_model).toBe('gpt-6-sol');expect(current.arrangement.source).toBe('user_page');
  await page.locator('details.arrangement > summary').click();await page.locator('details.arrangement').getByText('历次执行单（2）').click();
  await expect(page.locator('.arrangement-history li')).toHaveCount(2);
});

test('今天：待安排用紧凑行，复制入口直接可见；最小窗口无横向滚动',async({page})=>{
  for(let i=0;i<4;i++)await makeTask(page,{title:'接续合成待安排 '+i});
  await page.goto('/#/today');
  const group=page.getByRole('region',{name:'待安排'});await expect(group.locator('.turn.compact').first()).toBeVisible();
  // 共享合成账本里可能已有很多待办，先按标题搜索，避免受分页顺序影响。
  await page.getByRole('textbox',{name:'搜索待办'}).fill('接续合成待安排');await expect(group.locator('.turn.compact')).toHaveCount(4);
  await expect(group.getByRole('article',{name:'接续合成待安排 0'}).getByRole('button',{name:/复制执行单/})).toBeVisible();
  const kinds=page.getByRole('group',{name:'按动作筛选待办'});await expect(kinds.getByRole('button',{name:/^全部/})).toBeVisible();
  await page.setViewportSize({width:880,height:600});expect(await noHorizontalScroll(page)).toBe(true);
  await page.setViewportSize({width:375,height:760});expect(await noHorizontalScroll(page)).toBe(true);
});

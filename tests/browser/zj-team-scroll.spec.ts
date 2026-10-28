import {test,expect,type Page} from '@playwright/test';
import {noHorizontalScroll,shot} from './support.ts';

// Only browser responses are expanded; no live or fixture ledger is changed.
async function syntheticTeam(page:Page){
  const patch=async(route:any)=>{
    const response=await route.fetch(),state=await response.json();
    const template=state.agents.find((a:any)=>!a.archived);
    state.agents=Array.from({length:64},(_,i)=>({...template,id:'scroll-'+i,name:'测试滚动成员 '+i,scope:'团队滚动验证：执行、审查与资料整理。',archived:false,merged_into:null}));
    state.model_catalog=state.agents.map((a:any)=>({agent_id:a.id,sources:[],models:Array.from({length:36},(_,i)=>({id:'model-'+i,name:'测试模型 '+i,purpose:'验证详情栏独立滚动与切换后的起始位置。'}))}));
    state.tasks=[];state.sessions=[];
    await route.fulfill({response,json:state});
  };
  await page.route('**/api/bootstrap',patch);
  await page.route('**/api/state',patch);
  await page.goto('/#/team');
  await expect(page.getByRole('listitem',{name:'测试滚动成员 63',exact:true})).toHaveCount(1);
}
const listTop=(page:Page)=>page.locator('.team .agent-grid').evaluate(e=>e.scrollTop);
const windowTop=(page:Page)=>page.evaluate(()=>window.scrollY);

test('团队分栏在视口内独立滚动，切换成员和浏览器历史保留列表位置',async({page})=>{
  await page.setViewportSize({width:1440,height:900});await syntheticTeam(page);
  const list=page.getByRole('list',{name:'Agent 列表'});
  await page.getByRole('listitem',{name:'测试滚动成员 0',exact:true}).click();
  await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 0 详情');
  await list.evaluate(e=>{e.scrollTop=1800});
  const next=list.getByRole('listitem',{name:'测试滚动成员 20',exact:true});
  await next.scrollIntoViewIfNeeded();const before=await listTop(page);
  expect(before).toBeGreaterThan(800);
  await page.locator('.agent-panel').evaluate(e=>{e.scrollTop=500});
  await next.click();
  await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 20 详情');
  await expect.poll(()=>listTop(page)).toBe(before);
  await expect.poll(()=>page.locator('.agent-panel').evaluate(e=>e.scrollTop)).toBe(0);
  expect(await windowTop(page)).toBe(0);
  for(const selector of ['.team .agent-grid','.agent-panel']){
    const box=await page.locator(selector).boundingBox();expect(box!.y).toBeGreaterThanOrEqual(64);expect(box!.y+box!.height).toBeLessThanOrEqual(900);
    expect(await page.locator(selector).evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true);
  }
  await page.locator('.agent-panel').hover();await page.mouse.wheel(0,600);
  await expect.poll(()=>page.locator('.agent-panel').evaluate(e=>e.scrollTop)).toBeGreaterThan(100);
  expect(await listTop(page)).toBe(before);expect(await windowTop(page)).toBe(0);
  await page.goBack();await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 0 详情');expect(await listTop(page)).toBe(before);
  await page.goForward();await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 20 详情');expect(await listTop(page)).toBe(before);
  await page.getByRole('button',{name:'全部成员',exact:true}).click();await expect(page.locator('.agent-panel:not(.placeholder)')).toHaveCount(0);
  expect(await listTop(page)).toBe(0);
  await page.goBack();await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 20 详情');expect(await listTop(page)).toBe(before);
  expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'团队滚动-桌面',false);
});

test('团队窄窗口详情可独立滚动，返回和前进恢复列表位置',async({page})=>{
  await page.setViewportSize({width:880,height:600});await syntheticTeam(page);
  const list=page.getByRole('list',{name:'Agent 列表'});
  await list.evaluate(e=>{e.scrollTop=800});
  const member=list.getByRole('listitem',{name:'测试滚动成员 20',exact:true});
  await member.scrollIntoViewIfNeeded();const before=await listTop(page);expect(before).toBeGreaterThan(0);
  await member.click();const panel=page.locator('.agent-panel');
  await expect(panel).toHaveAttribute('aria-label','测试滚动成员 20 详情');await expect(list).toBeHidden();
  await panel.evaluate(e=>{e.scrollTop=500});expect(await panel.evaluate(e=>e.scrollTop)).toBe(500);expect(await windowTop(page)).toBe(0);
  await panel.evaluate(e=>{e.scrollTop=0});await page.getByRole('button',{name:'全部成员',exact:true}).click();
  await expect(list).toBeVisible();await expect.poll(()=>listTop(page)).toBe(before);
  await page.goBack();await expect(panel).toHaveAttribute('aria-label','测试滚动成员 20 详情');expect(await panel.evaluate(e=>e.scrollTop)).toBe(0);
  await page.goForward();await expect(list).toBeVisible();expect(await listTop(page)).toBe(before);
  for(const width of [390,880]){
    await page.setViewportSize({width,height:600});expect(await noHorizontalScroll(page)).toBe(true);
    await page.evaluate(()=>{location.hash='#/team/scroll-20'});await expect(panel).toBeVisible();
    const box=await panel.boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(600);
    if(width===390){
      const name=await panel.locator('.ap-head h2').boundingBox(),edit=await panel.getByRole('button',{name:'编辑分工'}).boundingBox();
      expect(name!.width).toBeGreaterThan(180);expect(edit!.y).toBeGreaterThan(name!.y);
    }
    expect(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await shot(page,'团队滚动-窄屏-'+width,false);
    await page.getByRole('button',{name:'全部成员',exact:true}).click();
  }
});

test('只有团队成员切换保留window滚动，其他页和团队页签仍回到顶部',async({page})=>{
  await syntheticTeam(page);await page.getByRole('listitem',{name:'测试滚动成员 0',exact:true}).click();
  // Create outer overflow to make an accidental global scrollTo observable.
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.id='scroll-probe';spacer.style.height='600px';document.body.append(spacer);window.scrollTo(0,120)});
  expect(await windowTop(page)).toBe(120);
  await page.evaluate(()=>{location.hash='#/team/scroll-1'});await expect(page.locator('.agent-panel')).toHaveAttribute('aria-label','测试滚动成员 1 详情');
  expect(await windowTop(page)).toBe(120);
  await page.evaluate(()=>{location.hash='#/team?tab=presets'});await expect(page.getByRole('region',{name:'Agent 预设库'})).toBeVisible();
  await expect.poll(()=>windowTop(page)).toBe(0);
  await page.evaluate(()=>{window.scrollTo(0,120);location.hash='#/projects'});await expect(page.locator('h1')).toHaveText('项目');await expect.poll(()=>windowTop(page)).toBe(0);
  await page.evaluate(()=>{window.scrollTo(0,120);location.hash='#/projects/not-found'});await expect.poll(()=>windowTop(page)).toBe(0);
});

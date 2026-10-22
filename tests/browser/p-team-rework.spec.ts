import {test,expect} from '@playwright/test';
import {api,shot,noHorizontalScroll} from './support.ts';

test('官方介绍在普通浏览器打开新页，保留工作台和当前筛选',async({page,context})=>{
 await page.goto('/#/team?tab=presets');await page.getByLabel('搜索预设').fill('Qoder');
 const link=page.locator('.preset-card').getByRole('link',{name:'官方介绍'}),href=await link.getAttribute('href');expect(href).toMatch(/^https:\/\//);
 await context.route(href!,route=>route.fulfill({status:200,body:'Official page navigation test',contentType:'text/html'}));
 const popupPromise=page.waitForEvent('popup');await link.click();const popup=await popupPromise;await popup.waitForLoadState();expect(popup.url()).toBe(href);
 await expect(page.getByLabel('搜索预设')).toHaveValue('Qoder');expect(page.url()).toContain('tab=presets');await popup.close();
});

test('已移除沿用预设卡片、官方图标及恢复按钮，明暗窄屏一致且恢复保留资料',async({page})=>{
 const {post,get}=await api(page);
 const a=await post('/agents',{version:0,preset_id:null,name:'测试已移除 Qoder',scope:'保留自定义分工与模型，恢复后继续使用。',restriction:'',model:null,icon_key:'qoder',allowed_kinds:['engineering'],models:[{id:'test-model',name:'测试模型',purpose:'恢复验证'}]});
 await post('/agents/'+a.id+'/delete',{version:a.version});
 await page.goto('/#/team?tab=removed');const card=page.getByRole('article',{name:a.name,exact:true});
 await expect(card).toHaveClass('preset-card');await expect(card.locator('img')).toHaveCount(1);await expect(card).toContainText(a.scope);await expect(card.getByRole('button',{name:'恢复到团队'})).toBeVisible();
 await expect(page.locator('.restore-row')).toHaveCount(0);
 for(const width of [1440,900,390]){await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true);if(width!==900)await shot(page,'已移除-浅色-'+width)}
 await page.getByRole('button',{name:'切换到深色外观'}).click();await page.setViewportSize({width:1440,height:1000});await shot(page,'已移除-深色');
 await card.getByRole('button',{name:'恢复到团队'}).click();await expect(card).toHaveCount(0);const restored=(await get('/state')).agents.find((x:any)=>x.id===a.id);expect(restored.archived).toBe(false);expect(restored.scope).toBe(a.scope);expect(restored.model_group.models).toEqual(a.model_group.models);
 await page.goto('/#/team/'+a.id);await expect(page.getByText('测试模型',{exact:true})).toBeVisible();
});

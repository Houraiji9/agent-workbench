import {test,expect} from '@playwright/test';
import {shot} from './support.ts';
test('v0.1.1 five brand icons load in light and dark preset cards',async({page})=>{
 await page.goto('/#/team?tab=presets');
 for(const theme of ['light','dark']){
  if(theme==='dark')await page.getByRole('button',{name:'切换到深色外观'}).click();
  for(const name of ['Bolt','智谱','Grok Bot','通义灵码','Zcode']){
   await page.getByLabel('搜索预设').fill(name);
   const card=page.locator('.preset-card');await expect(card).toHaveCount(1);
   const img=card.locator('img');await expect(img).toBeVisible();
   await expect.poll(()=>img.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0&&el.naturalHeight>0)).toBe(true);
   await shot(page,`v011-icon-${theme}-${name}`);
  }
 }
});

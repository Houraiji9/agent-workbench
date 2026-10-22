import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';
import {makeTask,shot,noHorizontalScroll,drawer} from './support.ts';

test('长成果路径在项目卡片和任务抽屉中保留末尾目录且复制完整路径',async({page})=>{
 const m=await makeTask(page,{stage:'running',title:'测试长目录显示'}),folder=path.join(m.root,'很长的设计文件夹名称'.repeat(5),'最后文件夹');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'长路径.png');fs.copyFileSync('desktop/icon.png',file);await m.report('submitted',{artifacts:[{path:file,label:'长路径.png'}]});
 for(const width of [900,1440]){await page.setViewportSize({width,height:1000});
  for(const kind of ['project','drawer']){await page.goto(kind==='project'?'/#/projects/'+m.project.id+'?tab=files':'/#/today?task='+m.tid);const location=(kind==='project'?page.locator('.file-card'):drawer(page).locator('.artifact-row')).filter({has:page.getByRole('button',{name:/长路径.png/})});const code=location.locator('.artifact-folder code');await expect(code).toHaveText(folder);
   const geometry=await code.evaluate(el=>{const span=el.querySelector('span')!,text=span.firstChild!;const range=document.createRange();range.setStart(text,text.textContent!.length-5);range.setEnd(text,text.textContent!.length);const tail=range.getBoundingClientRect(),box=el.getBoundingClientRect();return {tailLeft:tail.left,tailRight:tail.right,left:box.left,right:box.right,overflow:el.scrollWidth>el.clientWidth}});expect(geometry.overflow).toBe(true);expect(geometry.tailLeft).toBeGreaterThanOrEqual(geometry.left-1);expect(geometry.tailRight).toBeLessThanOrEqual(geometry.right+1);
   await location.getByRole('button',{name:'复制路径',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(folder);await shot(page,'长目录-'+kind+'-'+width);
  }
 }
});

async function setup(page:any){const m=await makeTask(page,{stage:'running',title:'测试成果文件夹入口'}),folder=path.join(m.root,'图片设计 成果');fs.mkdirSync(folder);const file=path.join(folder,'测试预览.png');fs.copyFileSync('desktop/icon.png',file);await m.report('submitted',{artifacts:[{path:file,label:'测试预览.png'}]});return {...m,folder,file}}
test('项目成果、预览、任务成果都显示目录，可复制并只提交成果ID',async({page})=>{
 const m=await setup(page),opens:any[]=[];await page.route('**/api/artifacts/*/open-folder',async route=>{opens.push({url:route.request().url(),body:route.request().postDataJSON()});await route.fulfill({json:{opened:true}})});
 await page.goto('/#/projects/'+m.project.id+'?tab=files');const card=page.locator('.file-card').filter({has:page.getByRole('button',{name:/测试预览.png/})});await expect(card.locator('.artifact-folder code')).toHaveText(m.folder);await card.getByRole('button',{name:'复制路径',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(m.folder);await card.getByRole('button',{name:'打开文件夹',exact:true}).click();expect(opens[0].body).toEqual({target:'original'});await expect(page.getByRole('dialog',{name:'测试预览.png'})).toHaveCount(0);
 await card.getByRole('button',{name:/测试预览.png/}).click();const d=page.getByRole('dialog',{name:'测试预览.png'});await expect(d.locator('img.preview-img')).toBeVisible();await expect(d.locator('.artifact-folder code')).toHaveText(m.folder);await d.getByRole('button',{name:'打开归档文件夹',exact:true}).click();expect(opens[1].body).toEqual({target:'archive'});await shot(page,'成果预览-目录操作');await page.keyboard.press('Escape');
 await page.goto('/#/today?task='+m.tid);const row=drawer(page).locator('.artifact-row').filter({has:page.getByRole('button',{name:/测试预览.png/})});await expect(row.locator('.artifact-folder code')).toHaveText(m.folder);await row.getByRole('button',{name:'打开文件夹',exact:true}).click();expect(opens[2].body).toEqual({target:'original'});await shot(page,'任务成果-目录入口');
});
test('文件缺失显示归档入口；剪贴板失败可手动复制；小窗口路径不撑开卡片',async({page})=>{
 const m=await setup(page);await page.addInitScript(()=>{Object.defineProperty(navigator.clipboard,'writeText',{value:async()=>{throw Error('denied')}})});await page.route('**/api/artifacts/*/open-folder',async route=>{const target=route.request().postDataJSON().target;await route.fulfill({status:target==='original'?404:200,json:target==='original'?{error:'原文件已移动或删除，请打开归档文件夹'}:{opened:true}})});
 await page.goto('/#/projects/'+m.project.id+'?tab=files');const card=page.locator('.file-card').filter({has:page.getByRole('button',{name:/测试预览.png/})});await card.getByRole('button',{name:'打开文件夹',exact:true}).click();await expect(card.getByRole('alert')).toContainText('原文件已移动');await card.getByRole('button',{name:'打开归档文件夹'}).click();await expect(card.getByRole('alert')).toHaveCount(0);await card.getByRole('button',{name:'复制路径',exact:true}).click();await expect(card.getByRole('textbox',{name:'手动复制文件夹路径'})).toHaveValue(m.folder);
 for(const width of [390,900,1440]){await page.setViewportSize({width,height:900});expect(await noHorizontalScroll(page)).toBe(true);await expect(card.getByRole('button',{name:'打开文件夹',exact:true})).toBeVisible();await shot(page,'成果目录-'+width)}
});
test('任务抽屉的归档回退按钮在打开后仍保留焦点，Escape关闭抽屉',async({page})=>{
 const m=await setup(page);await page.route('**/api/artifacts/*/open-folder',async route=>{const target=route.request().postDataJSON().target;await route.fulfill({status:target==='original'?404:200,json:target==='original'?{error:'原文件已移动或删除，请打开归档文件夹'}:{opened:true}})});
 await page.goto('/#/today?task='+m.tid);const row=drawer(page).locator('.artifact-row').filter({has:page.getByRole('button',{name:/测试预览.png/})});await row.getByRole('button',{name:'打开文件夹',exact:true}).click();const fallback=row.getByRole('button',{name:'打开归档文件夹'});await fallback.click();await expect(row.getByRole('alert')).toHaveCount(0);await expect(fallback).toBeFocused();await page.keyboard.press('Escape');await expect(drawer(page)).toHaveCount(0);
});

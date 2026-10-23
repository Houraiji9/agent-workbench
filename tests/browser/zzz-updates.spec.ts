import {test,expect} from '@playwright/test';
import {nav,shot,noHorizontalScroll} from './support.ts';
test('设置更新：检查、下载、进度、取消重启与确认重启（模拟新版）',async({page})=>{
  await page.addInitScript(()=>{
    let s={status:'idle',currentVersion:'0.1.4',canInstall:true,latestVersion:null as string|null,progress:0,message:'',releaseUrl:'https://github.com/Houraiji9/agent-workbench/releases',notes:'测试新版：改进展示与更新体验。'};
    (window as any).updateTestCalls=[];
    (window as any).workbenchUpdates={status:async()=>({...s}),check:async()=>s={...s,status:'available',latestVersion:'0.1.5',message:'发现新版本 v0.1.5'},download:async()=>{s={...s,status:'downloading',message:'正在下载新版…',progress:55};await new Promise(r=>setTimeout(r,1200));return s={...s,status:'downloaded',progress:100,message:'新版已准备好'}},install:async()=>{(window as any).updateTestCalls.push('install');return s={...s,status:'installing',message:'正在退出并安装更新…'}},openDownload:async()=>s};
  });
  await page.goto('/');await nav(page,'设置');const card=page.getByRole('region',{name:'软件更新'});
  await card.getByRole('button',{name:'检查更新'}).click();await expect(card.getByText('发现新版本 v0.1.5')).toBeVisible();
  await card.getByRole('button',{name:'下载新版'}).click();await expect(card.getByRole('progressbar')).toBeVisible();
  await expect(card.getByRole('button',{name:'重启并更新'})).toBeVisible();
  for(const width of [900,1440,1920]) {await page.setViewportSize({width,height:1000});expect(await noHorizontalScroll(page)).toBe(true);}
  await shot(page,'隔离测试-软件更新-新版准备完成',true);
  await card.getByRole('button',{name:'重启并更新'}).click();let d=page.getByRole('dialog',{name:'安装新版工作台'});await d.getByRole('button',{name:'稍后'}).click();
  expect(await page.evaluate(()=>(window as any).updateTestCalls)).toEqual([]);
  await card.getByRole('button',{name:'重启并更新'}).click();d=page.getByRole('dialog',{name:'安装新版工作台'});await d.getByRole('button',{name:'现在重启更新'}).click();
  expect(await page.evaluate(()=>(window as any).updateTestCalls)).toEqual(['install']);
});
test('浏览器入口如实引导到桌面，不显示失效的更新按钮',async({page})=>{
  await page.goto('/');await nav(page,'设置');await expect(page.getByText('请在桌面工作台中检查更新。')).toBeVisible();await expect(page.getByRole('button',{name:'检查更新'})).toHaveCount(0);
});

import {test,expect} from '@playwright/test';
import {api,EVIDENCE} from './support.ts';
import path from 'node:path';
const evidence=EVIDENCE;
test('搜索途中更改关键词后，应当能继续搜索',async({page})=>{
 let release!:()=>void; const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/history/external?*',async r=>{await gate;await r.fulfill({json:{items:[],next_cursor:null}})});
 await page.goto('/#/records');
 await page.getByLabel('搜索记录').fill('原关键词');
 const sent=page.waitForRequest(r=>r.url().includes('/history/external?'));
 await page.getByRole('button',{name:/在 AgentsView 里搜/}).click();await sent;
 await page.getByLabel('搜索记录').fill('新关键词');
 const response=page.waitForResponse(r=>r.url().includes('/history/external?'));
 release();await response;await page.waitForTimeout(350);
 await page.screenshot({path:path.join(evidence,'回归-搜索恢复.png'),fullPage:true});
 await expect(page.getByRole('button',{name:/正在搜索|在 AgentsView 里搜/})).toBeEnabled();
});
test('实时连接恢复后，应补回断线期间的新需求',async({page})=>{
 await page.addInitScript(()=>{
  const all:any[]=[];(window as any).__auditStreams=all;
  class FakeEvents extends EventTarget {
   onerror:any=null; constructor(_url:string){super();all.push(this)}close(){};
  }
  (window as any).EventSource=FakeEvents;
 });
 await page.goto('/');await expect(page.getByRole('heading',{level:1})).toBeVisible();
 await page.waitForFunction(()=>(window as any).__auditStreams?.length===1);
 await page.evaluate(()=>{const e=(window as any).__auditStreams[0];e.dispatchEvent(new Event('ready'));e.onerror(new Event('error'))});
 await expect(page.getByText('实时同步中断，正在重连')).toBeVisible();
 const helper=await api(page); const title='隔离测试：断线期间新增需求';
 await helper.post('/requests',{project_id:helper.boot.projects[0].id,text:title});
 await page.waitForFunction(()=>(window as any).__auditStreams.length===2);
 await page.evaluate(()=>(window as any).__auditStreams[1].dispatchEvent(new Event('ready')));
 await expect(page.getByText('实时同步中断，正在重连')).toHaveCount(0);
 await page.waitForTimeout(350);
 await page.screenshot({path:path.join(evidence,'回归-重连补取.png'),fullPage:true});
 const state=await helper.get('/state');expect(state.requests.some((q:any)=>q.text===title)).toBe(true);
 await expect(page.getByRole('article',{name:title})).toBeVisible();
});

import {test,expect} from '@playwright/test';import {makeTask,completeCloseout} from './support.ts';import fs from 'node:fs';import path from 'node:path';

test('旧源码变化后从轻量试用入口确认；全局刷新未完成也立即显示保存成功',async({page})=>{
 const m=await makeTask(page,{title:'测试0414旧任务确认',stage:'running'}),file=path.join(m.root,'AGENTS.md');fs.writeFileSync(file,'原审查资料');
 await m.report('submitted',{review_files:[file]});const delivered=await m.get('/tasks/'+m.tid);
 await m.post('/reviews',{run_id:m.rid,reviewer_id:'grok-build',performed:true,verdict:'passed',evidence:'隔离浏览器测试审查，不是真实外部报告。',artifact_hashes:delivered.artifacts.filter((a:any)=>a.current).map((a:any)=>a.sha256)});await completeCloseout(m);
 fs.appendFileSync(file,'\n项目后续修改');
 await page.goto('/#/projects/'+m.project.id);const card=page.getByRole('article',{name:m.title,exact:true});await expect(card).toBeVisible();
 // Opening trial must not load the full task history endpoint.
 await page.route('**/api/tasks/'+m.tid,route=>route.abort());
 const read=page.waitForResponse(r=>r.url().endsWith('/api/tasks/'+m.tid+'/trial'));
 await card.getByRole('button',{name:'试用确认',exact:true}).click();expect((await read).ok()).toBe(true);
 const dialog=page.getByRole('dialog',{name:'试用后确认完成',exact:true});await expect(dialog).toBeVisible();for(const box of await dialog.getByRole('checkbox').all())await box.check();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let blockedReads=0;
 await page.route('**/api/state',async route=>{blockedReads++;await gate;await route.continue()});
 try{
  const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/tasks/'+m.tid+'/accept'));
  await dialog.getByRole('button',{name:'确认结果符合需求'}).click();expect((await saved).ok()).toBe(true);
  await expect(dialog).toHaveCount(0,{timeout:2000});await expect(page.getByRole('status').filter({hasText:'已确认完成，成果已归档'})).toBeVisible();
  expect(blockedReads).toBeGreaterThan(0);
  const result=(await m.get('/tasks/'+m.tid)).task;expect(result.status).toBe('accepted');expect(result.acceptance_record.technical_verification.rechecked_on_confirmation).toBe(false);
 }finally{release();await page.unrouteAll({behavior:'wait'})}
});

test('轻量试用界面保留旧页面版本冲突，失败时不显示成功',async({page})=>{
 const m=await makeTask(page,{title:'测试0414冲突提示',stage:'reviewed'});
 await page.route('**/api/tasks/'+m.tid+'/trial',async route=>{const response=await route.fetch(),body=await response.json();body.task.revision--;await route.fulfill({response,json:body})});
 await page.goto('/#/projects/'+m.project.id);await page.getByRole('article',{name:m.title,exact:true}).getByRole('button',{name:'试用确认',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'试用后确认完成',exact:true});for(const box of await dialog.getByRole('checkbox').all())await box.check();
 await dialog.getByRole('button',{name:'确认结果符合需求'}).click();await expect(dialog.getByRole('alert')).toContainText('任务版本冲突');expect((await m.get('/tasks/'+m.tid)).task.status).toBe('awaiting_confirmation');
 await page.unrouteAll({behavior:'wait'});
});

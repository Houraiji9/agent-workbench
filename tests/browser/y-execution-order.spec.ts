import {test,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {api,drawer,shot} from './support.ts';
import {taskInput} from '../helpers.ts';

test('多执行单分步骤展示，等待前序时不能派发，实际验收后自动解锁并可跳转前序',async({page})=>{
  const h=await api(page),root=path.join(h.root,'顺序测试-'+randomUUID());fs.mkdirSync(root,{recursive:true});
  const p=await h.post('/projects',{name:'测试：多任务执行顺序',path:root});
  const q=await h.post('/requests',{project_id:p.id,text:'测试：设计、两项实现与最终集成'});
  const items=[{key:'final',title:'测试：最后集成',dependencies:['backend','frontend']},{key:'backend',title:'测试：实现接口',dependencies:['design']},{key:'design',title:'测试：先确定设计'},{key:'frontend',title:'测试：制作页面',agent_id:'claude',work_kind:'frontend_light',dependencies:['design']}];
  const plan=await h.post('/plans',{schema_version:1,plan_id:randomUUID(),request_id:q.id,expected_version:1,tasks:items.map(t=>({...taskInput(root,t.key),...t}))});
  const [final,backend,design,frontend]=plan.task_ids;
  await page.goto('/#/projects/'+p.id);
  const list=page.getByRole('region',{name:'执行顺序'});
  await expect(list.locator('.order-title')).toHaveText(['测试：先确定设计','测试：实现接口','测试：制作页面','测试：最后集成']);
  await expect(list.locator('.order-step')).toHaveText(['第 1 步','第 2 步','第 2 步','第 3 步']);
  const blocked=list.getByRole('article',{name:'测试：最后集成'});await expect(blocked).toContainText('等待前序');await expect(blocked.getByRole('button',{name:'复制执行单'})).toHaveCount(0);
  await blocked.getByRole('button',{name:'测试：最后集成',exact:true}).click();
  await expect(drawer(page).getByRole('button',{name:'等待前序',exact:true})).toBeDisabled();
  await drawer(page).getByRole('region',{name:'执行顺序'}).getByRole('button',{name:'测试：实现接口',exact:true}).click();
  await expect(drawer(page).getByRole('heading',{level:1})).toHaveText('测试：实现接口');await page.keyboard.press('Escape');
  await page.goto('/#/today');await page.getByText('等待前序的任务', {exact:false}).click();
  await expect(page.getByRole('region',{name:'轮到你了'}).getByRole('article',{name:'测试：实现接口'})).toHaveCount(0);
  const o=await h.post('/tasks/'+design+'/export',{version:1});
  for(const [seq,type] of [[1,'started'],[2,'submitted']] as const)await h.post('/receipts',{schema_version:1,event_id:randomUUID(),task_id:design,run_id:o.run_id,task_version:1,seq,event_type:type,occurred_at:new Date().toISOString(),data:{identity:'codex',cwd:root,message:'测试：'+type,...(type==='submitted'?{result:'隔离测试中的设计交付报告，测试依赖解锁，不代表真实业务交付。'}:{})}});
  const d=await h.get('/tasks/'+design);await h.post('/reviews',{run_id:o.run_id,reviewer_id:'grok-build',performed:true,evidence:'隔离浏览器测试：模拟审查用于验证状态规则',artifact_hashes:d.artifacts.map((a:any)=>a.sha256),verdict:'passed'});
  await expect.poll(async()=>(await h.get('/tasks/'+backend)).task.execution.dependencies_ready).toBe(false);
  const before=await h.get('/tasks/'+design);await h.post('/tasks/'+design+'/accept',{revision:before.task.revision,checks:[true]});
  await expect(page.getByRole('region',{name:'轮到你了'}).getByRole('article',{name:'测试：实现接口'})).toBeVisible();
  expect((await h.get('/tasks/'+final)).task.execution.dependencies_ready).toBe(false);
  await page.goto('/#/team/codex');const queue=page.getByRole('region',{name:'执行队列'});await expect(queue.getByRole('article',{name:'测试：实现接口'})).toContainText('建议第');
  await page.goto('/#/projects/'+p.id);
  for(const width of [1440,900]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,'执行顺序-'+width);}
  await page.getByRole('button',{name:/深色/}).click();await shot(page,'执行顺序-深色');
  await page.reload();await expect(list.getByRole('article',{name:'测试：制作页面'})).toContainText('可执行');
  expect((await h.get('/tasks/'+frontend)).task.current_run_id).toBeNull();
});

test('长需求在首页、需求箱和项目收起为两行；全文可查看复制，派单内容完整',async({page})=>{
  const h=await api(page),root=path.join(h.root,'长需求测试-'+randomUUID());fs.mkdirSync(root,{recursive:true});
  const p=await h.post('/projects',{name:'测试：长需求显示',path:root});
  const text='测试：合并需求与后续安排\n'+Array.from({length:25},(_,i)=>`${i+1}、完整保留需求内容，安排多个阶段执行。${'详细内容'.repeat(20)}`).join('\n')+'\n最后一项必须完整保留。';
  const q=await h.post('/requests',{project_id:p.id,text});
  for(const url of ['/#/today','/#/requests?tab=waiting','/#/projects/'+p.id]){
    await page.goto(url);const preview=page.locator('.request-preview').filter({hasText:'测试：合并需求与后续安排'});
    await expect(preview.getByRole('button',{name:'查看全文'})).toBeVisible();
    const metrics=await preview.locator('.request-preview-text').evaluate(el=>({height:el.clientHeight,full:el.scrollHeight,line:parseFloat(getComputedStyle(el).lineHeight)}));
    expect(metrics.height).toBeLessThanOrEqual(metrics.line*2+2);expect(metrics.full).toBeGreaterThan(metrics.height);
    await preview.getByRole('button',{name:'查看全文'}).click();const dialog=page.getByRole('dialog',{name:'需求全文'});
    await expect(dialog.locator('.request-full-text')).toHaveText(text);await dialog.getByRole('button',{name:'复制全文'}).click();expect((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,"\n")).toBe(text);
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  }
  await page.goto('/#/today');
  for(const width of [1920,900]){await page.setViewportSize({width,height:1000});const preview=page.locator('.request-preview').filter({hasText:'测试：合并需求与后续安排'});await expect(preview.getByRole('button',{name:'查看全文'})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,'长需求收起-'+width);}
  const card=page.locator('article.turn').filter({hasText:'测试：合并需求与后续安排'});await card.getByRole('button',{name:'复制规划请求'}).click();expect((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,"\n")).toContain(text);
  expect((await h.get('/state')).requests.find((x:any)=>x.id===q.id).text).toBe(text);
});

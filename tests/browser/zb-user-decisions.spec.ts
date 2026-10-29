import {test,expect} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {api,makeTask,EVIDENCE,noHorizontalScroll} from './support.ts';

test('会话准备验收：首页和任务详情一次确认，宽窄明暗布局，取消不改变任务',async({page})=>{
  const {root}=await api(page);expect(path.basename(root)).toBe('app');expect(path.basename(path.dirname(root))).toMatch(/^browser-/);
  const token=JSON.parse(fs.readFileSync(path.join(root,'data/keys.json'),'utf8')).manager;
  const made=await makeTask(page,{title:'测试：会话准备好，用户亲自确认',stage:'reviewed'});
  const prepare=async()=>{const d=await made.get('/tasks/'+made.tid);const r=await page.request.post('/api/mcp/manage_tasks',{headers:{authorization:'Bearer '+token},data:{request_id:randomUUID(),user_instruction:'隔离测试：我已试用，准备确认这项任务。',change:{action:'accept',task_id:made.tid,run_id:made.rid,revision:d.task.revision}}});expect(r.ok(),await r.text()).toBeTruthy();const result=await r.json();expect(result.status).toBe('awaiting_user_confirmation');return result.result.decision_id};
  await page.goto('/#/today');await prepare();
  const card=page.getByRole('article',{name:'确认验收通过：'+made.title,exact:true});await expect(card).toBeVisible();
  expect((await made.get('/tasks/'+made.tid)).task.status).toBe('awaiting_confirmation');
  await expect(card.getByText('我能看懂测试结果')).toBeVisible();await expect(card.getByText(made.project.name)).toBeVisible();
  for(const [width,theme] of [[1440,'light'],[820,'dark']] as const){
    await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('wb-theme',theme)},theme);await page.reload();await expect(card).toBeVisible();expect(await noHorizontalScroll(page)).toBeTruthy();
    if(process.env.WORKBENCH_EVIDENCE_DIR){fs.mkdirSync(EVIDENCE,{recursive:true});await page.screenshot({animations:'disabled',path:path.join(EVIDENCE,`用户确认卡-${width}-${theme}.png`),fullPage:false})}
  }
  await card.getByRole('button',{name:'取消这项确认'}).click();await expect(card).toHaveCount(0);expect((await made.get('/tasks/'+made.tid)).task.status).toBe('awaiting_confirmation');
  await prepare();await expect(card).toBeVisible();await card.getByRole('button',{name:made.title,exact:true}).click();
  const drawer=page.getByRole('dialog',{name:'任务详情'});await expect(drawer.getByRole('article',{name:'确认验收通过：'+made.title})).toBeVisible();
  await drawer.getByRole('button',{name:'确认验收通过',exact:true}).click();await expect(drawer.getByText('已经完成',{exact:true}).first()).toBeVisible();
  expect((await made.get('/tasks/'+made.tid)).task.status).toBe('accepted');expect(await noHorizontalScroll(page)).toBeTruthy();
});

test('已有修改要求可直接追加审查：无需二次确认卡，原报告保留并可复制新单',async({page})=>{
  const {root}=await api(page),token=JSON.parse(fs.readFileSync(path.join(root,'data/keys.json'),'utf8')).manager;
  const made=await makeTask(page,{title:'测试：已有授权可直接追加审查',stage:'submitted'}),d=await made.get('/tasks/'+made.tid);
  const original=await made.post('/reviews',{run_id:made.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',evidence:'隔离页面测试的原始审查记录，要求修复功能。',findings:'修复后再交付',artifact_hashes:d.artifacts.map((a:any)=>a.sha256)});
  const task=(await made.get('/tasks/'+made.tid)).task;
  const r=await page.request.post('/api/mcp/manage_reviews',{headers:{authorization:'Bearer '+token},data:{request_id:randomUUID(),user_instruction:'隔离测试：请准备改派 Claude 复查。',change:{action:'assign',data:{run_id:made.rid,reviewer_id:'claude',expected_revision:task.revision,reason:'隔离用户希望 Claude 重新审查'}}}});expect(r.ok(),await r.text()).toBeTruthy();
  await page.goto('/#/today');await expect(page.getByRole('article',{name:'确认重新安排审查：'+made.title})).toHaveCount(0);
  const detail=await made.get('/tasks/'+made.tid);expect(detail.task.status).toBe('submitted');expect(detail.review_assignments.some((a:any)=>a.reviewer_id==='claude'&&a.status==='awaiting_dispatch')).toBeTruthy();expect(detail.reviews.find((x:any)=>x.id===original.id).revoked_at).toBeFalsy();
  await page.goto('/#/today?task='+made.tid);const collaboration=page.getByRole('dialog',{name:'任务详情'}).getByRole('region',{name:'独立审查协作',exact:true});
  await expect(collaboration.getByText('Claude · 已安排 · 待接单',{exact:true})).toBeVisible();
  await collaboration.getByRole('button',{name:'复制共同审查交接',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(made.rid);
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain(made.tid);
});

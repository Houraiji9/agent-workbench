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

test('已有修改要求的改派：确认前保留原报告，点确认后可复制新审查单',async({page})=>{
  const {root}=await api(page),token=JSON.parse(fs.readFileSync(path.join(root,'data/keys.json'),'utf8')).manager;
  const made=await makeTask(page,{title:'测试：审查改派须用户确认',stage:'submitted'}),d=await made.get('/tasks/'+made.tid);
  const original=await made.post('/reviews',{run_id:made.rid,reviewer_id:'grok-build',performed:true,verdict:'changes_requested',evidence:'隔离页面测试的原始审查记录，要求修复功能。',findings:'修复后再交付',artifact_hashes:d.artifacts.map((a:any)=>a.sha256)});
  const task=(await made.get('/tasks/'+made.tid)).task;
  const r=await page.request.post('/api/mcp/manage_reviews',{headers:{authorization:'Bearer '+token},data:{request_id:randomUUID(),user_instruction:'隔离测试：请准备改派 Claude 复查。',change:{action:'assign',data:{run_id:made.rid,reviewer_id:'claude',expected_revision:task.revision,reason:'隔离用户希望 Claude 重新审查'}}}});expect(r.ok(),await r.text()).toBeTruthy();
  await page.goto('/#/today');const card=page.getByRole('article',{name:'确认重新安排审查：'+made.title});await expect(card).toBeVisible();await expect(card.getByText('审查者：Claude',{exact:true})).toBeVisible();
  let detail=await made.get('/tasks/'+made.tid);expect(detail.task.status).toBe('changes_requested');expect(detail.reviews.find((x:any)=>x.id===original.id).revoked_at).toBeFalsy();
  await card.getByRole('button',{name:'确认重新安排审查'}).click();await expect(card).toHaveCount(0);
  detail=await made.get('/tasks/'+made.tid);expect(detail.task.status).toBe('submitted');expect(detail.task.reviewer_id).toBe('claude');expect(detail.reviews.find((x:any)=>x.id===original.id).revoked_at).toBeTruthy();
  await page.getByRole('article',{name:made.title,exact:true}).getByRole('button',{name:'交给审查者'}).click();await page.getByRole('dialog',{name:'任务详情'}).getByText('手动转发或导入审查',{exact:true}).click();await expect(page.getByRole('dialog',{name:'任务详情'}).getByRole('button',{name:/复制审查单/}).first()).toBeVisible();
  await page.getByRole('dialog',{name:'任务详情'}).getByRole('button',{name:'复制审查单',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain(detail.task.current_review_assignment_id);
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('Claude');
});

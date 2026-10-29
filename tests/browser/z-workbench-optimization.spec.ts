import {test,expect} from '@playwright/test';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {api,makeTask,shot,noHorizontalScroll} from './support.ts';import {taskInput} from '../helpers.ts';

test('100项合成待办按动作分组、筛选与分页；待安排始终展开可见',async({page})=>{
  const states=['waiting_input','awaiting_confirmation','blocked','ready'];
  await page.route(/\/api\/(bootstrap|state)(\?|$)/,async route=>{const response=await route.fetch(),data=await response.json();data.requests=[];data.runs=[];data.user_decisions=[];data.tasks=Array.from({length:100},(_,i)=>({...taskInput(data.authorized_roots[0]),id:'T-attention-'+i,title:'合成待办 '+i,project_id:'P-workbench',status:states[i%4],current_run_id:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',version:1,revision:1,execution:{step:1,dependencies_ready:true,dependencies:[]}}));await route.fulfill({response,json:data});});
  await page.goto('/');const filters=page.getByRole('group',{name:'按动作筛选待办'});
  await expect(page.getByRole('combobox',{name:'待办排序'})).toBeVisible();
  await page.getByRole('combobox',{name:'待办排序'}).selectOption('oldest');
  for(const label of ['待回答','待试用','待决定','待安排'])await expect(filters.getByRole('button',{name:label+'（25）',exact:true})).toBeVisible();
  await expect(page.locator('.arrange-group')).toBeVisible();await expect(page.locator('.arrange-group summary')).toHaveCount(0);
  await expect(page.locator('.arrange-group .turn').first()).toBeVisible();await expect(page.locator('.arrange-group .turn-actions').first().getByRole('button',{name:'生成并复制执行单'})).toBeVisible();
  await filters.getByRole('button',{name:'待安排（25）',exact:true}).click();await expect(page.locator('.arrange-group .turn').first()).toBeVisible();
  await filters.getByRole('button',{name:'待回答（25）',exact:true}).click();await expect(page.getByRole('region',{name:'待回答'}).locator('.turn')).toHaveCount(20);
  await page.getByRole('button',{name:'显示更多待回答'}).click();await expect(page.getByRole('region',{name:'待回答'}).locator('.turn')).toHaveCount(25);
  await page.getByRole('textbox',{name:'搜索待办'}).fill('合成待办 96');await expect(page.locator('.turn')).toHaveCount(1);await expect(page.locator('.turn-title')).toHaveText('合成待办 96');
  await page.getByRole('textbox',{name:'搜索待办'}).fill('');await filters.getByRole('button',{name:'待安排（25）',exact:true}).click();await expect(page.locator('.arrange-group .turn').first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'优化-待办动作分组',false);
});

test('长项目说明默认三行，首屏可见实际任务；展开保留原文',async({page})=>{
  await page.setViewportSize({width:1280,height:720});const m=await makeTask(page,{title:'概览中的实际任务'});const p=(await m.get('/state')).projects.find((x:any)=>x.id===m.project.id),goal='这是完整的项目说明。\n\n'+('详细说明和真实目标。'.repeat(100));
  await m.post('/projects/'+p.id+'/edit',{version:p.version,changes:{name:p.name,goal,stage:'开发中',next_step:'完成整个目标后统一试用'}});await page.goto('/#/projects/'+p.id);
  const text=page.locator('.project-goal'),toggle=page.getByRole('button',{name:'展开完整说明'});await expect(toggle).toHaveAttribute('aria-expanded','false');
  const metrics=await text.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,line:parseFloat(getComputedStyle(el).lineHeight)}));expect(metrics.height).toBeLessThanOrEqual(metrics.line*3+1);expect(metrics.scroll).toBeGreaterThan(metrics.height);
  const task=page.getByRole('button',{name:m.title,exact:true});await expect(task).toBeVisible();expect((await task.boundingBox())!.y).toBeLessThan(680);
  await toggle.click();await expect(page.getByRole('button',{name:'收起说明'})).toHaveAttribute('aria-expanded','true');expect(await text.textContent()).toBe(goal);
  await page.getByRole('button',{name:'收起说明'}).click();await shot(page,'优化-项目首屏',false);
});

test('真实依赖图表达分支与汇合，节点可打开对应任务',async({page})=>{
  const a=await api(page),folder=path.join(a.root,'关系图-'+randomUUID());fs.mkdirSync(folder);const p=await a.post('/projects',{name:'测试关联项目',path:folder});const q=await a.post('/requests',{project_id:p.id,text:'合成的真实依赖记录'});
  const tasks=[{...taskInput(folder,'a'),title:'关系A'},{...taskInput(folder,'b'),title:'关系B',dependencies:['a']},{...taskInput(folder,'c'),title:'关系C',dependencies:['a']},{...taskInput(folder,'d'),title:'关系D',dependencies:['b','c']}];
  const plan=await a.post('/plans',{schema_version:1,plan_id:'graph-'+randomUUID(),request_id:q.id,expected_version:1,tasks});await page.goto('/#/projects/'+p.id+'?tab=diagrams');
  await expect(page.getByRole('tab',{name:'关系图'})).toHaveAttribute('aria-selected','true');await expect(page.locator('.graph-node')).toHaveCount(4);await expect(page.locator('.graph-edge')).toHaveCount(4);
  const graph=await a.get('/projects/'+p.id+'/relations');expect(graph.edges.filter((e:any)=>e.from===plan.task_ids[0])).toHaveLength(2);expect(graph.edges.filter((e:any)=>e.to===plan.task_ids[3])).toHaveLength(2);
  await page.getByRole('button',{name:'关系B',exact:true}).click();await expect(page.getByRole('dialog',{name:'任务详情'})).toContainText('关系B');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'适应画布'}).click();expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'优化-真实关系图',false);
});

test('同会话续作使用短简讯，复制不冒充已派发或接单',async({page})=>{
  const m=await makeTask(page,{title:'同会话续作测试',stage:'order'});const d=await m.get('/tasks/'+m.tid);const before=d.task.status;
  const entry=await m.post('/tasks/'+m.tid+'/continue',{revision:d.task.revision,same_session:true});expect(entry.entry.length).toBeLessThan(1500);expect(entry.automatic_delivery).toBe(false);expect(entry.entry).toContain('不重读');expect((await m.get('/tasks/'+m.tid)).task.status).toBe(before);
});

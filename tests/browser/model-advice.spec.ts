import {test,expect} from '@playwright/test';
import {makeTask,drawer,shot,noHorizontalScroll} from './support.ts';

test('task model suggestions accept unlisted names and can be cleared back to Agent choice',async({page})=>{
 const task=await makeTask(page,{title:'模型建议输入回归'});await page.goto('/#/today?task='+task.tid);
 const d=drawer(page);await d.getByText('执行安排',{exact:true}).click();await d.getByRole('button',{name:'修改执行安排',exact:true}).click();
 await d.getByLabel('主模型建议（可留空）').fill('future-client-model');await d.getByLabel('允许使用子代理',{exact:true}).check();
 await d.getByLabel('子模型建议（可留空，逗号分隔）').fill('private-child, client-default');await d.getByLabel('主模型建议（可留空）').focus();
 await d.getByRole('button',{name:'保存安排',exact:true}).click();
 await expect.poll(async()=> (await task.get('/tasks/'+task.tid)).task.requested_model).toBe('future-client-model');
 expect((await task.get('/tasks/'+task.tid)).task.execution_policy.child_models).toEqual(['private-child','client-default']);
 await d.getByRole('button',{name:'修改执行安排',exact:true}).click();await d.getByLabel('主模型建议（可留空）').fill('');await d.getByLabel('子模型建议（可留空，逗号分隔）').fill('');await d.getByLabel('主模型建议（可留空）').focus();
 await d.getByRole('button',{name:'保存安排',exact:true}).click();await expect.poll(async()=> (await task.get('/tasks/'+task.tid)).task.requested_model).toBe(null);
 await d.getByRole('button',{name:'修改执行安排',exact:true}).click();await expect(d.getByLabel('主模型建议（可留空）')).toHaveValue('');await expect(d.getByLabel('自主模式')).toHaveCount(0);
 await page.setViewportSize({width:480,height:760});expect(await noHorizontalScroll(page)).toBeTruthy();await shot(page,'0410-模型建议');
});

test('project model suggestions save with no published catalogue',async({page})=>{
 const task=await makeTask(page,{title:'项目模型建议回归'});await page.goto('/#/projects/'+task.project.id);await page.getByRole('tab',{name:'资料与设置'}).click();
 await page.getByText('项目默认模型与子代理设置',{exact:true}).click();const panel=page.locator('details').filter({has:page.getByText('项目默认模型与子代理设置',{exact:true})});
 await panel.getByLabel('这份默认设置适用于').selectOption('codex');await panel.getByLabel('主模型建议（可留空）').fill('unlisted-project-model');await panel.getByRole('button',{name:'保存项目默认策略',exact:true}).click();
 await expect.poll(async()=> (await task.get('/state')).projects.find((p:any)=>p.id===task.project.id).execution_policies?.codex?.main_model).toBe('unlisted-project-model');
 await panel.getByLabel('主模型建议（可留空）').fill('');await panel.getByRole('button',{name:'保存项目默认策略',exact:true}).click();await expect.poll(async()=> (await task.get('/state')).projects.find((p:any)=>p.id===task.project.id).execution_policies?.codex?.main_model).toBe(null);
});

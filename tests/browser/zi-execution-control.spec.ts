import {test,expect} from '@playwright/test';
import {makeTask,noHorizontalScroll,shot} from './support.ts';

test('主执行默认由我启动；单独开启续作许可，有保存反馈且不启动客户端',async({page})=>{
 const m=await makeTask(page,{title:'合成主执行启动许可',stage:'order'});
 // Only supply the route display. No real client route is stored or invoked by this browser fixture.
 await page.route('**/api/tasks/'+m.tid,async route=>{const response=await route.fetch(),detail=await response.json();detail.task.execution_route={client:'claude',model:'synthetic'};await route.fulfill({response,json:detail})});
 await page.goto('/#/today?task='+m.tid);const panel=page.locator('details.arrangement');
 await panel.locator(':scope > summary').click();await panel.getByText('启动方式 · 由我启动',{exact:true}).click();
 const checkbox=panel.getByRole('checkbox',{name:'允许工作台按任务计划自动返修和收尾'});await expect(checkbox).not.toBeChecked();
 await checkbox.focus();await page.keyboard.press('Space');await expect(page.getByRole('status')).toContainText('启动方式已保存');
 let detail=await m.get('/tasks/'+m.tid);expect(detail.task.main_execution_control).toBe('automatic');expect(detail.task.main_execution_control_decision.source).toBe('user_page');expect(detail.task.status).toBe('awaiting_dispatch');
 await expect(checkbox).toBeChecked();await checkbox.uncheck();await expect(checkbox).not.toBeChecked();await expect(checkbox).toBeEnabled();
 detail=await m.get('/tasks/'+m.tid);expect(detail.task.main_execution_control).toBe('user');expect(detail.task.current_run_id).toBe(m.rid);
 await page.setViewportSize({width:880,height:600});expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'启动方式-用户控制',false);
});

test('会话建议展示为未采用，用户可以编辑后保存下一版',async({page})=>{
 const m=await makeTask(page,{title:'合成会话安排建议',stage:'running'});
 await page.route('**/api/tasks/'+m.tid,async route=>{const response=await route.fetch(),detail=await response.json();
  if(!detail.task.pending_arrangement)detail.task.proposed_arrangement={agent_id:'codex',requested_model:'gpt-6-sol',execution_policy:{main_model:'gpt-6-sol',allow_subagents:false,child_models:[]},source:'manager_proposal'};
  await route.fulfill({response,json:detail});});
 await page.goto('/#/today?task='+m.tid);const panel=page.locator('details.arrangement');
 await expect(panel.getByRole('region',{name:'会话中的安排建议'})).toContainText('尚未采用');
 await expect(panel.getByRole('region',{name:'当前执行安排'})).not.toContainText('gpt-6-sol');
 await panel.getByRole('button',{name:'查看并调整建议'}).click();await expect(panel.getByLabel('主模型')).toHaveValue('gpt-6-sol');
 await panel.getByLabel('主模型').selectOption('gpt-6.1-sol');await panel.getByRole('button',{name:'保存为下一版安排'}).click();
 await expect(panel.getByRole('region',{name:'待生效的下一版安排'})).toContainText('gpt-6.1-sol');
 const detail=await m.get('/tasks/'+m.tid);expect(detail.task.current_run_id).toBe(m.rid);expect(detail.task.pending_arrangement.requested_model).toBe('gpt-6.1-sol');
 await page.setViewportSize({width:375,height:760});expect(await noHorizontalScroll(page)).toBe(true);await shot(page,'会话建议-用户调整',false);
});

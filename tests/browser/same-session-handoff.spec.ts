import {test,expect} from '@playwright/test';
import path from 'node:path';
import {api,drawer} from './support.js';

async function fixtureTask(page:any,title:string){const m=await api(page),task=m.boot.tasks.find((t:any)=>t.title===title);expect(task,'recovery fixture task').toBeTruthy();return {m,task};}
async function evidence(locator:any,name:string){if(process.env.WORKBENCH_EVIDENCE_DIR)await locator.screenshot({animations:'disabled',path:path.join(process.env.WORKBENCH_EVIDENCE_DIR,name)});}

test('手工同会话返修首页与抽屉由原执行者继续，不再要求用户复制转交',async({page})=>{
 const {m,task}=await fixtureTask(page,'测试：手工原会话继续返修');
 const detail=await m.get('/tasks/'+task.id);expect(detail.task.status).toBe('awaiting_dispatch');expect(detail.task.automation).toBeNull();expect(detail.task.execution_route).toBeNull();expect(detail.task.same_session_continuation.run_id).toBe(detail.task.current_run_id);expect(detail.runs.find((r:any)=>r.id===detail.task.current_run_id).has_started).toBe(false);
 await page.goto('/#/today');const active=page.locator('.active-task').filter({hasText:task.title});await expect(active).toBeVisible();await expect(active.getByText('原会话继续返修，等待接单',{exact:true})).toBeVisible();await evidence(active,'same-session-today-active.png');
 await page.goto('/#/today?task='+task.id);const panel=drawer(page),now=panel.getByRole('region',{name:'现在要做什么'});await expect(now.getByText('原会话继续返修，等待接单',{exact:true})).toBeVisible();await expect(panel.getByText('原会话待续接',{exact:true})).toBeVisible();await expect(now.getByRole('button',{name:'复制执行单',exact:true})).toHaveCount(0);await expect(now.getByRole('button',{name:'我已经发给它',exact:true})).toHaveCount(0);await expect(now.getByText(/复制.*执行单|我已经发给它|把执行单.*发给/)).toHaveCount(0);await evidence(now,'same-session-now-card.png');await evidence(panel,'same-session-drawer.png');
});

test('首次派单无同会话标记，保留用户复制执行单和确认转交入口',async({page})=>{
 const {task}=await fixtureTask(page,'测试：首次派单仍需交接');await page.goto('/#/today?task='+task.id);const now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByRole('button',{name:'复制执行单',exact:true})).toBeVisible();await expect(now.getByRole('button',{name:'我已经发给它',exact:true})).toBeVisible();await expect(drawer(page).getByText('原会话待续接',{exact:true})).toHaveCount(0);await evidence(now,'initial-handoff-control.png');
});

test('项目用量与过程同会话卡片不要求用户发送执行单，首次派单仍需用户交接',async({page})=>{
 const {task}=await fixtureTask(page,'测试：手工原会话继续返修');const {task:first}=await fixtureTask(page,'测试：首次派单仍需交接');
 await page.goto('/#/projects/P-workbench?tab=insights');const flow=page.getByRole('region',{name:'真实流程与交接'}),continuing=flow.locator('.pi-handoff').filter({hasText:task.title}),initial=flow.locator('.pi-handoff').filter({hasText:first.title});
 await expect(continuing).toBeVisible();await expect(continuing.getByText('下一步',{exact:true})).toBeVisible();await expect(continuing.getByText('原会话继续返修，等待接单，无需再次转发',{exact:true})).toBeVisible();await expect(continuing.getByText('原会话待续接',{exact:true})).toBeVisible();await expect(continuing.getByText('需要你做',{exact:true})).toHaveCount(0);await expect(continuing.getByText(/发送执行单|复制执行单|交给执行者/)).toHaveCount(0);await evidence(continuing,'same-session-project-card.png');
 await expect(initial.getByText('需要你做',{exact:true})).toBeVisible();await expect(initial.getByText('发送执行单，等待接单',{exact:true})).toBeVisible();await evidence(initial,'initial-project-control.png');
 await continuing.getByRole('button',{name:task.title,exact:true}).click();const now=drawer(page).getByRole('region',{name:'现在要做什么'});await expect(now.getByText('原会话继续返修，等待接单',{exact:true})).toBeVisible();await expect(now.getByRole('button',{name:'复制执行单',exact:true})).toHaveCount(0);await evidence(drawer(page),'project-opened-same-session-drawer.png');
});
